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
awk 'NF && $1 !~ /^#/ {print $NF}' "$authorized_keys" | head -n1 | sed 's/^/authorized_key_comment=/'
ssh-keygen -lf "$authorized_keys" -E sha256 | awk '{print "authorized_key_fingerprint="$2,"type="$4}'
echo "PCG_FORWARD_KEY_END"

echo "PCG_FORWARD_EFFECTIVE_BEGIN"
effective="$(sshd -T -C user="$user_name",host=localhost,addr=127.0.0.1)"
for key in   pubkeyauthentication authenticationmethods authorizedkeysfile strictmodes   passwordauthentication kbdinteractiveauthentication forcecommand   allowtcpforwarding permitopen permittty x11forwarding allowagentforwarding   gatewayports permituserrc allowusers denyusers allowgroups denygroups; do
  line="$(awk -v k="$key" '$1==k{$1=""; sub(/^ /,""); print; exit}' <<<"$effective")"
  printf '%s=%s\n' "$key" "${line:-<unset>}"
done
echo "PCG_FORWARD_EFFECTIVE_END"

echo "PCG_FORWARD_GATE_STATE_BEGIN"
test -x /usr/local/libexec/capability-fabric-pcg-provision-ssh-gate && echo "gate=present" || echo "gate=missing"
test -f /run/capability-fabric/pcg-provision/bootstrap-url && echo "bootstrap=present" || echo "bootstrap=missing"
test -e /var/lib/capability-fabric/pcg/run/provision-complete && echo "complete=yes" || echo "complete=no"
echo "PCG_FORWARD_GATE_STATE_END"

echo "PCG_FORWARD_SSH_LOG_BEGIN"
{
  journalctl -u ssh.service --since '30 minutes ago' --no-pager 2>/dev/null || true
  journalctl -t sshd --since '30 minutes ago' --no-pager 2>/dev/null || true
} |
  grep -F "$user_name" |
  tail -n 50 |
  sed -E 's/rhost=[^ ]+/rhost=REDACTED/g; s/from [0-9a-fA-F:.]+ port [0-9]+/from REDACTED/g; s/port [0-9]+ ssh2/port REDACTED ssh2/g' || true
echo "PCG_FORWARD_SSH_LOG_END"
