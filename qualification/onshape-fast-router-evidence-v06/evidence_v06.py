from __future__ import annotations

import json
import os
import re
import statistics
import time
import urllib.error
import urllib.request
from dataclasses import dataclass

MODEL = "openai/gpt-oss-20b"
ENDPOINT = "https://api.groq.com/openai/v1/chat/completions"
BATCH_SIZE = int(os.environ.get("BATCH_SIZE", "10"))
MAX_BATCH_RETRIES = int(os.environ.get("MAX_BATCH_RETRIES", "8"))

PERSIAN_DIGITS = str.maketrans("۰۱۲۳۴۵۶۷۸۹٠١٢٣٤٥٦٧٨٩", "01234567890123456789")
ARABIC_NORMALIZE = str.maketrans({"ي":"ی","ك":"ک"})

INTENTS = {
    "camera_move": "orbit/pan/zoom camera",
    "fit": "fit whole view or current selection",
    "top_view": "show top view",
    "clear_selection": "clear current viewer selection",
    "inspect": "inspect selection/viewer/collaboration state",
    "follow": "follow collaborator",
    "edge_on_selection": "fillet/chamfer current selection",
    "feature_parameter": "edit existing feature parameter",
    "feature_suppressed": "suppress/unsuppress existing feature",
    "feature_rename": "rename existing feature",
    "feature_delete": "delete existing feature",
    "part_delete": "delete existing part",
    "part_visibility": "hide/show part",
    "part_property": "set part name/color/material/description",
    "add_plane": "create plane",
    "add_pattern": "create linear pattern",
    "add_edge_feature": "create new empty fillet/chamfer",
    "feature_reorder": "move feature before/after another feature",
    "rollback": "move rollback bar",
    "create_part_studio": "create Part Studio",
    "rename_document": "rename document",
}

MATERIAL_INTENTS = {
    "edge_on_selection","feature_parameter","feature_suppressed","feature_rename",
    "feature_delete","part_delete","part_visibility","part_property","add_plane",
    "add_pattern","add_edge_feature","feature_reorder","rollback",
    "create_part_studio","rename_document",
}

WORD_NUM = {
    "صفر":0,"یک":1,"یه":1,"يه":1,"دو":2,"سه":3,"چهار":4,"پنج":5,"شش":6,
    "هفت":7,"هشت":8,"نه":9,"ده":10,"یازده":11,"دوازده":12,"سیزده":13,
    "چهارده":14,"پانزده":15,"شانزده":16,"هفده":17,"هجده":18,"نوزده":19,
}
TENS = {"بیست":20,"سی":30,"چهل":40,"پنجاه":50,"شصت":60,"هفتاد":70,"هشتاد":80,"نود":90}

def norm_text(text):
    t = text.translate(PERSIAN_DIGITS).translate(ARABIC_NORMALIZE).replace("\u200c"," ")
    t = re.sub(r"\s+"," ",t).strip()
    return t

def low(text):
    return norm_text(text).lower()

def has_any(t, xs):
    return any(x in t for x in xs)

def parse_int_words(s):
    s = norm_text(s).strip()
    if re.fullmatch(r"\d+", s):
        return int(s)
    if s in WORD_NUM:
        return WORD_NUM[s]
    if s in TENS:
        return TENS[s]
    parts=[x.strip() for x in s.split(" و ") if x.strip()]
    if len(parts)==2 and parts[0] in TENS and parts[1] in WORD_NUM:
        return TENS[parts[0]]+WORD_NUM[parts[1]]
    return None

def parse_spoken_number(s):
    s=norm_text(s).strip()
    if re.fullmatch(r"[+-]?\d+(?:[.,]\d+)?",s):
        return float(s.replace(",","."))
    if s=="نیم":
        return 0.5
    if s=="ربع":
        return 0.25
    m=re.fullmatch(r"(.+?) و نیم",s)
    if m:
        a=parse_int_words(m.group(1))
        return None if a is None else a+0.5
    m=re.fullmatch(r"(.+?) و (.+?) صدم",s)
    if m:
        a=parse_int_words(m.group(1)); b=parse_int_words(m.group(2))
        return None if a is None or b is None else a+b/100.0
    m=re.fullmatch(r"(.+?) دهم",s)
    if m:
        a=parse_int_words(m.group(1))
        return None if a is None else a/10.0
    m=re.fullmatch(r"(.+?) صدم",s)
    if m:
        a=parse_int_words(m.group(1))
        return None if a is None else a/100.0
    return float(parse_int_words(s)) if parse_int_words(s) is not None else None

NUMBER_PHRASE = r"(?:[+-]?\d+(?:[.,]\d+)?|نیم|ربع|(?:یک|یه|دو|سه|چهار|پنج|شش|هفت|هشت|نه|ده|یازده|دوازده|سیزده|چهارده|پانزده|شانزده|هفده|هجده|نوزده|بیست|سی|چهل|پنجاه|شصت|هفتاد|هشتاد|نود)(?: و (?:نیم|(?:یک|یه|دو|سه|چهار|پنج|شش|هفت|هشت|نه|ده|یازده|دوازده|سیزده|چهارده|پانزده|شانزده|هفده|هجده|نوزده|بیست|سی|چهل|پنجاه|شصت|هفتاد|هشتاد|نود)(?: دهم| صدم)?))?)"

def _longest_spoken_number_before(t, unit_start):
    prefix=t[:unit_start].rstrip()
    toks=list(re.finditer(r"\S+",prefix))
    # Longest suffix first; spoken engineering numbers here are intentionally bounded.
    for k in range(min(7,len(toks)),0,-1):
        start=toks[-k].start()
        cand=prefix[start:].strip(" ،,")
        n=parse_spoken_number(cand)
        if n is not None:
            return start,cand,n
    return None

