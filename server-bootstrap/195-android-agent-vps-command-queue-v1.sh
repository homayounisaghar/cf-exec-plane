#!/usr/bin/env bash
set -euo pipefail
umask 077

[[ "$(id -u)" -eq 0 ]] || exit 10

state_dir=/var/lib/capability-fabric/paa-command-queue
server=/usr/local/libexec/paa-command-queue-server.py
unit=/etc/systemd/system/capability-fabric-paa-command-queue.service
caddy=/etc/caddy/Caddyfile
binding=/etc/capability-fabric/secrets/android-agent/device-binding-alpha10-line3.json
producer=/etc/capability-fabric/secrets/android-agent/producer-p256-v1.pem
ingest_db=/var/lib/capability-fabric/paa-ingest/ingest.sqlite3

[[ -s "$binding" ]] || exit 11
[[ -s "$producer" ]] || exit 12
[[ -f "$caddy" ]] || exit 13
python3 - <<'PY'
import cryptography, sqlite3
PY

install -d -m 0700 -o root -g root "$state_dir"

cat > "$server" <<'PY'
#!/usr/bin/env python3
import base64
import hashlib
import json
import os
import re
import sqlite3
import time
from datetime import datetime, timezone, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.error import HTTPError
from urllib.parse import parse_qs, quote, urlparse
from urllib.request import urlopen
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec, padding
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

HOST="127.0.0.1"
PORT=8793
DB_PATH="/var/lib/capability-fabric/paa-command-queue/queue.sqlite3"
INGEST_DB="/var/lib/capability-fabric/paa-ingest/ingest.sqlite3"
BINDING_PATH="/etc/capability-fabric/secrets/android-agent/device-binding-alpha10-line3.json"
PRODUCER_PATH="/etc/capability-fabric/secrets/android-agent/producer-p256-v1.pem"
KEY_ID="personal-android-agent-producer-v1"
AUDIENCE="com.homayounisaghar.androidagent"
AAD=b"personal-android-agent.encrypted-command.v1"
MAX_BODY=65536

BINDING=json.loads(Path(BINDING_PATH).read_text())
PRIVATE=serialization.load_pem_private_key(Path(PRODUCER_PATH).read_bytes(), password=None)
DEVICE=serialization.load_der_public_key(base64.b64decode(BINDING["command_encryption_spki_b64"]))
if not isinstance(PRIVATE, ec.EllipticCurvePrivateKey) or PRIVATE.curve.name != "secp256r1":
    raise SystemExit("producer key")
if getattr(DEVICE,"key_size",None) != 3072:
    raise SystemExit("device key")

def b64u(data):
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()

def compact(obj):
    return json.dumps(obj,separators=(",",":"),ensure_ascii=False).encode()

def db():
    conn=sqlite3.connect(DB_PATH,timeout=10)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=FULL")
    conn.execute("""CREATE TABLE IF NOT EXISTS commands(
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      request_id TEXT NOT NULL UNIQUE,
      request_digest TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL,
      expires_at_ms INTEGER NOT NULL,
      action TEXT NOT NULL,
      envelope_json TEXT NOT NULL
    )""")
    return conn

def path_value(value, allow_empty):
    if not isinstance(value,str) or len(value)>512 or value.startswith("/") or value.endswith("/") or "\\" in value or "\x00" in value:
        raise ValueError("path")
    if not value:
        if allow_empty: return value
        raise ValueError("path")
    for part in value.split("/"):
        if not part or part in {".",".."} or len(part)>128:
            raise ValueError("path")
    return value

def leaf(value):
    if not isinstance(value,str) or not 1<=len(value)<=180 or value in {".",".."} or any(x in value for x in ["/","\\","\x00","\r","\n"]):
        raise ValueError("filename")
    return value

def https_url(value, prefix):
    if not isinstance(value,str) or len(value)>4096:
        raise ValueError("url")
    if not re.fullmatch(r"https://cf-onshape\.duckdns\.org"+prefix+r"[0-9a-f]{64}",value):
        raise ValueError("url")
    return value

def mime(value):
    if not isinstance(value,str) or len(value)>128 or not re.fullmatch(r"[a-z0-9][a-z0-9!#&^_.+-]{0,63}/[a-z0-9][a-z0-9!#&^_.+-]{0,63}",value.lower()):
        raise ValueError("mime")
    return value.lower()

