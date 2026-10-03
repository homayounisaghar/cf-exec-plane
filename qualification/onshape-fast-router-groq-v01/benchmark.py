from __future__ import annotations
import json, os, re, statistics, time, urllib.error, urllib.request

MODELS = ["openai/gpt-oss-20b", "openai/gpt-oss-120b"]
ENDPOINT = "https://api.groq.com/openai/v1/chat/completions"

OPS = [
    "view.move", "view.fit", "view.standard", "viewer.selection.clear",
    "feature.from_selection", "feature.parameter.set", "feature.patch",
    "feature.delete", "feature.add", "feature.reorder", "part.visibility",
    "metadata.property.set", "rollback.set", "documented.createPartStudio",
    "documented.updateDocumentAttributes", "documented.updateWVEPMetadata",
]

SYSTEM = """You are the fast intent compiler for a personal Onshape operator.
Convert one short human command into a tiny executable recipe.
Do not solve open-ended design problems. Do not invent capabilities.
Use only the listed operations. If a routine command is missing a required
referent or value, return clarify. If it asks for design judgment or open-ended
redesign, return design. Use supplied context for words such as this, it, same,
again, more, and back. Output must follow the schema exactly.

Available operations:
- view.move(action=orbit|pan|zoom, direction=left|right|up|down|clockwise|counterclockwise|in|out, intensity optional)
- view.fit(action=fit|fit_selection)
- view.standard(view=top)
- viewer.selection.clear
- feature.from_selection(feature_type=fillet|chamfer, amount)
- feature.parameter.set(feature, parameter, amount/value)
- feature.patch(feature, suppressed or new_name)
- feature.delete(feature or position=last|first)
- feature.add(feature_type=plane|linearPattern|fillet|chamfer, target/copies/distance/amount as needed)
- feature.reorder(source_feature, target_feature, placement=before|after)
- part.visibility(part, visible)
- metadata.property.set(part optional, property, value)
- rollback.set(before_feature|after_feature|position)
- documented.createPartStudio(new_name)
- documented.updateDocumentAttributes(new_name)
- documented.updateWVEPMetadata(part, property, value)

Rules:
- Existing Viewer selection is a first-class target; never re-pick it.
- For "more" repeat the last camera direction with moderately larger intensity.
- For "a little back" use the opposite direction with smaller intensity.
- Routine operations should execute without explanation.
- Open-ended aesthetic or engineering design requests are design, not execute.
"""

STEP_PROPERTIES = {
    "op": {"type": "string", "enum": OPS},
    "action": {"type": ["string", "null"], "enum": ["orbit", "pan", "zoom", "fit", "fit_selection", "clear", None]},
    "direction": {"type": ["string", "null"], "enum": ["left", "right", "up", "down", "clockwise", "counterclockwise", "in", "out", None]},
    "intensity": {"type": ["number", "null"]},
    "view": {"type": ["string", "null"], "enum": ["top", None]},
    "feature_type": {"type": ["string", "null"], "enum": ["fillet", "chamfer", "plane", "linearPattern", None]},
    "feature_name": {"type": ["string", "null"]},
    "part_name": {"type": ["string", "null"]},
    "parameter": {"type": ["string", "null"]},
    "amount": {"type": ["string", "null"]},
    "value": {"type": ["string", "number", "boolean", "null"]},
    "visible": {"type": ["boolean", "null"]},
    "suppressed": {"type": ["boolean", "null"]},
    "new_name": {"type": ["string", "null"]},
    "placement": {"type": ["string", "null"], "enum": ["before", "after", None]},
    "source_feature": {"type": ["string", "null"]},
    "target_feature": {"type": ["string", "null"]},
    "before_feature": {"type": ["string", "null"]},
    "after_feature": {"type": ["string", "null"]},
    "position": {"type": ["string", "null"], "enum": ["last", "first", "start", "end", None]},
    "property": {"type": ["string", "null"]},
    "copies": {"type": ["integer", "null"]},
    "distance": {"type": ["string", "null"]},
    "target": {"type": ["string", "null"]},
}
SCHEMA = {
    "type": "object",
    "properties": {
        "route": {"type": "string", "enum": ["execute", "clarify", "design"]},
        "steps": {
            "type": "array", "maxItems": 3,
            "items": {
                "type": "object",
                "properties": STEP_PROPERTIES,
                "required": list(STEP_PROPERTIES),
                "additionalProperties": False,
            },
        },
        "question": {"type": ["string", "null"]},
    },
    "required": ["route", "steps", "question"],
    "additionalProperties": False,
}

