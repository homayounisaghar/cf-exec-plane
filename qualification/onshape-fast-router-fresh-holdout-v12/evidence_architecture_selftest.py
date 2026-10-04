from __future__ import annotations
import json
import statistics
import time

import evidence_v06 as e

def compiled(text, ctx=None):
    case={"id":"self","text":text,"ctx":ctx or {},"expected":[{"route":"ask"}]}
    row=e.plan_case(case)
    if row is None:
        ev=e.extract_evidence(text,ctx or {})
        d,i=e.direct_intent(case,ev)
        if d is None:
            return {"route":"fallback","op":None,"args":{}},ev
        post=e.compile_intent(case,d,i,ev)
        post=e.enforce_evidence_consumption(post,ev)
        return post["compiled"],ev
    return row["post"]["compiled"],row["evidence"]

def assert_eq(got,want,label):
    if got != want:
        raise AssertionError(f"{label}: got={got!r} want={want!r}")

def main():
    checks=[]

    for text in ["چی الان دستمه","الان چی انتخاب کردم","چی دستمه الان"]:
        c,ev=compiled(text,{"selection_count":2})
        assert_eq(c,{"route":"do","op":"viewer.inspect","args":{"mode":"selection"}},f"inspect-order:{text}")
        checks.append(f"inspect-order:{text}")

    c,ev=compiled("یه plane بساز با اسم datum bottom")
    assert_eq(c,{"route":"do","op":"feature.add","args":{"feature_type":"plane","name":"datum bottom"}},"plane-name")
    checks.append("plane-name")

    c,ev=compiled("یه plane بساز با اسم hide top fit")
    assert_eq(c,{"route":"do","op":"feature.add","args":{"feature_type":"plane","name":"hide top fit"}},"literal-masking")
    checks.append("literal-masking")

    for text in [
        "این انتخاب رو پنجاه و پنج صدم میل پخ کن",
        "پخ شش دهم روی انتخاب فعلی",
        "پخ دو ممیز پنج میل روی انتخاب",
    ]:
        ev=e.extract_evidence(text,{"selection_count":2})
        assert_eq(ev.get("inspect_target"),None,f"selection-referent-not-inspect:{text}")
        checks.append(f"selection-referent-not-inspect:{text}")

    c,ev=compiled("selection رو کامل خالی کن")
    assert_eq(c,{"route":"do","op":"viewer.selection.clear","args":{}},"clear-selection-semantic")
    checks.append("clear-selection-semantic")

    for text,want in [
        ("یه ذره خلاف عقربه ها بچرخون",("view.move",{"action":"orbit","direction":"counterclockwise"})),
        ("یه قدم ازش دور شو",("view.move",{"action":"zoom","direction":"out"})),
        ("نمای top رو بده",("view.standard",{"view":"top"})),
        ("Extrude 7 رو برگردون روشن",("feature.patch",{"feature_name":"Extrude 7","suppressed":False})),
        ("اولین feature رو بنداز دور",("feature.delete",{"position":"first"})),
        ("Part 5 رو از نما بردار",("part.visibility",{"part_name":"Part 5","visible":False})),
    ]:
        c,ev=compiled(text)
        assert_eq((c.get("op"),c.get("args")),want,f"v12-class:{text}")
        checks.append(f"v12-class:{text}")

    # Explicit payload that is not compatible with the selected operation must never disappear.
    ev=e.extract_evidence("Part 5 رو مخفی کن با اسم Foo",{})
    post=e.accept("part.visibility",{"part_name":"Part 5","visible":False},{})
    guarded=e.enforce_evidence_consumption(post,ev)
    assert_eq(guarded["accepted"],False,"residue-block")
    assert_eq(guarded["reason"],"effect-evidence-unconsumed","residue-reason")
    checks.append("residue-block")

    samples=[
        ("چی الان دستمه",{"selection_count":2}),
        ("یه plane بساز با اسم datum bottom",{}),
        ("Part 5 رو از نما بردار",{}),
        ("یه ذره خلاف عقربه ها بچرخون",{}),
        ("Extrude 7 رو برگردون روشن",{}),
        ("نمای top رو بده",{}),
    ]
    timings=[]
    loops=3000
    for i in range(loops):
        text,ctx=samples[i % len(samples)]
        t0=time.perf_counter_ns()
        e.extract_evidence(text,ctx)
        timings.append((time.perf_counter_ns()-t0)/1_000_000)
    timings.sort()
    p50=statistics.median(timings)
    p95=timings[int((len(timings)-1)*0.95)]
    p99=timings[int((len(timings)-1)*0.99)]

    # A local regex/data-structure layer should remain far below network/model latency.
    if p95 > 2.0:
        raise AssertionError(f"deterministic evidence p95 too high: {p95:.3f} ms")

    print(json.dumps({
        "ok":True,
        "checks":checks,
        "checks_count":len(checks),
        "latency_ms":{"p50":p50,"p95":p95,"p99":p99},
        "loops":loops,
    },ensure_ascii=False,sort_keys=True))

if __name__=="__main__":
    main()
