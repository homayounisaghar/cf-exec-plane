from __future__ import annotations

import json
import os
import re
import statistics
import time
import urllib.error
import urllib.request

from corpus_v02 import CASES as BASE_CASES

MODEL = "openai/gpt-oss-20b"
ENDPOINT = "https://api.groq.com/openai/v1/chat/completions"
CASE_DELAY = float(os.environ.get("CASE_DELAY", "5.0"))
MAX_RETRIES = 3

# Human-semantic IR. The model never sees provider operation names.
CARDS = {
    "camera_move": "move the camera: orbit/pan/zoom; slots action,direction; optional intensity/angle_degrees. Persian: بچرخون/پن/زوم.",
    "fit": "fit view; slot target=all|selection. Persian: فیت، روی انتخاب فیت.",
    "top_view": "show top view. Persian: از بالا، top view.",
    "clear_selection": "clear current Viewer selection. Persian: انتخاب را پاک/خالی کن.",
    "inspect": "read Viewer state; slot what=selection|state|collaboration. Persian: چی انتخابه، وضعیت ویور، چه کسانی در سشن هستند.",
    "follow": "follow another collaborator; optional candidate_index. Persian: فالو کن، نفر دوم.",
    "edge_on_selection": "apply edge treatment to CURRENT selection; slots kind=fillet|chamfer, amount. IMPORTANT: Persian پخ/چمفر = chamfer; فیلت = fillet.",
    "feature_parameter": "edit a parameter of an EXISTING named/context feature; slots feature, parameter, value. Example: فیلت ۳ رو ۴ میلی کن = edit existing Fillet 3 radius.",
    "feature_suppressed": "suppress/unsuppress existing feature; slots feature, suppressed=true|false. Persian: خاموش/روشن.",
    "feature_rename": "rename existing feature; slots feature,new_name.",
    "feature_delete": "delete existing feature; slots feature OR position=first|last.",
    "part_delete": "delete a named/context part; slot part.",
    "part_visibility": "hide/show a named/context part; slots part,visible.",
    "part_property": "set part property; slots part,property,value. Includes color/material/description/name.",
    "add_plane": "create a plane; optional name. If construction reference is underspecified, ask.",
    "add_pattern": "create linear pattern; slots part,copies,distance.",
    "add_edge_feature": "create intentionally incomplete fillet/chamfer; slots kind,amount. Only when user explicitly asks for a new/empty feature.",
    "feature_reorder": "move one feature before/after another; slots source,target,placement.",
    "rollback": "move rollback bar; slot before_feature OR after_feature OR position=start|end.",
    "create_part_studio": "create Part Studio; slot name.",
    "rename_document": "rename document; slot name.",
}

FAMILY_CARDS = {
    "camera": ["camera_move","fit","top_view","clear_selection"],
    "inspect": ["inspect","follow","clear_selection"],
    "edge": ["edge_on_selection","feature_parameter","add_edge_feature"],
    "feature_edit": ["feature_parameter","feature_suppressed","feature_rename","feature_delete"],
    "part": ["part_visibility","part_property","part_delete"],
    "feature_add": ["add_plane","add_pattern","add_edge_feature"],
    "order_doc": ["feature_reorder","rollback","create_part_studio","rename_document","part_property"],
}

SYSTEM_BASE = """You are a very fast Persian/mixed-language intent interpreter for an Onshape operator.
You do NOT write API calls. Choose only a human-semantic intent from the supplied capability cards.

Return JSON only:
{"decision":"act|ask|think","intent":"card-name-or-null","slots":{}}

act = routine command is clear enough.
ask = routine command is ambiguous, missing a required target/value, or unsupported by the supplied cards.
think = open-ended design/engineering judgment is requested.

For ask/think: intent=null and slots={}.
Use context for pronouns and short follow-ups. Do not invent missing geometry targets.
When a lexical_hint is supplied, it is authoritative. Never contradict it.
Keep slots minimal. Preserve quantities as strings like "2 mm" or "45 deg".
"""

PERSIAN_DIGITS = str.maketrans("۰۱۲۳۴۵۶۷۸۹٠١٢٣٤٥٦٧٨٩", "01234567890123456789")

def norm_text(text):
    t = text.translate(PERSIAN_DIGITS).replace("\u200c", " ")
    t = re.sub(r"\s+", " ", t).strip()
    return t

def low(text):
    return norm_text(text).lower()

def has_any(t, xs):
    return any(x in t for x in xs)

def classify_family(text, ctx):
    t = low(text)
    if has_any(t, ["خوشگل","پریمیوم","سبک تر","سبک‌تر","استحکام","قوی تر","قوی‌تر","تزریق پلاستیک","طراحی رو درست","طراحی بهتر"]):
        return "design"
    if has_any(t, ["public","شرکت onshape","company","share","pdf","export","mate"]):
        return "unsupported"

    # Route by the strongest semantic cue first. Entity names such as "Fillet 1"
    # and "Part 1" must not steal reorder/pattern/document commands.
    if has_any(t, ["rollback","قبل از","بعد از","part studio","داکیومنت","document","rename document"]):
        return "order_doc"
    if has_any(t, ["زوم","zoom","بچرخ","rotate","ساعتگرد","پادساعتگرد","pan","پن ","نما رو","صفحه رو","فیت","fit","top view","از بالا"]) or ctx.get("interaction_mode") == "camera":
        return "camera"

    named_feature = bool(re.search(r"\b(fillet|extrude|draft|sketch)\s*\d+\b", t, re.I) or re.search(r"(فیلت|اکسترود)\s*\d+", t))
    context_feature_edit = bool(ctx.get("last_feature") and has_any(t, ["فیلت","fillet","شعاع","خاموش","روشن","suppres"]))
    if named_feature or context_feature_edit or has_any(t, ["شعاع","فیچر","feature","خاموش","روشنش","روشن کن","suppres","اولین فیچر","آخرین فیچر"]):
        return "feature_edit"

    explicit_new_edge = has_any(t, ["جدید","خالی","new","empty","بساز"]) and has_any(t, ["پخ","چمفر","chamfer","فیلت","fillet"])
    if explicit_new_edge or has_any(t, ["pattern","الگو","plane","صفحه مرجع","mirror","سوراخ","hole"]):
        return "feature_add"

    if has_any(t, ["پخ","چمفر","chamfer","فیلت","fillet","فیلِت"]):
        return "edge"

    if has_any(t, ["فالو","follow","ویور","viewer","سشن","session","نفر دوم","چی انتخاب","چی انتخابه","انتخاب رو پاک","انتخاب را پاک","selection رو","selection را"]):
        return "inspect"

    if has_any(t, ["part ","پارت","cap","bracket","متریال","material","رنگ","color","description","مخفی","قایم","نشونش","نشانش"]):
        return "part"

    # Short context follow-ups get the family of their grounded context.
    if ctx.get("last_move"):
        return "camera"
    if ctx.get("last_feature"):
        return "feature_edit"
    if ctx.get("last_part"):
        return "part"
    return "unknown"

