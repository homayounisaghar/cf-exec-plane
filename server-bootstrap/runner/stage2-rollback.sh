#!/usr/bin/env bash
set -euo pipefail
umask 077
: "${VPS_SSH_KEY:?VPS_SSH_KEY is required}"
: "${VPS_HOST:?VPS_HOST is required}"
: "${VPS_SSH_USER:?VPS_SSH_USER is required}"
: "${VPS_HOST_KEY:?VPS_HOST_KEY is required}"
port="${VPS_PORT:-22}"
tmp="$(mktemp -d "${RUNNER_TEMP:-/tmp}/cf-stage2-rollbackctl.XXXXXX")"
trap 'rm -rf "$tmp"' EXIT
key="$tmp/key"
kh="$tmp/kh"
printf '%s\n' "$VPS_SSH_KEY" > "$key"
chmod 0600 "$key"
read -r hkt hkd hkx <<< "${VPS_HOST_KEY//$'\r'/}"
[[ "$hkt" == ssh-ed25519 && -n "$hkd" && -z "${hkx:-}" ]] || exit 2
printf '%s %s %s\n' "$VPS_HOST" "$hkt" "$hkd" > "$kh"
printf '[%s]:%s %s %s\n' "$VPS_HOST" "$port" "$hkt" "$hkd" >> "$kh"
chmod 0600 "$kh"
ssh -i "$key" -p "$port" -o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile="$kh" -o ConnectTimeout=15 "$VPS_SSH_USER@$VPS_HOST" 'set -euo pipefail
  active=/root/.cf-stage2-rollback-active
  watchdog=cf-stage2-rollback-watchdog
  [[ -x "$active/rollback.sh" ]] || { echo "CF_STAGE2_ROLLBACK_STATE_MISSING" >&2; exit 40; }
  systemctl stop "$watchdog.timer" >/dev/null 2>&1 || true
  "$active/rollback.sh"
  rm -rf "$active"
  systemctl reset-failed "$watchdog.timer" "$watchdog.service" >/dev/null 2>&1 || true
  echo "CF_STAGE2_ROLLBACK=performed"'
