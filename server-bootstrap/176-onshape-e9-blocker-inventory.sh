#!/usr/bin/env bash
set -euo pipefail
DB=/var/lib/capability-fabric/onshape/fabric-state/execution.sqlite3
AGENT=/var/lib/capability-fabric/onshape/fabric-agent
CONTROL=/var/lib/capability-fabric/onshape/runtime-control/ONSHAPE_RUNTIME_CONTROL.json
python3 - "$DB" <<'PY'
import json,sqlite3,sys
db=sys.argv[1]
c=sqlite3.connect(f"file:{db}?mode=ro",uri=True); c.row_factory=sqlite3.Row
rows=c.execute("""
SELECT i.invocation_id,i.phase,i.payload AS invocation_payload,i.dispatch_payload,
       o.operation_id,o.state AS operation_state,o.outcome_payload,
       a.attempt_id,a.state AS attempt_state,a.payload AS attempt_payload,a.observation_payload
FROM invocations i
LEFT JOIN operations o ON o.invocation_id=i.invocation_id
LEFT JOIN attempts a ON a.operation_id=o.operation_id
WHERE i.phase IN ('DISPATCH_FINALIZED','DISPATCH_INTENT','OBSERVED')
   OR o.state IN ('IN_FLIGHT','IN_DOUBT')
   OR a.state IN ('DISPATCH_INTENT','IN_DOUBT')
ORDER BY i.rowid DESC
""").fetchall()
print("CF_E9_BLOCKER_COUNT="+str(len(rows)))
for r in rows:
 d=dict(r)
 for k in ["invocation_payload","dispatch_payload","outcome_payload","attempt_payload","observation_payload"]:
  if d.get(k):
   try:d[k]=json.loads(d[k])
   except Exception:pass
 print("CF_E9_BLOCKER_ROW="+json.dumps(d,separators=(',',':'),sort_keys=True))
c.close()
PY
python3 - "$AGENT" <<'PY'
import json,pathlib,sys
root=pathlib.Path(sys.argv[1])
for p in root.glob("*.json"):
 try:v=json.loads(p.read_text())
 except Exception:continue
 if str(v.get("state","")) in {"EXECUTING","UNCERTAIN"}:
  print("CF_E9_BLOCKER_AGENT="+json.dumps({"file":p.name,**v},separators=(',',':'),sort_keys=True))
PY
python3 - "$CONTROL" <<'PY'
import json,sys
x=json.load(open(sys.argv[1]))
print("CF_E9_BLOCKER_CONTROL="+json.dumps({
 "revision":x["controlRevision"],"epoch":x["authority"]["productionEpoch"],
 "mode":x["authority"]["mode"],"lease":x["lease"],"hold":x["authority"]["reconciliationHold"]
},separators=(',',':'),sort_keys=True))
PY
