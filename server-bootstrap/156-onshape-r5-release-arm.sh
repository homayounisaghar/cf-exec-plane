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
SERVER=capability-fabric-onshape-server
DB=/var/lib/capability-fabric/onshape/fabric-state/execution.sqlite3
QUARANTINE=/var/lib/capability-fabric/onshape/fabric-state/quarantine/D-018-attempt-f6d80f46.json
ROLLBACK_GUARD=/usr/local/libexec/capability-fabric-onshape-rollback-contract
EXPECTED_CONTROL=6ac33244f7968c142e30b2f815d090f74dac49f3

[[ -L "$ACTIVE" && -s "$CONTROL" && -s "$DB" && -s "$QUARANTINE" && -x "$ROLLBACK_GUARD" ]] || exit 20
[[ "$(basename "$(readlink -f "$ACTIVE")")" == "capability-fabric-isolated-telegram-ingress-r69" ]] || { echo CF_R5_ARM_ACTIVE_PRE=mismatch >&2; exit 21; }
[[ "$(cat "$STATE/last-good-sequence")" == "69" ]] || { echo CF_R5_ARM_LAST_GOOD_SEQUENCE=mismatch >&2; exit 21; }
[[ "$(cat "$STATE/last-good-release")" == "capability-fabric-isolated-telegram-ingress-r69" ]] || { echo CF_R5_ARM_LAST_GOOD_RELEASE=mismatch >&2; exit 21; }
[[ ! -s "$STATE/last-failed-commit" ]] || { echo CF_R5_ARM_LAST_FAILED=present >&2; exit 21; }
[[ "$(git hash-object "$CONTROL")" == "$EXPECTED_CONTROL" ]] || { echo CF_R5_ARM_CONTROL_BLOB=mismatch >&2; exit 21; }
[[ ! -e "$GATE" ]] || { echo CF_R5_ARM_GATE=already-present >&2; exit 21; }
systemctl is-active --quiet "$TIMER" || { echo CF_R5_ARM_TIMER=not-active >&2; exit 21; }
if systemctl is-active --quiet "$SERVICE"; then echo CF_R5_ARM_PULL_SERVICE=busy >&2; exit 21; fi
[[ "$(docker inspect -f '{{.State.Running}}' "$GATEWAY")" == true ]] || { echo CF_R5_ARM_GATEWAY=not-running >&2; exit 21; }
[[ "$(docker inspect -f '{{.State.Running}}' "$SERVER")" == true ]] || { echo CF_R5_ARM_SERVER=not-running >&2; exit 21; }

python3 - "$CONTROL" <<'PY'
import json,sys
x=json.load(open(sys.argv[1])); a=x["authority"]; g=a["productionGuard"]; v=a["planes"]["vps-fabric"]; d=a["planes"]["android-v1"]
assert x["controlRevision"]==540
assert a["productionEpoch"]==11 and a["mode"]=="VPS_PRODUCTION" and a["materialAuthority"]=="vps-fabric"
assert d["ingress"]=="CLOSED" and d["materialEffectsAllowed"] is False
assert v["ingress"]=="ADMITTED" and v["materialEffectsAllowed"] is True
assert v["releaseSequence"]==67 and v["releaseId"]=="onshape-vps-hardened-production-r4"
assert a["reconciliationHold"]["active"] is False
assert x["lease"]["state"]=="FREE"
assert g["killSwitch"]=="ENGAGED" and g["allowedDocumentIds"]==[]
assert g["mutationBudget"]["maxMutations"]==0
assert x["routing"]["state"]=="CLOSED" and x["routing"]["materialCommandsAllowed"] is False
print("CF_R5_ARM_AUTHORITY_PRE=pass")
print("CF_R5_ARM_GUARD=engaged-empty-zero")
print("CF_R5_ARM_LEASE=FREE")
PY

ponr="$("$ROLLBACK_GUARD" decide --db "$DB" --control "$CONTROL" --quarantine "$QUARANTINE")"
printf '%s
' "$ponr"
printf '%s
' "$ponr" | grep -Fxq 'CF_A4_PONR=true'
printf '%s
' "$ponr" | grep -Fxq 'CF_A4_PONR_COUNT=4'
printf '%s
' "$ponr" | grep -Fxq 'CF_A4_UNRESOLVED_BLOCKING=0'
echo CF_R5_ARM_SAFETY_PRE=pass

armed=no
cleanup(){
  rc=$?
  if [[ "$armed" != yes ]]; then
    rm -f "$GATE" >/dev/null 2>&1 || true
    docker start "$GATEWAY" >/dev/null 2>&1 || true
    systemctl start "$TIMER" >/dev/null 2>&1 || true
  fi
  exit "$rc"
}
trap cleanup EXIT

systemctl stop "$TIMER"
if systemctl is-active --quiet "$TIMER"; then echo CF_R5_ARM_TIMER=still-active >&2; exit 30; fi
if systemctl is-active --quiet "$SERVICE"; then echo CF_R5_ARM_PULL_SERVICE=became-active >&2; exit 30; fi

tmp="$GATE.tmp.$$"
printf '%s
' RELEASE_IN_PROGRESS >"$tmp"
chmod 0600 "$tmp"
chown root:root "$tmp"
mv -f "$tmp" "$GATE"
docker stop "$GATEWAY" >/dev/null

[[ "$(docker inspect -f '{{.State.Running}}' "$GATEWAY")" == false ]]
[[ "$(basename "$(readlink -f "$ACTIVE")")" == "capability-fabric-isolated-telegram-ingress-r69" ]]
[[ "$(git hash-object "$CONTROL")" == "$EXPECTED_CONTROL" ]]
python3 - "$CONTROL" <<'PY'
import json,sys
x=json.load(open(sys.argv[1]))
assert x["lease"]["state"]=="FREE"
g=x["authority"]["productionGuard"]
assert g["killSwitch"]=="ENGAGED" and g["allowedDocumentIds"]==[] and g["mutationBudget"]["maxMutations"]==0
PY

armed=yes
trap - EXIT
echo CF_R5_ARM_ACTIVE=seq69
echo CF_R5_ARM_PULL_TIMER=stopped
echo CF_R5_ARM_RELEASE_GATE=active
echo CF_R5_ARM_GATEWAY=stopped
echo CF_R5_ARM=pass
