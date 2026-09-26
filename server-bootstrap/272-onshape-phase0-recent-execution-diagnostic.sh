#!/usr/bin/env bash
set -euo pipefail
umask 077
[[ "$(id -u)" -eq 0 ]] || exit 2
candidate="c0cadee962c2059ba939c40c6bb9adf1bc99edfe"
root="/var/lib/capability-fabric/onshape-research-phase0"
db="$root/fabric-state/execution.sqlite3"
control="/var/lib/capability-fabric/onshape/runtime-control/ONSHAPE_RUNTIME_CONTROL.json"

python3 - "$control" <<'PY'
import json,sys
d=json.load(open(sys.argv[1])); a=d["authority"]; g=a["productionGuard"]
assert a["mode"]=="VPS_PRODUCTION" and a["materialAuthority"]=="vps-fabric"
assert a["planes"]["android-v1"]["ingress"]=="CLOSED"
assert a["reconciliationHold"]["active"] is False
assert g["killSwitch"]=="ENGAGED" and g["allowedDocumentIds"]==[] and g["mutationBudget"]["maxMutations"]==0
print("CF_PHASE0_RECENTDIAG_BOUNDARY=pass")
PY

python3 - "$db" <<'PY'
import json,sqlite3,sys
db=sys.argv[1]
con=sqlite3.connect(f"file:{db}?mode=ro",uri=True); con.row_factory=sqlite3.Row
for t in ["invocations","operations","attempts"]:
    cols=[r["name"] for r in con.execute(f"pragma table_info({t})")]
    print("CF_PHASE0_RECENTDIAG_SCHEMA_"+t.upper()+"="+json.dumps(cols))
rows=con.execute("""
SELECT a.rowid ar,i.rowid ir,o.rowid orow,
       i.payload ip,o.payload op,o.state os,o.outcome_payload out,
       a.payload ap,a.state ast,a.observation_payload ob
FROM attempts a
JOIN operations o ON o.operation_id=a.operation_id
JOIN invocations i ON i.invocation_id=o.invocation_id
ORDER BY a.rowid DESC LIMIT 20
""").fetchall()
out=[]
for r in rows:
    inv=json.loads(r["ip"]); op=json.loads(r["op"]); att=json.loads(r["ap"])
    obs=json.loads(r["ob"]) if r["ob"] else None
    oc=json.loads(r["out"]) if r["out"] else None
    args=inv.get("arguments") or {}
    out.append({
      "attempt_id":att.get("attempt_id"),"operation_id":op.get("operation_id"),
      "requirement_id":inv.get("requirement_id"),"action":args.get("action"),
      "steps":args.get("steps"),"operation_state":r["os"],"attempt_state":r["ast"],
      "ack_state":(obs or {}).get("ack_state"),"detail":(obs or {}).get("detail"),
      "evidence":(obs or {}).get("evidence"),"outcome":oc
    })
print("CF_PHASE0_RECENTDIAG_ROWS="+json.dumps(out,separators=(",",":"),sort_keys=True))
con.close()
PY
echo CF_PHASE0_RECENTDIAG=pass
