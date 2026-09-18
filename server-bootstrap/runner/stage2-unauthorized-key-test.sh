#!/usr/bin/env bash
set -euo pipefail
umask 077

: "${VPS_HOST:?VPS_HOST is required}"
: "${VPS_SSH_USER:?VPS_SSH_USER is required}"
: "${CF_ADMIN_USER:?CF_ADMIN_USER is required}"
: "${VPS_HOST_KEY:?VPS_HOST_KEY is required}"
port="${VPS_PORT:-22}"
tmp="$(mktemp -d "${RUNNER_TEMP:-/tmp}/cf-stage2-unauthorized.XXXXXX")"
trap 'rm -rf "$tmp"' EXIT
key="$tmp/never-authorized"
kh="$tmp/known_hosts"
ssh-keygen -q -t ed25519 -N '' -f "$key"
chmod 0600 "$key"
host_key_line="${VPS_HOST_KEY//$'\r'/}"
read -r hkt hkd hkx <<< "$host_key_line"
[[ "$hkt" == ssh-ed25519 && -n "$hkd" && -z "${hkx:-}" ]] || exit 2
printf '%s %s %s\n' "$VPS_HOST" "$hkt" "$hkd" > "$kh"
printf '[%s]:%s %s %s\n' "$VPS_HOST" "$port" "$hkt" "$hkd" >> "$kh"
chmod 0600 "$kh"

test_user() {
  local user="$1"
  local label="$2"
  local err="$tmp/$label.err"
  local rc
  set +e
  ssh -i "$key" -p "$port" -o BatchMode=yes -o IdentitiesOnly=yes \
    -o PreferredAuthentications=publickey -o PasswordAuthentication=no -o KbdInteractiveAuthentication=no \
    -o StrictHostKeyChecking=yes -o UserKnownHostsFile="$kh" -o ConnectTimeout=15 -o ConnectionAttempts=1 \
    "$user@$VPS_HOST" 'true' >/dev/null 2>"$err"
  rc=$?
  set -e
  [[ "$rc" -ne 0 ]] || { echo "CF_STAGE2_UNAUTHORIZED_${label}=fail-accepted" >&2; exit 30; }
  grep -Fq 'Permission denied (publickey)' "$err" || { echo "CF_STAGE2_UNAUTHORIZED_${label}=unproven" >&2; exit 31; }
  echo "CF_STAGE2_UNAUTHORIZED_${label}=rejected"
}
test_user "$VPS_SSH_USER" PRIVILEGED
test_user "$CF_ADMIN_USER" ADMIN