def extract_quantities(text):
    t=low(text)
    out=[]
    seen=set()
    unit_pat=re.compile(r"(?:میلی(?:متر)?|میل|mm|درجه|deg)\b",re.I)
    for um in unit_pat.finditer(t):
        parsed=_longest_spoken_number_before(t,um.start())
        if not parsed:
            continue
        start,cand,n=parsed
        raw_unit=um.group(0).lower()
        unit="deg" if raw_unit in {"درجه","deg"} else "mm"
        key=(start,um.end(),unit)
        if key in seen: continue
        seen.add(key)
        out.append({"id":f"q{len(out)+1}","value":n,"unit":unit,
                    "text":t[start:um.end()],"span":[start,um.end()]})
    # "ربع دور" is a camera magnitude = 90 degrees.
    for m in re.finditer(r"\bربع\s+دور\b",t):
        out.append({"id":f"q{len(out)+1}","value":90.0,"unit":"deg","text":m.group(0),"span":[m.start(),m.end()]})
    out.sort(key=lambda x:x["span"][0])
    for i,q in enumerate(out,1): q["id"]=f"q{i}"
    return out

def quantity_string(q):
    if q is None: return None
    v=q["value"]; unit=q["unit"]
    if float(v).is_integer(): s=str(int(v))
    else: s=(f"{v:.6f}").rstrip("0").rstrip(".")
    return f"{s} {unit}"

def extract_named_features(text):
    t=norm_text(text)
    out=[]
    for m in re.finditer(r"\b(Fillet|Extrude|Draft|Sketch)\s*(\d+)\b",t,re.I):
        out.append({"id":f"f{len(out)+1}","name":m.group(1).title()+" "+m.group(2),"span":[m.start(),m.end()]})
    for m in re.finditer(r"(فیلت|اکسترود)\s*("+NUMBER_PHRASE+r")",t,re.I):
        suffix=t[m.end():].lstrip()
        if re.match(r"(?:میلی(?:متر)?|میل|mm)\b",suffix,re.I):
            continue
        n=parse_spoken_number(m.group(2))
        if n is not None and float(n).is_integer():
            name=("Fillet" if m.group(1)=="فیلت" else "Extrude")+" "+str(int(n))
            if name not in [x["name"] for x in out]:
                out.append({"id":f"f{len(out)+1}","name":name,"span":[m.start(),m.end()]})
    out.sort(key=lambda x:x["span"][0])
    for i,x in enumerate(out,1): x["id"]=f"f{i}"
    return out

def extract_parts(text):
    t=norm_text(text)
    out=[]
    for m in re.finditer(r"\bPart\s*("+NUMBER_PHRASE+r")\b",t,re.I):
        n=parse_spoken_number(m.group(1))
        if n is not None and float(n).is_integer():
            out.append({"id":f"p{len(out)+1}","name":"Part "+str(int(n)),"span":[m.start(),m.end()]})
    for m in re.finditer(r"پارت\s*("+NUMBER_PHRASE+r")\b",t,re.I):
        n=parse_spoken_number(m.group(1))
        if n is not None and float(n).is_integer():
            name="Part "+str(int(n))
            if name not in [x["name"] for x in out]:
                out.append({"id":f"p{len(out)+1}","name":name,"span":[m.start(),m.end()]})
    for name in ("Cap","Bracket"):
        m=re.search(rf"\b{re.escape(name)}\b",t,re.I)
        if m and name not in [x["name"] for x in out]:
            out.append({"id":f"p{len(out)+1}","name":name,"span":[m.start(),m.end()]})
    out.sort(key=lambda x:x["span"][0])
    for i,x in enumerate(out,1): x["id"]=f"p{i}"
    return out

def extract_name_value(text):
    s=norm_text(text)
    patterns=[
        r"(?:اسم(?:ش)?\s+(?:بشه|بشود))\s+(.+)$",
        r"(?:اسم\s+.+?\s+(?:بشه|بشود))\s+(.+)$",
        r"(?:به اسم)\s+(.+)$",
        r"اسمش\s+(?!رو\b|را\b)(.+)$",
        r"\bcalled\s+(.+)$",
        r"(?:اسم\s+.+?\s+رو\s+بذار)\s+(.+)$",
        r"(?:عوض کن به)\s+(.+)$",
        r"\brename\s+document\s+to\s+(.+)$",
        r"\brename\s+.+?\s+to\s+(.+)$",
        r"(?:داکیومنت(?:و| رو)?\s+rename\s+کن\s+به)\s+(.+)$",
    ]
    for pat in patterns:
        m=re.search(pat,s,re.I)
        if m:
            v=m.group(1).strip(" ،,.;")
            v=re.sub(r"\s+(?:بساز|کن)$","",v).strip()
            if v: return v
    return None

def extract_property_value(text, ctx):
    t=low(text)
    colors={"قرمز":"red","آبی":"blue","ابي":"blue","سبز":"green","مشکی":"black","سیاه":"black","خاکستری":"gray","سفید":"white","زرد":"yellow"}
    for k,v in colors.items():
        if k in t: return ("color",v)
    m=re.search(r"\b(?:color\s*=?\s*)(red|blue|green|black|white|yellow|gray|grey)\b",t,re.I)
    if m: return ("color","gray" if m.group(1).lower()=="grey" else m.group(1).lower())
    if has_any(t,["متریال","material"]):
        for pat in [r"(?:متریال|material).*?(?:رو|را|=|to)\s+(.+?)(?:\s+(?:بذار|بگذار|کن))?$", r"(?:متریالش رو)\s+(.+?)\s+کن$"]:
            m=re.search(pat,norm_text(text),re.I)
            if m:
                v=m.group(1).strip()
                if v:
                    aliases={"فولاد":"Steel","آلومینیوم":"Aluminum","الومینیوم":"Aluminum"}
                    return ("material",aliases.get(low(v),v))
    if "description" in t:
        m=re.search(r"description.*?(?:بذار|بگذار|=|to)\s+(.+)$",norm_text(text),re.I)
        if m: return ("description",m.group(1).strip())
    name=extract_name_value(text)
    if name and has_any(t,["اسم","rename"]):
        return ("name",name)
    return (None,None)

