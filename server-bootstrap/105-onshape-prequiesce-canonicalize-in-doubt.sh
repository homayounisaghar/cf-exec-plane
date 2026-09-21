#!/usr/bin/env bash
set -euo pipefail
umask 077

[[ "$(id -u)" -eq 0 ]] || { echo "CF_PREQUIESCE_INDOUBT_REQUIRES_ROOT" >&2; exit 2; }
current="$(readlink -f /opt/capability-fabric/current)"
[[ "$current" == /var/lib/capability-fabric/releases/* ]] || exit 20

control=/var/lib/capability-fabric/onshape/runtime-control/ONSHAPE_RUNTIME_CONTROL.json
python3 - "$control" <<'PY'
import json,sys
r=json.load(open(sys.argv[1]))
a=r["authority"]
assert r["controlRevision"] == 529
assert r["lease"]["state"] == "FREE"
assert a["productionEpoch"] == 1
assert a["mode"] == "ANDROID_PRODUCTION"
assert a["materialAuthority"] == "android-v1"
assert a["planes"]["vps-fabric"]["materialEffectsAllowed"] is False
print("CF_INDOUBT_AUTHORITY=android-epoch1")
print("CF_INDOUBT_LEASE=FREE")
PY

db=/var/lib/capability-fabric/onshape/fabric-state/execution.sqlite3
PYTHONPATH="$current/fabric-src" python3 - "$db" <<'PY'
import sys
from capability_fabric.domain import AckState
from capability_fabric.persistence import SqliteExecutionStateStore

db=sys.argv[1]
attempt_id="attempt:f6d80f46-b4ff-4798-9848-9b0b28bca1b8"
operation_id="operation:3cbb9823-a285-4d55-9cdc-cf57a2cb0cd2"
invocation_id="invocation:9e14dc26-50bc-4b3d-a265-171f96b9231d"

with SqliteExecutionStateStore(db) as state:
    matches=[c for c in state.recoverable() if c.attempt is not None and c.attempt.attempt_id==attempt_id]
    assert len(matches)==1, len(matches)
    case=matches[0]
    assert case.operation is not None and case.attempt is not None and case.observation is not None
    assert case.invocation.invocation_id==invocation_id
    assert case.operation.operation_id==operation_id
    assert case.operation.effect=="onshape.ui.input.sequence.mutation_risk"
    assert case.observation.ack_state is AckState.UNKNOWN
    assert "TimeoutError" in str(case.observation.detail or "")
    ev=dict(case.observation.evidence)
    assert ev.get("sequenceCompleted") is False
    assert ev.get("completedSteps") is None
    assert ev.get("effectSent") is None
    payload=dict(case.dispatch.execution_payload)
    args=dict(payload.get("args") or {})
    steps=args.get("steps")
    assert isinstance(steps,list) and [s.get("action") for s in steps]==["locator.fill","locator.press","locator.fill","locator.press"]
    state.mark_dispatch_uncertain(
        case.operation,
        case.attempt,
        diagnostic="TimeoutError with unknown completedSteps/effectSent after a four-step locator sequence; same Attempt must remain unresolved and must not be replayed",
    )
    state.append(
        "operation.in_doubt.canonicalized",
        operation_id,
        {"attempt_id":attempt_id,"same_attempt":True,"reexecuted":False,"reason":"partial UI-input sequence cannot be proven absent or achieved"},
    )
print("CF_INDOUBT_ATTEMPT="+attempt_id)
print("CF_INDOUBT_OPERATION="+operation_id)
print("CF_INDOUBT_STATE=IN_DOUBT")
print("CF_INDOUBT_REEXECUTED=false")
PY

echo CF_PREQUIESCE_INDOUBT_CANONICALIZE=pass
