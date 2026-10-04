from __future__ import annotations
import argparse, json, os
from llm_client import get_client, chat_json, read_jsonl, write_jsonl, chunks

OPS={
"view.move":["action","direction"],"view.fit":["action"],"view.standard":["view"],
"viewer.selection.clear":[],"viewer.inspect":["mode"],"view.follow":["candidate_index"],
"feature.from_selection":["feature_type","amount"],
"feature.parameter.set":["feature_name","parameter","amount","value"],
"feature.patch":["feature_name","suppressed","new_name"],
"feature.delete":["feature_name","position"],"feature.delete_part":["part_name"],
"part.visibility":["part_name","visible"],
"metadata.property.set":["part_name","property","value"],
"documented.updateWVEPMetadata":["part_name","property","value"],
"feature.add":["feature_type","name","part_name","copies","distance","amount"],
"feature.reorder":["source_feature","target_feature","placement"],
"rollback.set":["before_feature","after_feature","position"],
"documented.createPartStudio":["new_name"],
"documented.updateDocumentAttributes":["new_name"]
}
BASE="""You are an independent semantic judge for a bounded Onshape apprentice command.
Parse meaning, not keyword similarity. You have no access to the router under test or the gold answer.

Routing contract:
- route=do only for exactly one fully grounded, valid bounded effect or read-only inspection.
- route=ask for two independent effects, a real semantic condition, ambiguous/missing target,
  invalid quantity, or a negative-only instruction with no positive requested replacement.
- route=think only for open-ended engineering/design judgment.
- A correction like "do not X; instead Y" is one positive effect Y if unambiguous.
- Preserve exact explicit names and values. Normalize ordinary numeric units to "N mm" or "N deg".
- Part rename -> documented.updateWVEPMetadata property=name.
- Feature rename -> feature.patch new_name.
- Part color/material/description -> metadata.property.set.
- Inspection -> viewer.inspect mode=selection|state|collaboration.
- Two-collaborator follow -> view.follow with no args; explicitly choosing collaborator 2 -> candidate_index=2.

Allowed operations and argument names:
""" + json.dumps(OPS,ensure_ascii=False,separators=(",",":")) + """

Return JSON only:
{"items":[{"id":"...","route":"do|ask|think","op":"operation-or-null","args":{},
"flags":{"ambiguous":false,"conditional":false,"multi_effect":false,"invalid_quantity":false,"negated_only":false}}]}
Every id exactly once."""

def main():
    p=argparse.ArgumentParser()
    p.add_argument("--input",required=True); p.add_argument("--output",required=True)
    p.add_argument("--variant",choices=["A","B"],required=True); p.add_argument("--batch-size",type=int,default=100)
    a=p.parse_args()
    model=os.environ.get("JUDGE_MODEL","openai/gpt-oss-20b")
    keyenv="GROQ_API_KEY_BACKUP" if a.variant=="B" and os.environ.get("GROQ_API_KEY_BACKUP","").strip() else "GROQ_API_KEY"
    client=get_client(keyenv)
    role=("Reconstruct only effects literally entailed by the utterance."
          if a.variant=="A" else
          "Act as a skeptical safety reviewer; distinguish requested effects from cancelled, conditional, ambiguous, invalid, or extra effects.")
    system=BASE+"\nJudge role "+a.variant+": "+role
    src=read_jsonl(a.input); out=[]; usage=[]
    for batch in chunks(src,a.batch_size):
        payload=[{"id":r["scenario_id"],"utterance":r["text"],"context":r.get("context",{})} for r in batch]
        data,u=chat_json(client,model,system,json.dumps({"items":payload},ensure_ascii=False,separators=(",",":")),temperature=0,max_tokens=16000)
        items=data.get("items") if isinstance(data,dict) else None
        if not isinstance(items,list): raise RuntimeError("judge missing items")
        got={str(x.get("id")):x for x in items if isinstance(x,dict)}
        ids=[x["scenario_id"] for x in batch]
        if set(got)!=set(ids):
            raise RuntimeError(f"judge {a.variant} id mismatch missing={sorted(set(ids)-set(got))[:5]} extra={sorted(set(got)-set(ids))[:5]}")
        for sid in ids:
            x=got[sid]; fl=x.get("flags") or {}
            out.append({"scenario_id":sid,"route":x.get("route"),"op":x.get("op"),"args":x.get("args") or {},
                        "flags":{k:bool(fl.get(k,False)) for k in ["ambiguous","conditional","multi_effect","invalid_quantity","negated_only"]}})
        usage.append(u)
    write_jsonl(a.output,out)
    print(json.dumps({"variant":a.variant,"model":model,"key_source":keyenv,"cases":len(out),"batches":len(usage),"usage":usage},ensure_ascii=False))

if __name__=="__main__": main()
