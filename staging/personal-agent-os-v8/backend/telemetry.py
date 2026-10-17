"""Bounded, content-free Alpha5 metadata telemetry. Independent of command execution."""
import hashlib
import json
import re
import time
import uuid
from datetime import datetime, timezone

SCHEMA="cf.agentos.telemetry.v1"
RECEIPT_SCHEMA="cf.agentos.telemetry-receipt.v1"
ALLOWED_TYPES={
"APP_START","APP_RESUME","APP_PAUSE","SPEAK_OPEN","SPEAK_START",
"SPEAK_READY","SPEAK_CAPTURED","SPEAK_ERROR","WAKE_OPEN","WAKE_START",
"WAKE_READY","WAKE_PHASE","WAKE_CAPTURED","WAKE_STOP","WAKE_ERROR",
"QUEUE_CAPTURED","QUEUE_ERROR","SYNC_BEGIN","SYNC_ACK","SYNC_ERROR",
"NETWORK_OFFLINE","NETWORK_RESTORED","DIAGNOSTIC_PING","DIAGNOSTIC_ENABLED",
"DIAGNOSTIC_PAUSED","PAIR_SUCCESS"
}
ALLOWED_SOURCE={"APP","SPEAK","WAKE","TYPE","JOB","MANUAL","SYSTEM","NETWORK"}
ALLOWED_PHASE={"IDLE","LISTENING","WAIT_COMMAND","AUTH","SONIOX","CAPTURED","STOPPED","ERROR","PENDING","ACKED"}
ALLOWED_NETWORK={"NONE","WIFI","CELLULAR","OTHER","UNKNOWN"}
ALLOWED_ERROR={"NONE","NETWORK","TIMEOUT","TLS","HTTP","PERMISSION","STORE","AUDIO","STT","AUTH","UNKNOWN"}
ALLOWED_DETAILS={"source","phase","network","error","pending","acked","value"}
INT_FIELDS={"pending","acked","value"}
ENUM_FIELDS={"source":ALLOWED_SOURCE,"phase":ALLOWED_PHASE,"network":ALLOWED_NETWORK,"error":ALLOWED_ERROR}
ID_RE=re.compile(r"[0-9a-f]{32}\Z")
RETENTION_MS=7*24*3600*1000
MAX_PER_DEVICE=2000

def validate_event(event):
    if not isinstance(event,dict):
        raise ValueError("INVALID_TELEMETRY")
    if set(event)!={"schema","event_id","seq","version_code","event_type","occurred_at_ms","details"}:
        raise ValueError("INVALID_TELEMETRY_SHAPE")
    if event["schema"]!=SCHEMA or type(event["version_code"]) is not int or event["version_code"] not in (5,6,7) or type(event["seq"]) is not int or not 1<=event["seq"]<=2**62:
        raise ValueError("INVALID_TELEMETRY_VERSION")
    if not isinstance(event["event_id"],str) or not ID_RE.fullmatch(event["event_id"]):
        raise ValueError("INVALID_TELEMETRY_ID")
    if event["event_type"] not in ALLOWED_TYPES:
        raise ValueError("INVALID_TELEMETRY_TYPE")
    timestamp=event["occurred_at_ms"]
    if type(timestamp) is not int or timestamp<1600000000000 or timestamp>int(time.time()*1000)+86400000:
        raise ValueError("INVALID_TELEMETRY_TIME")
    details=event["details"]
    if not isinstance(details,dict) or len(details)>7 or set(details)-ALLOWED_DETAILS:
        raise ValueError("INVALID_TELEMETRY_DETAILS")
    for k,v in details.items():
        if k in INT_FIELDS:
            if type(v) is not int or not 0<=v<=1000000:
                raise ValueError("INVALID_TELEMETRY_COUNT")
        elif k in ENUM_FIELDS:
            if type(v) is not str or v not in ENUM_FIELDS[k]:
                raise ValueError("INVALID_TELEMETRY_ENUM")
        else:
            raise ValueError("INVALID_TELEMETRY_KEY")
    raw=json.dumps(event,ensure_ascii=False,sort_keys=True,separators=(",",":")).encode("utf-8")
    if len(raw)>2048:
        raise ValueError("TELEMETRY_TOO_LARGE")
    return hashlib.sha256(raw).hexdigest()

