#!/usr/bin/env bash
set -euo pipefail
umask 077
[[ "$(id -u)" -eq 0 ]] || exit 2

ACTIVE=/opt/capability-fabric/current
PREVIOUS=/opt/capability-fabric/previous
STATE=/var/lib/capability-fabric/state
CONTROL=/var/lib/capability-fabric/onshape/runtime-control/ONSHAPE_RUNTIME_CONTROL.json
GATE="$STATE/release-in-progress"
TIMER=capability-fabric-pull.timer
SERVICE=capability-fabric-pull.service
PULL=/usr/local/libexec/capability-fabric-pull-agent
GATEWAY=capability-fabric-onshape-gateway
SERVER=capability-fabric-onshape-server
STANDBY=/var/lib/capability-fabric/onshape/browser-profile-standby
EXCLUDE=/etc/capability-fabric/backup.exclude
EXPECTED_MANIFEST=50c7a75af1c575ad31c7b2d0054cf1ecf7fabd494c42c98e5eb32ab6e9ec603e
EXPECTED_CONTROL_BLOB=4f33988ab09f4334960b3a6c346957774822ad9d

ensure_closed() {
  local tmp="$GATE.tmp.r10-activate.$$"
  printf '%s\n' RELEASE_IN_PROGRESS >"$tmp"
  chmod 0600 "$tmp"; chown root:root "$tmp"; mv -f "$tmp" "$GATE"
  docker stop "$GATEWAY" >/dev/null 2>&1 || true
  systemctl stop "$TIMER" >/dev/null 2>&1 || true
}
recover_pre_pull() {
  ensure_closed
  if [[ "$(basename "$(readlink -f "$ACTIVE" 2>/dev/null || true)")" == "onshape-vps-hardened-r9" ]]; then
    docker start "$SERVER" >/dev/null 2>&1 || true
  fi
}
trap recover_pre_pull ERR

[[ "$(basename "$(readlink -f "$ACTIVE")")" == "onshape-vps-hardened-r9" ]]
[[ "$(cat "$STATE/last-good-sequence")" == "74" ]]
[[ "$(cat "$STATE/last-good-release")" == "onshape-vps-hardened-r9" ]]
[[ ! -s "$STATE/last-failed-commit" ]]
[[ -f "$GATE" ]] && grep -Fxq RELEASE_IN_PROGRESS "$GATE"
! systemctl is-active --quiet "$TIMER"
! systemctl is-active --quiet "$SERVICE"
[[ "$(docker inspect -f '{{.State.Running}}' "$GATEWAY")" == false ]]
[[ "$(git hash-object "$CONTROL")" == "$EXPECTED_CONTROL_BLOB" ]]

python3 - "$CONTROL" <<'PY'
import json,sys
d=json.load(open(sys.argv[1])); a=d["authority"]; v=a["planes"]["vps-fabric"]; g=a["productionGuard"]
assert d["controlRevision"]==559 and a["productionEpoch"]==30
assert a["mode"]=="QUIESCED_RECONCILING" and a["materialAuthority"] is None
assert v["ingress"]=="CLOSED" and v["materialEffectsAllowed"] is False
assert v["releaseSequence"]==75 and v["releaseId"]=="onshape-vps-hardened-r10"
assert v["manifestSha256"]=="50c7a75af1c575ad31c7b2d0054cf1ecf7fabd494c42c98e5eb32ab6e9ec603e"
assert d["lease"]["state"]=="FREE" and a["reconciliationHold"]["active"] is False
assert g["killSwitch"]=="ENGAGED" and g["allowedDocumentIds"]==[]
assert g["mutationBudget"]["maxMutations"]==0
print("CF_R10_ACTIVATE_AUTHORITY=epoch30-quiesced")
PY

if [[ ! -e "$STANDBY" ]]; then
  stage="$(mktemp -d /var/lib/capability-fabric/onshape/.r10-standby.XXXXXX)"
  docker stop -t 30 "$SERVER" >/dev/null
  docker cp "$SERVER:/tmp/onshape-session-pool/session-2/." "$stage/"
  find "$stage" -xdev -mindepth 1 -print -quit|grep -q .
  find "$stage" -xdev -type l -name 'Singleton*' -exec unlink {} \;
  chown -R root:root "$stage"
  find "$stage" -xdev -type d -exec chmod 0700 {} +
  find "$stage" -xdev -type f -exec chmod 0600 {} +
  mv "$stage" "$STANDBY"
