from __future__ import annotations
import inspect
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

    compiler_source=inspect.getsource(e.compile_intent)
    if 'case["text"]' in compiler_source or "case['text']" in compiler_source:
        raise AssertionError("compiler-text-leakage")
    checks.append("compiler-text-blind")

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

    c,ev=compiled("Part 5 description بذار hide fit")
    assert_eq(ev.get("visibility"),None,"description-literal-no-visibility-cue")
    assert_eq(ev.get("fit_target"),None,"description-literal-no-fit-cue")
    assert_eq(c,{"route":"do","op":"metadata.property.set","args":{"part_name":"Part 5","property":"description","value":"hide fit"}},"description-literal-masking")
    checks.append("description-literal-masking")

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

    c,ev=compiled("همین چیزی که موس روشه رو انتخاب کن")
    assert_eq(ev.get("selection_action"),"select","selection-mutation-typed")
    assert_eq(ev.get("inspect_target"),None,"selection-mutation-not-inspect")
    assert_eq(c,{"route":"ask","op":None,"args":{}},"selection-mutation-fails-closed")
    checks.append("selection-mutation-vs-inspect")

    c,ev=compiled("زوم کن بیرون، لطفاً")
    assert_eq(c,{"route":"do","op":"view.move","args":{"action":"zoom","direction":"out"}},"zoom-explicit-polarity-precedence")
    checks.append("zoom-explicit-polarity-precedence")

    c,ev=compiled("زاویه دید رو به سمت راست بچرخون")
    assert_eq(ev.get("parameter_hint"),None,"camera-angle-not-feature-parameter")
    assert_eq(c,{"route":"do","op":"view.move","args":{"action":"orbit","direction":"right"}},"camera-role-scope")
    checks.append("camera-role-scope")

    c,ev=compiled("flip direction برای Extrude 9 رو خاموش کن")
    assert_eq(ev.get("suppressed"),None,"flip-boolean-not-suppression")
    assert_eq(c,{"route":"do","op":"feature.parameter.set","args":{"feature_name":"Extrude 9","parameter":"flip direction","value":False}},"flip-role-scope")
    checks.append("flip-role-scope")

    c,ev=compiled("یه صفحه مرجع به اسم datum alpha بساز")
    assert_eq(ev.get("plane_create_explicit"),True,"literal-span-preserves-create-cue")
    assert_eq(c,{"route":"do","op":"feature.add","args":{"feature_type":"plane","name":"datum alpha"}},"literal-span-boundary")
    checks.append("literal-span-boundary")

    c,ev=compiled("Part 6 رو blue کن")
    assert_eq(c,{"route":"do","op":"metadata.property.set","args":{"part_name":"Part 6","property":"color","value":"blue"}},"bare-english-color")
    checks.append("bare-english-color")

    c,ev=compiled("Titanium بذار material Part 6 رو")
    assert_eq(c,{"route":"do","op":"metadata.property.set","args":{"part_name":"Part 6","property":"material","value":"Titanium"}},"reordered-material-payload")
    checks.append("reordered-material-payload")

    c,ev=compiled("از Part 6 4 copies خطی با فاصله 3.5 mm بساز")
    assert_eq(ev.get("pattern_explicit"),True,"linear-copy-pattern-evidence")
    assert_eq(c,{"route":"do","op":"feature.add","args":{"feature_type":"linearPattern","part_name":"Part 6","copies":4,"distance":"3.5 mm"}},"linear-copy-pattern")
    checks.append("linear-copy-pattern")

    c,ev=compiled("سه میلش کن")
    assert_eq(len(ev.get("quantities") or []),1,"possessive-mm-quantity")
    assert_eq(c,{"route":"ask","op":None,"args":{}},"ungrounded-possessive-mm-fails-closed")
    checks.append("possessive-mm-fails-closed")

    c,ev=compiled("انتخاب رو پاک کن و بعد follow کن")
    assert_eq(ev.get("multi_action"),True,"cross-family-residue-detected")
    assert_eq(c,{"route":"ask","op":None,"args":{}},"cross-family-residue-fails-closed")
    checks.append("cross-family-residue")

    c,ev=compiled("مدل رو fit کن و بعد top view بده")
    assert_eq(ev.get("multi_action"),True,"reversible-multi-action-detected")
    assert_eq(c,{"route":"ask","op":None,"args":{}},"reversible-multi-action-fails-closed")
    checks.append("reversible-multi-action")

    c,ev=compiled("الان تو دستم چیه؟")
    assert_eq(c,{"route":"do","op":"viewer.inspect","args":{"mode":"selection"}},"selection-inspect-paraphrase")
    checks.append("selection-inspect-paraphrase")

    c,ev=compiled("Draft 5 رو دوازده درجه کن")
    assert_eq(c,{"route":"do","op":"feature.parameter.set","args":{"feature_name":"Draft 5","parameter":"angle","amount":"12 deg"}},"draft-type-unit-inference")
    checks.append("draft-type-unit-inference")

    c,ev=compiled("depth Fillet 6 رو سه میل کن")
    assert_eq(c,{"route":"ask","op":None,"args":{}},"explicit-parameter-precedence")
    checks.append("explicit-parameter-precedence")

    c,ev=compiled("Bracket دوباره دیده بشه")
    assert_eq(c,{"route":"do","op":"part.visibility","args":{"part_name":"Bracket","visible":True}},"grounded-positive-visibility")
    checks.append("grounded-positive-visibility")

    c,ev=compiled("material Part 8 رو Titanium بذار")
    assert_eq(ev.get("unsupported"),False,"material-not-mate")
    assert_eq(c,{"route":"do","op":"metadata.property.set","args":{"part_name":"Part 8","property":"material","value":"Titanium"}},"material-token-boundary")
    checks.append("material-token-boundary")

    c,ev=compiled("سبکش کن ولی سفتی قطعه کم نشه")
    assert_eq(c,{"route":"think","op":None,"args":{}},"weight-design-escalation")
    checks.append("weight-design-escalation")

    c,ev=compiled("درخت feature رو مرتب و خلوت کن")
    assert_eq(c,{"route":"think","op":None,"args":{}},"mixed-feature-tree-design")
    checks.append("mixed-feature-tree-design")

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
