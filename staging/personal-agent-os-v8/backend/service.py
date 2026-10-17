#!/usr/bin/env python3
"""Personal Agent OS Alpha4 dedicated ingress. Stores commands; NEVER executes them."""
import argparse
import hashlib
import hmac
import json
import os
import re
import secrets
import sqlite3
import sys
import time
import uuid
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from telemetry import TelemetryStore
from work_runtime_v8 import WorkRuntimeV8

PREFIX = "/agentos-alpha4"
COMMAND_SCHEMA = "cf.agentos.command.v2"
RECEIPT_SCHEMA = "cf.agentos.ingress-receipt.v2"
CID = re.compile(r"[A-Za-z0-9_-]{8,100}\Z", re.ASCII)
WORK = re.compile(r"[A-Za-z0-9_-]{1,100}\Z", re.ASCII)
CODE = re.compile(r"[A-Z2-9]{12,32}\Z", re.ASCII)
ALLOWED = {"schema", "command_id", "text", "sha256", "work_id"}

def sha(value):
    return hashlib.sha256(value.encode("utf-8")).hexdigest()

def validate(command):
    if not isinstance(command, dict) or set(command) - ALLOWED:
        raise ValueError("INVALID_ENVELOPE")
    if command.get("schema") != COMMAND_SCHEMA:
        raise ValueError("UNSUPPORTED_SCHEMA")
    cid = command.get("command_id")
    if not isinstance(cid, str) or not CID.fullmatch(cid):
        raise ValueError("INVALID_ID")
    raw = command.get("text")
    if not isinstance(raw, str) or not raw.strip():
        raise ValueError("INVALID_TEXT")
    try:
        data = raw.encode("utf-8", errors="strict")
    except UnicodeError as exc:
        raise ValueError("INVALID_UTF8") from exc
    if len(data) > 8192:
        raise ValueError("TOO_LARGE")
    digest = command.get("sha256")
    if not isinstance(digest, str) or len(digest) != 64 or not hmac.compare_digest(digest, sha(raw)):
        raise ValueError("DIGEST_MISMATCH")
    work = command.get("work_id")
    if work is not None and (not isinstance(work, str) or not WORK.fullmatch(work)):
        raise ValueError("INVALID_WORK")
    return cid, raw, digest, work

