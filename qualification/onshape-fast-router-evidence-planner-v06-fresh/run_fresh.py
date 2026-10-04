from __future__ import annotations
import json, os, time
from fresh_holdout_v06 import CASES
import evidence_router as r

OUT_DIR=os.environ.get("OUT_DIR","artifacts/onshape-fast-router-evidence-planner-v06-fresh")
BATCH_SIZE=int(os.environ.get("BATCH_SIZE","12"))

def main():
    os.makedirs(OUT_DIR,exist_ok=True)
    key=os.environ.get("GROQ_API_KEY","").strip()
    if not key:
        raise SystemExit("GROQ_API_KEY missing")
    started=time.perf_counter()
    rows,batches=r.route_cases(CASES,key,BATCH_SIZE)
    summary=r.summarize(rows,batches)
    summary["suite"]="fresh120"
    summary["wall_seconds"]=time.perf_counter()-started
    summary["code_under_test_commit"]="f54fb6273e641f1e6fefa7403c4a047a99f8ff8a"
    summary["holdout_kind"]="fresh synthetic colloquial Persian; frozen before first score"
    with open(os.path.join(OUT_DIR,"summary.json"),"w",encoding="utf-8") as f:
        json.dump(summary,f,ensure_ascii=False,indent=2)
    with open(os.path.join(OUT_DIR,"rows.json"),"w",encoding="utf-8") as f:
        json.dump(rows,f,ensure_ascii=False,indent=2)
    print("FINAL_SUMMARY="+json.dumps(summary,ensure_ascii=False,sort_keys=True),flush=True)

if __name__=="__main__":
    main()
