#!/usr/bin/env bash
set -euo pipefail
umask 077

[[ "$(id -u)" -eq 0 ]] || exit 10

svc_user=paa_ingest
svc_group=paa_ingest
svc_dir=/var/lib/capability-fabric/paa-ingest
cfg_dir=/etc/capability-fabric/paa-ingest
binding_src=/etc/capability-fabric/secrets/android-agent/device-binding-alpha10-line3.json
server=/usr/local/libexec/paa-ingest-server.py
unit=/etc/systemd/system/capability-fabric-paa-ingest.service
caddy=/etc/caddy/Caddyfile

[[ -f "$binding_src" ]] || exit 11
[[ -f "$caddy" ]] || exit 12
python3 - <<'PY'
import cryptography, sqlite3
PY

if ! getent group "$svc_group" >/dev/null; then
  groupadd --system "$svc_group"
fi
if ! id "$svc_user" >/dev/null 2>&1; then
  useradd --system --gid "$svc_group" --home-dir /nonexistent --shell /usr/sbin/nologin "$svc_user"
fi

install -d -m 0750 -o "$svc_user" -g "$svc_group" "$svc_dir"
install -d -m 0750 -o root -g "$svc_group" "$cfg_dir"
install -m 0640 -o root -g "$svc_group" "$binding_src" "$cfg_dir/device-binding.json"

cat > "$server" <<'PY'
#!/usr/bin/env python3
import base64
import hashlib
import json
import os
import sqlite3
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec

BINDING_PATH = "/etc/capability-fabric/paa-ingest/device-binding.json"
DB_PATH = "/var/lib/capability-fabric/paa-ingest/ingest.sqlite3"
HOST = "127.0.0.1"
PORT = 8792
MAX_BODY = 262144

with open(BINDING_PATH, "r", encoding="utf-8") as f:
    BINDING = json.load(f)
DEVICE_ID = BINDING["device_id"]
KEY_ID = BINDING["receipt_signing_key_id"]
SPKI = base64.b64decode(BINDING["receipt_signing_spki_b64"])
PUB = serialization.load_der_public_key(SPKI)
assert hashlib.sha256(SPKI).hexdigest() == KEY_ID

def b64url_decode(value):
    if not isinstance(value, str) or len(value) > 524288:
        raise ValueError("b64")
    return base64.urlsafe_b64decode(value + "=" * ((4 - len(value) % 4) % 4))

def db():
    conn = sqlite3.connect(DB_PATH, timeout=10)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=FULL")
    conn.execute("""CREATE TABLE IF NOT EXISTS telemetry (
        event_id TEXT PRIMARY KEY,
        received_at_ms INTEGER NOT NULL,
        timestamp_ms INTEGER NOT NULL,
        build_id TEXT NOT NULL,
        version TEXT NOT NULL,
        phase TEXT NOT NULL,
        status TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        envelope_json TEXT NOT NULL
    )""")
    conn.execute("""CREATE TABLE IF NOT EXISTS receipts (
        command_id TEXT PRIMARY KEY,
        received_at_ms INTEGER NOT NULL,
        cursor_value INTEGER NOT NULL,
        result TEXT NOT NULL,
        action TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        envelope_json TEXT NOT NULL
    )""")
    return conn

def verify_envelope(envelope, expected_schema):
    required = {"schema","key_id","payload_b64","signature_b64","public_key_spki_b64"}
    if not isinstance(envelope, dict) or set(envelope) != required:
        raise ValueError("envelope_fields")
    if envelope["schema"] != expected_schema:
        raise ValueError("envelope_schema")
    if envelope["key_id"] != KEY_ID:
        raise ValueError("key_id")
    spki = base64.b64decode(envelope["public_key_spki_b64"], validate=True)
    if spki != SPKI or hashlib.sha256(spki).hexdigest() != KEY_ID:
        raise ValueError("spki")
    payload = b64url_decode(envelope["payload_b64"])
    sig = b64url_decode(envelope["signature_b64"])
    if len(payload) > MAX_BODY:
        raise ValueError("payload_size")
    PUB.verify(sig, payload, ec.ECDSA(hashes.SHA256()))
    obj = json.loads(payload.decode("utf-8"))
    return payload, obj

