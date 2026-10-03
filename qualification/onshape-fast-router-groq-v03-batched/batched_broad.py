from __future__ import annotations

import json
import os
import statistics
import time
import urllib.error
import urllib.request
from collections import defaultdict

import benchmark as b

ENDPOINT=b.ENDPOINT
MODEL=b.MODEL
BATCH_SIZE=int(os.environ.get("BATCH_SIZE","30"))
OUT_DIR=os.environ.get("OUT_DIR","artifacts/onshape-fast-router-groq-v03-batched")
MAX_ATTEMPTS=int(os.environ.get("MAX_ATTEMPTS","8"))

def pct(vals,p):
    if not vals: return None
    s=sorted(vals)
    return s[max(0,min(len(s)-1,round((len(s)-1)*p)))]

def build_batch(cases):
    family=b.classify_family(cases[0]["text"],cases[0].get("ctx",{}))
    cards=b.FAMILY_CARDS.get(family,[])
    card_text="\n".join(f"- {name}: {b.CARDS[name]}" for name in cards)
    if not cards:
        card_text="- no executable capability card applies; choose ask or think."
    system=b.SYSTEM_BASE + f"""
You will receive MULTIPLE independent commands that all belong to the same routed family: {family}.
Return one result for every id, in the same order. Do not let one item influence another.
Output JSON only:
{{"items":[{{"id":"...","decision":"act|ask|think","intent":"card-name-or-null","slots":{{}}}}]}}
Capability cards for THIS batch only:
""" + card_text
    items=[]
    for case in cases:
        items.append({
            "id":case["id"],
            "command":b.norm_text(case["text"]),
            "context":case.get("ctx",{}),
            "lexical_hint":b.lexical_hints(case["text"],case.get("ctx",{})),
        })
    return family,system,items

def call_batch(key,cases):
    family,system,items=build_batch(cases)
    body={
        "model":MODEL,
        "messages":[
            {"role":"system","content":system},
            {"role":"user","content":json.dumps({"items":items},ensure_ascii=False,separators=(",",":"))},
        ],
        "reasoning_effort":"low",
        "temperature":0,
        "max_completion_tokens":1000,
        "response_format":{"type":"json_object"},
    }
    payload=json.dumps(body,ensure_ascii=False).encode("utf-8")
    last=None
    for attempt in range(MAX_ATTEMPTS):
        req=urllib.request.Request(
            ENDPOINT,
            data=payload,
            headers={
                "Authorization":"Bearer "+key,
                "Content-Type":"application/json",
                "User-Agent":"cf-exec-plane-onshape-router-batched/1.0",
            },
            method="POST",
        )
        t0=time.perf_counter()
        try:
            with urllib.request.urlopen(req,timeout=90) as resp:
                data=json.loads(resp.read().decode("utf-8"))
                ms=(time.perf_counter()-t0)*1000
                parsed=json.loads(data["choices"][0]["message"]["content"])
                out=parsed.get("items")
                if not isinstance(out,list):
                    raise ValueError("missing items list")
                by_id={str(x.get("id")):x for x in out if isinstance(x,dict)}
                missing=[x["id"] for x in items if x["id"] not in by_id]
                if missing:
                    raise ValueError("missing ids: "+",".join(missing))
                return {
                    "ok":True,
                    "latency_ms":ms,
                    "items":by_id,
                    "usage":data.get("usage",{}),
                    "family":family,
                    "batch_n":len(cases),
                }
        except urllib.error.HTTPError as e:
            ms=(time.perf_counter()-t0)*1000
            txt=e.read().decode("utf-8","replace")
            last={"ok":False,"status":e.code,"error":f"HTTP {e.code}: {txt[:1500]}","latency_ms":ms}
            retry=e.headers.get("retry-after")
            if e.code==429:
                wait=5.0
                if retry:
                    try: wait=max(wait,float(retry)+1.0)
                    except Exception: pass
                print(json.dumps({"event":"rate_wait","family":family,"attempt":attempt+1,"wait_s":wait,"error":last["error"][:400]}),flush=True)
                time.sleep(wait)
                continue
            if e.code==400 and ("json_validate_failed" in txt or "Failed to generate JSON" in txt):
                time.sleep(1.0+attempt)
                continue
            return last
        except Exception as e:
            last={"ok":False,"error":repr(e),"latency_ms":(time.perf_counter()-t0)*1000}
            time.sleep(1.0+attempt)
    return last or {"ok":False,"error":"exhausted"}

