#!/usr/bin/env bash
set -euo pipefail
umask 077

[[ "$(id -u)" -eq 0 ]] || { echo "CF_ATTEMPT_CONTEXT_REQUIRES_ROOT" >&2; exit 2; }

release="$(readlink -f /opt/capability-fabric/current)"
[[ "$release" == /var/lib/capability-fabric/releases/* ]] || exit 20
control=/var/lib/capability-fabric/onshape/runtime-control/ONSHAPE_RUNTIME_CONTROL.json
db=/var/lib/capability-fabric/onshape/fabric-state/execution.sqlite3
agent_dir=/var/lib/capability-fabric/onshape/fabric-agent
[[ -s "$control" && -s "$db" ]] || exit 21

python3 - "$control" "$db" "$agent_dir" <<'PY'
import base64,hashlib,json,pathlib,re,sqlite3,sys,datetime

control_path,db_path,agent_dir=sys.argv[1],sys.argv[2],pathlib.Path(sys.argv[3])
attempt_id="attempt:f6d80f46-b4ff-4798-9848-9b0b28bca1b8"
operation_id="operation:3cbb9823-a285-4d55-9cdc-cf57a2cb0cd2"

control=json.load(open(control_path))
a=control["authority"]
assert control["controlRevision"] == 529
assert a["productionEpoch"] == 1
assert a["mode"] == "ANDROID_PRODUCTION"
assert a["materialAuthority"] == "android-v1"
assert a["planes"]["vps-fabric"]["materialEffectsAllowed"] is False
print("CF_ATTEMPT_CONTEXT_AUTHORITY=android-epoch1")

c=sqlite3.connect(f"file:{db_path}?mode=ro",uri=True)
c.row_factory=sqlite3.Row
try:
    row=c.execute("""
      SELECT i.invocation_id,i.payload AS invocation_payload,i.dispatch_payload,
             o.operation_id,o.payload AS operation_payload,o.state AS operation_state,
             a.attempt_id,a.state AS attempt_state,a.observation_payload
      FROM attempts a
      JOIN operations o ON o.operation_id=a.operation_id
      JOIN invocations i ON i.invocation_id=o.invocation_id
      WHERE a.attempt_id=?
    """,(attempt_id,)).fetchone()
    assert row is not None
    assert row["operation_id"] == operation_id
    inv=json.loads(row["invocation_payload"])
    dispatch=json.loads(row["dispatch_payload"])
    op=json.loads(row["operation_payload"])
    obs=json.loads(row["observation_payload"]) if row["observation_payload"] else {}
    execution=dispatch.get("execution_payload") or dispatch.get("executionPayload") or {}
    args=execution.get("args") if isinstance(execution,dict) else {}
    assert isinstance(args,dict)
    steps=args.get("steps")
    assert isinstance(steps,list) and len(steps)==4

    did=str(args.get("documentId") or "")
    wid=str(args.get("workspaceId") or "")
    eid=str(args.get("elementId") or "")
    hex24=re.compile(r"^[0-9a-fA-F]{24}$")
    exact_doc_target=all(hex24.fullmatch(v) for v in (did,wid,eid))

    # Classify privately from selectors/field semantics; never emit selector/text/value.
    strings=[]
    for step in steps:
        if not isinstance(step,dict):
            continue
        for key in ("selector","target_selector"):
            v=step.get(key)
            if isinstance(v,str):
                strings.append(v.lower())
        for key in ("text","value","key"):
            v=step.get(key)
            if isinstance(v,str):
                strings.append(v.lower())
    joined="\n".join(strings)
    auth_tokens=("password","email","login","log-in","sign in","signin","auth","verification","verify","otp")
    dialog_tokens=("dialog","modal","aria-modal","role=dialog","role=\"dialog\"")
    auth_hint=any(t in joined for t in auth_tokens)
    dialog_hint=any(t in joined for t in dialog_tokens)

    if auth_hint:
        context="AUTH"
    elif dialog_hint:
        context="DIALOG"
    elif exact_doc_target:
        context="DOCUMENT"
    else:
        context="UNKNOWN"

    print("CF_ATTEMPT_CONTEXT_CLASS="+context)
    print("CF_ATTEMPT_CONTEXT_AUTH_HINT="+str(auth_hint).lower())
    print("CF_ATTEMPT_CONTEXT_DIALOG_HINT="+str(dialog_hint).lower())
    print("CF_ATTEMPT_CONTEXT_EXACT_DOCUMENT_TARGET="+str(exact_doc_target).lower())
    if context=="DOCUMENT":
        print("CF_ATTEMPT_CONTEXT_DOCUMENT_ID="+did)
        print("CF_ATTEMPT_CONTEXT_WORKSPACE_ID="+wid)
        print("CF_ATTEMPT_CONTEXT_ELEMENT_ID="+eid)
    print("CF_ATTEMPT_CONTEXT_OPERATION_STATE="+str(row["operation_state"]))
    print("CF_ATTEMPT_CONTEXT_ATTEMPT_STATE="+str(row["attempt_state"]))
    print("CF_ATTEMPT_CONTEXT_OBSERVATION_DETAIL="+str(obs.get("detail") or ""))
    ev=obs.get("evidence") if isinstance(obs,dict) else {}
    ev=ev if isinstance(ev,dict) else {}
    print("CF_ATTEMPT_CONTEXT_COMPLETED_STEPS="+str(ev.get("completedSteps")))
    print("CF_ATTEMPT_CONTEXT_EFFECT_SENT="+str(ev.get("effectSent")))

    record_path=agent_dir/(hashlib.sha256(attempt_id.encode()).hexdigest()+".json")
    assert record_path.is_file()
    agent=json.loads(record_path.read_text())
    assert agent.get("attemptId")==attempt_id
    print("CF_ATTEMPT_CONTEXT_AGENT_STATE="+str(agent.get("state")))
    timestamps={}
    def walk(v,prefix=""):
        if isinstance(v,dict):
            for k,val in v.items():
                key=(prefix+"."+str(k)).strip(".")
                lk=str(k).lower()
                if isinstance(val,str) and any(tok in lk for tok in ("time","created","updated","started","completed","observed","finished","at")):
                    if re.match(r"^\d{4}-\d{2}-\d{2}T",val):
                        timestamps[key]=val
                walk(val,key)
        elif isinstance(v,list):
            for i,val in enumerate(v):
                walk(val,f"{prefix}[{i}]")
    walk(agent)
    if timestamps:
        for k in sorted(timestamps):
            enc=base64.b64encode(timestamps[k].encode()).decode()
            print("CF_ATTEMPT_CONTEXT_TIMESTAMP_B64="+k+"="+enc)
    else:
        st=record_path.stat()
        print("CF_ATTEMPT_CONTEXT_TIMESTAMP=agent_file_mtime="+datetime.datetime.fromtimestamp(st.st_mtime,datetime.timezone.utc).isoformat().replace("+00:00","Z"))
        print("CF_ATTEMPT_CONTEXT_TIMESTAMP_QUALITY=file-mtime-only")
finally:
    c.close()
PY

echo CF_ATTEMPT_CONTEXT=pass
