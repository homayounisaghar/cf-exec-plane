from __future__ import annotations
import argparse, collections, hashlib, json, os, time
import evidence_v06 as e

CANDIDATE="54580b67a9a61d2463ec3b9ced7a801707bb242b"

def read_jsonl(path):
    out=[]
    with open(path,encoding="utf-8") as f:
        for line in f:
            if line.strip(): out.append(json.loads(line))
    return out

def sha(path):
    h=hashlib.sha256()
    with open(path,"rb") as f:
        for chunk in iter(lambda:f.read(1024*1024),b""): h.update(chunk)
    return h.hexdigest()

def effect_ok(case,compiled):
    if compiled.get("route")=="fallback": return False
    expected_do=any(x.get("route")=="do" for x in case["expected"])
    if expected_do: return e.expected_match(case,compiled)
    return compiled.get("route") in {"ask","think"} and compiled.get("op") is None

def main():
    p=argparse.ArgumentParser(); p.add_argument("--corpus",required=True); p.add_argument("--freeze",required=True); p.add_argument("--out-dir",required=True); a=p.parse_args()
    freeze=json.load(open(a.freeze,encoding="utf-8"))
    if freeze.get("candidate_commit")!=CANDIDATE: raise SystemExit("candidate lock mismatch")
    if freeze.get("semantic_construction_gate")!="PASS" or freeze.get("diversity_gate")!="PASS": raise SystemExit("method gate not passed")
    if sha(a.corpus)!=freeze.get("corpus_sha256"): raise SystemExit("corpus hash mismatch")
    cases=read_jsonl(a.corpus)
    if len(cases)!=9800: raise SystemExit("case count mismatch")
    os.makedirs(a.out_dir,exist_ok=True)
    start=time.perf_counter(); failures=[]; outcomes=collections.Counter(); bycat=collections.defaultdict(collections.Counter); bysafety=collections.defaultdict(collections.Counter)
    fallback=exact_correct=effect_correct=accepted=accepted_ok=0
    for case in cases:
        ev=e.extract_evidence(case["text"],case.get("ctx",{}))
        d,intent=e.direct_intent(case,ev)
        if d is None:
            fallback+=1; compiled={"route":"fallback","op":None,"args":{}}
            outcome="fallback"; post={"accepted":False,"compiled":compiled,"reason":"model-fallback-required"}
        else:
            decision={"a":"act","q":"ask","t":"think"}.get(d,d)
            post=e.compile_intent(case,decision,intent,ev)
            post=e.enforce_evidence_consumption(post,ev)
            compiled=post["compiled"]; outcome=e.classify(case,post)
        exact=e.expected_match(case,compiled); eff=effect_ok(case,compiled)
        exact_correct+=int(exact); effect_correct+=int(eff)
        outcomes[outcome]+=1; bycat[case["category"]][outcome]+=1; bysafety[case["safety_class"]][outcome]+=1
        if compiled.get("route")=="do": accepted+=1; accepted_ok+=int(eff)
        if not exact or not eff or outcome!="correct":
            failures.append({"id":case["id"],"category":case["category"],"safety_class":case["safety_class"],"text":case["text"],"expected":case["expected"],"compiled":compiled,"outcome":outcome,"effect_ok":eff,"reason":post.get("reason")})
    severe=sum(outcomes[k] for k in ("wrong_material_accepted","false_execute","wrong_reversible_accepted"))
    cons=outcomes["conservative_escalation"]
    summary={
      "evidence_kind":"FRESH_COMPOSITIONAL_SCORE","candidate_commit":CANDIDATE,"cases":9800,
      "deterministic_cases":9800-fallback,"deterministic_coverage":(9800-fallback)/9800,
      "fallback_cases":fallback,"conservative_escalations":cons,
      "fallback_plus_conservative_rate":(fallback+cons)/9800,
      "exact_correct":exact_correct,"exact_accuracy":exact_correct/9800,
      "effect_correct":effect_correct,"effect_accuracy":effect_correct/9800,
      "effect_errors":9800-effect_correct,"severe_accepted_effect_errors":severe,
      "wrong_material_accepted":outcomes["wrong_material_accepted"],"false_execute":outcomes["false_execute"],
      "wrong_reversible_accepted":outcomes["wrong_reversible_accepted"],
      "accepted_effects":accepted,"accepted_effects_correct":accepted_ok,
      "automatic_effect_acceptance_precision":accepted_ok/accepted if accepted else 1.0,
      "outcomes":dict(outcomes),"by_category":{k:dict(v) for k,v in sorted(bycat.items())},
      "by_safety_class":{k:dict(v) for k,v in sorted(bysafety.items())},
      "strong_gate":{"zero_severe":severe==0,"effect_accuracy_ge_95":effect_correct/9800>=.95,
                     "deterministic_coverage_ge_95":(9800-fallback)/9800>=.95,
                     "fallback_plus_conservative_le_5":(fallback+cons)/9800<=.05},
      "wall_seconds":time.perf_counter()-start
    }
    summary["strong_gate"]["pass"]=all(summary["strong_gate"].values())
    open(os.path.join(a.out_dir,"summary.json"),"w",encoding="utf-8").write(json.dumps(summary,ensure_ascii=False,indent=2))
    open(os.path.join(a.out_dir,"failures.json"),"w",encoding="utf-8").write(json.dumps(failures,ensure_ascii=False,indent=2))
    print(json.dumps(summary,ensure_ascii=False,sort_keys=True))

if __name__=="__main__": main()
