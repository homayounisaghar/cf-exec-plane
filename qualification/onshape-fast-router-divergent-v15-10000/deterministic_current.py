from __future__ import annotations
import json, os, collections
from fresh_holdout_v15_10000 import CASES
import evidence_v06 as e

def main():
    outdir=os.environ.get("OUT_DIR","artifacts/onshape-fast-router-v15-current-deterministic")
    os.makedirs(outdir,exist_ok=True)
    rows=[]
    fallback=0
    for c in CASES:
        ev=e.extract_evidence(c["text"],c.get("ctx",{}))
        d,i=e.direct_intent(c,ev)
        if d is None:
            fallback+=1
            continue
        decision={"a":"act","q":"ask","t":"think"}.get(d,d)
        post=e.compile_intent(c,decision,i,ev)
        post=e.enforce_evidence_consumption(post,ev)
        outcome=e.classify(c,post)
        rows.append({"id":c["id"],"category":c["category"],"text":c["text"],"outcome":outcome,
                     "compiled":post["compiled"],"reason":post.get("reason")})
    counts=collections.Counter(r["outcome"] for r in rows)
    bycat=collections.defaultdict(collections.Counter)
    for r in rows: bycat[r["category"]][r["outcome"]]+=1
    summary={
        "cases_total":len(CASES),
        "deterministic_cases":len(rows),
        "fallback_cases":fallback,
        "deterministic_correct":counts["correct"],
        "deterministic_accuracy":counts["correct"]/len(rows) if rows else None,
        "wrong_material_accepted":counts["wrong_material_accepted"],
        "false_execute":counts["false_execute"],
        "wrong_reversible_accepted":counts["wrong_reversible_accepted"],
        "conservative_escalation":counts["conservative_escalation"],
        "route_mismatch":counts["route_mismatch"],
        "by_category":{k:dict(v) for k,v in sorted(bycat.items())},
    }
    with open(os.path.join(outdir,"summary.json"),"w",encoding="utf-8") as f:
        json.dump(summary,f,ensure_ascii=False,indent=2)
    bad=[r for r in rows if r["outcome"]!="correct"]
    with open(os.path.join(outdir,"failures.json"),"w",encoding="utf-8") as f:
        json.dump(bad,f,ensure_ascii=False,indent=2)
    print(json.dumps(summary,ensure_ascii=False,sort_keys=True))

if __name__=="__main__": main()