class Store:
    def __init__(self, filename):
        self.filename = os.path.abspath(filename)
        os.makedirs(os.path.dirname(self.filename), mode=0o700, exist_ok=True)
        with self.connect() as db:
            db.execute("PRAGMA journal_mode=WAL")
            db.execute("""CREATE TABLE IF NOT EXISTS commands(
                command_id TEXT PRIMARY KEY,
                sha256 TEXT NOT NULL, text TEXT NOT NULL, work_id TEXT,
                receipt_id TEXT NOT NULL UNIQUE, received_at_ms INTEGER NOT NULL,
                state TEXT NOT NULL DEFAULT 'QUEUED' CHECK(state='QUEUED')
            )""")
            db.execute("""CREATE TABLE IF NOT EXISTS devices(
                token_sha TEXT PRIMARY KEY,
                device_id TEXT UNIQUE NOT NULL,
                created_at_ms INTEGER NOT NULL,
                revoked INTEGER NOT NULL DEFAULT 0
            )""")
            db.execute("""CREATE TABLE IF NOT EXISTS pairing(
                code_sha TEXT PRIMARY KEY,
                expires_ms INTEGER NOT NULL
            )""")
        os.chmod(self.filename, 0o600)

    @contextmanager
    def connect(self):
        db = sqlite3.connect(self.filename, timeout=10, isolation_level=None)
        db.execute("PRAGMA busy_timeout=10000")
        db.execute("PRAGMA synchronous=FULL")
        try:
            yield db
        finally:
            db.close()

    def create_pair(self, seconds=1800):
        alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
        code = "".join(secrets.choice(alphabet) for _ in range(16))
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            db.execute("DELETE FROM pairing")
            db.execute("INSERT INTO pairing(code_sha,expires_ms) VALUES(?,?)",
                       (sha(code), int(time.time()*1000) + seconds*1000))
            db.execute("COMMIT")
        return code

    def pair(self, code):
        if not isinstance(code, str) or not CODE.fullmatch(code):
            return 403, {"error":"PAIRING_INVALID"}
        code_hash = sha(code)
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("SELECT expires_ms FROM pairing WHERE code_sha=?", (code_hash,)).fetchone()
            if row is None or row[0] <= int(time.time()*1000):
                db.execute("ROLLBACK")
                return 403, {"error":"PAIRING_INVALID"}
            token = secrets.token_urlsafe(36)
            device_id = uuid.uuid4().hex
            db.execute("DELETE FROM pairing")
            db.execute("INSERT INTO devices(token_sha,device_id,created_at_ms) VALUES(?,?,?)",
                       (sha(token), device_id, int(time.time()*1000)))
            db.execute("COMMIT")
        return 201, {"schema":"cf.agentos.pair.v1","device_token":token,"device_id":device_id}

    def authorized(self, bearer):
        if not isinstance(bearer, str) or not bearer.startswith("Bearer "):
            return False
        token = bearer[7:]
        if len(token) < 30 or len(token) > 200:
            return False
        with self.connect() as db:
            row = db.execute("SELECT revoked FROM devices WHERE token_sha=?", (sha(token),)).fetchone()
        return row is not None and row[0] == 0

    def device_for_bearer(self,bearer):
        if not isinstance(bearer,str) or not bearer.startswith("Bearer "):
            return None
        token=bearer[7:]
        if len(token)<30 or len(token)>200:
            return None
        with self.connect() as db:
            row=db.execute("SELECT device_id,revoked FROM devices WHERE token_sha=?",(sha(token),)).fetchone()
        return row[0] if row and row[1]==0 else None

    def accept(self, body):
        try:
            cid, raw, digest, work = validate(body)
        except ValueError as exc:
            return 400, {"error":str(exc)}
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            try:
                prior = db.execute("SELECT sha256,text,work_id,receipt_id,received_at_ms FROM commands WHERE command_id=?",
                                   (cid,)).fetchone()
                if prior is not None:
                    if (not hmac.compare_digest(digest, prior[0]) or prior[1] != raw or prior[2] != work):
                        db.execute("ROLLBACK")
                        return 409, {"error":"ID_CONFLICT"}
                    duplicate = True
                    receipt_id, when = prior[3], prior[4]
                else:
                    duplicate = False
                    receipt_id, when = uuid.uuid4().hex, int(time.time()*1000)
                    db.execute("INSERT INTO commands(command_id,sha256,text,work_id,receipt_id,received_at_ms) VALUES(?,?,?,?,?,?)",
                               (cid,digest,raw,work,receipt_id,when))
                db.execute("COMMIT")
            except BaseException:
                if db.in_transaction:
                    db.execute("ROLLBACK")
                raise
        return (200 if duplicate else 201), {
          "schema":RECEIPT_SCHEMA,"command_id":cid,"sha256":digest,"work_id":work,
          "state":"QUEUED","receipt":"DURABLY_ACCEPTED","receipt_id":receipt_id,
          "received_at_ms":when,"duplicate":duplicate,"executed":False
        }

    def status(self, cid):
        if not CID.fullmatch(cid):
            return 400, {"error":"INVALID_ID"}
        with self.connect() as db:
            row = db.execute("SELECT sha256,work_id,receipt_id,received_at_ms FROM commands WHERE command_id=?",
                             (cid,)).fetchone()
        if row is None:
            return 404, {"error":"NOT_FOUND"}
        return 200, {"command_id":cid,"sha256":row[0],"work_id":row[1],
                     "receipt_id":row[2],"received_at_ms":row[3],
                     "state":"QUEUED","executed":False}

    def works(self):
        with self.connect() as db:
            rows = db.execute("SELECT work_id,COUNT(*) FROM commands GROUP BY work_id ORDER BY work_id").fetchall()
        return {"schema":"cf.agentos.work-summary.v1","executed":False,
                "works":[{"work_id":r[0],"queued_commands":r[1]} for r in rows]}

    def count(self):
        with self.connect() as db:
            return db.execute("SELECT COUNT(*) FROM commands").fetchone()[0]

