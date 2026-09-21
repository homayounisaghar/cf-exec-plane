#!/usr/bin/env bash
set -euo pipefail

user_name=pcg-forward
bootstrap=/run/capability-fabric/pcg-provision/bootstrap-url
token=/run/capability-fabric/pcg-provision/token
complete=/var/lib/capability-fabric/pcg/run/provision-complete
timer=capability-fabric-pcg-provision-cleanup.timer
service=capability-fabric-pcg-provision-cleanup.service

echo "PCG_GATE_DIAG_ROOT_BEGIN"
date -u '+utc=%Y-%m-%dT%H:%M:%SZ'
for p in /run /run/capability-fabric /run/capability-fabric/pcg-provision /var/lib/capability-fabric /var/lib/capability-fabric/pcg /var/lib/capability-fabric/pcg/run; do
  if [[ -e "$p" ]]; then stat -c "path=$p type=%F mode=%a owner=%U group=%G" "$p"; else echo "path=$p missing=yes"; fi
done
for p in "$bootstrap" "$token" "$complete"; do
  if [[ -e "$p" ]]; then stat -c "path=$p type=%F mode=%a owner=%U group=%G size=%s mtime=%y" "$p"; else echo "path=$p missing=yes"; fi
done
systemctl show "$timer" -p ActiveState -p SubState -p NextElapseUSecRealtime -p LastTriggerUSec --no-pager || true
systemctl show "$service" -p ActiveState -p SubState -p ExecMainStatus -p ExecMainStartTimestamp -p ExecMainExitTimestamp --no-pager || true
echo "PCG_GATE_DIAG_ROOT_END"

echo "PCG_GATE_DIAG_AS_USER_BEGIN"
runuser -u "$user_name" -- bash -c '
  bootstrap=/run/capability-fabric/pcg-provision/bootstrap-url
  complete=/var/lib/capability-fabric/pcg/run/provision-complete
  if [[ -e "$complete" ]]; then echo complete_visible=yes; else echo complete_visible=no; fi
  if [[ -f "$bootstrap" ]]; then echo bootstrap_file=yes; else echo bootstrap_file=no; fi
  if [[ -r "$bootstrap" ]]; then echo bootstrap_readable=yes; else echo bootstrap_readable=no; fi
  if [[ -L "$bootstrap" ]]; then echo bootstrap_symlink=yes; else echo bootstrap_symlink=no; fi
  for p in /run/capability-fabric /run/capability-fabric/pcg-provision /var/lib/capability-fabric/pcg/run; do
    if cd "$p" 2>/dev/null; then echo "traverse:$p=yes"; else echo "traverse:$p=no"; fi
  done
'
echo "PCG_GATE_DIAG_AS_USER_END"

echo "PCG_GATE_SCRIPT_BEGIN"
sed -n '1,120p' /usr/local/libexec/capability-fabric-pcg-provision-ssh-gate
echo "PCG_GATE_SCRIPT_END"