def extract_evidence(text, ctx=None):
    ctx=ctx or {}
    t=low(text)
    qs=extract_quantities(text)
    fs=extract_named_features(text)
    ps=extract_parts(text)
    prop,pval=extract_property_value(text,ctx)

    visibility=None
    if re.search(r"(?:نشون|نشان)\s+نده",t) or "نشون نده" in t or "نشان نده" in t:
        visibility=False
    elif has_any(t,["مخفی","قایم","hide","نشونش نده","نشانش نده"]):
        visibility=False
    elif has_any(t,["نشون بده","نشان بده","نشونش بده","نشانش بده","show","دوباره بیار","برگردونش توی نما"]):
        visibility=True

    suppressed=None
    if has_any(t,["خاموش","suppress"]): suppressed=True
    if has_any(t,["دوباره روشن","روشنش کن","روشن کن","unsuppress"]): suppressed=False
    if ctx.get("last_action")=="suppress" and has_any(t,["برش گردون","برگردونش","دوباره بیارش"]):
        suppressed=False

    relation=None
    if has_any(t,["قبل از","قبل ","بالای","بالا ی"]): relation="before"
    elif has_any(t,["بعد از","بعد ","زیر"]): relation="after"

    relative=None
    if has_any(t,["زیادش کن","بیشترش کن","بیشتر کن","یه میل بیشتر","یک میل بیشتر"]) or re.search(r"\bبیشتر\s+کن\b",t): relative="add"
    elif has_any(t,["کمترش کن","کم کن","یه میل کمتر","یک میل کمتر"]) or re.search(r"\bکمتر\s+کن\b",t): relative="subtract"

    design = has_any(t,[
        "خوشگل","پریمیوم","حرفه ای تر","حرفه‌ای‌تر","تولیدش راحت","تولید راحت",
        "سبک تر","سبک‌تر","وزنشو کم","وزنش رو کم","سفت بمونه","استحکام","قوی تر","قوی‌تر",
        "تزریق پلاستیک","طراحی بهتر","طراحی رو درست","اضافی",
        "مقاومتش کم نشه","مقاومت کم نشه","قالب گیری","قالب‌گیری","به دردنخور"
    ])
    unsupported = has_any(t,["public","share","pdf","export","step بگیر","mate","company","شرکت onshape"])

    camera_action=None; camera_direction=None; camera_inverse=False
    if has_any(t,["زوم","zoom"]): camera_action="zoom"
    elif has_any(t,["پن ","pan","نما رو","صفحه رو","هل بده"]): camera_action="pan"
    elif has_any(t,["بچرخ","rotate","ساعتگرد","پادساعتگرد","clockwise","counterclockwise","ربع دور"]): camera_action="orbit"
    if "پادساعتگرد" in t or re.search(r"\bcounterclockwise\b",t): camera_direction="counterclockwise"
    elif "ساعتگرد" in t or re.search(r"\bclockwise\b",t): camera_direction="clockwise"
    elif has_any(t,["سمت راست","به راست","طرف راست","راست بچرخ","هل بده راست"]): camera_direction="right"
    elif has_any(t,["سمت چپ","به چپ","طرف چپ","چپ بچرخ","هل بده چپ"]): camera_direction="left"
    elif has_any(t,["ببر بالا","پن کن بالا","بالا بچرخ"]): camera_direction="up"
    elif has_any(t,["ببر پایین","پن کن پایین","پایین بچرخ"]): camera_direction="down"
    elif camera_action and re.search(r"\b(right|راست)\b",t): camera_direction="right"
    elif camera_action and re.search(r"\b(left|چپ)\b",t): camera_direction="left"
    elif camera_action and re.search(r"\b(up|بالا)\b",t): camera_direction="up"
    elif camera_action and re.search(r"\b(down|پایین)\b",t): camera_direction="down"
    if has_any(t,["زیادی شد","برش گردون","برگرد","عقب تر","عقب‌تر"]):
        camera_inverse=True

    fit_all = has_any(t,["فیت","fit","تو کادر جا","توی کادر جا","کل مدل تو کادر"])
    fit_selection = fit_all and has_any(t,["انتخاب","همین انتخاب","selection"])
    top_view = has_any(t,["از بالا","top view"])
    clear_selection = has_any(t,["انتخاب رو پاک","انتخاب را پاک","selection رو خالی","selection را خالی","انتخابارو ول کن","انتخاب ها رو ول کن"])

    edge_kind=None
    if has_any(t,["پخ","چمفر","chamfer"]): edge_kind="chamfer"
    elif has_any(t,["فیلت","fillet","فیلِت"]): edge_kind="fillet"

    # In the owner's CAD shorthand, a bare fractional edge size is millimetres.
    # Keep this bounded to explicit fractional forms so "فیلت دو" can never become 2 mm.
    if edge_kind and not qs:
        frac_pat=r"(?:نیم|(?:یک|یه|دو|سه|چهار|پنج|شش|هفت|هشت|نه|ده|بیست|سی|چهل|پنجاه|شصت|هفتاد|هشتاد|نود)(?:\s+و\s+نیم|\s+(?:دهم|صدم)))"
        for fm in re.finditer(frac_pat,t):
            n=parse_spoken_number(fm.group(0))
            if n is not None:
                qs.append({"id":"q1","value":n,"unit":"mm","text":fm.group(0),
                           "span":[fm.start(),fm.end()],"implicit_unit":True})
                break

    action_cues=[]
    def cue(name, cond):
        if cond: action_cues.append(name)
    named_feature_context = bool(fs) and (relation is not None or has_any(t,["اسم","rename","پاک","حذف","بنداز دور"]))
    edge_effect_context = (ctx.get("selection_count",0)>0 or has_any(t,["لبه","انتخاب","selected"]) or has_any(t,["جدید","خالی","بدون انتخاب"]))
    cue("fillet", has_any(t,["فیلت","fillet","فیلِت"]) and edge_effect_context and not named_feature_context)
    cue("chamfer", has_any(t,["پخ","چمفر","chamfer"]) and edge_effect_context and not named_feature_context)
    cue("hide_show", visibility is not None)
    cue("color", prop=="color")
    cue("rename", prop=="name" or (has_any(t,["اسم","rename"]) and extract_name_value(text)))
    cue("delete", has_any(t,["پاک کن","حذف کن","بنداز دور","حذفش کن"]))
    cue("reorder", relation is not None and len(fs)>=1 and "rollback" not in t)
    cue("rollback", "rollback" in t)
    cue("create_plane", has_any(t,["plane","صفحه مرجع"]) and has_any(t,["بساز","جدید","خالی"]))
    cue("pattern", has_any(t,["pattern","الگو","خطی تکرار"]))
    # Multi-action only for genuinely different effect families. A rename phrase containing "بذار"
    # is one action; quantity conjunctions are never counted here.
    distinct=set(action_cues)
    multi_action = (("fillet" in distinct and "chamfer" in distinct) or
                    ("color" in distinct and "hide_show" in distinct) or
                    len([x for x in distinct if x in {"fillet","chamfer","hide_show","color","delete","reorder","rollback","create_plane","pattern"}])>1)

    return {
        "text":norm_text(text),
        "quantities":qs,
        "features":fs,
        "parts":ps,
        "context_feature":ctx.get("last_feature"),
        "context_part":ctx.get("last_part"),
        "selection_count":ctx.get("selection_count",0),
        "selection_types":ctx.get("selection_types",[]),
        "last_move":ctx.get("last_move"),
        "feature_parameters":ctx.get("feature_parameters",{}),
        "last_action":ctx.get("last_action"),
        "collaborator_count":ctx.get("collaborator_count"),
        "visibility":visibility,
        "suppressed":suppressed,
        "relation":relation,
        "relative":relative,
        "property":prop,
        "property_value":pval,
        "name_value":extract_name_value(text),
        "design":design,
        "unsupported":unsupported,
        "camera_action":camera_action,
        "camera_direction":camera_direction,
        "camera_inverse":camera_inverse,
        "fit_all":fit_all,
        "fit_selection":fit_selection,
        "top_view":top_view,
        "clear_selection":clear_selection,
        "edge_kind":edge_kind,
        "multi_action":multi_action,
        "action_cues":action_cues,
    }