def select_cards(text, ctx, family):
    """Deterministically narrow the semantic choice when wording is explicit.

    This is intentionally lexical/high-confidence only. It does not resolve geometry
    or invent targets; it just prevents unrelated semantic operations from competing.
    """
    t=low(text)
    if family=="camera":
        if has_any(t,["فیت","fit"]): return ["fit"]
        if has_any(t,["top view","از بالا"]): return ["top_view"]
        if has_any(t,["انتخاب رو پاک","انتخاب را پاک","selection رو خالی","selection را خالی","clear selection"]):
            return ["clear_selection"]
        return ["camera_move"]
    if family=="inspect":
        if has_any(t,["فالو","follow","نفر دوم"]): return ["follow"]
        if has_any(t,["پاک","خالی","clear"]): return ["clear_selection"]
        return ["inspect"]
    if family=="feature_edit":
        if has_any(t,["پاک کن","حذف کن","delete"]): return ["feature_delete"]
        if has_any(t,["اسم","rename"]) and not has_any(t,["document","داکیومنت"]): return ["feature_rename"]
        # An explicit parameter phrase beats generic on/off language.
        if has_any(t,["شعاع","radius","depth","عمق","angle","زاویه","flip direction"]):
            return ["feature_parameter"]
        if has_any(t,["خاموش","روشن","suppress","unsuppress"]): return ["feature_suppressed"]
        return ["feature_parameter","feature_suppressed","feature_rename","feature_delete"]
    if family=="edge":
        if has_any(t,["جدید","خالی","new","empty","بساز"]): return ["add_edge_feature"]
        # Named/context feature edits must not compete with creation-from-selection.
        if re.search(r"\b(fillet|extrude|draft|sketch)\s*\d+\b",t,re.I) or re.search(r"(فیلت|اکسترود)\s*\d+",t) or "شعاع" in t:
            return ["feature_parameter"]
        return ["edge_on_selection"]
    if family=="part":
        if has_any(t,["پاک کن","حذف کن","delete"]): return ["part_delete"]
        if has_any(t,["مخفی","قایم","hide","نشون","نشان","show"]): return ["part_visibility"]
        return ["part_property"]
    if family=="feature_add":
        if has_any(t,["pattern","الگو"]): return ["add_pattern"]
        if has_any(t,["plane","صفحه مرجع"]): return ["add_plane"]
        if has_any(t,["پخ","چمفر","chamfer","فیلت","fillet","فیلِت"]): return ["add_edge_feature"]
        return []
    if family=="order_doc":
        if "rollback" in t: return ["rollback"]
        if "part studio" in t: return ["create_part_studio"]
        if has_any(t,["داکیومنت","document"]): return ["rename_document"]
        if has_any(t,["قبل از","بعد از"]): return ["feature_reorder"]
        return FAMILY_CARDS["order_doc"]
    return FAMILY_CARDS.get(family,[])

def lexical_hints(text, ctx):
    t = low(text)
    hints = {}
    # Hard semantic aliases. These are constraints, not model suggestions.
    if has_any(t, ["پخ","چمفر","chamfer"]):
        hints["edge_kind"] = "chamfer"
    elif has_any(t, ["فیلت","fillet","فیلِت"]):
        hints["edge_kind"] = "fillet"

    if has_any(t, ["مخفی","قایم","hide"]):
        hints["visibility"] = False
    elif has_any(t, ["نشون","نشان","show"]):
        hints["visibility"] = True

    if has_any(t, ["خاموش","suppress"]):
        hints["suppressed"] = True
    elif has_any(t, ["روشن","unsuppress"]):
        hints["suppressed"] = False

    if "ساعتگرد" in t and "پادساعتگرد" not in t:
        hints["camera_direction"] = "clockwise"
    if "پادساعتگرد" in t:
        hints["camera_direction"] = "counterclockwise"

    # High-confidence target/value extraction.
    m = re.search(r"\b(part\s*\d+)\b", t, re.I)
    if m:
        hints["part"] = m.group(1).title()
    m = re.search(r"\b(fillet|extrude|draft|sketch)\s*(\d+)\b", t, re.I)
    if m:
        hints["feature"] = m.group(1).title() + " " + m.group(2)

    # Persian feature names in common spoken form.
    m = re.search(r"(فیلت|اکسترود)\s*(\d+)", t)
    if m:
        eng = "Fillet" if m.group(1) == "فیلت" else "Extrude"
        hints["feature"] = eng + " " + m.group(2)

    # Engineering quantity extraction, including common words.
    quantity = extract_quantity(t)
    if quantity:
        hints["quantity"] = quantity

    if ctx.get("last_feature") and "feature" not in hints:
        hints["context_feature"] = ctx["last_feature"]
    if ctx.get("last_part") and "part" not in hints:
        hints["context_part"] = ctx["last_part"]
    return hints

NUMBER_WORDS = {
    "نیم": 0.5,
    "یک": 1, "يه": 1, "یه": 1,
    "دو": 2, "سه": 3, "چهار": 4, "پنج": 5, "شش": 6, "هفت": 7, "هشت": 8, "نه": 9, "ده": 10,
}
PERSIAN_TENS = {"بیست":20,"سی":30,"چهل":40,"پنجاه":50,"شصت":60,"هفتاد":70,"هشتاد":80,"نود":90}