def validate(req):
    if not isinstance(req,dict) or set(req)!={"request_id","action","parameters","ttl_seconds"}:
        raise ValueError("request_fields")
    rid=req["request_id"]
    if not isinstance(rid,str) or not re.fullmatch(r"[A-Za-z0-9_.-]{8,96}",rid):
        raise ValueError("request_id")
    ttl=req["ttl_seconds"]
    if not isinstance(ttl,int) or isinstance(ttl,bool) or not 30<=ttl<=3600:
        raise ValueError("ttl")
    action=req["action"]
    p=req["parameters"]
    if not isinstance(p,dict):
        raise ValueError("parameters")
    if action=="storage.status":
        if p: raise ValueError("storage_status_parameters")
    elif action=="storage.list":
        if set(p)!={"directory","limit"}: raise ValueError("storage_list_parameters")
        path_value(p["directory"],True)
        if not isinstance(p["limit"],int) or isinstance(p["limit"],bool) or not 1<=p["limit"]<=500: raise ValueError("limit")
    elif action=="storage.stat":
        if set(p)!={"path"}: raise ValueError("storage_stat_parameters")
        path_value(p["path"],False)
    elif action=="storage.search":
        if set(p)!={"directory","query","alternate_queries","extension","recursive","limit"}:
            raise ValueError("storage_search_parameters")
        path_value(p["directory"],True)
        if not isinstance(p["query"],str) or len(p["query"])>180:
            raise ValueError("query")
        if not isinstance(p["alternate_queries"],list) or len(p["alternate_queries"])>8:
            raise ValueError("alternate_queries")
        for item in p["alternate_queries"]:
            if not isinstance(item,str) or not 1<=len(item)<=180:
                raise ValueError("alternate_queries")
        if not isinstance(p["extension"],str) or not re.fullmatch(r"\.?[A-Za-z0-9]{0,16}",p["extension"]):
            raise ValueError("extension")
        if not isinstance(p["recursive"],bool):
            raise ValueError("recursive")
        if not isinstance(p["limit"],int) or isinstance(p["limit"],bool) or not 1<=p["limit"]<=100:
            raise ValueError("limit")
        if not p["query"].strip() and not p["extension"].strip(".") and not p["alternate_queries"]:
            raise ValueError("search_query_required")
    elif action=="sms.status":
        if p: raise ValueError("sms_status_parameters")
    elif action=="sms.list":
        if set(p)!={"box","limit","address","unread_only","since_ms"}: raise ValueError("sms_list_parameters")
        if p["box"] not in {"any","inbox","sent","draft","outbox","failed","queued"}: raise ValueError("box")
        if not isinstance(p["limit"],int) or isinstance(p["limit"],bool) or not 1<=p["limit"]<=50: raise ValueError("limit")
        if not isinstance(p["address"],str) or len(p["address"])>160: raise ValueError("address")
        if not isinstance(p["unread_only"],bool): raise ValueError("unread_only")
        if not isinstance(p["since_ms"],int) or isinstance(p["since_ms"],bool) or p["since_ms"]<0: raise ValueError("since_ms")
    elif action=="sms.conversation_list":
        if set(p)!={"limit"}: raise ValueError("sms_conversation_list_parameters")
        if not isinstance(p["limit"],int) or isinstance(p["limit"],bool) or not 1<=p["limit"]<=50: raise ValueError("limit")
    elif action=="sms.search":
        if set(p)!={"query","box","limit","since_ms"}: raise ValueError("sms_search_parameters")
        if not isinstance(p["query"],str) or not 1<=len(p["query"])<=300: raise ValueError("query")
        if p["box"] not in {"any","inbox","sent","draft","outbox","failed","queued"}: raise ValueError("box")
        if not isinstance(p["limit"],int) or isinstance(p["limit"],bool) or not 1<=p["limit"]<=50: raise ValueError("limit")
        if not isinstance(p["since_ms"],int) or isinstance(p["since_ms"],bool) or p["since_ms"]<0: raise ValueError("since_ms")
    elif action=="contacts.search":
        if set(p)!={"query","limit"}: raise ValueError("contacts_search_parameters")
        if not isinstance(p["query"],str) or not 1<=len(p["query"])<=200: raise ValueError("query")
        if not isinstance(p["limit"],int) or isinstance(p["limit"],bool) or not 1<=p["limit"]<=50: raise ValueError("limit")
    elif action=="sms.send":
        if set(p)!={"recipient","body","subscription_id"}: raise ValueError("sms_send_parameters")
        if not isinstance(p["recipient"],str) or not 1<=len(p["recipient"])<=160: raise ValueError("recipient")
        if not isinstance(p["body"],str) or not 1<=len(p["body"])<=10000: raise ValueError("body")
        if not isinstance(p["subscription_id"],int) or isinstance(p["subscription_id"],bool) or p["subscription_id"] < -1: raise ValueError("subscription_id")
    elif action=="sms.mark_read":
        if set(p)!={"message_id","read"}: raise ValueError("sms_mark_read_parameters")
        if not isinstance(p["message_id"],str) or not re.fullmatch(r"[0-9]{1,19}",p["message_id"]): raise ValueError("message_id")
        if not isinstance(p["read"],bool): raise ValueError("read")
    elif action=="sms.delete":
        if set(p)!={"message_id","confirm"}: raise ValueError("sms_delete_parameters")
        if not isinstance(p["message_id"],str) or not re.fullmatch(r"[0-9]{1,19}",p["message_id"]): raise ValueError("message_id")
        if p["confirm"] is not True: raise ValueError("confirmation_required")
    elif action=="sms.thread_delete":
        if set(p)!={"thread_id","confirm"}: raise ValueError("sms_thread_delete_parameters")
        if not isinstance(p["thread_id"],str) or not re.fullmatch(r"[0-9]{1,19}",p["thread_id"]): raise ValueError("thread_id")
        if p["confirm"] is not True: raise ValueError("confirmation_required")
    elif action=="storage.file.save_from_url":
        if set(p)!={"url","sha256","size_bytes","directory","filename","mime"}: raise ValueError("storage_save_parameters")
        https_url(p["url"],r"/mcp/telegram-file/")
        if not isinstance(p["sha256"],str) or not re.fullmatch(r"[0-9a-f]{64}",p["sha256"]): raise ValueError("sha256")
        if not isinstance(p["size_bytes"],int) or isinstance(p["size_bytes"],bool) or not 1<=p["size_bytes"]<=2147483648: raise ValueError("size")
        path_value(p["directory"],True); leaf(p["filename"]); mime(p["mime"])
    elif action=="storage.file.upload_to_url":
        if set(p)!={"path","upload_url","size_bytes"}: raise ValueError("storage_upload_parameters")
        path_value(p["path"],False)
        https_url(p["upload_url"],r"/mcp/upload/")
        if not isinstance(p["size_bytes"],int) or isinstance(p["size_bytes"],bool) or not 1<=p["size_bytes"]<=2147483648: raise ValueError("size")
    else:
        raise ValueError("action_not_admitted")
    return rid,action,p,ttl

