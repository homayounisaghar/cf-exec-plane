from __future__ import annotations

import json
import os
import re
import statistics
import time
import urllib.error
import urllib.request

import benchmark as b

MODEL = b.MODEL
ENDPOINT = b.ENDPOINT
BATCH_SIZE = int(os.environ.get("BATCH_SIZE", "8"))
MAX_BATCH_RETRIES = int(os.environ.get("MAX_BATCH_RETRIES", "12"))

SHORT = {
    "camera_move":"orbit/pan/zoom camera; slots action,direction, optional angle_degrees",
    "fit":"fit view; slot target=all|selection",
    "top_view":"top view",
    "clear_selection":"clear selection",
    "inspect":"read viewer; slot what=selection|state|collaboration",
    "follow":"follow collaborator; optional candidate_index",
    "edge_on_selection":"fillet/chamfer CURRENT selection; slots kind,amount",
    "feature_parameter":"edit EXISTING feature parameter; slots feature,parameter,value",
    "feature_suppressed":"suppress/unsuppress feature; slots feature,suppressed",
    "feature_rename":"rename feature; slots feature,name",
    "feature_delete":"delete feature; slots feature OR position",
    "part_delete":"delete part; slot part",
    "part_visibility":"hide/show part; slots part,visible",
    "part_property":"part property; slots part,property,value",
    "add_plane":"create plane; optional name",
    "add_pattern":"linear pattern; slots part,copies,distance",
    "add_edge_feature":"create NEW empty fillet/chamfer; slots kind,amount",
    "feature_reorder":"reorder feature; slots source,target,placement",
    "rollback":"rollback; one of before_feature,after_feature,position",
    "create_part_studio":"new Part Studio; slot name",
    "rename_document":"rename document; slot name",
}

WORD_NUM = {
    "یک":1,"یه":1,"يه":1,"دو":2,"سه":3,"چهار":4,"پنج":5,"شش":6,
    "هفت":7,"هشت":8,"نه":9,"ده":10,"سی":30,
}

def named_features(text):
    t=b.norm_text(text)
    out=[]
    for m in re.finditer(r"\b(Fillet|Extrude|Draft|Sketch)\s*(\d+)\b",t,re.I):
        out.append(m.group(1).title()+" "+m.group(2))
    for m in re.finditer(r"(فیلت|اکسترود)\s*(\d+)",t):
        out.append(("Fillet" if m.group(1)=="فیلت" else "Extrude")+" "+m.group(2))
    return list(dict.fromkeys(out))

def word_or_digit_before(text, markers):
    t=b.norm_text(text).lower()
    for mk in markers:
        m=re.search(rf"(\d+)\s*{re.escape(mk)}",t)
        if m:
            return int(m.group(1))
        for w,n in WORD_NUM.items():
            if re.search(rf"\b{re.escape(w)}\s*{re.escape(mk)}",t):
                return n
    return None

def extract_after(text, patterns):
    s=b.norm_text(text)
    for pat in patterns:
        m=re.search(pat,s,re.I)
        if m:
            v=m.group(1).strip(" ،,.;")
            if v:
                return v
    return None

def part_hint(text, ctx):
    h=b.lexical_hints(text,ctx)
    if h.get("part"):
        return h["part"]
    if ctx.get("last_part"):
        return ctx["last_part"]
    s=b.norm_text(text)
    pats=[
        r"(?:رنگ|color)\s+([A-Za-z][A-Za-z0-9_.-]*)\b",
        r"(?:پارت|part)\s+([A-Za-z][A-Za-z0-9_.-]*)\b",
        r"linear\s+pattern\s+([A-Za-z][A-Za-z0-9_.-]*)\b",
        r"description\s+(?:پارت\s+)?([A-Za-z][A-Za-z0-9_.-]*)\b",
    ]
    for p in pats:
        m=re.search(p,s,re.I)
        if m and m.group(1).lower() not in {"color","part","pattern"}:
            return m.group(1)
    return None

