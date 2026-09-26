#!/usr/bin/env bash
set -euo pipefail
umask 077
[[ "$(id -u)" -eq 0 ]] || exit 2

candidate="17ae77556fb2581bdeb72985c5e2645e7b697bc0"
attempt="attempt:ff938907-e0d6-4a75-b045-6f38e36c7847"
operation="operation:90de9bde-f644-4a1a-90ba-496db050f73b"
fixture="a19e0fa5152af9f7ce106b6e:e5e7d0173fd1f1d0307a2cb6:e0929361aadb6135b5cecffa"
db="/var/lib/capability-fabric/onshape-research-phase0/fabric-state/execution.sqlite3"
agent_dir="/var/lib/capability-fabric/onshape-research-phase0/fabric-agent"
release="/var/lib/capability-fabric/onshape-research-phase0/releases/$candidate"
control="/var/lib/capability-fabric/onshape/runtime-control/ONSHAPE_RUNTIME_CONTROL.json"

python3 - "$control" <<'PY'
import json,sys
d=json.load(open(sys.argv[1])); a=d["authority"]; g=a["productionGuard"]
assert a["mode"]=="VPS_PRODUCTION" and a["materialAuthority"]=="vps-fabric"
assert a["planes"]["android-v1"]["ingress"]=="CLOSED"
assert a["planes"]["android-v1"]["materialEffectsAllowed"] is False
assert a["reconciliationHold"]["active"] is False
assert g["killSwitch"]=="ENGAGED" and g["allowedDocumentIds"]==[] and g["mutationBudget"]["maxMutations"]==0
print("CF_PHASE0_RTREC_PRODUCTION_FAILCLOSED=pass")
print("CF_PHASE0_RTREC_CONTROL_REV="+str(d["controlRevision"]))
print("CF_PHASE0_RTREC_EPOCH="+str(a["productionEpoch"]))
PY

for c in capability-fabric-onshape-phase0-research capability-fabric-onshape-phase0-fabric; do
 [[ "$(docker inspect -f '{{.State.Running}}' "$c")" == true ]]
 [[ "$(docker inspect -f '{{.State.Health.Status}}' "$c")" == healthy ]]
done
env_dump="$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' capability-fabric-onshape-phase0-research)"
grep -Fxq "CF_RESEARCH_SOURCE_COMMIT=$candidate" <<<"$env_dump"
grep -Fxq "CF_RESEARCH_FIXTURE_TARGET=$fixture" <<<"$env_dump"
echo CF_PHASE0_RTREC_BINDING=pass

python3 - "$db" "$attempt" "$operation" <<'PY'
import json,sqlite3,sys
db,attempt,operation=sys.argv[1:]
con=sqlite3.connect(f"file:{db}?mode=ro",uri=True); con.row_factory=sqlite3.Row
rows=con.execute("""
SELECT i.phase,i.payload ip,o.payload op,o.state os,o.outcome_payload out,a.payload ap,a.state ast,a.observation_payload ob
FROM invocations i JOIN operations o ON o.invocation_id=i.invocation_id JOIN attempts a ON a.operation_id=o.operation_id
WHERE a.payload LIKE ?
""",("%"+attempt+"%",)).fetchall()
assert len(rows)==1, len(rows)
r=rows[0]; inv=json.loads(r["ip"]); op=json.loads(r["op"]); att=json.loads(r["ap"]); obs=json.loads(r["ob"])
assert op["operation_id"]==operation and att["attempt_id"]==attempt
assert inv["requirement_id"]=="requirement:onshape.ui.native"
assert inv["arguments"]["action"]=="page.evaluate"
assert r["os"]=="IN_FLIGHT" and r["ast"]=="OBSERVED"
assert obs["ack_state"]=="UNKNOWN"
assert "SESSION_UNKNOWN" in str(obs.get("detail"))
ev=obs.get("evidence") or {}
assert ev.get("nativeAction")=="page.evaluate" and ev.get("nativeCompleted") is False
assert r["out"] is None
print("CF_PHASE0_RTREC_PREFLIGHT=pass")
print("CF_PHASE0_RTREC_ATTEMPT="+attempt)
print("CF_PHASE0_RTREC_OPERATION="+operation)
print("CF_PHASE0_RTREC_DETAIL="+str(obs.get("detail")))
con.close()
PY

