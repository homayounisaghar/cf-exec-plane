from __future__ import annotations
import json
from collections import Counter, defaultdict

ROWS="reports/onshape-fast-router-divergent-v14-1000/rows.json"
OUT="reports/onshape-fast-router-divergent-v14-1000/failure-analysis.json"

with open(ROWS,encoding="utf-8") as f:
    rows=json.load(f)

by_source=defaultdict(Counter)
by_category=defaultdict(Counter)
severe=[]
for r in rows:
    outcome=r["outcome"]
    source=r.get("source","unknown")
    cat=r["case"].get("category","unknown")
    by_source[source][outcome]+=1
    by_category[cat][outcome]+=1
    if outcome in {"wrong_material_accepted","false_execute","wrong_reversible_accepted"}:
        severe.append({
            "id":r["case"]["id"],
            "category":cat,
            "text":r["case"]["text"],
            "outcome":outcome,
            "source":source,
            "intent":r.get("intent"),
            "expected":r["case"]["expected"],
            "compiled":r["post"]["compiled"],
            "reason":r["post"].get("reason"),
        })

failures=[r for r in rows if r["outcome"]!="correct"]
api=[r for r in failures if r["outcome"]=="api_failure"]
non_api=[r for r in rows if r["outcome"]!="api_failure"]
analysis={
    "cases":len(rows),
    "correct":sum(r["outcome"]=="correct" for r in rows),
    "non_api_cases":len(non_api),
    "non_api_correct":sum(r["outcome"]=="correct" for r in non_api),
    "non_api_accuracy":sum(r["outcome"]=="correct" for r in non_api)/len(non_api),
    "by_source":{k:dict(v) for k,v in sorted(by_source.items())},
    "by_category":{k:dict(v) for k,v in sorted(by_category.items())},
    "severe":severe,
    "api_failure_ids":[r["case"]["id"] for r in api],
    "conservative_ids":[r["case"]["id"] for r in failures if r["outcome"]=="conservative_escalation"],
}
with open(OUT,"w",encoding="utf-8") as f:
    json.dump(analysis,f,ensure_ascii=False,indent=2)
print(json.dumps(analysis,ensure_ascii=False,sort_keys=True))
