#!/usr/bin/env bash
set -euo pipefail
umask 077

[[ "$(id -u)" -eq 0 ]] || { echo "CF_INDOUBT_METADATA_REQUIRES_ROOT" >&2; exit 2; }

current="$(readlink -f /opt/capability-fabric/current)"
[[ "$current" == /var/lib/capability-fabric/releases/* ]] || exit 20
control=/var/lib/capability-fabric/onshape/runtime-control/ONSHAPE_RUNTIME_CONTROL.json
[[ -s "$control" ]] || exit 21
python3 - "$control" <<'PY'
import json,sys
r=json.load(open(sys.argv[1]))
a=r["authority"]
assert r["controlRevision"] == 529, r["controlRevision"]
assert r["lease"]["state"] == "FREE", r["lease"]
assert a["productionEpoch"] == 1, a
assert a["mode"] == "ANDROID_PRODUCTION", a
assert a["materialAuthority"] == "android-v1", a
assert a["planes"]["vps-fabric"]["materialEffectsAllowed"] is False, a
print("CF_INDOUBT_METADATA_AUTHORITY=android-epoch1")
print("CF_INDOUBT_METADATA_LEASE=FREE")
PY

db=/var/lib/capability-fabric/onshape/fabric-state/execution.sqlite3
agent_dir=/var/lib/capability-fabric/onshape/fabric-agent
[[ -s "$db" ]] || exit 22

python3 - "$db" "$agent_dir" <<'PY'
import hashlib,json,pathlib,re,sqlite3,sys

db,agent_dir=sys.argv[1],pathlib.Path(sys.argv[2])
attempt_id="attempt:f6d80f46-b4ff-4798-9848-9b0b28bca1b8"
operation_id="operation:3cbb9823-a285-4d55-9cdc-cf57a2cb0cd2"
invocation_id="invocation:9e14dc26-50bc-4b3d-a265-171f96b9231d"

c=sqlite3.connect(f"file:{db}?mode=ro",uri=True)
c.row_factory=sqlite3.Row
try:
    row=c.execute("""
      SELECT i.payload AS invocation_payload,i.dispatch_payload,i.phase,
             o.payload AS operation_payload,o.state AS operation_state,
             a.payload AS attempt_payload,a.state AS attempt_state,a.observation_payload
      FROM invocations i
      JOIN operations o ON o.invocation_id=i.invocation_id
      JOIN attempts a ON a.operation_id=o.operation_id
      WHERE i.invocation_id=? AND o.operation_id=? AND a.attempt_id=?
    """,(invocation_id,operation_id,attempt_id)).fetchone()
    assert row is not None
    inv=json.loads(row["invocation_payload"])
    dispatch=json.loads(row["dispatch_payload"])
    op=json.loads(row["operation_payload"])
    assert inv["invocation_id"]==invocation_id
    assert op["operation_id"]==operation_id
    ep=dispatch.get("execution_payload") or dispatch.get("executionPayload") or {}
    args=ep.get("args") if isinstance(ep,dict) else None
    assert isinstance(args,dict)
    did=str(args.get("documentId",""))
    wid=str(args.get("workspaceId",""))
    eid=str(args.get("elementId",""))
    assert all(re.fullmatch(r"[0-9a-fA-F]{24}",x) for x in (did,wid,eid))
    target=str(op.get("target_id") or op.get("targetId") or inv.get("target_id") or inv.get("targetId") or "")
    expected=f"onshape:document:{did}:workspace:{wid}:element:{eid}"
    assert target==expected, (target,expected)

    steps=args.get("steps")
    assert isinstance(steps,list) and len(steps)==4
    actions=[str(s.get("action","")) for s in steps if isinstance(s,dict)]
    assert actions==["locator.fill","locator.press","locator.fill","locator.press"]

    selectors=[str(s.get("selector","")) for s in steps if isinstance(s,dict)]
    joined="\n".join(selectors).lower()
    auth=any(tok in joined for tok in [
      "password","passwd","username","email","signin","sign-in","login",
      "current-password","autocomplete=\"email\"","autocomplete='email'"
    ])
    dialog=any(tok in joined for tok in [
      "role=dialog","role=\"dialog\"","role='dialog'","aria-modal","modal","dialog"
    ])
    if auth:
        surface="AUTHENTICATION"
    elif dialog:
        surface="DIALOG"
    else:
        surface="DOCUMENT_CONTENT"
    print("CF_INDOUBT_TARGET_SURFACE="+surface)
    print("CF_INDOUBT_TARGET_DOCUMENT_ID="+did)
    print("CF_INDOUBT_TARGET_WORKSPACE_ID="+wid)
    print("CF_INDOUBT_TARGET_ELEMENT_ID="+eid)
    print("CF_INDOUBT_TARGET_BINDING=exact-document-workspace-element")
    print("CF_INDOUBT_TARGET_ACTIONS="+"->".join(actions))
    print("CF_INDOUBT_TARGET_SELECTOR_COUNT="+str(len(selectors)))

    name=hashlib.sha256(attempt_id.encode()).hexdigest()+".json"
    p=agent_dir/name
    assert p.is_file(), p
    agent=json.loads(p.read_text())
    assert agent.get("attemptId")==attempt_id
    print("CF_INDOUBT_ATTEMPT_CREATED_AT="+str(agent.get("createdAt")))
    print("CF_INDOUBT_ATTEMPT_UPDATED_AT="+str(agent.get("updatedAt")))
    print("CF_INDOUBT_AGENT_STATE="+str(agent.get("state")))
finally:
    c.close()
PY

echo CF_INDOUBT_METADATA=pass
