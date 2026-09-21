#!/usr/bin/env bash
set -euo pipefail
umask 077
[[ "$(id -u)" -eq 0 ]] || exit 2

GUARD_SRC=server-bootstrap/pull-agent/runtime_control_guard.py
TEST_SRC=server-bootstrap/pull-agent/test_runtime_control_guard.py
LIVE_GUARD=/usr/local/libexec/capability-fabric-runtime-control-guard
PULL_AGENT=/usr/local/libexec/capability-fabric-pull-agent
ACTIVE=/opt/capability-fabric/current
PREVIOUS=/opt/capability-fabric/previous
STATE=/var/lib/capability-fabric/state
GATE="$STATE/release-in-progress"
LOCK=/run/lock/capability-fabric-pull.lock
TIMER=capability-fabric-pull.timer
GATEWAY=capability-fabric-onshape-gateway
CONTROL=/var/lib/capability-fabric/onshape/runtime-control/ONSHAPE_RUNTIME_CONTROL.json
MIRROR_BLOB=/var/lib/capability-fabric/onshape/runtime-control/git-blob-sha
MIRROR_COMMIT=/var/lib/capability-fabric/onshape/runtime-control/source-commit

before_blob=3b7b05f78c89d7fed2f8bb964cda42347924a329
after_blob=56fa3abbcfffaa7451f32a0707a569f865ab49bb
expected_active=/var/lib/capability-fabric/releases/onshape-vps-hardened-production-r4

[[ -s "$GUARD_SRC" && -s "$TEST_SRC" && -x "$PULL_AGENT" && -s "$LIVE_GUARD" ]] || exit 20
[[ -L "$ACTIVE" && "$(readlink -f "$ACTIVE")" == "$expected_active" ]] || exit 20
[[ -f "$GATE" ]] || exit 20
grep -Fxq RELEASE_IN_PROGRESS "$GATE"
if systemctl is-active --quiet "$TIMER"; then exit 20; fi
[[ "$(docker inspect -f '{{.State.Running}}' "$GATEWAY")" == false ]]
[[ "$(git hash-object "$CONTROL")" == "$before_blob" ]]
[[ "$(tr -d '\r\n' < "$MIRROR_BLOB")" == "$before_blob" ]]

python3 "$TEST_SRC" "$GUARD_SRC" >/tmp/cf-guard-policy-tests.$$
trap 'rm -f /tmp/cf-guard-policy-tests.$$' EXIT
grep -Fxq CF_AUTH_GUARD_TEST_POLICY_CHANGE_SAME_EPOCH_REJECT=pass /tmp/cf-guard-policy-tests.$$
grep -Fxq CF_AUTH_GUARD_TEST_POLICY_CHANGE_NEW_EPOCH=pass /tmp/cf-guard-policy-tests.$$
grep -Fxq CF_AUTH_GUARD_TEST=pass /tmp/cf-guard-policy-tests.$$
echo CF_GUARD_REPAIR_TESTS=pass

python3 - "$CONTROL" <<'PY'
import json,sys
x=json.load(open(sys.argv[1])); a=x["authority"]; g=a["productionGuard"]
assert x["controlRevision"]==534
assert a["productionEpoch"]==5 and a["mode"]=="VPS_PRODUCTION" and a["materialAuthority"]=="vps-fabric"
assert a["planes"]["android-v1"]["materialEffectsAllowed"] is False
assert a["planes"]["vps-fabric"]["materialEffectsAllowed"] is True
assert g["generation"]==1 and g["killSwitch"]=="ENGAGED"
assert g["allowedDocumentIds"]==[]
assert g["mutationBudget"]["maxMutations"]==0
print("CF_GUARD_REPAIR_HOST_BEFORE=rev534-epoch5-closed")
PY

exec 9>"$LOCK"
flock -w 30 9 || exit 21

work="$(mktemp -d /var/lib/capability-fabric/.guard-repair.XXXXXX)"
cleanup(){
  rc=$?
  set +e
  rm -rf "$work"
  rm -f /tmp/cf-guard-policy-tests.$$
  exit "$rc"
}
trap cleanup EXIT

cp -a "$LIVE_GUARD" "$work/live-guard.before"
cp -a "$CONTROL" "$work/control.before"
cp -a "$MIRROR_BLOB" "$work/blob.before"
cp -a "$MIRROR_COMMIT" "$work/commit.before"
active_before="$(readlink -f "$ACTIVE")"
previous_before="$(readlink -f "$PREVIOUS" 2>/dev/null || true)"