def produce(req):
    rid,action,params,ttl=validate(req)
    digest=hashlib.sha256(compact(req)).hexdigest()
    conn=db()
    try:
        prior=conn.execute("SELECT seq,request_digest,envelope_json FROM commands WHERE request_id=?",(rid,)).fetchone()
        if prior:
            if prior[1]!=digest: raise RuntimeError("request_id_collision")
            return {"ok":True,"request_id":rid,"seq":prior[0],"envelope":json.loads(prior[2]),"duplicate":True}
        now=datetime.now(timezone.utc)
        exp=now+timedelta(seconds=ttl)
        issued=now.isoformat(timespec="milliseconds").replace("+00:00","Z")
        expires=exp.isoformat(timespec="milliseconds").replace("+00:00","Z")
        recipe={"protocol_version":"1","request_id":rid,"action":action,"parameters":params,
                "issued_at":issued,"expires_at":expires,"idempotency_key":rid}
        payload={"schema":"personal-android-agent.command-payload.v1","command_id":rid,
                 "audience":AUDIENCE,"device_id":BINDING["device_id"],"issued_at":issued,
                 "expires_at":expires,"recipe":recipe}
        payload_bytes=compact(payload)
        sig=PRIVATE.sign(payload_bytes,ec.ECDSA(hashes.SHA256()))
        signed={"schema":"personal-android-agent.signed-command.v1","producer_key_id":KEY_ID,
                "payload_b64":b64u(payload_bytes),"signature_b64":b64u(sig)}
        key=os.urandom(16); nonce=os.urandom(12)
        ct=AESGCM(key).encrypt(nonce,compact(signed),AAD)
        wrapped=DEVICE.encrypt(key,padding.OAEP(mgf=padding.MGF1(algorithm=hashes.SHA1()),algorithm=hashes.SHA256(),label=None))
        env={"schema":"personal-android-agent.encrypted-command.v1",
             "device_key_id":BINDING["command_encryption_key_id"],
             "wrapped_key_b64":b64u(wrapped),"nonce_b64":b64u(nonce),"ciphertext_b64":b64u(ct)}
        raw=json.dumps(env,separators=(",",":"))
        cur=conn.execute("INSERT INTO commands(request_id,request_digest,created_at_ms,expires_at_ms,action,envelope_json) VALUES(?,?,?,?,?,?)",
            (rid,digest,int(time.time()*1000),int(exp.timestamp()*1000),action,raw))
        conn.commit()
        return {"ok":True,"request_id":rid,"seq":cur.lastrowid,"envelope":env,"duplicate":False}
    finally:
        conn.close()

