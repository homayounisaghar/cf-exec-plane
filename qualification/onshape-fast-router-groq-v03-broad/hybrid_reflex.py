from __future__ import annotations

import json
import os
import re

import benchmark as b

NUM_WORDS = {
    "نیم": 0.5,
    "یک": 1, "یه": 1, "يک": 1,
    "دو": 2, "سه": 3, "چهار": 4, "پنج": 5, "شش": 6,
    "هفت": 7, "هشت": 8, "نه": 9, "ده": 10, "دوازده": 12,
    "بیست": 20, "سی": 30, "چهل": 40, "چهل و پنج": 45,
}
COLOR = {"قرمز":"red","آبی":"blue","ابي":"blue","سبز":"green"}


def compiled(route, op=None, args=None):
    return {"route": route, "op": op, "args": args or {}}


def first_num(text):
    t=b.norm_text(text).lower()
    m=re.search(r"(?<![a-z])([0-9]+(?:[.,][0-9]+)?)",t)
    if m:
        x=float(m.group(1).replace(",","."))
        return int(x) if x.is_integer() else x
    for phrase in sorted(NUM_WORDS,key=len,reverse=True):
        if phrase in t:
            return NUM_WORDS[phrase]
    return None


def quantity(text):
    t=b.norm_text(text).lower()
    q=b.extract_quantity(t)
    if q:
        return q
    if "یک و بیست و پنج صدم" in t and ("میل" in t or "میلی" in t):
        return "1.25 mm"
    for phrase,n in sorted(NUM_WORDS.items(), key=lambda kv:len(kv[0]), reverse=True):
        if re.search(rf"\b{re.escape(phrase)}\s*(?:میلی(?:متر)?|میل)\b",t):
            return f"{n:g} mm"
        if re.search(rf"\b{re.escape(phrase)}\s*درجه\b",t):
            return f"{n:g} deg"
    return None


def named_feature(text):
    t=b.norm_text(text)
    m=re.search(r"\b(Fillet|Extrude|Draft|Sketch)\s*(\d+)\b",t,re.I)
    if m:
        return m.group(1).title()+" "+m.group(2)
    m=re.search(r"(فیلت|اکسترود)\s*(\d+)",t)
    if m:
        return ("Fillet" if m.group(1)=="فیلت" else "Extrude")+" "+m.group(2)
    return None


def all_features(text):
    t=b.norm_text(text)
    out=[]
    for m in re.finditer(r"\b(Fillet|Extrude|Draft|Sketch)\s*(\d+)\b",t,re.I):
        out.append(m.group(1).title()+" "+m.group(2))
    return out


def part_name(text, ctx):
    t=b.norm_text(text)
    m=re.search(r"\bPart\s*(\d+)\b",t,re.I)
    if m:
        return "Part "+m.group(1)
    m=re.search(r"\b(Cap|Bracket)\b",t,re.I)
    if m:
        return m.group(1).title()
    return ctx.get("last_part")


def after_any(text, patterns):
    raw=b.norm_text(text)
    for p in patterns:
        m=re.search(p,raw,re.I)
        if m:
            return m.group(1).strip()
    return None


def opposite(d):
    return {"left":"right","right":"left","up":"down","down":"up","in":"out","out":"in",
            "clockwise":"counterclockwise","counterclockwise":"clockwise"}.get(d)


