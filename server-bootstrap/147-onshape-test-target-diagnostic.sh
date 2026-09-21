#!/usr/bin/env bash
set -euo pipefail
umask 077
[[ "$(id -u)" -eq 0 ]] || exit 2
CONTROL=/var/lib/capability-fabric/onshape/runtime-control/ONSHAPE_RUNTIME_CONTROL.json
GATE=/var/lib/capability-fabric/state/release-in-progress
TIMER=capability-fabric-pull.timer
GATEWAY=capability-fabric-onshape-gateway
DB=/var/lib/capability-fabric/onshape/fabric-state/execution.sqlite3
AGENT_DIR=/var/lib/capability-fabric/onshape/fabric-agent
expected_blob=56fa3abbcfffaa7451f32a0707a569f865ab49bb
budget_id=epoch6-test-881affea-budget2
budget_key="$(printf '%s' "2:$budget_id" | sha256sum | awk '{print $1}')"
budget_dir="$AGENT_DIR/mutation-budgets/$budget_key"

[[ "$(git hash-object "$CONTROL")" == "$expected_blob" ]]
[[ -f "$GATE" ]]
if systemctl is-active --quiet "$TIMER"; then exit 20; fi
[[ "$(docker inspect -f '{{.State.Running}}' "$GATEWAY")" == false ]]
if [[ -d "$budget_dir" ]]; then
  n="$(find "$budget_dir" -maxdepth 1 -type f -name '*.json' -print | wc -l | tr -d ' ')"
else
  n=0
fi
echo "CF_TARGET_DIAG_BUDGET_RESERVATIONS=$n"

python3 - "$DB" <<'PY'
import json, sqlite3, sys
db=sys.argv[1]
c=sqlite3.connect(f"file:{db}?mode=ro",uri=True)
c.row_factory=sqlite3.Row
rows=c.execute("""
select rowid, invocation_id, phase, payload, dispatch_payload
from invocations
order by rowid desc
limit 12
""").fetchall()
matched=[]
for row in rows:
    try:
        payload=json.loads(row["payload"])
    except Exception:
        payload={}
    args=payload.get("arguments") if isinstance(payload,dict) else {}
    did=None
    if isinstance(args,dict):
        pp=args.get("pathParams")
        if isinstance(pp,dict):
            did=pp.get("did")
    item={
        "rowid":row["rowid"],
        "invocationId":row["invocation_id"],
        "phase":row["phase"],
        "did":did,
        "hasDispatch":row["dispatch_payload"] is not None,
    }
    if did in {"000000000000000000000001","881affea8ea63c33ae4e6c78"}:
        matched.append(item)
for item in reversed(matched):
    print("CF_TARGET_DIAG_INVOCATION="+json.dumps(item,separators=(",",":")))
print("CF_TARGET_DIAG_MATCHED="+str(len(matched)))
print("CF_TARGET_DIAG_SQLITE_INTEGRITY="+c.execute("pragma integrity_check").fetchone()[0])
c.close()
PY
echo CF_TARGET_DIAG_GATE=active
echo CF_TARGET_DIAG_TIMER=stopped
echo CF_TARGET_DIAG_GATEWAY=stopped
echo CF_TARGET_DIAG=pass