CASES = [
 {"id":"cam_orbit_right_small","text":"یه کم به راست بچرخون","ctx":{},"gold":{"route":"execute","steps":[{"op":"view.move","action":"orbit","direction":"right"}]}},
 {"id":"cam_more","text":"بیشتر","ctx":{"last_action":"view.move","last_move":{"action":"orbit","direction":"right","intensity":0.2}},"gold":{"route":"execute","steps":[{"op":"view.move","action":"orbit","direction":"right"}]}},
 {"id":"cam_back","text":"زیادی شد، یه کم برگرد","ctx":{"last_action":"view.move","last_move":{"action":"orbit","direction":"right","intensity":0.6}},"gold":{"route":"execute","steps":[{"op":"view.move","action":"orbit","direction":"left"}]}},
 {"id":"zoom_in","text":"یکم زوم کن","ctx":{},"gold":{"route":"execute","steps":[{"op":"view.move","action":"zoom","direction":"in"}]}},
 {"id":"zoom_out","text":"خیلی زوم اوت کن","ctx":{},"gold":{"route":"execute","steps":[{"op":"view.move","action":"zoom","direction":"out"}]}},
 {"id":"fit_all","text":"فیتش کن","ctx":{"selection_count":0},"gold":{"route":"execute","steps":[{"op":"view.fit","action":"fit"}]}},
 {"id":"fit_selection","text":"روی همین انتخاب فیت کن","ctx":{"selection_count":2,"selection_types":["edge","edge"]},"gold":{"route":"execute","steps":[{"op":"view.fit","action":"fit_selection"}]}},
 {"id":"top","text":"از بالا نشون بده","ctx":{},"gold":{"route":"execute","steps":[{"op":"view.standard","view":"top"}]}},
 {"id":"clear_selection","text":"انتخاب رو پاک کن","ctx":{"selection_count":2},"gold":{"route":"execute","steps":[{"op":"viewer.selection.clear"}]}},
 {"id":"fillet_selected","text":"این دو تا لبه رو دو میلیمتر فیلت کن","ctx":{"selection_count":2,"selection_types":["edge","edge"]},"gold":{"route":"execute","steps":[{"op":"feature.from_selection","feature_type":"fillet","amount":"2 mm"}]}},
 {"id":"chamfer_selected","text":"همین دو تا رو نیم میلیمتر چمفر کن","ctx":{"selection_count":2,"selection_types":["edge","edge"]},"gold":{"route":"execute","steps":[{"op":"feature.from_selection","feature_type":"chamfer","amount":"0.5 mm"}]}},
 {"id":"fillet_radius_named","text":"فیلت ۳ رو بکن ۴ میلیمتر","ctx":{},"gold":{"route":"execute","steps":[{"op":"feature.parameter.set","feature_name":"Fillet 3","parameter":"radius","amount":"4 mm"}]}},
 {"id":"fillet_radius_relative","text":"شعاع همین فیلت رو یه میل بیشتر کن","ctx":{"last_feature":"Fillet 3","feature_parameters":{"radius":"3 mm"}},"gold":{"route":"execute","steps":[{"op":"feature.parameter.set","feature_name":"Fillet 3","parameter":"radius","amount":"4 mm"}]}},
 {"id":"suppress","text":"فیچر Extrude 2 رو خاموش کن","ctx":{},"gold":{"route":"execute","steps":[{"op":"feature.patch","feature_name":"Extrude 2","suppressed":True}]}},
 {"id":"unsuppress_context","text":"دوباره روشنش کن","ctx":{"last_feature":"Extrude 2","last_action":"suppress"},"gold":{"route":"execute","steps":[{"op":"feature.patch","feature_name":"Extrude 2","suppressed":False}]}},
 {"id":"delete_last","text":"آخرین فیچر رو پاک کن","ctx":{},"gold":{"route":"execute","steps":[{"op":"feature.delete","position":"last"}]}},
 {"id":"hide_part","text":"Part 2 رو مخفی کن","ctx":{},"gold":{"route":"execute","steps":[{"op":"part.visibility","part_name":"Part 2","visible":False}]}},
 {"id":"show_context","text":"دوباره نشونش بده","ctx":{"last_part":"Part 2","last_action":"hide"},"gold":{"route":"execute","steps":[{"op":"part.visibility","part_name":"Part 2","visible":True}]}},
 {"id":"color_part","text":"Part 1 رو قرمز کن","ctx":{},"gold":{"route":"execute","steps":[{"op":"metadata.property.set","part_name":"Part 1","property":"color","value":"red"}]}},
 {"id":"new_part_studio","text":"یه Part Studio جدید بساز به اسم تست","ctx":{},"gold":{"route":"execute","steps":[{"op":"documented.createPartStudio","new_name":"تست"}]}},
 {"id":"rename_doc","text":"اسم داکیومنت رو بذار بسته‌بندی","ctx":{},"gold":{"route":"execute","steps":[{"op":"documented.updateDocumentAttributes","new_name":"بسته‌بندی"}]}},
 {"id":"reorder","text":"Fillet 1 رو قبل از Extrude 3 ببر","ctx":{},"gold":{"route":"execute","steps":[{"op":"feature.reorder","source_feature":"Fillet 1","target_feature":"Extrude 3","placement":"before"}]}},
 {"id":"rollback","text":"rollback رو قبل از Fillet 4 ببر","ctx":{},"gold":{"route":"execute","steps":[{"op":"rollback.set","before_feature":"Fillet 4"}]}},
 {"id":"new_plane","text":"یه plane جدید بساز","ctx":{},"gold":{"route":"execute","steps":[{"op":"feature.add","feature_type":"plane"}]}},
 {"id":"linear_pattern","text":"یه الگوی خطی ۵ تایی با فاصله ۲۰ میلی روی Part 1 بساز","ctx":{},"gold":{"route":"execute","steps":[{"op":"feature.add","feature_type":"linearPattern","part_name":"Part 1","copies":5,"distance":"20 mm"}]}},
 {"id":"design_aesthetic","text":"این قطعه رو یه کم خوشگل‌تر کن","ctx":{},"gold":{"route":"design"}},
 {"id":"design_cap","text":"یه طراحی بهتر برای این درپوش بده که پریمیوم‌تر بشه","ctx":{},"gold":{"route":"design"}},
 {"id":"clarify_fillet","text":"فیلت بزن","ctx":{"selection_count":0},"gold":{"route":"clarify"}},
 {"id":"clarify_delete","text":"اون رو حذف کن","ctx":{},"gold":{"route":"clarify"}},
 {"id":"clarify_bulk","text":"همه رو پاک کن","ctx":{},"gold":{"route":"clarify"}},
 {"id":"clarify_radius","text":"اون دوتا رو فیلت کن","ctx":{"selection_count":2,"selection_types":["edge","edge"]},"gold":{"route":"clarify"}},
 {"id":"context_amount","text":"دو میلیمترش کن","ctx":{"last_feature":"Fillet 3","last_parameter":"radius"},"gold":{"route":"execute","steps":[{"op":"feature.parameter.set","feature_name":"Fillet 3","parameter":"radius","amount":"2 mm"}]}},
 {"id":"context_orbit","text":"کمی بچرخون","ctx":{"last_move":{"action":"orbit","direction":"left","intensity":0.3}},"gold":{"route":"execute","steps":[{"op":"view.move","action":"orbit","direction":"left"}]}},
 {"id":"context_direction","text":"سمت چپ","ctx":{"interaction_mode":"camera","last_move":{"action":"orbit","direction":"right","intensity":0.3}},"gold":{"route":"execute","steps":[{"op":"view.move","action":"orbit","direction":"left"}]}},
 {"id":"clarify_zoom","text":"زوم","ctx":{},"gold":{"route":"clarify"}},
 {"id":"fit_this","text":"همینو فیت کن","ctx":{"selection_count":1,"selection_types":["face"]},"gold":{"route":"execute","steps":[{"op":"view.fit","action":"fit_selection"}]}},
 {"id":"mixed_top","text":"top view","ctx":{},"gold":{"route":"execute","steps":[{"op":"view.standard","view":"top"}]}},
 {"id":"mixed_hide","text":"hide Part 3","ctx":{},"gold":{"route":"execute","steps":[{"op":"part.visibility","part_name":"Part 3","visible":False}]}},
 {"id":"mixed_fillet","text":"Fillet selected edges 1.5 mm","ctx":{"selection_count":2,"selection_types":["edge","edge"]},"gold":{"route":"execute","steps":[{"op":"feature.from_selection","feature_type":"fillet","amount":"1.5 mm"}]}},
 {"id":"rename_part","text":"اسم Part 2 رو عوض کن به cap","ctx":{},"gold":{"route":"execute","steps":[{"op":"documented.updateWVEPMetadata","part_name":"Part 2","property":"name","value":"cap"}]}}
]