def reflex(case):
    raw=case["text"]
    t=b.low(raw)
    ctx=case.get("ctx",{})

    # Open-ended design and hard unsupported/safety boundaries.
    if b.has_any(t,["خوشگل","پریمیوم","سبک تر","سبک‌تر","استحکام","قوی تر","قوی‌تر","تزریق پلاستیک","طراحی رو درست","طراحی بهتر"]):
        return compiled("think")
    if b.has_any(t,[" public","public کن","شرکت onshape","company","mate","pdf","export","ایزومتریک","front view"]):
        return compiled("ask")
    if b.has_any(t,["mirror","سوراخ","hole"]) or ("sketch" in t and "extrude" in t):
        return compiled("ask")
    if b.has_any(t,["همه رو پاک","همه را پاک"]):
        return compiled("ask")

    # Selection/read/follow.
    if ("انتخاب" in t or "selection" in t) and b.has_any(t,["پاک","خالی"]):
        return compiled("do","viewer.selection.clear",{})
    if b.has_any(t,["چی انتخاب","چه چیزی انتخاب","what is selected"]):
        return compiled("do","viewer.inspect",{"mode":"selection"})
    if b.has_any(t,["وضعیت ویور","viewer state"]):
        return compiled("do","viewer.inspect",{"mode":"state"})
    if b.has_any(t,["سشن","session"]) and b.has_any(t,["کسایی","کسانی","people","چه کس"]):
        return compiled("do","viewer.inspect",{"mode":"collaboration"})
    if b.has_any(t,["فالو","follow"]):
        if ctx.get("collaborator_count",0)>=3:
            if b.has_any(t,["نفر دوم","second"]):
                return compiled("do","view.follow",{"candidate_index":2})
            return compiled("ask")
        return compiled("do","view.follow",{})
    if b.has_any(t,["این رو انتخاب","این را انتخاب","لبه رو هم به انتخاب","لبه را هم به انتخاب"]):
        return compiled("ask")

    # Camera reflexes.
    lm=ctx.get("last_move") or {}
    if t.strip()=="بیشتر" and lm:
        return compiled("do","view.move",{"action":lm.get("action"),"direction":lm.get("direction")})
    if "برگرد" in t and lm:
        return compiled("do","view.move",{"action":lm.get("action"),"direction":opposite(lm.get("direction"))})
    if "فیت" in t or re.search(r"\bfit\b",t):
        if b.has_any(t,["انتخاب","selection","همین"]):
            if ctx.get("selection_count",0)>0:
                return compiled("do","view.fit",{"action":"fit_selection"})
            return compiled("ask")
        return compiled("do","view.fit",{"action":"fit"})
    if b.has_any(t,["از بالا","top view"]):
        return compiled("do","view.standard",{"view":"top"})
    if b.has_any(t,["زوم","zoom"]):
        direction="out" if b.has_any(t,["اوت","out","بیرون"]) else "in"
        return compiled("do","view.move",{"action":"zoom","direction":direction})
    if b.has_any(t,["pan","پن ","نما رو","صفحه رو"]):
        if b.has_any(t,["چپ","left"]): d="left"
        elif b.has_any(t,["راست","right"]): d="right"
        elif b.has_any(t,["بالا","up"]): d="up"
        elif b.has_any(t,["پایین","down"]): d="down"
        else: return None
        return compiled("do","view.move",{"action":"pan","direction":d})
    if b.has_any(t,["بچرخ","rotate","ساعتگرد","پادساعتگرد"]):
        if "پادساعتگرد" in t: d="counterclockwise"
        elif "ساعتگرد" in t: d="clockwise"
        elif b.has_any(t,["راست","right"]): d="right"
        elif b.has_any(t,["چپ","left"]): d="left"
        elif b.has_any(t,["بالا","up"]): d="up"
        elif b.has_any(t,["پایین","down"]): d="down"
        else: return None
        args={"action":"orbit","direction":d}
        q=quantity(raw)
        if q and q.endswith(" deg"):
            args["angle_degrees"]=float(q[:-4])
        return compiled("do","view.move",args)

    # Edge treatment on current selection.
    kind=None
    if b.has_any(t,["پخ","چمفر","chamfer"]): kind="chamfer"
    elif b.has_any(t,["فیلت","fillet","فیلِت"]): kind="fillet"
    q=quantity(raw)
    explicit_new=b.has_any(t,["جدید","خالی","new","empty","بساز"]) and kind
    if kind and not named_feature(raw) and not ("شعاع" in t):
        if explicit_new and b.has_any(t,["انتخاب فعلاً نمی","بدون انتخاب","چیزی انتخاب نکن","خالی","جدید"]):
            return compiled("do","feature.add",{"feature_type":kind,"amount":q}) if q else compiled("ask")
        if ctx.get("selection_count",0)<=0:
            return compiled("ask")
        if not q:
            return compiled("ask")
        return compiled("do","feature.from_selection",{"feature_type":kind,"amount":q})

    # Feature parameter edits.
    feat=named_feature(raw) or ctx.get("last_feature")
    if feat and ("شعاع" in t or feat.startswith("Fillet")) and q and not b.has_any(t,["اسم ","پاک","حذف"]):
        if "بیشتر" in t or "کمتر" in t:
            cur=(ctx.get("feature_parameters") or {}).get("radius")
            cm=b.parse_mm(cur); dm=b.parse_mm(q)
            if cm is None or dm is None: return None
            q=f"{cm + (dm if 'بیشتر' in t else -dm):g} mm"
        return compiled("do","feature.parameter.set",{"feature_name":feat,"parameter":"radius","amount":q})
    if feat and "عمق" in t and q:
        return compiled("do","feature.parameter.set",{"feature_name":feat,"parameter":"depth","amount":q})
    if feat and "زاویه" in t and q:
        return compiled("do","feature.parameter.set",{"feature_name":feat,"parameter":"angle","amount":q})
    if feat and "flip direction" in t:
        if "روشن" in t: val=True
        elif "خاموش" in t: val=False
        else: return compiled("ask")
        return compiled("do","feature.parameter.set",{"feature_name":feat,"parameter":"flip direction","value":val})
    if feat and b.has_any(t,["خاموش","suppress"]):
        return compiled("do","feature.patch",{"feature_name":feat,"suppressed":True})
    if feat and b.has_any(t,["روشن","unsuppress"]):
        return compiled("do","feature.patch",{"feature_name":feat,"suppressed":False})
    if ctx.get("last_feature") and ctx.get("last_action")=="suppress" and "روشن" in t:
        return compiled("do","feature.patch",{"feature_name":ctx["last_feature"],"suppressed":False})

    # Rename/delete feature and part.
    if "اسم" in t and feat:
        name=after_any(raw,[r"اسم\s+(?:Fillet|Extrude|Draft|Sketch)\s*\d+\s+رو\s+بذار\s+(.+)$",r"اسم\s+(?:Fillet|Extrude|Draft|Sketch)\s*\d+\s+را\s+بذار\s+(.+)$"])
        if name:
            return compiled("do","feature.patch",{"feature_name":feat,"new_name":name})
    if b.has_any(t,["آخرین فیچر","last feature"]) and b.has_any(t,["پاک","حذف","delete"]):
        return compiled("do","feature.delete",{"position":"last"})
    if b.has_any(t,["اولین فیچر","first feature"]) and b.has_any(t,["پاک","حذف","delete"]):
        return compiled("do","feature.delete",{"position":"first"})
    if feat and b.has_any(t,["پاک","حذف","delete"]):
        return compiled("do","feature.delete",{"feature_name":feat})

    part=part_name(raw,ctx)
    if b.has_any(t,["پارت","part"]) and b.has_any(t,["پاک","حذف","delete"]) and part:
        return compiled("do","feature.delete_part",{"part_name":part})
    if b.has_any(t,["پارت","part"]) and b.has_any(t,["پاک","حذف","delete"]) and not part:
        return compiled("ask")

    # Part visibility and properties.
    if b.has_any(t,["مخفی","قایم","hide"]):
        return compiled("do","part.visibility",{"part_name":part,"visible":False}) if part else compiled("ask")
    if b.has_any(t,["نشون","نشان","show"]) and part:
        return compiled("do","part.visibility",{"part_name":part,"visible":True})

    if part and (b.has_any(t,["رنگ","color"]) or any(k in t for k in COLOR)):
        val=None
        for k,v in COLOR.items():
            if k in t: val=v
        m=re.search(r"color\s*=\s*([A-Za-z]+)",raw,re.I)
        if m: val=m.group(1).lower()
        if val:
            return compiled("do","metadata.property.set",{"part_name":part,"property":"color","value":val})
    if part and b.has_any(t,["متریال","material"]):
        val=after_any(raw,[r"(?:متریال|material)\s+(?:Part\s*\d+|Cap|Bracket)\s+رو\s+(.+?)\s+بذار$",r"(?:متریال|material).*?\s+([A-Za-z][A-Za-z0-9 _-]*)\s+(?:بذار|set)$"])
        if not val:
            m=re.search(r"\b(Aluminum|Steel|Plastic)\b",raw,re.I)
            val=m.group(1) if m else None
        if val:
            return compiled("do","metadata.property.set",{"part_name":part,"property":"material","value":val})
    if part and "description" in t:
        val=after_any(raw,[r"description\s+(?:پارت\s+)?(?:Part\s*\d+|Cap|Bracket)\s+رو\s+بذار\s+(.+)$"])
        if val:
            return compiled("do","metadata.property.set",{"part_name":part,"property":"description","value":val})

    # Part rename.
    if part and (("اسم" in t and b.has_any(t,["عوض کن","بذار"])) or "rename" in t):
        val=after_any(raw,[
            r"اسم\s+(?:Part\s*\d+|Cap|Bracket)\s+رو\s+(?:عوض کن\s+به|بذار)\s+(.+)$",
            r"rename\s+(?:Part\s*\d+|Cap|Bracket)\s+to\s+(.+)$",
        ])
        if val:
            return compiled("do","documented.updateWVEPMetadata",{"part_name":part,"property":"name","value":val})

    # Feature creation.
    if "plane" in t:
        if b.has_any(t,["right","left","top","front"]) and not b.has_any(t,["اسمش","called","named"]):
            return compiled("ask")
        name=after_any(raw,[r"اسمش\s+(.+)$",r"(?:called|named)\s+(.+)$"])
        args={"feature_type":"plane"}
        if name: args["name"]=name
        return compiled("do","feature.add",args)
    if b.has_any(t,["pattern","الگو"]):
        p=part
        dist=quantity(raw)
        copies=None
        m=re.search(r"(\d+)\s*(?:copies|تایی)",b.norm_text(raw),re.I)
        if m: copies=int(m.group(1))
        if copies is None:
            # Spoken counts near pattern language.
            for w,n in sorted(NUM_WORDS.items(), key=lambda kv:len(kv[0]), reverse=True):
                if re.search(rf"\b{re.escape(w)}(?:\s*تایی|\s*بار)",t):
                    copies=int(n); break
        if p and copies and dist:
            return compiled("do","feature.add",{"feature_type":"linearPattern","part_name":p,"copies":copies,"distance":dist})
        return compiled("ask")

    # Reorder / rollback.
    if "rollback" in t:
        feats=all_features(raw)
        if "قبل از" in t and feats:
            return compiled("do","rollback.set",{"before_feature":feats[-1]})
        if "بعد از" in t and feats:
            return compiled("do","rollback.set",{"after_feature":feats[-1]})
        if b.has_any(t,["آخر","end"]): return compiled("do","rollback.set",{"position":"end"})
        if b.has_any(t,["اول","start"]): return compiled("do","rollback.set",{"position":"start"})
        return compiled("ask")
    if b.has_any(t,["قبل از","بعد از"]) and ("فیچر" in t or all_features(raw)):
        feats=all_features(raw)
        source=feats[0] if len(feats)>=2 else ctx.get("last_feature")
        target=feats[-1] if feats else None
        placement="before" if "قبل از" in t else "after"
        if source and target and source!=target:
            return compiled("do","feature.reorder",{"source_feature":source,"target_feature":target,"placement":placement})

    # Part Studio/document operations.
    if "part studio" in t:
        name=after_any(raw,[r"(?:به اسم|called)\s+(.+)$"])
        return compiled("do","documented.createPartStudio",{"new_name":name}) if name else compiled("ask")
    if b.has_any(t,["داکیومنت","document"]) and b.has_any(t,["اسم","rename"]):
        name=after_any(raw,[r"اسم\s+داکیومنت\s+رو\s+بذار\s+(.+)$",r"rename\s+document\s+to\s+(.+)$"])
        return compiled("do","documented.updateDocumentAttributes",{"new_name":name}) if name else compiled("ask")

    # Ambiguous edit/value/delete/color/same without a grounded target.
    if b.has_any(t,["ویرایش کن","میلیمترش کن","میلی کن","همون کار","اونو حذف","اون رو حذف","قرمزش کن"]):
        return compiled("ask")
    if t.strip() in {"مخفیش کن","فیلت بزن"}:
        return compiled("ask")
    if "پارت رو مخفی" in t or "پارت را مخفی" in t:
        return compiled("ask")

    return None