record="$agent_dir/$(printf '%s' "$attempt"|sha256sum|awk '{print $1}').json"
[[ -s "$record" ]]
python3 - "$record" "$attempt" <<'PY'
import json,sys
r=json.load(open(sys.argv[1])); attempt=sys.argv[2]
assert r.get("attemptId")==attempt
o=r.get("observation") or {}; e=o.get("evidence") or {}
safe={"state":r.get("state"),"observationState":o.get("state"),"detail":o.get("detail"),
      "effectSent":e.get("effectSent"),"nativeCompleted":e.get("nativeCompleted"),"nativeAction":e.get("nativeAction")}
print("CF_PHASE0_RTREC_AGENT="+json.dumps(safe,separators=(",",":"),sort_keys=True))
PY

python3 - "$attempt" <<'PY'
import json,sys,urllib.request
attempt=sys.argv[1]
body=json.dumps({"attemptId":attempt},separators=(",",":")).encode()
req=urllib.request.Request("http://127.0.0.1:8901/v1/reconcile",data=body,headers={"Content-Type":"application/json"},method="POST")
with urllib.request.urlopen(req,timeout=20) as r:
 data=json.loads(r.read().decode()); status=r.status
assert status==200
result=data["result"]; obs=result.get("observation") or {}; ev=obs.get("evidence") or {}
assert result.get("attemptId")==attempt and result.get("sameAttempt") is True and result.get("reexecuted") is False
safe={"attemptId":attempt,"sameAttempt":True,"reexecuted":False,"outcome":result.get("outcome"),
      "observation":{"ackState":obs.get("ackState"),"detail":obs.get("detail"),
                     "evidence":{k:ev.get(k) for k in ["effectSent","nativeCompleted","nativeAction","buildId","finalUrl"]}}}
print("CF_PHASE0_RTREC_RECONCILE="+json.dumps(safe,separators=(",",":"),sort_keys=True))
PY

python3 - "$release" <<'PY'
import pathlib,sys
root=pathlib.Path(sys.argv[1])
bn=(root/"server-deploy/current/browser-native.js").read_text()
b=(root/"server-deploy/current/browser.js").read_text()
fa=(root/"server-deploy/current/fabric-agent.js").read_text()
run=bn.index("export async function runNativeAction")
ensure=bn.index("const opened = await ensureTarget",run)
action=bn.index('if (action === "page.screenshot")',ensure)
ensuredef=bn.index("async function ensureTarget")
open_call=bn.index("await session.openDocument",ensuredef)
assert ensure < action and open_call > ensuredef
opendef=b.index("async openDocument")
auth=b.index("const auth = await this.proveAuthentication()",opendef)
throw=b.index('error.code = auth.state === "REJECTED" ? "SESSION_REJECTED" : "SESSION_UNKNOWN"',auth)
nav=b.index("const expectedUrl =",throw)
assert auth < throw < nav
claim=fa.index("this._writeRecord(claimed);",fa.index("async execute(dispatchInput)"))
effect=fa.index("observed = await this._executeOnce",claim)
assert claim < effect
print("CF_PHASE0_RTREC_PRE_EFFECT_ORDER=pass")
print("CF_PHASE0_RTREC_PERSIST_BEFORE_EFFECT=pass")
PY

PYTHONPATH="$release/src" python3 - "$db" "$attempt" "$operation" <<'PY'
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
    assert dict(case.invocation.arguments).get("action")=="page.evaluate"
    outcome=Outcome(operation,OutcomeState.ABSENT,
      "Proven pre-effect authentication fence: runNativeAction calls ensureTarget/openDocument first; openDocument emitted SESSION_UNKNOWN before native page.evaluate dispatch.")
    state.record_outcome(case.operation,outcome)
    state.append("operation.reconciled.proven_absent_pre_effect",operation,{
      "attempt_id":attempt,"same_attempt":True,"reexecuted":False,
      "proof":"SESSION_UNKNOWN at openDocument authentication fence precedes runNativeAction action body; agent Attempt persistence precedes execution",
    })
print("CF_PHASE0_RTREC_OUTCOME=ABSENT")
print("CF_PHASE0_RTREC_REEXECUTED=false")
PY

PYTHONPATH="$release/src" python3 - "$db" "$attempt" <<'PY'
import sys
from capability_fabric.persistence import SqliteExecutionStateStore
db,attempt=sys.argv[1:]
with SqliteExecutionStateStore(db) as state:
    assert all(c.attempt is None or c.attempt.attempt_id!=attempt for c in state.recoverable())
print("CF_PHASE0_RTREC_READBACK=pass")
PY
echo CF_PHASE0_RTREC=pass
