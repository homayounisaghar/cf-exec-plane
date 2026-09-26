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
PREV_CONTROL=d8378b345474a9aaca1a9e605d7578e47b23772d
TARGET_CONTROL=7c03d59b613a7c91249f4c56efd045e1ed13a8dc
DID=6efc214ada1e9b6924774296
EXPECTED_MANIFEST=08873ac1a6830ed42f15ebe340604ed6ffea33b8e7cb12b3a192982f3dcd6e9c

[[ "$(basename "$(readlink -f "$ACTIVE")")" == "onshape-vps-hardened-production-r8" ]]
[[ "$(cat "$STATE/last-good-sequence")" == "73" ]]
[[ "$(cat "$STATE/last-good-release")" == "onshape-vps-hardened-production-r8" ]]
[[ "$(sha256sum "$(readlink -f "$ACTIVE")/manifest.json" | awk '{print $1}')" == "$EXPECTED_MANIFEST" ]]
[[ "$(git hash-object "$CONTROL")" == "$PREV_CONTROL" ]]
[[ "$(tr -d '\r\n' < "$MIRROR_BLOB")" == "$PREV_CONTROL" ]]
[[ ! -e "$GATE" ]]
systemctl is-active --quiet "$TIMER"
if systemctl is-active --quiet "$SERVICE"; then exit 20; fi
[[ "$(docker inspect -f '{{.State.Running}}' "$GATEWAY")" == true ]]

systemctl stop "$TIMER"
docker stop "$GATEWAY" >/dev/null
tmp="$GATE.tmp.e9mateopen.$$"; printf '%s\n' RELEASE_IN_PROGRESS >"$tmp"; chmod 600 "$tmp"; chown root:root "$tmp"; mv "$tmp" "$GATE"

out="$("$PULL" pull)"
printf '%s\n' "$out"
printf '%s\n' "$out" | grep -Fxq 'CF_RUNTIME_CONTROL_MIRROR=updated'
printf '%s\n' "$out" | grep -Fxq 'CF_PULL_NO_CHANGE'
[[ "$(git hash-object "$CONTROL")" == "$TARGET_CONTROL" ]]
[[ "$(tr -d '\r\n' < "$MIRROR_BLOB")" == "$TARGET_CONTROL" ]]

python3 - "$CONTROL" "$DID" <<'PY'
import json,sys
x=json.load(open(sys.argv[1])); did=sys.argv[2]; a=x["authority"]; g=a["productionGuard"]; v=a["planes"]["vps-fabric"]
assert x["controlRevision"]==555 and a["productionEpoch"]==26
assert a["mode"]=="VPS_PRODUCTION" and a["materialAuthority"]=="vps-fabric"
assert v["releaseSequence"]==73 and v["releaseId"]=="onshape-vps-hardened-production-r8"
assert v["manifestSha256"]=="08873ac1a6830ed42f15ebe340604ed6ffea33b8e7cb12b3a192982f3dcd6e9c"
assert g["generation"]==10 and g["killSwitch"]=="OPEN"
assert g["allowedDocumentIds"]==[did]
assert g["mutationBudget"]=={"budgetId":"e9-mate-durability-r8-20260926","maxMutations":4}
assert x["lease"]["state"]=="FREE" and a["reconciliationHold"]["active"] is False
print("CF_E9_MATE_OPEN_AUTHORITY=epoch26-seq73-r8")
print("CF_E9_MATE_OPEN_GUARD=copy-only-budget4")
PY
echo CF_E9_MATE_OPEN_RELEASE_GATE=active
echo CF_E9_MATE_OPEN_GATEWAY=stopped
echo CF_E9_MATE_OPEN=pass