def reflex_ir(case):
    text=case["text"]
    ctx=case.get("ctx",{})
    t=b.low(text)
    family=b.classify_family(text,ctx)
    cards=b.select_cards(text,ctx,family)
    hints=b.lexical_hints(text,ctx)

    # Deterministic non-execution lanes.
    if b.has_any(t,["ایزومتریک","isometric"]):
        return {"decision":"ask","intent":None,"slots":{}}
    if family=="design":
        return {"decision":"think","intent":None,"slots":{}}
    if family in {"unsupported","unknown"}:
        return {"decision":"ask","intent":None,"slots":{}}
    if b.has_any(t,["همه رو پاک","همه را پاک","public","شرکت onshape","company","share"]):
        return {"decision":"ask","intent":None,"slots":{}}

    # Known unsupported provider shapes are never delegated to free interpretation.
    if b.has_any(t,["mirror","سوراخ","hole"]):
        return {"decision":"ask","intent":None,"slots":{}}
    if re.search(r"\bextrude\b",t,re.I) and not re.search(r"\bextrude\s*\d+\b",t,re.I):
        return {"decision":"ask","intent":None,"slots":{}}
    if "plane" in t and b.has_any(t,["right","left","top","front"]) and "اسمش" not in t:
        return {"decision":"ask","intent":None,"slots":{}}

    # Strong named-Fillet shorthand is an existing radius edit even when the
    # family card selector leaves multiple feature-edit choices open.
    if family=="feature_edit" and hints.get("feature") and str(hints["feature"]).lower().startswith("fillet") and hints.get("quantity") and not b.has_any(t,["جدید","خالی","بساز","delete","پاک کن","حذف کن","اسم","rename","خاموش","روشن"]):
        return {"decision":"act","intent":"feature_parameter",
                "slots":{"feature":hints["feature"],"parameter":"radius","value":hints["quantity"]}}

    if len(cards)!=1:
        return None
    intent=cards[0]
    slots={}

    if intent=="camera_move":
        if b.has_any(t,["zoom","زوم"]):
            action="zoom"
            direction="out" if b.has_any(t,["out","اوت","بیرون","عقب"]) else "in"
        elif b.has_any(t,["pan","پن ","نما رو","صفحه رو"]):
            action="pan"
            direction=""
        else:
            action="orbit"
            direction=""
        if "camera_direction" in hints:
            direction=hints["camera_direction"]
        elif b.has_any(t,["سمت راست","به راست","rotate right"]): direction="right"
        elif b.has_any(t,["سمت چپ","به چپ"]): direction="left"
        elif "راست" in t: direction="right"
        elif "چپ" in t: direction="left"
        elif b.has_any(t,["بالا"," up"]): direction="up"
        elif b.has_any(t,["پایین"," down"]): direction="down"
        if not direction and ctx.get("last_move"):
            lm=ctx["last_move"]
            if t.strip()=="بیشتر":
                action=lm.get("action",action)
                direction=lm.get("direction","")
            elif "برگرد" in t:
                opp={"left":"right","right":"left","up":"down","down":"up","in":"out","out":"in",
                     "clockwise":"counterclockwise","counterclockwise":"clockwise"}
                action=lm.get("action",action)
                direction=opp.get(lm.get("direction"),"")
        if not direction:
            return None
        slots={"action":action,"direction":direction}
        m=re.search(r"(\d+(?:\.\d+)?)\s*(?:درجه|deg)",b.norm_text(text),re.I)
        if m:
            slots["angle_degrees"]=float(m.group(1))
        elif "سی درجه" in t:
            slots["angle_degrees"]=30
        return {"decision":"act","intent":intent,"slots":slots}

    if intent=="fit":
        slots["target"]="selection" if b.has_any(t,["همین انتخاب","selection"]) else "all"
        return {"decision":"act","intent":intent,"slots":slots}
    if intent in {"top_view","clear_selection"}:
        return {"decision":"act","intent":intent,"slots":{}}

    if intent=="inspect":
        if b.has_any(t,["سشن","session","کسایی","کسانی"]): slots["what"]="collaboration"
        elif b.has_any(t,["انتخاب","selection","چی انتخاب"]): slots["what"]="selection"
        else: slots["what"]="state"
        return {"decision":"act","intent":intent,"slots":slots}

    if intent=="follow":
        if ctx.get("collaborator_count",0)>=3:
            if b.has_any(t,["نفر دوم","second"]):
                slots["candidate_index"]=2
            else:
                return {"decision":"ask","intent":None,"slots":{}}
        return {"decision":"act","intent":intent,"slots":slots}

    if intent=="edge_on_selection":
        if ctx.get("selection_count",0)<=0:
            return {"decision":"ask","intent":None,"slots":{}}
        if not hints.get("edge_kind"):
            return None
        if not hints.get("quantity"):
            # Complex spoken decimal is a language task; ordinary missing amount is clarification.
            if "صدم" in t:
                return None
            return {"decision":"ask","intent":None,"slots":{}}
        return {"decision":"act","intent":intent,
                "slots":{"kind":hints["edge_kind"],"amount":hints["quantity"]}}

    if intent=="feature_parameter":
        feat=hints.get("feature") or ctx.get("last_feature")
        if not feat:
            return {"decision":"ask","intent":None,"slots":{}}
        if b.has_any(t,["شعاع","radius"]) or str(feat).lower().startswith("fillet"):
            param="radius"
        elif b.has_any(t,["عمق","depth"]):
            param="depth"
        elif b.has_any(t,["زاویه","angle"]):
            param="angle"
        elif "flip direction" in t:
            param="flip direction"
        else:
            return {"decision":"ask","intent":None,"slots":{}}
        slots={"feature":feat,"parameter":param}
        if param=="flip direction":
            if b.has_any(t,["روشن"," on","true"]): slots["value"]=True
            elif b.has_any(t,["خاموش"," off","false"]): slots["value"]=False
            else: return {"decision":"ask","intent":None,"slots":{}}
        elif hints.get("quantity"):
            slots["value"]=hints["quantity"]
        else:
            return None
        return {"decision":"act","intent":intent,"slots":slots}

    if intent=="feature_suppressed":
        feat=hints.get("feature") or ctx.get("last_feature")
        if not feat or hints.get("suppressed") is None:
            return {"decision":"ask","intent":None,"slots":{}}
        return {"decision":"act","intent":intent,
                "slots":{"feature":feat,"suppressed":hints["suppressed"]}}

    if intent=="feature_rename":
        feat=hints.get("feature") or ctx.get("last_feature")
        name=extract_after(text,[r"(?:بذار|بگذار)\s+(.+)$",r"\bto\s+(.+)$"])
        if not feat or not name:
            return None
        return {"decision":"act","intent":intent,"slots":{"feature":feat,"name":name}}

    if intent=="feature_delete":
        if "آخرین" in t:
            slots["position"]="last"
        elif "اولین" in t:
            slots["position"]="first"
        else:
            feat=hints.get("feature") or ctx.get("last_feature")
            if not feat:
                return {"decision":"ask","intent":None,"slots":{}}
            slots["feature"]=feat
        return {"decision":"act","intent":intent,"slots":slots}

    if intent=="part_delete":
        part=part_hint(text,ctx)
        if not part:
            return {"decision":"ask","intent":None,"slots":{}}
        return {"decision":"act","intent":intent,"slots":{"part":part}}

    if intent=="part_visibility":
        part=part_hint(text,ctx)
        vis=hints.get("visibility")
        if not part or vis is None:
            return {"decision":"ask","intent":None,"slots":{}}
        return {"decision":"act","intent":intent,"slots":{"part":part,"visible":vis}}

    if intent=="part_property":
        part=part_hint(text,ctx)
        if not part:
            return {"decision":"ask","intent":None,"slots":{}}
        prop=None
        value=None
        if b.has_any(t,["رنگ","color","قرمز","آبی","ابي","سبز"]):
            prop="color"
            cmap={"قرمز":"red","آبی":"blue","ابي":"blue","سبز":"green"}
            for k,v in cmap.items():
                if k in t:
                    value=v
                    break
            if value is None:
                m=re.search(r"(?:color\s*=\s*|color\s+)(red|blue|green|black|white|yellow)\b",t,re.I)
                if m: value=m.group(1).lower()
        elif b.has_any(t,["متریال","material"]):
            prop="material"
            value=extract_after(text,[r"(?:رو|را)\s+(.+?)\s+(?:بذار|بگذار)$",r"\bmaterial\s+(?:to|=)\s*(.+)$"])
        elif "description" in t:
            prop="description"
            value=extract_after(text,[r"(?:بذار|بگذار)\s+(.+)$",r"description.*?(?:to|=)\s*(.+)$"])
        elif b.has_any(t,["اسم","rename"]):
            prop="name"
            value=extract_after(text,[r"(?:عوض کن به|rename\s+.+?\s+to)\s+(.+)$",r"(?:بذار|بگذار)\s+(.+)$"])
        if not prop or value is None:
            return None
        return {"decision":"act","intent":intent,
                "slots":{"part":part,"property":prop,"value":value}}

    if intent=="add_plane":
        name=extract_after(text,[r"(?:اسمش|called|named)\s+(.+)$"])
        if name:
            slots["name"]=name
        return {"decision":"act","intent":intent,"slots":slots}

    if intent=="add_pattern":
        part=part_hint(text,ctx)
        copies=word_or_digit_before(text,["تایی","تا","بار","copies"])
        dist=hints.get("quantity")
        if not part or copies is None or not dist:
            return {"decision":"ask","intent":None,"slots":{}}
        return {"decision":"act","intent":intent,
                "slots":{"part":part,"copies":copies,"distance":dist}}

    if intent=="add_edge_feature":
        if not hints.get("edge_kind"):
            return None
        if not hints.get("quantity"):
            return {"decision":"ask","intent":None,"slots":{}}
        return {"decision":"act","intent":intent,
                "slots":{"kind":hints["edge_kind"],"amount":hints["quantity"]}}

    if intent=="feature_reorder":
        feats=named_features(text)
        if ctx.get("last_feature") and len(feats)==1:
            source=ctx["last_feature"]; target=feats[0]
        else:
            source=feats[0] if len(feats)>0 else None
            target=feats[1] if len(feats)>1 else None
        placement="before" if "قبل از" in t else ("after" if "بعد از" in t else None)
        if not source or not target or not placement:
            return None
        return {"decision":"act","intent":intent,
                "slots":{"source":source,"target":target,"placement":placement}}

    if intent=="rollback":
        feats=named_features(text)
        if "قبل از" in t and feats: slots["before_feature"]=feats[-1]
        elif "بعد از" in t and feats: slots["after_feature"]=feats[-1]
        elif "آخر" in t: slots["position"]="end"
        elif "اول" in t: slots["position"]="start"
        else: return None
        return {"decision":"act","intent":intent,"slots":slots}

    if intent=="create_part_studio":
        name=extract_after(text,[r"(?:به اسم|called)\s+(.+)$"])
        if not name:
            return None
        return {"decision":"act","intent":intent,"slots":{"name":name}}

    if intent=="rename_document":
        name=extract_after(text,[r"(?:بذار|بگذار)\s+(.+)$",r"\bto\s+(.+)$"])
        if not name:
            return None
        return {"decision":"act","intent":intent,"slots":{"name":name}}

    return None