def choose_feature(ev):
    if ev["features"]: return ev["features"][0]["name"]
    return ev.get("context_feature")

def choose_part(ev):
    if ev["parts"]: return ev["parts"][0]["name"]
    return ev.get("context_part")

def first_quantity(ev, unit=None):
    for q in ev["quantities"]:
        if unit is None or q["unit"]==unit: return q
    return None

def all_quantities(ev, unit=None):
    return [q for q in ev["quantities"] if unit is None or q["unit"]==unit]

def opposite(d):
    return {"left":"right","right":"left","up":"down","down":"up",
            "in":"out","out":"in","clockwise":"counterclockwise",
            "counterclockwise":"clockwise"}.get(d)

def direct_intent(case, ev):
    t=low(case["text"])
    ctx=case.get("ctx",{})

    if ev["design"]: return ("think",None)
    if ev["unsupported"]: return ("ask",None)
    if ev["multi_action"]: return ("ask",None)

    if ev["clear_selection"]: return ("act","clear_selection")
    if ev["fit_all"]: return ("act","fit")
    if ev["top_view"]: return ("act","top_view")
    if has_any(t,["چی انتخاب","چی انتخابه","چی انتخاب شده","چی سلکت","سلکت شده"]): return ("act","inspect")
    if has_any(t,["وضعیت ویور","viewer state"]): return ("act","inspect")
    if has_any(t,["سشن","session","چند نفر تو","کسایی تو","کسانی تو"]): return ("act","inspect")
    if has_any(t,["فالو","follow"]): return ("act","follow")

    if "flip direction" in t and choose_feature(ev):
        return ("act","feature_parameter")
    if has_any(t,["اسم","rename"]) and choose_feature(ev):
        return ("act","feature_rename")
    if has_any(t,["آخرین فیچر","اولین فیچر","فیچرو","فیچر رو"]) and has_any(t,["پاک","حذف","بنداز دور"]):
        return ("act","feature_delete")
    if choose_feature(ev) and has_any(t,["پاک کن","حذف کن","بنداز دور"]):
        return ("act","feature_delete")
    if choose_part(ev) and has_any(t,["پاک کن","حذف کن"]) and not choose_feature(ev):
        return ("act","part_delete")
    if "rollback" in t: return ("act","rollback")
    if ev["relation"] and (len(ev["features"])>=2 or (ctx.get("last_feature") and len(ev["features"])>=1)):
        return ("act","feature_reorder")

    if ev["suppressed"] is not None and choose_feature(ev):
        return ("act","feature_suppressed")
    if ev["visibility"] is not None and choose_part(ev): return ("act","part_visibility")
    if ev["property"] and choose_part(ev): return ("act","part_property")

    if ev["edge_kind"]:
        explicit_new=has_any(t,["جدید","خالی","بدون انتخاب","فعلا بدون","فعلاً بدون","بساز"])
        if explicit_new: return ("act","add_edge_feature")
        if choose_feature(ev) and first_quantity(ev) and not (ctx.get("selection_count",0)>0 or has_any(t,["لبه","انتخاب","selected"])):
            return ("act","feature_parameter")
        return ("act","edge_on_selection")

    # Camera direct lane, including contextual correction.
    if ev["camera_action"] or (ev["last_move"] and has_any(t,["بیشتر","برگرد","برش گردون","برگردون","زیادی شد","عقب تر","عقب‌تر","همون طرف"])):
        return ("act","camera_move")
    if has_any(t,["part studio","پارت استودیو"]) and has_any(t,["بساز","جدید","new"]): return ("act","create_part_studio")
    if has_any(t,["داکیومنت","document"]) and has_any(t,["اسم","rename","بشه","بذار"]): return ("act","rename_document")

    if has_any(t,["plane","صفحه مرجع"]) and has_any(t,["بساز","جدید","خالی"]): return ("act","add_plane")
    if has_any(t,["pattern","الگو","خطی تکرار"]): return ("act","add_pattern")

    # Existing-feature parameter cues.
    if choose_feature(ev) and (has_any(t,["شعاع","radius","عمق","depth","زاویه","angle","flip direction"]) or ev["relative"]):
        return ("act","feature_parameter")

    # Existing-part property by common shorthand.
    if choose_part(ev) and has_any(t,["رنگ","color","متریال","material","description"]):
        return ("act","part_property")

    # Known unsupported/deictic shapes fail closed.
    if has_any(t,["ایزو","ایزومتریک","front view","نمای روبرو","mirror","سوراخ","hole","این رو انتخاب","اون لبه"]):
        return ("ask",None)
    if has_any(t,["همه رو پاک","همه را پاک","کل مدل رو حذف"]):
        return ("ask",None)
    return (None,None)

