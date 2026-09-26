#!/usr/bin/env bash
set -euo pipefail
umask 077
[[ "$(id -u)" -eq 0 ]] || exit 2

candidate="c0cadee962c2059ba939c40c6bb9adf1bc99edfe"
attempt="attempt:f4762dd8-7c05-4b5f-a13f-7c7e1cd4bd14"
operation="operation:ebf8b8d7-6896-4b63-98c4-e0deb7b8bf5d"
fixture="a19e0fa5152af9f7ce106b6e:e5e7d0173fd1f1d0307a2cb6:e0929361aadb6135b5cecffa"
root="/var/lib/capability-fabric/onshape-research-phase0"
release="$root/releases/$candidate"
db="$root/fabric-state/execution.sqlite3"
agent_dir="$root/fabric-agent"
control="/var/lib/capability-fabric/onshape/runtime-control/ONSHAPE_RUNTIME_CONTROL.json"
research="capability-fabric-onshape-phase0-research"

python3 - "$control" <<'PY'
import json,sys
d=json.load(open(sys.argv[1])); a=d["authority"]; g=a["productionGuard"]
assert a["mode"]=="VPS_PRODUCTION" and a["materialAuthority"]=="vps-fabric"
assert a["planes"]["android-v1"]["ingress"]=="CLOSED"
assert a["planes"]["android-v1"]["materialEffectsAllowed"] is False
assert a["reconciliationHold"]["active"] is False
assert g["killSwitch"]=="ENGAGED" and g["allowedDocumentIds"]==[] and g["mutationBudget"]["maxMutations"]==0
print("CF_PHASE0_EDGERECON_PRODUCTION_FAILCLOSED=pass")
print("CF_PHASE0_EDGERECON_CONTROL_REV="+str(d["controlRevision"]))
print("CF_PHASE0_EDGERECON_EPOCH="+str(a["productionEpoch"]))
PY

[[ "$(docker inspect -f '{{.State.Running}}' "$research")" == true ]]
[[ "$(docker inspect -f '{{.State.Health.Status}}' "$research")" == healthy ]]
env_dump="$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$research")"
grep -Fxq "CF_RESEARCH_SOURCE_COMMIT=$candidate" <<<"$env_dump"
grep -Fxq "CF_RESEARCH_FIXTURE_TARGET=$fixture" <<<"$env_dump"
echo CF_PHASE0_EDGERECON_BINDING=pass

python3 - "$db" "$attempt" "$operation" <<'PY'
import json,sqlite3,sys
db,attempt,operation=sys.argv[1:]
con=sqlite3.connect(f"file:{db}?mode=ro",uri=True); con.row_factory=sqlite3.Row
rows=con.execute("""
SELECT i.phase,i.payload ip,o.payload op,o.state os,o.outcome_payload out,
       a.payload ap,a.state ast,a.observation_payload ob
FROM invocations i
JOIN operations o ON o.invocation_id=i.invocation_id
JOIN attempts a ON a.operation_id=o.operation_id
WHERE a.payload LIKE ?
""",("%"+attempt+"%",)).fetchall()
assert len(rows)==1, len(rows)
r=rows[0]; inv=json.loads(r["ip"]); op=json.loads(r["op"]); att=json.loads(r["ap"]); obs=json.loads(r["ob"])
assert op["operation_id"]==operation and att["attempt_id"]==attempt
assert inv["requirement_id"]=="requirement:onshape.ui.native"
assert inv["arguments"]["action"]=="runtime.viewer"
assert r["os"]=="IN_FLIGHT" and r["ast"]=="OBSERVED"
assert obs["ack_state"]=="UNKNOWN"
assert "SESSION_UNKNOWN" in str(obs.get("detail"))
ev=obs.get("evidence") or {}
assert ev.get("nativeAction")=="runtime.viewer"
assert ev.get("nativeCompleted") is False
assert ev.get("effectSent") is None
assert r["out"] is None
print("CF_PHASE0_EDGERECON_PREFLIGHT=pass")
print("CF_PHASE0_EDGERECON_ATTEMPT="+attempt)
print("CF_PHASE0_EDGERECON_OPERATION="+operation)
print("CF_PHASE0_EDGERECON_DETAIL="+str(obs.get("detail")))
con.close()
PY

