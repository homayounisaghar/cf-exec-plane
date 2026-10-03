from __future__ import annotations
import json, os, statistics, time
import benchmark as b

DELAY=float(os.environ.get("CASE_DELAY","8.2"))

def pct(vals,p):
    if not vals: return None
    s=sorted(vals); return s[max(0,min(len(s)-1,round((len(s)-1)*p)))]

def main():
    outdir=os.environ.get("OUT_DIR","artifacts/onshape-fast-router-groq-v03-red")
    os.makedirs(outdir,exist_ok=True)
    key=os.environ.get("GROQ_API_KEY","").strip()
    if not key: raise SystemExit("GROQ_API_KEY missing")

    rows=[]
    for i,case in enumerate(b.RED,1):
        row=b.run_one(key,case)
        rows.append(row)
        print(json.dumps({
            "i":i,"n":len(b.RED),"id":case["id"],"outcome":row["outcome"],
            "latency_ms":round(row.get("latency_ms",0),1),
            "reason":row["post"].get("reason"),"error":row.get("error")
        },ensure_ascii=False),flush=True)
        with open(os.path.join(outdir,"rows.json"),"w",encoding="utf-8") as f:
            json.dump(rows,f,ensure_ascii=False,indent=2)
        if i!=len(b.RED): time.sleep(DELAY)

    good=[r for r in rows if r.get("ok")]
    lats=[r["latency_ms"] for r in good]
    outcomes={}
    for r in rows: outcomes[r["outcome"]]=outcomes.get(r["outcome"],0)+1
    expected_do=[r for r in rows if "do" in b.expected_route(r["case"])]
    summary={
        "model":b.MODEL,
        "cases":len(rows),
        "api_success":len(good),
        "exact_correct":sum(r["outcome"]=="correct" for r in rows),
        "exact_accuracy":sum(r["outcome"]=="correct" for r in rows)/len(rows),
        "wrong_material_accepted":sum(r["outcome"]=="wrong_material_accepted" for r in rows),
        "wrong_material_ids":[r["case"]["id"] for r in rows if r["outcome"]=="wrong_material_accepted"],
        "false_execute":sum(r["outcome"]=="false_execute" for r in rows),
        "false_execute_ids":[r["case"]["id"] for r in rows if r["outcome"]=="false_execute"],
        "conservative_escalations":sum(r["outcome"]=="conservative_escalation" for r in rows),
        "routine_expected_do":len(expected_do),
        "routine_auto_accepted":sum(r["post"]["accepted"] for r in expected_do),
        "routine_correct":sum(r["outcome"]=="correct" for r in expected_do),
        "p50_ms":statistics.median(lats) if lats else None,
        "p95_ms":pct(lats,.95),
        "p99_ms":pct(lats,.99),
        "mean_ms":statistics.mean(lats) if lats else None,
        "outcomes":outcomes,
    }
    with open(os.path.join(outdir,"summary.json"),"w",encoding="utf-8") as f:
        json.dump(summary,f,ensure_ascii=False,indent=2)
    print("FINAL_SUMMARY="+json.dumps(summary,ensure_ascii=False,sort_keys=True),flush=True)
    return 0

if __name__=="__main__":
    raise SystemExit(main())
