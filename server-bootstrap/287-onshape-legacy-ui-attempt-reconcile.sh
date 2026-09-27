#!/usr/bin/env bash
set -euo pipefail
umask 077
[[ "$(id -u)" -eq 0 ]] || exit 2

attempt="attempt:f6d80f46-b4ff-4798-9848-9b0b28bca1b8"
operation="operation:3cbb9823-a285-4d55-9cdc-cf57a2cb0cd2"
target_did="84d077d8370c21c4b3045263"
target_wid="aa8c5ad631e1836645149d09"
target_eid="7fde3930aaf98b87b30b63ed"
db="/var/lib/capability-fabric/onshape/fabric-state/execution.sqlite3"
active="/opt/capability-fabric/current"
control="/var/lib/capability-fabric/onshape/runtime-control/ONSHAPE_RUNTIME_CONTROL.json"
agent_dir="/var/lib/capability-fabric/onshape/fabric-agent"

python3 - "$control" <<'PY'
import json,sys
d=json.load(open(sys.argv[1])); a=d["authority"]; g=a["productionGuard"]
assert d["lease"]["state"]=="FREE"
assert a["mode"]=="VPS_PRODUCTION" and a["materialAuthority"]=="vps-fabric"
assert a["reconciliationHold"]["active"] is False
assert g["killSwitch"]=="ENGAGED" and g["allowedDocumentIds"]==[]
assert g["mutationBudget"]["maxMutations"]==0
print("CF_LEGACY_UI_RECON_AUTHORITY=pass")
PY

# Capture authoritative current durable case and exact old agent record before any state mutation.
PYTHONPATH="$active/fabric-src" python3 - "$db" "$attempt" "$operation" "$target_did" "$target_wid" "$target_eid" "$agent_dir" <<'PY'
import hashlib,json,sys
from pathlib import Path
from capability_fabric.domain import AckState, RecoveryDisposition
from capability_fabric.persistence import SqliteExecutionStateStore

db,attempt,operation,did,wid,eid,agent_dir=sys.argv[1:]
with SqliteExecutionStateStore(db) as state:
    cases=[c for c in state.recoverable() if c.attempt is not None and c.attempt.attempt_id==attempt]
    assert len(cases)==1
    c=cases[0]
    assert c.disposition is RecoveryDisposition.RECONCILIATION_PENDING
    assert c.operation is not None and c.operation.operation_id==operation
    assert c.operation.effect=="onshape.ui.input.sequence.mutation_risk"
    assert c.operation.target_id==f"onshape:document:{did}:workspace:{wid}:element:{eid}"
    assert c.observation is not None and c.observation.ack_state is AckState.UNKNOWN
    assert "TimeoutError" in str(c.observation.detail or "")
    assert c.observation.evidence.get("sequenceCompleted") is False
    assert c.observation.evidence.get("effectSent") is None

    args=dict(c.invocation.arguments)
    assert args["documentId"]==did and args["workspaceId"]==wid and args["elementId"]==eid
    steps=list(args["steps"])
    assert len(steps)==4
    expected=[
      ("locator.fill","role=textbox >> nth=1","30 mm",None),
      ("locator.press","role=textbox >> nth=1",None,"Enter"),
      ("locator.fill","role=textbox >> nth=2","6",None),
      ("locator.press","role=textbox >> nth=2",None,"Enter"),
    ]
    for step,exp in zip(steps,expected):
        action,selector,value,key=exp
        assert step.get("action")==action and step.get("selector")==selector
        if value is not None: assert step.get("value")==value
        if key is not None: assert step.get("key")==key

record=Path(agent_dir)/(hashlib.sha256(attempt.encode()).hexdigest()+".json")
assert record.is_file()
r=json.loads(record.read_text())
assert r.get("attemptId")==attempt and r.get("operationId")==operation
assert r.get("state")=="UNCERTAIN"
assert not r.get("budgetReservation") and not r.get("recovery")
obs=r.get("observation") or {}
assert obs.get("state")=="UNCERTAIN"
assert "TimeoutError" in str(obs.get("detail") or "")
e=obs.get("evidence") or {}
assert e.get("sequenceCompleted") is False and e.get("effectSent") is None

Path("/tmp/cf-legacy-ui-recon-times.json").write_text(json.dumps({
  "createdAt":r["createdAt"],"updatedAt":r["updatedAt"]
}))
print("CF_LEGACY_UI_RECON_CASE=exact")
PY

