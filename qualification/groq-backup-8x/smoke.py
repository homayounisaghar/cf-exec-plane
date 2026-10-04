from __future__ import annotations
import json, os, time, urllib.request, urllib.error

ENDPOINT="https://api.groq.com/openai/v1/chat/completions"
MODEL="openai/gpt-oss-20b"
key=os.environ.get("GROQ_API_KEY_BACKUP","").strip()
if not key:
    raise SystemExit("GROQ_API_KEY_BACKUP missing")

rows=[]
for i in range(1,9):
    body={
        "model":MODEL,
        "messages":[
            {"role":"system","content":"Reply with exactly OK."},
            {"role":"user","content":f"backup-key smoke test {i}"}
        ],
        "temperature":0,
        "max_completion_tokens":8,
    }
    payload=json.dumps(body).encode("utf-8")
    req=urllib.request.Request(
        ENDPOINT,
        data=payload,
        headers={
            "Authorization":"Bearer "+key,
            "Content-Type":"application/json",
            "User-Agent":"cf-exec-plane-groq-backup-8x/1.0"
        },
        method="POST",
    )
    t0=time.perf_counter()
    try:
        with urllib.request.urlopen(req, timeout=45) as resp:
            data=json.loads(resp.read().decode("utf-8"))
            latency=(time.perf_counter()-t0)*1000
            msg=(data.get("choices") or [{}])[0].get("message",{}).get("content")
            hdrs={k.lower():v for k,v in resp.headers.items()}
            rows.append({
                "index":i,
                "ok":True,
                "status":resp.status,
                "latency_ms":round(latency,1),
                "content":msg,
                "usage":data.get("usage",{}),
                "rate_limit":{
                    "limit_requests":hdrs.get("x-ratelimit-limit-requests"),
                    "remaining_requests":hdrs.get("x-ratelimit-remaining-requests"),
                    "limit_tokens":hdrs.get("x-ratelimit-limit-tokens"),
                    "remaining_tokens":hdrs.get("x-ratelimit-remaining-tokens"),
                    "reset_requests":hdrs.get("x-ratelimit-reset-requests"),
                    "reset_tokens":hdrs.get("x-ratelimit-reset-tokens"),
                }
            })
    except urllib.error.HTTPError as e:
        latency=(time.perf_counter()-t0)*1000
        body=e.read().decode("utf-8","replace")
        rows.append({
            "index":i,
            "ok":False,
            "status":e.code,
            "latency_ms":round(latency,1),
            "error":body[:1000],
        })
    except Exception as e:
        latency=(time.perf_counter()-t0)*1000
        rows.append({
            "index":i,
            "ok":False,
            "latency_ms":round(latency,1),
            "error":repr(e),
        })

summary={
    "model":MODEL,
    "calls":8,
    "successes":sum(1 for r in rows if r["ok"]),
    "failures":sum(1 for r in rows if not r["ok"]),
    "latency_ms":{
        "min":min((r["latency_ms"] for r in rows), default=None),
        "max":max((r["latency_ms"] for r in rows), default=None),
        "avg":round(sum(r["latency_ms"] for r in rows)/len(rows),1) if rows else None,
    },
    "rows":rows,
}
print(json.dumps(summary, ensure_ascii=False, indent=2))
