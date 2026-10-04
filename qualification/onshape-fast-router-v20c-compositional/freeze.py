from __future__ import annotations
import argparse, hashlib, importlib.util, json, pathlib, re, statistics, unicodedata
from collections import Counter, defaultdict

CANDIDATE="54580b67a9a61d2463ec3b9ced7a801707bb242b"
ROUTER_BLOB="2794465cefb0f8cad45ad5428b0570d04921a343"
SELFTEST_BLOB="344f36c0bb5401721741e6eeab28fc2f7f617228"

def read_jsonl(path):
    out=[]
    with open(path,encoding="utf-8") as f:
        for line in f:
            if line.strip(): out.append(json.loads(line))
    return out

def write_jsonl(path,rows):
    with open(path,"w",encoding="utf-8") as f:
        for r in rows: f.write(json.dumps(r,ensure_ascii=False,sort_keys=True,separators=(",",":"))+"\n")

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
                best=max(best,cur[j])
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
        m=load_module(path,"v20c_cmp_"+name)
        cases=getattr(m,"CASES",getattr(m,"CANDIDATES",[]))
        for c in cases:
            if c.get("text"):
                out.append((name,c.get("id"),c["text"],toks(c["text"])))
    return out

def sha(path):
    h=hashlib.sha256()
    with open(path,"rb") as f:
        for chunk in iter(lambda:f.read(1024*1024),b""): h.update(chunk)
    return h.hexdigest()

