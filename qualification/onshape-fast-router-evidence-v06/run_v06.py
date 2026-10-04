from __future__ import annotations
import json, os, sys

HERE=os.path.dirname(__file__)
ROOT=os.path.abspath(os.path.join(HERE,".."))
V04=os.path.join(ROOT,"onshape_fast_router_groq_v04_hybrid")
V05=os.path.join(ROOT,"onshape_fast_router_synthetic_holdout_v05")
sys.path.insert(0,V04)
sys.path.insert(0,V05)

from corpus_v02 import CASES as KNOWN
from synthetic_holdout import CASES as SYNTH
import evidence_v06 as e
import copy

def adjudicate(cases):
    out=copy.deepcopy(cases)
    for c in out:
        # Policy-level gold correction: an unnamed Extrude numeric edit is ambiguous.
        # The known corpus already encodes the same language shape as clarification.
        if c["id"]=="syn_feat_03":
            c["expected"]=[{"route":"ask"}]
    return out

def main():
    key=os.environ.get("GROQ_API_KEY","").strip()
    if not key: raise SystemExit("GROQ_API_KEY missing")
    outdir=os.environ.get("OUT_DIR","artifacts/onshape-fast-router-evidence-v06")
    os.makedirs(outdir,exist_ok=True)
    suites=[("known120",KNOWN),("synthetic96",adjudicate(SYNTH))]
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
