#!/usr/bin/env bash
set -euo pipefail

user_name=pcg-forward
authorized_keys=/etc/capability-fabric/pcg-forward/authorized_keys

echo "PCG_FORWARD_ACCOUNT_BEGIN"
getent passwd "$user_name" | awk -F: '{print "user="$1,"uid="$3,"gid="$4,"home="$6,"shell="$7}'
passwd -S "$user_name" | awk '{print "password_status="$2}'
chage -l "$user_name" | sed -E 's/^(Password expires|Account expires)[[:space:]]*:[[:space:]]*/\1=/'
id "$user_name" | sed 's/^/identity=/'
echo "PCG_FORWARD_ACCOUNT_END"

echo "PCG_FORWARD_KEY_BEGIN"
stat -c 'authorized_keys_mode=%a owner=%U group=%G' "$authorized_keys"
ssh-keygen -lf "$authorized_keys" -E sha256 | awk '{print "authorized_key_fingerprint="$2,"type="$4}'
echo "PCG_FORWARD_KEY_END"

echo "PCG_FORWARD_EFFECTIVE_BEGIN"
effective="$(sshd -T -C user="$user_name",host=localhost,addr=127.0.0.1)"
for key in   pubkeyauthentication authenticationmethods authorizedkeysfile strictmodes   passwordauthentication kbdinteractiveauthentication forcecommand   allowtcpforwarding permitopen permittty x11forwarding allowagentforwarding   gatewayports permituserrc clientaliveinterval clientalivecountmax   logingracetime tcpkeepalive channeltimeout unusedconnectiontimeout   allowusers denyusers allowgroups denygroups; do
  line="$(awk -v k="$key" '$1==k{$1=""; sub(/^ /,""); print; exit}' <<<"$effective")"
  printf '%s=%s\n' "$key" "${line:-<unset>}"
done
echo "PCG_FORWARD_EFFECTIVE_END"

echo "PCG_FORWARD_GATE_STATE_BEGIN"
stat -c 'bootstrap_mode=%a owner=%U group=%G mtime=%y' /run/capability-fabric-pcg-forward/bootstrap-url 2>/dev/null || true
test -f /run/capability-fabric-pcg-forward/bootstrap-url && echo "bootstrap=present" || echo "bootstrap=missing"
test -e /var/lib/capability-fabric/pcg/run/provision-complete && echo "complete=yes" || echo "complete=no"
echo "PCG_FORWARD_GATE_STATE_END"

echo "PCG_FORWARD_SSH_LOG_BEGIN"
{
  journalctl -u ssh.service --since '10 minutes ago' --until 'now' --no-pager 2>/dev/null || true
  journalctl -u sshd.service --since '10 minutes ago' --until 'now' --no-pager 2>/dev/null || true
} |
  tail -n 120 |
  sed -E 's/from [0-9a-fA-F:.]+ port [0-9]+/from REDACTED/g; s/rhost=[^ ]+/rhost=REDACTED/g; s/port [0-9]+ ssh2/port REDACTED ssh2/g'
echo "PCG_FORWARD_SSH_LOG_END"

echo "PCG_SYSTEM_EVENTS_BEGIN"
journalctl --since '10 minutes ago' --until 'now' --no-pager 2>/dev/null |
  grep -E 'ssh(d)?\.service|sshd-session|Started OpenBSD|Stopped OpenBSD|Reloading OpenBSD|Reloaded OpenBSD|reboot|shutdown|Docker|docker\.service|NetworkManager|systemd-networkd' |
  tail -n 160 |
  sed -E 's/from [0-9a-fA-F:.]+ port [0-9]+/from REDACTED/g; s/rhost=[^ ]+/rhost=REDACTED/g; s/port [0-9]+ ssh2/port REDACTED ssh2/g' || true
echo "PCG_SYSTEM_EVENTS_END"

echo "PCG_PROVISION_SESSION_DIAG_BEGIN"
host_token=/run/capability-fabric/pcg-provision/token
if [[ -f "$host_token" ]]; then
  python3 - "$host_token" <<'PY'
import hashlib,sys
p=sys.argv[1]
data=open(p,'rb').read().strip()
print("host_token_sha256="+hashlib.sha256(data).hexdigest())
print("host_token_len="+str(len(data)))
PY
else
  echo "host_token=missing"
fi

cid="$(docker ps --filter name=^/capability-fabric-pcg-telegram$ --format '{{.ID}}' | head -n1)"
if [[ -n "$cid" ]]; then
  docker exec "$cid" python - <<'PY'
import hashlib,json,socket,urllib.request,urllib.error
from pathlib import Path
p=Path('/provision/token')
if p.exists():
    data=p.read_bytes().strip()
    print("container_token_sha256="+hashlib.sha256(data).hexdigest())
    print("container_token_len="+str(len(data)))
else:
    print("container_token=missing")