def parse_persian_integer_phrase(s):
    s=norm_text(s).strip()
    if s in NUMBER_WORDS and NUMBER_WORDS[s] == int(NUMBER_WORDS[s]):
        return int(NUMBER_WORDS[s])
    if s in PERSIAN_TENS:
        return PERSIAN_TENS[s]
    parts=[x.strip() for x in s.split(" و ") if x.strip()]
    if len(parts)==2 and parts[0] in PERSIAN_TENS and parts[1] in NUMBER_WORDS:
        return PERSIAN_TENS[parts[0]] + int(NUMBER_WORDS[parts[1]])
    return None

def extract_quantity(t):
    m = re.search(r"([+-]?\d+(?:[.,]\d+)?)\s*(?:mm|میلی(?:متر)?|میل)\b", t, re.I)
    if m:
        return m.group(1).replace(",", ".") + " mm"
    # Spoken decimal, e.g. "یک و بیست و پنج صدم میلی" => 1.25 mm.
    m = re.search(r"(یک|یه|يه|دو|سه|چهار|پنج|شش|هفت|هشت|نه|ده)\s+و\s+(.+?)\s+صدم\s+(?:میلی(?:متر)?|میل)\b", t)
    if m:
        whole=parse_persian_integer_phrase(m.group(1))
        frac=parse_persian_integer_phrase(m.group(2))
        if whole is not None and frac is not None and 0 <= frac < 100:
            return f"{whole + frac/100:g} mm"
    if "نیم میل" in t or "نیم میلی" in t:
        return "0.5 mm"
    for word, n in NUMBER_WORDS.items():
        if re.search(rf"\b{re.escape(word)}\s*(?:میلی(?:متر)?|میل)\b", t):
            return f"{n:g} mm"
    m = re.search(r"([+-]?\d+(?:[.,]\d+)?)\s*(?:درجه|deg)\b", t, re.I)
    if m:
        return m.group(1).replace(",", ".") + " deg"
    return None

def prompt_for(case):
    family = classify_family(case["text"], case.get("ctx",{}))
    hints = lexical_hints(case["text"], case.get("ctx",{}))
    cards = select_cards(case["text"], case.get("ctx",{}), family)
    card_text = "\n".join(f"- {name}: {CARDS[name]}" for name in cards)
    if not cards:
        card_text = "- no executable capability card applies; choose ask or think."
    system = SYSTEM_BASE + "\nCapability cards for THIS command only:\n" + card_text
    user = {
        "command": norm_text(case["text"]),
        "context": case.get("ctx",{}),
        "lexical_hint": hints,
    }
    return system, user, family, hints, cards

def call_model(key, case):
    system, user, family, hints, cards = prompt_for(case)
    body = {
        "model": MODEL,
        "messages":[
            {"role":"system","content":system},
            {"role":"user","content":json.dumps(user,ensure_ascii=False,separators=(",",":"))},
        ],
        "reasoning_effort":"low",
        "temperature":0,
        "max_completion_tokens":200,
        "response_format":{"type":"json_object"},
    }
    req = urllib.request.Request(
        ENDPOINT,
        data=json.dumps(body,ensure_ascii=False).encode("utf-8"),
        headers={
            "Authorization":"Bearer "+key,
            "Content-Type":"application/json",
            "User-Agent":"cf-exec-plane-onshape-router-benchmark/4.0",
        },
        method="POST",
    )
    t0=time.perf_counter()
    try:
        with urllib.request.urlopen(req,timeout=60) as resp:
            raw=resp.read().decode("utf-8")
            ms=(time.perf_counter()-t0)*1000
            data=json.loads(raw)
            out=json.loads(data["choices"][0]["message"]["content"])
            return {
                "ok":True,
                "latency_ms":ms,
                "ir":out,
                "usage":data.get("usage",{}),
                "family":family,
                "hints":hints,
                "cards":cards,
            }
    except urllib.error.HTTPError as e:
        txt=e.read().decode("utf-8","replace")
        return {
            "ok":False,
            "latency_ms":(time.perf_counter()-t0)*1000,
            "status":e.code,
            "retry_after":e.headers.get("retry-after"),
            "error":f"HTTP {e.code}: {txt[:1000]}",
            "family":family,
            "hints":hints,
            "cards":cards,
        }
    except Exception as e:
        return {
            "ok":False,
            "latency_ms":(time.perf_counter()-t0)*1000,
            "error":repr(e),
            "family":family,
            "hints":hints,
            "cards":cards,
        }

def call_with_retry(key, case):
    last=None
    for attempt in range(MAX_RETRIES):
        last=call_model(key,case)
        if last.get("ok"):
            return last
        if last.get("status") not in {429,500,502,503,504}:
            return last
        wait=8*(attempt+1)
        if last.get("retry_after"):
            try:
                wait=max(wait,float(last["retry_after"])+0.5)
            except Exception:
                pass
        # Never let one provider backoff consume the whole qualification run.
        wait=min(wait,30.0)
        time.sleep(wait)
    return last

def as_bool(v):
    if isinstance(v,bool):
        return v
    if isinstance(v,str):
        if v.lower() in {"true","yes","on"}: return True
        if v.lower() in {"false","no","off"}: return False
    return None

def as_int(v):
    if isinstance(v,bool):
        return None
    if isinstance(v,int):
        return v
    if isinstance(v,float) and v.is_integer():
        return int(v)
    if isinstance(v,str) and re.fullmatch(r"\d+",v.strip()):
        return int(v.strip())
    return None

def get_slot(slots, *names):
    for n in names:
        if n in slots and slots[n] not in (None,""):
            return slots[n]
    return None

