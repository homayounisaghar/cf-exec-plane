#!/usr/bin/env bash
set -euo pipefail
umask 077

[[ "$(id -u)" -eq 0 ]] || { echo "must run as uid 0" >&2; exit 1; }
mode="${CF_PCG_WEB_CONTROL_MODE:-}"
case "$mode" in prepare|status|semantic-status|semantic-conversations|phone|code|password|cleanup|screenshot|mytelegram-start|mytelegram-capture-code|mytelegram-signin|mytelegram-create-app|mytelegram-screenshot) ;; *) echo "invalid mode" >&2; exit 2 ;; esac

run_root=/var/lib/capability-fabric/pcg/run
socket="$run_root/web.sock"
key_root=/run/capability-fabric/pcg-web-control
private_key="$key_root/ephemeral-rsa.pem"
public_key="$key_root/ephemeral-rsa.pub.pem"

for cmd in python3 openssl base64 docker; do
  command -v "$cmd" >/dev/null 2>&1 || { echo "missing required tool: $cmd" >&2; exit 20; }
done

active=/opt/capability-fabric/channels/pcg/current
[[ -L "$active" ]] || { echo "PCG_WEB_ACTIVE_RELEASE=missing" >&2; exit 21; }
release="$(readlink -f "$active")"
[[ -s "$release/manifest.json" ]] || exit 21
python3 - "$release/manifest.json" <<'PY'
import json,sys
m=json.load(open(sys.argv[1],encoding='utf-8'))
if int(m.get('sequence',0)) < 6:
    raise SystemExit('Telegram Web control requires PCG sequence >= 6')
PY

cid="$(docker ps --filter name='^/capability-fabric-pcg-web$' --format '{{.ID}}' | head -n1)"
[[ -n "$cid" ]] || { echo "PCG_WEB_CONTAINER=absent" >&2; exit 22; }
[[ "$(docker inspect -f '{{.State.Health.Status}}' "$cid")" == healthy ]] || { echo "PCG_WEB_CONTAINER=unhealthy" >&2; exit 22; }
[[ -S "$socket" ]] || { echo "PCG_WEB_SOCKET=absent" >&2; exit 22; }

socket_simple() {
  local op="$1"
  python3 - "$socket" "$op" <<'PY'
import json,socket,sys
sock_path,op=sys.argv[1:]
s=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM)
s.settimeout(35)
s.connect(sock_path)
s.sendall((json.dumps({'op':op},separators=(',',':'))+'\n').encode())
buf=b''
while b'\n' not in buf:
    chunk=s.recv(65536)
    if not chunk: break
    buf+=chunk
s.close()
if not buf: raise SystemExit('empty browser response')
d=json.loads(buf.split(b'\n',1)[0])
safe={k:d.get(k) for k in ('ok','phase','origin','pathname','logged_in','error') if k in d}
print(json.dumps(safe,separators=(',',':')))
if not d.get('ok'): raise SystemExit(40)
PY
}


socket_semantic() {
  local operation="$1"
  local purpose="${2:-}"
  python3 - "$socket" "$operation" "$purpose" <<'PY'
import json,socket,sys
sock_path,operation,purpose=sys.argv[1:]
payload={'op':'semantic.invoke','operation':operation,'args':{}}
if operation == 'communication.conversation.list':
    payload['args']={'limit':20}
if purpose:
    payload['purpose']=purpose
s=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM)
s.settimeout(35)
s.connect(sock_path)
s.sendall((json.dumps(payload,separators=(',',':'))+'\n').encode())
buf=b''
while b'\n' not in buf:
    chunk=s.recv(65536)
    if not chunk:
        break
    buf+=chunk
s.close()
if not buf:
    raise SystemExit('empty browser response')
d=json.loads(buf.split(b'\n',1)[0])
safe={k:d.get(k) for k in ('ok','state','operation','provider','realization','error') if k in d}
obs=d.get('observation')
if isinstance(obs,dict):
    allowed=('connection_state','logged_in','count','handles','bounded','provider_content_model_visible')
    safe['observation']={k:obs.get(k) for k in allowed if k in obs}
print(json.dumps(safe,separators=(',',':')))
if d.get('state') != 'ACHIEVED':
    raise SystemExit(40)
PY
}

if [[ "$mode" == prepare ]]; then
  install -d -m 0700 -o root -g root "$key_root"
  rm -f "$private_key" "$public_key"
  openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:3072 -out "$private_key" >/dev/null 2>&1
  chmod 0600 "$private_key"
  openssl pkey -in "$private_key" -pubout -out "$public_key" >/dev/null 2>&1
  chmod 0644 "$public_key"
  socket_simple open
  printf 'PCG_WEB_PUBLIC_KEY_PEM_B64=%s\n' "$(base64 -w0 < "$public_key")"
  printf 'PCG_WEB_CONTROL_PREPARE=pass\n'
  exit 0
fi

if [[ "$mode" == status ]]; then
  socket_simple health
  exit 0
fi

if [[ "$mode" == semantic-status || "$mode" == semantic-conversations ]]; then
  sequence="$(python3 - "$release/manifest.json" <<'PY'
