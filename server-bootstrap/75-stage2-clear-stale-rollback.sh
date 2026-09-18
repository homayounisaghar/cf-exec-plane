#!/usr/bin/env bash
set -euo pipefail
umask 077
[[ "$(id -u)" -eq 0 ]] || exit 1
active=/root/.cf-stage2-rollback-active
watchdog=cf-stage2-rollback-watchdog
[[ -d "$active" && -x "$active/rollback.sh" ]] || { echo "CF_STAGE2_STALE_ROLLBACK_STATE_NOT_FOUND" >&2; exit 2; }
[[ -s /etc/capability-fabric/trust/deploy-signing.pub && -s /etc/capability-fabric/trust/deploy-signing-next.pub ]] || {
  echo "CF_STAGE2_REFUSE_STALE_STATE_CLEANUP_WITHOUT_OVERLAP_TRUST" >&2
  exit 3
}
systemctl stop "$watchdog.timer" >/dev/null 2>&1 || true
systemctl stop "$watchdog.service" >/dev/null 2>&1 || true
rm -rf "$active"
systemctl reset-failed "$watchdog.timer" "$watchdog.service" >/dev/null 2>&1 || true
printf 'CF_STAGE2_STALE_ROLLBACK_STATE_CLEARED=pass\n'