# Conservative, intentionally small handwritten baseline.
def grammar(case):
    t = case["text"].strip().lower().replace("‌", " ")
    c = case.get("ctx", {})
    def ex(step): return {"route":"execute","steps":[step],"question":None}
    if re.search(r"طراحی|خوشگل|پریمیوم|بهتر", t): return {"route":"design","steps":[],"question":None}
    if re.search(r"انتخاب.*پاک|clear.*selection", t): return ex({"op":"viewer.selection.clear"})
    if "top" in t or "از بالا" in t: return ex({"op":"view.standard","view":"top"})
    if "فیت" in t or "fit" in t:
        return ex({"op":"view.fit","action":"fit_selection" if c.get("selection_count",0)>0 and ("همین" in t or "انتخاب" in t) else "fit"})
    if "زوم اوت" in t or "zoom out" in t: return ex({"op":"view.move","action":"zoom","direction":"out"})
    if ("زوم" in t or "zoom" in t) and ("کن" in t or "in" in t): return ex({"op":"view.move","action":"zoom","direction":"in"})
    if "راست" in t and ("بچرخ" in t or c.get("interaction_mode")=="camera"): return ex({"op":"view.move","action":"orbit","direction":"right"})
    if "چپ" in t and ("بچرخ" in t or c.get("interaction_mode")=="camera"): return ex({"op":"view.move","action":"orbit","direction":"left"})
    if t == "بیشتر" and c.get("last_move"):
        m=c["last_move"]; return ex({"op":"view.move","action":m["action"],"direction":m["direction"]})
    if "برگرد" in t and c.get("last_move"):
        opp={"left":"right","right":"left","up":"down","down":"up","in":"out","out":"in","clockwise":"counterclockwise","counterclockwise":"clockwise"}
        m=c["last_move"]; return ex({"op":"view.move","action":m["action"],"direction":opp.get(m["direction"],m["direction"])})
    if ("فیلت" in t or "fillet" in t) and c.get("selection_count",0)>0:
        m=re.search(r"(\d+(?:[\.,]\d+)?)\s*(?:میلی|mm)",t)
        if not m: return {"route":"clarify","steps":[],"question":"radius?"}
        return ex({"op":"feature.from_selection","feature_type":"fillet","amount":m.group(1).replace(",",".")+" mm"})
    if ("چمفر" in t or "chamfer" in t) and c.get("selection_count",0)>0:
        m=re.search(r"(\d+(?:[\.,]\d+)?)\s*(?:میلی|mm)",t)
        if "نیم میلی" in t: amount="0.5 mm"
        elif m: amount=m.group(1).replace(",",".")+" mm"
        else: return {"route":"clarify","steps":[],"question":"amount?"}
        return ex({"op":"feature.from_selection","feature_type":"chamfer","amount":amount})
    if re.search(r"آخرین فیچر.*پاک",t): return ex({"op":"feature.delete","position":"last"})
    m=re.search(r"(part\s*\d+)\s*رو\s*مخفی",t,re.I)
    if m: return ex({"op":"part.visibility","part_name":m.group(1).title(),"visible":False})
    m=re.search(r"hide\s+(part\s*\d+)",t,re.I)
    if m: return ex({"op":"part.visibility","part_name":m.group(1).title(),"visible":False})
    if "دوباره نشونش بده" in t and c.get("last_part"): return ex({"op":"part.visibility","part_name":c["last_part"],"visible":True})
    return {"route":"clarify","steps":[],"question":"unparsed"}