fi
find "$STANDBY" -xdev -mindepth 1 -print -quit|grep -q .
[[ "$(stat -c '%a %U:%G' "$STANDBY")" == "700 root:root" ]]

if ! grep -Fxq "$STANDBY" "$EXCLUDE"; then
  exclude_tmp="$EXCLUDE.tmp.r10.$$"
  cp "$EXCLUDE" "$exclude_tmp"
  printf '%s\n' "$STANDBY" >>"$exclude_tmp"
  chmod 0600 "$exclude_tmp"; chown root:root "$exclude_tmp"; mv -f "$exclude_tmp" "$EXCLUDE"
fi
grep -Fxq "$STANDBY" "$EXCLUDE"

out="$("$PULL" pull)"
printf '%s\n' "$out"
printf '%s\n' "$out"|grep -Fxq 'CF_PULL_APPLY=success'

ensure_closed
for _ in $(seq 1 30); do systemctl is-active --quiet "$SERVICE" || break; sleep 1; done
! systemctl is-active --quiet "$SERVICE"
[[ "$(basename "$(readlink -f "$ACTIVE")")" == "onshape-vps-hardened-r10" ]]
[[ "$(basename "$(readlink -f "$PREVIOUS")")" == "onshape-vps-hardened-r9" ]]
[[ "$(cat "$STATE/last-good-sequence")" == "75" ]]
[[ "$(cat "$STATE/last-good-release")" == "onshape-vps-hardened-r10" ]]
[[ ! -s "$STATE/last-failed-commit" ]]
[[ "$(sha256sum "$(readlink -f "$ACTIVE")/manifest.json"|awk '{print $1}')" == "$EXPECTED_MANIFEST" ]]
[[ "$(git hash-object "$CONTROL")" == "$EXPECTED_CONTROL_BLOB" ]]
[[ "$(docker inspect -f '{{.State.Running}}' "$SERVER")" == true ]]
[[ "$(docker inspect -f '{{.State.Health.Status}}' "$SERVER")" == healthy ]]
[[ "$(docker inspect -f '{{.State.Running}}' "$GATEWAY")" == false ]]

# The release gate blocks backend tools. Remove it only while the public gateway
# remains stopped and epoch30 has no material authority.
rm -f "$GATE"
trap ensure_closed EXIT
result="$(docker exec -i "$SERVER" sh -lc 'cd /tmp/app && node --input-type=module' < server-bootstrap/helpers/319-onshape-session-pool-r10-live-qualification.mjs|tail -n1)"
python3 - "$result" <<'PY'
import json,sys
r=json.loads(sys.argv[1])
assert r["ok"] is True and r["build_id"]=="onshape-vps-hardened-r10"
assert r["topology"]=="ACTIVE_HOT_STANDBY" and r["proven_sessions"]==2
assert r["documented_reads"]==200 and r["dispatch_delta"]==200
assert r["minimum_interval_ms"]==1000 and r["maximum_observed_concurrency"]==1
assert r["burst_elapsed_ms"]>=198000
assert r["isolated_ui_pages"]==3 and r["final_ui_lease_count"]==0
print("CF_R10_ACTIVATE_LIVE_QUALIFICATION="+json.dumps(r,separators=(",",":"),sort_keys=True))
PY

PYTHONPATH="$(readlink -f "$ACTIVE")/fabric-src" python3 - <<'PY'
from capability_fabric.persistence import SqliteExecutionStateStore
with SqliteExecutionStateStore("/var/lib/capability-fabric/onshape/fabric-state/execution.sqlite3") as state:
    assert not state.recoverable()
print("CF_R10_ACTIVATE_RECOVERABLE=zero")
PY

ensure_closed
trap - EXIT
trap - ERR
[[ -f "$GATE" ]] && grep -Fxq RELEASE_IN_PROGRESS "$GATE"
[[ "$(docker inspect -f '{{.State.Running}}' "$GATEWAY")" == false ]]
! systemctl is-active --quiet "$TIMER"
echo CF_R10_ACTIVATE_ACTIVE=seq75-r10
echo CF_R10_ACTIVATE_PREVIOUS=seq74-r9
echo CF_R10_ACTIVATE=pass
