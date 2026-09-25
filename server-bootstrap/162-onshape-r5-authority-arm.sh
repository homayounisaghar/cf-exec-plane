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
GATEWAY=capability-fabric-onshape-gateway
SERVER=capability-fabric-onshape-server
FABRIC=capability-fabric-onshape-fabric
DB=/var/lib/capability-fabric/onshape/fabric-state/execution.sqlite3
QUARANTINE=/var/lib/capability-fabric/onshape/fabric-state/quarantine/D-018-attempt-f6d80f46.json
ROLLBACK_GUARD=/usr/local/libexec/capability-fabric-onshape-rollback-contract

EXPECTED_CONTROL=6ac33244f7968c142e30b2f815d090f74dac49f3
EXPECTED_MANIFEST=01f31143e3574c02d430a6b4f67a9be3ef24590a39f4e27459131da4beece057

active="$(readlink -f "$ACTIVE")"
[[ "$(basename "$active")" == "onshape-vps-hardened-production-r5" ]] || { echo CF_R5_AUTH_ARM_ACTIVE=mismatch >&2; exit 20; }
[[ "$(cat "$STATE/last-good-sequence")" == "70" ]] || { echo CF_R5_AUTH_ARM_SEQUENCE=mismatch >&2; exit 20; }
[[ "$(cat "$STATE/last-good-release")" == "onshape-vps-hardened-production-r5" ]] || { echo CF_R5_AUTH_ARM_LAST_GOOD=mismatch >&2; exit 20; }
[[ ! -s "$STATE/last-failed-commit" ]] || { echo CF_R5_AUTH_ARM_LAST_FAILED=present >&2; exit 20; }
[[ "$(sha256sum "$active/manifest.json" | awk '{print $1}')" == "$EXPECTED_MANIFEST" ]] || { echo CF_R5_AUTH_ARM_MANIFEST=mismatch >&2; exit 20; }
[[ "$(git hash-object "$CONTROL")" == "$EXPECTED_CONTROL" ]] || { echo CF_R5_AUTH_ARM_CONTROL=mismatch >&2; exit 20; }
[[ "$(tr -d '\r\n' < "$MIRROR_BLOB")" == "$EXPECTED_CONTROL" ]] || { echo CF_R5_AUTH_ARM_MIRROR=mismatch >&2; exit 20; }
[[ ! -e "$GATE" ]] || { echo CF_R5_AUTH_ARM_GATE=already-present >&2; exit 20; }
systemctl is-active --quiet "$TIMER" || { echo CF_R5_AUTH_ARM_TIMER=not-active >&2; exit 20; }
if systemctl is-active --quiet "$SERVICE"; then echo CF_R5_AUTH_ARM_PULL_SERVICE=busy >&2; exit 20; fi
[[ "$(docker inspect -f '{{.State.Running}}' "$GATEWAY")" == true ]] || { echo CF_R5_AUTH_ARM_GATEWAY=not-running >&2; exit 20; }
[[ "$(docker inspect -f '{{.State.Running}}' "$SERVER")" == true ]] || exit 20
[[ "$(docker inspect -f '{{.State.Running}}' "$FABRIC")" == true ]] || exit 20

python3 - "$CONTROL" <<'PY'
import json,sys
x=json.load(open(sys.argv[1])); a=x["authority"]; g=a["productionGuard"]; v=a["planes"]["vps-fabric"]; d=a["planes"]["android-v1"]
assert x["controlRevision"]==540
assert a["productionEpoch"]==11 and a["mode"]=="VPS_PRODUCTION" and a["materialAuthority"]=="vps-fabric"
assert d["ingress"]=="CLOSED" and d["materialEffectsAllowed"] is False
assert v["ingress"]=="ADMITTED" and v["materialEffectsAllowed"] is True
assert v["releaseSequence"]==67 and v["releaseId"]=="onshape-vps-hardened-production-r4"
assert v["manifestSha256"]=="f2631a7f94ec5f6e5af5e9d3b3211cf440354eef0b55ff6fee7ab65cec50bfb9"
assert a["reconciliationHold"]["active"] is False
assert x["lease"]["state"]=="FREE"
assert g["generation"]==3 and g["killSwitch"]=="ENGAGED"
assert g["allowedDocumentIds"]==[] and g["mutationBudget"]["maxMutations"]==0
assert x["routing"]["state"]=="CLOSED" and x["routing"]["materialCommandsAllowed"] is False
print("CF_R5_AUTH_ARM_AUTHORITY_PRE=epoch11-seq67-r4")
print("CF_R5_AUTH_ARM_GUARD=engaged-empty-zero")
print("CF_R5_AUTH_ARM_LEASE=FREE")
PY

ponr="$("$ROLLBACK_GUARD" decide --db "$DB" --control "$CONTROL" --quarantine "$QUARANTINE")"
printf '%s\n' "$ponr"
printf '%s\n' "$ponr" | grep -Fxq 'CF_A4_PONR=true'
printf '%s\n' "$ponr" | grep -Fxq 'CF_A4_PONR_COUNT=4'
printf '%s\n' "$ponr" | grep -Fxq 'CF_A4_UNRESOLVED_BLOCKING=0'
printf '%s\n' "$ponr" | grep -Fxq 'CF_A4_ZERO_UNRESOLVED=pass'
echo CF_R5_AUTH_ARM_SAFETY_PRE=pass

armed=no
cleanup(){
  rc=$?
  set +e
  if [[ "$armed" != yes ]]; then
    rm -f "$GATE" >/dev/null 2>&1 || true
    docker start "$GATEWAY" >/dev/null 2>&1 || true
    systemctl start "$TIMER" >/dev/null 2>&1 || true
  fi
  exit "$rc"
}
trap cleanup EXIT

systemctl stop "$TIMER"
if systemctl is-active --quiet "$TIMER"; then echo CF_R5_AUTH_ARM_TIMER=still-active >&2; exit 30; fi
if systemctl is-active --quiet "$SERVICE"; then echo CF_R5_AUTH_ARM_PULL_SERVICE=became-active >&2; exit 30; fi

tmp="$GATE.tmp.$$"
printf '%s\n' RELEASE_IN_PROGRESS >"$tmp"
chmod 0600 "$tmp"
chown root:root "$tmp"
mv -f "$tmp" "$GATE"
docker stop "$GATEWAY" >/dev/null

[[ "$(docker inspect -f '{{.State.Running}}' "$GATEWAY")" == false ]]
[[ "$(basename "$(readlink -f "$ACTIVE")")" == "onshape-vps-hardened-production-r5" ]]
[[ "$(git hash-object "$CONTROL")" == "$EXPECTED_CONTROL" ]]

armed=yes
trap - EXIT
echo CF_R5_AUTH_ARM_ACTIVE=seq70-r5
echo CF_R5_AUTH_ARM_PULL_TIMER=stopped
echo CF_R5_AUTH_ARM_RELEASE_GATE=active
echo CF_R5_AUTH_ARM_GATEWAY=stopped
echo CF_R5_AUTH_ARM=pass
