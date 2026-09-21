#!/usr/bin/env bash
set -euo pipefail
umask 077
[[ "$(id -u)" -eq 0 ]] || exit 2

control=/var/lib/capability-fabric/onshape/runtime-control/ONSHAPE_RUNTIME_CONTROL.json
db=/var/lib/capability-fabric/onshape/fabric-state/execution.sqlite3
active="$(readlink -f /opt/capability-fabric/current)"
[[ "$active" == /var/lib/capability-fabric/releases/* ]] || exit 20
[[ -s "$control" && -s "$db" ]] || exit 21

python3 - "$active/manifest.json" "$control" "$db" <<'PY'
import json,re,sqlite3,sys

manifest_path,control_path,db_path=sys.argv[1:]
m=json.load(open(manifest_path))
r=json.load(open(control_path))
a=r["authority"]
assert m["sequence"]==66 and m["release_id"]=="onshape-vps-hardened-production-r3",m
assert r["controlRevision"]==530,r["controlRevision"]
assert r["lease"]["state"]=="FREE",r["lease"]
assert a["productionEpoch"]==2,a
assert a["mode"]=="QUIESCED_RECONCILING",a
assert a["materialAuthority"] is None,a
assert a["planes"]["android-v1"]["ingress"]=="CLOSED",a
assert a["planes"]["android-v1"]["materialEffectsAllowed"] is False,a
assert a["planes"]["vps-fabric"]["ingress"]=="CLOSED",a
assert a["planes"]["vps-fabric"]["materialEffectsAllowed"] is False,a

attempt_id="attempt:f6d80f46-b4ff-4798-9848-9b0b28bca1b8"
operation_id="operation:3cbb9823-a285-4d55-9cdc-cf57a2cb0cd2"
invocation_id="invocation:9e14dc26-50bc-4b3d-a265-171f96b9231d"

c=sqlite3.connect(f"file:{db_path}?mode=ro",uri=True)
c.row_factory=sqlite3.Row
try:
    row=c.execute("""
      SELECT i.dispatch_payload,o.payload AS operation_payload,
             o.state AS operation_state,a.state AS attempt_state
      FROM invocations i
      JOIN operations o ON o.invocation_id=i.invocation_id
      JOIN attempts a ON a.operation_id=o.operation_id
      WHERE i.invocation_id=? AND o.operation_id=? AND a.attempt_id=?
    """,(invocation_id,operation_id,attempt_id)).fetchone()
    assert row is not None
    dispatch=json.loads(row["dispatch_payload"])
    ep=dispatch.get("execution_payload") or dispatch.get("executionPayload") or {}
    args=ep.get("args") if isinstance(ep,dict) else None
    assert isinstance(args,dict)
    assert args.get("documentId")=="84d077d8370c21c4b3045263"
    assert args.get("workspaceId")=="aa8c5ad631e1836645149d09"
    assert args.get("elementId")=="7fde3930aaf98b87b30b63ed"
    steps=args.get("steps")
    assert isinstance(steps,list) and len(steps)==4
    actions=[str(s.get("action","")) for s in steps if isinstance(s,dict)]
    assert actions==["locator.fill","locator.press","locator.fill","locator.press"],actions

    fills=[s for s in steps if isinstance(s,dict) and s.get("action")=="locator.fill"]
    presses=[s for s in steps if isinstance(s,dict) and s.get("action")=="locator.press"]
    assert len(fills)==2 and len(presses)==2
    keys=[str(s.get("key","")).strip().lower() for s in presses]
    values=[str(s.get("value",s.get("text",""))).strip().lower() for s in fills]
    selectors=[str(s.get("selector","")).strip().lower() for s in steps if isinstance(s,dict)]

    def norm(x):
        return re.sub(r"[^a-z0-9]+"," ",x).strip()
    nv=[norm(v) for v in values]
    ns=[norm(s) for s in selectors]
    joined_values=" | ".join(nv)
    joined_selectors=" | ".join(ns)

    enter_pair=(keys==["enter","enter"])
    has_linear=("linear" in joined_values)
    has_pattern=("pattern" in joined_values)
    has_linear_pattern=has_linear and has_pattern
    search_hint=any(tok in joined_selectors for tok in ("search","command","tool","feature"))
    numeric_fill=any(re.fullmatch(r"[0-9]+(?:\.[0-9]+)?",v or "") for v in nv)
    auth_hint=any(tok in joined_selectors for tok in ("password","signin","login","email"))
    assert not auth_hint

    if enter_pair and has_linear_pattern:
        intent="LINEAR_PATTERN_UI_SEQUENCE"
    elif enter_pair and search_hint:
        intent="DOCUMENT_COMMAND_SEARCH_SEQUENCE"
    else:
        intent="OTHER_DOCUMENT_INPUT_SEQUENCE"

    print("CF_INTENT_AUTHORITY=quiesced-epoch2")
    print("CF_INTENT_ACTIVE_RELEASE=seq66-r3")
    print("CF_INTENT_CLASS="+intent)
    print("CF_INTENT_ENTER_PAIR="+("yes" if enter_pair else "no"))
    print("CF_INTENT_LINEAR_PATTERN_VALUE="+("yes" if has_linear_pattern else "no"))
    print("CF_INTENT_SEARCH_OR_FEATURE_SELECTOR="+("yes" if search_hint else "no"))
    print("CF_INTENT_NUMERIC_FILL="+("yes" if numeric_fill else "no"))
    print("CF_INTENT_OPERATION_STATE="+str(row["operation_state"]))
    print("CF_INTENT_ATTEMPT_STATE="+str(row["attempt_state"]))
finally:
    c.close()
PY

echo CF_INTENT_CLASSIFIER=pass
