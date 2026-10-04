from __future__ import annotations
import argparse, hashlib, importlib.util, json, math, os, pathlib, re, statistics, unicodedata
from collections import Counter, defaultdict
from llm_client import read_jsonl, write_jsonl

CANDIDATE="54580b67a9a61d2463ec3b9ced7a801707bb242b"
ROUTER_BLOB="2794465cefb0f8cad45ad5428b0570d04921a343"
SELFTEST_BLOB="344f36c0bb5401721741e6eeab28fc2f7f617228"

def norm(s):
    s=unicodedata.normalize("NFKC",s).replace("\u200c"," ").lower()
    s=re.sub(r"[«»\"'“”؟?!،,؛;:()\[\]{}]"," ",s)
    return re.sub(r"\s+"," ",s).strip()
def toks(s): return norm(s).split()
def lccs(a,b):
    if not a or not b: return 0
    prev=[0]*(len(b)+1); best=0
    for x in a:
        cur=[0]*(len(b)+1)
        for j,y in enumerate(b,1):
            if x==y:
                cur[j]=prev[j-1]+1
                if cur[j]>best: best=cur[j]
        prev=cur
    return best
def load_module(path,name):
    spec=importlib.util.spec_from_file_location(name,path)
    mod=importlib.util.module_from_spec(spec); spec.loader.exec_module(mod); return mod
def prior_cases(root):
    specs=[
      ("v15",root/"onshape-fast-router-divergent-v15-10000"/"fresh_holdout_v15_10000.py"),
      ("v16",root/"onshape-fast-router-fresh-v16-filtered"/"fresh_holdout_v16_filtered_10000.py"),
      ("v17",root/"onshape-fast-router-fresh-v17-independent"/"fresh_holdout_v17_independent_10000.py"),
      ("v18",root/"onshape-fast-router-fresh-v18-independent"/"fresh_holdout_v18_independent_10000.py"),
      ("v19",root/"onshape-fast-router-fresh-v19-independent"/"fresh_holdout_v19_independent_10000.py"),
    ]
    out=[]
    for name,path in specs:
        m=load_module(path,"v20_cmp_"+name)
        cases=getattr(m,"CASES",getattr(m,"CANDIDATES",[]))
        for c in cases:
            if c.get("text"): out.append((name,c.get("id"),c["text"],toks(c["text"])))
    return out

def sha(path):
    h=hashlib.sha256()
    with open(path,"rb") as f:
        for chunk in iter(lambda:f.read(1024*1024),b""): h.update(chunk)
    return h.hexdigest()

