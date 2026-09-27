#!/usr/bin/env bash
set -euo pipefail
umask 077
[[ "$(id -u)" -eq 0 ]] || exit 2

root="/var/lib/capability-fabric/onshape-session-pool-phase5-lab"
marker="$root/agent-state/phase5-live-unresolved.json"
db="$root/fabric-state/execution.sqlite3"

[[ -s "$marker" ]] || { echo CF_PHASE5_PRESERVED_MARKER=missing >&2; exit 20; }
[[ -s "$db" ]] || { echo CF_PHASE5_PRESERVED_DB=missing >&2; exit 21; }

python3 - "$marker" "$db" <<'PY'
import json,sqlite3,sys
marker_path,db=sys.argv[1:3]
marker=json.load(open(marker_path))
safe_marker={k:marker.get(k) for k in ("attemptId","phase","expectedName","workItem","executionContextId")}
print("CF_PHASE5_PRESERVED_MARKER="+json.dumps(safe_marker,sort_keys=True,separators=(",",":")))

con=sqlite3.connect("file:"+db+"?mode=ro",uri=True)
con.row_factory=sqlite3.Row
integrity=con.execute("PRAGMA integrity_check").fetchone()[0]
print("CF_PHASE5_PRESERVED_DB_INTEGRITY="+str(integrity))

rows=con.execute("""
SELECT i.rowid AS seq,i.invocation_id,i.phase,i.payload AS invocation_payload,i.dispatch_payload,
       o.operation_id,o.state AS operation_state,o.outcome_payload,
       a.attempt_id,a.state AS attempt_state,a.observation_payload
FROM invocations i
LEFT JOIN operations o ON o.invocation_id=i.invocation_id
LEFT JOIN attempts a ON a.operation_id=o.operation_id
ORDER BY i.rowid
""").fetchall()
out=[]
for row in rows:
    inv=json.loads(row["invocation_payload"])
    args=inv.get("arguments") or {}
    item={
      "seq":row["seq"],
      "invocationId":row["invocation_id"],
      "phase":row["phase"],
      "definitionId":inv.get("definition_id"),
      "effect":inv.get("effect"),
      "targetId":inv.get("target_id"),
      "operationId":row["operation_id"],
      "operationState":row["operation_state"],
      "attemptId":row["attempt_id"],
      "attemptState":row["attempt_state"],
      "hasObservation":row["observation_payload"] is not None,
      "hasOutcome":row["outcome_payload"] is not None,
      "argOperationId":args.get("operationId"),
      "executionContextId":args.get("executionContextId"),
    }
    out.append(item)
print("CF_PHASE5_PRESERVED_EXECUTIONS="+json.dumps(out,sort_keys=True,separators=(",",":")))

recoverable=con.execute("""
SELECT i.invocation_id,i.phase,o.operation_id,o.state AS operation_state,
       a.attempt_id,a.state AS attempt_state,
       CASE WHEN a.observation_payload IS NULL THEN 0 ELSE 1 END AS has_observation
FROM invocations i
LEFT JOIN operations o ON o.invocation_id=i.invocation_id
LEFT JOIN attempts a ON a.operation_id=o.operation_id
WHERE i.phase IN ('DISPATCH_FINALIZED','DISPATCH_INTENT','OBSERVED')
ORDER BY i.rowid
""").fetchall()
print("CF_PHASE5_PRESERVED_RECOVERABLE="+json.dumps([dict(r) for r in recoverable],sort_keys=True,separators=(",",":")))
con.close()
PY

echo CF_PHASE5_PRESERVED_DIAG=pass
