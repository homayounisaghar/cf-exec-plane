#!/usr/bin/env bash
set -euo pipefail
umask 077
echo CF_PHASE5_RESCUE_DIAG=begin
root="/var/lib/capability-fabric/onshape-session-pool-phase5-lab"
marker="$root/agent-state/phase5-live-unresolved.json"
gate="/var/lib/capability-fabric/state/release-in-progress"
lock="/run/lock/capability-fabric-pull.lock"
if [[ -e "$gate" ]]; then echo CF_PHASE5_RESCUE_GATE=present; else echo CF_PHASE5_RESCUE_GATE=absent; fi
if [[ -s "$marker" ]]; then
  python3 - "$marker" <<'PY'
import json,sys
m=json.load(open(sys.argv[1]))
print("CF_PHASE5_RESCUE_MARKER_ATTEMPT="+str(m.get("attemptId")))
print("CF_PHASE5_RESCUE_MARKER_PHASE="+str(m.get("phase")))
PY
else
  echo CF_PHASE5_RESCUE_MARKER=absent
fi
echo CF_PHASE5_RESCUE_LOCK_BEGIN
(fuser -v "$lock" 2>&1 || true) | sed -n '1,20p'
echo CF_PHASE5_RESCUE_LOCK_END
echo CF_PHASE5_RESCUE_UNITS_BEGIN
systemctl list-units --all 'cf-bootstrap-*' --no-pager --no-legend 2>/dev/null | sed -n '1,30p' || true
echo CF_PHASE5_RESCUE_UNITS_END
echo CF_PHASE5_RESCUE_JOBS_BEGIN
for d in /root/.cf-bootstrap-jobs/*; do
  [[ -d "$d" ]] || continue
  printf 'JOB=%s STATUS=' "$(basename "$d")"
  if [[ -s "$d/status" ]]; then tr -d '\r\n' < "$d/status"; else printf 'pending'; fi
  printf '\n'
  if [[ -s "$d/output.log" ]]; then tail -n 20 "$d/output.log"; fi
done
echo CF_PHASE5_RESCUE_JOBS_END
echo CF_PHASE5_RESCUE_DIAG=pass
