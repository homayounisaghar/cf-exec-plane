#!/usr/bin/env bash
set -euo pipefail
umask 077
[[ "$(id -u)" -eq 0 ]] || exit 2

control=/var/lib/capability-fabric/onshape/runtime-control/ONSHAPE_RUNTIME_CONTROL.json
db=/var/lib/capability-fabric/onshape/fabric-state/execution.sqlite3
agent_dir=/var/lib/capability-fabric/onshape/fabric-agent
active="$(readlink -f /opt/capability-fabric/current)"
[[ "$active" == /var/lib/capability-fabric/releases/* ]] || exit 20
[[ -s "$control" && -s "$db" ]] || exit 21

python3 - "$active/manifest.json" "$control" "$db" "$agent_dir" <<'PY'
import hashlib,json,pathlib,sqlite3,sys
manifest_path,control_path,db_path,agent_dir=sys.argv[1:]
m=json.load(open(manifest_path)); r=json.load(open(control_path)); a=r["authority"]
assert m["sequence"]==66 and m["release_id"]=="onshape-vps-hardened-production-r3"
assert r["controlRevision"]==530
assert r["lease"]["state"]=="FREE"
assert a["productionEpoch"]==2 and a["mode"]=="QUIESCED_RECONCILING"
assert a["materialAuthority"] is None
assert a["planes"]["android-v1"]["ingress"]=="CLOSED"
assert a["planes"]["vps-fabric"]["ingress"]=="CLOSED"

attempt_id="attempt:f6d80f46-b4ff-4798-9848-9b0b28bca1b8"
operation_id="operation:3cbb9823-a285-4d55-9cdc-cf57a2cb0cd2"
invocation_id="invocation:9e14dc26-50bc-4b3d-a265-171f96b9231d"

c=sqlite3.connect(f"file:{db_path}?mode=ro",uri=True); c.row_factory=sqlite3.Row
try:
    row=c.execute("""
      SELECT i.dispatch_payload,o.state AS operation_state,
             a.state AS attempt_state,a.observation_payload
      FROM invocations i JOIN operations o ON o.invocation_id=i.invocation_id
      JOIN attempts a ON a.operation_id=o.operation_id
      WHERE i.invocation_id=? AND o.operation_id=? AND a.attempt_id=?
    """,(invocation_id,operation_id,attempt_id)).fetchone()
    assert row is not None
    dispatch=json.loads(row["dispatch_payload"])
    ep=dispatch.get("execution_payload") or dispatch.get("executionPayload") or {}
    args=ep.get("args") if isinstance(ep,dict) else {}
    steps=args.get("steps")
    assert isinstance(steps,list) and len(steps)==4
    selectors=[str(s.get("selector","")) for s in steps]
    actions=[str(s.get("action","")) for s in steps]
    obs=json.loads(row["observation_payload"]) if row["observation_payload"] else {}
    detail=str(obs.get("detail") or "")
    low=detail.lower()

    matches=[i for i,s in enumerate(selectors) if s and s in detail]
    if len(matches)==1:
        locus=f"STEP{matches[0]}"
    elif len(matches)>1:
        # If fill+press share one selector, report the first unique failing selector group.
        groups=[]
        for i in matches:
            if not groups or selectors[i]!=selectors[groups[-1]]:
                groups.append(i)
        locus=f"STEP{groups[-1]}" if len(groups)==1 else "MULTI_SELECTOR_MATCH"
    else:
        # Playwright often renders locator(selector) with quoting/escaping differences.
        compact=lambda x:"".join(x.lower().split())
        dcompact=compact(detail)
        cm=[i for i,s in enumerate(selectors) if s and compact(s) in dcompact]
        locus=f"STEP{cm[0]}" if len(cm)==1 else ("MULTI_SELECTOR_MATCH" if len(cm)>1 else "UNKNOWN")

    timeout=any(t in low for t in ("timeouterror","timeout","exceeded"))
    fill_hint="locator.fill" in low or "fill(" in low
    press_hint="locator.press" in low or "press(" in low

    record=pathlib.Path(agent_dir)/(hashlib.sha256(attempt_id.encode()).hexdigest()+".json")
    agent=json.loads(record.read_text()) if record.is_file() else {}
    aobs=agent.get("observation") if isinstance(agent,dict) else {}
    if not isinstance(aobs,dict): aobs={}
    evidence=aobs.get("evidence") if isinstance(aobs.get("evidence"),dict) else {}
    completed=evidence.get("completedSteps")

    print("CF_FAILURE_LOCUS="+locus)
    print("CF_FAILURE_TIMEOUT="+("yes" if timeout else "no"))
    print("CF_FAILURE_FILL_HINT="+("yes" if fill_hint else "no"))
    print("CF_FAILURE_PRESS_HINT="+("yes" if press_hint else "no"))
    print("CF_FAILURE_DETAIL_PRESENT="+("yes" if bool(detail) else "no"))
    print("CF_FAILURE_AGENT_STATE="+str(agent.get("state")))
    print("CF_FAILURE_COMPLETED_STEPS="+("unknown" if completed is None else str(completed)))
    print("CF_FAILURE_OPERATION_STATE="+str(row["operation_state"]))
    print("CF_FAILURE_ATTEMPT_STATE="+str(row["attempt_state"]))
finally:
    c.close()
PY

echo CF_FAILURE_LOCUS_PROBE=pass