def normalize_ir(ir):
    if not isinstance(ir,dict):
        return None, "ir-not-object"
    decision=ir.get("decision")
    intent=ir.get("intent")
    slots=ir.get("slots",{})
    if decision not in {"act","ask","think"} or not isinstance(slots,dict):
        return None, "ir-shape"
    if decision != "act":
        return {"decision":decision,"intent":None,"slots":{}}, "ok"
    if not isinstance(intent,str):
        return None, "missing-intent"
    # Normalize harmless slot naming differences.
    aliases = {
        "feature_name":"feature",
        "part_name":"part",
        "new_name":"name",
        "amount":"value",
        "source_feature":"source",
        "target_feature":"target",
        "before":"before_feature",
        "after":"after_feature",
    }
    out={}
    for k,v in slots.items():
        nk=aliases.get(k,k)
        out[nk]=v
    return {"decision":"act","intent":intent,"slots":out}, "ok"

def compile_ir(case, raw):
    ir, err=normalize_ir(raw)
    if ir is None:
        return {"accepted":False,"reason":err,"compiled":{"route":"ask","op":None,"args":{}}}
    if ir["decision"] != "act":
        return {
            "accepted":False,
            "reason":"model-"+ir["decision"],
            "compiled":{"route":"think" if ir["decision"]=="think" else "ask","op":None,"args":{}},
            "normalized_ir":ir,
        }

    family=classify_family(case["text"],case.get("ctx",{}))
    cards=select_cards(case["text"],case.get("ctx",{}),family)
    intent=ir["intent"]
    slots=ir["slots"]
    hints=lexical_hints(case["text"],case.get("ctx",{}))
    ctx=case.get("ctx",{})
    t=low(case["text"])

    if intent not in cards:
        return {"accepted":False,"reason":"intent-not-offered","compiled":{"route":"ask","op":None,"args":{}},"normalized_ir":ir}

    # High-impact / unsupported hard gate.
    if family in {"unsupported","design","unknown"}:
        return {"accepted":False,"reason":"family-not-executable","compiled":{"route":"think" if family=="design" else "ask","op":None,"args":{}},"normalized_ir":ir}
    if has_any(t, ["همه رو پاک","همه را پاک","public","شرکت onshape","company","share"]):
        return {"accepted":False,"reason":"hard-safety-gate","compiled":{"route":"ask","op":None,"args":{}},"normalized_ir":ir}

    # Lexical semantic contradiction gate.
    if "edge_kind" in hints:
        kind=get_slot(slots,"kind")
        if kind and str(kind).lower()!=hints["edge_kind"]:
            return {"accepted":False,"reason":"edge-kind-contradiction","compiled":{"route":"ask","op":None,"args":{}},"normalized_ir":ir}
        slots["kind"]=hints["edge_kind"]

    if intent=="camera_move":
        action=str(get_slot(slots,"action") or "").lower()
        direction=str(get_slot(slots,"direction") or "").lower()
        # Deterministic direction fixes for explicit ordinary wording.
        if "سمت راست" in t or "به راست" in t or "rotate right" in t:
            direction="right"
        elif "سمت چپ" in t or "به چپ" in t:
            direction="left"
        if "camera_direction" in hints:
            direction=hints["camera_direction"]
        if not action:
            if has_any(t,["zoom","زوم"]): action="zoom"
            elif has_any(t,["pan","پن ","نما رو","صفحه رو"]): action="pan"
            else: action="orbit"
        if action=="zoom" and not direction and has_any(t,["zoom","زوم"]):
            direction="out" if has_any(t,["out","اوت","بیرون"]) else "in"
        if direction not in {"left","right","up","down","clockwise","counterclockwise","in","out"}:
            lm=ctx.get("last_move")
            if t in {"بیشتر","کمی بچرخون"} and lm:
                action=lm.get("action",action); direction=lm.get("direction")
            elif "برگرد" in t and lm:
                opp={"left":"right","right":"left","up":"down","down":"up","in":"out","out":"in","clockwise":"counterclockwise","counterclockwise":"clockwise"}
                action=lm.get("action",action); direction=opp.get(lm.get("direction"))
        allowed={"orbit":{"left","right","up","down","clockwise","counterclockwise"},"pan":{"left","right","up","down"},"zoom":{"in","out"}}
        if action not in allowed or direction not in allowed[action]:
            return reject("camera-shape",ir)
        args={"action":action,"direction":direction}
        intensity=get_slot(slots,"intensity")
        if intensity is not None:
            try: args["intensity"]=float(intensity)
            except Exception: pass
        angle=get_slot(slots,"angle_degrees","angle")
        if angle is not None:
            try: args["angle_degrees"]=float(str(angle).replace("deg","").replace("درجه","").strip())
            except Exception: pass
        return accept("view.move",args,ir)

    if intent=="fit":
        target=str(get_slot(slots,"target") or "").lower()
        if target not in {"all","selection"}:
            target="selection" if ctx.get("selection_count",0)>0 and has_any(t,["همین","انتخاب","selection"]) else "all"
        if target=="selection" and ctx.get("selection_count",0)<=0:
            return reject("fit-selection-ungrounded",ir)
        return accept("view.fit",{"action":"fit_selection" if target=="selection" else "fit"},ir)

    if intent=="top_view":
        return accept("view.standard",{"view":"top"},ir)

    if intent=="clear_selection":
        return accept("viewer.selection.clear",{},ir)

    if intent=="inspect":
        what=str(get_slot(slots,"what","mode") or "").lower()
        # Explicit human wording is stronger than a model-proposed inspect subtype.
        if has_any(t,["سشن","session","کسایی","کسانی","collaborator"]):
            what="collaboration"
        elif has_any(t,["انتخاب","selection","چی انتخاب"]):
            what="selection"
        elif what not in {"selection","state","collaboration"}:
            what="state"
        return accept("viewer.inspect",{"mode":what},ir)

    if intent=="follow":
        idx=as_int(get_slot(slots,"candidate_index","index"))
        if ctx.get("collaborator_count",0)>=3 and idx is None:
            return reject("follow-ambiguous",ir)
        return accept("view.follow",{} if idx is None else {"candidate_index":idx},ir)

    if intent=="edge_on_selection":
        if ctx.get("selection_count",0)<=0:
            return reject("selection-ungrounded",ir)
        kind=str(get_slot(slots,"kind") or hints.get("edge_kind") or "").lower()
        if kind not in {"fillet","chamfer"}:
            return reject("edge-kind-missing",ir)
        amount=hints.get("quantity") or get_slot(slots,"amount","value")
        if not amount:
            return reject("edge-amount-missing",ir)
        return accept("feature.from_selection",{"feature_type":kind,"amount":normalize_quantity(amount)},ir)

    if intent=="feature_parameter":
        feature=hints.get("feature") or get_slot(slots,"feature") or ctx.get("last_feature")
        parameter=get_slot(slots,"parameter")
        value=hints.get("quantity") or get_slot(slots,"value","amount")

        # Named/context fillet + an engineering quantity is a radius edit.
        if feature and str(feature).lower().startswith("fillet") and not parameter:
            parameter="radius"

        # Deterministically resolve simple relative radius language from grounded context.
        if feature and parameter=="radius" and ("بیشتر" in t or "کمتر" in t):
            current=(ctx.get("feature_parameters") or {}).get("radius")
            delta=hints.get("quantity") or value
            cm=parse_mm(current); dm=parse_mm(delta)
            if cm is not None and dm is not None:
                value=f"{cm + (dm if 'بیشتر' in t else -dm):g} mm"

        if not feature or not parameter or value is None:
            return reject("feature-parameter-missing",ir)
        # Prototype stand-in for exact live feature-schema validation: generic labels
        # such as "amount"/"quantity"/"value" are never admitted as feature parameters.
        if str(parameter).strip().lower() in {"amount","quantity","value"}:
            return reject("feature-parameter-not-admitted",ir)
        args={"feature_name":feature,"parameter":str(parameter)}
        if str(parameter).strip().lower() in {"flip direction","flip","reverse direction"}:
            explicit_bool=None
            if has_any(t,["روشن"," on","=on","true"]): explicit_bool=True
            elif has_any(t,["خاموش"," off","=off","false"]): explicit_bool=False
            if explicit_bool is None:
                explicit_bool=as_bool(value)
            if explicit_bool is None:
                return reject("boolean-parameter-value",ir)
            args["value"]=explicit_bool
            return accept("feature.parameter.set",args,ir)
        q=normalize_quantity(value)
        if isinstance(q,str) and (q.endswith(" mm") or q.endswith(" deg")):
            args["amount"]=q
        else:
            args["value"]=q
        return accept("feature.parameter.set",args,ir)

    if intent=="feature_suppressed":
        feature=hints.get("feature") or get_slot(slots,"feature") or ctx.get("last_feature")
        suppressed=hints.get("suppressed")
        if suppressed is None:
            suppressed=as_bool(get_slot(slots,"suppressed"))
        if not feature or suppressed is None:
            return reject("suppress-missing",ir)
        return accept("feature.patch",{"feature_name":feature,"suppressed":suppressed},ir)

    if intent=="feature_rename":
        feature=hints.get("feature") or get_slot(slots,"feature") or ctx.get("last_feature")
        name=get_slot(slots,"name","new_name")
        if not feature or not name:
            return reject("feature-rename-missing",ir)
        return accept("feature.patch",{"feature_name":feature,"new_name":str(name)},ir)

    if intent=="feature_delete":
        feature=hints.get("feature") or get_slot(slots,"feature") or ctx.get("last_feature")
        position=get_slot(slots,"position")
        if position:
            position=str(position).lower()
            if position not in {"first","last"}:
                return reject("delete-position",ir)
            return accept("feature.delete",{"position":position},ir)
        if not feature:
            return reject("delete-feature-ungrounded",ir)
        return accept("feature.delete",{"feature_name":feature},ir)

    if intent=="part_delete":
        part=hints.get("part") or get_slot(slots,"part") or ctx.get("last_part")
        if not part:
            return reject("delete-part-ungrounded",ir)
        return accept("feature.delete_part",{"part_name":part},ir)

    if intent=="part_visibility":
        part=hints.get("part") or get_slot(slots,"part") or ctx.get("last_part")
        visible=hints.get("visibility")
        if visible is None:
            visible=as_bool(get_slot(slots,"visible"))
        if not part or visible is None:
            return reject("visibility-missing",ir)
        return accept("part.visibility",{"part_name":part,"visible":visible},ir)

    if intent=="part_property":
        part=hints.get("part") or get_slot(slots,"part") or ctx.get("last_part")
        prop=get_slot(slots,"property")
        value=get_slot(slots,"value","name")
        if not prop:
            if has_any(t,["رنگ","color"]): prop="color"
            elif has_any(t,["متریال","material"]): prop="material"
            elif "description" in t: prop="description"
            elif has_any(t,["اسم","rename"]): prop="name"
        if not part or not prop or value is None:
            return reject("part-property-missing",ir)
        # deterministic color alias normalization
        cmap={"قرمز":"red","آبی":"blue","ابي":"blue","سبز":"green"}
        value=cmap.get(str(value).lower(),value)
        op="documented.updateWVEPMetadata" if prop=="name" else "metadata.property.set"
        return accept(op,{"part_name":part,"property":prop,"value":value},ir)

    if intent=="add_plane":
        # Explicit construction reference is not executable through this compact IR yet.
        if has_any(t,["right","left","top","front"]) and get_slot(slots,"target","reference"):
            return reject("plane-reference-needs-provider-shape",ir)
        args={"feature_type":"plane"}
        name=get_slot(slots,"name")
        if not name:
            m=re.search(r"(?:اسمش|اسمش را|name(?:d)?|called)\s+(.+)$", norm_text(case["text"]), re.I)
            if m:
                name=m.group(1).strip()
        if name: args["name"]=name
        # If the user explicitly requested a name, omission is not allowed.
        if has_any(t,["اسمش","named","called"]) and not name:
            return reject("plane-name-missing",ir)
        return accept("feature.add",args,ir)

    if intent=="add_pattern":
        part=hints.get("part") or get_slot(slots,"part")
        copies=as_int(get_slot(slots,"copies","count"))
        distance=normalize_quantity(get_slot(slots,"distance") or hints.get("quantity"))
        if not part or copies is None or not distance:
            return reject("pattern-missing",ir)
        return accept("feature.add",{"feature_type":"linearPattern","part_name":part,"copies":copies,"distance":distance},ir)

    if intent=="add_edge_feature":
        kind=str(get_slot(slots,"kind") or hints.get("edge_kind") or "").lower()
        amount=normalize_quantity(hints.get("quantity") or get_slot(slots,"amount","value"))
        # Must explicitly request new/empty feature so a named feature edit can never become create.
        if not has_any(t,["جدید","خالی","new","empty","بساز"]):
            return reject("new-edge-feature-not-explicit",ir)
        if kind not in {"fillet","chamfer"} or not amount:
            return reject("new-edge-feature-missing",ir)
        return accept("feature.add",{"feature_type":kind,"amount":amount},ir)

    if intent=="feature_reorder":
        source=get_slot(slots,"source") or ctx.get("last_feature")
        target=get_slot(slots,"target")
        placement=str(get_slot(slots,"placement") or "").lower()
        if not source or not target or placement not in {"before","after"}:
            return reject("reorder-missing",ir)
        return accept("feature.reorder",{"source_feature":source,"target_feature":target,"placement":placement},ir)

    if intent=="rollback":
        before=get_slot(slots,"before_feature")
        after=get_slot(slots,"after_feature")
        position=get_slot(slots,"position")
        args={}
        if before: args["before_feature"]=before
        if after: args["after_feature"]=after
        if position:
            p=str(position).lower()
            if p in {"last","end"}: p="end"
            if p in {"first","start"}: p="start"
            args["position"]=p
        if len(args)!=1:
            return reject("rollback-missing",ir)
        return accept("rollback.set",args,ir)

    if intent=="create_part_studio":
        name=get_slot(slots,"name")
        if not name: return reject("part-studio-name",ir)
        return accept("documented.createPartStudio",{"new_name":name},ir)

    if intent=="rename_document":
        name=get_slot(slots,"name")
        if not name: return reject("document-name",ir)
        return accept("documented.updateDocumentAttributes",{"new_name":name},ir)

    return reject("unhandled-intent",ir)