def compile_intent(case, decision, intent, ev):
    t=low(case["text"]); ctx=case.get("ctx",{})
    if decision=="think":
        return reject("design-escalation")
    if decision=="ask" or not intent:
        return reject("clarification")

    if intent in MATERIAL_INTENTS and ev["multi_action"]:
        return reject("semantic-residue-multi-action")

    if intent=="camera_move":
        lm=ev.get("last_move") or {}
        action=ev.get("camera_action") or lm.get("action")
        direction=ev.get("camera_direction")
        if ev.get("camera_inverse") and lm:
            action=lm.get("action",action)
            direction=opposite(lm.get("direction"))
        elif not direction and lm and has_any(t,["بیشتر","همون طرف"]):
            action=lm.get("action",action)
            direction=lm.get("direction")
        if action=="zoom" and not direction:
            if has_any(t,["اوت","out","بیرون","عقب"]): direction="out"
            elif has_any(t,["داخل","in","زومشو","زوم کن"]) or t.strip() in {"زوم","zoom"}: direction="in"
        if not action:
            action="orbit"
        allowed={"orbit":{"left","right","up","down","clockwise","counterclockwise"},
                 "pan":{"left","right","up","down"},"zoom":{"in","out"}}
        if action not in allowed or direction not in allowed[action]:
            return reject("camera-ungrounded")
        args={"action":action,"direction":direction}
        q=first_quantity(ev,"deg")
        if q: args["angle_degrees"]=q["value"]
        return accept("view.move",args,{"direction":"text/context","magnitude":q["id"] if q else None})

    if intent=="fit":
        target="selection" if ev["fit_selection"] else "all"
        if target=="selection" and ev["selection_count"]<=0:
            return reject("fit-selection-ungrounded")
        return accept("view.fit",{"action":"fit_selection" if target=="selection" else "fit"},{"target":"text/context"})

    if intent=="top_view": return accept("view.standard",{"view":"top"},{"view":"text"})
    if intent=="clear_selection": return accept("viewer.selection.clear",{},{})

    if intent=="inspect":
        if has_any(t,["سشن","session","چند نفر","کسایی","کسانی"]): mode="collaboration"
        elif has_any(t,["انتخاب","selection","چی انتخاب","سلکت","select"]): mode="selection"
        else: mode="state"
        return accept("viewer.inspect",{"mode":mode},{"mode":"text"})

    if intent=="follow":
        cc=ev.get("collaborator_count")
        idx=2 if has_any(t,["نفر دوم","second"]) else None
        if cc and cc>=3 and idx is None: return reject("follow-ambiguous")
        return accept("view.follow",{} if idx is None else {"candidate_index":idx},{"candidate":"text/context"})

    if intent=="edge_on_selection":
        if ev["selection_count"]<=0: return reject("selection-ungrounded")
        if ev["edge_kind"] not in {"fillet","chamfer"}: return reject("edge-kind-missing")
        qs=all_quantities(ev,"mm")
        if len(qs)!=1: return reject("edge-amount-ambiguous")
        return accept("feature.from_selection",
                      {"feature_type":ev["edge_kind"],"amount":quantity_string(qs[0])},
                      {"kind":"text","amount":qs[0]["id"],"selection":"verified-context"})

    if intent=="feature_parameter":
        feature=choose_feature(ev)
        if not feature: return reject("feature-ungrounded")
        if str(feature).lower().startswith("fillet"): parameter="radius"
        elif has_any(t,["عمق","depth"]): parameter="depth"
        elif has_any(t,["زاویه","angle"]): parameter="angle"
        elif "flip direction" in t: parameter="flip direction"
        else: return reject("feature-parameter-ungrounded")

        if parameter=="flip direction":
            if has_any(t,["خاموش"]) or re.search(r"\b(?:off|false)\b",t): value=False
            elif has_any(t,["روشن"]) or re.search(r"\b(?:on|true)\b",t): value=True
            else: return reject("boolean-value-ungrounded")
            return accept("feature.parameter.set",{"feature_name":feature,"parameter":parameter,"value":value},
                          {"feature":"text/context","value":"text"})

        unit="deg" if parameter=="angle" else "mm"
        qs=all_quantities(ev,unit)
        if ev["relative"]:
            if len(qs)!=1: return reject("relative-delta-ambiguous")
            current=(ev.get("feature_parameters") or {}).get(parameter)
            if current is None and parameter=="radius":
                current=(ev.get("feature_parameters") or {}).get("radius")
            cur=parse_quantity_literal(current,unit)
            if cur is None: return reject("relative-current-missing")
            delta=qs[0]["value"]*(1 if ev["relative"]=="add" else -1)
            value=cur+delta
            qstr=f"{int(value) if float(value).is_integer() else value:g} {unit}"
            return accept("feature.parameter.set",{"feature_name":feature,"parameter":parameter,"amount":qstr},
                          {"feature":"text/context","delta":qs[0]["id"],"current":"verified-context","operator":ev["relative"]})
        if len(qs)!=1: return reject("feature-value-ambiguous")
        return accept("feature.parameter.set",{"feature_name":feature,"parameter":parameter,"amount":quantity_string(qs[0])},
                      {"feature":"text/context","value":qs[0]["id"],"parameter":"text/type"})

    if intent=="feature_suppressed":
        feature=choose_feature(ev)
        if not feature or ev["suppressed"] is None: return reject("suppress-ungrounded")
        return accept("feature.patch",{"feature_name":feature,"suppressed":ev["suppressed"]},
                      {"feature":"text/context","state":"text"})

    if intent=="feature_rename":
        feature=choose_feature(ev); name=ev.get("name_value")
        if not feature or not name: return reject("feature-rename-ungrounded")
        return accept("feature.patch",{"feature_name":feature,"new_name":name},
                      {"feature":"text/context","name":"text-span"})

    if intent=="feature_delete":
        if "آخرین" in t: return accept("feature.delete",{"position":"last"},{"position":"text"})
        if "اولین" in t: return accept("feature.delete",{"position":"first"},{"position":"text"})
        feature=choose_feature(ev)
        if not feature: return reject("delete-feature-ungrounded")
        return accept("feature.delete",{"feature_name":feature},{"feature":"text/context"})

    if intent=="part_delete":
        part=choose_part(ev)
        if not part: return reject("delete-part-ungrounded")
        return accept("feature.delete_part",{"part_name":part},{"part":"text/context"})

    if intent=="part_visibility":
        part=choose_part(ev)
        if not part or ev["visibility"] is None: return reject("visibility-ungrounded")
        return accept("part.visibility",{"part_name":part,"visible":ev["visibility"]},
                      {"part":"text/context","state":"text-negation-aware"})

    if intent=="part_property":
        part=choose_part(ev); prop=ev.get("property"); value=ev.get("property_value")
        if not part or not prop or value is None: return reject("part-property-ungrounded")
        op="documented.updateWVEPMetadata" if prop=="name" else "metadata.property.set"
        return accept(op,{"part_name":part,"property":prop,"value":value},
                      {"part":"text/context","property":"text","value":"text-span"})

    if intent=="add_plane":
        if has_any(t,["right","left","top","front"]) and not ev.get("name_value"):
            return reject("plane-reference-needs-provider-shape")
        args={"feature_type":"plane"}
        if ev.get("name_value"): args["name"]=ev["name_value"]
        return accept("feature.add",args,{"name":"text-span" if ev.get("name_value") else None})

    if intent=="add_pattern":
        if not has_any(t,["pattern","الگو","تکرار"]):
            return reject("pattern-not-explicit")
        part=choose_part(ev)
        qs=all_quantities(ev,"mm")
        copies=extract_copy_count(case["text"])
        if not part or copies is None or len(qs)!=1: return reject("pattern-ungrounded")
        return accept("feature.add",
                      {"feature_type":"linearPattern","part_name":part,"copies":copies,"distance":quantity_string(qs[0])},
                      {"part":"text/context","copies":"text","distance":qs[0]["id"]})

    if intent=="add_edge_feature":
        if not has_any(t,["جدید","خالی","بدون انتخاب","فعلا بدون","فعلاً بدون","بساز"]):
            return reject("new-edge-not-explicit")
        qs=all_quantities(ev,"mm")
        if ev["edge_kind"] not in {"fillet","chamfer"} or len(qs)!=1:
            return reject("new-edge-ungrounded")
        return accept("feature.add",{"feature_type":ev["edge_kind"],"amount":quantity_string(qs[0])},
                      {"kind":"text","amount":qs[0]["id"]})

    if intent=="feature_reorder":
        fs=[x["name"] for x in ev["features"]]
        if ev.get("context_feature") and len(fs)==1:
            source=ev["context_feature"]; target=fs[0]
        elif len(fs)>=2:
            source,target=fs[0],fs[1]
        else: return reject("reorder-targets-ungrounded")
        if ev["relation"] not in {"before","after"}: return reject("reorder-relation-ungrounded")
        return accept("feature.reorder",{"source_feature":source,"target_feature":target,"placement":ev["relation"]},
                      {"source":"text/context","target":"text","placement":"text"})

    if intent=="rollback":
        fs=[x["name"] for x in ev["features"]]
        if ev["relation"]=="before" and fs:
            args={"before_feature":fs[-1]}
        elif ev["relation"]=="after" and fs:
            args={"after_feature":fs[-1]}
        elif "آخر" in t:
            args={"position":"end"}
        elif "اول" in t:
            args={"position":"start"}
        else: return reject("rollback-ungrounded")
        return accept("rollback.set",args,{"target":"text"})

    if intent=="create_part_studio":
        name=ev.get("name_value")
        if not name:
            m=re.search(r"(?:part studio|پارت استودیو).*?(?:اسمش|به اسم)\s+(.+)$",norm_text(case["text"]),re.I)
            name=m.group(1).strip() if m else None
        if not name: return reject("part-studio-name-ungrounded")
        return accept("documented.createPartStudio",{"new_name":name},{"name":"text-span"})

    if intent=="rename_document":
        name=ev.get("name_value")
        if not name: return reject("document-name-ungrounded")
        return accept("documented.updateDocumentAttributes",{"new_name":name},{"name":"text-span"})

    return reject("intent-unhandled")

