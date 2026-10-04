from __future__ import annotations
import argparse, json, re
from llm_client import read_jsonl, write_jsonl

FLAG_KEYS=["ambiguous","conditional","multi_effect","invalid_quantity","negated_only"]

def norm_scalar(v):
    if isinstance(v,str):
        s=" ".join(v.strip().split())
        m=re.fullmatch(r"([+-]?\d+(?:\.\d+)?)\s*(mm|deg)",s,re.I)
        if m:
            n=float(m.group(1)); ns=str(int(n)) if n.is_integer() else ("%g"%n)
            return ns+" "+m.group(2).lower()
        return s
    return v

def norm_obj(v):
    if isinstance(v,dict): return {k:norm_obj(x) for k,x in sorted(v.items()) if x is not None}
    if isinstance(v,list): return [norm_obj(x) for x in v]
    return norm_scalar(v)

def parse_ok(scenario,j):
    g=scenario["gold"]
    if j.get("route")!=g.get("route"): return False,"route"
    if g["route"]=="do":
        if j.get("op")!=g.get("op"): return False,"op"
        if norm_obj(j.get("args") or {})!=norm_obj(g.get("args") or {}): return False,"args"
    else:
        if j.get("op") not in (None,""): return False,"non_null_op"
        if norm_obj(j.get("args") or {})!={}: return False,"nonempty_args"
    jf={k:bool((j.get("flags") or {}).get(k,False)) for k in FLAG_KEYS}
    gf={k:bool(scenario.get("expected_flags",{}).get(k,False)) for k in FLAG_KEYS}
    if jf!=gf: return False,"flags"
    return True,"ok"

def lang_view(s):
    return {k:s[k] for k in ["scenario_id","family","semantic_description","context","value_provenance","expected_flags","realization_constraints"]}

def main():
    p=argparse.ArgumentParser()
    p.add_argument("--scenarios",required=True); p.add_argument("--generated",required=True)
    p.add_argument("--judge-a",required=True); p.add_argument("--judge-b",required=True)
    p.add_argument("--round",type=int,required=True); p.add_argument("--accepted-out",required=True)
    p.add_argument("--retry-out",required=True); p.add_argument("--report-out",required=True)
    p.add_argument("--prior-accepted")
    a=p.parse_args()

    S={x["scenario_id"]:x for x in read_jsonl(a.scenarios)}
    G={x["scenario_id"]:x for x in read_jsonl(a.generated)}
    A={x["scenario_id"]:x for x in read_jsonl(a.judge_a)}
    B={x["scenario_id"]:x for x in read_jsonl(a.judge_b)}
    accepted={x["scenario_id"]:x for x in read_jsonl(a.prior_accepted)} if a.prior_accepted else {}
    failures=[]; reasons={}; newly=0

    for sid,g in G.items():
        if sid in accepted: raise RuntimeError(f"duplicate accepted id {sid}")
        if sid not in S or sid not in A or sid not in B: raise RuntimeError(f"missing join {sid}")
        missing=list(g.get("missing_literals") or [])
        if missing:
            oka=False; ra="literal"
        else:
            oka,ra=parse_ok(S[sid],A[sid])
        okb,rb=parse_ok(S[sid],B[sid])
        if oka and okb:
            accepted[sid]={"scenario_id":sid,"family":S[sid]["family"],"text":g["text"],"context":S[sid]["context"],"attempt":a.round}
            newly+=1
        else:
            reason=f"A:{ra}|B:{rb}"
            reasons[reason]=reasons.get(reason,0)+1
            failures.append({
                "scenario_id":sid,"family":S[sid]["family"],"text":g["text"],
                "missing_literals":missing,
                "judge_a":A[sid],"judge_b":B[sid],
                "gold":S[sid]["gold"],"expected_flags":S[sid]["expected_flags"],
                "reason":reason
            })

    order={sid:i for i,sid in enumerate(S)}
    accepted_rows=sorted(accepted.values(),key=lambda x:order[x["scenario_id"]])
    retry_rows=[lang_view(S[x["scenario_id"]]) for x in failures]

    write_jsonl(a.accepted_out,accepted_rows)
    write_jsonl(a.retry_out,retry_rows)
    report={
      "round":a.round,"generated":len(G),"newly_accepted":newly,
      "total_accepted":len(accepted_rows),"retry_count":len(retry_rows),
      "reason_counts":reasons,"representative_failures":failures[:40]
    }
    open(a.report_out,"w",encoding="utf-8").write(json.dumps(report,ensure_ascii=False,indent=2))
    print(json.dumps({k:report[k] for k in ["round","generated","newly_accepted","total_accepted","retry_count"]},ensure_ascii=False))

if __name__=="__main__": main()
