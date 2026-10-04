from __future__ import annotations
import argparse, json, os
from llm_client import get_client, chat_json
import generate_utterances as gen
import judge_utterances as judge
from fidelity_round import parse_ok

FLAGS={"ambiguous":False,"conditional":False,"multi_effect":False,"invalid_quantity":False,"negated_only":False}

def sc(sid,meaning,gold,ctx=None,flags=None,lits=None):
    return {"scenario_id":sid,"family":"calibration","semantic_description":meaning,
            "gold":gold,"context":ctx or {},"expected_flags":flags or dict(FLAGS),
            "realization_constraints":{"style_bucket":"spoken-fa","preserve_literals":lits or []}}

CASES=[
 sc("cal_hide","Hide Part 12 in the viewport.",{"route":"do","op":"part.visibility","args":{"part_name":"Part 12","visible":False}},lits=["Part 12"]),
 sc("cal_radius","Set radius of Fillet 7 to exactly 2 mm.",{"route":"do","op":"feature.parameter.set","args":{"feature_name":"Fillet 7","parameter":"radius","amount":"2 mm"}},lits=["Fillet 7","2 mm"]),
 sc("cal_cond","Request showing Part 3 only if Part 3 is currently hidden.",{"route":"ask","op":None,"args":{}},flags={**FLAGS,"conditional":True},lits=["Part 3"]),
 sc("cal_amb","Request hiding either Part 4 or Part 7, but do not specify which target is intended.",{"route":"ask","op":None,"args":{}},flags={**FLAGS,"ambiguous":True},lits=["Part 4","Part 7"]),
 sc("cal_inspect","Cancel clearing the selection; instead request only a read-only report of selected entities.",{"route":"do","op":"viewer.inspect","args":{"mode":"selection"}},{"selection_count":2}),
 sc("cal_suppress","Suppress existing Extrude 9.",{"route":"do","op":"feature.patch","args":{"feature_name":"Extrude 9","suppressed":True}},lits=["Extrude 9"]),
 sc("cal_part_delete","Delete Part 15 from the model.",{"route":"do","op":"feature.delete_part","args":{"part_name":"Part 15"}},lits=["Part 15"]),
 sc("cal_zoom_correct","Cancel zoom-in and instead request zoom-out.",{"route":"do","op":"view.move","args":{"action":"zoom","direction":"out"}}),
]
BYID={c["scenario_id"]:c for c in CASES}

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
          "Act as a skeptical semantic safety reviewer. A cancelled action is not a requested effect; 'do not X, instead Y' contains one requested effect Y.")
    system=judge.BASE+"\nJudge role "+variant+": "+role
    payload=[{"id":sid,"utterance":text,"context":BYID[sid]["context"]} for sid,text in items]
    data,usage=chat_json(client,model,system,json.dumps({"items":payload},ensure_ascii=False,separators=(",",":")),temperature=0,max_tokens=max(900,170*len(items)))
    got={str(x.get("id")):x for x in data.get("items",[]) if isinstance(x,dict)}
    rows=[]
    for sid,_ in items:
        c=BYID[sid]; x=got.get(sid)
        if not x:
            rows.append({"id":sid,"ok":False,"reason":"missing"}); continue
        fl=x.get("flags") or {}
        parsed={"scenario_id":sid,"route":x.get("route"),"op":x.get("op"),"args":x.get("args") or {},
                "flags":{k:bool(fl.get(k,False)) for k in FLAGS}}
        ok,reason=parse_ok(c,parsed)
        rows.append({"id":sid,"ok":ok,"reason":reason,"parsed":parsed})
    return rows,usage

def generate_once(client,model,cases,attempt):
    gp=[{"id":c["scenario_id"],"meaning":c["semantic_description"],"context":c["context"],
         "flags":c["expected_flags"],"style":"spoken-fa",
         "preserve_literals":c["realization_constraints"]["preserve_literals"],"constraints":{}}
        for c in cases]
    data,usage=chat_json(client,model,gen.SYSTEM,json.dumps({"attempt":attempt,"items":gp},ensure_ascii=False,separators=(",",":")),temperature=0.7,max_tokens=max(900,190*len(cases)))
    got={str(x.get("id")):str(x.get("utterance","")).strip() for x in data.get("items",[]) if isinstance(x,dict)}
    good=[]; failures=[]
    for c in cases:
        sid=c["scenario_id"]; text=got.get(sid,"")
        missing=[lit for lit in c["realization_constraints"]["preserve_literals"] if lit not in text]
        if not text or missing: failures.append({"id":sid,"text":text,"missing":missing})
        else: good.append((sid,text))
    return good,failures,usage

def main():
    p=argparse.ArgumentParser(); p.add_argument("--report",required=True); a=p.parse_args()
    generator=os.environ["GENERATOR_MODEL"]; ma=os.environ["JUDGE_MODEL_A"]; mb=os.environ["JUDGE_MODEL_B"]
    primary=get_client("GROQ_API_KEY")
    backup=primary

    direct_a,ua=judge_items(primary,ma,DIRECT,"A")
    direct_b,ub=judge_items(backup,mb,DIRECT,"B")
    if not all(x["ok"] for x in direct_a+direct_b):
        report={"pass":False,"stage":"direct_judge","generator_model":generator,"judge_model_a":ma,"judge_model_b":mb,
                "direct_a":direct_a,"direct_b":direct_b,"usage":[ua,ub]}
        open(a.report,"w",encoding="utf-8").write(json.dumps(report,ensure_ascii=False,indent=2))
        raise SystemExit("judge calibration failed")

    unresolved=list(CASES); accepted={}; rounds=[]; usage=[ua,ub]
    for attempt in range(1,4):
        generated,literal_fail,ug=generate_once(primary,generator,unresolved,attempt); usage.append(ug)
        valid_ids={sid for sid,_ in generated}
        ga,uga=judge_items(primary,ma,generated,"A") if generated else ([],{})
        gb,ugb=judge_items(backup,mb,generated,"B") if generated else ([],{})
        usage.extend([uga,ugb])
        oka={x["id"]:x for x in ga}; okb={x["id"]:x for x in gb}
        failed_ids={x["id"] for x in literal_fail}
        for sid,text in generated:
            if oka[sid]["ok"] and okb[sid]["ok"]: accepted[sid]=text
            else: failed_ids.add(sid)
        rounds.append({"attempt":attempt,"input":len(unresolved),"accepted_total":len(accepted),
                       "literal_failures":literal_fail,
                       "judge_a_failures":[x for x in ga if not x["ok"]],
                       "judge_b_failures":[x for x in gb if not x["ok"]]})
        unresolved=[BYID[sid] for sid in BYID if sid not in accepted]
        if not unresolved: break

    passed=not unresolved
    report={"pass":passed,"stage":"complete" if passed else "generated_fidelity",
            "generator_model":generator,"judge_model_a":ma,"judge_model_b":mb,
            "direct_a":direct_a,"direct_b":direct_b,"rounds":rounds,
            "accepted":[[sid,accepted[sid]] for sid in sorted(accepted)],"unresolved":[c["scenario_id"] for c in unresolved],
            "usage":usage}
    open(a.report,"w",encoding="utf-8").write(json.dumps(report,ensure_ascii=False,indent=2))
    if not passed: raise SystemExit("generated semantic calibration unresolved after 3 attempts")
    print(json.dumps({"pass":True,"generator_model":generator,"judge_model_a":ma,"judge_model_b":mb,"cases":len(CASES)}))

if __name__=="__main__": main()