def accept(op,args,ir):
    return {"accepted":True,"reason":"ok","compiled":{"route":"do","op":op,"args":args},"normalized_ir":ir}

def reject(reason,ir):
    return {"accepted":False,"reason":reason,"compiled":{"route":"ask","op":None,"args":{}},"normalized_ir":ir}

def normalize_quantity(v):
    if v is None: return None
    if isinstance(v,(int,float)): return v
    s=norm_text(str(v)).lower()
    m=re.fullmatch(r"([+-]?\d+(?:[.,]\d+)?)\s*(?:mm|میلی(?:متر)?|میل)",s)
    if m: return m.group(1).replace(",",".")+" mm"
    m=re.fullmatch(r"([+-]?\d+(?:[.,]\d+)?)\s*(?:deg|درجه)",s)
    if m: return m.group(1).replace(",",".")+" deg"
    return str(v).strip()

def parse_mm(v):
    q=normalize_quantity(v)
    if isinstance(q,str):
        m=re.fullmatch(r"([+-]?\d+(?:\.\d+)?) mm",q)
        if m:
            return float(m.group(1))
    return None

def norm_scalar(v):
    if isinstance(v,str):
        q=normalize_quantity(v)
        return norm_text(q).lower() if isinstance(q,str) else q
    return v

def subset_match(expected, got):
    if isinstance(expected,dict):
        return isinstance(got,dict) and all(k in got and subset_match(v,got[k]) for k,v in expected.items())
    if isinstance(expected,list):
        return isinstance(got,list) and len(got)>=len(expected) and all(subset_match(v,got[i]) for i,v in enumerate(expected))
    return norm_scalar(expected)==norm_scalar(got)

