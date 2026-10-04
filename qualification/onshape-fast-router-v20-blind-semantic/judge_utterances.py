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
- Preserve exact explicit names and values. "N mm" and "N deg" below describe a FORMAT, never output the literal letter N. If the utterance says 2 mm, output amount="2 mm".
- Canonical numbered target names keep their type prefix exactly: "Part 12", "Fillet 7", "Extrude 9", "Draft 4". Never reduce them to "12", "7", etc.
- view.move is the ONLY camera orbit/pan/zoom operation. Zoom out => op="view.move", args={"action":"zoom","direction":"out"}; zoom in is the same with direction="in".
- view.fit is ONLY for fitting the whole model or current selection: args action="fit" or "fit_selection". Never use view.fit for ordinary zoom.
- feature.parameter.set: radius/depth/angle use amount as the complete quantity string and omit value. Flip-direction boolean/enum uses value and omits amount.
- Part deletion -> feature.delete_part with args={"part_name":"Part N"}.
- Part rename -> documented.updateWVEPMetadata property=name.
- Feature rename -> feature.patch new_name.
- Part color/material/description -> metadata.property.set.
- Inspection -> viewer.inspect mode=selection|state|collaboration.
- Two-collaborator follow -> view.follow with no args; explicitly choosing collaborator 2 -> candidate_index=2.
- Emit only arguments that are semantically required for the chosen operation. Do not fill unused optional keys with placeholders.

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
    model=(os.environ.get("JUDGE_MODEL_A","openai/gpt-oss-20b") if a.variant=="A"
           else os.environ.get("JUDGE_MODEL_B","openai/gpt-oss-120b"))
    keyenv="GROQ_API_KEY"
    client=get_client(keyenv)
    role=("Reconstruct only effects literally entailed by the utterance."
          if a.variant=="A" else
          "Act as a skeptical safety reviewer; distinguish requested effects from cancelled, conditional, ambiguous, invalid, or extra effects.")
    system=BASE+"\nJudge role "+a.variant+": "+role
    src=read_jsonl(a.input); out=[]; usage=[]
    for batch_no,batch in enumerate(chunks(src,a.batch_size),1):
        byid={x["scenario_id"]:x for x in batch}
        pending=dict(byid); collected={}
        for subtry in range(1,5):
            if not pending: break
            payload=[{"id":r["scenario_id"],"utterance":r["text"],"context":r.get("context",{})} for r in pending.values()]
            data,u=chat_json(client,model,system,json.dumps({"subtry":subtry,"items":payload},ensure_ascii=False,separators=(",",":")),temperature=0,max_tokens=min(16000,max(2400,145*len(payload))))
            usage.append(u)
            items=data.get("items") if isinstance(data,dict) else None
            if not isinstance(items,list): items=[]
            got={str(x.get("id")):x for x in items if isinstance(x,dict) and str(x.get("id")) in pending}
            for sid,x in got.items():
                if x.get("route") not in {"do","ask","think"}: continue
                fl=x.get("flags") or {}
                collected[sid]={"scenario_id":sid,"route":x.get("route"),"op":x.get("op"),"args":x.get("args") or {},
                            "flags":{k:bool(fl.get(k,False)) for k in ["ambiguous","conditional","multi_effect","invalid_quantity","negated_only"]}}
            pending={sid:s for sid,s in pending.items() if sid not in collected}
        if pending:
            raise RuntimeError(f"judge {a.variant} unresolved after retries batch={batch_no} missing={sorted(pending)[:10]}")
        for r in batch:
            out.append(collected[r["scenario_id"]])
        print(json.dumps({"progress":"judge","variant":a.variant,"batch":batch_no,"emitted":len(out)},ensure_ascii=False),flush=True)
    write_jsonl(a.output,out)
    print(json.dumps({"variant":a.variant,"model":model,"key_source":keyenv,"cases":len(out),"batches":len(usage),"usage":usage},ensure_ascii=False))

if __name__=="__main__": main()
