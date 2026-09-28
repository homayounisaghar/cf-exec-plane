#!/usr/bin/env bash
set -euo pipefail
umask 077
[[ "$(id -u)" -eq 0 ]] || exit 2
echo CF_RESILIENT_DIAG_BEGIN
systemctl --no-pager --plain list-units 'cf-bootstrap-*' --all 2>/dev/null | sed -n '1,40p' || true
for d in /root/.cf-bootstrap-jobs/*; do
  [[ -d "$d" ]] || continue
  echo "CF_RESILIENT_DIAG_JOB=$(basename "$d")"
  if [[ -s "$d/status" ]]; then
    printf 'CF_RESILIENT_DIAG_STATUS='
    cat "$d/status"
  else
    echo CF_RESILIENT_DIAG_STATUS=running-or-unresolved
  fi
  if [[ -s "$d/output.log" ]]; then
    echo CF_RESILIENT_DIAG_LOG_TAIL_BEGIN
    tail -n 80 "$d/output.log"
    echo CF_RESILIENT_DIAG_LOG_TAIL_END
  fi
done
echo CF_RESILIENT_DIAG=pass