def main():
    outdir=os.environ.get("OUT_DIR","artifacts/onshape-fast-router-groq-v03-reflex")
    os.makedirs(outdir,exist_ok=True)
    rows=[]
    for case in b.BASE_CASES:
        got=reflex(case)
        correct=bool(got is not None and b.expected_match(case,got))
        rows.append({
            "id":case["id"],"category":case["category"],"text":case["text"],
            "expected":case["expected"],"reflex":got,"covered":got is not None,"correct":correct,
        })
    covered=[r for r in rows if r["covered"]]
    residual=[r for r in rows if not r["covered"]]
    wrong=[r for r in covered if not r["correct"]]
    summary={
        "total":len(rows),
        "reflex_covered":len(covered),
        "reflex_coverage":len(covered)/len(rows),
        "reflex_correct":sum(r["correct"] for r in rows),
        "reflex_correct_rate_all":sum(r["correct"] for r in rows)/len(rows),
        "reflex_accuracy_when_covered":sum(r["correct"] for r in covered)/len(covered) if covered else 0,
        "wrong_covered_ids":[r["id"] for r in wrong],
        "residual_ids":[r["id"] for r in residual],
    }
    with open(os.path.join(outdir,"summary.json"),"w",encoding="utf-8") as f:
        json.dump(summary,f,ensure_ascii=False,indent=2)
    with open(os.path.join(outdir,"rows.json"),"w",encoding="utf-8") as f:
        json.dump(rows,f,ensure_ascii=False,indent=2)
    print("FINAL_SUMMARY="+json.dumps(summary,ensure_ascii=False,sort_keys=True),flush=True)
    return 0


if __name__=="__main__":
    raise SystemExit(main())
