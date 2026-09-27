#!/usr/bin/env bash
set -euo pipefail
umask 077
[[ "$(id -u)" -eq 0 ]] || exit 2

attempt="attempt:f6d80f46-b4ff-4798-9848-9b0b28bca1b8"
db="/var/lib/capability-fabric/onshape/fabric-state/execution.sqlite3"
agent_dir="/var/lib/capability-fabric/onshape/fabric-agent"

python3 - "$db" "$attempt" <<'PY'
import json,sqlite3,sys
db,attempt=sys.argv[1:3]
con=sqlite3.connect("file:"+db+"?mode=ro",uri=True)
con.row_factory=sqlite3.Row
row=con.execute("""
SELECT i.invocation_id,i.phase,i.payload AS invocation_payload,i.dispatch_payload,
       o.operation_id,o.state AS operation_state,o.payload AS operation_payload,
       a.attempt_id,a.state AS attempt_state,a.payload AS attempt_payload,a.observation_payload
FROM attempts a
JOIN operations o ON o.operation_id=a.operation_id
JOIN invocations i ON i.invocation_id=o.invocation_id
WHERE a.attempt_id=?
""",(attempt,)).fetchone()
if row is None:
    raise SystemExit("attempt not found")
inv=json.loads(row["invocation_payload"])
dispatch=json.loads(row["dispatch_payload"])
obs=None if row["observation_payload"] is None else json.loads(row["observation_payload"])
args=inv.get("arguments") or {}
steps=args.get("steps") or []
safe_steps=[]
for idx,step in enumerate(steps):
    if not isinstance(step,dict):
        safe_steps.append({"index":idx,"type":type(step).__name__})
        continue
    item={"index":idx,"action":step.get("action")}
    for k in ("key","x","y","button","click_count"):
        if k in step: item[k]=step.get(k)
    for k in ("selector","target_selector"):
        if k in step:
            v=str(step.get(k) or "")
            item[k]=v
    import hashlib
    for k in ("text","value"):
        if k in step:
            v=str(step.get(k) or "")
            item[k+"_present"]=True
            item[k+"_length"]=len(v)
            item[k+"_sha256"]=hashlib.sha256(v.encode()).hexdigest()
    safe_steps.append(item)
print("CF_RECOVERABLE_ATTEMPT_INVOCATION="+json.dumps({
  "invocation_id":row["invocation_id"],
  "phase":row["phase"],
  "operation_id":row["operation_id"],
  "operation_state":row["operation_state"],
  "attempt_id":row["attempt_id"],
  "attempt_state":row["attempt_state"],
  "definition_id":inv.get("definition_id"),
  "effect":inv.get("effect"),
  "target_id":inv.get("target_id"),
  "documentId":args.get("documentId"),
  "workspaceId":args.get("workspaceId"),
  "elementId":args.get("elementId"),
  "steps":safe_steps,
},sort_keys=True,separators=(",",":")))
print("CF_RECOVERABLE_ATTEMPT_DISPATCH="+json.dumps({
  "operation":((dispatch.get("execution_payload") or {}).get("operation") if isinstance(dispatch,dict) else None),
  "current_state_revision":dispatch.get("current_state_revision") if isinstance(dispatch,dict) else None,
  "snapshot_digest":dispatch.get("snapshot_digest") if isinstance(dispatch,dict) else None,
},sort_keys=True,separators=(",",":")))
print("CF_RECOVERABLE_ATTEMPT_OBSERVATION="+json.dumps(obs,sort_keys=True,separators=(",",":")))
con.close()
PY

hash="$(printf '%s' "$attempt" | sha256sum | awk '{print $1}')"
record="$agent_dir/$hash.json"
if [[ -s "$record" ]]; then
  python3 - "$record" <<'PY'
import json,sys
r=json.load(open(sys.argv[1]))
o=r.get("observation") or {}
e=o.get("evidence") or {}
safe={
  "schema":r.get("schema"),
  "attemptId":r.get("attemptId"),
  "operationId":r.get("operationId"),
  "state":r.get("state"),
  "createdAt":r.get("createdAt"),
  "updatedAt":r.get("updatedAt"),
  "hasBudgetReservation":bool(r.get("budgetReservation")),
  "hasRecovery":bool(r.get("recovery")),
  "observation":{
    "state":o.get("state"),
    "detail":o.get("detail"),
    "externalReference":o.get("externalReference"),
    "evidence":e,
  },
}
print("CF_RECOVERABLE_AGENT_RECORD="+json.dumps(safe,sort_keys=True,separators=(",",":")))
PY
else
  echo CF_RECOVERABLE_AGENT_RECORD=missing
fi

echo CF_RECOVERABLE_ATTEMPT_DIAG=pass
