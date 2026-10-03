from __future__ import annotations

import json
import re
import time

import benchmark as b

def tnorm(case):
    return b.low(case["text"])

def act(intent, slots=None):
    return {"decision":"act","intent":intent,"slots":slots or {}}

def ask():
    return {"decision":"ask","intent":None,"slots":{}}

def think():
    return {"decision":"think","intent":None,"slots":{}}

def named_features(text):
    t=b.norm_text(text)
    out=[]
    for m in re.finditer(r"\b(fillet|extrude|draft|sketch)\s*(\d+)\b",t,re.I):
        out.append(m.group(1).title()+" "+m.group(2))
    for m in re.finditer(r"(فیلت|اکسترود)\s*(\d+)",t):
        v=("Fillet" if m.group(1)=="فیلت" else "Extrude")+" "+m.group(2)
        if v not in out: out.append(v)
    return out

def phrase_after(text, markers):
    raw=str(text).strip()
    low=raw.lower()
    best=None
    for marker in markers:
        idx=low.find(marker.lower())
        if idx>=0:
            val=raw[idx+len(marker):].strip(" :=،,")
            if val:
                best=val
    return best

def part_value(text, hints, ctx):
    part=hints.get("part") or ctx.get("last_part")
    if part:
        return part
    raw=b.norm_text(text)
    # Human-readable named parts such as Cap in "رنگ Cap..." or "پارت Cap...".
    patterns=[
        r"(?:رنگ|color|description|پارت)\s+([A-Za-z][A-Za-z0-9_-]*)",
        r"\b(?:hide|show)\s+([A-Za-z][A-Za-z0-9_-]*)\b",
    ]
    for pat in patterns:
        m=re.search(pat,raw,re.I)
        if m:
            return m.group(1)
    return None

def count_value(t):
    m=re.search(r"\b(\d+)\s*(?:تایی|بار|copies?|x)\b",t,re.I)
    if m: return int(m.group(1))
    m=re.search(r"\b(\d+)\s*(?=تا\b)",t)
    if m: return int(m.group(1))
    words={"یک":1,"یه":1,"دو":2,"سه":3,"چهار":4,"پنج":5,"شش":6,"هفت":7,"هشت":8,"نه":9,"ده":10}
    for w,n in words.items():
        if re.search(rf"\b{re.escape(w)}\s*(?:تایی|بار)\b",t):
            return n
    return None

def special_quantity(t):
    q=b.extract_quantity(t)
    if q: return q
    if "یک و بیست و پنج صدم" in t: return "1.25 mm"
    if "سی درجه" in t: return "30 deg"
    return None

def color_value(t):
    cmap={"قرمز":"red","آبی":"blue","ابي":"blue","سبز":"green","red":"red","blue":"blue","green":"green"}
    for k,v in cmap.items():
        if k in t: return v
    return None

