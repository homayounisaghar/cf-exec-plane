#!/usr/bin/env bash
set -euo pipefail
umask 077
[[ "$(id -u)" -eq 0 ]] || exit 2
ACTIVE=/opt/capability-fabric/current
STATE=/var/lib/capability-fabric/state
CONTROL=/var/lib/capability-fabric/onshape/runtime-control/ONSHAPE_RUNTIME_CONTROL.json
GATE="$STATE/release-in-progress"
TIMER=capability-fabric-pull.timer
SERVICE=capability-fabric-pull.service
GATEWAY=capability-fabric-onshape-gateway
DB=/var/lib/capability-fabric/onshape/fabric-state/execution.sqlite3
QUARANTINE=/var/lib/capability-fabric/onshape/fabric-state/quarantine/D-018-attempt-f6d80f46.json
ROLLBACK_GUARD=/usr/local/libexec/capability-fabric-onshape-rollback-contract
EXPECTED_CONTROL=b526a61c5af2c054cbde6411f49c51f96982acc7
EXPECTED_MANIFEST=e64a1053c02a5abf6becd09275b91768f8642a724c7f0db6d4106a8cbe19583f

[[ "$(basename "$(readlink -f "$ACTIVE")")" == "onshape-vps-hardened-production-r6" ]] || exit 20
[[ "$(cat "$STATE/last-good-sequence")" == "71" ]] || exit 20
[[ "$(cat "$STATE/last-good-release")" == "onshape-vps-hardened-production-r6" ]] || exit 20
[[ "$(sha256sum "$(readlink -f "$ACTIVE")/manifest.json" | awk '{print $1}')" == "$EXPECTED_MANIFEST" ]] || exit 20
[[ "$(git hash-object "$CONTROL")" == "$EXPECTED_CONTROL" ]] || exit 20
[[ ! -e "$GATE" ]] || exit 20
systemctl is-active --quiet "$TIMER"
if systemctl is-active --quiet "$SERVICE"; then exit 20; fi
[[ "$(docker inspect -f '{{.State.Running}}' "$GATEWAY")" == true ]]

python3 - "$CONTROL" <<'PY'
import json,sys
x=json.load(open(sys.argv[1])); a=x["authority"]; g=a["productionGuard"]; v=a["planes"]["vps-fabric"]
assert x["controlRevision"]==548 and a["productionEpoch"]==19
assert a["mode"]=="VPS_PRODUCTION" and a["materialAuthority"]=="vps-fabric"
assert v["releaseSequence"]==71 and v["releaseId"]=="onshape-vps-hardened-production-r6"
assert v["manifestSha256"]=="e64a1053c02a5abf6becd09275b91768f8642a724c7f0db6d4106a8cbe19583f"
assert x["lease"]["state"]=="FREE" and a["reconciliationHold"]["active"] is False
assert g["generation"]==7 and g["killSwitch"]=="ENGAGED" and g["allowedDocumentIds"]==[] and g["mutationBudget"]["maxMutations"]==0
print("CF_R7_ARM_PRE=epoch19-seq71-r6-guard-closed")
PY
ponr="$("$ROLLBACK_GUARD" decide --db "$DB" --control "$CONTROL" --quarantine "$QUARANTINE")"
printf '%s
' "$ponr" | grep -Fxq 'CF_A4_PONR_COUNT=6'
printf '%s
' "$ponr" | grep -Fxq 'CF_A4_UNRESOLVED_BLOCKING=0'
printf '%s
' "$ponr" | grep -Fxq 'CF_A4_ZERO_UNRESOLVED=pass'

systemctl stop "$TIMER"
if systemctl is-active --quiet "$TIMER"; then exit 30; fi
if systemctl is-active --quiet "$SERVICE"; then exit 30; fi
tmp="$GATE.tmp.r7.$$"; printf '%s
' RELEASE_IN_PROGRESS >"$tmp"; chmod 0600 "$tmp"; chown root:root "$tmp"; mv -f "$tmp" "$GATE"
docker stop "$GATEWAY" >/dev/null
[[ "$(docker inspect -f '{{.State.Running}}' "$GATEWAY")" == false ]]
echo CF_R7_ARM_GATE=active
echo CF_R7_ARM_TIMER=stopped
echo CF_R7_ARM_GATEWAY=stopped
echo CF_R7_ARM=pass
