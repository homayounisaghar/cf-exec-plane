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
SERVER=capability-fabric-onshape-server
DB=/var/lib/capability-fabric/onshape/fabric-state/execution.sqlite3
AGENT_DIR=/var/lib/capability-fabric/onshape/fabric-agent
QUARANTINE=/var/lib/capability-fabric/onshape/fabric-state/quarantine/D-018-attempt-f6d80f46.json
ROLLBACK_GUARD=/usr/local/libexec/capability-fabric-onshape-rollback-contract

PREV_CONTROL=7c03d59b613a7c91249f4c56efd045e1ed13a8dc
TARGET_CONTROL=1b9c248d8b57385a86c5c157bf99ef4f1f6928ce
EXPECTED_MANIFEST=08873ac1a6830ed42f15ebe340604ed6ffea33b8e7cb12b3a192982f3dcd6e9c
BUDGET=e9-mate-durability-r8-20260926

[[ "$(basename "$(readlink -f "$ACTIVE")")" == "onshape-vps-hardened-production-r8" ]] || exit 20
[[ "$(cat "$STATE/last-good-sequence")" == "73" ]] || exit 20
[[ "$(cat "$STATE/last-good-release")" == "onshape-vps-hardened-production-r8" ]] || exit 20
[[ ! -s "$STATE/last-failed-commit" ]] || exit 20
[[ "$(sha256sum "$(readlink -f "$ACTIVE")/manifest.json" | awk '{print $1}')" == "$EXPECTED_MANIFEST" ]] || exit 20
[[ "$(git hash-object "$CONTROL")" == "$PREV_CONTROL" ]] || exit 20
[[ "$(tr -d '\r\n' < "$MIRROR_BLOB")" == "$PREV_CONTROL" ]] || exit 20
[[ -f "$GATE" ]] && grep -Fxq RELEASE_IN_PROGRESS "$GATE"
if systemctl is-active --quiet "$TIMER"; then exit 20; fi
if systemctl is-active --quiet "$SERVICE"; then exit 20; fi
[[ "$(docker inspect -f '{{.State.Running}}' "$GATEWAY" 2>/dev/null || echo false)" == false ]] || exit 20
[[ "$(docker inspect -f '{{.State.Running}}' "$SERVER" 2>/dev/null || echo false)" == true ]] || exit 20

out="$("$PULL" pull)"
printf '%s\n' "$out"
printf '%s\n' "$out" | grep -Fxq 'CF_RUNTIME_CONTROL_MIRROR=updated'
printf '%s\n' "$out" | grep -Fxq 'CF_PULL_NO_CHANGE'
[[ "$(git hash-object "$CONTROL")" == "$TARGET_CONTROL" ]]
[[ "$(tr -d '\r\n' < "$MIRROR_BLOB")" == "$TARGET_CONTROL" ]]

python3 - "$CONTROL" <<'PY'
import json,sys
x=json.load(open(sys.argv[1])); a=x["authority"]; g=a["productionGuard"]; v=a["planes"]["vps-fabric"]
assert x["controlRevision"]==556 and a["productionEpoch"]==27
assert a["mode"]=="VPS_PRODUCTION" and a["materialAuthority"]=="vps-fabric"
assert v["releaseSequence"]==73 and v["releaseId"]=="onshape-vps-hardened-production-r8"
assert v["manifestSha256"]=="08873ac1a6830ed42f15ebe340604ed6ffea33b8e7cb12b3a192982f3dcd6e9c"
assert a["planes"]["android-v1"]["ingress"]=="CLOSED"
assert a["planes"]["android-v1"]["materialEffectsAllowed"] is False
assert a["reconciliationHold"]["active"] is False and x["lease"]["state"]=="FREE"
assert g["generation"]==11 and g["killSwitch"]=="ENGAGED"
assert g["allowedDocumentIds"]==[]
assert g["mutationBudget"]=={"budgetId":"e9-mate-durability-complete-closed","maxMutations":0}
print("CF_E9_MATE_CLOSE_AUTHORITY=epoch27-seq73-r8")
print("CF_E9_MATE_CLOSE_GUARD=engaged-empty-zero")
PY

python3 - "$AGENT_DIR" "$BUDGET" <<'PY'
import json,pathlib,sys
root=pathlib.Path(sys.argv[1]); budget=sys.argv[2]; rows=[]
for p in root.rglob("*.json"):
    try:v=json.loads(p.read_text())
    except Exception: continue
    if isinstance(v,dict) and v.get("budgetId")==budget:
        rows.append(v)
slots=sorted(int(x["slot"]) for x in rows)
assert slots==[1,2,3,4],slots
print("CF_E9_MATE_CLOSE_BUDGET_SLOTS=1,2,3,4")
PY

ponr="$("$ROLLBACK_GUARD" decide --db "$DB" --control "$CONTROL" --quarantine "$QUARANTINE")"
printf '%s\n' "$ponr"
printf '%s\n' "$ponr" | grep -Fxq 'CF_A4_UNRESOLVED_BLOCKING=0'
printf '%s\n' "$ponr" | grep -Fxq 'CF_A4_ZERO_UNRESOLVED=pass'

# Preserve the shared production closure because the isolated Phase-0 research
# surface is concurrently using that fail-closed boundary. Do not reopen here.
[[ -f "$GATE" ]] && grep -Fxq RELEASE_IN_PROGRESS "$GATE"
if systemctl is-active --quiet "$TIMER"; then exit 20; fi
[[ "$(docker inspect -f '{{.State.Running}}' "$GATEWAY" 2>/dev/null || echo false)" == false ]] || exit 20
[[ "$(docker inspect -f '{{.State.Running}}' "$SERVER")" == true ]] || exit 20

echo CF_E9_MATE_CLOSE_PRODUCTION_GATE=preserved-closed
echo CF_E9_MATE_CLOSE_PULL_TIMER=preserved-stopped
echo CF_E9_MATE_CLOSE_GATEWAY=preserved-stopped
echo CF_E9_MATE_CLOSE=pass