def main():
    os.makedirs(OUT_DIR,exist_ok=True)
    key=os.environ.get("GROQ_API_KEY","").strip()
    if not key: raise SystemExit("GROQ_API_KEY missing")

    grouped=defaultdict(list)
    for case in b.BASE_CASES:
        grouped[b.classify_family(case["text"],case.get("ctx",{}))].append(case)

    batches=[]
    for family in sorted(grouped):
        cases=grouped[family]
        for i in range(0,len(cases),BATCH_SIZE):
            batches.append(cases[i:i+BATCH_SIZE])

    rows=[]
    call_lats=[]
    total_usage={"prompt_tokens":0,"completion_tokens":0}
    for bi,cases in enumerate(batches,1):
        result=call_batch(key,cases)
        print(json.dumps({
            "batch":bi,"batches":len(batches),
            "family":b.classify_family(cases[0]["text"],cases[0].get("ctx",{})),
            "cases":len(cases),"ok":result.get("ok"),
            "latency_ms":round(result.get("latency_ms",0),1),
            "error":result.get("error")
        },ensure_ascii=False),flush=True)

        if result.get("ok"):
            call_lats.append(result["latency_ms"])
            u=result.get("usage",{})
            total_usage["prompt_tokens"]+=u.get("prompt_tokens") or 0
            total_usage["completion_tokens"]+=u.get("completion_tokens") or 0
            for case in cases:
                raw=result["items"][case["id"]]
                ir={"decision":raw.get("decision"),"intent":raw.get("intent"),"slots":raw.get("slots",{})}
                post=b.compile_ir(case,ir)
                outcome=b.classify_outcome(case,post)
                rows.append({
                    "case":case,
                    "ok":True,
                    "batch_latency_ms":result["latency_ms"],
                    "ir":ir,
                    "family":result["family"],
                    "post":post,
                    "outcome":outcome,
                })
        else:
            for case in cases:
                rows.append({
                    "case":case,
                    "ok":False,
                    "error":result.get("error"),
                    "batch_latency_ms":result.get("latency_ms"),
                    "post":{"accepted":False,"reason":"api-failure","compiled":{"route":"ask","op":None,"args":{}}},
                    "outcome":"api_failure",
                })

        with open(os.path.join(OUT_DIR,"rows.json"),"w",encoding="utf-8") as f:
            json.dump(rows,f,ensure_ascii=False,indent=2)

    outcomes={}
    for r in rows: outcomes[r["outcome"]]=outcomes.get(r["outcome"],0)+1
    expected_do=[r for r in rows if "do" in b.expected_route(r["case"])]
    summary={
        "model":MODEL,
        "mode":"family-batched broad coverage",
        "cases":len(rows),
        "batches":len(batches),
        "api_success_cases":sum(r.get("ok",False) for r in rows),
        "exact_correct":sum(r["outcome"]=="correct" for r in rows),
        "exact_accuracy":sum(r["outcome"]=="correct" for r in rows)/len(rows),
        "wrong_material_accepted":sum(r["outcome"]=="wrong_material_accepted" for r in rows),
        "wrong_material_ids":[r["case"]["id"] for r in rows if r["outcome"]=="wrong_material_accepted"],
        "false_execute":sum(r["outcome"]=="false_execute" for r in rows),
        "false_execute_ids":[r["case"]["id"] for r in rows if r["outcome"]=="false_execute"],
        "conservative_escalations":sum(r["outcome"]=="conservative_escalation" for r in rows),
        "conservative_ids":[r["case"]["id"] for r in rows if r["outcome"]=="conservative_escalation"],
        "wrong_reversible_accepted":sum(r["outcome"]=="wrong_reversible_accepted" for r in rows),
        "wrong_reversible_ids":[r["case"]["id"] for r in rows if r["outcome"]=="wrong_reversible_accepted"],
        "route_mismatch":sum(r["outcome"]=="route_mismatch" for r in rows),
        "route_mismatch_ids":[r["case"]["id"] for r in rows if r["outcome"]=="route_mismatch"],
        "routine_expected_do":len(expected_do),
        "routine_auto_accepted":sum(r["post"]["accepted"] for r in expected_do),
        "routine_correct":sum(r["outcome"]=="correct" for r in expected_do),
        "routine_correct_rate":sum(r["outcome"]=="correct" for r in expected_do)/len(expected_do) if expected_do else 0,
        "batch_p50_ms":statistics.median(call_lats) if call_lats else None,
        "batch_p95_ms":pct(call_lats,.95),
        "batch_mean_ms":statistics.mean(call_lats) if call_lats else None,
        "prompt_tokens":total_usage["prompt_tokens"],
        "completion_tokens":total_usage["completion_tokens"],
        "outcomes":outcomes,
        "api_failure_ids":[r["case"]["id"] for r in rows if r["outcome"]=="api_failure"],
    }
    with open(os.path.join(OUT_DIR,"summary.json"),"w",encoding="utf-8") as f:
        json.dump(summary,f,ensure_ascii=False,indent=2)
    print("FINAL_SUMMARY="+json.dumps(summary,ensure_ascii=False,sort_keys=True),flush=True)
    return 0 if summary["api_success_cases"]==len(rows) else 1

if __name__=="__main__":
    raise SystemExit(main())