def store_telemetry(envelope):
    payload, obj = verify_envelope(
        envelope, "personal-android-agent.signed-telemetry.v1")
    if obj.get("schema") != "personal-android-agent.telemetry.v1":
        raise ValueError("telemetry_schema")
    if obj.get("device_instance_id") != DEVICE_ID:
        raise ValueError("device_id")
    event_id = obj.get("event_id")
    if not isinstance(event_id, str) or not 8 <= len(event_id) <= 160:
        raise ValueError("event_id")
    raw_payload = payload.decode("utf-8")
    raw_envelope = json.dumps(envelope, separators=(",",":"), sort_keys=True)
    conn = db()
    try:
        cur = conn.execute("""INSERT OR IGNORE INTO telemetry
            (event_id,received_at_ms,timestamp_ms,build_id,version,phase,status,payload_json,envelope_json)
            VALUES (?,?,?,?,?,?,?,?,?)""", (
            event_id, int(time.time()*1000), int(obj.get("timestamp_ms",0)),
            str(obj.get("build_id",""))[:32], str(obj.get("version",""))[:80],
            str(obj.get("phase",""))[:96], str(obj.get("status",""))[:64],
            raw_payload, raw_envelope))
        conn.commit()
        return cur.rowcount == 1
    finally:
        conn.close()

def store_receipt(envelope):
    payload, obj = verify_envelope(
        envelope, "personal-android-agent.device-receipt.v1")
    if obj.get("schema") != "personal-android-agent.device-receipt-payload.v1":
        raise ValueError("receipt_schema")
    if obj.get("device_id") != DEVICE_ID:
        raise ValueError("device_id")
    command_id = obj.get("command_id")
    if not isinstance(command_id, str) or not 8 <= len(command_id) <= 160:
        raise ValueError("command_id")
    receipt = obj.get("receipt")
    if not isinstance(receipt, dict):
        raise ValueError("receipt")
    raw_payload = payload.decode("utf-8")
    raw_envelope = json.dumps(envelope, separators=(",",":"), sort_keys=True)
    conn = db()
    try:
        prior = conn.execute(
            "SELECT payload_json FROM receipts WHERE command_id=?", (command_id,)
        ).fetchone()
        if prior is not None:
            if prior[0] != raw_payload:
                raise RuntimeError("command_id_collision")
            return False
        conn.execute("""INSERT INTO receipts
            (command_id,received_at_ms,cursor_value,result,action,payload_json,envelope_json)
            VALUES (?,?,?,?,?,?,?)""", (
            command_id, int(time.time()*1000), int(obj.get("cursor",-1)),
            str(receipt.get("result",""))[:32], str(receipt.get("action",""))[:128],
            raw_payload, raw_envelope))
        conn.commit()
        return True
    finally:
        conn.close()

class Handler(BaseHTTPRequestHandler):
    server_version = "PAAIngest/1"

    def log_message(self, fmt, *args):
        return

    def send_json(self, code, obj):
        raw = json.dumps(obj, separators=(",",":")).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(raw)

    def read_json(self):
        try:
            n = int(self.headers.get("Content-Length","0"))
        except Exception:
            raise ValueError("content_length")
        if n < 2 or n > MAX_BODY:
            raise ValueError("content_length")
        raw = self.rfile.read(n)
        return json.loads(raw.decode("utf-8"))

    def do_GET(self):
        u = urlparse(self.path)
        if u.path == "/paa/v1/health":
            return self.send_json(200, {
                "schema":"personal-android-agent.ingest-health.v1",
                "status":"ok"
            })
        if u.path == "/local/v1/stats":
            conn = db()
            try:
                t = conn.execute("SELECT COUNT(*) FROM telemetry").fetchone()[0]
                r = conn.execute("SELECT COUNT(*) FROM receipts").fetchone()[0]
                latest = conn.execute(
                    "SELECT COALESCE(MAX(received_at_ms),0) FROM telemetry"
                ).fetchone()[0]
            finally:
                conn.close()
            return self.send_json(200, {
                "schema":"personal-android-agent.ingest-stats.v1",
                "telemetry_count":t,"receipt_count":r,
                "latest_telemetry_received_at_ms":latest
            })
        if u.path == "/local/v1/telemetry":
            q = parse_qs(u.query)
            try:
                limit = max(1, min(200, int(q.get("limit",["50"])[0])))
            except Exception:
                limit = 50
            conn = db()
            try:
                rows = conn.execute("""SELECT payload_json FROM telemetry
                    ORDER BY received_at_ms DESC LIMIT ?""",(limit,)).fetchall()
            finally:
                conn.close()
            return self.send_json(200, {
                "schema":"personal-android-agent.ingest-telemetry-read.v1",
                "events":[json.loads(x[0]) for x in reversed(rows)]
            })
        if u.path == "/local/v1/receipts":
            q = parse_qs(u.query)
            command_id = q.get("command_id",[""])[0]
            if not command_id:
                return self.send_json(400, {"error":"command_id_required"})
            conn = db()
            try:
                row = conn.execute("""SELECT payload_json,envelope_json
                    FROM receipts WHERE command_id=?""",(command_id,)).fetchone()
            finally:
                conn.close()
            if row is None:
                return self.send_json(404, {"error":"not_found"})
            return self.send_json(200, {
                "schema":"personal-android-agent.ingest-receipt-read.v1",
                "payload":json.loads(row[0]),
                "envelope":json.loads(row[1])
            })
        return self.send_json(404, {"error":"not_found"})

    def do_POST(self):
        try:
            envelope = self.read_json()
            if self.path == "/paa/v1/telemetry":
                inserted = store_telemetry(envelope)
                return self.send_json(201 if inserted else 200, {
                    "ok":True,"stored":inserted
                })
            if self.path == "/paa/v1/receipt":
                inserted = store_receipt(envelope)
                return self.send_json(201 if inserted else 200, {
                    "ok":True,"stored":inserted
                })
            return self.send_json(404, {"error":"not_found"})
        except RuntimeError as e:
            return self.send_json(409, {"ok":False,"error":str(e)})
        except Exception:
            return self.send_json(401, {"ok":False,"error":"invalid_signed_payload"})

