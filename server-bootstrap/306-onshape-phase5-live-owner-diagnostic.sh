#!/usr/bin/env bash
set -euo pipefail
umask 077
[[ "$(id -u)" -eq 0 ]] || exit 2
root="/var/lib/capability-fabric/onshape-session-pool-phase5-lab"
marker="$root/agent-state/phase5-live-unresolved.json"
gate="/var/lib/capability-fabric/state/release-in-progress"
lock="/run/lock/capability-fabric-pull.lock"

echo "CF_PHASE5_LIVE_OWNER_DIAG=begin"
if [[ -e "$gate" ]]; then echo "CF_PHASE5_LIVE_OWNER_GATE=present"; else echo "CF_PHASE5_LIVE_OWNER_GATE=absent"; fi
if [[ -f "$marker" ]]; then
  python3 - "$marker" <<'PY'
import json,sys
m=json.load(open(sys.argv[1]))
print("CF_PHASE5_LIVE_OWNER_MARKER_ATTEMPT="+str(m.get("attemptId")))
print("CF_PHASE5_LIVE_OWNER_MARKER_PHASE="+str(m.get("phase")))
PY
else
  echo "CF_PHASE5_LIVE_OWNER_MARKER=absent"
fi
echo "CF_PHASE5_LIVE_OWNER_FLOCK_HOLDERS_BEGIN"
(fuser -v "$lock" 2>&1 || true) | sed -n '1,20p'
echo "CF_PHASE5_LIVE_OWNER_FLOCK_HOLDERS_END"
echo "CF_PHASE5_LIVE_OWNER_PROCESSES_BEGIN"
ps -eo pid,ppid,stat,etime,args | grep -E '300-onshape-session-pool-phase5-live|remote-bundle-exec|ssh .*cf-exec|onshape-session-pool-phase5' | grep -v grep | sed -n '1,40p' || true
echo "CF_PHASE5_LIVE_OWNER_PROCESSES_END"
for c in capability-fabric-onshape-server capability-fabric-onshape-fabric capability-fabric-onshape-gateway capability-fabric-onshape-phase5-lab-server capability-fabric-onshape-phase5-lab-fabric; do
  s="$(docker inspect -f '{{.State.Status}}|{{.State.Running}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$c" 2>/dev/null || echo missing)"
  echo "CF_PHASE5_LIVE_OWNER_CONTAINER_${c}=${s}"
done
echo "CF_PHASE5_LIVE_OWNER_DIAG=pass"
