from __future__ import annotations
import argparse, json, os
from llm_client import get_client, chat_json
import generate_utterances as gen
import judge_utterances as judge
from fidelity_round import parse_ok

FLAGS={"ambiguous":False,"conditional":False,"multi_effect":False,"invalid_quantity":False,"negated_only":False}

def sc(sid,meaning,gold,ctx=None,flags=None,lits=None):
    return {
      "scenario_id":sid,"family":"calibration","semantic_description":meaning,
      "gold":gold,"context":ctx or {},"expected_flags":flags or dict(FLAGS),
      "realization_constraints":{"style_bucket":"spoken-fa","preserve_literals":lits or []}
    }

CASES=[
 sc("cal_hide","Hide Part 12 in the viewport.",{"route":"do","op":"part.visibility","args":{"part_name":"Part 12","visible":False}},lits=["Part 12"]),
 sc("cal_radius","Set radius of Fillet 7 to exactly 2 mm.",{"route":"do","op":"feature.parameter.set","args":{"feature_name":"Fillet 7","parameter":"radius","amount":"2 mm"}},lits=["Fillet 7","2 mm"]),
 sc("cal_cond","Request showing Part 3 only if Part 3 is currently hidden.",{"route":"ask","op":None,"args":{}},flags={**FLAGS,"conditional":True},lits=["Part 3"]),
 sc("cal_amb","Request hiding either Part 4 or Part 7, but do not specify which one is the intended target.",{"route":"ask","op":None,"args":{}},flags={**FLAGS,"ambiguous":True},lits=["Part 4","Part 7"]),
 sc("cal_inspect","Cancel clearing the selection; instead ask only for a read-only report of selected entities.",{"route":"do","op":"viewer.inspect","args":{"mode":"selection"}},{"selection_count":2}),
 sc("cal_suppress","Suppress existing Extrude 9.",{"route":"do","op":"feature.patch","args":{"feature_name":"Extrude 9","suppressed":True}},lits=["Extrude 9"]),
 sc("cal_part_delete","Delete Part 15 from the model.",{"route":"do","op":"feature.delete_part","args":{"part_name":"Part 15"}},lits=["Part 15"]),
 sc("cal_zoom_correct","Cancel zoom-in and instead request zoom-out.",{"route":"do","op":"view.move","args":{"action":"zoom","direction":"out"}}),
]

DIRECT=[
 ("cal_hide","Part 12 رو توی نما مخفی کن"),
 ("cal_radius","شعاع Fillet 7 رو دقیقاً 2 mm کن"),
 ("cal_cond","اگر Part 3 مخفی بود، نشونش بده"),
 ("cal_amb","Part 4 یا Part 7 رو مخفی کن؛ معلوم نیست کدومشون"),
 ("cal_inspect","selection رو clear نکن؛ فقط بگو چی selected هست"),
 ("cal_suppress","Extrude 9 رو suppress کن"),
 ("cal_part_delete","خود Part 15 رو از مدل حذف کن"),
 ("cal_zoom_correct","zoom in نکن؛ به جاش zoom out کن"),
]

def judge_items(client,model,items,variant):
    role=("Reconstruct only effects literally entailed by the utterance."
          if variant=="A" else
          "Act as a skeptical safety reviewer; distinguish requested effects from cancelled, conditional, ambiguous, invalid, or extra effects.")
    system=judge.BASE+"\nJudge role "+variant+": "+role
    payload=[{"id":sid,"utterance":text,"context":next(c["context"] for c in CASES if c["scenario_id"]==sid)} for sid,text in items]
    data,usage=chat_json(client,model,system,json.dumps({"items":payload},ensure_ascii=False,separators=(",",":")),temperature=0,max_tokens=1400)
    got={str(x.get("id")):x for x in data.get("items",[]) if isinstance(x,dict)}
    rows=[]
    for c in CASES:
        sid=c["scenario_id"]; x=got.get(sid)
        if not x:
            rows.append({"id":sid,"ok":False,"reason":"missing"}); continue
        fl=x.get("flags") or {}
        parsed={"scenario_id":sid,"route":x.get("route"),"op":x.get("op"),"args":x.get("args") or {},
                "flags":{k:bool(fl.get(k,False)) for k in FLAGS}}
        ok,reason=parse_ok(c,parsed)
        rows.append({"id":sid,"ok":ok,"reason":reason,"parsed":parsed})
    return rows,usage

def main():
    p=argparse.ArgumentParser(); p.add_argument("--report",required=True); a=p.parse_args()
    generator=os.environ["GENERATOR_MODEL"]; judge_model=os.environ["JUDGE_MODEL"]
    primary=get_client("GROQ_API_KEY")
    backup=get_client("GROQ_API_KEY_BACKUP") if os.environ.get("GROQ_API_KEY_BACKUP","").strip() else primary

    direct_a,ua=judge_items(primary,judge_model,DIRECT,"A")
    direct_b,ub=judge_items(backup,judge_model,DIRECT,"B")
    if not all(x["ok"] for x in direct_a+direct_b):
        report={"pass":False,"stage":"direct_judge","generator_model":generator,"judge_model":judge_model,
                "direct_a":direct_a,"direct_b":direct_b,"usage":[ua,ub]}
        open(a.report,"w",encoding="utf-8").write(json.dumps(report,ensure_ascii=False,indent=2))
        raise SystemExit("judge calibration failed")

    gp=[]
    for c in CASES:
        gp.append({"id":c["scenario_id"],"meaning":c["semantic_description"],"context":c["context"],
                   "flags":c["expected_flags"],"style":"spoken-fa",
                   "preserve_literals":c["realization_constraints"]["preserve_literals"],"constraints":{}})
    data,ug=chat_json(primary,generator,gen.SYSTEM,json.dumps({"attempt":0,"items":gp},ensure_ascii=False,separators=(",",":")),temperature=0.5,max_tokens=500)
    got={str(x.get("id")):str(x.get("utterance","")).strip() for x in data.get("items",[]) if isinstance(x,dict)}
    generated=[]
    literal_fail=[]
    for c in CASES:
        sid=c["scenario_id"]; text=got.get(sid,"")
        missing=[lit for lit in c["realization_constraints"]["preserve_literals"] if lit not in text]
        if not text or missing: literal_fail.append({"id":sid,"text":text,"missing":missing})
        generated.append((sid,text))
    if literal_fail:
        report={"pass":False,"stage":"generator_literals","generator_model":generator,"judge_model":judge_model,
                "literal_failures":literal_fail,"generated":generated,"generator_raw":data,"usage":[ua,ub,ug]}
        open(a.report,"w",encoding="utf-8").write(json.dumps(report,ensure_ascii=False,indent=2))
        raise SystemExit("generator calibration failed")

    gen_a,uga=judge_items(primary,judge_model,generated,"A")
    gen_b,ugb=judge_items(backup,judge_model,generated,"B")
    passed=all(x["ok"] for x in gen_a+gen_b)
    report={"pass":passed,"stage":"complete" if passed else "generated_fidelity",
            "generator_model":generator,"judge_model":judge_model,
            "direct_a":direct_a,"direct_b":direct_b,"generated":generated,
            "generated_a":gen_a,"generated_b":gen_b,"usage":[ua,ub,ug,uga,ugb]}
    open(a.report,"w",encoding="utf-8").write(json.dumps(report,ensure_ascii=False,indent=2))
    if not passed: raise SystemExit("generated semantic calibration failed")
    print(json.dumps({"pass":True,"generator_model":generator,"judge_model":judge_model,"cases":len(CASES)}))

if __name__=="__main__": main()
