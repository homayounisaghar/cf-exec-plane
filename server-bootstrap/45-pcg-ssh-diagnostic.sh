#!/usr/bin/env bash
set -euo pipefail

echo "PCG_FORWARD_PASSWD_STATE_BEGIN"
getent passwd pcg-forward | awk -F: '{print "user="$1,"shell="$7,"home="$6}'
passwd -S pcg-forward | awk '{print "password_status="$2}'
echo "PCG_FORWARD_PASSWD_STATE_END"

echo "PCG_FORWARD_GATE_STATE_BEGIN"
test -s /etc/capability-fabric/pcg-forward/authorized_keys && echo "authorized_keys=present" || echo "authorized_keys=missing"
test -x /usr/local/libexec/capability-fabric-pcg-provision-ssh-gate && echo "gate=present" || echo "gate=missing"
test -f /run/capability-fabric/pcg-provision/bootstrap-url && echo "bootstrap=present" || echo "bootstrap=missing"
test -e /var/lib/capability-fabric/pcg/run/provision-complete && echo "complete=yes" || echo "complete=no"
echo "PCG_FORWARD_GATE_STATE_END"

echo "PCG_FORWARD_SSH_LOG_BEGIN"
journalctl -u ssh.service --since '20 minutes ago' --no-pager 2>/dev/null |
  grep -F 'pcg-forward' |
  tail -n 30 |
  sed -E 's/rhost=[^ ]+/rhost=REDACTED/g; s/from [0-9a-fA-F:.]+ port [0-9]+/from REDACTED/g; s/port [0-9]+ ssh2/port REDACTED ssh2/g'
echo "PCG_FORWARD_SSH_LOG_END"
