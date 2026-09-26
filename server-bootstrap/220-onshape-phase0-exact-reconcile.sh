#!/usr/bin/env bash
set -euo pipefail
attempt="attempt:1972dcac-fcfe-4772-a5ee-8296f1029e73"
db="/var/lib/capability-fabric/onshape-research-phase0/fabric-state/execution.sqlite3"

# Prove this is still the sole recoverable exact Attempt before reconciliation.
python3 - "$db" "$attempt" <<'PY'
import sqlite3,sys,json
db,attempt=sys.argv[1:3]
con=sqlite3.connect(f"file:{db}?mode=ro",uri=True)
con.row_factory=sqlite3.Row
rows=con.execute("""
SELECT i.phase,i.payload AS ip,o.payload AS op,o.state AS os,a.payload AS ap,a.state AS ast,a.observation_payload AS ob
FROM invocations i
JOIN operations o ON o.invocation_id=i.invocation_id
JOIN attempts a ON a.operation_id=o.operation_id
WHERE i.phase IN ('DISPATCH_FINALIZED','DISPATCH_INTENT','OBSERVED')
""").fetchall()
matches=[]
for r in rows:
    ap=json.loads(r["ap"])
    if ap.get("attempt_id")==attempt:
        matches.append(r)
assert len(matches)==1, f"expected exact recoverable attempt once, got {len(matches)}"
r=matches[0]
inv=json.loads(r["ip"]); op=json.loads(r["op"]); obs=json.loads(r["ob"]) if r["ob"] else None
assert inv.get("requirement_id")=="requirement:onshape.ui.native"
assert inv.get("arguments",{}).get("action")=="page.screenshot"
assert r["os"]=="IN_FLIGHT" and r["ast"]=="OBSERVED"
assert obs and obs.get("ack_state")=="UNKNOWN"
print("CF_PHASE0_RECONCILE_PREFLIGHT=pass")
print("CF_PHASE0_RECONCILE_OPERATION="+str(op.get("operation_id")))
print("CF_PHASE0_RECONCILE_ATTEMPT="+attempt)
con.close()
PY

python3 - "$attempt" <<'PY'
import json,sys,urllib.request,urllib.error
attempt=sys.argv[1]
body=json.dumps({"attemptId":attempt},separators=(",",":")).encode()
req=urllib.request.Request("http://127.0.0.1:8901/v1/reconcile",data=body,headers={"Content-Type":"application/json"},method="POST")
try:
    with urllib.request.urlopen(req,timeout=20) as r:
        raw=r.read().decode()
        status=r.status
except urllib.error.HTTPError as e:
    raw=e.read().decode(errors="replace")
    status=e.code
print("CF_PHASE0_RECONCILE_HTTP="+str(status))
try:
    data=json.loads(raw)
except Exception:
    print("CF_PHASE0_RECONCILE_PARSE=fail")
    raise
# Sanitize output to the reconciliation contract only.
result=data.get("result") if isinstance(data,dict) else None
if isinstance(result,dict):
    safe={
      "operationId":result.get("operationId"),
      "attemptId":result.get("attemptId"),
      "outcome":result.get("outcome"),
      "observation":{
        "ackState":(result.get("observation") or {}).get("ackState"),
        "detail":(result.get("observation") or {}).get("detail"),
        "evidence":{k:(result.get("observation") or {}).get("evidence",{}).get(k) for k in [
          "effectSent","nativeCompleted","nativeAction","buildId","finalUrl"
        ]},
      },
      "sameAttempt":result.get("sameAttempt"),
      "reexecuted":result.get("reexecuted"),
    }
    print("CF_PHASE0_RECONCILE_RESULT="+json.dumps(safe,separators=(",",":"),sort_keys=True))
else:
    print("CF_PHASE0_RECONCILE_ERROR="+json.dumps(data,separators=(",",":"),sort_keys=True)[:2000])
if status != 200:
    raise SystemExit(20)
assert isinstance(result,dict)
assert result.get("attemptId")==attempt
assert result.get("sameAttempt") is True
assert result.get("reexecuted") is False
print("CF_PHASE0_RECONCILE_CALL=pass")
PY