def parse_quantity_literal(v, unit):
    if v is None: return None
    s=low(str(v))
    m=re.fullmatch(r"([+-]?\d+(?:\.\d+)?)\s*"+re.escape(unit),s)
    return float(m.group(1)) if m else None

def extract_copy_count(text):
    t=low(text)
    pats=[
        rf"({NUMBER_PHRASE})\s*(?:تایی|تا|بار|copies)\b",
        rf"(?:pattern|الگو).*?({NUMBER_PHRASE})\s*(?:تایی|تا|copies)\b",
    ]
    for p in pats:
        m=re.search(p,t)
        if m:
            n=parse_spoken_number(m.group(1))
            if n is not None and float(n).is_integer(): return int(n)
    return None

def accept(op,args,provenance):
    return {"accepted":True,"reason":"ok","compiled":{"route":"do","op":op,"args":args},"provenance":provenance}

def reject(reason):
    route="think" if reason=="design-escalation" else "ask"
    return {"accepted":False,"reason":reason,"compiled":{"route":route,"op":None,"args":{}}}

def model_items(cases):
    items=[]
    for c in cases:
        ev=extract_evidence(c["text"],c.get("ctx",{}))
        compact={k:v for k,v in ev.items() if k not in {"feature_parameters","last_move"}}
        compact["feature_parameters"]=ev.get("feature_parameters")
        compact["last_move"]=ev.get("last_move")
        items.append({"id":c["id"],"command":ev["text"],"evidence":compact})
    return items

