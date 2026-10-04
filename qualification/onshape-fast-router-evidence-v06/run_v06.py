from __future__ import annotations
import json, os, sys

HERE=os.path.dirname(__file__)
sys.path.insert(0,HERE)

from corpus_v02 import CASES as KNOWN
from synthetic_holdout import CASES as SYNTH
import evidence_v06 as e

def main():
    key=os.environ.get("GROQ_API_KEY","").strip()
    if not key: raise SystemExit("GROQ_API_KEY missing")
    outdir=os.environ.get("OUT_DIR","artifacts/onshape-fast-router-evidence-v06")
    os.makedirs(outdir,exist_ok=True)
    suites=[("known120",KNOWN),("synthetic96",SYNTH)]
    combined={}
    for name,cases in suites:
        rows,summary=e.run_suite(cases,key)
        with open(os.path.join(outdir,name+"-rows.json"),"w",encoding="utf-8") as f:
            json.dump(rows,f,ensure_ascii=False,indent=2)
        with open(os.path.join(outdir,name+"-summary.json"),"w",encoding="utf-8") as f:
            json.dump(summary,f,ensure_ascii=False,indent=2)
        combined[name]=summary
        print(name.upper()+"="+json.dumps(summary,ensure_ascii=False,sort_keys=True),flush=True)
    with open(os.path.join(outdir,"summary.json"),"w",encoding="utf-8") as f:
        json.dump(combined,f,ensure_ascii=False,indent=2)
    return 0

if __name__=="__main__":
    raise SystemExit(main())
