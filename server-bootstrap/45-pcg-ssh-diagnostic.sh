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

echo "PCG_WEB_ISOLATED_SMOKE_BEGIN"
release=/var/lib/capability-fabric/deploy/pcg/releases/pcg-web-login-r6
image='mcr.microsoft.com/playwright:v1.62.1-resolute@sha256:aebd85bce8056dcdc2269853fd94ea432b6a201da4f0ef125b509489ecd52ddb'
debug_name=capability-fabric-pcg-web-debug
tmp_debug="$(mktemp -d /var/lib/capability-fabric/pcg/.web-debug.XXXXXX)"
cleanup_debug() {
  docker rm -f "$debug_name" >/dev/null 2>&1 || true
  rm -rf "$tmp_debug"
}
trap cleanup_debug EXIT
install -d -m 0700 -o 65534 -g 65534 "$tmp_debug/run" "$tmp_debug/profile"
(
  exec 8>/run/lock/capability-fabric-pull.lock
  flock 8
  docker rm -f "$debug_name" >/dev/null 2>&1 || true
  docker run -d --name "$debug_name"     --user 65534:65534     --network bridge     --read-only     --tmpfs /tmp:rw,nosuid,nodev,size=512m     --shm-size 128m     --memory 768m     --cpus 1.00     --pids-limit 160     --cap-drop ALL     --security-opt no-new-privileges:true     --health-cmd 'node -e '\''const net=require("net");const s=net.createConnection("/run/pcg/web.sock");s.setTimeout(2000);s.on("connect",()=>s.write("{\\\"op\\\":\\\"health\\\"}\\n"));let b="";s.on("data",d=>{b+=d;if(b.includes("\\n")){const x=JSON.parse(b.split("\\n")[0]);process.exit(x.ok===true&&x.phase!=="BROWSER_CLOSED"?0:1)}});s.on("timeout",()=>process.exit(1));s.on("error",()=>process.exit(1));'\'''     --health-interval 2s     --health-timeout 4s     --health-retries 3     --health-start-period 2s     -v "$release:/release:ro"     -v "$tmp_debug/run:/run/pcg:rw"     -v "$tmp_debug/profile:/profile:rw"     -e PCG_WEB_PROFILE_DIR=/profile     -e PCG_WEB_SOCKET=/run/pcg/web.sock     -e PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1     -e NPM_CONFIG_CACHE=/tmp/npm-cache     -e HOME=/tmp     -e NODE_ENV=production     "$image" sh -lc 'umask 077 && chmod 0700 /profile && mkdir -p /tmp/app && cp /release/pcg_web_browser.mjs /tmp/app/pcg_web_browser.mjs && cp /release/pcg_web_package.json /tmp/app/package.json && cd /tmp/app && PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install --omit=dev --ignore-scripts --no-audit --no-fund --package-lock=false && exec node pcg_web_browser.mjs' >/dev/null
)
for _ in $(seq 1 45); do
  state="$(docker inspect -f '{{.State.Status}}' "$debug_name" 2>/dev/null || true)"
  health="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$debug_name" 2>/dev/null || true)"
  [[ "$state" == running ]] || break
  [[ "$health" == healthy ]] && break
  sleep 1
done
if docker inspect "$debug_name" >/dev/null 2>&1; then
  docker inspect -f 'debug_running={{.State.Running}} debug_status={{.State.Status}} debug_exit={{.State.ExitCode}} debug_oom={{.State.OOMKilled}} debug_health={{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}} started={{.State.StartedAt}}' "$debug_name"
  docker inspect -f '{{if .State.Health}}{{range .State.Health.Log}}health_probe_exit={{.ExitCode}} health_probe_output={{json .Output}}{{println}}{{end}}{{end}}' "$debug_name" | tail -n 12
  if [[ -S "$tmp_debug/run/web.sock" ]]; then
    python3 - "$tmp_debug/run/web.sock" <<'PY'
import json,socket,sys
s=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM); s.settimeout(3); s.connect(sys.argv[1])
s.sendall(b'{"op":"health"}\n')
buf=b''
while b'\n' not in buf:
    c=s.recv(4096)
    if not c: break
    buf+=c
s.close()
if buf:
    d=json.loads(buf.split(b'\n',1)[0])
    safe={k:d.get(k) for k in ('ok','phase','origin','pathname','logged_in','error') if k in d}
    print("debug_health="+json.dumps(safe,separators=(',',':')))
else:
    print("debug_health=empty")