class TelemetryStore:
    def __init__(self, store):
        self.store=store
        with store.connect() as db:
            db.execute("""CREATE TABLE IF NOT EXISTS telemetry_events(
                device_id TEXT NOT NULL, event_id TEXT NOT NULL,
                seq INTEGER NOT NULL, version_code INTEGER NOT NULL,
                event_type TEXT NOT NULL, occurred_at_ms INTEGER NOT NULL,
                received_at_ms INTEGER NOT NULL, details_json TEXT NOT NULL,
                content_sha TEXT NOT NULL,
                PRIMARY KEY(device_id,event_id), UNIQUE(device_id,seq)
            )""")
            db.execute("""CREATE INDEX IF NOT EXISTS telemetry_recent
                ON telemetry_events(device_id,received_at_ms DESC)""")

    def accept(self,device_id,event):
        try:
            digest=validate_event(event)
        except (ValueError,TypeError) as e:
            return 400,{"error":str(e) if str(e).startswith("INVALID_") or str(e)=="TELEMETRY_TOO_LARGE" else "INVALID_TELEMETRY"}
        now=int(time.time()*1000)
        with self.store.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            try:
                prior=db.execute(
                    "SELECT event_id,seq,content_sha,received_at_ms FROM telemetry_events WHERE device_id=? AND (event_id=? OR seq=?)",
                    (device_id,event["event_id"],event["seq"])).fetchone()
                if prior:
                    if prior[0]!=event["event_id"] or prior[1]!=event["seq"] or prior[2]!=digest:
                        db.execute("ROLLBACK")
                        return 409,{"error":"TELEMETRY_ID_CONFLICT"}
                    duplicate=True
                    received=prior[3]
                else:
                    duplicate=False
                    received=now
                    db.execute("""INSERT INTO telemetry_events
                      (device_id,event_id,seq,version_code,event_type,occurred_at_ms,received_at_ms,details_json,content_sha)
                      VALUES(?,?,?,?,?,?,?,?,?)""",
                      (device_id,event["event_id"],event["seq"],event["version_code"],event["event_type"],
                       event["occurred_at_ms"],now,json.dumps(event["details"],sort_keys=True),digest))
                db.execute("DELETE FROM telemetry_events WHERE received_at_ms < ?",(now-RETENTION_MS,))
                db.execute("""DELETE FROM telemetry_events WHERE device_id=? AND seq NOT IN(
                    SELECT seq FROM telemetry_events WHERE device_id=? ORDER BY received_at_ms DESC,seq DESC LIMIT ?
                )""",(device_id,device_id,MAX_PER_DEVICE))
                db.execute("COMMIT")
            except BaseException:
                if db.in_transaction:db.execute("ROLLBACK")
                raise
        return (200 if duplicate else 201),{
           "schema":RECEIPT_SCHEMA,"event_id":event["event_id"],"seq":event["seq"],
           "state":"RECORDED","duplicate":duplicate,"received_at_ms":received,"executed":False
        }

    def summary(self,device_id):
        with self.store.connect() as db:
            row=db.execute("""SELECT COUNT(*), MAX(received_at_ms), MAX(seq)
              FROM telemetry_events WHERE device_id=?""",(device_id,)).fetchone()
            last=db.execute("""SELECT event_type,details_json,seq,occurred_at_ms,received_at_ms
              FROM telemetry_events WHERE device_id=?
              ORDER BY received_at_ms DESC,seq DESC LIMIT 1""",(device_id,)).fetchone()
        now=int(time.time()*1000)
        return {"schema":"cf.agentos.telemetry-summary.v1","device_id":device_id,
                "event_count":row[0],"last_seen_ms":row[1],
                "last_seq":row[2],"stale":(row[1] is None or now-row[1]>15*60*1000),
                "latest":None if not last else
                 {"event_type":last[0],"details":json.loads(last[1]),"seq":last[2],
                  "occurred_at_ms":last[3],"received_at_ms":last[4]}}

    def read_owner(self,device_prefix=None,limit=25):
        """Owner-authorized local CLI only. Never exposed as a public API."""
        limit=max(1,min(100,int(limit)))
        with self.store.connect() as db:
            if device_prefix:
                if not re.fullmatch("[0-9a-f]{4,32}",device_prefix):
                    raise ValueError("INVALID_DEVICE_PREFIX")
                devices=db.execute("SELECT DISTINCT device_id FROM telemetry_events WHERE device_id LIKE ?",(device_prefix+"%",)).fetchall()
            else:
                devices=db.execute("SELECT DISTINCT device_id FROM telemetry_events ORDER BY device_id").fetchall()
            out=[]
            for (device_id,) in devices:
                summary=self.summary(device_id)
                ev=db.execute("""SELECT seq,event_type,details_json,occurred_at_ms,received_at_ms
                    FROM telemetry_events WHERE device_id=? ORDER BY received_at_ms DESC,seq DESC LIMIT ?""",(device_id,limit)).fetchall()
                out.append({"device_id":device_id,"summary":summary,
                            "events":[{"seq":seq,"event_type":etype,"details":json.loads(details),
                                "occurred_at_ms":when,"received_at_ms":received} for seq,etype,details,when,received in ev]})
        return out
