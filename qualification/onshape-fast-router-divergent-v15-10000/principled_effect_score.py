from __future__ import annotations
import json, os
from fresh_holdout_v15_10000 import CASES
import evidence_v06 as e

def effect_match(case, compiled):
    expected=case["expected"]
    if any(x.get("route")=="do" for x in expected):
        return e.expected_match(case,compiled)
    return compiled.get("route") in {"ask","think"}

def main():
    errors=[]
    correct=0
    for c in CASES:
        ev=e.extract_evidence(c["text"],c.get("ctx",{}))
        d,i=e.direct_intent(c,ev)
        if d is None:
            errors.append({"id":c["id"],"category":c["category"],"reason":"fallback"})
            continue
        decision={"a":"act","q":"ask","t":"think"}.get(d,d)
        post=e.compile_intent(c,decision,i,ev)
        post=e.enforce_evidence_consumption(post,ev)
        comp=post["compiled"]
        if effect_match(c,comp):
            correct+=1
        else:
            errors.append({"id":c["id"],"category":c["category"],"text":c["text"],"expected":c["expected"],"compiled":comp,"reason":post.get("reason")})
    out={
      "cases":len(CASES),
      "effect_correct":correct,
      "effect_accuracy":correct/len(CASES),
      "effect_errors":len(errors),
      "fallback_cases":sum(1 for x in errors if x.get("reason")=="fallback"),
      "errors":errors[:200]
    }
    outdir=os.environ.get("OUT_DIR","artifacts/onshape-v15-principled-effect")
    os.makedirs(outdir,exist_ok=True)
    with open(os.path.join(outdir,"summary.json"),"w",encoding="utf-8") as f:
        json.dump(out,f,ensure_ascii=False,indent=2)
    print(json.dumps(out,ensure_ascii=False,sort_keys=True))

if __name__=="__main__": main()
