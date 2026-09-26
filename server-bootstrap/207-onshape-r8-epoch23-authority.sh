#!/usr/bin/env bash
set -euo pipefail
umask 077
[[ "$(id -u)" -eq 0 ]] || exit 2
ACTIVE=/opt/capability-fabric/current
PREVIOUS=/opt/capability-fabric/previous
STATE=/var/lib/capability-fabric/state
CONTROL=/var/lib/capability-fabric/onshape/runtime-control/ONSHAPE_RUNTIME_CONTROL.json
MIRROR_BLOB=/var/lib/capability-fabric/onshape/runtime-control/git-blob-sha
GATE="$STATE/release-in-progress"
TIMER=capability-fabric-pull.timer
SERVICE=capability-fabric-pull.service
PULL=/usr/local/libexec/capability-fabric-pull-agent
GATEWAY=capability-fabric-onshape-gateway
PREV_CONTROL=3bef6ae0a09e517fb4030187091bf226c1d68b88
TARGET_CONTROL=ed50203283fc49d30af5b27c08607740edc6e696
EXPECTED_MANIFEST=08873ac1a6830ed42f15ebe340604ed6ffea33b8e7cb12b3a192982f3dcd6e9c
[[ "$(basename "$(readlink -f "$ACTIVE")")" == "onshape-vps-hardened-production-r8" ]] || exit 20
[[ "$(basename "$(readlink -f "$PREVIOUS")")" == "onshape-vps-hardened-production-r7" ]] || exit 20
[[ "$(cat "$STATE/last-good-sequence")" == "73" ]] || exit 20
[[ "$(cat "$STATE/last-good-release")" == "onshape-vps-hardened-production-r8" ]] || exit 20
[[ ! -s "$STATE/last-failed-commit" ]] || exit 20
[[ "$(sha256sum "$(readlink -f "$ACTIVE")/manifest.json" | awk '{print $1}')" == "$EXPECTED_MANIFEST" ]] || exit 20
[[ "$(git hash-object "$CONTROL")" == "$PREV_CONTROL" ]] || exit 20
[[ "$(tr -d '\r\n' < "$MIRROR_BLOB")" == "$PREV_CONTROL" ]] || exit 20
[[ -f "$GATE" ]] && grep -Fxq RELEASE_IN_PROGRESS "$GATE"
if systemctl is-active --quiet "$TIMER"; then exit 20; fi
if systemctl is-active --quiet "$SERVICE"; then exit 20; fi
[[ "$(docker inspect -f '{{.State.Running}}' "$GATEWAY")" == false ]] || exit 20
out="$("$PULL" pull)"
printf '%s\n' "$out"
printf '%s\n' "$out" | grep -Fxq 'CF_RUNTIME_CONTROL_MIRROR=updated'
printf '%s\n' "$out" | grep -Fxq 'CF_PULL_NO_CHANGE'
[[ "$(git hash-object "$CONTROL")" == "$TARGET_CONTROL" ]]
[[ "$(tr -d '\r\n' < "$MIRROR_BLOB")" == "$TARGET_CONTROL" ]]
python3 - "$CONTROL" <<'PY'
import json,sys
x=json.load(open(sys.argv[1])); a=x["authority"]; g=a["productionGuard"]; v=a["planes"]["vps-fabric"]
assert x["controlRevision"]==552
assert a["productionEpoch"]==23 and a["mode"]=="VPS_PRODUCTION" and a["materialAuthority"]=="vps-fabric"
assert v["ingress"]=="ADMITTED" and v["materialEffectsAllowed"] is True
assert v["releaseSequence"]==73 and v["releaseId"]=="onshape-vps-hardened-production-r8"
assert v["manifestSha256"]=="08873ac1a6830ed42f15ebe340604ed6ffea33b8e7cb12b3a192982f3dcd6e9c"
assert g["generation"]==7 and g["killSwitch"]=="ENGAGED" and g["allowedDocumentIds"]==[] and g["mutationBudget"]["maxMutations"]==0
assert x["lease"]["state"]=="FREE" and a["reconciliationHold"]["active"] is False
print("CF_R8_AUTH_AUTHORITY=epoch23-seq73-r8")
print("CF_R8_AUTH_GUARD=engaged-empty-zero")
print("CF_R8_AUTH=pass")
PY
