#!/usr/bin/env bash
set -euo pipefail
umask 077
[[ "$(id -u)" -eq 0 ]] || exit 2

active=/opt/capability-fabric/current
state=/var/lib/capability-fabric/state
gate="$state/release-in-progress"
control=/var/lib/capability-fabric/onshape/runtime-control/ONSHAPE_RUNTIME_CONTROL.json
db=/var/lib/capability-fabric/onshape/fabric-state/execution.sqlite3
quarantine=/var/lib/capability-fabric/onshape/fabric-state/quarantine/D-018-attempt-f6d80f46.json
guard=/usr/local/libexec/capability-fabric-onshape-rollback-contract
gateway=capability-fabric-onshape-gateway
expected_blob=81f73bb89c5517080a80ada3047c58c287874c50

[[ -L "$active" && -s "$control" && -s "$db" && -s "$quarantine" && -x "$guard" ]] || exit 20
[[ ! -e "$gate" ]] || { echo CF_R4_ARM_RELEASE_GATE_ALREADY_PRESENT >&2; exit 21; }
a="$(readlink -f "$active")"
[[ "$a" == /var/lib/capability-fabric/releases/* ]]
python3 - "$a/manifest.json" "$control" <<'PY'
import json,sys
m=json.load(open(sys.argv[1])); r=json.load(open(sys.argv[2])); a=r["authority"]
assert m["sequence"]==66 and m["release_id"]=="onshape-vps-hardened-production-r3"
assert r["controlRevision"]==531
assert a["productionEpoch"]==3 and a["mode"]=="VPS_PRODUCTION" and a["materialAuthority"]=="vps-fabric"
assert a["planes"]["android-v1"]["ingress"]=="CLOSED"
assert a["planes"]["android-v1"]["materialEffectsAllowed"] is False
assert a["planes"]["vps-fabric"]["ingress"]=="ADMITTED"
assert a["planes"]["vps-fabric"]["materialEffectsAllowed"] is True
assert r["lease"]["state"]=="FREE"
print("CF_R4_ARM_AUTHORITY_PRE=epoch3-vps-production")
print("CF_R4_ARM_ACTIVE_PRE=seq66")
PY
[[ "$(git hash-object "$control")" == "$expected_blob" ]]

ponr="$(python3 "$guard" decide --db "$db" --control "$control" --quarantine "$quarantine")"
printf '%s\n' "$ponr"
printf '%s\n' "$ponr" | grep -Fxq 'CF_A4_PONR=true'
printf '%s\n' "$ponr" | grep -Fxq 'CF_A4_PONR_COUNT=2'
printf '%s\n' "$ponr" | grep -Fxq 'CF_A4_UNRESOLVED_BLOCKING=0'
printf '%s\n' "$ponr" | grep -Fxq 'CF_A4_ZERO_UNRESOLVED=pass'
echo CF_R4_ARM_SAFETY_PRE=pass

systemctl stop capability-fabric-pull.timer
if systemctl is-active --quiet capability-fabric-pull.timer; then
  echo CF_R4_ARM_PULL_TIMER_STILL_ACTIVE >&2
  exit 30
fi
tmp="$gate.tmp.$$"
printf '%s\n' 'RELEASE_IN_PROGRESS' > "$tmp"
chmod 0600 "$tmp"
chown root:root "$tmp"
mv -f "$tmp" "$gate"
docker stop "$gateway" >/dev/null
[[ "$(docker inspect -f '{{.State.Running}}' "$gateway")" == false ]]

[[ "$(readlink -f "$active")" == "$a" ]]
[[ "$(git hash-object "$control")" == "$expected_blob" ]]
echo CF_R4_ARM_PULL_TIMER=stopped
echo CF_R4_ARM_RELEASE_GATE=active
echo CF_R4_ARM_PUBLIC_GATEWAY=stopped
echo CF_R4_ARM_ACTIVE_UNCHANGED=seq66
echo CF_R4_ARM_CONTROL_UNCHANGED=yes
echo CF_R4_ARM=pass