# Independent authoritative Onshape history read through the normal semantic sidecar.
python3 - "$target_did" "$target_wid" <<'PY'
import json,sys,urllib.request
did,wid=sys.argv[1:]
body=json.dumps({
  "capabilityId":"onshape.documented.operation",
  "arguments":{
    "operationId":"getDocumentHistory",
    "pathParams":{"did":did,"wm":"w","wmid":wid}
  }
},separators=(",",":")).encode()
req=urllib.request.Request(
  "http://127.0.0.1:8791/v1/invoke",
  data=body,
  headers={"Content-Type":"application/json"},
  method="POST",
)
with urllib.request.urlopen(req,timeout=30) as resp:
    data=json.load(resp)
result=data["result"]
obs=result["observation"]
assert obs["ackState"]=="ACKNOWLEDGED"
ev=obs["evidence"]
assert ev["httpStatus"]==200
history=ev["body"]
assert isinstance(history,list)
open("/tmp/cf-legacy-ui-recon-history.json","w").write(json.dumps(history))
print("CF_LEGACY_UI_RECON_HISTORY=read")
PY

python3 - /tmp/cf-legacy-ui-recon-times.json /tmp/cf-legacy-ui-recon-history.json <<'PY'
import datetime as dt,json,sys
times=json.load(open(sys.argv[1]))
history=json.load(open(sys.argv[2]))
def parse(s):
    return dt.datetime.fromisoformat(str(s).replace("Z","+00:00"))
start=parse(times["createdAt"]); end=parse(times["updatedAt"])
inside=[]
for item in history:
    when=parse(item["date"])
    if start <= when <= end:
        inside.append(item)
assert len(inside)==1, inside
event=inside[0]
assert event.get("description")=="Part Studio 1 :: Insert feature : Linear pattern 1"
assert str(event.get("microversionId") or "")=="e2cd3776b56ba5e1b4c665d8"
delta=(parse(event["date"])-start).total_seconds()
assert 0 <= delta <= 3
print("CF_LEGACY_UI_RECON_PARTIAL_EFFECT=proven")
print("CF_LEGACY_UI_RECON_EVENT="+json.dumps({
  "date":event["date"],
  "description":event["description"],
  "microversionId":event["microversionId"],
  "secondsAfterAttemptStart":round(delta,3),
},sort_keys=True,separators=(",",":")))
PY

# Backup durable Fabric state, then terminally classify this exact historical Attempt.
mkdir -p /var/lib/capability-fabric/onshape/fabric-state/backups
PYTHONPATH="$active/fabric-src" python3 - "$db" "$attempt" "$operation" <<'PY'
import sys
from pathlib import Path
from capability_fabric.domain import Outcome,OutcomeState,RecoveryDisposition
from capability_fabric.persistence import SqliteExecutionStateStore

db,attempt,operation=sys.argv[1:]
backup=Path("/var/lib/capability-fabric/onshape/fabric-state/backups")/"pre-seq74-legacy-ui-reconciliation.sqlite3"
with SqliteExecutionStateStore(db) as state:
    cases=[c for c in state.recoverable() if c.attempt is not None and c.attempt.attempt_id==attempt]
    assert len(cases)==1
    c=cases[0]
    assert c.disposition is RecoveryDisposition.RECONCILIATION_PENDING
    assert c.operation is not None and c.operation.operation_id==operation
    state.backup_to(backup)

basis=(
  "Authoritative Onshape document history proves a partial external UI effect "
  "(Insert feature: Linear pattern 1) inside this Attempt's execution window, "
  "while the finalized four-step UI sequence never produced complete execution evidence. "
  "The Attempt is terminally failed; no replay is authorized."
)
with SqliteExecutionStateStore(db) as state:
    cases=[c for c in state.recoverable() if c.attempt is not None and c.attempt.attempt_id==attempt]
    assert len(cases)==1
    c=cases[0]
    state.record_outcome(c.operation,Outcome(c.operation.operation_id,OutcomeState.FAILED,basis))
    state.append("operation.legacy_ui_input_forensic_closed",operation,{
      "attempt_id":attempt,
      "classification":"FAILED_PARTIAL_EXTERNAL_EFFECT",
      "authoritative_history_event":"Part Studio 1 :: Insert feature : Linear pattern 1",
      "blind_replay_allowed":False,
    })

with SqliteExecutionStateStore(db) as state:
    remaining=state.recoverable()
    assert all(c.attempt is None or c.attempt.attempt_id!=attempt for c in remaining)
    assert len(remaining)==0, [c.attempt.attempt_id if c.attempt else None for c in remaining]
    outcome=state.outcome_for(operation)
    assert outcome is not None and outcome.state is OutcomeState.FAILED
print("CF_LEGACY_UI_RECON_OUTCOME=FAILED_PARTIAL_EXTERNAL_EFFECT")
print("CF_LEGACY_UI_RECON_RECOVERABLE=zero")
PY

rm -f /tmp/cf-legacy-ui-recon-times.json /tmp/cf-legacy-ui-recon-history.json
echo CF_LEGACY_UI_RECONCILIATION=pass