record="$agent_dir/$(printf '%s' "$attempt"|sha256sum|awk '{print $1}').json"
[[ -s "$record" ]]
python3 - "$record" "$attempt" "$operation" <<'PY'
import json,sys
r=json.load(open(sys.argv[1])); attempt,operation=sys.argv[2:]
assert r.get("attemptId")==attempt and r.get("operationId")==operation
o=r.get("observation") or {}; e=o.get("evidence") or {}
assert r.get("state")=="UNCERTAIN"
assert "SESSION_UNKNOWN" in str(o.get("detail") or "")
assert e.get("nativeAction")=="runtime.viewer"
assert e.get("nativeCompleted") is False
assert e.get("effectSent") is None
safe={"state":r.get("state"),"observationState":o.get("state"),"detail":o.get("detail"),
      "effectSent":e.get("effectSent"),"nativeCompleted":e.get("nativeCompleted"),"nativeAction":e.get("nativeAction")}
print("CF_PHASE0_EDGERECON_AGENT="+json.dumps(safe,separators=(",",":"),sort_keys=True))
PY

python3 - "$attempt" <<'PY'
import json,sys,urllib.request,urllib.error
attempt=sys.argv[1]
body=json.dumps({"attemptId":attempt},separators=(",",":")).encode()
req=urllib.request.Request("http://127.0.0.1:8901/v1/reconcile",data=body,headers={"Content-Type":"application/json"},method="POST")
try:
    with urllib.request.urlopen(req,timeout=20) as r:
        data=json.loads(r.read().decode()); status=r.status
except urllib.error.HTTPError as e:
    raw=e.read().decode(errors="replace"); status=e.code
    print("CF_PHASE0_EDGERECON_HTTP="+str(status))
    print("CF_PHASE0_EDGERECON_ERROR="+raw[:2000])
    raise
assert status==200
result=data["result"]; obs=result.get("observation") or {}; ev=obs.get("evidence") or {}
assert result.get("attemptId")==attempt
assert result.get("sameAttempt") is True
assert result.get("reexecuted") is False
safe={"attemptId":attempt,"sameAttempt":True,"reexecuted":False,"outcome":result.get("outcome"),
      "observation":{"ackState":obs.get("ackState"),"detail":obs.get("detail"),
                     "evidence":{k:ev.get(k) for k in ["effectSent","nativeCompleted","nativeAction","buildId","finalUrl"]}}}
print("CF_PHASE0_EDGERECON_RECONCILE="+json.dumps(safe,separators=(",",":"),sort_keys=True))
PY

python3 - "$release/server-deploy/current/browser-native.js" "$release/server-deploy/current/browser.js" "$release/server-deploy/current/fabric-agent.js" <<'PY'
import sys
native=open(sys.argv[1],encoding="utf-8").read()
browser=open(sys.argv[2],encoding="utf-8").read()
agent=open(sys.argv[3],encoding="utf-8").read()
run=native.index("export async function runNativeAction")
ensure=native.index("const opened = await ensureTarget",run)
viewer=native.index('action === "runtime.viewer"',ensure)
assert ensure < viewer
et=native.index("async function ensureTarget")
open_call=native.index("session.openDocument",et)
assert et < open_call
od=browser.index("async openDocument(")
auth=browser.index("const auth = await this.proveAuthentication()",od)
unknown=browser.index('"SESSION_UNKNOWN"',auth)
expected=browser.index("const expectedUrl =",unknown)
goto=browser.index("await this.page.goto",expected)
assert auth < unknown < expected < goto
claim=agent.index("this._writeRecord(claimed);",agent.index("async execute(dispatchInput)"))
effect=agent.index("observed = await this._executeOnce",claim)
assert claim < effect
print("CF_PHASE0_EDGERECON_PRE_EFFECT_ORDER=pass")
print("CF_PHASE0_EDGERECON_PERSIST_BEFORE_EFFECT=pass")
PY

PYTHONPATH="$release/server-deploy/current/fabric-src" python3 - "$db" "$attempt" "$operation" "$record" <<'PY'
import datetime,hashlib,json,os,pathlib,sys
from capability_fabric.domain import AckState,Outcome,OutcomeState
from capability_fabric.persistence import SqliteExecutionStateStore