PY
    set +e
    docker exec "$debug_name" node -e 'const net=require("net");const s=net.createConnection("/run/pcg/web.sock");s.setTimeout(2000);s.on("connect",()=>s.write("{\"op\":\"health\"}\n"));let b="";s.on("data",d=>{b+=d;if(b.includes("\n")){const x=JSON.parse(b.split("\n")[0]);process.exit(x.ok===true&&x.phase!=="BROWSER_CLOSED"?0:1)}});s.on("timeout",()=>process.exit(1));s.on("error",()=>process.exit(1));'
    health_cmd_rc=$?
    set -e
    echo "debug_docker_health_command_rc=$health_cmd_rc"
  else
    echo "debug_socket=missing"
  fi
  echo "debug_logs_begin"
  docker logs --tail 160 "$debug_name" 2>&1 |
    sed -E 's#https?://[^[:space:]]+#URL_REDACTED#g; s/[A-Za-z0-9_+\/-]{48,}/[REDACTED]/g' |
    tail -n 160
  echo "debug_logs_end"
else
  echo "debug_container=missing"
fi
cleanup_debug
trap - EXIT
echo "PCG_WEB_ISOLATED_SMOKE_END"


echo "PCG_WEB_COMPOSE_SMOKE_BEGIN"
r7=/var/lib/capability-fabric/deploy/pcg/releases/pcg-web-login-r7
debug_project=capability-fabric-pcg-web-smoke
if [[ -d "$r7" ]]; then
  existing_web="$(docker ps -a --filter name='^/capability-fabric-pcg-web$' --format '{{.ID}}' | head -n1)"
  if [[ -n "$existing_web" ]]; then
    echo "compose_smoke=skipped-existing-web-container"
  else
    (
      exec 8>/run/lock/capability-fabric-pull.lock
      flock 8
      docker compose -p "$debug_project" -f "$r7/compose.yaml" up -d --no-deps pcg_web >/dev/null
    )
    for _ in $(seq 1 40); do
      cid="$(docker ps -a --filter name='^/capability-fabric-pcg-web$' --format '{{.ID}}' | head -n1)"
      [[ -n "$cid" ]] || { sleep 1; continue; }
      health="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$cid" 2>/dev/null || true)"
      [[ "$health" == healthy || "$health" == unhealthy ]] && break
      sleep 1
    done
    cid="$(docker ps -a --filter name='^/capability-fabric-pcg-web$' --format '{{.ID}}' | head -n1)"
    if [[ -n "$cid" ]]; then
      docker inspect -f 'compose_web_running={{.State.Running}} compose_web_status={{.State.Status}} compose_web_exit={{.State.ExitCode}} compose_web_oom={{.State.OOMKilled}} compose_web_health={{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$cid"
      docker inspect -f '{{if .State.Health}}{{range .State.Health.Log}}compose_health_exit={{.ExitCode}} compose_health_output={{json .Output}}{{println}}{{end}}{{end}}' "$cid" | tail -n 12
      if [[ -S /var/lib/capability-fabric/pcg/run/web.sock ]]; then
        python3 - /var/lib/capability-fabric/pcg/run/web.sock <<'PY'
import json,socket,sys
s=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM); s.settimeout(3); s.connect(sys.argv[1])
s.sendall(b'{"op":"health"}\n')
buf=b''
while b'\n' not in buf:
    c=s.recv(4096)
    if not c: break
    buf+=c
s.close()
if buf:
    d=json.loads(buf.split(b'\n',1)[0])
    safe={k:d.get(k) for k in ('ok','phase','origin','pathname','logged_in','error') if k in d}
    print("compose_web_uds="+json.dumps(safe,separators=(',',':')))
PY
      else
        echo "compose_web_socket=missing"
      fi
      echo "compose_web_logs_begin"
      docker logs --tail 100 "$cid" 2>&1 |
        sed -E 's#https?://[^[:space:]]+#URL_REDACTED#g; s/[A-Za-z0-9_+\/-]{48,}/[REDACTED]/g' |
        tail -n 100
      echo "compose_web_logs_end"
    else
      echo "compose_web_container=missing"
    fi
    (
      exec 8>/run/lock/capability-fabric-pull.lock
      flock 8
      docker compose -p "$debug_project" -f "$r7/compose.yaml" down --remove-orphans >/dev/null 2>&1 || true
    )
  fi
else
  echo "staged_r7=missing"
fi
echo "PCG_WEB_COMPOSE_SMOKE_END"
