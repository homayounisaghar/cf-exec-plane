#!/usr/bin/env bash
set -euo pipefail
umask 077
[[ "$(id -u)" -eq 0 ]] || exit 2

ACTIVE=/opt/capability-fabric/current
STATE=/var/lib/capability-fabric/state
CONTROL=/var/lib/capability-fabric/onshape/runtime-control/ONSHAPE_RUNTIME_CONTROL.json
MIRROR_BLOB=/var/lib/capability-fabric/onshape/runtime-control/git-blob-sha
GATE="$STATE/release-in-progress"
TIMER=capability-fabric-pull.timer
SERVICE=capability-fabric-pull.service
PULL=/usr/local/libexec/capability-fabric-pull-agent
GATEWAY=capability-fabric-onshape-gateway

PREV=79ea04caa91462d85021ae46392b636b217a6cc8
TARGET=d803ce77c7aa9aed513e26609aa268e96df61454
DID=8ca702971e2419cfa45cc87c

[[ -x "$PULL" ]]
[[ -f "$GATE" ]] && grep -Fxq RELEASE_IN_PROGRESS "$GATE"
if systemctl is-active --quiet "$TIMER"; then exit 20; fi
if systemctl is-active --quiet "$SERVICE"; then exit 20; fi
[[ "$(docker inspect -f '{{.State.Running}}' "$GATEWAY")" == false ]]
[[ "$(git hash-object "$CONTROL")" == "$PREV" ]]
[[ "$(tr -d '\r\n' < "$MIRROR_BLOB")" == "$PREV" ]]
[[ "$(basename "$(readlink -f "$ACTIVE")")" == "onshape-vps-hardened-production-r5" ]]

out="$("$PULL" pull)"
printf '%s\n' "$out"
printf '%s\n' "$out" | grep -Fxq 'CF_RUNTIME_CONTROL_MIRROR=updated'
printf '%s\n' "$out" | grep -Fxq 'CF_PULL_NO_CHANGE'

[[ "$(git hash-object "$CONTROL")" == "$TARGET" ]]
[[ "$(tr -d '\r\n' < "$MIRROR_BLOB")" == "$TARGET" ]]
[[ "$(basename "$(readlink -f "$ACTIVE")")" == "onshape-vps-hardened-production-r5" ]]
[[ -f "$GATE" ]] && grep -Fxq RELEASE_IN_PROGRESS "$GATE"
if systemctl is-active --quiet "$TIMER"; then exit 30; fi
[[ "$(docker inspect -f '{{.State.Running}}' "$GATEWAY")" == false ]]

python3 - "$CONTROL" "$DID" <<'PY'
import json,sys
x=json.load(open(sys.argv[1])); did=sys.argv[2]; a=x["authority"]; g=a["productionGuard"]; v=a["planes"]["vps-fabric"]
assert x["controlRevision"]==543 and a["productionEpoch"]==14
assert a["mode"]=="VPS_PRODUCTION" and a["materialAuthority"]=="vps-fabric"
assert v["releaseSequence"]==70 and v["releaseId"]=="onshape-vps-hardened-production-r5"
assert a["reconciliationHold"]["active"] is False
assert x["lease"]["state"]=="FREE"
assert g["generation"]==4 and g["killSwitch"]=="OPEN"
assert g["allowedDocumentIds"]==[did]
assert g["mutationBudget"]=={"budgetId":"e9-selector-durability-slice-a-20260925","maxMutations":4}
print("CF_E9_OPEN_AUTHORITY=epoch14-seq70-r5")
print("CF_E9_OPEN_GUARD=semantic-lab-only")
print("CF_E9_OPEN_BUDGET=4")
print("CF_E9_OPEN_GATEWAY=stopped")
PY
echo CF_E9_OPEN_SYNC=pass
