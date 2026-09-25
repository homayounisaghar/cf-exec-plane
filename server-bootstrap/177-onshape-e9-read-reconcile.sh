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
EXPECTED_CONTROL=79ea04caa91462d85021ae46392b636b217a6cc8

INV=invocation:e85f57ec-b244-4bb2-8557-2497b5856216
OP=operation:02d18a16-78fd-40af-8bd6-981fe5a8d029
ATT=attempt:979ada7e-7d0f-4f41-bd2b-14bf95e6723d

[[ "$(git hash-object "$CONTROL")" == "$EXPECTED_CONTROL" ]] || exit 20
[[ ! -e "$GATE" ]] || exit 20
systemctl is-active --quiet "$TIMER"
if systemctl is-active --quiet "$SERVICE"; then exit 20; fi
[[ "$(docker inspect -f '{{.State.Running}}' "$GATEWAY")" == true ]]

python3 - "$DB" "$INV" "$OP" "$ATT" <<'PY'
import json,sqlite3,sys
db,inv,op,att=sys.argv[1:]
c=sqlite3.connect(f"file:{db}?mode=ro",uri=True); c.row_factory=sqlite3.Row
r=c.execute("""
SELECT i.phase,i.payload AS ip,i.dispatch_payload,o.state os,o.outcome_payload,
       a.state ats,a.payload AS ap,a.observation_payload
FROM invocations i JOIN operations o ON o.invocation_id=i.invocation_id
JOIN attempts a ON a.operation_id=o.operation_id
WHERE i.invocation_id=? AND o.operation_id=? AND a.attempt_id=?
""",(inv,op,att)).fetchone()
assert r is not None
ip=json.loads(r["ip"]); dp=json.loads(r["dispatch_payload"]); obs=json.loads(r["observation_payload"])
assert ip["effect"]=="onshape.documented.operation.read"
assert dp["execution_payload"]["agentEffect"]=="READ_ONLY"
assert dp["execution_payload"]["args"]["operationId"]=="getPartStudioFeatures"
assert r["phase"]=="OBSERVED" and r["os"]=="IN_FLIGHT" and r["ats"]=="OBSERVED"
assert r["outcome_payload"] is None
assert obs["ack_state"]=="UNKNOWN"
assert "TimeoutError" in str(obs.get("detail") or "")
assert (obs.get("evidence") or {}).get("transportUncertain") is True
print("CF_E9_READ_RECOVERY_PRE=verified-readonly-timeout")
c.close()
PY

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
if systemctl is-active --quiet "$TIMER"; then exit 30; fi
tmp="$GATE.tmp.$$"; printf '%s\n' RELEASE_IN_PROGRESS >"$tmp"; chmod 0600 "$tmp"; chown root:root "$tmp"; mv -f "$tmp" "$GATE"
docker stop "$GATEWAY" >/dev/null
[[ "$(docker inspect -f '{{.State.Running}}' "$GATEWAY")" == false ]]

PYTHONPATH="$ACTIVE/fabric-src" python3 - "$DB" "$OP" "$ATT" <<'PY'
import sys
from capability_fabric.domain import Outcome,OutcomeState,RecoveryDisposition
from capability_fabric.persistence import SqliteExecutionStateStore
db,op,att=sys.argv[1:]
with SqliteExecutionStateStore(db) as state:
    matches=[c for c in state.recoverable() if c.operation and c.attempt and c.operation.operation_id==op and c.attempt.attempt_id==att]
    assert len(matches)==1,len(matches)
    case=matches[0]
    assert case.disposition is RecoveryDisposition.RECONCILIATION_PENDING,case.disposition
    assert case.operation.effect=="onshape.documented.operation.read"
    assert case.dispatch.execution_payload["agentEffect"]=="READ_ONLY"
    state.record_outcome(case.operation,Outcome(
      operation_id=op,
      state=OutcomeState.FAILED,
      basis="read-only getPartStudioFeatures transport timed out; no material effect is possible and no replay was performed",
    ))
    state.append("e9.read_timeout.reconciled",op,{
      "attempt_id":att,
      "effect":"READ_ONLY",
      "reexecuted":False,
      "classification":"TERMINAL_READ_FAILURE_NO_EFFECT",
    })
print("CF_E9_READ_RECOVERY_OUTCOME=FAILED")
print("CF_E9_READ_RECOVERY_REEXECUTED=false")
print("CF_E9_READ_RECOVERY_EFFECT=READ_ONLY")
PY

python3 - "$DB" "$INV" "$OP" "$ATT" <<'PY'
import json,sqlite3,sys
db,inv,op,att=sys.argv[1:]
c=sqlite3.connect(f"file:{db}?mode=ro",uri=True); c.row_factory=sqlite3.Row
r=c.execute("""
SELECT i.phase,o.state os,o.outcome_payload,a.state ats
FROM invocations i JOIN operations o ON o.invocation_id=i.invocation_id
JOIN attempts a ON a.operation_id=o.operation_id
WHERE i.invocation_id=? AND o.operation_id=? AND a.attempt_id=?
""",(inv,op,att)).fetchone()
assert r is not None
out=json.loads(r["outcome_payload"])
assert r["phase"]=="RECONCILED" and r["os"]=="FAILED" and r["ats"]=="OBSERVED"
assert out["state"]=="FAILED"
assert "read-only" in out["basis"]
print("CF_E9_READ_RECOVERY_DURABLE=terminal")
c.close()
PY

ponr="$("$ROLLBACK_GUARD" decide --db "$DB" --control "$CONTROL" --quarantine "$QUARANTINE")"
printf '%s\n' "$ponr"
printf '%s\n' "$ponr" | grep -Fxq 'CF_A4_PONR_COUNT=4'
printf '%s\n' "$ponr" | grep -Fxq 'CF_A4_UNRESOLVED_BLOCKING=0'
printf '%s\n' "$ponr" | grep -Fxq 'CF_A4_ZERO_UNRESOLVED=pass'

rm -f "$GATE"
systemctl start "$TIMER"; systemctl is-active --quiet "$TIMER"
docker start "$GATEWAY" >/dev/null
[[ "$(docker inspect -f '{{.State.Running}}' "$GATEWAY")" == true ]]
armed=yes
trap - EXIT
echo CF_E9_READ_RECOVERY_GATE=clear
echo CF_E9_READ_RECOVERY=pass