def create_server(store, address="127.0.0.1", port=18765):
    if address != "127.0.0.1":
        raise ValueError("EXTERNAL_BIND_FORBIDDEN")
    telemetry=TelemetryStore(store)
    works_v8=WorkRuntimeV8(store)
    works_v8.start()
    class Handler(BaseHTTPRequestHandler):
        server_version = "PersonalAgentIngress/1"
        def log_message(self,*args):
            pass  # never print bearer, pairing code, chat text, or query
        def respond(self,code,obj):
            data=json.dumps(obj,ensure_ascii=False,separators=(",",":")).encode("utf-8")
            self.send_response(code)
            for header,value in (("Content-Type","application/json; charset=utf-8"),
                                 ("Content-Length",str(len(data))),
                                 ("Cache-Control","no-store"),
                                 ("X-Content-Type-Options","nosniff")):
                self.send_header(header,value)
            self.end_headers()
            try:self.wfile.write(data)
            except BrokenPipeError:pass
        def read_json(self):
            if self.headers.get("Content-Type","").split(";")[0].strip().lower()!="application/json":
                raise ValueError("REQUIRES_JSON")
            try:size=int(self.headers.get("Content-Length","-1"))
            except ValueError:raise ValueError("INVALID_LENGTH")
            if size<2 or size>16000:raise ValueError("INVALID_LENGTH")
            try:
                text=self.rfile.read(size).decode("utf-8",errors="strict")
                value=json.loads(text)
            except (UnicodeError,ValueError):
                raise ValueError("INVALID_JSON")
            if not isinstance(value,dict):raise ValueError("INVALID_OBJECT")
            return value
        def do_POST(self):
            if self.path==PREFIX+"/v2/pair":
                try:
                    request=self.read_json()
                except ValueError as ex:return self.respond(400,{"error":str(ex)})
                if set(request)!={"pairing_code"}:return self.respond(400,{"error":"INVALID_PAIR_SHAPE"})
                return self.respond(*store.pair(request["pairing_code"]))
            if self.path==PREFIX+"/v3/telemetry":
                device=store.device_for_bearer(self.headers.get("Authorization"))
                if device is None:
                    return self.respond(401,{"error":"NOT_AUTHORIZED"})
                try:event=self.read_json()
                except ValueError as ex:return self.respond(400,{"error":str(ex)})
                return self.respond(*telemetry.accept(device,event))
            if self.path!=PREFIX+"/v2/commands":return self.respond(404,{"error":"NOT_FOUND"})
            if not store.authorized(self.headers.get("Authorization")):
                return self.respond(401,{"error":"NOT_AUTHORIZED"})
            try:request=self.read_json()
            except ValueError as ex:return self.respond(400,{"error":str(ex)})
            return self.respond(*store.accept(request))
        def do_GET(self):
            if self.path==PREFIX+"/health":
                return self.respond(200,{"service":"personal-agent-os-alpha4-ingress",
                                         "status":"READY","executed":False})
            if not store.authorized(self.headers.get("Authorization")):
                return self.respond(401,{"error":"NOT_AUTHORIZED"})
            if self.path==PREFIX+"/v3/telemetry/summary":
                device=store.device_for_bearer(self.headers.get("Authorization"))
                if device is None:
                    return self.respond(401,{"error":"NOT_AUTHORIZED"})
                return self.respond(200,telemetry.summary(device))
            if self.path==PREFIX+"/v4/board":
                return self.respond(200,works_v8.board())
            if self.path==PREFIX+"/v2/works":
                return self.respond(200,store.works())
            start=PREFIX+"/v2/commands/"
            if self.path.startswith(start):
                return self.respond(*store.status(self.path[len(start):]))
            return self.respond(404,{"error":"NOT_FOUND"})
    return ThreadingHTTPServer((address,port),Handler)

def main():
    p=argparse.ArgumentParser()
    p.add_argument("command",choices=["serve","new-pair","summary","read-telemetry"])
    p.add_argument("--db",required=True)
    p.add_argument("--port",type=int,default=18765)
    p.add_argument("--ttl",type=int,default=1800)
    p.add_argument("--device-prefix",default=None)
    p.add_argument("--limit",type=int,default=25)
    a=p.parse_args()
    store=Store(a.db)
    if a.command=="new-pair":
        print(store.create_pair(seconds=max(60,min(86400,a.ttl))))
    elif a.command=="summary":
        print(json.dumps({"queued":store.count(),"executed":False}))
    elif a.command=="read-telemetry":
        print(json.dumps(TelemetryStore(store).read_owner(a.device_prefix,a.limit),ensure_ascii=False,indent=2))
    else:
        httpd=create_server(store,port=a.port)
        print("ALPHA4_INGRESS_READY port="+str(httpd.server_port),flush=True)
        httpd.serve_forever()

if __name__=="__main__":main()
