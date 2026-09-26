#!/usr/bin/env bash
set -euo pipefail
umask 077
[[ "$(id -u)" -eq 0 ]] || exit 2

candidate="dbb08f8257b4e72e31e203497fa135acdeda5e5b"
attempt="attempt:465388f7-f1c7-4e99-b7a2-c8efa4d09d21"
operation="operation:f21fab3d-07f3-4f07-9683-8397d8655d8e"
db=/var/lib/capability-fabric/onshape-research-phase0/fabric-state/execution.sqlite3
agent_dir=/var/lib/capability-fabric/onshape-research-phase0/fabric-agent
control=/var/lib/capability-fabric/onshape/runtime-control/ONSHAPE_RUNTIME_CONTROL.json
cache=/var/lib/capability-fabric/repo.git
home=/var/lib/capability-fabric/agent-home

python3 - "$control" <<'PY'
import json,sys
d=json.load(open(sys.argv[1])); a=d["authority"]; g=a["productionGuard"]
assert a["mode"]=="VPS_PRODUCTION" and a["materialAuthority"]=="vps-fabric"
assert a["planes"]["android-v1"]["ingress"]=="CLOSED"
assert a["reconciliationHold"]["active"] is False
assert g["killSwitch"]=="ENGAGED" and g["allowedDocumentIds"]==[] and g["mutationBudget"]["maxMutations"]==0
print("CF_PHASE0_SESSION_REJECT_AUTHORITY=pass")
PY

tmp="$(mktemp -d /var/lib/capability-fabric/phase0-session-reject.XXXXXX)"
trap 'rm -rf "$tmp"' EXIT
ask="$tmp/askpass"
cat >"$ask" <<'ASK'
#!/usr/bin/env bash
case "${1:-}" in
 *Username*) printf '%s\n' x-access-token ;;
 *Password*) cat /etc/capability-fabric/secrets/repo-read-token ;;
 *) exit 1 ;;
esac
ASK
chmod 0700 "$ask"
GIT_ASKPASS="$ask" GIT_TERMINAL_PROMPT=0 HOME="$home" git --git-dir="$cache" fetch --quiet --force --depth=1 origin "$candidate"
[[ "$(git --git-dir="$cache" rev-parse FETCH_HEAD)" == "$candidate" ]]
mkdir "$tmp/repo"; git --git-dir="$cache" archive "$candidate" | tar -x -C "$tmp/repo"

python3 - "$tmp/repo/server-deploy/current/browser-native.js" "$tmp/repo/server-deploy/current/browser.js" <<'PY'
import sys
native=open(sys.argv[1],encoding="utf-8").read()
browser=open(sys.argv[2],encoding="utf-8").read()
run=native.index("export async function runNativeAction")
ensure=native.index("const opened = await ensureTarget",run)
eval_branch=native.index('action === "page.evaluate"',ensure)
assert ensure < eval_branch
helper=native.index("async function ensureTarget")
open_call=native.index("await session.openDocument",helper)
assert helper < open_call < run
open_def=browser.index("async openDocument(")
auth=browser.index("const auth = await this.proveAuthentication()",open_def)
guard=browser.index('if (auth.state !== "PROVEN")',auth)
reject=browser.index('"SESSION_REJECTED"',guard)
goto=browser.index("await this.page.goto",guard)
assert open_def < auth < guard < reject < goto
print("CF_PHASE0_SESSION_REJECT_SOURCE_ORDER=pass")
print("CF_PHASE0_SESSION_REJECT_BASIS=auth-before-open-before-page-evaluate")
PY

PYTHONPATH="$tmp/repo/src" python3 - "$db" "$attempt" "$operation" <<'PY'
import sys,json
from capability_fabric.domain import AckState,Outcome,OutcomeState
from capability_fabric.persistence import SqliteExecutionStateStore

db,attempt,operation=sys.argv[1:]
with SqliteExecutionStateStore(db) as state:
    cases=[c for c in state.recoverable() if c.attempt is not None and c.attempt.attempt_id==attempt]
    assert len(cases)==1, len(cases)
    case=cases[0]
    assert case.operation is not None and case.observation is not None
    assert case.operation.operation_id==operation
    assert case.invocation.requirement_id=="requirement:onshape.ui.native"
    assert dict(case.invocation.arguments).get("action")=="page.evaluate"
    assert case.observation.ack_state is AckState.UNKNOWN
    assert "SESSION_REJECTED" in str(case.observation.detail or "")
    ev=dict(case.observation.evidence)
    assert ev.get("nativeAction")=="page.evaluate"
    assert ev.get("nativeCompleted") is False
    assert ev.get("effectSent") is None
    outcome=Outcome(
      operation,
      OutcomeState.ABSENT,
      "Proven pre-effect authentication rejection: runNativeAction calls ensureTarget/openDocument before the page.evaluate branch; openDocument throws SESSION_REJECTED before navigation/evaluation when authentication is not PROVEN.",
    )
    state.record_outcome(case.operation,outcome)
    state.append("operation.reconciled.proven_absent_pre_effect",operation,{
      "attempt_id":attempt,
      "same_attempt":True,
      "reexecuted":False,
      "proof":"dbb08 runNativeAction ensureTarget/openDocument auth guard precedes page.evaluate",
    })
print("CF_PHASE0_SESSION_REJECT_FABRIC_OUTCOME=ABSENT")
print("CF_PHASE0_SESSION_REJECT_REEXECUTED=false")
PY

python3 - "$db" "$attempt" <<'PY'
import sqlite3,sys,json
db,attempt=sys.argv[1:]
c=sqlite3.connect(f"file:{db}?mode=ro",uri=True); c.row_factory=sqlite3.Row
r=c.execute("""SELECT o.state,o.outcome_payload FROM operations o JOIN attempts a ON a.operation_id=o.operation_id WHERE a.attempt_id=?""",(attempt,)).fetchone()
assert r and r["state"]=="ABSENT"
out=json.loads(r["outcome_payload"]); assert out["state"]=="ABSENT"
print("CF_PHASE0_SESSION_REJECT_READBACK=pass")
c.close()
PY

# If an agent record exists, prove it contains the same pre-effect rejection; do not rewrite or replay it.
python3 - "$agent_dir" "$attempt" "$operation" <<'PY'
import hashlib,json,pathlib,sys
root,attempt,operation=sys.argv[1:]
p=pathlib.Path(root)/(hashlib.sha256(attempt.encode()).hexdigest()+".json")
if not p.exists():
    print("CF_PHASE0_SESSION_REJECT_AGENT_RECORD=absent")
else:
    v=json.loads(p.read_text())
    assert v.get("attemptId")==attempt and v.get("operationId")==operation
    obs=v.get("observation") or {}
    assert "SESSION_REJECTED" in str(obs.get("detail") or "")
    ev=obs.get("evidence") or {}
    assert ev.get("nativeAction")=="page.evaluate"
    assert ev.get("nativeCompleted") is False
    print("CF_PHASE0_SESSION_REJECT_AGENT_RECORD=consistent")
PY

echo CF_PHASE0_SESSION_REJECT_RECONCILE=pass
