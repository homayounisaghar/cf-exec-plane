from __future__ import annotations
import json, os, collections
from fresh_holdout_v15_10000 import CASES
import evidence_v06 as e

def main():
    outdir=os.environ.get("OUT_DIR","artifacts/onshape-fast-router-v15-deterministic")
    os.makedirs(outdir,exist_ok=True)
    rows=[]
    fallback=0
    fallback_samples=[]
    for c in CASES:
        row=e.plan_case(c)
        if row is None:
            fallback+=1
            if len(fallback_samples)<12:
                ev=e.extract_evidence(c["text"],c.get("ctx") or {})
                fallback_samples.append({
                    "id":c["id"],
                    "category":c["category"],
                    "text":c["text"],
                    "expected":c["expected"],
                    "action_families":ev.get("action_families"),
                    "inspect_target":ev.get("inspect_target"),
                    "core_text":ev.get("core_text"),
                    "cue_text":ev.get("cue_text"),
                })
            continue
        row["outcome"]=e.classify(c,row["post"])
        rows.append(row)

    outcomes=collections.Counter(r["outcome"] for r in rows)
    bycat={}
    samples={}
    for r in rows:
        cat=r["case"]["category"]
        bycat.setdefault(cat,collections.Counter())
        bycat[cat][r["outcome"]]+=1
        if r["outcome"]!="correct":
            k=cat+"|"+r["outcome"]
            samples.setdefault(k,[])
            if len(samples[k])<6:
                samples[k].append({
                    "id":r["case"]["id"],
                    "text":r["case"]["text"],
                    "expected":r["case"]["expected"],
                    "compiled":r["post"]["compiled"],
                    "reason":r["post"].get("reason"),
                    "intent":r.get("intent"),
                    "action_families":r.get("evidence",{}).get("action_families"),
                })
    severe=sum(outcomes.get(k,0) for k in ("wrong_material_accepted","false_execute","wrong_reversible_accepted"))
    summary={
        "cases":len(CASES),
        "deterministic_cases":len(rows),
        "fallback_cases":fallback,
        "deterministic_correct":outcomes.get("correct",0),
        "deterministic_accuracy":outcomes.get("correct",0)/len(rows) if rows else None,
        "wrong_material_accepted":outcomes.get("wrong_material_accepted",0),
        "false_execute":outcomes.get("false_execute",0),
        "wrong_reversible_accepted":outcomes.get("wrong_reversible_accepted",0),
        "severe_accepted_effect_errors":severe,
        "conservative_escalations":outcomes.get("conservative_escalation",0),
        "route_mismatch":outcomes.get("route_mismatch",0),
        "outcomes":dict(outcomes),
        "by_category":{k:dict(v) for k,v in sorted(bycat.items())},
    }
    with open(os.path.join(outdir,"summary.json"),"w",encoding="utf-8") as f:
        json.dump(summary,f,ensure_ascii=False,indent=2)
    if fallback_samples:
        samples["fallback"] = fallback_samples
    with open(os.path.join(outdir,"failure-samples.json"),"w",encoding="utf-8") as f:
        json.dump(samples,f,ensure_ascii=False,indent=2)
    print(json.dumps(summary,ensure_ascii=False,sort_keys=True))

if __name__=="__main__":
    main()