def main():
    p=argparse.ArgumentParser()
    p.add_argument("--scenarios",required=True); p.add_argument("--accepted",required=True)
    p.add_argument("--qualification-root",required=True); p.add_argument("--out-dir",required=True)
    p.add_argument("--round-reports",nargs="*",default=[])
    a=p.parse_args()
    out=pathlib.Path(a.out_dir); out.mkdir(parents=True,exist_ok=True)
    scenarios=read_jsonl(a.scenarios); accepted=read_jsonl(a.accepted)
    if len(scenarios)!=9800 or len(accepted)!=9800: raise SystemExit(f"count gate failed scenarios={len(scenarios)} accepted={len(accepted)}")
    S={x["scenario_id"]:x for x in scenarios}; A={x["scenario_id"]:x for x in accepted}
    if set(S)!=set(A): raise SystemExit("scenario/accepted id mismatch")

    texts=[A[x["scenario_id"]]["text"] for x in scenarios]
    norms=[norm(x) for x in texts]
    if len(set(norms))!=9800: raise SystemExit("normalized uniqueness gate failed")

    priors=prior_cases(pathlib.Path(a.qualification_root))
    pnorm={norm(x[2]) for x in priors}
    exact=[S[scenarios[i]["scenario_id"]]["scenario_id"] for i,n in enumerate(norms) if n in pnorm]
    if exact: raise SystemExit(f"prior normalized overlap gate failed count={len(exact)} examples={exact[:10]}")

    trig=defaultdict(set)
    for idx,(_,_,_,tt) in enumerate(priors):
        if len(tt)>=3:
            for j in range(len(tt)-2): trig[tuple(tt[j:j+3])].add(idx)
    simvals=[]; violations=[]; nearest=[]
    for s in scenarios:
        sid=s["scenario_id"]; tt=toks(A[sid]["text"]); cand=set()
        if len(tt)>=3:
            for j in range(len(tt)-2): cand.update(trig.get(tuple(tt[j:j+3]),()))
        best=0.0; bestmeta=None
        for idx in cand:
            name,pid,ptext,pt=priors[idx]
            L=lccs(tt,pt); den=min(len(tt),len(pt))
            ratio=(L/den) if den else 0.0
            if ratio>best: best=ratio; bestmeta=(name,pid,ptext,L,den)
        simvals.append(best)
        if bestmeta: nearest.append({"scenario_id":sid,"ratio":best,"prior_corpus":bestmeta[0],"prior_id":bestmeta[1]})
        if best>=0.70: violations.append({"scenario_id":sid,"ratio":best,"prior":bestmeta[:2] if bestmeta else None})
    if violations: raise SystemExit(f"surface similarity gate failed count={len(violations)} examples={violations[:10]}")

    byfam=defaultdict(list)
    for s in scenarios: byfam[s["family"]].append(toks(A[s["scenario_id"]]["text"]))
    prefix_viol=[]; suffix_viol=[]
    for fam,rows in byfam.items():
        pc=Counter(tuple(x[:4]) for x in rows if len(x)>=4)
        sc=Counter(tuple(x[-4:]) for x in rows if len(x)>=4)
        for gram,n in pc.items():
            if n>10: prefix_viol.append({"family":fam,"count":n,"tokens":gram})
        for gram,n in sc.items():
            if n>10: suffix_viol.append({"family":fam,"count":n,"tokens":gram})
    if prefix_viol or suffix_viol:
        raise SystemExit(f"within-family template gate failed prefixes={prefix_viol[:8]} suffixes={suffix_viol[:8]}")

    corpus=[]
    for s in scenarios:
        g=s["gold"]; exp={"route":g["route"]}
        if g["route"]=="do": exp.update({"op":g["op"],"args":g.get("args",{})})
        corpus.append({"id":s["scenario_id"],"category":s["family"],"text":A[s["scenario_id"]]["text"],
                       "ctx":s["context"],"expected":[exp],"safety_class":s["safety_class"],"expected_flags":s["expected_flags"]})
    corpus_path=out/"frozen-corpus.jsonl"; write_jsonl(corpus_path,corpus)

    reports=[]
    for rp in a.round_reports:
        path=pathlib.Path(rp)
        if path.exists(): reports.append(json.loads(path.read_text(encoding="utf-8")))
    first=reports[0] if reports else {}
    fidelity={
      "rounds":reports,
      "first_attempt_pass_rate":(first.get("newly_accepted",0)/9800 if first else None),
      "regenerated_realizations":sum(r.get("newly_accepted",0) for r in reports[1:]),
      "unresolved_scenarios":9800-(reports[-1].get("total_accepted",0) if reports else 0),
      "generator_model":os.environ.get("GENERATOR_MODEL","unknown"),
      "judge_models":[os.environ.get("JUDGE_MODEL","unknown"),os.environ.get("JUDGE_MODEL","unknown")],
      "judge_b_key_preference":"GROQ_API_KEY_BACKUP if provisioned, else primary",
      "router_used_in_fidelity":False,
    }
    (out/"fidelity-report.json").write_text(json.dumps(fidelity,ensure_ascii=False,indent=2),encoding="utf-8")
    diversity={
      "unique_normalized":len(set(norms)),"prior_normalized_overlap":0,
      "prior_corpora":["V15","V16","V17","V18","V19"],
      "similarity_metric":"longest common contiguous token span / shorter utterance among trigram-retrieved prior candidates",
      "similarity_threshold":0.70,
      "similarity":{"max":max(simvals),"p50":statistics.median(simvals),"p95":sorted(simvals)[int(0.95*(len(simvals)-1))]},
      "prefix_4token_violations":0,"suffix_4token_violations":0,
      "nearest_examples":sorted(nearest,key=lambda x:x["ratio"],reverse=True)[:30]
    }
    (out/"diversity-report.json").write_text(json.dumps(diversity,ensure_ascii=False,indent=2),encoding="utf-8")

    scenario_hash=sha(a.scenarios); corpus_hash=sha(corpus_path)
    freeze={
      "test_id":"onshape-fast-router-v20-blind-semantic",
      "candidate_commit":CANDIDATE,"router_blob":ROUTER_BLOB,"selftest_blob":SELFTEST_BLOB,
      "candidate_scenarios":10000,"filtered_before_language":200,"scored_cases":9800,
      "scenario_sha256":scenario_hash,"corpus_sha256":corpus_hash,
      "fidelity_gate":"PASS","diversity_gate":"PASS","prior_normalized_overlap":0
    }
    (out/"freeze.json").write_text(json.dumps(freeze,ensure_ascii=False,indent=2),encoding="utf-8")
    print(json.dumps({"freeze":freeze,"diversity":diversity["similarity"],"fidelity_first_pass":fidelity["first_attempt_pass_rate"]},ensure_ascii=False))

if __name__=="__main__": main()
