from __future__ import annotations
import json, os
from fresh_holdout_v07 import CASES
import evidence_v06 as e

def main():
    key=os.environ.get("GROQ_API_KEY","").strip()
    if not key: raise SystemExit("GROQ_API_KEY missing")
    outdir=os.environ.get("OUT_DIR","artifacts/onshape-fast-router-fresh-holdout-v07")
    os.makedirs(outdir,exist_ok=True)
    rows,summary=e.run_suite(CASES,key)
    with open(os.path.join(outdir,"rows.json"),"w",encoding="utf-8") as f:
        json.dump(rows,f,ensure_ascii=False,indent=2)
    with open(os.path.join(outdir,"summary.json"),"w",encoding="utf-8") as f:
        json.dump(summary,f,ensure_ascii=False,indent=2)
    print("FINAL_SUMMARY="+json.dumps(summary,ensure_ascii=False,sort_keys=True),flush=True)
    return 0

if __name__=="__main__":
    raise SystemExit(main())
