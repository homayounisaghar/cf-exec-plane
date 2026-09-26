#!/usr/bin/env bash
set -euo pipefail
umask 077
[[ "$(id -u)" -eq 0 ]] || exit 2

candidate="dbb08f8257b4e72e31e203497fa135acdeda5e5b"
fixture="a19e0fa5152af9f7ce106b6e:e5e7d0173fd1f1d0307a2cb6:e0929361aadb6135b5cecffa"
attempt="attempt:465388f7-f1c7-4e99-b7a2-c8efa4d09d21"
operation="operation:f21fab3d-07f3-4f07-9683-8397d8655d8e"
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
print("CF_PHASE0_SESSION_RECON_PRODUCTION_FAILCLOSED=pass")
PY

[[ "$(docker inspect -f '{{.State.Running}}' "$research")" == true ]]
[[ "$(docker inspect -f '{{.State.Health.Status}}' "$research")" == healthy ]]
env_dump="$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$research")"
grep -Fxq "CF_RESEARCH_SOURCE_COMMIT=$candidate" <<<"$env_dump"
grep -Fxq "CF_RESEARCH_FIXTURE_TARGET=$fixture" <<<"$env_dump"
echo CF_PHASE0_SESSION_RECON_BINDING=pass

python3 - "$release/server-deploy/current/browser-native.js" "$release/server-deploy/current/browser.js" <<'PY'
import sys
native=open(sys.argv[1],encoding="utf-8").read()
browser=open(sys.argv[2],encoding="utf-8").read()

run=native.index("export async function runNativeAction")
ensure=native.index("const opened = await ensureTarget",run)
eval_branch=native.index('action === "page.evaluate"',ensure)
assert ensure < eval_branch

et=native.index("async function ensureTarget")
open_call=native.index("session.openDocument",et)
assert et < open_call

od=browser.index("async openDocument(")
auth=browser.index("const auth = await this.proveAuthentication()",od)
reject=browser.index('"SESSION_REJECTED"',auth)
expected=browser.index("const expectedUrl =",reject)
goto=browser.index("await this.page.goto",expected)
assert auth < reject < expected < goto
print("CF_PHASE0_SESSION_RECON_SOURCE_ORDER=pass")
print("CF_PHASE0_SESSION_RECON_BASIS=auth-check-before-target-navigation-and-native-action")
PY

python3 - "$db" "$agent_dir" "$attempt" "$operation" <<'PY'
import datetime,hashlib,json,os,pathlib,sqlite3,sys
from capability_fabric.domain import AckState, Outcome, OutcomeState
from capability_fabric.persistence import SqliteExecutionStateStore

db,agent_dir,attempt,operation=sys.argv[1:]
with SqliteExecutionStateStore(db) as state:
    cases=[c for c in state.recoverable() if c.attempt is not None and c.attempt.attempt_id==attempt]
    assert len(cases)==1, len(cases)
    case=cases[0]
    assert case.operation is not None and case.operation.operation_id==operation
    assert case.observation is not None and case.observation.ack_state is AckState.UNKNOWN
    assert "SESSION_REJECTED" in str(case.observation.detail or "")
    assert case.invocation.requirement_id=="requirement:onshape.ui.native"
    args=dict(case.invocation.arguments)
    assert args.get("action")=="page.evaluate"

    state.record_outcome(case.operation, Outcome(
        operation,
        OutcomeState.ABSENT,
        "Proven pre-effect rejection: research authentication was SESSION_REJECTED in openDocument before target navigation and before the page.evaluate native action branch.",
    ))
    state.append("operation.reconciled.proven_absent_pre_effect",operation,{
        "attempt_id":attempt,
        "same_attempt":True,
        "reexecuted":False,
        "proof":"runNativeAction ensureTarget -> openDocument auth check; SESSION_REJECTED precedes page navigation and page.evaluate action",
    })

