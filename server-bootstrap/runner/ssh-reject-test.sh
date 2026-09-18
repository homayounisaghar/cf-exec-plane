#!/usr/bin/env bash
set -euo pipefail
umask 077

: "${VPS_SSH_KEY:?VPS_SSH_KEY is required}"
: "${VPS_HOST:?VPS_HOST is required}"
: "${VPS_TEST_USER:?VPS_TEST_USER is required}"
: "${VPS_HOST_KEY:?VPS_HOST_KEY is required}"
port="${VPS_PORT:-22}"
case "$port" in ''|*[!0-9]*) echo "VPS_PORT must be numeric" >&2; exit 2 ;; esac
case "$VPS_TEST_USER" in ''|*[!a-zA-Z0-9_-]*) echo "VPS_TEST_USER invalid" >&2; exit 2 ;; esac

tmp="$(mktemp -d "${RUNNER_TEMP:-/tmp}/cf-old-reject.XXXXXX")"
trap 'rm -rf "$tmp"' EXIT
key="$tmp/key"
kh="$tmp/known_hosts"
err="$tmp/ssh.err"
printf '%s\n' "$VPS_SSH_KEY" > "$key"
chmod 0600 "$key"
host_key_line="${VPS_HOST_KEY//$'\r'/}"
read -r hkt hkd hkx <<< "$host_key_line"
[[ "$hkt" == ssh-ed25519 && -n "$hkd" && -z "${hkx:-}" ]] || exit 3
printf '%s %s %s\n' "$VPS_HOST" "$hkt" "$hkd" > "$kh"
printf '[%s]:%s %s %s\n' "$VPS_HOST" "$port" "$hkt" "$hkd" >> "$kh"
chmod 0600 "$kh"

set +e
ssh \
  -i "$key" \
  -p "$port" \
  -o BatchMode=yes \
  -o IdentitiesOnly=yes \
  -o PreferredAuthentications=publickey \
  -o PasswordAuthentication=no \
  -o KbdInteractiveAuthentication=no \
  -o StrictHostKeyChecking=yes \
  -o UserKnownHostsFile="$kh" \
  -o ConnectTimeout=15 \
  -o ConnectionAttempts=1 \
  "${VPS_TEST_USER}@${VPS_HOST}" 'true' >/dev/null 2>"$err"
rc=$?
set -e
[[ "$rc" -ne 0 ]] || { echo "CF_STAGE2_OLD_SSH_KEY_REJECTED=fail-still-accepted" >&2; exit 30; }
if grep -Fq 'Permission denied (publickey)' "$err"; then
  echo "CF_STAGE2_OLD_SSH_KEY_REJECTED=pass"
  exit 0
fi
echo "CF_STAGE2_OLD_SSH_KEY_REJECTED=unproven-unexpected-ssh-failure" >&2
exit 31