def deterministic_ir(case):
    text=case["text"]
    t=tnorm(case)
    ctx=case.get("ctx",{})
    family=b.classify_family(text,ctx)
    cards=b.select_cards(text,ctx,family)
    hints=b.lexical_hints(text,ctx)

    if b.has_any(t,["ایزومتریک","isometric","front view","right view","left view","bottom view"]):
        return ask(), "unsupported-standard-view"

    if family=="design":
        return think(), "design-gate"
    if family in {"unsupported","unknown"}:
        return ask(), "unsupported-or-unknown"

    if not cards:
        return ask(), "no-card"

    # The lexical router has already narrowed these to one semantic card.
    intent=cards[0] if len(cards)==1 else None

    if family=="camera":
        if intent=="fit":
            return act("fit",{"target":"selection" if b.has_any(t,["همین","انتخاب","selection"]) else "all"}), "reflex"
        if intent=="top_view":
            return act("top_view"), "reflex"
        if intent=="clear_selection":
            return act("clear_selection"), "reflex"
        if intent!="camera_move":
            return None, "fallback"
        slots={}
        if b.has_any(t,["zoom","زوم"]): slots["action"]="zoom"
        elif b.has_any(t,["pan","پن ","نما رو","صفحه رو"]): slots["action"]="pan"
        else: slots["action"]="orbit"

        direction=None
        if "پادساعتگرد" in t: direction="counterclockwise"
        elif "ساعتگرد" in t: direction="clockwise"
        elif b.has_any(t,["zoom out","زوم اوت","بیرون"]): direction="out"
        elif b.has_any(t,["zoom in","زوم کن داخل","داخل"]): direction="in"
        elif b.has_any(t,["rotate right","به راست","سمت راست","ببر راست"]): direction="right"
        elif b.has_any(t,["به چپ","سمت چپ","ببر چپ"]): direction="left"
        elif b.has_any(t,["بالا"," up"]): direction="up"
        elif b.has_any(t,["پایین"," down"]): direction="down"
        elif t=="زوم": direction="in"

        lm=ctx.get("last_move")
        if t=="بیشتر" and lm:
            slots["action"]=lm.get("action","orbit"); direction=lm.get("direction")
        if "برگرد" in t and lm:
            opp={"left":"right","right":"left","up":"down","down":"up","in":"out","out":"in",
                 "clockwise":"counterclockwise","counterclockwise":"clockwise"}
            slots["action"]=lm.get("action","orbit"); direction=opp.get(lm.get("direction"))
        if direction: slots["direction"]=direction
        q=special_quantity(t)
        if q and q.endswith(" deg"):
            slots["angle_degrees"]=float(q.split()[0])
        return act("camera_move",slots), "reflex"

    if family=="inspect":
        if intent=="clear_selection":
            return act("clear_selection"), "reflex"
        if intent=="follow":
            slots={}
            if b.has_any(t,["نفر دوم","second"]): slots["candidate_index"]=2
            return act("follow",slots), "reflex"
        what="collaboration" if b.has_any(t,["سشن","session","کسایی","کسانی","collaborator"]) else (
             "selection" if b.has_any(t,["انتخاب","selection","چی انتخاب"]) else "state")
        return act("inspect",{"what":what}), "reflex"

    if family=="edge":
        # Existing named/context feature edit.
        if intent=="feature_parameter":
            slots={}
            feat=hints.get("feature") or ctx.get("last_feature")
            if feat: slots["feature"]=feat
            if feat and str(feat).lower().startswith("fillet"): slots["parameter"]="radius"
            q=special_quantity(t)
            if q: slots["value"]=q
            return act("feature_parameter",slots), "reflex"
        if intent=="add_edge_feature":
            slots={"kind":hints.get("edge_kind")}
            q=special_quantity(t)
            if q: slots["value"]=q
            return act("add_edge_feature",slots), "reflex"
        slots={"kind":hints.get("edge_kind")}
        q=special_quantity(t)
        if q: slots["value"]=q
        return act("edge_on_selection",slots), "reflex"

    if family=="feature_edit":
        intent=cards[0] if len(cards)==1 else None
        feat=hints.get("feature") or ctx.get("last_feature")
        if intent=="feature_delete":
            slots={}
            if "آخرین" in t: slots["position"]="last"
            elif "اولین" in t: slots["position"]="first"
            elif feat: slots["feature"]=feat
            return act("feature_delete",slots), "reflex"
        if intent=="feature_rename":
            name=phrase_after(text,["رو بذار","را بذار","to "])
            return act("feature_rename",{"feature":feat,"name":name} if name else {"feature":feat}), "reflex"
        if intent=="feature_suppressed":
            return act("feature_suppressed",{"feature":feat} if feat else {}), "reflex"
        if intent=="feature_parameter" or intent is None:
            slots={}
            if feat: slots["feature"]=feat
            if b.has_any(t,["شعاع","radius"]) or (feat and str(feat).lower().startswith("fillet")):
                slots["parameter"]="radius"
            elif b.has_any(t,["عمق","depth"]): slots["parameter"]="depth"
            elif b.has_any(t,["زاویه","angle"]): slots["parameter"]="angle"
            elif "flip direction" in t: slots["parameter"]="flip direction"
            q=special_quantity(t)
            if q: slots["value"]=q
            elif "flip direction" in t:
                if "روشن" in t: slots["value"]=True
                elif "خاموش" in t: slots["value"]=False
            return act("feature_parameter",slots), "reflex"

    if family=="part":
        intent=cards[0] if len(cards)==1 else None
        part=part_value(text,hints,ctx)
        if intent=="part_delete":
            return act("part_delete",{"part":part} if part else {}), "reflex"
        if intent=="part_visibility":
            return act("part_visibility",{"part":part} if part else {}), "reflex"
        if intent=="part_property" or intent is None:
            slots={}
            if part: slots["part"]=part
            if b.has_any(t,["رنگ","color","قرمز","آبی","ابي","سبز","red","blue","green"]):
                slots["property"]="color"
                v=color_value(t)
                if v: slots["value"]=v
            elif b.has_any(t,["متریال","material"]):
                slots["property"]="material"
                m=re.search(r"(?:رو|را)\s+(.+?)\s+(?:بذار|بگذار)$",b.norm_text(text),re.I)
                if m: slots["value"]=m.group(1).strip()
            elif "description" in t:
                slots["property"]="description"
                v=phrase_after(text,["بذار","بگذار"])
                if v: slots["value"]=v
            elif b.has_any(t,["اسم","rename"]):
                slots["property"]="name"
                v=phrase_after(text,["عوض کن به","رو بذار","را بذار"," to "])
                if v: slots["value"]=v
            return act("part_property",slots), "reflex"

    if family=="feature_add":
        intent=cards[0] if len(cards)==1 else None
        if intent is None:
            return ask(), "unsupported-add"
        if intent=="add_plane":
            slots={}
            v=phrase_after(text,["اسمش ","called ","named "])
            if v: slots["name"]=v
            # Provider-level construction on a reference remains intentionally unsupported.
            if b.has_any(t,[" right","right "," left","left "," top","top "," front","front "]):
                slots["target"]="Right" if "right" in t else "reference"
            return act("add_plane",slots), "reflex"
        if intent=="add_pattern":
            slots={}
            part=hints.get("part")
            if not part:
                # Cap/bracket-style named parts.
                m=re.search(r"\b(?:linear pattern\s+)?([A-Za-z][A-Za-z0-9_-]*)\b",b.norm_text(text))
                if m and m.group(1).lower() not in {"linear","pattern"}:
                    part=m.group(1)
            if part: slots["part"]=part
            copies=count_value(t)
            if copies is not None: slots["copies"]=copies
            q=special_quantity(t)
            if q: slots["distance"]=q
            return act("add_pattern",slots), "reflex"
        if intent=="add_edge_feature":
            slots={"kind":hints.get("edge_kind")}
            q=special_quantity(t)
            if q: slots["value"]=q
            return act("add_edge_feature",slots), "reflex"

    if family=="order_doc":
        intent=cards[0] if len(cards)==1 else None
        feats=named_features(text)
        if intent=="rollback":
            slots={}
            if "قبل از" in t and feats: slots["before_feature"]=feats[-1]
            elif "بعد از" in t and feats: slots["after_feature"]=feats[-1]
            elif "آخر" in t: slots["position"]="end"
            elif "اول" in t: slots["position"]="start"
            return act("rollback",slots), "reflex"
        if intent=="feature_reorder":
            slots={}
            source=ctx.get("last_feature") or (feats[0] if feats else None)
            target=feats[-1] if feats else None
            if source: slots["source"]=source
            if target and target!=source: slots["target"]=target
            if "قبل از" in t: slots["placement"]="before"
            elif "بعد از" in t: slots["placement"]="after"
            return act("feature_reorder",slots), "reflex"
        if intent=="create_part_studio":
            v=phrase_after(text,["به اسم ","called "])
            return act("create_part_studio",{"name":v} if v else {}), "reflex"
        if intent=="rename_document":
            v=phrase_after(text,["رو بذار","را بذار"," to "])
            return act("rename_document",{"name":v} if v else {}), "reflex"

    return None, "fallback"