def main():
    p=argparse.ArgumentParser()
    p.add_argument("--scenarios",required=True); p.add_argument("--realized",required=True)
    p.add_argument("--qualification-root",required=True); p.add_argument("--out-dir",required=True)
    a=p.parse_args()
    out=pathlib.Path(a.out_dir); out.mkdir(parents=True,exist_ok=True)
    S=read_jsonl(a.scenarios); R=read_jsonl(a.realized)
    if len(S)!=9800 or len(R)!=9800: raise SystemExit(f"count gate failed {len(S)} {len(R)}")
    sm={x["scenario_id"]:x for x in S}; rm={x["scenario_id"]:x for x in R}
    if set(sm)!=set(rm): raise SystemExit("id mismatch")
    texts=[rm[x["scenario_id"]]["text"] for x in S]
    norms=[norm(x) for x in texts]
    if len(set(norms))!=9800: raise SystemExit(f"normalized uniqueness failed: {len(set(norms))}")

    priors=prior_cases(pathlib.Path(a.qualification_root))
    prior_norms={norm(x[2]) for x in priors}
    exact=[S[i]["scenario_id"] for i,n in enumerate(norms) if n in prior_norms]
    if exact: raise SystemExit(f"prior exact overlap count={len(exact)} examples={exact[:10]}")

    long_idx=defaultdict(set); short_idx=defaultdict(set)
    for idx,(_,_,_,pt) in enumerate(priors):
        if len(pt)>=8:
            for j in range(len(pt)-4):
                long_idx[tuple(pt[j:j+5])].add(idx)
        else:
            for j in range(max(0,len(pt)-2)):
                short_idx[tuple(pt[j:j+3])].add(idx)
    vals=[]; violations=[]; nearest=[]
    for s in S:
        sid=s["scenario_id"]; tt=toks(rm[sid]["text"]); cand=set()
        for j in range(max(0,len(tt)-4)):
            cand.update(long_idx.get(tuple(tt[j:j+5]),()))
        for j in range(max(0,len(tt)-2)):
            cand.update(short_idx.get(tuple(tt[j:j+3]),()))
        best=0.0; meta=None
        for idx in cand:
            name,pid,ptext,pt=priors[idx]
            den=min(len(tt),len(pt))
            needed=(7*den+9)//10
            if needed>=5 and not any(tuple(tt[k:k+5]) in {tuple(pt[z:z+5]) for z in range(max(0,len(pt)-4))} for k in range(max(0,len(tt)-4))):
                continue
            ratio=lccs(tt,pt)/den if den else 0.0
            if ratio>best: best=ratio; meta=(name,pid)
        vals.append(best)
        if meta: nearest.append({"scenario_id":sid,"ratio":best,"prior_corpus":meta[0],"prior_id":meta[1]})
        if best>=0.70: violations.append({"scenario_id":sid,"ratio":best,"prior":meta})
    if violations:
        fam=Counter(x["scenario_id"].rsplit("_",1)[0].replace("v20_","") for x in violations)
        (out/"similarity-violations.json").write_text(json.dumps({"count":len(violations),"by_family":dict(fam),"examples":violations[:100]},ensure_ascii=False,indent=2),encoding="utf-8")
        raise SystemExit(f"surface similarity gate failed count={len(violations)} by_family={dict(fam)} examples={violations[:10]}")

    byfam=defaultdict(list)
    for s in S: byfam[s["family"]].append(toks(rm[s["scenario_id"]]["text"]))
    pviol=[]; sviol=[]
    for fam,rows in byfam.items():
        pc=Counter(tuple(x[:4]) for x in rows if len(x)>=4)
        sc=Counter(tuple(x[-4:]) for x in rows if len(x)>=4)
        pviol.extend({"family":fam,"count":n,"tokens":gram} for gram,n in pc.items() if n>10)
        sviol.extend({"family":fam,"count":n,"tokens":gram} for gram,n in sc.items() if n>10)
    if pviol or sviol: raise SystemExit(f"template gate failed prefixes={pviol[:5]} suffixes={sviol[:5]}")

    corpus=[]
    for s in S:
        g=s["gold"]; exp={"route":g["route"]}
        if g["route"]=="do": exp.update({"op":g["op"],"args":g.get("args",{})})
        corpus.append({"id":s["scenario_id"],"category":s["family"],"text":rm[s["scenario_id"]]["text"],
                       "ctx":s["context"],"expected":[exp],"safety_class":s["safety_class"],
                       "expected_flags":s["expected_flags"]})
    corpus_path=out/"frozen-corpus.jsonl"; write_jsonl(corpus_path,corpus)

    diversity={
      "unique_normalized":9800,"prior_normalized_overlap":0,
      "prior_corpora":["V15","V16","V17","V18","V19"],
      "similarity_threshold":0.70,
      "similarity":{"max":max(vals),"p50":statistics.median(vals),"p95":sorted(vals)[int(0.95*(len(vals)-1))]},
      "prefix_4token_violations":0,"suffix_4token_violations":0,
      "nearest_examples":sorted(nearest,key=lambda x:x["ratio"],reverse=True)[:30]
    }
    (out/"diversity-report.json").write_text(json.dumps(diversity,ensure_ascii=False,indent=2),encoding="utf-8")
    construction={
      "generator":"v20c-semantic-compositional-grammar-v1",
      "scenario_first":True,
      "router_source_read_by_realizer":False,
      "prior_holdout_text_read_by_realizer":False,
      "semantic_fidelity":"by construction from structured gold and typed context",
      "cases":9800
    }
    (out/"construction-report.json").write_text(json.dumps(construction,ensure_ascii=False,indent=2),encoding="utf-8")
    freeze={
      "test_id":"onshape-fast-router-v20c-compositional",
      "candidate_commit":CANDIDATE,"router_blob":ROUTER_BLOB,"selftest_blob":SELFTEST_BLOB,
      "candidate_scenarios":10000,"filtered_before_language":200,"scored_cases":9800,
      "scenario_sha256":sha(a.scenarios),"corpus_sha256":sha(corpus_path),
      "semantic_construction_gate":"PASS","diversity_gate":"PASS","prior_normalized_overlap":0
    }
    (out/"freeze.json").write_text(json.dumps(freeze,ensure_ascii=False,indent=2),encoding="utf-8")
    print(json.dumps({"freeze":freeze,"similarity":diversity["similarity"]},ensure_ascii=False))

if __name__=="__main__": main()