def subset_match(gold, got):
    if isinstance(gold, dict):
        return isinstance(got, dict) and all(k in got and subset_match(v, got[k]) for k,v in gold.items())
    if isinstance(gold, list):
        return isinstance(got, list) and len(got)>=len(gold) and all(subset_match(v, got[i]) for i,v in enumerate(gold))
    return gold == got

def call_groq(key, model, case):
    body = {
        "model": model,
        "messages": [
            {"role":"system","content":SYSTEM},
            {"role":"user","content":json.dumps({"command":case["text"],"context":case.get("ctx",{})},ensure_ascii=False,separators=(",",":"))}
        ],
        "reasoning_effort":"low",
        "temperature":0,
        "max_completion_tokens":700,
        "response_format":{"type":"json_schema","json_schema":{"name":"onshape_recipe","strict":True,"schema":SCHEMA}},
    }
    req = urllib.request.Request(
        ENDPOINT,
        data=json.dumps(body,ensure_ascii=False).encode("utf-8"),
        headers={"Authorization":"Bearer "+key,"Content-Type":"application/json","User-Agent":"cf-exec-plane-onshape-router-benchmark/1.0"},
        method="POST",
    )
    t0=time.perf_counter()
    try:
        with urllib.request.urlopen(req,timeout=60) as resp:
            raw=resp.read().decode("utf-8")
            ms=(time.perf_counter()-t0)*1000
            data=json.loads(raw)
            out=json.loads(data["choices"][0]["message"]["content"])
            usage=data.get("usage",{})
            headers={k.lower():v for k,v in resp.headers.items() if k.lower().startswith("x-ratelimit") or k.lower()=="retry-after"}
            return {"ok":True,"latency_ms":ms,"output":out,"usage":usage,"headers":headers}
    except urllib.error.HTTPError as e:
        ms=(time.perf_counter()-t0)*1000
        txt=e.read().decode("utf-8","replace")
        return {"ok":False,"latency_ms":ms,"error":f"HTTP {e.code}: {txt[:1200]}","retry_after":e.headers.get("retry-after")}
    except Exception as e:
        return {"ok":False,"latency_ms":(time.perf_counter()-t0)*1000,"error":repr(e)}

