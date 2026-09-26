#!/usr/bin/env bash
set -euo pipefail
umask 077

[[ "$(id -u)" -eq 0 ]] || { echo "must run as root" >&2; exit 1; }

remote_user=paa_remote
remote_group=paa_remote
remote_home=/var/lib/capability-fabric/paa-remote
publisher_state=/var/lib/capability-fabric/android-agent-publisher
pairing_file=/var/lib/capability-fabric/state/paa-remote-pairing.txt
binding_file=/etc/capability-fabric/secrets/android-agent/device-binding-alpha10-line3.json
repo_token=/etc/capability-fabric/secrets/repo-read-token
producer_key=/etc/capability-fabric/secrets/android-agent/producer-p256-v1.pem
producer_pub=/etc/capability-fabric/trust/android-agent/producer-p256-v1.pub.pem
expected_device_key_id=f3b36d38fdf16bae4175064f76e22c5f92938dd845e44e275ebbb6d772d8af63
dc_version=0.2.51

[[ -s "$repo_token" && "$(stat -c '%U:%G:%a' "$repo_token")" == root:root:600 ]] || { echo "repo read token unavailable" >&2; exit 10; }
[[ -s "$producer_key" && "$(stat -c '%U:%G:%a' "$producer_key")" == root:root:600 ]] || { echo "producer key unavailable" >&2; exit 11; }
[[ -s "$producer_pub" ]] || { echo "producer public key unavailable" >&2; exit 12; }

export DEBIAN_FRONTEND=noninteractive
need_pkgs=()
command -v python3 >/dev/null 2>&1 || need_pkgs+=(python3)
python3 - <<'PY' >/dev/null 2>&1 || need_pkgs+=(python3-cryptography)
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
PY
if ! command -v node >/dev/null 2>&1 || ! node -e 'const m=+process.versions.node.split(".")[0]; process.exit(m>=18?0:1)' >/dev/null 2>&1; then
  need_pkgs+=(nodejs npm)
elif ! command -v npx >/dev/null 2>&1; then
  need_pkgs+=(npm)