def call_model_batch(key,cases):
    meanings=json.dumps(INTENTS,ensure_ascii=False,separators=(",",":"))
    system=(
        "You are a Persian/mixed-language semantic planner for Onshape. "
        "Choose only the user's semantic intent; never invent targets, numbers, names, colors, geometry, or state. "
        "All material values/targets will be derived later from deterministic evidence. "
        "If the sentence requests open-ended design/engineering judgment use d='t'. "
        "If unsupported, ambiguous, missing required information, or more than one material action is requested use d='q'. "
        "Otherwise use d='a' and choose exactly one intent from the provided intent set. "
        "Return JSON only: {\"r\":[{\"id\":\"...\",\"d\":\"a|q|t\",\"i\":\"intent-or-null\"}]}. "
        "Intent meanings: "+meanings
    )
    body={
        "model":MODEL,
        "messages":[{"role":"system","content":system},
                    {"role":"user","content":json.dumps({"items":model_items(cases)},ensure_ascii=False,separators=(",",":"))}],
        "reasoning_effort":"low","temperature":0,
        "max_completion_tokens":max(300,55*len(cases)),
        "response_format":{"type":"json_object"},
    }
    payload=json.dumps(body,ensure_ascii=False).encode("utf-8")
    last=None
    for attempt in range(MAX_BATCH_RETRIES):
        req=urllib.request.Request(ENDPOINT,data=payload,
            headers={"Authorization":"Bearer "+key,"Content-Type":"application/json",
                     "User-Agent":"cf-exec-plane-onshape-evidence-v06/1.0"},method="POST")
        t0=time.perf_counter()
        try:
            with urllib.request.urlopen(req,timeout=90) as resp:
                data=json.loads(resp.read().decode("utf-8"))
                obj=json.loads(data["choices"][0]["message"]["content"])
                return {"ok":True,"latency_ms":(time.perf_counter()-t0)*1000,
                        "results":obj.get("r",[]),"usage":data.get("usage",{}),"attempts":attempt+1}
        except urllib.error.HTTPError as e:
            txt=e.read().decode("utf-8","replace")
            last={"ok":False,"status":e.code,"error":f"HTTP {e.code}: {txt[:700]}"}
            if e.code not in {400,429,500,502,503,504}: return last
            wait=e.headers.get("retry-after")
            try: wait=float(wait)+0.5 if wait else 10*(attempt+1)
            except Exception: wait=10*(attempt+1)
            time.sleep(min(max(wait,3),120))
        except Exception as e:
            last={"ok":False,"error":repr(e)}
            time.sleep(min(10*(attempt+1),45))
    return last or {"ok":False,"error":"batch-failed"}

def plan_case(case, model_choice=None):
    ev=extract_evidence(case["text"],case.get("ctx",{}))
    d,i=direct_intent(case,ev)
    source="evidence_reflex"
    if d is None:
        if not model_choice:
            return None
        d=model_choice.get("d")
        i=model_choice.get("i") if d=="a" else None
        source="model_intent"
    if d not in {"a","q","t","act","ask","think"}:
        d="q"
    decision={"a":"act","q":"ask","t":"think"}.get(d,d)
    post=compile_intent(case,decision,i,ev)
    return {"case":case,"source":source,"decision":decision,"intent":i,"evidence":ev,"post":post}

def semantic_equivalence_options(expected):
    # Equivalent implementation routes for part-name metadata.
    out=[expected]
    if expected.get("route")=="do" and expected.get("args",{}).get("property")=="name":
        op=expected.get("op")
        if op=="metadata.property.set":
            x=json.loads(json.dumps(expected)); x["op"]="documented.updateWVEPMetadata"; out.append(x)
        elif op=="documented.updateWVEPMetadata":
            x=json.loads(json.dumps(expected)); x["op"]="metadata.property.set"; out.append(x)
    return out

