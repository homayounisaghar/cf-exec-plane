#!/usr/bin/env bash
set -euo pipefail
DB=/var/lib/capability-fabric/onshape/fabric-state/execution.sqlite3
AGENT_DIR=/var/lib/capability-fabric/onshape/fabric-agent
CONTROL=/var/lib/capability-fabric/onshape/runtime-control/ONSHAPE_RUNTIME_CONTROL.json
GATE=/var/lib/capability-fabric/state/release-in-progress
DID=6efc214ada1e9b6924774296
BUDGET=e9-mate-durability-r8-20260926
[[ -s "$DB" && -s "$CONTROL" && -f "$GATE" ]]
echo CF_E9_MATE_RECON_GATE=active
python3 - "$DB" "$DID" <<'PY'
import json,sqlite3,sys
db,did=sys.argv[1:]
c=sqlite3.connect(f"file:{db}?mode=ro",uri=True); c.row_factory=sqlite3.Row
rows=c.execute("""
SELECT i.invocation_id,i.phase,i.payload AS invocation_payload,i.dispatch_payload,
       o.operation_id,o.state AS operation_state,o.outcome_payload,
       a.attempt_id,a.state AS attempt_state,a.observation_payload
FROM invocations i
LEFT JOIN operations o ON o.invocation_id=i.invocation_id
LEFT JOIN attempts a ON a.operation_id=o.operation_id
WHERE i.payload LIKE ? OR i.dispatch_payload LIKE ?
ORDER BY i.rowid DESC LIMIT 12
""",("%"+did+"%","%"+did+"%")).fetchall()
print("CF_E9_MATE_RECON_ROWS="+str(len(rows)))
for r in rows:
    d=dict(r)
    slim={k:d[k] for k in ["invocation_id","phase","operation_id","operation_state","attempt_id","attempt_state"]}
    for k in ["invocation_payload","dispatch_payload","outcome_payload","observation_payload"]:
        v=d.get(k)
        if v:
            try: slim[k]=json.loads(v)
            except: slim[k]=v
    print("CF_E9_MATE_RECON_ROW="+json.dumps(slim,separators=(",",":"),sort_keys=True))
c.close()
PY
python3 - "$AGENT_DIR" "$BUDGET" <<'PY'
import json,pathlib,sys
root=pathlib.Path(sys.argv[1]); budget=sys.argv[2]
rows=[]
for p in root.rglob("*.json"):
    try:v=json.loads(p.read_text())
    except:continue
    if isinstance(v,dict) and v.get("budgetId")==budget:
        rows.append({"path":str(p),"value":v})
print("CF_E9_MATE_RECON_BUDGET_ROWS="+str(len(rows)))
for r in sorted(rows,key=lambda x:int(x["value"].get("slot",0))):
    print("CF_E9_MATE_RECON_BUDGET="+json.dumps(r,separators=(",",":"),sort_keys=True))
PY
