#!/usr/bin/env bash
set -euo pipefail
umask 077
[[ "$(id -u)" -eq 0 ]] || exit 2

timer=capability-fabric-pull.timer
service=capability-fabric-pull.service
lock=/run/lock/capability-fabric-pull.lock
gate=/var/lib/capability-fabric/state/release-in-progress
active=/opt/capability-fabric/current
candidate=/var/lib/capability-fabric/releases/onshape-vps-hardened-production-r3
control=/var/lib/capability-fabric/onshape/runtime-control/ONSHAPE_RUNTIME_CONTROL.json
expected_sha=857b7ca6d5a6bcf79b820594801a4f88642fe9520dad1ae18fc064eae6073d7c

[[ ! -e "$gate" ]] || { echo CF_ACT_ARM_GATE=already-present >&2; exit 20; }
[[ -L "$active" && -d "$candidate" && -s "$control" ]] || exit 20
systemctl stop "$timer"
if systemctl is-active --quiet "$service"; then
  systemctl stop "$service"
fi
exec 9>"$lock"
flock -w 30 9 || { echo CF_ACT_ARM_LOCK=busy >&2; exit 21; }

python3 - "$active/manifest.json" "$candidate/manifest.json" "$control" <<'PY'
import json,sys
a=json.load(open(sys.argv[1])); c=json.load(open(sys.argv[2])); r=json.load(open(sys.argv[3]))
assert a["sequence"]==63 and a["release_id"]=="onshape-vps-hardened-rollback-r1"
assert c["sequence"]==66 and c["release_id"]=="onshape-vps-hardened-production-r3"
auth=r["authority"]
assert r["controlRevision"]==530 and auth["productionEpoch"]==2
assert auth["mode"]=="QUIESCED_RECONCILING" and auth["materialAuthority"] is None
assert auth["planes"]["android-v1"]["ingress"]=="CLOSED" and auth["planes"]["android-v1"]["materialEffectsAllowed"] is False
assert auth["planes"]["vps-fabric"]["ingress"]=="CLOSED" and auth["planes"]["vps-fabric"]["materialEffectsAllowed"] is False
assert r["lease"]["state"]=="FREE"
print("CF_ACT_ARM_AUTHORITY=quiesced-epoch2")
print("CF_ACT_ARM_ACTIVE=seq63")
print("CF_ACT_ARM_CANDIDATE=seq66")
PY
[[ "$(sha256sum "$candidate/manifest.json" | awk '{print $1}')" == "$expected_sha" ]] || exit 22
printf '%s\n' 'SEQ66_ACTIVATION_IN_PROGRESS_EPOCH2_QUIESCED' >"$gate"
chmod 0600 "$gate"
chown root:root "$gate"
sync
echo CF_ACT_ARM_TIMER=stopped
echo CF_ACT_ARM_RELEASE_GATE=set
echo CF_ACT_ARM_POINTER=unchanged-seq63
echo CF_ACT_ARM=pass