def queue(after,limit):
    conn=db()
    try:
        rows=conn.execute("""SELECT seq,request_id,expires_at_ms,envelope_json FROM commands
             WHERE seq>? ORDER BY seq ASC LIMIT ?""",(after,limit)).fetchall()
    finally:
        conn.close()
    now=int(time.time()*1000)
    items=[]
    for seq,rid,expires,raw in rows:
        if expires < now: continue
        items.append({"seq":seq,"envelope":json.loads(raw)})
    return {"schema":"personal-android-agent.command-queue.v1","commands":items}

def status(request_id):
    if not re.fullmatch(r"[A-Za-z0-9_.-]{8,96}",request_id or ""):
        raise ValueError("request_id")
    conn=db()
    try:
        row=conn.execute("SELECT seq,action,created_at_ms,expires_at_ms FROM commands WHERE request_id=?",(request_id,)).fetchone()
    finally:
        conn.close()
    if row is None: return None
    result={"schema":"personal-android-agent.command-status.v1","request_id":request_id,
            "seq":row[0],"action":row[1],"created_at_ms":row[2],"expires_at_ms":row[3],
            "receipt":None}
    try:
        receipt_url="http://127.0.0.1:8792/local/v1/receipts?command_id="+quote(request_id,safe="")
        with urlopen(receipt_url,timeout=2) as response:
            raw=response.read(262144)
            if response.read(1):
                raise ValueError("receipt_response_size")
        value=json.loads(raw)
        if value.get("schema")!="personal-android-agent.ingest-receipt-read.v1":
            raise ValueError("receipt_schema")
        payload=value.get("payload")
        if not isinstance(payload,dict):
            raise ValueError("receipt_payload")
        result["receipt"]=payload
        cursor=payload.get("cursor")
        if isinstance(cursor,int) and not isinstance(cursor,bool):
            result["receipt_cursor_decimal"]=str(cursor)
    except HTTPError as e:
        if e.code!=404:
            result["receipt_lookup_error"]="http_"+str(e.code)
    except Exception as e:
        result["receipt_lookup_error"]=e.__class__.__name__
    result["state"]="COMPLETED" if result["receipt"] else ("EXPIRED" if row[3]<int(time.time()*1000) else "PENDING")
    return result

class H(BaseHTTPRequestHandler):
    server_version="PAACommandQueue/1"
    def log_message(self,*args): return
    def sendj(self,code,obj):
        raw=json.dumps(obj,separators=(",",":")).encode()
        self.send_response(code); self.send_header("Content-Type","application/json")
        self.send_header("Content-Length",str(len(raw))); self.send_header("Cache-Control","no-store")
        self.end_headers(); self.wfile.write(raw)
    def body(self):
        n=int(self.headers.get("Content-Length","0"))
        if n<2 or n>MAX_BODY: raise ValueError("content_length")
        return json.loads(self.rfile.read(n))
    def do_GET(self):
        u=urlparse(self.path); q=parse_qs(u.query)
        try:
            if u.path=="/paa/v1/commands":
                after=max(0,int(q.get("after",["0"])[0])); limit=max(1,min(100,int(q.get("limit",["50"])[0])))
                return self.sendj(200,queue(after,limit))
            if u.path=="/local/v1/health":
                return self.sendj(200,{"status":"ok","schema":"personal-android-agent.command-queue-health.v1"})
            if u.path=="/local/v1/status":
                value=status(q.get("request_id",[""])[0])
                return self.sendj(200 if value else 404,value or {"error":"not_found"})
            return self.sendj(404,{"error":"not_found"})
        except Exception as e:
            return self.sendj(400,{"error":str(e)[:120]})
    def do_POST(self):
        if self.path!="/local/v1/publish": return self.sendj(404,{"error":"not_found"})
        try: return self.sendj(200,produce(self.body()))
        except RuntimeError as e: return self.sendj(409,{"ok":False,"error":str(e)})
        except Exception as e: return self.sendj(400,{"ok":False,"error":str(e)[:120]})