s=socket.socket(socket.AF_UNIX)
s.settimeout(2)
s.connect('/run/pcg/telegram.sock')
s.sendall(b'{"op":"health"}')
h=json.loads(s.recv(4096).decode())
s.close()
for k in ('provisioning_surface','authorization','authorization_state','tdlib_client'):
    print(f"runtime_{k}={h.get(k)}")
PY
  if [[ -f "$host_token" ]]; then
    python3 - "$host_token" <<'PY'
import sys,urllib.request,urllib.error
token=open(sys.argv[1],encoding='utf-8').read().strip()
req=urllib.request.Request(
    'http://127.0.0.1:8766/session',
    data=token.encode(),
    method='POST',
    headers={'Content-Type':'text/plain','Origin':'http://127.0.0.1:8766'},
)
try:
    with urllib.request.urlopen(req,timeout=3) as r:
        print("host_same_token_session_status="+str(r.status))
except urllib.error.HTTPError as e:
    print("host_same_token_session_status="+str(e.code))
except Exception as e:
    print("host_same_token_session_error="+type(e).__name__)
PY
  else
    echo "host_same_token_session_status=skipped-no-token"
  fi
else
  echo "pcg_telegram_container=missing"
fi
echo "PCG_PROVISION_SESSION_DIAG_END"

echo "PCG_PROVISION_RUNTIME_DIAG_BEGIN"
python3 - <<'PY'
import json,socket
s=socket.socket(socket.AF_UNIX)
s.settimeout(2)
s.connect('/var/lib/capability-fabric/pcg/run/telegram.sock')
s.sendall(b'{"op":"health"}')
d=json.loads(s.recv(4096).decode())
s.close()
for k in ('provisioning_surface','authorization','authorization_state','tdlib_client'):
    print(f"host_runtime_{k}={d.get(k)}")
PY
cid="$(docker ps --filter name=^/capability-fabric-pcg-telegram$ --format '{{.ID}}' | head -n1)"
if [[ -n "$cid" ]]; then
  echo "container_id=present"
  docker inspect -f 'container_running={{.State.Running}} health={{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}} started={{.State.StartedAt}}' "$cid"
  docker exec -i "$cid" python - <<'PY'
import hashlib,http.client
from pathlib import Path
p=Path('/provision/token')
if p.exists():
    data=p.read_bytes().strip()
    print("container_token_sha256="+hashlib.sha256(data).hexdigest())
    print("container_token_len="+str(len(data)))
else:
    print("container_token=missing")
try:
    c=http.client.HTTPConnection('127.0.0.1',8766,timeout=2)
    c.request('GET','/healthz')
    r=c.getresponse()
    print("container_healthz_status="+str(r.status))
    print("container_healthz_body="+r.read(128).decode('utf-8','replace'))
except Exception as e:
    print("container_healthz_error="+type(e).__name__)
PY
  docker logs --tail 80 "$cid" 2>&1 | sed -E 's/[A-Za-z0-9_-]{32,}/[REDACTED]/g' | tail -n 80
fi
echo "PCG_PROVISION_RUNTIME_DIAG_END"

echo "PCG_WEB_DEPLOY_DIAG_BEGIN"
detail=/var/log/capability-fabric/pcg-pull-agent-detail.log
if [[ -f "$detail" ]]; then
  grep -E 'pcg-web-login-r6|pcg_web|compose|health|unhealthy|error|ERROR|failed|FAIL|npm|node|socket|profile' "$detail" 2>/dev/null |
    tail -n 240 |
    sed -E 's#https?://[^[:space:]]+#URL_REDACTED#g; s/[A-Za-z0-9_+\/-]{48,}/[REDACTED]/g' || true
else
  echo "pcg_pull_detail=missing"
fi
release=/var/lib/capability-fabric/deploy/pcg/releases/pcg-web-login-r6
if [[ -d "$release" ]]; then
  echo "staged_release=present"
  stat -c 'release_mode=%a owner=%U group=%G' "$release"
  if [[ -s "$release/manifest.json" ]]; then
    python3 - "$release/manifest.json" <<'PY'
import json,sys
m=json.load(open(sys.argv[1],encoding='utf-8'))
print("release_id="+str(m.get("release_id")))
print("sequence="+str(m.get("sequence")))
print("health_timeout_seconds="+str(m.get("health_timeout_seconds")))
PY
  fi
else
  echo "staged_release=missing"
fi
web_cid="$(docker ps -a --filter name='^/capability-fabric-pcg-web$' --format '{{.ID}}' | head -n1)"
if [[ -n "$web_cid" ]]; then
  docker inspect -f 'web_running={{.State.Running}} web_status={{.State.Status}} web_exit={{.State.ExitCode}} web_health={{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$web_cid"
  docker logs --tail 160 "$web_cid" 2>&1 |
    sed -E 's#https?://[^[:space:]]+#URL_REDACTED#g; s/[A-Za-z0-9_+\/-]{48,}/[REDACTED]/g' |
    tail -n 160
else
  echo "web_container=absent_after_rollback"
fi
echo "PCG_WEB_DEPLOY_DIAG_END"