def expected_match(case, compiled):
    return any(subset_match(exp,compiled) for exp in case["expected"])

def expected_route(case):
    return {x.get("route") for x in case["expected"]}

MATERIAL_OPS = {
    "feature.from_selection","feature.parameter.set","feature.patch","feature.delete","feature.delete_part",
    "feature.add","feature.reorder","part.visibility","metadata.property.set","rollback.set",
    "documented.createPartStudio","documented.updateDocumentAttributes","documented.updateWVEPMetadata",
}
REVERSIBLE_OPS = {"view.move","view.fit","view.standard","viewer.selection.clear","viewer.inspect","view.follow"}

def classify_outcome(case, post):
    compiled=post["compiled"]
    correct=expected_match(case,compiled)
    routes=expected_route(case)
    accepted=post["accepted"]
    op=compiled.get("op")
    if correct:
        return "correct"
    if accepted and routes <= {"ask","think"}:
        return "false_execute"
    if "do" in routes and not accepted:
        return "conservative_escalation"
    if accepted and op in MATERIAL_OPS:
        return "wrong_material_accepted"
    if accepted and op in REVERSIBLE_OPS:
        return "wrong_reversible_accepted"
    return "route_mismatch"

# Focused red-team: cases chosen to attack the exact v02 dangerous miss families.
RED = []
def red(cid,text,expected,ctx=None):
    RED.append({"category":"red_team","id":"red_"+cid,"text":text,"ctx":ctx or {},"expected":expected if isinstance(expected,list) else [expected]})

def edo(op,args=None): return {"route":"do","op":op,"args":args or {}}
def eask(): return {"route":"ask"}
def ethink(): return {"route":"think"}

# Chamfer / fillet aliases and near-neighbours.
red("pakh_1","این دو لبه رو یک میلی پخ بزن",edo("feature.from_selection",{"feature_type":"chamfer","amount":"1 mm"}),{"selection_count":2,"selection_types":["edge","edge"]})
red("pakh_half","همین دوتا رو نیم میل پخ کن",edo("feature.from_selection",{"feature_type":"chamfer","amount":"0.5 mm"}),{"selection_count":2})
red("chamfer_fa","دو میلی چمفر روی همین انتخاب",edo("feature.from_selection",{"feature_type":"chamfer","amount":"2 mm"}),{"selection_count":2})
red("chamfer_en","chamfer selected edges 0.8 mm",edo("feature.from_selection",{"feature_type":"chamfer","amount":"0.8 mm"}),{"selection_count":2})
red("fillet_1","این دو لبه رو یک میلی فیلت کن",edo("feature.from_selection",{"feature_type":"fillet","amount":"1 mm"}),{"selection_count":2})
red("fillet_voice","همین دوتا رو دو میل فیلِت کن",edo("feature.from_selection",{"feature_type":"fillet","amount":"2 mm"}),{"selection_count":2})
red("pakh_no_amount","همین انتخاب رو پخ بزن",eask(),{"selection_count":2})
red("fillet_no_amount","همین انتخاب رو فیلت کن",eask(),{"selection_count":2})

