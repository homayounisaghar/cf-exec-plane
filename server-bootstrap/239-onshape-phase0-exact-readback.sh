#!/usr/bin/env bash
set -euo pipefail
[[ "$(id -u)" -eq 0 ]] || exit 2
db=/var/lib/capability-fabric/onshape-research-phase0/fabric-state/execution.sqlite3
attempt="attempt:465388f7-f1c7-4e99-b7a2-c8efa4d09d21"
python3 - "$db" "$attempt" <<'PY'
import sqlite3,json,sys
db,attempt=sys.argv[1:]
c=sqlite3.connect(f"file:{db}?mode=ro",uri=True); c.row_factory=sqlite3.Row
r=c.execute("""
SELECT i.phase,i.payload ip,o.state os,o.outcome_payload outcome,
       a.state ast,a.observation_payload obs
FROM invocations i JOIN operations o ON o.invocation_id=i.invocation_id
JOIN attempts a ON a.operation_id=o.operation_id
WHERE a.attempt_id=?
""",(attempt,)).fetchone()
assert r is not None
inv=json.loads(r["ip"]); out=json.loads(r["outcome"]) if r["outcome"] else None
obs=json.loads(r["obs"]) if r["obs"] else None
safe={
 "phase":r["phase"],"operationState":r["os"],"attemptState":r["ast"],
 "requirementId":inv.get("requirement_id"),
 "action":(inv.get("arguments") or {}).get("action"),
 "outcome":out,
 "ackState":obs.get("ack_state") if obs else None,
 "detail":obs.get("detail") if obs else None
}
print("CF_PHASE0_EXACT_READBACK="+json.dumps(safe,separators=(",",":"),sort_keys=True))
assert r["os"]!="IN_FLIGHT" and out is not None
print("CF_PHASE0_EXACT_TERMINAL=pass")
c.close()
PY
