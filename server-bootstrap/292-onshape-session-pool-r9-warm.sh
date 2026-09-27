#!/usr/bin/env bash
set -euo pipefail
umask 077
STATE=/var/lib/capability-fabric/state
CONTROL=/var/lib/capability-fabric/onshape/runtime-control/ONSHAPE_RUNTIME_CONTROL.json
GATE="$STATE/release-in-progress"
TIMER=capability-fabric-pull.timer
SERVICE=capability-fabric-pull.service
GATEWAY=capability-fabric-onshape-gateway
SERVER=capability-fabric-onshape-server
FIXTURE=a19e0fa5152af9f7ce106b6e:e5e7d0173fd1f1d0307a2cb6:e0929361aadb6135b5cecffa

ensure_closed() {
  local tmp="$GATE.tmp.r9-warm.$$"
  printf '%s\n' RELEASE_IN_PROGRESS >"$tmp"
  chmod 0600 "$tmp"; chown root:root "$tmp"; mv -f "$tmp" "$GATE"
  docker stop "$GATEWAY" >/dev/null 2>&1 || true
  systemctl stop "$TIMER" >/dev/null 2>&1 || true
}
trap ensure_closed EXIT
ensure_closed
for _ in $(seq 1 30); do systemctl is-active --quiet "$SERVICE" || break; sleep 1; done
! systemctl is-active --quiet "$SERVICE"

python3 - "$CONTROL" <<'PY'
import json,sys
d=json.load(open(sys.argv[1])); a=d["authority"]; v=a["planes"]["vps-fabric"]; g=a["productionGuard"]
assert d["controlRevision"]==557 and a["productionEpoch"]==28
assert a["mode"]=="QUIESCED_RECONCILING" and a["materialAuthority"] is None
assert v["ingress"]=="CLOSED" and v["materialEffectsAllowed"] is False
assert v["releaseSequence"]==74 and v["releaseId"]=="onshape-vps-hardened-r9"
assert d["lease"]["state"]=="FREE" and a["reconciliationHold"]["active"] is False
assert g["killSwitch"]=="ENGAGED" and g["allowedDocumentIds"]==[] and g["mutationBudget"]["maxMutations"]==0
print("CF_R9_WARM_AUTHORITY=quiesced")
PY

[[ "$(basename "$(readlink -f /opt/capability-fabric/current)")" == "onshape-vps-hardened-r9" ]]
[[ "$(docker inspect -f '{{.State.Running}}' "$SERVER")" == true ]]
[[ "$(docker inspect -f '{{.State.Health.Status}}' "$SERVER")" == healthy ]]
[[ "$(docker inspect -f '{{.State.Running}}' "$GATEWAY")" == false ]]

# Release gate blocks all backend tools, so remove it only while the public gateway stays stopped and authority is CLOSED.
rm -f "$GATE"

set +e
bash server-bootstrap/281-onshape-production-cohort-recover.sh
rc=$?
set -e
if (( rc == 42 )); then
  echo CF_R9_WARM_INPUT_REQUIRED=EMAIL_VERIFICATION_CODE
  exit 42
fi
(( rc == 0 ))

result="$(docker exec -e CF_FIXTURE="$FIXTURE" -i "$SERVER" sh -lc 'cd /tmp/app && node --input-type=module' < server-bootstrap/helpers/292-onshape-session-pool-production-semantic-client.mjs | tail -n 1)"
python3 - "$result" <<'PY'
import json,sys
r=json.loads(sys.argv[1])
assert r["ok"] is True and r["build_id"]=="onshape-vps-hardened-r9"
assert r["semantic_contexts"]==5 and r["physical_slots_distinct"]==5
assert r["documented_reads"]==25 and r["post_auth_proven"]==5
assert r["fingerprints_distinct"] is True and r["final_workflow_lease_count"]==0 and r["final_active_count"]==0
assert r["navigation_limit"]==2 and r["physical_slot_redaction"] is True
print("CF_R9_WARM_SEMANTIC_RESULT="+json.dumps(r,separators=(",",":"),sort_keys=True))
PY

ensure_closed
trap - EXIT
[[ -f "$GATE" ]] && grep -Fxq RELEASE_IN_PROGRESS "$GATE"
[[ "$(docker inspect -f '{{.State.Running}}' "$GATEWAY")" == false ]]
! systemctl is-active --quiet "$TIMER"
echo CF_R9_WARM=pass
