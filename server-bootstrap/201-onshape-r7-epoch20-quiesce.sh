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
PREV_CONTROL=b526a61c5af2c054cbde6411f49c51f96982acc7
TARGET_CONTROL=a2c89efef8cc5c78e00926881e844ec90efaea97
EXPECTED_MANIFEST=7fdfb79f43dba8a061767824984cb76c0a3cc1f8349a7628f806893ba04c8f2e

[[ "$(basename "$(readlink -f "$ACTIVE")")" == "onshape-vps-hardened-production-r7" ]] || exit 20
[[ "$(basename "$(readlink -f "$PREVIOUS")")" == "onshape-vps-hardened-production-r6" ]] || exit 20
[[ "$(cat "$STATE/last-good-sequence")" == "72" ]] || exit 20
[[ "$(cat "$STATE/last-good-release")" == "onshape-vps-hardened-production-r7" ]] || exit 20
[[ ! -s "$STATE/last-failed-commit" ]] || exit 20
[[ "$(sha256sum "$(readlink -f "$ACTIVE")/manifest.json" | awk '{print $1}')" == "$EXPECTED_MANIFEST" ]] || exit 20
[[ "$(git hash-object "$CONTROL")" == "$PREV_CONTROL" ]] || exit 20
[[ "$(tr -d '\r\n' < "$MIRROR_BLOB")" == "$PREV_CONTROL" ]] || exit 20
[[ -f "$GATE" ]] && grep -Fxq RELEASE_IN_PROGRESS "$GATE"
systemctl stop "$TIMER" || true
if systemctl is-active --quiet "$TIMER"; then exit 20; fi
if systemctl is-active --quiet "$SERVICE"; then exit 20; fi
[[ "$(docker inspect -f '{{.State.Running}}' "$GATEWAY")" == false ]] || exit 20

out="$("$PULL" pull)"
printf '%s\n' "$out"
printf '%s\n' "$out" | grep -Fxq 'CF_RUNTIME_CONTROL_MIRROR=updated'
printf '%s\n' "$out" | grep -Fxq 'CF_PULL_NO_CHANGE'
[[ "$(git hash-object "$CONTROL")" == "$TARGET_CONTROL" ]]
[[ "$(tr -d '\r\n' < "$MIRROR_BLOB")" == "$TARGET_CONTROL" ]]
[[ "$(basename "$(readlink -f "$ACTIVE")")" == "onshape-vps-hardened-production-r7" ]]
[[ "$(cat "$STATE/last-good-sequence")" == "72" ]]
[[ -f "$GATE" ]]
if systemctl is-active --quiet "$TIMER"; then exit 30; fi
[[ "$(docker inspect -f '{{.State.Running}}' "$GATEWAY")" == false ]]

python3 - "$CONTROL" <<'PY'
import json,sys
x=json.load(open(sys.argv[1])); a=x["authority"]; g=a["productionGuard"]; v=a["planes"]["vps-fabric"]
assert x["controlRevision"]==549
assert a["productionEpoch"]==20 and a["mode"]=="QUIESCED_RECONCILING" and a["materialAuthority"] is None
assert v["ingress"]=="CLOSED" and v["materialEffectsAllowed"] is False
assert v["releaseSequence"]==72 and v["releaseId"]=="onshape-vps-hardened-production-r7"
assert v["manifestSha256"]=="7fdfb79f43dba8a061767824984cb76c0a3cc1f8349a7628f806893ba04c8f2e"
assert g["generation"]==7 and g["killSwitch"]=="ENGAGED" and g["allowedDocumentIds"]==[] and g["mutationBudget"]["maxMutations"]==0
assert x["lease"]["state"]=="FREE" and a["reconciliationHold"]["active"] is False
print("CF_R7_Q_AUTHORITY=epoch20-quiesced")
print("CF_R7_Q_RELEASE=seq72-r7")
print("CF_R7_Q_GUARD=engaged-empty-zero")
print("CF_R7_Q=pass")
PY
