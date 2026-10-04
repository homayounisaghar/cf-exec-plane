from __future__ import annotations
import json, os, collections

def main():
    outdir=os.environ.get("OUT_DIR","artifacts/onshape-fast-router-divergent-v15-10000")
    with open(os.path.join(outdir,"rows.json"),encoding="utf-8") as f:
        rows=json.load(f)

    bad=[r for r in rows if r.get("outcome")!="correct"]
    by_cat=collections.defaultdict(collections.Counter)
    by_source=collections.defaultdict(collections.Counter)
    for r in rows:
        by_cat[r["case"]["category"]][r["outcome"]]+=1
        by_source[r["source"]][r["outcome"]]+=1

    severe=[]
    for r in bad:
        if r["outcome"] in {"wrong_material_accepted","false_execute","wrong_reversible_accepted"}:
            severe.append({
                "id":r["case"]["id"],
                "category":r["case"]["category"],
                "text":r["case"]["text"],
                "outcome":r["outcome"],
                "source":r["source"],
                "intent":r.get("intent"),
                "expected":r["case"]["expected"],
                "compiled":r["post"]["compiled"],
                "reason":r["post"].get("reason"),
                "action_families":r.get("evidence",{}).get("action_families"),
            })

    samples={}
    for r in bad:
        k=r["case"]["category"]+"|"+r["outcome"]
        samples.setdefault(k,[])
        if len(samples[k])<8:
            samples[k].append({
                "id":r["case"]["id"],
                "text":r["case"]["text"],
                "source":r["source"],
                "intent":r.get("intent"),
                "expected":r["case"]["expected"],
                "compiled":r["post"]["compiled"],
                "reason":r["post"].get("reason"),
            })

    report={
        "cases":len(rows),
        "correct":sum(r["outcome"]=="correct" for r in rows),
        "accuracy":sum(r["outcome"]=="correct" for r in rows)/len(rows),
        "by_source":{k:dict(v) for k,v in sorted(by_source.items())},
        "by_category":{k:dict(v) for k,v in sorted(by_cat.items())},
        "severe_count":len(severe),
        "severe":severe[:200],
        "failure_samples":samples,
        "non_api_cases":sum(r["outcome"]!="api_failure" for r in rows),
        "non_api_correct":sum(r["outcome"]=="correct" for r in rows if r["outcome"]!="api_failure"),
    }
    n=report["non_api_cases"]
    report["non_api_accuracy"]=report["non_api_correct"]/n if n else None
    with open(os.path.join(outdir,"failure-analysis.json"),"w",encoding="utf-8") as f:
        json.dump(report,f,ensure_ascii=False,indent=2)

if __name__=="__main__":
    main()
