#!/usr/bin/env bash
set -euo pipefail
ACTIVE=/opt/capability-fabric/current
STATE=/var/lib/capability-fabric/state
CONTROL=/var/lib/capability-fabric/onshape/runtime-control/ONSHAPE_RUNTIME_CONTROL.json
MIRROR_BLOB=/var/lib/capability-fabric/onshape/runtime-control/git-blob-sha
GATE="$STATE/release-in-progress"
TIMER=capability-fabric-pull.timer
GATEWAY=capability-fabric-onshape-gateway
SERVER=capability-fabric-onshape-server

echo "CF_E9_ENV_ACTIVE=$(basename "$(readlink -f "$ACTIVE")")"
echo "CF_E9_ENV_LAST_GOOD_SEQUENCE=$(cat "$STATE/last-good-sequence" 2>/dev/null || true)"
echo "CF_E9_ENV_LAST_GOOD_RELEASE=$(cat "$STATE/last-good-release" 2>/dev/null || true)"
echo "CF_E9_ENV_CONTROL_BLOB=$(git hash-object "$CONTROL" 2>/dev/null || true)"
echo "CF_E9_ENV_MIRROR_BLOB=$(tr -d '\r\n' < "$MIRROR_BLOB" 2>/dev/null || true)"
if [[ -e "$GATE" ]]; then echo CF_E9_ENV_GATE=present; else echo CF_E9_ENV_GATE=absent; fi
if systemctl is-active --quiet "$TIMER"; then echo CF_E9_ENV_TIMER=active; else echo CF_E9_ENV_TIMER=inactive; fi
echo "CF_E9_ENV_GATEWAY=$(docker inspect -f '{{.State.Running}}' "$GATEWAY" 2>/dev/null || true)"
echo "CF_E9_ENV_SERVER=$(docker inspect -f '{{.State.Running}}' "$SERVER" 2>/dev/null || true)"
python3 - "$CONTROL" <<'PY'
import json,sys
x=json.load(open(sys.argv[1])); a=x["authority"]; g=a["productionGuard"]
print("CF_E9_ENV_REV="+str(x["controlRevision"]))
print("CF_E9_ENV_EPOCH="+str(a["productionEpoch"]))
print("CF_E9_ENV_MODE="+str(a["mode"]))
print("CF_E9_ENV_GUARD="+json.dumps(g,separators=(',',':'),sort_keys=True))
print("CF_E9_ENV_LEASE="+str(x["lease"]["state"]))
PY
echo CF_E9_ENV=pass
