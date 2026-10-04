from __future__ import annotations
import collections
import json
import os
import time
import evidence_v06 as e
from fresh_holdout_v18_independent_10000 import CANDIDATES, CASES, FILTERED

def effect_ok(case, compiled):
    if compiled.get("route") == "fallback":
        return False
    expected_do = any(x.get("route") == "do" for x in case["expected"])
    if expected_do:
        return e.expected_match(case, compiled)
    return compiled.get("route") in {"ask", "think"} and compiled.get("op") is None

def main():
    outdir=os.environ.get("OUT_DIR","artifacts/onshape-fast-router-fresh-v18-independent")
    os.makedirs(outdir,exist_ok=True)
    started=time.perf_counter()
    rows=[]; fallback=0; exact_correct=0; effect_correct=0
    outcomes=collections.Counter(); by_category=collections.defaultdict(collections.Counter)
    for case in CASES:
        ev=e.extract_evidence(case["text"],case.get("ctx",{}))
        d,intent=e.direct_intent(case,ev)
        if d is None:
            fallback+=1
            compiled={"route":"fallback","op":None,"args":{}}
            outcome="fallback"
            post={"accepted":False,"compiled":compiled,"reason":"model-fallback-required"}
        else:
            decision={"a":"act","q":"ask","t":"think"}.get(d,d)
            post=e.compile_intent(case,decision,intent,ev)
            post=e.enforce_evidence_consumption(post,ev)
            compiled=post["compiled"]
            outcome=e.classify(case,post)
        exact=e.expected_match(case,compiled)
        eff=effect_ok(case,compiled)
        exact_correct+=int(exact); effect_correct+=int(eff)
        outcomes[outcome]+=1; by_category[case["category"]][outcome]+=1
        if not exact or not eff or outcome!="correct":
            rows.append({"id":case["id"],"category":case["category"],"text":case["text"],
                         "expected":case["expected"],"compiled":compiled,"outcome":outcome,
                         "effect_ok":eff,"reason":post.get("reason"),
                         "action_families":ev.get("action_families"),
                         "quantity_issues":ev.get("quantity_issues")})
    severe=sum(outcomes[k] for k in ("wrong_material_accepted","false_execute","wrong_reversible_accepted"))
    reason_counts=collections.defaultdict(collections.Counter)
    representatives=collections.defaultdict(list)
    for row in rows:
        reason_counts[row["category"]][row.get("reason") or row["outcome"]]+=1
        if len(representatives[row["category"]])<3:
            representatives[row["category"]].append({
                "id":row["id"],"text":row["text"],"expected":row["expected"],
                "compiled":row["compiled"],"outcome":row["outcome"],"reason":row.get("reason"),
                "action_families":row.get("action_families"),"quantity_issues":row.get("quantity_issues")
            })
    summary={
        "candidate_cases_before_filter":len(CANDIDATES),"filtered_before_score":len(FILTERED),
        "cases":len(CASES),"deterministic_cases":len(CASES)-fallback,"fallback_cases":fallback,
        "exact_correct":exact_correct,"exact_accuracy":exact_correct/len(CASES),
        "effect_correct":effect_correct,"effect_accuracy":effect_correct/len(CASES),
        "effect_errors":len(CASES)-effect_correct,"severe_accepted_effect_errors":severe,
        "wrong_material_accepted":outcomes["wrong_material_accepted"],
        "false_execute":outcomes["false_execute"],
        "wrong_reversible_accepted":outcomes["wrong_reversible_accepted"],
        "conservative_escalations":outcomes["conservative_escalation"],
        "route_mismatch":outcomes["route_mismatch"],"outcomes":dict(outcomes),
        "by_category":{k:dict(v) for k,v in sorted(by_category.items())},
        "failure_reason_counts":{k:dict(v) for k,v in sorted(reason_counts.items())},
        "representative_failures":{k:v for k,v in sorted(representatives.items())},
        "wall_seconds":time.perf_counter()-started
    }
    with open(os.path.join(outdir,"summary.json"),"w",encoding="utf-8") as f:
        json.dump(summary,f,ensure_ascii=False,indent=2)
    with open(os.path.join(outdir,"failures.json"),"w",encoding="utf-8") as f:
        json.dump(rows,f,ensure_ascii=False,indent=2)
    print(json.dumps(summary,ensure_ascii=False,sort_keys=True))

if __name__=="__main__":
    main()
