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
EXPECTED_PREV=d803ce77c7aa9aed513e26609aa268e96df61454
EXPECTED_TARGET=be24a7a3beb329aad2f04ad8fa96247afc282a55

[[ "$(basename "$(readlink -f "$ACTIVE")")" == "onshape-vps-hardened-production-r5" ]] || exit 20
[[ "$(git hash-object "$CONTROL")" == "$EXPECTED_PREV" ]] || exit 20
[[ "$(tr -d '\r\n' < "$MIRROR_BLOB")" == "$EXPECTED_PREV" ]] || exit 20
[[ -f "$GATE" ]] && grep -Fxq RELEASE_IN_PROGRESS "$GATE"
if systemctl is-active --quiet "$TIMER"; then exit 20; fi
if systemctl is-active --quiet "$SERVICE"; then exit 20; fi
[[ "$(docker inspect -f '{{.State.Running}}' "$GATEWAY")" == false ]] || exit 20

out="$("$PULL" pull)"
printf '%s\n' "$out"
printf '%s\n' "$out" | grep -Fxq 'CF_RUNTIME_CONTROL_MIRROR=updated'
printf '%s\n' "$out" | grep -Fxq 'CF_PULL_NO_CHANGE'

[[ "$(git hash-object "$CONTROL")" == "$EXPECTED_TARGET" ]]
[[ "$(tr -d '\r\n' < "$MIRROR_BLOB")" == "$EXPECTED_TARGET" ]]
[[ -f "$GATE" ]] && grep -Fxq RELEASE_IN_PROGRESS "$GATE"
if systemctl is-active --quiet "$TIMER"; then exit 30; fi
[[ "$(docker inspect -f '{{.State.Running}}' "$GATEWAY")" == false ]]

python3 - "$CONTROL" <<'PY'
import json,sys
x=json.load(open(sys.argv[1])); a=x["authority"]; g=a["productionGuard"]
assert x["controlRevision"]==544 and a["productionEpoch"]==15
assert a["mode"]=="VPS_PRODUCTION" and a["materialAuthority"]=="vps-fabric"
assert g["generation"]==5 and g["killSwitch"]=="ENGAGED"
assert g["allowedDocumentIds"]==[] and g["mutationBudget"]=={"budgetId":"e9-slice-a-paused-snapshot-version-wiring","maxMutations":0}
assert x["lease"]["state"]=="FREE" and a["reconciliationHold"]["active"] is False
print("CF_E9_CLOSE_AUTHORITY=epoch15-seq70-r5")
print("CF_E9_CLOSE_GUARD=engaged-empty-zero")
print("CF_E9_CLOSE=pass")
PY
