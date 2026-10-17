#!/usr/bin/env python3
"""Personal Agent OS v8: read-only durable multi-work projection.

No raw command execution, external provider writes, CF authority impersonation or token logging.
Existing v2 ingress receipts and v5-v7 phone queue formats stay unchanged.
"""
import hashlib
import json
import os
import sqlite3
import threading
import time

SCHEMA="cf.agentos.work-board.v8"
LOCAL_WORKS=frozenset(("agentos","vps","queue"))
KNOWN_WORKS=frozenset(("agentos","vps","queue","onshape","telegram"))

class WorkRuntimeV8:
    def __init__(self,store):
        self.store=store
        with store.connect() as db:
            db.execute("""CREATE TABLE IF NOT EXISTS work_v8_meta (
                name TEXT PRIMARY KEY, value TEXT NOT NULL)""")
            db.execute("""CREATE TABLE IF NOT EXISTS work_v8 (
                command_id TEXT PRIMARY KEY,
                work_id TEXT, state TEXT NOT NULL,
                result_summary TEXT, evidence_ref TEXT,
                last_update_ms INTEGER NOT NULL,
                FOREIGN KEY(command_id) REFERENCES commands(command_id))""")
            db.execute("CREATE INDEX IF NOT EXISTS work_v8_by_work ON work_v8(work_id,last_update_ms)")
            first=db.execute("SELECT value FROM work_v8_meta WHERE name='cutover_rowid'").fetchone()
            if first is None:
                db.execute("INSERT INTO work_v8_meta(name,value) VALUES('cutover_rowid',?)",
                           (str(db.execute("SELECT COALESCE(MAX(rowid),0) FROM commands").fetchone()[0]),))
        self._stop=threading.Event()
        self._thread=None

    def _cutover(self,db):
        return int(db.execute("SELECT value FROM work_v8_meta WHERE name='cutover_rowid'").fetchone()[0])

    def ingest(self):
        """Only commands inserted after v8 cutover ROWID get new work state."""
        with self.store.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            try:
                cutover=self._cutover(db)
                db.execute("""INSERT OR IGNORE INTO work_v8(
                   command_id,work_id,state,last_update_ms)
                   SELECT command_id,work_id,
                   CASE WHEN work_id IS NULL THEN 'NEEDS_CLARIFICATION' ELSE 'QUEUED' END,
                   received_at_ms FROM commands WHERE rowid > ?""",(cutover,))
                db.execute("COMMIT")
            except BaseException:
                if db.in_transaction:db.execute("ROLLBACK")
                raise

    @staticmethod
    def _can_answer_locally(work_id,text):
        """Only explicit status/read intents can be answered by local VPS probes.

        A selected work ID never confers semantic permission to execute arbitrary
        natural language. Ambiguous and cross-work requests require clarification.
        """
        if not isinstance(text,str):return False
        norm=text.strip().casefold()
        if not norm or len(norm)>300:return False
        if not any(k in norm for k in ("وضعیت","بررسی","سلامت","تعداد","گزارش","status","health","count")):
            return False
        # A status-like phrase can still request a mutation: fail closed.
        if any(k in norm for k in ("حذف","پاک کن","تغییر بده","ویرایش","نصب کن","ارسال کن",
                                   "بفرست","راه‌اندازی کن","ریستارت کن","بساز",
                                   "delete ","modify ","restart ","install ","write ","send ")):
            return False
        for named,target in (("تلگرام","telegram"),("telegram","telegram"),
                             ("آنشیپ","onshape"),("onshape","onshape"),
                             ("وی پی ان","vpn"),("vpn","vpn")):
            if named in norm and target!=work_id:
                return False
        return True

    def _local_result(self,db,work_id):
        if work_id=="agentos":
            total=db.execute("SELECT COUNT(*) FROM commands").fetchone()[0]
            devices=db.execute("SELECT COUNT(*) FROM devices WHERE revoked=0").fetchone()[0]
            return "صف سرور: %d فرمان پایدار؛ دستگاه‌های فعال: %d" %(total,devices)
        if work_id=="queue":
            rows=db.execute("""SELECT COALESCE(work_id,'unspecified'),COUNT(*) FROM commands
                               GROUP BY work_id ORDER BY work_id LIMIT 10""").fetchall()
            return "فرمان‌های دریافت‌شده به‌تفکیک کار: "+", ".join("%s=%d"%(w,n) for w,n in rows)
        if work_id=="vps":
            up=0
            try:
                with open("/proc/uptime",encoding="ascii") as f:up=int(float(f.read().split()[0]))
            except (OSError,ValueError,IndexError):pass
            one=os.getloadavg()[0] if hasattr(os,"getloadavg") else 0
            return "سرور حاضر است؛ مدت روشن‌بودن: %d دقیقه؛ بار یک‌دقیقه‌ای: %.2f"%(up//60,one)
        raise ValueError("NOT_LOCAL_WORK")

    def advance(self,limit=20):
        """Bounded deterministic read-only jobs. No provider execution hot path."""
        self.ingest()
        with self.store.connect() as db:
            rows=db.execute("""SELECT command_id,work_id FROM work_v8
                               WHERE state='QUEUED' ORDER BY last_update_ms ASC LIMIT ?""",
                            (min(50,max(1,limit)),)).fetchall()
        for command_id,work_id in rows:
            if work_id not in LOCAL_WORKS:
                continue  # provider tasks must wait for a qualified CF read adapter
            with self.store.connect() as db:
                db.execute("BEGIN IMMEDIATE")
                try:
                    row=db.execute("""SELECT w.state,c.text FROM work_v8 AS w
                                      JOIN commands AS c ON c.command_id=w.command_id
                                      WHERE w.command_id=?""",(command_id,)).fetchone()
                    if row is None or row[0]!="QUEUED":
                        db.execute("COMMIT")
                        continue
                    if not self._can_answer_locally(work_id,row[1]):
                        db.execute("""UPDATE work_v8 SET state='NEEDS_CLARIFICATION',
                                      result_summary='این فرمان بررسی وضعیتِ قابل اجرای محلی نیست. مقصد و کار مجاز را مشخص کن.',
                                      last_update_ms=?
                                      WHERE command_id=? AND state='QUEUED'""",
                                   (int(time.time()*1000),command_id))
                        db.execute("COMMIT")
                        continue
                    db.execute("""UPDATE work_v8 SET state='WORKING',last_update_ms=?
                                  WHERE command_id=? AND state='QUEUED'""",
                               (int(time.time()*1000),command_id))
                    try:
                        summary=self._local_result(db,work_id)
                        now=int(time.time()*1000)
                        evidence=hashlib.sha256(
                            ("%s:%s:%s"%(command_id,now,summary)).encode("utf-8")).hexdigest()[:20]
                        db.execute("""UPDATE work_v8 SET state='DONE',result_summary=?,
                                      evidence_ref=?,last_update_ms=? WHERE command_id=? AND state='WORKING'""",
                                   (summary,"vps-read-"+evidence,now,command_id))
                    except Exception:
                        db.execute("""UPDATE work_v8 SET state='FAILED',
                                      result_summary='READ_ONLY_LOCAL_CHECK_FAILED',
                                      last_update_ms=? WHERE command_id=?""",
                                   (int(time.time()*1000),command_id))
                    db.execute("COMMIT")
                except BaseException:
                    if db.in_transaction:db.execute("ROLLBACK")
                    raise

    def detail(self,cid):
        """Read one exact immutable command's processing state, not another work's latest."""
        self.ingest()
        with self.store.connect() as db:
            row=db.execute("""SELECT work_id,command_id,state,result_summary,
                              evidence_ref,last_update_ms FROM work_v8 WHERE command_id=?""",
                           (cid,)).fetchone()
        if row is None:return None
        wid,ident,state,summary,proof,when=row
        return {"schema":"cf.agentos.command-result.v9","command_id":ident,
                "work_id":wid,"state":state,"result_summary":summary,
                "evidence_ref":proof,"updated_ms":when,
                "provider_effect_executed":False}

    def board(self):
        self.ingest()
        with self.store.connect() as db:
            records=db.execute("""SELECT work_id,command_id,state,result_summary,
                                  evidence_ref,last_update_ms
                                  FROM work_v8 ORDER BY last_update_ms DESC,command_id DESC LIMIT 200""").fetchall()
            total=db.execute("SELECT COUNT(*) FROM commands").fetchone()[0]
        chosen={}
        for wid,cid,state,summary,proof,when in records:
            if wid is None:
                continue
            if wid not in chosen:
                chosen[wid]={"work_id":wid,"state":state,"latest_command_id":cid,
                             "result_summary":summary,"evidence_ref":proof,
                             "updated_ms":when,"command_count":0}
            chosen[wid]["command_count"]+=1
            history=chosen[wid].setdefault("history",[])
            if len(history)<4:
                history.append({"command_id":cid,"state":state,
                                "result_summary":summary,
                                "evidence_ref":proof,"updated_ms":when})
        return {"schema":SCHEMA,"mode":"DIRECT_READONLY","works":sorted(chosen.values(),
                key=lambda x:x["work_id"]),"total_durable_receipts":total,
                "server_time_ms":int(time.time()*1000),
                "external_provider_dispatch":False}

    def start(self):
        if self._thread is not None:return
        def loop():
            while not self._stop.wait(2):
                try:self.advance()
                except Exception:pass  # never crash existing ingress
        self._thread=threading.Thread(target=loop,name="agentos-v8-local-read",daemon=True)
        self._thread.start()

    def stop(self):
        self._stop.set()
