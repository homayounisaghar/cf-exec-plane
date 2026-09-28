#!/usr/bin/env bash
set -euo pipefail
umask 077
[[ "$(id -u)" -eq 0 ]] || exit 2
root="/var/lib/capability-fabric/onshape-session-pool-phase5-lab"
marker="$root/agent-state/phase5-live-unresolved.json"
db="$root/fabric-state/execution.sqlite3"
leases="$root/agent-state/workflow-leases.json"
lock="/run/lock/capability-fabric-pull.lock"
[[ -s "$marker" && -s "$db" && -s "$leases" ]] || { echo CF_PHASE5_TERMINAL_CLEANUP_STATE=missing >&2; exit 20; }
exec 9>"$lock"
flock -w 30 9 || { echo CF_PHASE5_TERMINAL_CLEANUP_LOCK=busy >&2; exit 21; }
for c in capability-fabric-onshape-phase5-lab-server capability-fabric-onshape-phase5-lab-fabric capability-fabric-onshape-phase5-recovery-server capability-fabric-onshape-phase5-recovery-fabric; do
  [[ "$(docker inspect -f '{{.State.Running}}' "$c" 2>/dev/null || echo false)" != true ]] || { echo CF_PHASE5_TERMINAL_CLEANUP_LAB=running >&2; exit 22; }
done
python3 - "$marker" "$db" "$leases" <<'PY'
import json,re,sqlite3,sys
marker,db,lease_file=sys.argv[1:]
m=json.load(open(marker))
ctx=str(m.get("executionContextId") or "")
assert m.get("phase")=="create-copyWorkspace-dispatching",m
assert m.get("attemptId") is None,m
assert m.get("workItem")=="phase5-copy",m
assert re.fullmatch(r"ctx_[0-9a-f]{32}",ctx),m
assert str(m.get("expectedName") or "").startswith("CF Phase5 Disposable A "),m
lease_root=json.load(open(lease_file))
assert (lease_root.get("leases") or [])==[],lease_root
con=sqlite3.connect("file:"+db+"?mode=ro",uri=True)
con.row_factory=sqlite3.Row
assert con.execute("PRAGMA integrity_check").fetchone()[0]=="ok"
recoverable=con.execute("""
SELECT 1 FROM invocations i
JOIN operations o ON o.invocation_id=i.invocation_id
JOIN attempts a ON a.operation_id=o.operation_id
WHERE i.phase IN ('DISPATCH_FINALIZED','DISPATCH_INTENT','OBSERVED')
LIMIT 1
""").fetchall()
assert not recoverable,recoverable
rows=con.execute("""
SELECT i.phase,o.state AS operation_state,o.outcome_payload,a.attempt_id,
       json_extract(i.payload,'$.arguments.operationId') AS arg_operation_id,
       json_extract(i.payload,'$.arguments.executionContextId') AS context_id
FROM invocations i
JOIN operations o ON o.invocation_id=i.invocation_id
JOIN attempts a ON a.operation_id=o.operation_id
WHERE json_extract(i.payload,'$.arguments.operationId')='copyWorkspace'
  AND json_extract(i.payload,'$.arguments.executionContextId')=?
""",(ctx,)).fetchall()
assert len(rows)==1,rows
r=rows[0]
assert r["phase"]=="RECONCILED" and r["operation_state"]=="ABSENT",dict(r)
assert r["outcome_payload"] is not None,dict(r)
out=json.loads(r["outcome_payload"])
assert out.get("state")=="ABSENT",out
assert str(r["attempt_id"]).startswith("attempt:"),dict(r)
print("CF_PHASE5_TERMINAL_CLEANUP_PROOF=ABSENT-reconciled-no-recoverable-no-lease")
con.close()
PY
rm -rf "$root"
[[ ! -e "$root" ]] || exit 30
echo CF_PHASE5_TERMINAL_CLEANUP=retired