fi
if ((${#need_pkgs[@]})); then
  apt-get update
  apt-get install -y "${need_pkgs[@]}"
fi
python3 - <<'PY'
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
PY
node -e 'const m=+process.versions.node.split(".")[0]; if(m<18) process.exit(1)'
command -v npx >/dev/null

if ! getent group "$remote_group" >/dev/null; then
  groupadd --system "$remote_group"
fi
if ! id "$remote_user" >/dev/null 2>&1; then
  useradd --system --gid "$remote_group" --home-dir "$remote_home" --create-home --shell /bin/bash "$remote_user"
fi
[[ "$(id -u "$remote_user")" -ne 0 ]] || exit 13
[[ "$(id -Gn "$remote_user")" == "$remote_group" ]] || { echo "remote user has unexpected supplementary groups" >&2; exit 14; }
passwd -l "$remote_user" >/dev/null 2>&1 || true
install -d -m 0700 -o "$remote_user" -g "$remote_group" "$remote_home" "$remote_home/.npm"
install -d -m 0700 -o root -g root "$publisher_state" "$publisher_state/requests"
install -d -m 0755 -o root -g root /var/lib/capability-fabric/state /etc/capability-fabric/secrets/android-agent /usr/local/libexec

cfg="$(mktemp)"
api_json="$(mktemp)"
binding_tmp="$(mktemp)"
trap 'rm -f "$cfg" "$api_json" "$binding_tmp"' EXIT
chmod 600 "$cfg" "$api_json" "$binding_tmp"
token="$(cat "$repo_token")"
{
  printf 'silent\nshow-error\nfail\n'
  printf 'header = "Authorization: Bearer %s"\n' "$token"
  printf 'header = "Accept: application/vnd.github+json"\n'
  printf 'header = "X-GitHub-Api-Version: 2022-11-28"\n'
} > "$cfg"
unset token
curl -K "$cfg"   'https://api.github.com/repos/homayounisaghar/capability-fabric/contents/projects/personal-android-agent/private/device-binding-alpha10-line3.json?ref=project%2Fpersonal-android-agent'   > "$api_json"
python3 - "$api_json" "$binding_tmp" "$expected_device_key_id" <<'PY'
import base64, json, re, sys
src,dst,expected=sys.argv[1:]
obj=json.load(open(src))
raw=base64.b64decode((obj.get("content") or "").replace("\n",""))
binding=json.loads(raw)
required={
  "schema","device_id","receipt_signing_key_id","receipt_signing_spki_b64",
  "command_encryption_key_id","command_encryption_spki_b64",
}
if set(binding) != required:
    raise SystemExit("device binding fields")
if binding["schema"] != "personal-android-agent.device-identity.v1":
    raise SystemExit("device binding schema")
if binding["command_encryption_key_id"] != expected:
    raise SystemExit("unexpected device encryption key")
if not re.fullmatch(r"[0-9a-f-]{36}", binding["device_id"]):
    raise SystemExit("device id")
open(dst,"wb").write(raw)
PY
install -m 0600 -o root -g root "$binding_tmp" "$binding_file"

cat > /usr/local/libexec/paa-envelope-publisher.py <<'PY'
#!/usr/bin/env python3
import base64, fcntl, hashlib, json, os, re, socket
from datetime import datetime, timezone, timedelta
from pathlib import Path
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec, padding
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

SOCKET_PATH="/run/capability-fabric/paa-publisher.sock"
BINDING_PATH=Path("/etc/capability-fabric/secrets/android-agent/device-binding-alpha10-line3.json")
PRIVATE_KEY_PATH=Path("/etc/capability-fabric/secrets/android-agent/producer-p256-v1.pem")
PUBLIC_KEY_PATH=Path("/etc/capability-fabric/trust/android-agent/producer-p256-v1.pub.pem")
STATE_DIR=Path("/var/lib/capability-fabric/android-agent-publisher")
REQ_DIR=STATE_DIR/"requests"
LOCK_PATH=STATE_DIR/"publisher.lock"
KEY_ID="personal-android-agent-producer-v1"
AUDIENCE="com.homayounisaghar.androidagent"
AAD=b"personal-android-agent.encrypted-command.v1"

def b64u(data):
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")

def canonical(obj):
    return json.dumps(obj, sort_keys=True, separators=(",",":"), ensure_ascii=False).encode("utf-8")

def compact(obj):
    return json.dumps(obj, separators=(",",":"), ensure_ascii=False).encode("utf-8")

def fail(msg):
    raise ValueError(msg)

def validate(req):
    if not isinstance(req, dict):
        fail("request must be object")
    if set(req) != {"schema","request_id","action","parameters","ttl_seconds"}:
        fail("request fields")
    if req["schema"] != "personal-android-agent.remote-request.v1":
        fail("request schema")
    rid=req["request_id"]
    if not isinstance(rid,str) or not re.fullmatch(r"[A-Za-z0-9_.-]{8,96}",rid):
        fail("request_id")
    if req["action"] != "notification.post":
        fail("action not admitted by bootstrap publisher")
    p=req["parameters"]
    if not isinstance(p,dict) or set(p) != {"title","text"}:
        fail("notification parameters")
    title,text=p["title"],p["text"]
    if not isinstance(title,str) or not 1 <= len(title) <= 120 or any(c in title for c in "\r\n\0"):
        fail("notification title")
    if not isinstance(text,str) or not 1 <= len(text) <= 500 or "\0" in text:
        fail("notification text")
    ttl=req["ttl_seconds"]
    if not isinstance(ttl,int) or isinstance(ttl,bool) or ttl < 30 or ttl > 3600:
        fail("ttl_seconds")
    return rid

def load_keys():
    binding=json.loads(BINDING_PATH.read_text())
    private_key=serialization.load_pem_private_key(PRIVATE_KEY_PATH.read_bytes(), password=None)
    public_key=serialization.load_pem_public_key(PUBLIC_KEY_PATH.read_bytes())
    if not isinstance(private_key, ec.EllipticCurvePrivateKey) or private_key.curve.name != "secp256r1":
        fail("producer private key type")
    if private_key.public_key().public_numbers() != public_key.public_numbers():
        fail("producer keypair mismatch")
    device_der=base64.b64decode(binding["command_encryption_spki_b64"])
    device_key=serialization.load_der_public_key(device_der)
    if getattr(device_key, "key_size", None) != 3072:
        fail("device encryption key size")
    return binding, private_key, public_key, device_key

def produce(req):
    rid=validate(req)
    digest=hashlib.sha256(canonical(req)).hexdigest()
    REQ_DIR.mkdir(parents=True, exist_ok=True, mode=0o700)
    lockfd=os.open(LOCK_PATH, os.O_RDWR|os.O_CREAT, 0o600)
    try:
        fcntl.flock(lockfd, fcntl.LOCK_EX)
        record_path=REQ_DIR/(rid+".json")
        if record_path.exists():
            prior=json.loads(record_path.read_text())
            if prior.get("request_digest") != digest:
                fail("request_id reused with different request")
            return prior["response"]

        binding,private_key,public_key,device_key=load_keys()
        now=datetime.now(timezone.utc)
        issued=now.isoformat(timespec="milliseconds").replace("+00:00","Z")
        expires=(now+timedelta(seconds=req["ttl_seconds"])).isoformat(timespec="milliseconds").replace("+00:00","Z")
        recipe={
            "protocol_version":"1",
            "request_id":rid,
            "action":req["action"],
            "parameters":req["parameters"],
            "issued_at":issued,
            "expires_at":expires,
            "idempotency_key":rid,
        }
        payload={
            "schema":"personal-android-agent.command-payload.v1",
            "command_id":rid,
            "audience":AUDIENCE,
            "device_id":binding["device_id"],
            "issued_at":issued,
            "expires_at":expires,
            "recipe":recipe,
        }
        payload_bytes=compact(payload)
        if len(payload_bytes) > 65536:
            fail("payload too large")

        sig=private_key.sign(payload_bytes, ec.ECDSA(hashes.SHA256()))
        public_key.verify(sig, payload_bytes, ec.ECDSA(hashes.SHA256()))
        signed={
            "schema":"personal-android-agent.signed-command.v1",
            "producer_key_id":KEY_ID,
            "payload_b64":b64u(payload_bytes),
            "signature_b64":b64u(sig),
        }
        signed_bytes=compact(signed)
        aes_key=os.urandom(16)
        nonce=os.urandom(12)
        ciphertext=AESGCM(aes_key).encrypt(nonce, signed_bytes, AAD)
        wrapped=device_key.encrypt(
            aes_key,
            padding.OAEP(
                mgf=padding.MGF1(algorithm=hashes.SHA1()),
                algorithm=hashes.SHA256(),
                label=None,
            ),
        )
        envelope={
            "schema":"personal-android-agent.encrypted-command.v1",
            "device_key_id":binding["command_encryption_key_id"],
            "wrapped_key_b64":b64u(wrapped),
            "nonce_b64":b64u(nonce),
            "ciphertext_b64":b64u(ciphertext),
        }
        envelope_bytes=compact(envelope)
        response={
            "ok":True,
            "request_id":rid,
            "request_digest":digest,
            "envelope_sha256":hashlib.sha256(envelope_bytes).hexdigest(),
            "envelope":envelope,
        }
        record={"request_digest":digest,"response":response}
        tmp=record_path.with_suffix(".tmp")
        with open(tmp,"w",encoding="utf-8") as fh:
            os.fchmod(fh.fileno(),0o600)
            json.dump(record,fh,separators=(",",":"),ensure_ascii=False)
            fh.write("\n")
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp,record_path)
        return response
    finally:
        os.close(lockfd)

def serve():
    os.makedirs(os.path.dirname(SOCKET_PATH), mode=0o755, exist_ok=True)
    try:
        os.unlink(SOCKET_PATH)
    except FileNotFoundError:
        pass
    s=socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    s.bind(SOCKET_PATH)
    os.chmod(SOCKET_PATH,0o660)
    import grp
    os.chown(SOCKET_PATH,0,grp.getgrnam("paa_remote").gr_gid)
    s.listen(8)
    while True:
        conn,_=s.accept()
        with conn:
            try:
                data=b""
                while True:
                    chunk=conn.recv(65536)
                    if not chunk:
                        break
                    data += chunk
                    if len(data)>16384:
                        fail("request too large")
                req=json.loads(data.decode("utf-8"))
                out=compact(produce(req))
            except Exception as e:
                out=compact({"ok":False,"error":str(e)[:160]})
            conn.sendall(out+b"\n")

if __name__=="__main__":
    serve()
PY
chmod 0750 /usr/local/libexec/paa-envelope-publisher.py
chown root:root /usr/local/libexec/paa-envelope-publisher.py

cat > /usr/local/bin/paa-publish-envelope <<'PY'
#!/usr/bin/env python3
import socket,sys
path="/run/capability-fabric/paa-publisher.sock"
data=sys.stdin.buffer.read(16385)
if not data or len(data)>16384:
    raise SystemExit("expected bounded JSON on stdin")
s=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM)
s.connect(path)
s.sendall(data)
s.shutdown(socket.SHUT_WR)
out=b""
while True:
    chunk=s.recv(65536)
    if not chunk:
        break
    out += chunk
    if len(out)>262144:
        raise SystemExit("publisher response too large")
sys.stdout.buffer.write(out)
PY
chmod 0755 /usr/local/bin/paa-publish-envelope
chown root:root /usr/local/bin/paa-publish-envelope

cat > /etc/systemd/system/capability-fabric-paa-publisher.service <<'UNIT'
[Unit]
Description=Capability Fabric Personal Android Agent bounded envelope publisher
After=network.target

[Service]
Type=simple
ExecStart=/usr/local/libexec/paa-envelope-publisher.py
User=root
Group=root
UMask=0077
Restart=on-failure
RestartSec=2
PrivateTmp=yes
ProtectHome=yes
ProtectSystem=strict
ReadWritePaths=/run/capability-fabric /var/lib/capability-fabric/android-agent-publisher
NoNewPrivileges=yes
LockPersonality=yes
RestrictSUIDSGID=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectKernelLogs=yes
ProtectControlGroups=yes
RestrictRealtime=yes
RestrictAddressFamilies=AF_UNIX
SystemCallArchitectures=native

[Install]
WantedBy=multi-user.target
UNIT

cat > /etc/systemd/system/capability-fabric-paa-remote.service <<UNIT
[Unit]
Description=Restricted Remote Desktop Commander transport for Personal Android Agent
After=network-online.target capability-fabric-paa-publisher.service
Wants=network-online.target
Requires=capability-fabric-paa-publisher.service

[Service]
Type=simple
User=$remote_user
Group=$remote_group
Environment=HOME=$remote_home
Environment=NPM_CONFIG_CACHE=$remote_home/.npm
WorkingDirectory=$remote_home
ExecStart=/usr/bin/npx -y @wonderwhy-er/desktop-commander@$dc_version remote
Restart=on-failure
RestartSec=5
UMask=0077
PrivateTmp=yes
ProtectHome=yes
ProtectSystem=strict
ReadWritePaths=$remote_home
InaccessiblePaths=/etc/capability-fabric/secrets /etc/capability-fabric/trust /var/lib/capability-fabric/android-agent-publisher /var/lib/capability-fabric/onshape /opt/capability-fabric
NoNewPrivileges=yes
CapabilityBoundingSet=
AmbientCapabilities=
LockPersonality=yes
RestrictSUIDSGID=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectKernelLogs=yes
ProtectControlGroups=yes
PrivateDevices=yes
RestrictRealtime=yes
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
ProtectProc=invisible
ProcSubset=pid
SystemCallArchitectures=native

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable --now capability-fabric-paa-publisher.service
systemctl enable capability-fabric-paa-remote.service >/dev/null 2>&1 || true
systemctl restart capability-fabric-paa-remote.service

for _ in $(seq 1 30); do
  if systemctl is-active --quiet capability-fabric-paa-publisher.service; then
    break
  fi
  sleep 1
done
systemctl is-active --quiet capability-fabric-paa-publisher.service

if runuser -u "$remote_user" -- cat "$producer_key" >/dev/null 2>&1; then
  echo "restricted user can read producer key" >&2
  exit 30
fi
if runuser -u "$remote_user" -- cat "$binding_file" >/dev/null 2>&1; then
  echo "restricted user can read device binding" >&2
  exit 31
fi

rm -f "$pairing_file"
journal_tmp="$(mktemp)"
trap 'rm -f "$cfg" "$api_json" "$binding_tmp" "$journal_tmp" "$pairing_file.tmp"' EXIT
for _ in $(seq 1 90); do
  journalctl -u capability-fabric-paa-remote.service --since '-15 minutes' --no-pager -o cat > "$journal_tmp" 2>/dev/null || true
  python3 - "$journal_tmp" "$pairing_file.tmp" <<'PY'
import re,sys
src,dst=sys.argv[1:]
lines=open(src,encoding="utf-8",errors="replace").read().splitlines()
url=None
code=None
expiry=None
for i,line in enumerate(lines):
    s=line.strip()
    if s in {"1. Open this URL in your browser:","1. Verify this device in your browser:"} and i+1 < len(lines):
        url=lines[i+1].strip()
    elif s in {"2. Enter this code when prompted:","2. Make sure the code matches:"} and i+1 < len(lines):
        code=lines[i+1].strip()
    elif s.startswith("Code expires in "):
        expiry=s
m=re.fullmatch(r"https://mcp\.desktopcommander\.app/device/verify\?user_code=([A-Z0-9]{4}-[A-Z0-9]{4})", url or "")
if m:
    if code is None:
        code=m.group(1)
    if code==m.group(1):
        with open(dst,"w",encoding="utf-8") as out:
            out.write(url+"\n")
            out.write(code+"\n")
            if expiry:
                out.write(expiry+"\n")
PY
  if [[ -s "$pairing_file.tmp" ]]; then
    install -m 0600 -o root -g root "$pairing_file.tmp" "$pairing_file"
    rm -f "$pairing_file.tmp"
    break
  fi
  rm -f "$pairing_file.tmp"
  sleep 2
done

printf 'CF_PAA_REMOTE_BOOTSTRAP_BEGIN\n'
printf 'PUBLISHER_SERVICE=%s\n' "$(systemctl is-active capability-fabric-paa-publisher.service)"
printf 'REMOTE_SERVICE=%s\n' "$(systemctl is-active capability-fabric-paa-remote.service || true)"
printf 'REMOTE_USER=%s\n' "$remote_user"
printf 'REMOTE_USER_UID=%s\n' "$(id -u "$remote_user")"
printf 'REMOTE_USER_GROUPS=%s\n' "$(id -Gn "$remote_user")"
printf 'PRODUCER_KEY_READABLE_BY_REMOTE=no\n'
printf 'DEVICE_BINDING_READABLE_BY_REMOTE=no\n'
printf 'PAIRING_MATERIAL=%s\n' "$([[ -s "$pairing_file" ]] && printf ready || printf pending)"
printf 'DESKTOP_COMMANDER_VERSION=%s\n' "$dc_version"
printf 'CF_PAA_REMOTE_BOOTSTRAP_END\n'

[[ -s "$pairing_file" ]] || exit 40