import json,sys
print(int(json.load(open(sys.argv[1],encoding='utf-8')).get('sequence',0)))
PY
)"
  [[ "$sequence" -ge 18 ]] || { echo "PCG_WEB_SEMANTIC_RUNTIME=too-old" >&2; exit 29; }
  if [[ "$mode" == semantic-status ]]; then
    socket_semantic communication.session.status
  else
    socket_semantic communication.conversation.list PROTECTED_DISPLAY
  fi
  printf 'PCG_WEB_SEMANTIC_%s=pass\n' "${mode#semantic-}"
  exit 0
fi

if [[ "$mode" == screenshot ]]; then
  sequence="$(python3 - "$release/manifest.json" <<'PY'
import json,sys
print(int(json.load(open(sys.argv[1],encoding='utf-8')).get('sequence',0)))
PY
)"
  [[ "$sequence" -ge 11 ]] || { echo "PCG_WEB_SCREENSHOT_RUNTIME=too-old" >&2; exit 26; }
  shot="$run_root/telegram-web-ui.png"
  rm -f "$shot"
  socket_simple screenshot
  [[ -s "$shot" ]] || { echo "PCG_WEB_SCREENSHOT=missing" >&2; exit 27; }
  chmod 0600 "$shot"
  printf 'PCG_WEB_SCREENSHOT_READY=yes\n'
  exit 0
fi

if [[ "$mode" == mytelegram-capture-code ]]; then
  socket_simple mytelegram.capture_code
  exit 0
fi

if [[ "$mode" == mytelegram-signin ]]; then
  socket_simple mytelegram.signin
  exit 0
fi

if [[ "$mode" == mytelegram-create-app ]]; then
  socket_simple mytelegram.create_app
  src="$run_root/mytelegram-api.json"
  dst_dir=/var/lib/capability-fabric/pcg/api-credentials
  dst="$dst_dir/telegram-api.json"
  if [[ -s "$src" ]]; then
    install -d -m 0700 -o 65534 -g 65534 "$dst_dir"
    install -m 0600 -o 65534 -g 65534 "$src" "$dst"
    rm -f "$src"
    printf 'PCG_TELEGRAM_API_CREDENTIALS=installed\n'
  fi
  exit 0
fi

if [[ "$mode" == mytelegram-screenshot ]]; then
  shot="$run_root/mytelegram-ui.png"
  rm -f "$shot"
  socket_simple mytelegram.screenshot
  [[ -s "$shot" ]] || { echo "PCG_MYTELEGRAM_SCREENSHOT=missing" >&2; exit 28; }
  chmod 0600 "$shot"
  printf 'PCG_MYTELEGRAM_SCREENSHOT_READY=yes\n'
  exit 0
fi

if [[ "$mode" == cleanup ]]; then
  rm -f "$private_key" "$public_key"
  printf 'PCG_WEB_EPHEMERAL_KEY=removed\n'
  exit 0
fi

[[ -s "$private_key" ]] || { echo "PCG_WEB_EPHEMERAL_KEY=missing" >&2; exit 23; }
cipher="${CF_PCG_WEB_CONTROL_CIPHERTEXT:-}"
[[ "$cipher" =~ ^[A-Za-z0-9+/=]{32,8192}$ ]] || { echo "invalid ciphertext" >&2; exit 24; }

tmp_cipher="$(mktemp "$key_root/.cipher.XXXXXX")"
tmp_plain="$(mktemp "$key_root/.plain.XXXXXX")"
cleanup_files() { rm -f "$tmp_cipher" "$tmp_plain"; }
trap cleanup_files EXIT
printf '%s' "$cipher" | base64 -d > "$tmp_cipher"
openssl pkeyutl -decrypt -inkey "$private_key" -in "$tmp_cipher" -out "$tmp_plain" \
  -pkeyopt rsa_padding_mode:oaep -pkeyopt rsa_oaep_md:sha256 -pkeyopt rsa_mgf1_md:sha256 >/dev/null 2>&1
[[ -s "$tmp_plain" ]] || { echo "decrypt failed" >&2; exit 25; }

case "$mode" in
  phone) op='login.phone' ;;
  code) op='login.code' ;;
  password) op='login.password' ;;
  mytelegram-start) op='mytelegram.start' ;;
esac

python3 - "$socket" "$op" "$tmp_plain" <<'PY'
import json,socket,sys
sock_path,op,plain_path=sys.argv[1:]
with open(plain_path,'r',encoding='utf-8') as f:
    value=f.read()
s=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM)
s.settimeout(40)
s.connect(sock_path)
s.sendall((json.dumps({'op':op,'value':value},separators=(',',':'))+'\n').encode())
value=''
buf=b''
while b'\n' not in buf:
    chunk=s.recv(65536)
    if not chunk: break
    buf+=chunk
s.close()
if not buf: raise SystemExit('empty browser response')
d=json.loads(buf.split(b'\n',1)[0])
safe={k:d.get(k) for k in ('ok','phase','origin','pathname','logged_in','error') if k in d}
print(json.dumps(safe,separators=(',',':')))
if not d.get('ok'): raise SystemExit(40)
PY
: > "$tmp_plain"
printf 'PCG_WEB_CONTROL_%s=pass\n' "${mode^^}"
