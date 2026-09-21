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
    values=[str(s.get("value",s.get("text",""))).strip() for s in fills]
    selectors=[str(s.get("selector","")).strip() for s in fills]

    def norm(x):
        return re.sub(r"[^a-z0-9]+"," ",x.lower()).strip()

    nv=[norm(v) for v in values]
    ns=[norm(s) for s in selectors]
    joined_values=" | ".join(nv)
    joined_selectors=" | ".join(ns)

    def value_shape(raw):
        t=raw.strip()
        if not t:
            return "EMPTY"
        if re.fullmatch(r"[+-]?[0-9]+(?:\.[0-9]+)?",t):
            return "NUMERIC"
        if re.fullmatch(r"[+-]?[0-9]+(?:\.[0-9]+)?\s*[a-zA-Z%°]+",t):
            return "QUANTITY"
        if re.fullmatch(r"[a-zA-Z][a-zA-Z0-9 _.-]{0,79}",t):
            return "TEXT"
        return "OTHER"

    shapes=[value_shape(v) for v in values]
    shape_pair=f"{shapes[0]}_{shapes[1]}"

    feature_param_tokens=(
        "parameter","expression","quantity","distance","spacing","count","instance",
        "instances","angle","dimension","value","offset","pitch","length","depth"
    )
    naming_tokens=("name","title","label","rename")
    search_tokens=("search","command","tool","feature","filter")
    selection_tokens=("select","query","entities","entity","face","edge","vertex","part")
    dialog_tokens=("dialog","modal","popover","panel")

    def selector_class(n):
        toks=set(n.split())
        if any(t in toks for t in feature_param_tokens):
            return "FEATURE_PARAMETER"
        if any(t in toks for t in naming_tokens):
            return "NAMING"
        if any(t in toks for t in search_tokens):
            return "SEARCH"
        if any(t in toks for t in selection_tokens):
            return "SELECTION"
        if any(t in toks for t in dialog_tokens):
            return "DIALOG"
        if any(t in toks for t in ("input","textbox","text","field")):
            return "GENERIC_INPUT"
        return "OTHER"

    sclasses=[selector_class(s) for s in ns]
    selector_pair=f"{sclasses[0]}_{sclasses[1]}"
    selectors_same=(ns[0]==ns[1])

    enter_pair=(keys==["enter","enter"])
    has_linear=("linear" in joined_values)
    has_pattern=("pattern" in joined_values)
    has_linear_pattern=has_linear and has_pattern
    search_hint=any(c=="SEARCH" for c in sclasses)
    feature_param_hint=any(c=="FEATURE_PARAMETER" for c in sclasses)
    numeric_like=all(s in ("NUMERIC","QUANTITY") for s in shapes)
    naming_hint=any(c=="NAMING" for c in sclasses)
    auth_hint=any(tok in joined_selectors for tok in ("password","signin","login","email"))
    assert not auth_hint

    if enter_pair and has_linear_pattern:
        intent="LINEAR_PATTERN_UI_SEQUENCE"
    elif enter_pair and search_hint:
        intent="DOCUMENT_COMMAND_SEARCH_SEQUENCE"
    elif enter_pair and feature_param_hint and numeric_like:
        intent="FEATURE_PARAMETER_COMMIT_SEQUENCE"
    elif enter_pair and naming_hint:
        intent="NAMING_COMMIT_SEQUENCE"
    else:
        intent="OTHER_DOCUMENT_INPUT_SEQUENCE"

    print("CF_INTENT_AUTHORITY=quiesced-epoch2")
    print("CF_INTENT_ACTIVE_RELEASE=seq66-r3")
    print("CF_INTENT_CLASS="+intent)
    print("CF_INTENT_ENTER_PAIR="+("yes" if enter_pair else "no"))
    print("CF_INTENT_VALUE_SHAPES="+shape_pair)
    print("CF_INTENT_SELECTOR_CLASSES="+selector_pair)
    print("CF_INTENT_SELECTORS_SAME="+("yes" if selectors_same else "no"))
    print("CF_INTENT_LINEAR_PATTERN_VALUE="+("yes" if has_linear_pattern else "no"))
    print("CF_INTENT_OPERATION_STATE="+str(row["operation_state"]))
    print("CF_INTENT_ATTEMPT_STATE="+str(row["attempt_state"]))
finally:
    c.close()
PY

echo CF_INTENT_CLASSIFIER=pass
