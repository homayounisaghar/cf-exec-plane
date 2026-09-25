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
DB=/var/lib/capability-fabric/onshape/fabric-state/execution.sqlite3
QUARANTINE=/var/lib/capability-fabric/onshape/fabric-state/quarantine/D-018-attempt-f6d80f46.json
ROLLBACK_GUARD=/usr/local/libexec/capability-fabric-onshape-rollback-contract

PREV_CONTROL=6ac33244f7968c142e30b2f815d090f74dac49f3
TARGET_CONTROL=417a443c78550348ed3e9b41b1da4542f9b686dd
EXPECTED_MANIFEST=01f31143e3574c02d430a6b4f67a9be3ef24590a39f4e27459131da4beece057

[[ -x "$PULL" && -x "$ROLLBACK_GUARD" ]] || exit 20
[[ -f "$GATE" ]] && grep -Fxq RELEASE_IN_PROGRESS "$GATE"
if systemctl is-active --quiet "$TIMER"; then exit 20; fi
if systemctl is-active --quiet "$SERVICE"; then echo CF_R5_Q_PULL_SERVICE=busy >&2; exit 20; fi
[[ "$(docker inspect -f '{{.State.Running}}' "$GATEWAY")" == false ]]
[[ "$(basename "$(readlink -f "$ACTIVE")")" == "onshape-vps-hardened-production-r5" ]]
[[ "$(cat "$STATE/last-good-sequence")" == "70" ]]
[[ "$(cat "$STATE/last-good-release")" == "onshape-vps-hardened-production-r5" ]]
[[ "$(sha256sum "$(readlink -f "$ACTIVE")/manifest.json" | awk '{print $1}')" == "$EXPECTED_MANIFEST" ]]
[[ "$(git hash-object "$CONTROL")" == "$PREV_CONTROL" ]]
[[ "$(tr -d '\r\n' < "$MIRROR_BLOB")" == "$PREV_CONTROL" ]]

out="$("$PULL" pull)"
printf '%s\n' "$out"
printf '%s\n' "$out" | grep -Fxq 'CF_RUNTIME_CONTROL_MIRROR=updated'
printf '%s\n' "$out" | grep -Fxq 'CF_PULL_NO_CHANGE'

[[ "$(basename "$(readlink -f "$ACTIVE")")" == "onshape-vps-hardened-production-r5" ]]
[[ "$(cat "$STATE/last-good-sequence")" == "70" ]]
[[ "$(cat "$STATE/last-good-release")" == "onshape-vps-hardened-production-r5" ]]
[[ "$(git hash-object "$CONTROL")" == "$TARGET_CONTROL" ]]
[[ "$(tr -d '\r\n' < "$MIRROR_BLOB")" == "$TARGET_CONTROL" ]]
[[ -f "$GATE" ]] && grep -Fxq RELEASE_IN_PROGRESS "$GATE"
if systemctl is-active --quiet "$TIMER"; then exit 30; fi
[[ "$(docker inspect -f '{{.State.Running}}' "$GATEWAY")" == false ]]

python3 - "$CONTROL" <<'PY'
import json,sys
x=json.load(open(sys.argv[1])); a=x["authority"]; g=a["productionGuard"]; v=a["planes"]["vps-fabric"]; d=a["planes"]["android-v1"]
assert x["controlRevision"]==541
assert a["productionEpoch"]==12 and a["mode"]=="QUIESCED_RECONCILING" and a["materialAuthority"] is None
assert d["ingress"]=="CLOSED" and d["materialEffectsAllowed"] is False
assert v["ingress"]=="CLOSED" and v["materialEffectsAllowed"] is False
assert v["releaseSequence"]==70 and v["releaseId"]=="onshape-vps-hardened-production-r5"
assert v["manifestSha256"]=="01f31143e3574c02d430a6b4f67a9be3ef24590a39f4e27459131da4beece057"
assert a["reconciliationHold"]["active"] is False
assert x["lease"]["state"]=="FREE"
assert g["generation"]==3 and g["killSwitch"]=="ENGAGED"
assert g["allowedDocumentIds"]==[] and g["mutationBudget"]["maxMutations"]==0
assert x["routing"]["state"]=="CLOSED" and x["routing"]["materialCommandsAllowed"] is False
print("CF_R5_Q_AUTHORITY=epoch12-quiesced")
print("CF_R5_Q_TARGET_RELEASE=seq70-r5")
print("CF_R5_Q_GUARD=engaged-empty-zero")
print("CF_R5_Q_LEASE=FREE")
PY

ponr="$("$ROLLBACK_GUARD" decide --db "$DB" --control "$CONTROL" --quarantine "$QUARANTINE")"
printf '%s\n' "$ponr"
printf '%s\n' "$ponr" | grep -Fxq 'CF_A4_PONR_COUNT=4'
printf '%s\n' "$ponr" | grep -Fxq 'CF_A4_UNRESOLVED_BLOCKING=0'
printf '%s\n' "$ponr" | grep -Fxq 'CF_A4_ZERO_UNRESOLVED=pass'

echo CF_R5_Q_ACTIVE_RELEASE=seq70-r5
echo CF_R5_Q_RELEASE_GATE=active
echo CF_R5_Q_PULL_TIMER=stopped
echo CF_R5_Q_GATEWAY=stopped
echo CF_R5_Q=pass
