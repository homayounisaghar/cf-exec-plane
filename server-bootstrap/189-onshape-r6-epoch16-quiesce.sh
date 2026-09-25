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
PREV_CONTROL=be24a7a3beb329aad2f04ad8fa96247afc282a55
TARGET_CONTROL=022eef1b4e6234e525c25964487e282f2d3530df
EXPECTED_MANIFEST=e64a1053c02a5abf6becd09275b91768f8642a724c7f0db6d4106a8cbe19583f

[[ -x "$PULL" ]] || exit 20
[[ "$(basename "$(readlink -f "$ACTIVE")")" == "onshape-vps-hardened-production-r6" ]] || exit 20
[[ "$(basename "$(readlink -f "$PREVIOUS")")" == "onshape-vps-hardened-production-r5" ]] || exit 20
[[ "$(cat "$STATE/last-good-sequence")" == "71" ]] || exit 20
[[ "$(cat "$STATE/last-good-release")" == "onshape-vps-hardened-production-r6" ]] || exit 20
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

[[ "$(basename "$(readlink -f "$ACTIVE")")" == "onshape-vps-hardened-production-r6" ]]
[[ "$(basename "$(readlink -f "$PREVIOUS")")" == "onshape-vps-hardened-production-r5" ]]
[[ "$(git hash-object "$CONTROL")" == "$TARGET_CONTROL" ]]
[[ "$(tr -d '\r\n' < "$MIRROR_BLOB")" == "$TARGET_CONTROL" ]]
[[ -f "$GATE" ]]
if systemctl is-active --quiet "$TIMER"; then exit 30; fi
[[ "$(docker inspect -f '{{.State.Running}}' "$GATEWAY")" == false ]]

python3 - "$CONTROL" <<'PY'
import json,sys
x=json.load(open(sys.argv[1])); a=x["authority"]; g=a["productionGuard"]; v=a["planes"]["vps-fabric"]
assert x["controlRevision"]==545
assert a["productionEpoch"]==16 and a["mode"]=="QUIESCED_RECONCILING" and a["materialAuthority"] is None
assert v["ingress"]=="CLOSED" and v["materialEffectsAllowed"] is False
assert v["releaseSequence"]==71 and v["releaseId"]=="onshape-vps-hardened-production-r6"
assert v["manifestSha256"]=="e64a1053c02a5abf6becd09275b91768f8642a724c7f0db6d4106a8cbe19583f"
assert g["killSwitch"]=="ENGAGED" and g["allowedDocumentIds"]==[] and g["mutationBudget"]["maxMutations"]==0
assert x["lease"]["state"]=="FREE"
print("CF_R6_Q_AUTHORITY=epoch16-quiesced")
print("CF_R6_Q_RELEASE=seq71-r6")
print("CF_R6_Q_GUARD=engaged-empty-zero")
print("CF_R6_Q=pass")
PY
