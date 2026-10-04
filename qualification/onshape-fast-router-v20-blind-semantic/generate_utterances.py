from __future__ import annotations
import argparse, json, os
from llm_client import get_client, chat_json, read_jsonl, write_jsonl, chunks

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
    for batch in chunks(src,a.batch_size):
        payload=[]
        for r in batch:
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
            json.dumps({"attempt":a.attempt,"items":payload},ensure_ascii=False,separators=(",",":")),
            temperature=0.7,max_tokens=14000)
        items=data.get("items") if isinstance(data,dict) else None
        if not isinstance(items,list): raise RuntimeError("generator missing items")
        got={str(x.get("id")):x for x in items if isinstance(x,dict)}
        ids=[x["scenario_id"] for x in batch]
        if set(got)!=set(ids):
            raise RuntimeError(f"generator id mismatch missing={sorted(set(ids)-set(got))[:5]} extra={sorted(set(got)-set(ids))[:5]}")
        byid={x["scenario_id"]:x for x in batch}
        for sid in ids:
            utt=str(got[sid].get("utterance","")).strip()
            if not utt: raise RuntimeError(f"empty utterance {sid}")
            s=byid[sid]
            for lit in s.get("realization_constraints",{}).get("preserve_literals",[]):
                if lit not in utt: raise RuntimeError(f"literal not preserved {sid}: {lit!r}")
            out.append({"scenario_id":sid,"family":s["family"],"text":utt,"context":s.get("context",{})})
        usage.append(u)
    write_jsonl(a.output,out)
    print(json.dumps({"attempt":a.attempt,"model":model,"cases":len(out),"batches":len(usage),"usage":usage},ensure_ascii=False))

if __name__=="__main__": main()
