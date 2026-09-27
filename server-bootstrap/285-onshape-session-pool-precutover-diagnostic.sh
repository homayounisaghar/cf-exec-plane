#!/usr/bin/env bash
set -euo pipefail
umask 077
[[ "$(id -u)" -eq 0 ]] || exit 2

control="/var/lib/capability-fabric/onshape/runtime-control/ONSHAPE_RUNTIME_CONTROL.json"
mirror="/var/lib/capability-fabric/onshape/runtime-control/git-blob-sha"
active="/opt/capability-fabric/current"
db="/var/lib/capability-fabric/onshape/fabric-state/execution.sqlite3"

python3 - "$control" <<'PY'
import json,sys
d=json.load(open(sys.argv[1]))
a=d.get("authority",{})
g=a.get("productionGuard",{})
lease=d.get("lease",{})
print("CF_POOL_PRECUTOVER_DIAG_CONTROL_REV="+str(d.get("controlRevision")))
print("CF_POOL_PRECUTOVER_DIAG_EPOCH="+str(a.get("productionEpoch")))
print("CF_POOL_PRECUTOVER_DIAG_MODE="+str(a.get("mode")))
print("CF_POOL_PRECUTOVER_DIAG_MATERIAL_AUTHORITY="+str(a.get("materialAuthority")))
print("CF_POOL_PRECUTOVER_DIAG_RECONCILIATION_HOLD="+str(bool(a.get("reconciliationHold",{}).get("active"))).lower())
print("CF_POOL_PRECUTOVER_DIAG_LEASE_STATE="+str(lease.get("state")))
for k in ("resourceKey","leaseId","workItem","attemptId","effect","target","updatedAt"):
    v=lease.get(k)
    print("CF_POOL_PRECUTOVER_DIAG_LEASE_"+k.upper()+"="+json.dumps(v,sort_keys=True,separators=(",",":")))
vps=a.get("planes",{}).get("vps-fabric",{})
print("CF_POOL_PRECUTOVER_DIAG_VPS_INGRESS="+str(vps.get("ingress")))
print("CF_POOL_PRECUTOVER_DIAG_VPS_RELEASE_SEQUENCE="+str(vps.get("releaseSequence")))
print("CF_POOL_PRECUTOVER_DIAG_VPS_RELEASE_ID="+str(vps.get("releaseId")))
print("CF_POOL_PRECUTOVER_DIAG_GUARD_KILL="+str(g.get("killSwitch")))
print("CF_POOL_PRECUTOVER_DIAG_GUARD_ALLOWLIST_COUNT="+str(len(g.get("allowedDocumentIds") or [])))
print("CF_POOL_PRECUTOVER_DIAG_GUARD_BUDGET="+str((g.get("mutationBudget") or {}).get("maxMutations")))
PY

echo "CF_POOL_PRECUTOVER_DIAG_CONTROL_BLOB=$(git hash-object "$control")"
echo "CF_POOL_PRECUTOVER_DIAG_MIRROR_BLOB=$(tr -d '\r\n' < "$mirror" 2>/dev/null || true)"
echo "CF_POOL_PRECUTOVER_DIAG_ACTIVE=$(basename "$(readlink -f "$active")")"

python3 - "$db" <<'PY'
import json,sqlite3,sys
db=sys.argv[1]
con=sqlite3.connect("file:"+db+"?mode=ro",uri=True)
con.row_factory=sqlite3.Row
rows=con.execute("""
SELECT i.invocation_id,i.phase,i.payload AS invocation_payload,i.dispatch_payload,
       o.operation_id,o.state AS operation_state,o.payload AS operation_payload,o.outcome_payload,
       a.attempt_id,a.state AS attempt_state,a.payload AS attempt_payload,a.observation_payload
FROM invocations i
LEFT JOIN operations o ON o.invocation_id=i.invocation_id
LEFT JOIN attempts a ON a.operation_id=o.operation_id
WHERE i.phase IN ('DISPATCH_FINALIZED','DISPATCH_INTENT','OBSERVED')
ORDER BY i.rowid
""").fetchall()
print("CF_POOL_PRECUTOVER_DIAG_RECOVERABLE_COUNT="+str(len(rows)))
for n,row in enumerate(rows[:20],1):
    inv=json.loads(row["invocation_payload"])
    op=None if row["operation_payload"] is None else json.loads(row["operation_payload"])
    att=None if row["attempt_payload"] is None else json.loads(row["attempt_payload"])
    obs=None if row["observation_payload"] is None else json.loads(row["observation_payload"])
    if op is None and att is None:
        disposition="READMIT_AND_REFINALIZE"
    elif op is not None and att is not None and obs is None:
        disposition="EFFECT_STATUS_UNKNOWN"
    elif op is not None and att is not None and obs is not None:
        disposition="RECONCILIATION_PENDING"
    else:
        disposition="INCOMPLETE"
    safe={
      "disposition":disposition,
      "invocation_id":row["invocation_id"],
      "invocation_phase":row["phase"],
      "requirement_id":inv.get("requirement_id"),
      "definition_id":inv.get("definition_id"),
      "invocation_effect":inv.get("effect"),
      "target_id":inv.get("target_id"),
      "operation_id":row["operation_id"],
      "operation_state":row["operation_state"],
      "operation_effect":None if op is None else op.get("effect"),
      "attempt_id":row["attempt_id"],
      "attempt_state":row["attempt_state"],
      "ack_state":None if obs is None else obs.get("ack_state"),
      "observation_detail":None if obs is None else obs.get("detail"),
      "external_reference":None if obs is None else obs.get("external_reference"),
    }
    print("CF_POOL_PRECUTOVER_DIAG_RECOVERABLE_"+str(n)+"="+json.dumps(safe,sort_keys=True,separators=(",",":")))
con.close()
PY

echo CF_POOL_PRECUTOVER_DIAG_DONE=pass
