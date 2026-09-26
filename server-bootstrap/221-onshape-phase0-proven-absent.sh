#!/usr/bin/env bash
set -euo pipefail
umask 077
[[ "$(id -u)" -eq 0 ]] || exit 2

old_candidate="ae9bc114d84cfd7991cbdd38489b18d33a2d34bf"
attempt="attempt:1972dcac-fcfe-4772-a5ee-8296f1029e73"
operation="operation:e334a4d8-5e4f-4679-a611-8a479ea14391"
db="/var/lib/capability-fabric/onshape-research-phase0/fabric-state/execution.sqlite3"
agent_dir="/var/lib/capability-fabric/onshape-research-phase0/fabric-agent"
control="/var/lib/capability-fabric/onshape/runtime-control/ONSHAPE_RUNTIME_CONTROL.json"
cache="/var/lib/capability-fabric/repo.git"
token="/etc/capability-fabric/secrets/repo-read-token"
home="/var/lib/capability-fabric/agent-home"

python3 - "$control" <<'PY'
import json,sys
d=json.load(open(sys.argv[1])); a=d["authority"]; g=a["productionGuard"]
assert a["mode"]=="VPS_PRODUCTION" and a["materialAuthority"]=="vps-fabric"
assert a["planes"]["android-v1"]["ingress"]=="CLOSED"
assert a["reconciliationHold"]["active"] is False
assert g["killSwitch"]=="ENGAGED" and g["allowedDocumentIds"]==[] and g["mutationBudget"]["maxMutations"]==0
print("CF_PHASE0_ABSENT_PRODUCTION_FAILCLOSED=pass")
PY

tmp="$(mktemp -d /var/lib/capability-fabric/phase0-absent.XXXXXX)"
trap 'rm -rf "$tmp"' EXIT
askpass="$tmp/askpass"
cat >"$askpass" <<'ASK'
#!/usr/bin/env bash
case "${1:-}" in
 *Username*) printf '%s\n' x-access-token ;;
 *Password*) cat /etc/capability-fabric/secrets/repo-read-token ;;
 *) exit 1 ;;
esac
ASK
chmod 0700 "$askpass"
GIT_ASKPASS="$askpass" GIT_TERMINAL_PROMPT=0 HOME="$home" git --git-dir="$cache" fetch --quiet --force --depth=1 origin "$old_candidate"
[[ "$(git --git-dir="$cache" rev-parse FETCH_HEAD)" == "$old_candidate" ]]
mkdir "$tmp/repo"; git --git-dir="$cache" archive "$old_candidate" | tar -x -C "$tmp/repo"

python3 - "$tmp/repo" <<'PY'
import pathlib,sys
root=pathlib.Path(sys.argv[1])
t=(root/"src/capability_fabric/onshape_vps_transport.py").read_text()
c=(root/"server-deploy/research-phase0/compose.yaml").read_text()
a=(root/"server-deploy/current/fabric-agent.js").read_text()
assert "port: int = 8789" in t and "if self.port != 8789:" in t
assert 'CF_DIAGNOSTIC_PORT: "8899"' in c
assert "CF_FABRIC_AGENT_PORT" not in c
claim=a.index("this._writeRecord(claimed);",a.index("async execute(dispatchInput)"))
effect=a.index("observed = await this._executeOnce",claim)
assert claim < effect
print("CF_PHASE0_ABSENT_OLD_ROUTING=8789")
print("CF_PHASE0_ABSENT_RESEARCH_AGENT=8899")
print("CF_PHASE0_ABSENT_PERSIST_BEFORE_EFFECT=pass")
PY

prod_token=/etc/capability-fabric/secrets/mcp-token
research_token=/etc/capability-fabric/secrets/mcp-token-research-phase0
[[ -s "$prod_token" && -s "$research_token" ]]
prod_sha="$(sha256sum "$prod_token"|awk '{print $1}')"
research_sha="$(sha256sum "$research_token"|awk '{print $1}')"
[[ "$prod_sha" != "$research_sha" ]]
echo CF_PHASE0_ABSENT_TOKEN_SEPARATION=pass

research_key="$(python3 - "$research_token" <<'PY'
import hashlib,sys
t=open(sys.argv[1]).read().strip()
print(hashlib.sha256(("fabric-agent:"+t).encode()).hexdigest())
PY
)"
status="$(curl -sS -o "$tmp/body" -w '%{http_code}' -X POST -H 'content-type: application/json' --data '{"action":"observe"}' "http://127.0.0.1:8789/internal/fabric/$research_key")"
[[ "$status" == "404" ]]
echo CF_PHASE0_ABSENT_WRONG_PORT_REJECTION=404

record="$agent_dir/$(printf '%s' "$attempt"|sha256sum|awk '{print $1}').json"
[[ ! -e "$record" ]]
echo CF_PHASE0_ABSENT_RESEARCH_AGENT_RECORD=absent

PYTHONPATH="$tmp/repo/src" python3 - "$db" "$attempt" "$operation" <<'PY'
import sys
from capability_fabric.domain import AckState,Outcome,OutcomeState
from capability_fabric.persistence import SqliteExecutionStateStore

db,attempt,operation=sys.argv[1:]
with SqliteExecutionStateStore(db) as state:
    cases=[c for c in state.recoverable() if c.attempt is not None and c.attempt.attempt_id==attempt]
    assert len(cases)==1
    case=cases[0]
    assert case.operation is not None and case.operation.operation_id==operation
    assert case.observation is not None and case.observation.ack_state is AckState.UNKNOWN
    assert case.invocation.requirement_id=="requirement:onshape.ui.native"
    assert dict(case.invocation.arguments).get("action")=="page.screenshot"
    outcome=Outcome(
      operation,
      OutcomeState.ABSENT,
      "Proven pre-effect transport misroute: Phase 0 sidecar targeted production diagnostic port 8789 with the distinct research internal key; production returned 404, research agent had no Attempt record, and agent persistence precedes every effect.",
    )
    state.record_outcome(case.operation,outcome)
    state.append("operation.reconciled.proven_absent_pre_effect",operation,{
      "attempt_id":attempt,
      "same_attempt":True,
      "reexecuted":False,
      "proof":"old candidate hardcoded 8789; research agent 8899; distinct token; wrong-port 404; no research agent record; persist-before-effect",
    })
print("CF_PHASE0_ABSENT_OUTCOME=ABSENT")
print("CF_PHASE0_ABSENT_REEXECUTED=false")
PY

python3 - "$db" "$attempt" <<'PY'
import sqlite3,sys,json
db,attempt=sys.argv[1:]
c=sqlite3.connect(f"file:{db}?mode=ro",uri=True); c.row_factory=sqlite3.Row
r=c.execute("""SELECT o.state,o.outcome_payload FROM operations o JOIN attempts a ON a.operation_id=o.operation_id WHERE a.attempt_id=?""",(attempt,)).fetchone()
assert r and r["state"]=="ABSENT"
out=json.loads(r["outcome_payload"]); assert out["state"]=="ABSENT"
print("CF_PHASE0_ABSENT_READBACK=pass")
PY
echo CF_PHASE0_ABSENT_RECONCILE=pass