if __name__ == "__main__":
    conn = db()
    conn.close()
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
PY
chmod 0755 "$server"
chown root:root "$server"

cat > "$unit" <<'UNIT'
[Unit]
Description=Capability Fabric Personal Android Agent signed ingest
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=paa_ingest
Group=paa_ingest
ExecStart=/usr/bin/python3 /usr/local/libexec/paa-ingest-server.py
Restart=always
RestartSec=2
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadOnlyPaths=/etc/capability-fabric/paa-ingest
ReadWritePaths=/var/lib/capability-fabric/paa-ingest

[Install]
WantedBy=multi-user.target
UNIT
chmod 0644 "$unit"

python3 - "$caddy" <<'PY'
import sys
p=sys.argv[1]
text=open(p,encoding="utf-8").read()
marker='''\thandle /mcp/* {
\t\treverse_proxy 127.0.0.1:8787
\t}
'''
if "paa/v1/telemetry" not in text:
    block='''\t@paa_telemetry {
\t\tpath /paa/v1/telemetry
\t\tmethod POST
\t}
\thandle @paa_telemetry {
\t\treverse_proxy 127.0.0.1:8792
\t}
\t@paa_receipt {
\t\tpath /paa/v1/receipt
\t\tmethod POST
\t}
\thandle @paa_receipt {
\t\treverse_proxy 127.0.0.1:8792
\t}
\t@paa_health {
\t\tpath /paa/v1/health
\t\tmethod GET
\t}
\thandle @paa_health {
\t\treverse_proxy 127.0.0.1:8792
\t}
'''
    if marker not in text:
        raise SystemExit("caddy baseline mismatch")
    text=text.replace(marker,block+marker,1)
    open(p,"w",encoding="utf-8").write(text)
PY

caddy validate --config "$caddy"
systemctl daemon-reload
systemctl enable --now capability-fabric-paa-ingest.service
systemctl restart capability-fabric-paa-ingest.service
systemctl reload caddy

for _ in $(seq 1 30); do
  if curl --fail --silent --show-error --max-time 2 http://127.0.0.1:8792/paa/v1/health >/tmp/paa-ingest-health.json 2>/dev/null; then
    break
  fi
  sleep 1
done
python3 - <<'PY'
import json
o=json.load(open("/tmp/paa-ingest-health.json",encoding="utf-8"))
assert o.get("schema")=="personal-android-agent.ingest-health.v1"
assert o.get("status")=="ok"
PY
curl --fail --silent --show-error --max-time 10 https://cf-onshape.duckdns.org/paa/v1/health > /tmp/paa-ingest-public-health.json
python3 - <<'PY'
import json
o=json.load(open("/tmp/paa-ingest-public-health.json",encoding="utf-8"))
assert o.get("status")=="ok"
PY

code="$(curl --silent --output /tmp/paa-ingest-negative.json --write-out '%{http_code}' \
  -H 'Content-Type: application/json' \
  --data '{"schema":"personal-android-agent.device-receipt.v1","key_id":"bad","payload_b64":"e30","signature_b64":"eA","public_key_spki_b64":"eA=="}' \
  https://cf-onshape.duckdns.org/paa/v1/receipt)"
[[ "$code" == "401" ]]
python3 - <<'PY'
import json
o=json.load(open("/tmp/paa-ingest-negative.json",encoding="utf-8"))
assert o.get("ok") is False
PY

stats="$(curl --fail --silent http://127.0.0.1:8792/local/v1/stats)"
printf 'CF_PAA_INGEST_DEPLOY_BEGIN\n'
printf 'SERVICE=%s\n' "$(systemctl is-active capability-fabric-paa-ingest.service)"
printf 'CADDY=%s\n' "$(systemctl is-active caddy.service)"
printf 'PUBLIC_HEALTH=PASS\n'
printf 'INVALID_SIGNATURE_NEGATIVE=PASS\n'
printf 'LOCAL_STATS=%s\n' "$stats"
printf 'CF_PAA_INGEST_DEPLOY_END\n'
