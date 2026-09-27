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

PYTHONPATH="$active/fabric-src" python3 - "$db" <<'PY'
import sys
from capability_fabric.persistence import SqliteExecutionStateStore
with SqliteExecutionStateStore(sys.argv[1]) as state:
    pending=state.recoverable()
    print("CF_POOL_PRECUTOVER_DIAG_RECOVERABLE_COUNT="+str(len(pending)))
    for i,item in enumerate(pending[:20],1):
        op=item.operation
        att=item.attempt
        print("CF_POOL_PRECUTOVER_DIAG_RECOVERABLE_"+str(i)+"="+repr({
            "operation_id": None if op is None else op.operation_id,
            "attempt_id": None if att is None else att.attempt_id,
            "operation_state": None if op is None else str(op.state),
            "attempt_state": None if att is None else str(att.state),
            "effect": None if op is None else str(op.effect),
        }))
PY

echo CF_POOL_PRECUTOVER_DIAG_DONE=pass
