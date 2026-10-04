from __future__ import annotations
import json, os, collections
from fresh_holdout_v15_10000 import CASES
import evidence_v06 as e

def main():
    outdir=os.environ.get("OUT_DIR","artifacts/onshape-fast-router-v15-fallback-dump")
    os.makedirs(outdir,exist_ok=True)
    rows=[]
    bycat=collections.Counter()
    for c in CASES:
        ev=e.extract_evidence(c["text"],c.get("ctx",{}))
        d,i=e.direct_intent(c,ev)
        if d is None:
            rows.append({
                "id":c["id"],"category":c["category"],"text":c["text"],"ctx":c.get("ctx",{}),
                "expected":c["expected"],
                "evidence":{k:ev.get(k) for k in [
                    "core_text","features","parts","name_value","property","property_value",
                    "fit_target","camera_action","camera_direction","last_move","suppressed",
                    "relation","rollback_position","quantity_issues","quantities","design","unsupported",
                    "action_families","multi_action","conditional","dependent_sequence"
                ]}
            })
            bycat[c["category"]]+=1
    with open(os.path.join(outdir,"fallbacks.json"),"w",encoding="utf-8") as f:
        json.dump(rows,f,ensure_ascii=False,indent=2)
    with open(os.path.join(outdir,"summary.json"),"w",encoding="utf-8") as f:
        json.dump({"fallback_cases":len(rows),"by_category":dict(sorted(bycat.items()))},f,ensure_ascii=False,indent=2)

if __name__=="__main__": main()
