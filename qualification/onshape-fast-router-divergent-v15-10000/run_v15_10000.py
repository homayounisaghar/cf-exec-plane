from __future__ import annotations
import hashlib, json, os
from fresh_holdout_v15_10000 import CASES, FAMILY_COUNTS, DIVERGENCE_AXES
import evidence_v06 as e

def corpus_digest():
    payload=json.dumps(CASES,ensure_ascii=False,sort_keys=True,separators=(",",":")).encode("utf-8")
    return hashlib.sha256(payload).hexdigest()

def main():
    key=os.environ.get("GROQ_API_KEY","").strip()
    if not key:
        raise SystemExit("GROQ_API_KEY missing")
    outdir=os.environ.get("OUT_DIR","artifacts/onshape-fast-router-divergent-v15-10000")
    os.makedirs(outdir,exist_ok=True)

    rows,summary=e.run_suite(CASES,key)
    summary["corpus_sha256"]=corpus_digest()
    summary["unique_texts"]=len({c["text"] for c in CASES})
    summary["family_counts"]=FAMILY_COUNTS
    summary["divergence_axes"]=DIVERGENCE_AXES
    summary["fallback_rate"]=summary["model_intent_cases"]/len(CASES)

    with open(os.path.join(outdir,"rows.json"),"w",encoding="utf-8") as f:
        json.dump(rows,f,ensure_ascii=False,indent=2)
    with open(os.path.join(outdir,"summary.json"),"w",encoding="utf-8") as f:
        json.dump(summary,f,ensure_ascii=False,indent=2)
    with open(os.path.join(outdir,"corpus-manifest.json"),"w",encoding="utf-8") as f:
        json.dump({
            "cases":len(CASES),
            "unique_texts":len({c["text"] for c in CASES}),
            "corpus_sha256":summary["corpus_sha256"],
            "family_counts":FAMILY_COUNTS,
            "divergence_axes":DIVERGENCE_AXES,
        },f,ensure_ascii=False,indent=2)

    print("FINAL_SUMMARY="+json.dumps(summary,ensure_ascii=False,sort_keys=True),flush=True)

if __name__=="__main__":
    main()
