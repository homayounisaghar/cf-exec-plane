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
expected_blob=3b7b05f78c89d7fed2f8bb964cda42347924a329
expected_manifest=f2631a7f94ec5f6e5af5e9d3b3211cf440354eef0b55ff6fee7ab65cec50bfb9

[[ -L "$ACTIVE" && -s "$CONTROL" && -s "$DB" && -s "$QUARANTINE" && -x "$ROLLBACK_GUARD" ]] || exit 20
[[ ! -e "$GATE" ]] || { echo CF_TARGET_ARM_RELEASE_GATE_ALREADY_PRESENT >&2; exit 21; }
active="$(readlink -f "$ACTIVE")"
[[ "$active" == /var/lib/capability-fabric/releases/onshape-vps-hardened-production-r4 ]]
[[ "$(sha256sum "$active/manifest.json" | awk '{print $1}')" == "$expected_manifest" ]]
[[ "$(git hash-object "$CONTROL")" == "$expected_blob" ]]
[[ "$(tr -d '\r\n' < "$MIRROR_BLOB")" == "$expected_blob" ]]

python3 - "$active/manifest.json" "$CONTROL" <<'PY'
import json,sys
m=json.load(open(sys.argv[1])); r=json.load(open(sys.argv[2])); a=r["authority"]; g=a["productionGuard"]
assert m["sequence"]==67 and m["release_id"]=="onshape-vps-hardened-production-r4"
assert r["controlRevision"]==534
assert a["productionEpoch"]==5 and a["mode"]=="VPS_PRODUCTION" and a["materialAuthority"]=="vps-fabric"
assert a["planes"]["android-v1"]["ingress"]=="CLOSED" and a["planes"]["android-v1"]["materialEffectsAllowed"] is False
assert a["planes"]["vps-fabric"]["ingress"]=="ADMITTED" and a["planes"]["vps-fabric"]["materialEffectsAllowed"] is True
assert r["lease"]["state"]=="FREE"
assert g["generation"]==1 and g["killSwitch"]=="ENGAGED"
assert g["allowedDocumentIds"]==[]
assert g["mutationBudget"]=={"budgetId":"epoch4-seq67-stabilization-closed","maxMutations":0}
print("CF_TARGET_ARM_AUTHORITY_PRE=epoch5-vps-production")
print("CF_TARGET_ARM_GUARD_PRE=engaged-empty-zero")
print("CF_TARGET_ARM_ACTIVE_PRE=seq67")
PY

ponr="$("$ROLLBACK_GUARD" decide --db "$DB" --control "$CONTROL" --quarantine "$QUARANTINE")"
printf '%s\n' "$ponr"
printf '%s\n' "$ponr" | grep -Fxq 'CF_A4_PONR=true'
printf '%s\n' "$ponr" | grep -Fxq 'CF_A4_PONR_COUNT=2'
printf '%s\n' "$ponr" | grep -Fxq 'CF_A4_UNRESOLVED_BLOCKING=0'
printf '%s\n' "$ponr" | grep -Fxq 'CF_A4_ZERO_UNRESOLVED=pass'
echo CF_TARGET_ARM_SAFETY_PRE=pass

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
echo CF_TARGET_ARM_PULL_TIMER=stopped
echo CF_TARGET_ARM_RELEASE_GATE=active
echo CF_TARGET_ARM_PUBLIC_GATEWAY=stopped
echo CF_TARGET_ARM_ACTIVE_UNCHANGED=seq67
echo CF_TARGET_ARM_CONTROL_UNCHANGED=yes
echo CF_TARGET_ARM=pass
