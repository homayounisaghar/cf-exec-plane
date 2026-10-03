from __future__ import annotations
import json, os, statistics, time
import benchmark as b

SHARD_INDEX=int(os.environ["SHARD_INDEX"])
SHARD_COUNT=int(os.environ.get("SHARD_COUNT","2"))
DELAY=float(os.environ.get("CASE_DELAY","6.0"))

def pct(vals,p):
    if not vals: return None
    s=sorted(vals)
    return s[max(0,min(len(s)-1,round((len(s)-1)*p)))]

def main():
    outdir=os.environ.get("OUT_DIR",f"artifacts/onshape-fast-router-groq-v03-broad/shard-{SHARD_INDEX}")
    os.makedirs(outdir,exist_ok=True)
    key=os.environ.get("GROQ_API_KEY","").strip()
    if not key: raise SystemExit("GROQ_API_KEY missing")

    # Two balanced contiguous shards preserve category distribution reasonably well.
    all_cases=list(b.BASE_CASES)
    cases=[c for i,c in enumerate(all_cases) if i % SHARD_COUNT == SHARD_INDEX]

    # Make transient provider throttling recoverable instead of turning into model errors.
    b.MAX_RETRIES=8

    rows=[]
    for i,case in enumerate(cases,1):
        row=b.run_one(key,case)
        # One clean case-level replay for provider/JSON failures after the built-in retries.
        if row["outcome"]=="api_failure":
            time.sleep(2.0)
            row=b.run_one(key,case)
        rows.append(row)
        print(json.dumps({
            "shard":SHARD_INDEX,"i":i,"n":len(cases),"id":case["id"],
            "outcome":row["outcome"],"latency_ms":round(row.get("latency_ms",0),1),
            "reason":row["post"].get("reason"),"error":row.get("error")
        },ensure_ascii=False),flush=True)
        with open(os.path.join(outdir,"rows.json"),"w",encoding="utf-8") as f:
            json.dump(rows,f,ensure_ascii=False,indent=2)
        if i!=len(cases): time.sleep(DELAY)

    good=[r for r in rows if r.get("ok")]
    lats=[r["latency_ms"] for r in good]
    summary={
        "shard_index":SHARD_INDEX,
        "shard_count":SHARD_COUNT,
        "cases":len(rows),
        "api_success":len(good),
        "correct":sum(r["outcome"]=="correct" for r in rows),
        "wrong_material_accepted":sum(r["outcome"]=="wrong_material_accepted" for r in rows),
        "false_execute":sum(r["outcome"]=="false_execute" for r in rows),
        "conservative_escalation":sum(r["outcome"]=="conservative_escalation" for r in rows),
        "wrong_reversible_accepted":sum(r["outcome"]=="wrong_reversible_accepted" for r in rows),
        "route_mismatch":sum(r["outcome"]=="route_mismatch" for r in rows),
        "api_failure":sum(r["outcome"]=="api_failure" for r in rows),
        "p50_ms":statistics.median(lats) if lats else None,
        "p95_ms":pct(lats,.95),
        "p99_ms":pct(lats,.99),
        "mean_ms":statistics.mean(lats) if lats else None,
    }
    with open(os.path.join(outdir,"summary.json"),"w",encoding="utf-8") as f:
        json.dump(summary,f,ensure_ascii=False,indent=2)
    print("SHARD_SUMMARY="+json.dumps(summary,ensure_ascii=False,sort_keys=True),flush=True)
    return 0

if __name__=="__main__":
    raise SystemExit(main())
