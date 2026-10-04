from __future__ import annotations
import hashlib, json, os
from fresh_holdout_v15_10000 import CASES, FAMILY_COUNTS, DIVERGENCE_AXES, SURFACE_DEDUP_COUNT

def digest():
    payload=json.dumps(CASES,ensure_ascii=False,sort_keys=True,separators=(",",":")).encode("utf-8")
    return hashlib.sha256(payload).hexdigest()

def main():
    assert len(CASES)==10000, len(CASES)
    assert len({c["id"] for c in CASES})==10000
    assert len({c["text"] for c in CASES})==10000
    assert len(FAMILY_COUNTS)==50, len(FAMILY_COUNTS)
    assert set(FAMILY_COUNTS.values())=={200}, FAMILY_COUNTS
    out={
        "cases":len(CASES),
        "unique_texts":len({c["text"] for c in CASES}),
        "families":len(FAMILY_COUNTS),
        "family_counts":FAMILY_COUNTS,
        "divergence_axes":DIVERGENCE_AXES,
        "corpus_sha256":digest(),
        "surface_dedup_count":SURFACE_DEDUP_COUNT,
        "status":"frozen_pre_score",
    }
    path=os.environ.get("OUT_PATH","pre-score-manifest.json")
    with open(path,"w",encoding="utf-8") as f:
        json.dump(out,f,ensure_ascii=False,indent=2)
    print(json.dumps(out,ensure_ascii=False,sort_keys=True))

if __name__=="__main__":
    main()
