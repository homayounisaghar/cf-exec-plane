#!/usr/bin/env bash
set -euo pipefail
[[ "$(id -u)" -eq 0 ]] || exit 2
db=/var/lib/capability-fabric/onshape-research-phase0/fabric-state/execution.sqlite3
[[ -r "$db" ]]
python3 - "$db" <<'PY'
import json,sqlite3,sys
p=sys.argv[1]
c=sqlite3.connect(f"file:{p}?mode=ro",uri=True); c.row_factory=sqlite3.Row
rows=c.execute("""
SELECT i.phase,i.payload ip,o.state os,o.payload op,o.outcome_payload outcome,
       a.state ast,a.payload ap,a.observation_payload obs
FROM invocations i
LEFT JOIN operations o ON o.invocation_id=i.invocation_id
LEFT JOIN attempts a ON a.operation_id=o.operation_id
WHERE o.state IN ('IN_FLIGHT') OR (a.state IN ('DISPATCH_INTENT','OBSERVED') AND o.outcome_payload IS NULL)
ORDER BY i.rowid
""").fetchall()
print("CF_PHASE0_PENDING_COUNT="+str(len(rows)))
for r in rows:
    inv=json.loads(r["ip"]) if r["ip"] else {}
    op=json.loads(r["op"]) if r["op"] else {}
    att=json.loads(r["ap"]) if r["ap"] else {}
    obs=json.loads(r["obs"]) if r["obs"] else {}
    args=inv.get("arguments") if isinstance(inv.get("arguments"),dict) else {}
    ev=obs.get("evidence") if isinstance(obs.get("evidence"),dict) else {}
    out={
      "phase":r["phase"],"requirementId":inv.get("requirement_id"),"effect":inv.get("effect"),
      "targetId":inv.get("target_id"),"action":args.get("action"),"operationId":op.get("operation_id"),
      "operationState":r["os"],"attemptId":att.get("attempt_id"),"attemptState":r["ast"],
      "ackState":obs.get("ack_state"),"detail":obs.get("detail"),
      "evidence":{k:ev.get(k) for k in ["effectSent","nativeCompleted","nativeAction","sequenceCompleted","completedSteps","transportUncertain"]},
      "hasOutcome":r["outcome"] is not None
    }
    print("CF_PHASE0_PENDING_CASE="+json.dumps(out,separators=(",",":"),sort_keys=True))
c.close()
PY
echo CF_PHASE0_PENDING_DIAGNOSTIC=pass