if __name__=="__main__":
    conn=db(); conn.close()
    ThreadingHTTPServer((HOST,PORT),H).serve_forever()
PY
chmod 0750 "$server"
chown root:root "$server"

cat > "$unit" <<'UNIT'
[Unit]
Description=Capability Fabric Personal Android Agent bounded command queue
After=network-online.target capability-fabric-paa-ingest.service
Wants=network-online.target

[Service]
Type=simple
User=root
Group=root
ExecStart=/usr/bin/python3 /usr/local/libexec/paa-command-queue-server.py
Restart=always
RestartSec=2
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadOnlyPaths=/etc/capability-fabric/secrets/android-agent /var/lib/capability-fabric/paa-ingest
ReadWritePaths=/var/lib/capability-fabric/paa-command-queue
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectKernelLogs=true
ProtectControlGroups=true
RestrictRealtime=true
RestrictAddressFamilies=AF_INET AF_INET6
SystemCallArchitectures=native

[Install]
WantedBy=multi-user.target
UNIT
chmod 0644 "$unit"

python3 - "$caddy" <<'PY'
import sys
p=sys.argv[1]
text=open(p,encoding="utf-8").read()
if "/paa/v1/commands" not in text:
    marker='''\thandle /mcp/* {
\t\treverse_proxy 127.0.0.1:8787
\t}
'''
    block='''\t@paa_commands {
\t\tpath /paa/v1/commands
\t\tmethod GET
\t}
\thandle @paa_commands {
\t\treverse_proxy 127.0.0.1:8793
\t}
'''
    if marker not in text: raise SystemExit("caddy baseline mismatch")
    text=text.replace(marker,block+marker,1)
    open(p,"w",encoding="utf-8").write(text)
PY

caddy validate --config "$caddy"
systemctl daemon-reload
systemctl enable --now capability-fabric-paa-command-queue.service
systemctl restart capability-fabric-paa-command-queue.service
systemctl reload caddy

for _ in $(seq 1 30); do
  curl --fail --silent http://127.0.0.1:8793/local/v1/health >/tmp/paa-command-health.json 2>/dev/null && break
  sleep 1
done
python3 - <<'PY'
import json
o=json.load(open("/tmp/paa-command-health.json"))
assert o["status"]=="ok"
PY
curl --fail --silent 'https://cf-onshape.duckdns.org/paa/v1/commands?after=0&limit=1' >/tmp/paa-command-public.json
python3 - <<'PY'
import json
o=json.load(open("/tmp/paa-command-public.json"))
assert o["schema"]=="personal-android-agent.command-queue.v1"
assert isinstance(o["commands"],list)
PY

bad="$(curl --silent -X POST -H 'Content-Type: application/json' --data '{"request_id":"paa-storage-negative-20261004-001","action":"raw.shell","parameters":{},"ttl_seconds":300}' http://127.0.0.1:8793/local/v1/publish)"
[[ "$bad" == *'action_not_admitted'* ]]

bad_search="$(curl --silent -X POST -H 'Content-Type: application/json' --data '{"request_id":"paa-search-negative-20261004-001","action":"storage.search","parameters":{"directory":"Download","query":"","alternate_queries":[],"extension":"","recursive":true,"limit":25},"ttl_seconds":300}' http://127.0.0.1:8793/local/v1/publish)"
[[ "$bad_search" == *'search_query_required'* ]]

printf 'CF_PAA_COMMAND_QUEUE_BEGIN\n'
printf 'SERVICE=%s\n' "$(systemctl is-active capability-fabric-paa-command-queue.service)"
printf 'PUBLIC_QUEUE=PASS\n'
printf 'RAW_SHELL_NEGATIVE=PASS\n'
printf 'STORAGE_SEARCH_VALIDATOR=PASS\n'
printf 'CF_PAA_COMMAND_QUEUE_END\n'
