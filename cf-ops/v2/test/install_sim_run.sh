set -u
F=/tmp/fr/root; L=$F/usr/local/lib/capability-fabric/cf-ops
reset_v1() {
  for p in $(ps -eo pid,args | awk '$2=="python3" && $3 ~ /fr\/root.*cf_ops_agent.py$/ {print $1}'); do kill "$p"; done; sleep 0.3
  rm -rf $F /tmp/fr/visudo_fail /tmp/fr/agent_fail /tmp/fr/calls.log; mkdir -p $L $F/etc/systemd/system $F/etc/capability-fabric $F/var/lib/capability-fabric/cf-ops-run $F/var/lib/capability-fabric/cf-ops
  cp /data/cfops_r251/v1/cf_ops_agent.py /data/cfops_r251/v1/github_api.py $L/
  echo "[Service] # v1 unit NoNewPrivileges=yes" > $F/etc/systemd/system/capability-fabric-cf-ops.service
  echo "DISPLAY=:1" > $F/etc/capability-fabric/cf-ops.env
  (CF_OPS_STATE=$F/var/lib/capability-fabric/cf-ops CF_OPS_SOCKET=$F/var/lib/capability-fabric/cf-ops-run/agent.sock CF_OPS_ALLOWED_UIDS=$(id -u) setsid python3 $L/cf_ops_agent.py >> /tmp/fr/agent.log 2>&1 &); sleep 0.8
}
bundle() { rm -rf /tmp/fr/bundle; mkdir -p /tmp/fr/bundle; cp /data/cfops_r251/v2fix/github_api.py /data/cfops_r251/v2fix/status.sh /tmp/fr/bundle/; cp /tmp/fr/install_test.sh /tmp/fr/bundle/install.sh
  if [[ "$1" == patched ]]; then sed 's#\["sudo", "-n", "/usr/local/sbin/cf-admin-exec"\]#["python3", "/tmp/fr/root/usr/local/sbin/cf-admin-exec"]#' /data/cfops_r251/v2fix/cf_ops_agent.py > /tmp/fr/bundle/cf_ops_agent.py; else cp /data/cfops_r251/v2fix/cf_ops_agent.py /tmp/fr/bundle/; fi; }
ver() { python3 -c "
import json,socket,sys
s=socket.socket(socket.AF_UNIX); s.settimeout(5); s.connect('$F/var/lib/capability-fabric/cf-ops-run/agent.sock')
s.sendall(b'{\"op\":\"server_status\",\"args\":{}}\n'); print(json.loads(s.makefile().readline())['result']['version'])" 2>/dev/null || echo no-agent; }
state() { echo "  lib_agent=$(cmp -s $L/cf_ops_agent.py /data/cfops_r251/v1/cf_ops_agent.py && echo v1 || echo v2) unit=$(grep -q 'v1 unit' $F/etc/systemd/system/capability-fabric-cf-ops.service && echo v1 || echo v2) wrapper=$([[ -e $F/usr/local/sbin/cf-admin-exec ]] && echo yes || echo no) sudoers=$([[ -e $F/etc/sudoers.d/cf-admin ]] && echo yes || echo no) running=$(ver)"; }
mkdir -p $F/usr/local/sbin $F/etc/sudoers.d 2>/dev/null
echo "== A: upgrade v1 -> v2 (success expected)"; reset_v1; mkdir -p $F/usr/local/sbin $F/etc/sudoers.d; bundle patched; bash /tmp/fr/bundle/install.sh > /tmp/fr/A.out 2>&1; echo "  rc=$? $(grep -E 'CF_OPS_INSTALL|FAIL|INFO' /tmp/fr/A.out | tr '\n' ' ')"; state
echo "== D: re-run v2 -> v2 (idempotent)"; bundle patched; bash /tmp/fr/bundle/install.sh > /tmp/fr/D.out 2>&1; echo "  rc=$? $(grep -E 'CF_OPS_INSTALL|FAIL' /tmp/fr/D.out | tr '\n' ' ')"; state
echo "== B: upgrade v1 -> v2, final check fails (rollback expected)"; reset_v1; mkdir -p $F/usr/local/sbin $F/etc/sudoers.d; bundle unpatched; bash /tmp/fr/bundle/install.sh > /tmp/fr/B.out 2>&1; rcb=$?; sleep 2; echo rcb=$rcb; echo "  rc=$? $(grep -E 'CF_OPS_INSTALL|FAIL|INFO|Error' /tmp/fr/B.out | tr '\n' ' ' | cut -c1-300)"; state
echo "== C: upgrade v1 -> v2, sudoers check fails (rollback expected)"; reset_v1; mkdir -p $F/usr/local/sbin $F/etc/sudoers.d; touch /tmp/fr/visudo_fail; bundle patched; bash /tmp/fr/bundle/install.sh > /tmp/fr/C.out 2>&1; echo "  rc=$? $(grep -E 'CF_OPS_INSTALL|FAIL|INFO' /tmp/fr/C.out | tr '\n' ' ')"; state
echo "== E: v2 agent never starts (rollback expected)"; reset_v1; mkdir -p $F/usr/local/sbin $F/etc/sudoers.d; touch /tmp/fr/agent_fail; bundle patched; bash /tmp/fr/bundle/install.sh > /tmp/fr/E.out 2>&1; rc=$?; rm -f /tmp/fr/agent_fail; echo "  rc=$rc $(grep -E 'CF_OPS_INSTALL|FAIL|INFO' /tmp/fr/E.out | tr '\n' ' ')"; state
for p in $(ps -eo pid,args | awk '$2=="python3" && $3 ~ /fr\/root.*cf_ops_agent.py$/ {print $1}'); do kill "$p"; done