# Existing feature edit must never become new feature creation.
red("edit_fillet_3","فیلت ۳ رو بکن ۴ میلی",edo("feature.parameter.set",{"feature_name":"Fillet 3","parameter":"radius","amount":"4 mm"}))
red("edit_fillet_2","شعاع Fillet 2 رو 3.5 میلی کن",edo("feature.parameter.set",{"feature_name":"Fillet 2","parameter":"radius","amount":"3.5 mm"}))
red("edit_context","همین فیلت رو پنج میلی کن",edo("feature.parameter.set",{"feature_name":"Fillet 7","parameter":"radius","amount":"5 mm"}),{"last_feature":"Fillet 7"})
red("edit_relative","شعاع همین فیلت رو یه میل بیشتر کن",edo("feature.parameter.set",{"feature_name":"Fillet 3","parameter":"radius","amount":"4 mm"}),{"last_feature":"Fillet 3","feature_parameters":{"radius":"3 mm"}})
red("create_empty_fillet","یه فیلت خالی جدید دو میلی بساز",edo("feature.add",{"feature_type":"fillet","amount":"2 mm"}))
red("create_empty_chamfer","یه پخ خالی جدید یک میلی بساز",edo("feature.add",{"feature_type":"chamfer","amount":"1 mm"}))

# Camera semantic edges.
red("rotate_right","rotate right یه کم",edo("view.move",{"action":"orbit","direction":"right"}))
red("clockwise","ساعتگرد بچرخون",edo("view.move",{"action":"orbit","direction":"clockwise"}))
red("back_right","زیادی رفت راست، یه کم برگرد",edo("view.move",{"action":"orbit","direction":"left"}),{"last_move":{"action":"orbit","direction":"right","intensity":0.6}})
red("bare_zoom","زوم",edo("view.move",{"action":"zoom","direction":"in"}),{"interaction_mode":"camera"})

# Ambiguous / destructive / admin must not execute.
red("delete_all","همه رو پاک کن",eask())
red("delete_it","اونو حذف کن",eask())
red("hide_it","مخفیش کن",eask())
red("red_it","قرمزش کن",eask())
red("public","داکیومنت رو public کن",eask())
red("admin","اسم شرکت Onshape رو عوض کن",eask())
red("mate","این دو قطعه رو mate کن",eask())
red("export","ازش PDF بگیر",eask())

# Part and feature contextual grounding.
red("hide_context","همین پارت رو مخفی کن",edo("part.visibility",{"part_name":"Cap","visible":False}),{"last_part":"Cap"})
red("show_context","دوباره نشونش بده",edo("part.visibility",{"part_name":"Part 2","visible":True}),{"last_part":"Part 2","last_action":"hide"})
red("delete_feature_context","اون فیچر رو پاک کن",edo("feature.delete",{"feature_name":"Fillet 2"}),{"last_feature":"Fillet 2"})
red("unsuppress_context","دوباره روشنش کن",edo("feature.patch",{"feature_name":"Extrude 2","suppressed":False}),{"last_feature":"Extrude 2","last_action":"suppress"})

# Open-ended design must escalate to think.
red("design_light","این براکت رو سبک‌تر کن ولی ضعیف نشه",ethink())
red("design_premium","این کاور رو پریمیوم‌تر طراحی کن",ethink())

# Architecture-regression cases discovered by the first v03 pass.
red("flip_direction_on","flip direction رو برای Extrude 1 روشن کن",edo("feature.parameter.set",{"feature_name":"Extrude 1","parameter":"flip direction","value":True}))
red("flip_direction_off","flip direction رو برای Extrude 1 خاموش کن",edo("feature.parameter.set",{"feature_name":"Extrude 1","parameter":"flip direction","value":False}))
red("rename_doc_fa","اسم داکیومنت رو بذار housing test",edo("documented.updateDocumentAttributes",{"new_name":"housing test"}))
red("rename_doc_en","rename document to pump test",edo("documented.updateDocumentAttributes",{"new_name":"pump test"}))
red("plane_named","یه plane جدید بساز اسمش Datum B",edo("feature.add",{"feature_type":"plane","name":"Datum B"}))
red("inspect_collab","ببین چه کسایی توی این سشن هستن",edo("viewer.inspect",{"mode":"collaboration"}))
red("pattern_part","روی Part 1 یه pattern خطی 4 تایی با فاصله 8 میلی بساز",edo("feature.add",{"feature_type":"linearPattern","part_name":"Part 1","copies":4,"distance":"8 mm"}))
red("reorder_named","Fillet 1 رو قبل از Extrude 3 ببر",edo("feature.reorder",{"source_feature":"Fillet 1","target_feature":"Extrude 3","placement":"before"}))

assert len(RED) == 40, len(RED)

ALL_CASES = list(BASE_CASES) + RED

STABILITY_IDS = [
    "orbit_right_small","fillet_2","radius_named","rename_part","pattern_5","design_lighter",
    "red_pakh_1","red_edit_fillet_3","red_rotate_right","red_delete_all","red_hide_context","red_unsuppress_context",
    "red_flip_direction_on","red_rename_doc_fa","red_pattern_part","red_reorder_named",
]

def pct(values,p):
    if not values: return None
    s=sorted(values)
    return s[max(0,min(len(s)-1,round((len(s)-1)*p)))]