candidate="$work/guard.candidate"
install -m 0750 -o root -g root "$GUARD_SRC" "$candidate"
python3 "$candidate" "$CONTROL" "$CONTROL" | grep -Fxq CF_AUTH_GUARD_IDENTICAL=pass

install -m 0750 -o root -g root "$candidate" "$LIVE_GUARD"
installed_sha="$(sha256sum "$LIVE_GUARD" | awk '{print $1}')"
candidate_sha="$(sha256sum "$GUARD_SRC" | awk '{print $1}')"
[[ "$installed_sha" == "$candidate_sha" ]] || exit 22
echo CF_GUARD_REPAIR_INSTALL=pass
echo "CF_GUARD_REPAIR_SHA256=$installed_sha"

# Release the pull lock before calling the pull agent; timer remains stopped and
# release gate/gateway remain fail-closed, so this is the only pull caller.
flock -u 9
exec 9>&-

set +e
pull_output="$("$PULL_AGENT" pull 2>&1)"
pull_rc=$?
set -e
printf '%s\n' "$pull_output"
if [[ "$pull_rc" -ne 0 ]]; then
  install -m 0750 -o root -g root "$work/live-guard.before" "$LIVE_GUARD"
  install -m 0640 -o root -g root "$work/control.before" "$CONTROL"
  install -m 0600 -o root -g root "$work/blob.before" "$MIRROR_BLOB"
  install -m 0600 -o root -g root "$work/commit.before" "$MIRROR_COMMIT"
  echo CF_GUARD_REPAIR_ROLLBACK=performed
  exit 23
fi

[[ "$(git hash-object "$CONTROL")" == "$after_blob" ]] || {
  install -m 0750 -o root -g root "$work/live-guard.before" "$LIVE_GUARD"
  install -m 0640 -o root -g root "$work/control.before" "$CONTROL"
  install -m 0600 -o root -g root "$work/blob.before" "$MIRROR_BLOB"
  install -m 0600 -o root -g root "$work/commit.before" "$MIRROR_COMMIT"
  echo CF_GUARD_REPAIR_ROLLBACK=performed
  exit 24
}
[[ "$(tr -d '\r\n' < "$MIRROR_BLOB")" == "$after_blob" ]] || exit 24
[[ "$(readlink -f "$ACTIVE")" == "$active_before" ]] || exit 24
[[ "$(readlink -f "$PREVIOUS" 2>/dev/null || true)" == "$previous_before" ]] || exit 24
[[ -f "$GATE" ]] || exit 24
if systemctl is-active --quiet "$TIMER"; then exit 24; fi
[[ "$(docker inspect -f '{{.State.Running}}' "$GATEWAY")" == false ]]

python3 - "$CONTROL" <<'PY'
import json,sys
x=json.load(open(sys.argv[1])); a=x["authority"]; g=a["productionGuard"]
assert x["controlRevision"]==535
assert a["productionEpoch"]==6 and a["mode"]=="VPS_PRODUCTION" and a["materialAuthority"]=="vps-fabric"
assert a["planes"]["android-v1"]["ingress"]=="CLOSED" and a["planes"]["android-v1"]["materialEffectsAllowed"] is False
assert a["planes"]["vps-fabric"]["ingress"]=="ADMITTED" and a["planes"]["vps-fabric"]["materialEffectsAllowed"] is True
assert a["planes"]["vps-fabric"]["releaseSequence"]==67
assert g["generation"]==2 and g["killSwitch"]=="OPEN"
assert g["allowedDocumentIds"]==["881affea8ea63c33ae4e6c78"]
assert g["mutationBudget"]=={"budgetId":"epoch6-test-881affea-budget2","maxMutations":2}
print("CF_GUARD_REPAIR_HOST_AFTER=rev535-epoch6-open-budget2")
PY
python3 "$LIVE_GUARD" "$work/control.before" "$CONTROL" | grep -Fxq CF_AUTH_GUARD_TRANSITION=pass

echo CF_GUARD_REPAIR_ACTIVE_UNCHANGED=seq67
echo CF_GUARD_REPAIR_GATE=active
echo CF_GUARD_REPAIR_TIMER=stopped
echo CF_GUARD_REPAIR_GATEWAY=stopped
echo CF_GUARD_REPAIR_MIRROR=epoch6-proven
echo CF_GUARD_REPAIR=pass
