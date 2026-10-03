from __future__ import annotations
import glob, json, os, statistics

root=os.environ.get("RESULT_ROOT","downloaded")
rows=[]
for path in sorted(glob.glob(root+"/**/rows.json",recursive=True)):
    with open(path,encoding="utf-8") as f:
        rows.extend(json.load(f))

seen={}
for r in rows:
    seen[r["case"]["id"]]=r
rows=[seen[k] for k in sorted(seen)]

lats=[r["latency_ms"] for r in rows if r.get("ok")]
def pct(vals,p):
    if not vals:return None
    s=sorted(vals)
    return s[max(0,min(len(s)-1,round((len(s)-1)*p)))]

outcomes={}
for r in rows: outcomes[r["outcome"]]=outcomes.get(r["outcome"],0)+1
expected_do=[r for r in rows if any(x.get("route")=="do" for x in r["case"]["expected"])]
summary={
    "cases":len(rows),
    "api_success":sum(bool(r.get("ok")) for r in rows),
    "exact_correct":sum(r["outcome"]=="correct" for r in rows),
    "exact_accuracy":sum(r["outcome"]=="correct" for r in rows)/len(rows) if rows else 0,
    "wrong_material_accepted":sum(r["outcome"]=="wrong_material_accepted" for r in rows),
    "wrong_material_ids":[r["case"]["id"] for r in rows if r["outcome"]=="wrong_material_accepted"],
    "false_execute":sum(r["outcome"]=="false_execute" for r in rows),
    "false_execute_ids":[r["case"]["id"] for r in rows if r["outcome"]=="false_execute"],
    "conservative_escalations":sum(r["outcome"]=="conservative_escalation" for r in rows),
    "wrong_reversible_accepted":sum(r["outcome"]=="wrong_reversible_accepted" for r in rows),
    "route_mismatch":sum(r["outcome"]=="route_mismatch" for r in rows),
    "api_failures":sum(r["outcome"]=="api_failure" for r in rows),
    "api_failure_ids":[r["case"]["id"] for r in rows if r["outcome"]=="api_failure"],
    "routine_expected_do":len(expected_do),
    "routine_auto_accepted":sum(r["post"]["accepted"] for r in expected_do),
    "routine_correct":sum(r["outcome"]=="correct" for r in expected_do),
    "p50_ms":statistics.median(lats) if lats else None,
    "p95_ms":pct(lats,.95),
    "p99_ms":pct(lats,.99),
    "mean_ms":statistics.mean(lats) if lats else None,
    "outcomes":outcomes,
}
os.makedirs("aggregate",exist_ok=True)
with open("aggregate/summary.json","w",encoding="utf-8") as f: json.dump(summary,f,ensure_ascii=False,indent=2)
with open("aggregate/rows.json","w",encoding="utf-8") as f: json.dump(rows,f,ensure_ascii=False,indent=2)
print("FINAL_SUMMARY="+json.dumps(summary,ensure_ascii=False,sort_keys=True))
if len(rows)!=120:
    raise SystemExit(f"expected 120 unique cases, got {len(rows)}")