def compact_item(case):
    family=b.classify_family(case["text"],case.get("ctx",{}))
    cards=b.select_cards(case["text"],case.get("ctx",{}),family)
    return {
        "id":case["id"],
        "cmd":b.norm_text(case["text"]),
        "ctx":case.get("ctx",{}),
        "h":b.lexical_hints(case["text"],case.get("ctx",{})),
        "a":cards,
    }

def parse_retry_after(headers):
    raw=headers.get("retry-after")
    if not raw:
        return None
    try:
        return float(raw)
    except Exception:
        return None

def call_batch(key,cases):
    allowed=[]
    for case in cases:
        fam=b.classify_family(case["text"],case.get("ctx",{}))
        for card in b.select_cards(case["text"],case.get("ctx",{}),fam):
            if card not in allowed:
                allowed.append(card)
    meanings={k:SHORT[k] for k in allowed if k in SHORT}
    system=(
        'Interpret each independent Persian/mixed Onshape command. '
        'For each item choose d="a" act, "q" ask, or "t" think. '
        "If d=\"a\", i MUST be one of that item's allowed codes in a, and s contains only needed slots. "
        'h is authoritative. Missing target/value => q. Open-ended design => t. '
        'Never invent geometry. Return JSON only: {"r":[{"id":"...","d":"a|q|t","i":"code-or-null","s":{}}]}. '
        'Meanings: '+json.dumps(meanings,ensure_ascii=False,separators=(",",":"))
    )
    user={"items":[compact_item(c) for c in cases]}
    body={
        "model":MODEL,
        "messages":[
            {"role":"system","content":system},
            {"role":"user","content":json.dumps(user,ensure_ascii=False,separators=(",",":"))},
        ],
        "reasoning_effort":"low",
        "temperature":0,
        "max_completion_tokens":max(300,80*len(cases)),
        "response_format":{"type":"json_object"},
    }
    payload=json.dumps(body,ensure_ascii=False).encode("utf-8")
    last=None
    for attempt in range(MAX_BATCH_RETRIES):
        req=urllib.request.Request(
            ENDPOINT,data=payload,
            headers={"Authorization":"Bearer "+key,"Content-Type":"application/json",
                     "User-Agent":"cf-exec-plane-onshape-router-hybrid-broad/1.0"},
            method="POST",
        )
        t0=time.perf_counter()
        try:
            with urllib.request.urlopen(req,timeout=90) as resp:
                raw=resp.read().decode("utf-8")
                ms=(time.perf_counter()-t0)*1000
                data=json.loads(raw)
                obj=json.loads(data["choices"][0]["message"]["content"])
                return {
                    "ok":True,"latency_ms":ms,"results":obj.get("r",[]),
                    "usage":data.get("usage",{}),"attempts":attempt+1,
                }
        except urllib.error.HTTPError as e:
            txt=e.read().decode("utf-8","replace")
            last={"ok":False,"status":e.code,"error":f"HTTP {e.code}: {txt[:900]}",
                  "retry_after":parse_retry_after(e.headers),
                  "latency_ms":(time.perf_counter()-t0)*1000}
            retryable=e.code in {400,429,500,502,503,504}
            if not retryable:
                return last
            wait=last["retry_after"] if last["retry_after"] is not None else 15*(attempt+1)
            wait=max(5.0,min(float(wait)+0.5,180.0))
            print(json.dumps({"batch_retry":attempt+1,"status":e.code,"wait_s":round(wait,1),
                              "cases":[c["id"] for c in cases]},ensure_ascii=False),flush=True)
            time.sleep(wait)
        except Exception as e:
            last={"ok":False,"error":repr(e),"latency_ms":(time.perf_counter()-t0)*1000}
            time.sleep(min(15*(attempt+1),60))
    return last or {"ok":False,"error":"batch-failed"}