def norm_scalar(v):
    if isinstance(v,str): return low(v)
    return v

def subset_match(expected, got):
    if isinstance(expected,dict):
        return isinstance(got,dict) and all(k in got and subset_match(v,got[k]) for k,v in expected.items())
    if isinstance(expected,list):
        return isinstance(got,list) and len(got)>=len(expected) and all(subset_match(v,got[i]) for i,v in enumerate(expected))
    return norm_scalar(expected)==norm_scalar(got)

def expected_match(case, compiled):
    for e in case["expected"]:
        for exp in semantic_equivalence_options(e):
            if subset_match(exp,compiled): return True
    return False

MATERIAL_OPS={
    "feature.from_selection","feature.parameter.set","feature.patch","feature.delete","feature.delete_part",
    "feature.add","feature.reorder","part.visibility","metadata.property.set","rollback.set",
    "documented.createPartStudio","documented.updateDocumentAttributes","documented.updateWVEPMetadata",
}
REVERSIBLE_OPS={"view.move","view.fit","view.standard","viewer.selection.clear","viewer.inspect","view.follow"}

def classify(case, post):
    compiled=post["compiled"]
    if expected_match(case,compiled): return "correct"
    routes={x.get("route") for x in case["expected"]}
    if post["accepted"] and routes <= {"ask","think"}: return "false_execute"
    if "do" in routes and not post["accepted"]: return "conservative_escalation"
    if post["accepted"] and compiled.get("op") in MATERIAL_OPS: return "wrong_material_accepted"
    if post["accepted"] and compiled.get("op") in REVERSIBLE_OPS: return "wrong_reversible_accepted"
    return "route_mismatch"

def run_suite(cases, key):
    started=time.perf_counter()
    rows_by_id={}
    fallback=[]
    for c in cases:
        row=plan_case(c)
        if row is None: fallback.append(c)
        else:
            row["outcome"]=classify(c,row["post"])
            rows_by_id[c["id"]]=row

    usage={"prompt_tokens":0,"completion_tokens":0}
    model_lats=[]
    calls=0; retries=0
    for start in range(0,len(fallback),BATCH_SIZE):
        batch=fallback[start:start+BATCH_SIZE]
        res=call_model_batch(key,batch)
        calls+=1
        if not res.get("ok"):
            for c in batch:
                post=reject("api-failure")
                row={"case":c,"source":"model_intent","decision":"ask","intent":None,
                     "evidence":extract_evidence(c["text"],c.get("ctx",{})),"post":post,"error":res.get("error")}
                row["outcome"]="api_failure"
                rows_by_id[c["id"]]=row
            continue
        retries+=max(0,res.get("attempts",1)-1)
        usage["prompt_tokens"]+=res.get("usage",{}).get("prompt_tokens") or 0
        usage["completion_tokens"]+=res.get("usage",{}).get("completion_tokens") or 0
        model_lats.append(res.get("latency_ms",0))
        byid={x.get("id"):x for x in res.get("results",[]) if isinstance(x,dict)}
        for c in batch:
            choice=byid.get(c["id"],{"d":"q","i":None})
            row=plan_case(c,choice)
            row["model_choice"]=choice
            row["model_latency_ms"]=res.get("latency_ms",0)
            row["outcome"]=classify(c,row["post"])
            rows_by_id[c["id"]]=row

    rows=[rows_by_id[c["id"]] for c in cases]
    outcomes={}
    for r in rows: outcomes[r["outcome"]]=outcomes.get(r["outcome"],0)+1
    material=[r for r in rows if r["outcome"]=="wrong_material_accepted"]
    falsex=[r for r in rows if r["outcome"]=="false_execute"]
    routine=[r for r in rows if any(e.get("route")=="do" for e in r["case"]["expected"])]
    summary={
        "architecture":"evidence extraction -> deterministic reflex or intent-only 20B -> provenance compiler/residue guard",
        "model":MODEL,
        "cases":len(rows),
        "evidence_reflex_cases":sum(r["source"]=="evidence_reflex" for r in rows),
        "model_intent_cases":sum(r["source"]=="model_intent" for r in rows),
        "model_batch_calls":calls,
        "model_batch_retries":retries,
        "exact_correct":sum(r["outcome"]=="correct" for r in rows),
        "exact_accuracy":sum(r["outcome"]=="correct" for r in rows)/len(rows),
        "wrong_material_accepted":len(material),
        "wrong_material_ids":[r["case"]["id"] for r in material],
        "false_execute":len(falsex),
        "false_execute_ids":[r["case"]["id"] for r in falsex],
        "wrong_reversible_accepted":sum(r["outcome"]=="wrong_reversible_accepted" for r in rows),
        "conservative_escalations":sum(r["outcome"]=="conservative_escalation" for r in rows),
        "route_mismatch":sum(r["outcome"]=="route_mismatch" for r in rows),
        "api_failures":sum(r["outcome"]=="api_failure" for r in rows),
        "routine_expected_do":len(routine),
        "routine_auto_accepted":sum(r["post"]["accepted"] for r in routine),
        "routine_correct":sum(r["outcome"]=="correct" for r in routine),
        "provider_prompt_tokens":usage["prompt_tokens"],
        "provider_completion_tokens":usage["completion_tokens"],
        "model_batch_p50_ms":statistics.median(model_lats) if model_lats else None,
        "model_batch_p95_ms":sorted(model_lats)[max(0,min(len(model_lats)-1,round((len(model_lats)-1)*.95)))] if model_lats else None,
        "wall_seconds":time.perf_counter()-started,
        "outcomes":outcomes,
    }
    return rows,summary
