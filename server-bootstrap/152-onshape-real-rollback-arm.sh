#!/usr/bin/env bash
set -euo pipefail
umask 077
[[ "$(id -u)" -eq 0 ]] || exit 2

ACTIVE=/opt/capability-fabric/current
STATE=/var/lib/capability-fabric/state
GATE="$STATE/release-in-progress"
CONTROL=/var/lib/capability-fabric/onshape/runtime-control/ONSHAPE_RUNTIME_CONTROL.json
MIRROR_BLOB=/var/lib/capability-fabric/onshape/runtime-control/git-blob-sha
DB=/var/lib/capability-fabric/onshape/fabric-state/execution.sqlite3
QUARANTINE=/var/lib/capability-fabric/onshape/fabric-state/quarantine/D-018-attempt-f6d80f46.json
ROLLBACK_GUARD=/usr/local/libexec/capability-fabric-onshape-rollback-contract
GATEWAY=capability-fabric-onshape-gateway
TIMER=capability-fabric-pull.timer
expected_blob=499a1372a0416d5f8d0bbcecbef39cee20373f5b
expected_manifest=f2631a7f94ec5f6e5af5e9d3b3211cf440354eef0b55ff6fee7ab65cec50bfb9

[[ -L "$ACTIVE" && -s "$CONTROL" && -s "$DB" && -s "$QUARANTINE" && -x "$ROLLBACK_GUARD" ]] || exit 20
[[ ! -e "$GATE" ]] || exit 21
active="$(readlink -f "$ACTIVE")"
[[ "$active" == /var/lib/capability-fabric/releases/onshape-vps-hardened-production-r4 ]]
[[ "$(sha256sum "$active/manifest.json" | awk '{print $1}')" == "$expected_manifest" ]]
[[ "$(git hash-object "$CONTROL")" == "$expected_blob" ]]
[[ "$(tr -d '\r\n' < "$MIRROR_BLOB")" == "$expected_blob" ]]
[[ "$(docker inspect -f '{{.State.Running}}' "$GATEWAY")" == true ]]
systemctl is-active --quiet "$TIMER"

python3 - "$CONTROL" <<'PY'
import json,sys
x=json.load(open(sys.argv[1])); a=x["authority"]; g=a["productionGuard"]; v=a["planes"]["vps-fabric"]; android=a["planes"]["android-v1"]
assert x["controlRevision"]==536
assert a["productionEpoch"]==7 and a["mode"]=="VPS_PRODUCTION" and a["materialAuthority"]=="vps-fabric"
assert android["ingress"]=="CLOSED" and android["materialEffectsAllowed"] is False and android["busGeneration"]==2
assert v["ingress"]=="ADMITTED" and v["materialEffectsAllowed"] is True and v["releaseSequence"]==67
assert x["routing"]["state"]=="CLOSED" and x["routing"]["materialCommandsAllowed"] is False
assert x["routing"]["busGeneration"]==2 and x["routing"]["activeMailboxIssue"]==34
assert x["lease"]["state"]=="FREE"
assert g["generation"]==3 and g["killSwitch"]=="ENGAGED" and g["allowedDocumentIds"]==[]
assert g["mutationBudget"]=={"budgetId":"epoch7-post-test-closed","maxMutations":0}
print("CF_ROLLBACK_ARM_AUTHORITY=epoch7-vps")
print("CF_ROLLBACK_ARM_GUARD=closed")
print("CF_ROLLBACK_ARM_ANDROID=CLOSED-bus2-mailbox34")
PY

out="$("$ROLLBACK_GUARD" decide --db "$DB" --control "$CONTROL" --quarantine "$QUARANTINE")"
printf '%s\n' "$out"
printf '%s\n' "$out" | grep -Fxq 'CF_A4_PONR=true'
printf '%s\n' "$out" | grep -Fxq 'CF_A4_PONR_COUNT=4'
printf '%s\n' "$out" | grep -Fxq 'CF_A4_UNRESOLVED_BLOCKING=0'
printf '%s\n' "$out" | grep -Fxq 'CF_A4_ZERO_UNRESOLVED=pass'
echo CF_ROLLBACK_ARM_SAFETY=pass

systemctl stop "$TIMER"
if systemctl is-active --quiet "$TIMER"; then exit 30; fi
tmp="$GATE.tmp.$$"
printf '%s\n' RELEASE_IN_PROGRESS >"$tmp"
chmod 0600 "$tmp"
chown root:root "$tmp"
mv -f "$tmp" "$GATE"
docker stop "$GATEWAY" >/dev/null
[[ "$(docker inspect -f '{{.State.Running}}' "$GATEWAY")" == false ]]
[[ "$(readlink -f "$ACTIVE")" == "$active" ]]
[[ "$(git hash-object "$CONTROL")" == "$expected_blob" ]]
echo CF_ROLLBACK_ARM_PULL_TIMER=stopped
echo CF_ROLLBACK_ARM_RELEASE_GATE=active
echo CF_ROLLBACK_ARM_PUBLIC_GATEWAY=stopped
echo CF_ROLLBACK_ARM_ACTIVE=seq67
echo CF_ROLLBACK_ARM=pass