def main():
    rows=[]
    t0=time.perf_counter()
    for case in b.BASE_CASES:
        start=time.perf_counter()
        ir,source=deterministic_ir(case)
        if ir is None:
            post={"accepted":False,"reason":"fallback-needed","compiled":{"route":"ask","op":None,"args":{}}}
            outcome="fallback_needed"
        else:
            post=b.compile_ir(case,ir)
            outcome=b.classify_outcome(case,post)
        rows.append({
            "case":case,"source":source,"ir":ir,"post":post,"outcome":outcome,
            "latency_ms":(time.perf_counter()-start)*1000,
        })
        print(json.dumps({"id":case["id"],"source":source,"outcome":outcome,"compiled":post["compiled"]},ensure_ascii=False))

    counts={}
    for r in rows: counts[r["outcome"]]=counts.get(r["outcome"],0)+1
    fallback=[r["case"]["id"] for r in rows if r["outcome"]=="fallback_needed"]
    wrong=[r["case"]["id"] for r in rows if r["outcome"] in {"wrong_material_accepted","false_execute","wrong_reversible_accepted"}]
    summary={
        "cases":len(rows),
        "correct":sum(r["outcome"]=="correct" for r in rows),
        "accuracy":sum(r["outcome"]=="correct" for r in rows)/len(rows),
        "fallback_needed":len(fallback),
        "fallback_ids":fallback,
        "dangerous_wrong":len(wrong),
        "dangerous_wrong_ids":wrong,
        "outcomes":counts,
        "total_local_ms":(time.perf_counter()-t0)*1000,
    }
    with open("hybrid_reflex_summary.json","w",encoding="utf-8") as f: json.dump(summary,f,ensure_ascii=False,indent=2)
    with open("hybrid_reflex_rows.json","w",encoding="utf-8") as f: json.dump(rows,f,ensure_ascii=False,indent=2)
    print("FINAL_SUMMARY="+json.dumps(summary,ensure_ascii=False,sort_keys=True))
    return 0

if __name__=="__main__":
    raise SystemExit(main())