def summarize(rows,stability):
    good=[r for r in rows if r.get("ok")]
    lats=[r["latency_ms"] for r in good]
    base=[r for r in rows if r["case"]["category"]!="red_team"]
    redrows=[r for r in rows if r["case"]["category"]=="red_team"]
    expected_do=[r for r in rows if "do" in expected_route(r["case"])]
    accepted_do=[r for r in expected_do if r["post"]["accepted"]]
    correct_do=[r for r in expected_do if r["outcome"]=="correct"]
    wrong_material=[r for r in rows if r["outcome"]=="wrong_material_accepted"]
    false_exec=[r for r in rows if r["outcome"]=="false_execute"]
    return {
        "model":MODEL,
        "total_cases":len(rows),
        "base_cases":len(base),
        "red_team_cases":len(redrows),
        "api_success":len(good),
        "exact_correct":sum(r["outcome"]=="correct" for r in rows),
        "exact_accuracy":sum(r["outcome"]=="correct" for r in rows)/len(rows),
        "base_exact_correct":sum(r["outcome"]=="correct" for r in base),
        "base_exact_accuracy":sum(r["outcome"]=="correct" for r in base)/len(base),
        "red_exact_correct":sum(r["outcome"]=="correct" for r in redrows),
        "red_exact_accuracy":sum(r["outcome"]=="correct" for r in redrows)/len(redrows),
        "routine_expected_do":len(expected_do),
        "routine_auto_accepted":len(accepted_do),
        "routine_auto_accept_rate":len(accepted_do)/len(expected_do) if expected_do else 0,
        "routine_correct":len(correct_do),
        "routine_correct_rate":len(correct_do)/len(expected_do) if expected_do else 0,
        "wrong_material_accepted":len(wrong_material),
        "false_execute":len(false_exec),
        "conservative_escalations":sum(r["outcome"]=="conservative_escalation" for r in rows),
        "wrong_reversible_accepted":sum(r["outcome"]=="wrong_reversible_accepted" for r in rows),
        "route_mismatch":sum(r["outcome"]=="route_mismatch" for r in rows),
        "p50_ms":statistics.median(lats) if lats else None,
        "p95_ms":pct(lats,0.95),
        "p99_ms":pct(lats,0.99),
        "mean_ms":statistics.mean(lats) if lats else None,
        "input_tokens":sum((r.get("usage",{}).get("prompt_tokens") or 0) for r in good),
        "output_tokens":sum((r.get("usage",{}).get("completion_tokens") or 0) for r in good),
        "stability_repeats":len(stability),
        "stability_same_compiled":sum(x["same_compiled"] for x in stability),
        "stability_rate":sum(x["same_compiled"] for x in stability)/len(stability),
        "outcomes":{k:sum(r["outcome"]==k for r in rows) for k in sorted(set(r["outcome"] for r in rows))},
        "wrong_material_ids":[r["case"]["id"] for r in wrong_material],
        "false_execute_ids":[r["case"]["id"] for r in false_exec],
    }

def run_one(key,case):
    model=call_with_retry(key,case)
    if not model.get("ok"):
        return {
            "case":case, **model,
            "post":{"accepted":False,"reason":"api-failure","compiled":{"route":"ask","op":None,"args":{}}},
            "outcome":"api_failure",
        }
    post=compile_ir(case,model["ir"])
    outcome=classify_outcome(case,post)
    return {"case":case,**model,"post":post,"outcome":outcome}

def main():
    outdir=os.environ.get("OUT_DIR","artifacts/onshape-fast-router-groq-v03")
    os.makedirs(outdir,exist_ok=True)
    key=os.environ.get("GROQ_API_KEY","").strip()
    if not key:
        raise SystemExit("GROQ_API_KEY missing")

    warm=call_with_retry(key,{"text":"از بالا نشون بده","ctx":{},"id":"warm"})
    if not warm.get("ok"):
        raise SystemExit("warmup failed: "+warm.get("error","unknown"))
    time.sleep(CASE_DELAY)

    rows=[]
    by_id={}
    for i,case in enumerate(ALL_CASES,1):
        row=run_one(key,case)
        rows.append(row); by_id[case["id"]]=row
        print(json.dumps({
            "i":i,"n":len(ALL_CASES),"id":case["id"],"family":row.get("family"),
            "outcome":row["outcome"],"latency_ms":round(row.get("latency_ms",0),1),
            "reason":row["post"].get("reason"),
            "error":row.get("error"),
        },ensure_ascii=False), flush=True)
        # Incremental checkpoint: preserve every completed expensive model call.
        with open(os.path.join(outdir,"rows.json"),"w",encoding="utf-8") as f:
            json.dump(rows,f,ensure_ascii=False,indent=2)
        if i != len(ALL_CASES):
            time.sleep(CASE_DELAY)

    # Persist the expensive model-call evidence before post-processing so a
    # scoring bug can never discard the raw run again.
    with open(os.path.join(outdir,"rows.json"),"w",encoding="utf-8") as f:
        json.dump(rows,f,ensure_ascii=False,indent=2)

    stability=[]
    for sid in STABILITY_IDS:
        case=next(c for c in ALL_CASES if c["id"]==sid)
        time.sleep(CASE_DELAY)
        rep=run_one(key,case)
        first=by_id[sid]
        same=rep["post"]["compiled"]==first["post"]["compiled"]
        stability.append({
            "id":sid,
            "same_compiled":same,
            "first":first["post"]["compiled"],
            "repeat":rep["post"]["compiled"],
            "first_outcome":first["outcome"],
            "repeat_outcome":rep["outcome"],
            "repeat_latency_ms":rep.get("latency_ms"),
        })

    summary=summarize(rows,stability)
    summary["warmup_latency_ms"]=warm.get("latency_ms")

    with open(os.path.join(outdir,"summary.json"),"w",encoding="utf-8") as f:
        json.dump(summary,f,ensure_ascii=False,indent=2)
    with open(os.path.join(outdir,"rows.json"),"w",encoding="utf-8") as f:
        json.dump(rows,f,ensure_ascii=False,indent=2)
    with open(os.path.join(outdir,"stability.json"),"w",encoding="utf-8") as f:
        json.dump(stability,f,ensure_ascii=False,indent=2)
    print("FINAL_SUMMARY="+json.dumps(summary,ensure_ascii=False,sort_keys=True))
    return 0 if summary["api_success"]==len(rows) else 1

if __name__=="__main__":
    raise SystemExit(main())
