from __future__ import annotations
import importlib.util, json, os, pathlib, collections, sys

ROOT=pathlib.Path(__file__).resolve().parents[2]

def load_module(name,path):
    spec=importlib.util.spec_from_file_location(name,str(path))
    mod=importlib.util.module_from_spec(spec)
    assert spec.loader
    spec.loader.exec_module(mod)
    return mod

router=load_module("router_current", ROOT/"qualification/onshape-fast-router-divergent-v15-10000/evidence_v06.py")

SUITES=[
    ("v12", ROOT/"qualification/onshape-fast-router-fresh-holdout-v12/fresh_holdout_v12.py"),
    ("v13", ROOT/"qualification/onshape-fast-router-fresh-holdout-v13/fresh_holdout_v13.py"),
    ("v14", ROOT/"qualification/onshape-fast-router-divergent-v14-1000/fresh_holdout_v14_1000.py"),
]

def run(cases):
    rows=[]
    fallback=[]
    for c in cases:
        ev=router.extract_evidence(c["text"],c.get("ctx",{}))
        d,i=router.direct_intent(c,ev)
        if d is None:
            fallback.append(c["id"])
            continue
        decision={"a":"act","q":"ask","t":"think"}.get(d,d)
        post=router.compile_intent(c,decision,i,ev)
        post=router.enforce_evidence_consumption(post,ev)
        outcome=router.classify(c,post)
        rows.append((c,outcome,post))
    counts=collections.Counter(o for _,o,_ in rows)
    return {
        "cases":len(cases),
        "deterministic_cases":len(rows),
        "fallback_cases":len(fallback),
        "fallback_ids":fallback,
        "correct":counts["correct"],
        "wrong_material_accepted":counts["wrong_material_accepted"],
        "false_execute":counts["false_execute"],
        "wrong_reversible_accepted":counts["wrong_reversible_accepted"],
        "conservative_escalation":counts["conservative_escalation"],
        "route_mismatch":counts["route_mismatch"],
        "unsafe_total":counts["wrong_material_accepted"]+counts["false_execute"]+counts["wrong_reversible_accepted"],
    }

def main():
    out={}
    for name,path in SUITES:
        mod=load_module("corpus_"+name,path)
        out[name]=run(mod.CASES)
    outdir=os.environ.get("OUT_DIR","artifacts/onshape-known-local-regression")
    os.makedirs(outdir,exist_ok=True)
    with open(os.path.join(outdir,"summary.json"),"w",encoding="utf-8") as f:
        json.dump(out,f,ensure_ascii=False,indent=2)
    print(json.dumps(out,ensure_ascii=False,sort_keys=True))

if __name__=="__main__":
    main()