db,attempt,operation,record_path=sys.argv[1:]
with SqliteExecutionStateStore(db) as state:
    cases=[c for c in state.recoverable() if c.attempt is not None and c.attempt.attempt_id==attempt]
    assert len(cases)==1, len(cases)
    case=cases[0]
    assert case.operation is not None and case.operation.operation_id==operation
    assert case.observation is not None and case.observation.ack_state is AckState.UNKNOWN
    assert case.invocation.requirement_id=="requirement:onshape.ui.native"
    assert dict(case.invocation.arguments).get("action")=="runtime.viewer"
    outcome=Outcome(operation,OutcomeState.ABSENT,
      "Proven pre-effect authentication fence: runNativeAction calls ensureTarget/openDocument first; SESSION_UNKNOWN occurred before runtime.viewer dispatch.")
    state.record_outcome(case.operation,outcome)
    state.append("operation.reconciled.proven_absent_pre_effect",operation,{
      "attempt_id":attempt,"same_attempt":True,"reexecuted":False,
      "proof":"SESSION_UNKNOWN at openDocument authentication fence precedes runtime.viewer action body; agent Attempt persistence precedes execution",
    })

record=pathlib.Path(record_path)
raw=record.read_bytes(); v=json.loads(raw)
assert v.get("attemptId")==attempt and v.get("operationId")==operation
obs=v.get("observation") or {}; ev=obs.get("evidence") or {}
assert v.get("state")=="UNCERTAIN" and "SESSION_UNKNOWN" in str(obs.get("detail") or "")
assert ev.get("effectSent") is None and ev.get("nativeCompleted") is False and ev.get("nativeAction")=="runtime.viewer"

audit_dir=record.parent/"reconciliation-audit"
audit_dir.mkdir(mode=0o700,exist_ok=True); os.chmod(audit_dir,0o700)
sha=hashlib.sha256(raw).hexdigest()
audit_path=audit_dir/(record.name+".pre-reconcile.json")
audit={"schema":"capability-fabric.vps-agent-reconciliation-audit.v1","attemptId":attempt,"operationId":operation,
       "originalRecordSha256":sha,"originalRecord":v,
       "proof":{"classification":"PROVEN_PRE_EFFECT_SESSION_UNKNOWN","basis":"openDocument authentication fence precedes runtime.viewer dispatch","reexecuted":False}}
encoded=json.dumps(audit,sort_keys=True,separators=(",",":")).encode()
if audit_path.exists(): assert audit_path.read_bytes()==encoded
else:
    tmp=audit_path.with_name(audit_path.name+".tmp"); tmp.write_bytes(encoded); os.chmod(tmp,0o600); os.replace(tmp,audit_path)

new=dict(v); new["state"]="REJECTED"
new["updatedAt"]=datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00","Z")
new["reconciliation"]={"classification":"PROVEN_PRE_EFFECT_SESSION_UNKNOWN","fabricOutcome":"ABSENT",
                       "originalRecordSha256":sha,"basis":"authentication fence before runtime.viewer","reexecuted":False}
new_obs=dict(obs); new_obs["state"]="REJECTED"
new_obs["detail"]="reconciled proven pre-effect SESSION_UNKNOWN before runtime.viewer"
new_ev=dict(ev); new_ev["effectSent"]=False; new_ev["nativeCompleted"]=False
new_ev["reconciledFromState"]="UNCERTAIN"; new_ev["reconciliationBasis"]="auth-fence-before-runtime.viewer"; new_ev["reexecuted"]=False
new_obs["evidence"]=new_ev; new["observation"]=new_obs
payload=json.dumps(new,separators=(",",":")).encode()
tmp=record.with_name(record.name+".tmp"); tmp.write_bytes(payload); os.chmod(tmp,0o600); os.replace(tmp,record); os.chmod(record,0o600)
check=json.loads(record.read_text())
assert check["state"]=="REJECTED" and check["observation"]["evidence"]["effectSent"] is False
print("CF_PHASE0_EDGERECON_OUTCOME=ABSENT")
print("CF_PHASE0_EDGERECON_EFFECT_SENT=false")
print("CF_PHASE0_EDGERECON_REEXECUTED=false")
PY

PYTHONPATH="$release/server-deploy/current/fabric-src" python3 - "$db" "$attempt" <<'PY'
import sys
from capability_fabric.persistence import SqliteExecutionStateStore
db,attempt=sys.argv[1:]
with SqliteExecutionStateStore(db) as state:
    assert all(c.attempt is None or c.attempt.attempt_id!=attempt for c in state.recoverable())
print("CF_PHASE0_EDGERECON_READBACK=pass")
PY

echo CF_PHASE0_EDGERECON=pass
