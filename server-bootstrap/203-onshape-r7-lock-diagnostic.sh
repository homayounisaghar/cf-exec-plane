#!/usr/bin/env bash
set -euo pipefail
CONTROL=/var/lib/capability-fabric/onshape/runtime-control/ONSHAPE_RUNTIME_CONTROL.json
MIRROR_BLOB=/var/lib/capability-fabric/onshape/runtime-control/git-blob-sha
LOCK=/run/lock/capability-fabric-pull.lock
SERVICE=capability-fabric-pull.service
TIMER=capability-fabric-pull.timer
GATE=/var/lib/capability-fabric/state/release-in-progress
ACTIVE=/opt/capability-fabric/current
GATEWAY=capability-fabric-onshape-gateway
echo "CF_R7_LOCK_DIAG_CONTROL=$(git hash-object "$CONTROL")"
echo "CF_R7_LOCK_DIAG_MIRROR=$(tr -d '\r\n' < "$MIRROR_BLOB")"
echo "CF_R7_LOCK_DIAG_ACTIVE=$(basename "$(readlink -f "$ACTIVE")")"
echo "CF_R7_LOCK_DIAG_SERVICE=$(systemctl is-active "$SERVICE" 2>/dev/null || true)"
echo "CF_R7_LOCK_DIAG_TIMER=$(systemctl is-active "$TIMER" 2>/dev/null || true)"
echo "CF_R7_LOCK_DIAG_GATE=$([[ -f "$GATE" ]] && echo active || echo clear)"
echo "CF_R7_LOCK_DIAG_GATEWAY=$(docker inspect -f '{{.State.Running}}' "$GATEWAY")"
exec 9>"$LOCK"
if flock -n 9; then
  echo CF_R7_LOCK_DIAG_LOCK=FREE
else
  echo CF_R7_LOCK_DIAG_LOCK=HELD
fi
