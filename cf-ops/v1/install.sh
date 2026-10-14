#!/usr/bin/env bash
# CF-ops host agent installer. Run as root from the bundle directory.
# Never touches WeChat services, paa_remote, or the CF containers.
set -euo pipefail
[[ "$(id -u)" -eq 0 ]] || { echo "FAIL root_required"; exit 30; }
here="$(cd "$(dirname "$0")" && pwd)"
user=cfop_e79aa1fde5
lib=/usr/local/lib/capability-fabric/cf-ops
state=/var/lib/capability-fabric/cf-ops
run=/var/lib/capability-fabric/cf-ops-run
unit=/etc/systemd/system/capability-fabric-cf-ops.service
envf=/etc/capability-fabric/cf-ops.env
wx=(capability-fabric-pcg-wechat.service capability-fabric-pcg-wechat-semantic.service)

id "$user" >/dev/null 2>&1 || { echo "FAIL user_missing"; exit 31; }
echo "PASS user=$user uid=$(id -u "$user")"
declare -A before
for s in "${wx[@]}"; do before[$s]="$(systemctl show "$s" -p MainPID --value 2>/dev/null || echo none)"; done
echo "INFO wechat_pids ${before[*]}"

python3 -m py_compile "$here/cf_ops_agent.py" "$here/github_api.py"
echo "PASS py_compile python=$(python3 -V 2>&1)"

had_unit=no; [[ -f "$unit" ]] && had_unit=yes
rollback() {
  echo "FAIL install_error_rolling_back"
  if [[ "$had_unit" == no ]]; then
    systemctl disable --now capability-fabric-cf-ops.service >/dev/null 2>&1 || true
    rm -f "$unit"; systemctl daemon-reload || true
    echo "INFO rollback=unit_removed"
  fi
}
trap rollback ERR

install -d -m 0755 -o root -g root "$lib"
install -m 0644 -o root -g root "$here/cf_ops_agent.py" "$lib/cf_ops_agent.py"
install -m 0644 -o root -g root "$here/github_api.py" "$lib/github_api.py"
install -d -m 0700 -o "$user" -g "$user" "$state"
install -d -m 0755 -o "$user" -g "$user" "$run"
runuser -u "$user" -- test -w "$state" && runuser -u "$user" -- test -w "$run" && runuser -u "$user" -- test -r "$lib/cf_ops_agent.py"
echo "PASS files_installed"

# Desktop session environment (read-only copy from the WeChat unit, display/audio only).
{
  systemctl show capability-fabric-pcg-wechat.service -p Environment --value 2>/dev/null | tr ' ' '\n' \
    | grep -E '^(DISPLAY|XAUTHORITY|XDG_RUNTIME_DIR|PULSE_SERVER|PULSE_RUNTIME_PATH|DBUS_SESSION_BUS_ADDRESS|LANG|LC_ALL)=' || true
} > "$envf.tmp"
grep -q '^XDG_RUNTIME_DIR=' "$envf.tmp" || echo "XDG_RUNTIME_DIR=/run/user/$(id -u "$user")" >> "$envf.tmp"
install -m 0644 -o root -g root "$envf.tmp" "$envf"; rm -f "$envf.tmp"
echo "PASS env_keys=$(cut -d= -f1 "$envf" | tr '\n' ',')"

cat > "$unit.tmp" <<UNIT
[Unit]
Description=Capability Fabric owner host-ops agent (cf-ops)
After=network-online.target

[Service]
Type=simple
User=$user
Group=$user
EnvironmentFile=-$envf
Environment=CF_OPS_STATE=$state
Environment=CF_OPS_SOCKET=$run/agent.sock
Environment=CF_OPS_ALLOWED_UIDS=0
Environment=PYTHONUNBUFFERED=1
WorkingDirectory=$state
ExecStart=$(command -v python3) $lib/cf_ops_agent.py
Restart=always
RestartSec=3
KillMode=process
NoNewPrivileges=yes
MemoryMax=2G
TasksMax=512
UMask=0077

[Install]
WantedBy=multi-user.target
UNIT
install -m 0644 -o root -g root "$unit.tmp" "$unit"; rm -f "$unit.tmp"
systemctl daemon-reload
systemctl enable capability-fabric-cf-ops.service >/dev/null
systemctl restart capability-fabric-cf-ops.service
echo "PASS unit_started"

for _ in $(seq 1 20); do [[ -S "$run/agent.sock" ]] && break; sleep 1; done
[[ -S "$run/agent.sock" ]]
python3 - "$run/agent.sock" <<'PY'
import json,socket,sys
s=socket.socket(socket.AF_UNIX); s.settimeout(15); s.connect(sys.argv[1])
s.sendall(b'{"op":"server_status","args":{}}\n')
r=json.loads(s.makefile().readline())
assert r.get("ok") is True, r
x=r["result"]; print("PASS agent_status user=%s uid=%s version=%s free_gb=%.1f" % (x["user"],x["uid"],x["version"],x["disk_root"]["free"]/1e9))
s=socket.socket(socket.AF_UNIX); s.settimeout(30); s.connect(sys.argv[1])
s.sendall(b'{"op":"server_exec","args":{"command":"id -un; echo $DISPLAY; ls /tmp/wxeng 2>/dev/null | head -3","timeout_s":20}}\n')
r=json.loads(s.makefile().readline()); assert r.get("ok") is True, r
print("PASS agent_exec exit=%s out=%s" % (r["result"]["exit_code"], r["result"]["stdout"].replace("\n"," | ")[:200]))
PY
trap - ERR
for s in "${wx[@]}"; do
  now="$(systemctl show "$s" -p MainPID --value 2>/dev/null || echo none)"
  [[ "$now" == "${before[$s]}" ]] && echo "PASS wechat_untouched $s pid=$now" || echo "WARN wechat_pid_changed $s ${before[$s]}->$now"
done
echo "CF_OPS_INSTALL=success"