root=pathlib.Path(agent_dir)
record=root/(hashlib.sha256(attempt.encode()).hexdigest()+".json")
assert record.is_file(), record
raw=record.read_bytes()
v=json.loads(raw)
assert v.get("attemptId")==attempt and v.get("operationId")==operation
obs=v.get("observation") or {}
assert v.get("state")=="UNCERTAIN"
assert obs.get("state")=="UNCERTAIN"
assert "SESSION_REJECTED" in str(obs.get("detail") or "")
ev=obs.get("evidence") or {}
assert ev.get("nativeAction")=="page.evaluate"
assert ev.get("nativeCompleted") is False
assert ev.get("effectSent") is None

audit_dir=root/"reconciliation-audit"
audit_dir.mkdir(mode=0o700,exist_ok=True)
os.chmod(audit_dir,0o700)
sha=hashlib.sha256(raw).hexdigest()
audit_path=audit_dir/(record.name+".pre-reconcile.json")
audit={
 "schema":"capability-fabric.vps-agent-reconciliation-audit.v1",
 "attemptId":attempt,"operationId":operation,
 "originalRecordSha256":sha,"originalRecord":v,
 "proof":{
   "classification":"PROVEN_PRE_EFFECT_AUTH_REJECTION",
   "basis":"SESSION_REJECTED in openDocument before target navigation and page.evaluate branch",
   "reexecuted":False
 }
}
encoded=json.dumps(audit,sort_keys=True,separators=(",",":")).encode()
if audit_path.exists():
    assert audit_path.read_bytes()==encoded
else:
    tmp=audit_path.with_name(audit_path.name+".tmp")
    tmp.write_bytes(encoded); os.chmod(tmp,0o600); os.replace(tmp,audit_path)

new=dict(v)
new["state"]="REJECTED"
new["updatedAt"]=datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00","Z")
new["reconciliation"]={
 "classification":"PROVEN_PRE_EFFECT_AUTH_REJECTION",
 "fabricOutcome":"ABSENT",
 "originalRecordSha256":sha,
 "basis":"SESSION_REJECTED before target navigation and page.evaluate",
 "reexecuted":False
}
new_obs=dict(obs)
new_obs["state"]="REJECTED"
new_obs["detail"]="reconciled proven pre-effect rejection: SESSION_REJECTED before native action"
new_ev=dict(ev)
new_ev["effectSent"]=False
new_ev["nativeCompleted"]=False
new_ev["reconciledFromState"]="UNCERTAIN"
new_ev["reconciliationBasis"]="auth-check-before-target-navigation-and-native-action"
new_ev["reexecuted"]=False
new_obs["evidence"]=new_ev
new["observation"]=new_obs
payload=json.dumps(new,separators=(",",":")).encode()
tmp=record.with_name(record.name+".tmp")
tmp.write_bytes(payload); os.chmod(tmp,0o600); os.replace(tmp,record)
os.chmod(record,0o600)

check=json.loads(record.read_text())
assert check["state"]=="REJECTED"
assert check["observation"]["evidence"]["effectSent"] is False
assert check["observation"]["evidence"]["reexecuted"] is False
print("CF_PHASE0_SESSION_RECON_ATTEMPT="+attempt)
print("CF_PHASE0_SESSION_RECON_OUTCOME=ABSENT")
print("CF_PHASE0_SESSION_RECON_EFFECT_SENT=false")
print("CF_PHASE0_SESSION_RECON_REEXECUTED=false")
PY

PYTHONPATH="$release/server-deploy/current/fabric-src" python3 - "$db" <<'PY'
import sys
from capability_fabric.persistence import SqliteExecutionStateStore
with SqliteExecutionStateStore(sys.argv[1]) as state:
    pending=state.recoverable()
    assert not pending, [(x.operation.operation_id if x.operation else None,x.attempt.attempt_id if x.attempt else None) for x in pending]
print("CF_PHASE0_SESSION_RECON_RECOVERABLE=zero")
PY
echo CF_PHASE0_SESSION_RECON=pass
