from __future__ import annotations
import json
import evidence_v06 as e
from known120 import CASES as KNOWN120
from synthetic96 import CASES as SYN96
from fresh_v07 import CASES as V07
from fresh_v08 import CASES as V08
from fresh_v09 import CASES as V09

UNSAFE={"wrong_material_accepted","false_execute","wrong_reversible_accepted"}
V09_CRITICAL={"v09_e01","v09_e02","v09_e14","v09_d07"}

def run_suite(name,cases):
    rows=[]
    fallback=0
    unsafe=[]
    exact=0
    for c in cases:
        row=e.plan_case(c)
        if row is None:
            fallback+=1
            continue
        outcome=e.classify(c,row["post"])
        row["outcome"]=outcome
        rows.append(row)
        if outcome=="correct":
            exact+=1
        if outcome in UNSAFE:
            unsafe.append({
                "id":c["id"],"text":c["text"],"outcome":outcome,
                "compiled":row["post"]["compiled"],"reason":row["post"]["reason"],
                "quantities":row["evidence"].get("quantities"),
                "quantity_issues":row["evidence"].get("quantity_issues"),
            })
    return {
        "suite":name,
        "cases":len(cases),
        "deterministic_cases":len(rows),
        "fallback_cases":fallback,
        "deterministic_exact":exact,
        "deterministic_unsafe":len(unsafe),
        "unsafe_rows":unsafe,
    }

def main():
    suites=[
        ("known120",KNOWN120),
        ("synthetic96",SYN96),
        ("fresh_v07",V07),
        ("fresh_v08",V08),
        ("fresh_v09",V09),
    ]
    results=[run_suite(n,c) for n,c in suites]

    critical=[]
    byid={c["id"]:c for c in V09}
    for cid in sorted(V09_CRITICAL):
        c=byid[cid]
        row=e.plan_case(c)
        outcome=None if row is None else e.classify(c,row["post"])
        critical.append({
            "id":cid,
            "text":c["text"],
            "outcome":outcome,
            "compiled":None if row is None else row["post"]["compiled"],
            "quantities":None if row is None else row["evidence"].get("quantities"),
            "quantity_issues":None if row is None else row["evidence"].get("quantity_issues"),
        })

    bad_critical=[x for x in critical if x["outcome"]!="correct"]
    unsafe_total=sum(x["deterministic_unsafe"] for x in results)
    report={
        "architecture":"canonical Persian quantity grammar/AST + provenance + fail-closed partial-parse guard",
        "suites":results,
        "v09_critical_numeric_cases":critical,
        "v09_critical_failures":bad_critical,
        "deterministic_unsafe_total":unsafe_total,
        "pass":unsafe_total==0 and not bad_critical,
    }
    print(json.dumps(report,ensure_ascii=False,indent=2))
    return 0 if report["pass"] else 1

if __name__=="__main__":
    raise SystemExit(main())