def summarize(rows):
    good=[r for r in rows if r.get("ok")]
    lats=[r["latency_ms"] for r in good]
    correct=[r for r in good if r["correct"]]
    p95=sorted(lats)[max(0,min(len(lats)-1,int(0.95*len(lats))-1))] if lats else None
    return {
        "requests":len(rows),"api_success":len(good),"correct":len(correct),
        "accuracy":len(correct)/len(rows) if rows else 0,
        "p50_ms":statistics.median(lats) if lats else None,
        "p95_ms":p95,
        "mean_ms":statistics.mean(lats) if lats else None,
        "input_tokens":sum((r.get("usage",{}).get("prompt_tokens") or 0) for r in good),
        "output_tokens":sum((r.get("usage",{}).get("completion_tokens") or 0) for r in good),
    }

def main():
    outdir=os.environ.get("OUT_DIR","artifacts/onshape-fast-router-groq")
    os.makedirs(outdir,exist_ok=True)
    baseline=[]
    for case in CASES:
        got=grammar(case)
        baseline.append({"id":case["id"],"got":got,"gold":case["gold"],"correct":subset_match(case["gold"],got)})
    bsum={"requests":len(baseline),"correct":sum(x["correct"] for x in baseline)}
    bsum["accuracy"]=bsum["correct"]/bsum["requests"]
    with open(os.path.join(outdir,"grammar.json"),"w",encoding="utf-8") as f:
        json.dump({"summary":bsum,"rows":baseline},f,ensure_ascii=False,indent=2)

    key=os.environ.get("GROQ_API_KEY","").strip()
    if not key:
        with open(os.path.join(outdir,"summary.json"),"w",encoding="utf-8") as f:
            json.dump({"status":"blocked","reason":"GROQ_API_KEY missing","grammar":bsum},f,ensure_ascii=False,indent=2)
        print(json.dumps({"status":"blocked","grammar":bsum}))
        return 2

    allsum={"grammar":bsum,"models":{}}
    for model in MODELS:
        warm=call_groq(key,model,{"text":"از بالا نشون بده","ctx":{},"id":"warmup"})
        time.sleep(2)
        rows=[]
        for idx,case in enumerate(CASES):
            r=call_groq(key,model,case)
            if not r.get("ok") and r.get("retry_after"):
                try: time.sleep(float(r["retry_after"])+0.5)
                except Exception: time.sleep(10)
                r=call_groq(key,model,case)
            r.update({"id":case["id"],"text":case["text"],"gold":case["gold"]})
            r["correct"]=bool(r.get("ok") and subset_match(case["gold"],r.get("output")))
            rows.append(r)
            print(json.dumps({"model":model,"id":case["id"],"ok":r.get("ok"),"correct":r["correct"],"latency_ms":round(r["latency_ms"],1)},ensure_ascii=False))
            if idx != len(CASES)-1: time.sleep(8.2)
        s=summarize(rows); s["warmup"]=warm
        allsum["models"][model]=s
        with open(os.path.join(outdir,model.split("/")[-1]+".json"),"w",encoding="utf-8") as f:
            json.dump({"summary":s,"rows":rows},f,ensure_ascii=False,indent=2)
        time.sleep(8)

    with open(os.path.join(outdir,"summary.json"),"w",encoding="utf-8") as f:
        json.dump(allsum,f,ensure_ascii=False,indent=2)
    print(json.dumps(allsum,ensure_ascii=False))
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
