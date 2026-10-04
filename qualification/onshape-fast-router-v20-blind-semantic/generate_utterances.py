from __future__ import annotations
import argparse, json, os, re, unicodedata
from llm_client import get_client, chat_json, read_jsonl, write_jsonl, chunks

def norm_literal(s):
    s=unicodedata.normalize("NFKC",str(s))
    s=s.replace("\u00a0"," ").replace("\u202f"," ").replace("\u2009"," ")
    return re.sub(r"\\s+"," ",s).strip()

SYSTEM="""You are a blind natural-language realizer for a CAD apprentice evaluation.
You receive structured semantic scenarios only. You do not know the router source,
its phrase lists, or any previous benchmark utterances.

For every item, write exactly ONE natural owner-to-apprentice Onshape command in Persian.
Natural Persian/English CAD code-switching is allowed when the style bucket calls for it.
Do not explain. Do not add effects. Do not remove effects.
Do not resolve deliberate ambiguity, conditions, invalid values, multiple-effect structure,
or negative-only structure. Preserve every literal in preserve_literals EXACTLY as written.
Avoid shared canned openers/closers and make wording genuinely varied.

Return JSON only:
{"items":[{"id":"scenario_id","utterance":"..."}]}
Every input id must appear exactly once."""

def main():
    p=argparse.ArgumentParser()
    p.add_argument("--input",required=True); p.add_argument("--output",required=True)
    p.add_argument("--attempt",type=int,required=True); p.add_argument("--batch-size",type=int,default=100)
    a=p.parse_args()
    model=os.environ.get("GENERATOR_MODEL","openai/gpt-oss-120b")
    client=get_client("GROQ_API_KEY")
    src=read_jsonl(a.input); out=[]; usage=[]
    for batch_no,batch in enumerate(chunks(src,a.batch_size),1):
        byid={x["scenario_id"]:x for x in batch}
        pending=dict(byid); collected={}
        for subtry in range(1,5):
            if not pending: break
            payload=[]
            for r in pending.values():
                payload.append({
                    "id":r["scenario_id"],
                    "meaning":r["semantic_description"],
                    "context":r.get("context",{}),
                    "flags":r.get("expected_flags",{}),
                    "style":r.get("realization_constraints",{}).get("style_bucket"),
                    "preserve_literals":r.get("realization_constraints",{}).get("preserve_literals",[]),
                    "constraints":{k:v for k,v in r.get("realization_constraints",{}).items()
                                   if k not in {"style_bucket","preserve_literals","language"}},
                })
            data,u=chat_json(client,model,SYSTEM,
                json.dumps({"attempt":a.attempt,"subtry":subtry,"items":payload},ensure_ascii=False,separators=(",",":")),
                temperature=0.7,max_tokens=min(8000,max(1800,95*len(payload))))
            usage.append(u)
            items=data.get("items") if isinstance(data,dict) else None
            if not isinstance(items,list): items=[]
            got={str(x.get("id")):x for x in items if isinstance(x,dict) and str(x.get("id")) in pending}
            for sid,x in got.items():
                utt=str(x.get("utterance","")).strip()
                if not utt: continue
                s=pending[sid]
                nu=norm_literal(utt)
                missing=[lit for lit in s.get("realization_constraints",{}).get("preserve_literals",[]) if norm_literal(lit) not in nu]
                if missing: continue
                collected[sid]={"scenario_id":sid,"family":s["family"],"text":utt,"context":s.get("context",{}),"missing_literals":[]}
            pending={sid:s for sid,s in pending.items() if sid not in collected}
        if pending:
            raise RuntimeError(f"generator unresolved after retries batch={batch_no} missing={sorted(pending)[:10]}")
        for r in batch:
            out.append(collected[r["scenario_id"]])
        print(json.dumps({"progress":"generator","batch":batch_no,"emitted":len(out)},ensure_ascii=False),flush=True)
    write_jsonl(a.output,out)
    print(json.dumps({"attempt":a.attempt,"model":model,"cases":len(out),"batches":len(usage),"usage":usage},ensure_ascii=False))

if __name__=="__main__": main()