def ir_from_compact(obj):
    d=obj.get("d")
    if d=="a":
        return {"decision":"act","intent":obj.get("i"),"slots":obj.get("s") or {}}
    if d=="t":
        return {"decision":"think","intent":None,"slots":{}}
    return {"decision":"ask","intent":None,"slots":{}}

def row_from_ir(case,ir,source,latency_ms=0.0,usage=None,batch_attempts=None):
    post=b.compile_ir(case,ir)
    return {
        "case":case,
        "ok":True,
        "source":source,
        "latency_ms":latency_ms,
        "usage":usage or {},
        "batch_attempts":batch_attempts,
        "ir":ir,
        "post":post,
        "outcome":b.classify_outcome(case,post),
    }

def percentile(values,p):
    if not values:
        return None
    s=sorted(values)
    return s[max(0,min(len(s)-1,round((len(s)-1)*p)))]

def main():
    outdir=os.environ.get("OUT_DIR","artifacts/onshape-fast-router-groq-v04-hybrid")
    os.makedirs(outdir,exist_ok=True)
    key=os.environ.get("GROQ_API_KEY","").strip()
    if not key:
        raise SystemExit("GROQ_API_KEY missing")

    started=time.perf_counter()
    rows_by_id={}
    fallback=[]

    for case in b.BASE_CASES:
        t0=time.perf_counter()
        ir=reflex_ir(case)
        if ir is None:
            fallback.append(case)
            continue
        row=row_from_ir(case,ir,"reflex",(time.perf_counter()-t0)*1000)
        rows_by_id[case["id"]]=row

    print(json.dumps({
        "phase":"reflex",
        "total":len(b.BASE_CASES),
        "handled":len(rows_by_id),
        "fallback":len(fallback),
        "fallback_ids":[c["id"] for c in fallback],
    },ensure_ascii=False),flush=True)

    total_prompt=0
    total_completion=0
    batch_calls=0
    batch_retries=0

    for start in range(0,len(fallback),BATCH_SIZE):
        cases=fallback[start:start+BATCH_SIZE]
        res=call_batch(key,cases)
        batch_calls+=1
        if not res.get("ok"):
            for case in cases:
                rows_by_id[case["id"]]={
                    "case":case,"ok":False,"source":"model_batch","latency_ms":res.get("latency_ms",0),
                    "error":res.get("error"),"usage":{},
                    "post":{"accepted":False,"reason":"api-failure",
                            "compiled":{"route":"ask","op":None,"args":{}}},
                    "outcome":"api_failure",
                }
            continue
        batch_retries+=max(0,res.get("attempts",1)-1)
        total_prompt+=(res.get("usage",{}).get("prompt_tokens") or 0)
        total_completion+=(res.get("usage",{}).get("completion_tokens") or 0)
        byid={x.get("id"):x for x in res.get("results",[]) if isinstance(x,dict)}
        for case in cases:
            obj=byid.get(case["id"])
            if not obj:
                rows_by_id[case["id"]]={
                    "case":case,"ok":False,"source":"model_batch","latency_ms":res.get("latency_ms",0),
                    "error":"missing result in batch response","usage":res.get("usage",{}),
                    "post":{"accepted":False,"reason":"api-failure",
                            "compiled":{"route":"ask","op":None,"args":{}}},
                    "outcome":"api_failure",
                }
                continue
            ir=ir_from_compact(obj)
            rows_by_id[case["id"]]=row_from_ir(
                case,ir,"model_batch",res.get("latency_ms",0),
                res.get("usage",{}),res.get("attempts",1)
            )
        print(json.dumps({
            "phase":"batch","batch":batch_calls,"n":len(cases),
            "ids":[c["id"] for c in cases],
            "latency_ms":round(res.get("latency_ms",0),1),
            "attempts":res.get("attempts",1),
        },ensure_ascii=False),flush=True)

    rows=[rows_by_id[c["id"]] for c in b.BASE_CASES]
    wall=time.perf_counter()-started

    outcomes={}
    for r in rows:
        outcomes[r["outcome"]]=outcomes.get(r["outcome"],0)+1
    expected_do=[r for r in rows if "do" in b.expected_route(r["case"])]
    reflex_rows=[r for r in rows if r.get("source")=="reflex"]
    model_rows=[r for r in rows if r.get("source")=="model_batch"]
    model_lats=[r["latency_ms"] for r in model_rows if r.get("ok")]

    summary={
        "architecture":"deterministic reflex -> compact batched 20B fallback -> deterministic compiler/guards",
        "model":MODEL,
        "cases":len(rows),
        "reflex_cases":len(reflex_rows),
        "model_fallback_cases":len(model_rows),
        "model_batch_calls":batch_calls,
        "model_batch_retries":batch_retries,
        "api_success":sum(bool(r.get("ok")) for r in rows),
        "exact_correct":sum(r["outcome"]=="correct" for r in rows),
        "exact_accuracy":sum(r["outcome"]=="correct" for r in rows)/len(rows),
        "reflex_correct":sum(r["outcome"]=="correct" for r in reflex_rows),
        "model_fallback_correct":sum(r["outcome"]=="correct" for r in model_rows),
        "wrong_material_accepted":sum(r["outcome"]=="wrong_material_accepted" for r in rows),
        "wrong_material_ids":[r["case"]["id"] for r in rows if r["outcome"]=="wrong_material_accepted"],
        "false_execute":sum(r["outcome"]=="false_execute" for r in rows),
        "false_execute_ids":[r["case"]["id"] for r in rows if r["outcome"]=="false_execute"],
        "conservative_escalations":sum(r["outcome"]=="conservative_escalation" for r in rows),
        "conservative_ids":[r["case"]["id"] for r in rows if r["outcome"]=="conservative_escalation"],
        "wrong_reversible_accepted":sum(r["outcome"]=="wrong_reversible_accepted" for r in rows),
        "wrong_reversible_ids":[r["case"]["id"] for r in rows if r["outcome"]=="wrong_reversible_accepted"],
        "route_mismatch":sum(r["outcome"]=="route_mismatch" for r in rows),
        "api_failures":sum(r["outcome"]=="api_failure" for r in rows),
        "api_failure_ids":[r["case"]["id"] for r in rows if r["outcome"]=="api_failure"],
        "routine_expected_do":len(expected_do),
        "routine_auto_accepted":sum(r["post"]["accepted"] for r in expected_do),
        "routine_correct":sum(r["outcome"]=="correct" for r in expected_do),
        "provider_prompt_tokens":total_prompt,
        "provider_completion_tokens":total_completion,
        "model_batch_p50_ms":statistics.median(model_lats) if model_lats else None,
        "model_batch_p95_ms":percentile(model_lats,.95),
        "wall_seconds":wall,
        "outcomes":outcomes,
    }

    with open(os.path.join(outdir,"rows.json"),"w",encoding="utf-8") as f:
        json.dump(rows,f,ensure_ascii=False,indent=2)
    with open(os.path.join(outdir,"summary.json"),"w",encoding="utf-8") as f:
        json.dump(summary,f,ensure_ascii=False,indent=2)
    print("FINAL_SUMMARY="+json.dumps(summary,ensure_ascii=False,sort_keys=True),flush=True)
    return 0

if __name__=="__main__":
    raise SystemExit(main())
