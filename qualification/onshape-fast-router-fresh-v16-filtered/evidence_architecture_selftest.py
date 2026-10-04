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

    # V15 architecture invariants: envelope, literal-first parsing, scope, clauses and bounds.
    c,ev=compiled("لطفاً اسم Fillet 3 بشه delete top corner 1؟")
    assert_eq(c,{"route":"do","op":"feature.patch","args":{"feature_name":"Fillet 3","new_name":"delete top corner 1"}},"envelope-feature-rename")
    checks.append("envelope-feature-rename")

    c,ev=compiled("اگه میشه material Part 14 رو Aluminum بذار، مرسی")
    assert_eq(c,{"route":"do","op":"metadata.property.set","args":{"part_name":"Part 14","property":"material","value":"Aluminum"}},"envelope-material")
    checks.append("envelope-material")

    c,ev=compiled("Part 8 description بذار pattern 4x 5mm note؛ ممنون")
    assert_eq(ev.get("copy_count"),None,"literal-first-no-copy-count")
    assert_eq(ev.get("pattern_explicit"),False,"literal-first-no-pattern")
    assert_eq(c,{"route":"do","op":"metadata.property.set","args":{"part_name":"Part 8","property":"description","value":"pattern 4x 5mm note"}},"literal-first-description")
    checks.append("literal-first-description")

    c,ev=compiled("یه plane بساز با اسم Draft 7 angle 15 deg")
    assert_eq(ev.get("features"),[],"literal-first-no-fake-feature")
    assert_eq(ev.get("quantities"),[],"literal-first-no-fake-quantity")
    assert_eq(c,{"route":"do","op":"feature.add","args":{"feature_type":"plane","name":"Draft 7 angle 15 deg"}},"literal-first-plane")
    checks.append("literal-first-plane")

    c,ev=compiled("میشه جهت flip اکسترود 2 رو روشن کن؟")
    assert_eq(c,{"route":"do","op":"feature.parameter.set","args":{"feature_name":"Extrude 2","parameter":"flip direction","value":True}},"flip-synonym-role")
    checks.append("flip-synonym-role")

    c,ev=compiled("می‌خوام هرچی انتخاب شده ول کن")
    assert_eq(ev.get("inspect_target"),None,"clear-not-inspect")
    assert_eq(c,{"route":"do","op":"viewer.selection.clear","args":{}},"clear-selection-colloquial")
    checks.append("clear-selection-colloquial")

    c,ev=compiled("Part 4 رو مخفی نکن، نشونش بده")
    assert_eq(c,{"route":"do","op":"part.visibility","args":{"part_name":"Part 4","visible":True}},"negation-correction-visibility")
    checks.append("negation-correction-visibility")

    c,ev=compiled("hide نکن، فقط top view بده")
    assert_eq(c,{"route":"do","op":"view.standard","args":{"view":"top"}},"negation-correction-view")
    checks.append("negation-correction-view")

    c,ev=compiled("Fillet 5 رو حذف نکن")
    assert_eq(c,{"route":"ask","op":None,"args":{}},"negated-only-fails-closed")
    checks.append("negated-only-fails-closed")

    c,ev=compiled("zoom in نه، zoom out کن")
    assert_eq(c,{"route":"do","op":"view.move","args":{"action":"zoom","direction":"out"}},"correction-polarity")
    checks.append("correction-polarity")

    c,ev=compiled("selection رو clear کن و Part 3 رو قرمز کن")
    assert_eq(ev.get("multi_action"),True,"bare-conjunction-multi-action")
    assert_eq(c,{"route":"ask","op":None,"args":{}},"bare-conjunction-fails-closed")
    checks.append("bare-conjunction-fails-closed")

    c,ev=compiled("zoom out کن و pan left")
    assert_eq(ev.get("effect_clause_count"),2,"same-family-clause-count")
    assert_eq(c,{"route":"ask","op":None,"args":{}},"same-family-multi-action")
    checks.append("same-family-multi-action")

    c,ev=compiled("اگر سه نفر وصلن نفر دوم رو follow کن",{"collaborator_count":3})
    assert_eq(ev.get("conditional"),True,"conditional-detected")
    assert_eq(c,{"route":"ask","op":None,"args":{}},"conditional-fails-closed")
    checks.append("conditional-fails-closed")

    c,ev=compiled("Part 8 رو hide کن مگر اینکه تنها part visible باشه")
    assert_eq(c,{"route":"ask","op":None,"args":{}},"exception-fails-closed")
    checks.append("exception-fails-closed")

    c,ev=compiled("Fillet 4 رو منفی دو میلی کن",{"selection_count":1,"selection_types":["edge"]})
    assert_eq(c,{"route":"ask","op":None,"args":{}},"negative-spoken-quantity")
    checks.append("negative-spoken-quantity")

    c,ev=compiled("روی selection فیلت -1 mm بزن",{"selection_count":1,"selection_types":["edge"]})
    assert_eq(c,{"route":"ask","op":None,"args":{}},"negative-literal-quantity")
    checks.append("negative-literal-quantity")

    c,ev=compiled("Draft 6 رو 9999 درجه کن")
    assert_eq(c,{"route":"ask","op":None,"args":{}},"angle-bound")
    checks.append("angle-bound")

    c,ev=compiled("از Part 6 0 copies خطی با فاصله 3.5 mm بساز")
    assert_eq(c,{"route":"ask","op":None,"args":{}},"pattern-count-bound")
    checks.append("pattern-count-bound")

    c,ev=compiled("برای همین feature 0.25 mm بیشتر",{"last_feature":"Fillet 6","feature_parameters":{"radius":"4 mm"}})
    assert_eq(c,{"route":"do","op":"feature.parameter.set","args":{"feature_name":"Fillet 6","parameter":"radius","amount":"4.25 mm"}},"context-relative-delta")
    checks.append("context-relative-delta")

    c,ev=compiled("new Part Studio: fit hide studio 4")
    assert_eq(c,{"route":"do","op":"documented.createPartStudio","args":{"new_name":"fit hide studio 4"}},"part-studio-colon")
    checks.append("part-studio-colon")

    c,ev=compiled("نام داکیومنت رو بذار top delete archive 21")
    assert_eq(c,{"route":"do","op":"documented.updateDocumentAttributes","args":{"new_name":"top delete archive 21"}},"document-name-persian")
    checks.append("document-name-persian")

    c,ev=compiled("همین edge رو 0.8 mm bevel کن",{"selection_count":1,"selection_types":["edge"]})
    assert_eq(c,{"route":"do","op":"feature.from_selection","args":{"feature_type":"chamfer","amount":"0.8 mm"}},"bevel-alias")
    checks.append("bevel-alias")

    c,ev=compiled("Draft 5 angle 8 degrees")
    assert_eq(c,{"route":"do","op":"feature.parameter.set","args":{"feature_name":"Draft 5","parameter":"angle","amount":"8 deg"}},"degrees-alias")
    checks.append("degrees-alias")

    c,ev=compiled("participantها رو بگو")
    assert_eq(c,{"route":"do","op":"viewer.inspect","args":{"mode":"collaboration"}},"participant-not-pan")
    checks.append("participant-not-pan")

    c,ev=compiled("صفحه الان چه وضعیه")
    assert_eq(c,{"route":"do","op":"viewer.inspect","args":{"mode":"state"}},"state-colloquial")
    checks.append("state-colloquial")

    c,ev=compiled("شعاع Fillet 4 رو ۳٫۵ mm کن")
    assert_eq(c,{"route":"do","op":"feature.parameter.set","args":{"feature_name":"Fillet 4","parameter":"radius","amount":"3.5 mm"}},"persian-decimal-separator")
    checks.append("persian-decimal-separator")

    c,ev=compiled("اکسترود 7 دیپث ده میل")
    assert_eq(c,{"route":"do","op":"feature.parameter.set","args":{"feature_name":"Extrude 7","parameter":"depth","amount":"10 mm"}},"spoken-depth-alias")
    checks.append("spoken-depth-alias")

    c,ev=compiled("فیلِت 8 ریدیوس دو میل")
    assert_eq(c,{"route":"do","op":"feature.parameter.set","args":{"feature_name":"Fillet 8","parameter":"radius","amount":"2 mm"}},"spoken-radius-alias")
    checks.append("spoken-radius-alias")

    c,ev=compiled("نما رو ببر روی top")
    assert_eq(c,{"route":"do","op":"view.standard","args":{"view":"top"}},"top-view-colloquial")
    checks.append("top-view-colloquial")

    c,ev=compiled("follow participant",{"collaborator_count":2})
    assert_eq(c,{"route":"do","op":"view.follow","args":{}},"follow-participant")
    checks.append("follow-participant")

    c,ev=compiled("camera رو به چپ ببر")
    assert_eq(c,{"route":"do","op":"view.move","args":{"action":"orbit","direction":"left"}},"camera-orbit-colloquial")
    checks.append("camera-orbit-colloquial")

    c,ev=compiled("viewport رو یکم ببر راست")
    assert_eq(c,{"route":"do","op":"view.move","args":{"action":"pan","direction":"right"}},"viewport-pan")
    checks.append("viewport-pan")

    c,ev=compiled("delete کن Part 5 رو")
    assert_eq(c,{"route":"do","op":"feature.delete_part","args":{"part_name":"Part 5"}},"english-part-delete")
    checks.append("english-part-delete")

    c,ev=compiled("move Fillet 12 before Sketch 32")
    assert_eq(c,{"route":"do","op":"feature.reorder","args":{"source_feature":"Fillet 12","target_feature":"Sketch 32","placement":"before"}},"english-reorder")
    checks.append("english-reorder")

    c,ev=compiled("rollback after Extrude 5")
    assert_eq(c,{"route":"do","op":"rollback.set","args":{"after_feature":"Extrude 5"}},"english-rollback")
    checks.append("english-rollback")

    c,ev=compiled("Extrude 4 فعلاً غیرفعال باشه")
    assert_eq(c,{"route":"do","op":"feature.patch","args":{"feature_name":"Extrude 4","suppressed":True}},"suppression-colloquial")
    checks.append("suppression-colloquial")

    c,ev=compiled("Extrude 4 دوباره فعال باشه")
    assert_eq(c,{"route":"do","op":"feature.patch","args":{"feature_name":"Extrude 4","suppressed":False}},"unsuppression-colloquial")
    checks.append("unsuppression-colloquial")

    c,ev=compiled("part 9 material titanium")
    assert_eq(c,{"route":"do","op":"metadata.property.set","args":{"part_name":"Part 9","property":"material","value":"titanium"}},"bare-material-order")
    checks.append("bare-material-order")

    c,ev=compiled("Part 2 و Part 3 رو hide کن")
    assert_eq(c,{"route":"ask","op":None,"args":{}},"multi-part-target-fails-closed")
    checks.append("multi-part-target-fails-closed")

    c,ev=compiled("Extrude 2 و Extrude 3 رو خاموش کن")
    assert_eq(c,{"route":"ask","op":None,"args":{}},"multi-feature-target-fails-closed")
    checks.append("multi-feature-target-fails-closed")

    c,ev=compiled("روی selection فیلت 2 mm بزن",{"selection_count":1,"selection_types":["face"]})
    assert_eq(c,{"route":"ask","op":None,"args":{}},"selection-type-fails-closed")
    checks.append("selection-type-fails-closed")

    c,ev=compiled("Part 4 رو مخفی نکن نشونش بده")
    assert_eq(c,{"route":"do","op":"part.visibility","args":{"part_name":"Part 4","visible":True}},"inline-negation-correction")
    checks.append("inline-negation-correction")

    c,ev=compiled("zoom in نه zoom out کن")
    assert_eq(c,{"route":"do","op":"view.move","args":{"action":"zoom","direction":"out"}},"inline-polarity-correction")
    checks.append("inline-polarity-correction")

    c,ev=compiled("وقتی selection خالی شد top view بده")
    assert_eq(c,{"route":"ask","op":None,"args":{}},"temporal-condition-fails-closed")
    checks.append("temporal-condition-fails-closed")

    c,ev=compiled("قبل از حذف Fillet 7 وضعیت selection رو بگو",{"selection_count":1})
    assert_eq(c,{"route":"ask","op":None,"args":{}},"dependent-sequence-fails-closed")
    checks.append("dependent-sequence-fails-closed")

    c,ev=compiled("پارت 6 رو هاید کن")
    assert_eq(c,{"route":"do","op":"part.visibility","args":{"part_name":"Part 6","visible":False}},"hide-loanword")
    checks.append("hide-loanword")

    c,ev=compiled("نام Fillet 2 رو بذار fit hide corner 26")
    assert_eq(c,{"route":"do","op":"feature.patch","args":{"feature_name":"Fillet 2","new_name":"fit hide corner 26"}},"persian-name-synonym-feature-rename")
    checks.append("persian-name-synonym-feature-rename")

    c,ev=compiled("نام Part 3 رو بذار selection follow")
    assert_eq(c,{"route":"do","op":"documented.updateWVEPMetadata","args":{"part_name":"Part 3","property":"name","value":"selection follow"}},"persian-name-synonym-part-rename")
    checks.append("persian-name-synonym-part-rename")

    # Politeness and true conditions are semantically distinct.
    for text,want in [
        ("به سمت چپ اگه میشه یه کم rotate کن",{"route":"do","op":"view.move","args":{"action":"orbit","direction":"left"}}),
        ("top view اگه میشه بده",{"route":"do","op":"view.standard","args":{"view":"top"}}),
        ("یه صفحه مرجع جدید بساز اگه میشه الان",{"route":"do","op":"feature.add","args":{"feature_type":"plane"}}),
    ]:
        c,_=compiled(text)
        assert_eq(c,want,f"mid-clause-politeness:{text}")
        checks.append(f"mid-clause-politeness:{text}")

    c,_=compiled("اگه selection خالی بود top view بده",{"selection_count":1})
    assert_eq(c,{"route":"ask","op":None,"args":{}},"real-condition-still-fails-closed")
    checks.append("real-condition-still-fails-closed")

    # V15 fallback-collapse invariants: routine apprentice work stays local.
    for text,want in [
        ("همه چی توی viewport جا بشه",{"route":"do","op":"view.fit","args":{"action":"fit"}}),
        ("همین چیزهای انتخاب شده رو بزرگ کن تو صفحه",{"route":"do","op":"view.fit","args":{"action":"fit_selection"}}),
    ]:
        ctx={"selection_count":2,"selection_types":["edge","edge"]} if "انتخاب" in text else {}
        c,_=compiled(text,ctx)
        assert_eq(c,want,f"fit-local:{text}")
        checks.append(f"fit-local:{text}")

    c,_=compiled("feature Extrude 7 رو برگردون")
    assert_eq(c,{"route":"do","op":"feature.patch","args":{"feature_name":"Extrude 7","suppressed":False}},"feature-restore-local")
    checks.append("feature-restore-local")

    c,ev=compiled("نام Fillet 5 رو بذار material steel corner 29")
    assert_eq(ev.get("features"),[{"id":"f1","name":"Fillet 5","span":[4,12]}],"rename-material-literal-keeps-feature")
    assert_eq(ev.get("property"),"name","rename-material-literal-role")
    assert_eq(c,{"route":"do","op":"feature.patch","args":{"feature_name":"Fillet 5","new_name":"material steel corner 29"}},"rename-material-literal-local")
    checks.append("rename-material-literal-local")

    c,_=compiled("Part 12 name = top suppress archive 7")
    assert_eq(c,{"route":"do","op":"documented.updateWVEPMetadata","args":{"part_name":"Part 12","property":"name","value":"top suppress archive 7"}},"part-name-equals-local")
    checks.append("part-name-equals-local")

    c,_=compiled("این part یعنی Part 45 رو بنداز دور")
    assert_eq(c,{"route":"do","op":"feature.delete_part","args":{"part_name":"Part 45"}},"part-discard-local")
    checks.append("part-discard-local")

    for text,want in [
        ("برگرد تا قبل Extrude 8",{"route":"do","op":"rollback.set","args":{"before_feature":"Extrude 8"}}),
        ("برگرد تا بعد Extrude 9",{"route":"do","op":"rollback.set","args":{"after_feature":"Extrude 9"}}),
    ]:
        c,_=compiled(text)
        assert_eq(c,want,f"persian-rollback:{text}")
        checks.append(f"persian-rollback:{text}")

    for text,want in [
        ("create Part Studio called fit hide studio 50",{"route":"do","op":"documented.createPartStudio","args":{"new_name":"fit hide studio 50"}}),
        ("پارت استودیو تازه با اسم alpha beta",{"route":"do","op":"documented.createPartStudio","args":{"new_name":"alpha beta"}}),
        ("document name = top delete archive 12",{"route":"do","op":"documented.updateDocumentAttributes","args":{"new_name":"top delete archive 12"}}),
    ]:
        c,_=compiled(text)
        assert_eq(c,want,f"document-local:{text}")
        checks.append(f"document-local:{text}")

    for text in ["باز هم همون جهت","همون حرکت رو ادامه بده"]:
        c,_=compiled(text,{"last_move":{"action":"orbit","direction":"left"}})
        assert_eq(c,{"route":"do","op":"view.move","args":{"action":"orbit","direction":"left"}},f"context-camera-local:{text}")
        checks.append(f"context-camera-local:{text}")

    for text in ["این خط رو tangent کن","یه center rectangle اینجا بکش","از این sketch extrude symmetric بساز",
                 "از Sketch 8 یک extrude تا سطح بعدی بساز"]:
        c,_=compiled(text)
        assert_eq(c,{"route":"ask","op":None,"args":{}},f"unsupported-local-reject:{text}")
        checks.append(f"unsupported-local-reject:{text}")

    for text in ["طراحی رو برای پرینت سه بعدی قابل اعتمادتر کن",
                 "گوشه ها رو جوری اصلاح کن که stress concentration کم بشه",
                 "clearance مونتاژ رو بهتر کن بدون اینکه لق بشه",
                 "این part رو ارزون تر تولیدپذیر کن",
                 "مدل رو robust کن که با تغییر اندازه خراب نشه"]:
        c,_=compiled(text)
        assert_eq(c,{"route":"think","op":None,"args":{}},f"design-local-escalation:{text}")
        checks.append(f"design-local-escalation:{text}")

    c,ev=compiled("Extrude 8 رو tenish mm کن")
    if not ev.get("quantity_issues"):
        raise AssertionError("unparseable-unit-must-produce-quantity-issue")
    assert_eq(c,{"route":"ask","op":None,"args":{}},"unparseable-unit-local-reject")
    checks.append("unparseable-unit-local-reject")

    # V16 fresh-generalization invariants: broader natural language, same typed effects.
    for text,want,ctx in [
        ("یه زحمت، Part 4 رو مخفی کن",{"route":"do","op":"part.visibility","args":{"part_name":"Part 4","visible":False}},{}),
        ("اگه اوکیه Draft 10 رو 9 deg کن",{"route":"do","op":"feature.parameter.set","args":{"feature_name":"Draft 10","parameter":"angle","amount":"9 deg"}},{}),
        ("یکم نزدیک‌ترش کن",{"route":"do","op":"view.move","args":{"action":"zoom","direction":"in"}},{}),
        ("دید رو با orbit ببر بالا",{"route":"do","op":"view.move","args":{"action":"orbit","direction":"up"}},{}),
        ("نما رو صاف جابه‌جا کن به چپ",{"route":"do","op":"view.move","args":{"action":"pan","direction":"left"}},{}),
        ("نما رو خلاف ساعتگرد بچرخون",{"route":"do","op":"view.move","args":{"action":"orbit","direction":"counterclockwise"}},{}),
        ("کل چیزی که داریم داخل viewport جا بشه",{"route":"do","op":"view.fit","args":{"action":"fit"}},{}),
        ("selection فعلی رو داخل viewport جا بده",{"route":"do","op":"view.fit","args":{"action":"fit_selection"}},{"selection_count":2,"selection_types":["edge","edge"]}),
        ("هرچی الان select شده آزادش کن",{"route":"do","op":"viewer.selection.clear","args":{}},{}),
        ("بگو الان دقیقاً چی selected هست",{"route":"do","op":"viewer.inspect","args":{"mode":"selection"}},{}),
        ("وضع فعلی viewer رو گزارش بده",{"route":"do","op":"viewer.inspect","args":{"mode":"state"}},{}),
        ("لیست آدم‌های حاضر در جلسه رو بگو",{"route":"do","op":"viewer.inspect","args":{"mode":"collaboration"}},{}),
        ("view همکار روبرو رو بگیر",{"route":"do","op":"view.follow","args":{}},{"collaborator_count":2}),
        ("feature Extrude 3 رو دوباره فعال کن",{"route":"do","op":"feature.patch","args":{"feature_name":"Extrude 3","suppressed":False}},{}),
        ("suppressed برای Extrude 4 خاموش بشه",{"route":"do","op":"feature.patch","args":{"feature_name":"Extrude 4","suppressed":False}},{}),
        ("نقطه بازگشت رو قبل Extrude 10 قرار بده",{"route":"do","op":"rollback.set","args":{"before_feature":"Extrude 10"}},{}),
    ]:
        c,_=compiled(text,ctx)
        assert_eq(c,want,f"v16-natural:{text}")
        checks.append(f"v16-natural:{text}")

    for text,want in [
        ("برای Part 26 material رو Steel قرار بده",{"route":"do","op":"metadata.property.set","args":{"part_name":"Part 26","property":"material","value":"Steel"}}),
        ("برای Fillet 3 اسم جدید بذار fit orbit node 0",{"route":"do","op":"feature.patch","args":{"feature_name":"Fillet 3","new_name":"fit orbit node 0"}}),
        ("create a new Part Studio named orbit fit workspace 1",{"route":"do","op":"documented.createPartStudio","args":{"new_name":"orbit fit workspace 1"}}),
        ("document title بشه selection orbit project 1",{"route":"do","op":"documented.updateDocumentAttributes","args":{"new_name":"selection orbit project 1"}}),
        ("صفحه مرجع جدید با نام fit top ref 1 ایجاد کن",{"route":"do","op":"feature.add","args":{"feature_type":"plane","name":"fit top ref 1"}}),
        ("description برای Part 54 بذار orbit steel note 20 fit ممنونت می‌شم",{"route":"do","op":"metadata.property.set","args":{"part_name":"Part 54","property":"description","value":"orbit steel note 20 fit"}}),
    ]:
        c,_=compiled(text)
        assert_eq(c,want,f"v16-literal:{text}")
        checks.append(f"v16-literal:{text}")

    c,_=compiled("از Part 16 یه linear pattern با 2 copies و فاصله 3 mm بساز")
    assert_eq(c,{"route":"do","op":"feature.add","args":{"feature_type":"linearPattern","part_name":"Part 16","copies":2,"distance":"3 mm"}},"v16-pattern-single-effect")
    checks.append("v16-pattern-single-effect")

    c,_=compiled("یک feature chamfer تازه 1.8 mm بساز، selection خالیه")
    assert_eq(c,{"route":"do","op":"feature.add","args":{"feature_type":"chamfer","amount":"1.8 mm"}},"v16-empty-selection-state-not-clear")
    checks.append("v16-empty-selection-state-not-clear")

    # V16 residual invariants.
    for text,want in [
        ("visibility Part 3 رو off کن اگه اوکیه",{"route":"do","op":"part.visibility","args":{"part_name":"Part 3","visible":False}}),
        ("visibility Part 14 رو on کن اگه اوکیه",{"route":"do","op":"part.visibility","args":{"part_name":"Part 14","visible":True}}),
        ("selectionها رو خالی کن",{"route":"do","op":"viewer.selection.clear","args":{}}),
        ("یه plane مرجع تازه بساز و اسمش رو بذار fit top ref 0",{"route":"do","op":"feature.add","args":{"feature_type":"plane","name":"fit top ref 0"}}),
        ("از جهت بالا نشونش بده",{"route":"do","op":"view.standard","args":{"view":"top"}}),
        ("Extrude 3 دیگه نباشه، حذفش کن",{"route":"do","op":"feature.delete","args":{"feature_name":"Extrude 3"}}),
        ("Fillet 3 name = follow material node 16",{"route":"do","op":"feature.patch","args":{"feature_name":"Fillet 3","new_name":"follow material node 16"}}),
        ("میشه لطف کنی از Part 32 یه linear pattern با 4 copies و فاصله 4 mm بساز مرسی",{"route":"do","op":"feature.add","args":{"feature_type":"linearPattern","part_name":"Part 32","copies":4,"distance":"4 mm"}}),
    ]:
        c,_=compiled(text)
        assert_eq(c,want,f"v16-residual:{text}")
        checks.append(f"v16-residual:{text}")

    # Metamorphic invariants: neutral conversational envelopes must preserve semantics.
    envelope_bases=[
        ("Part 5 رو مخفی کن",{},{"route":"do","op":"part.visibility","args":{"part_name":"Part 5","visible":False}}),
        ("نمای top رو بده",{},{"route":"do","op":"view.standard","args":{"view":"top"}}),
        ("شعاع Fillet 4 رو 3.5 mm کن",{},{"route":"do","op":"feature.parameter.set","args":{"feature_name":"Fillet 4","parameter":"radius","amount":"3.5 mm"}}),
        ("selection رو کامل خالی کن",{},{"route":"do","op":"viewer.selection.clear","args":{}}),
        ("زوم کن بیرون",{},{"route":"do","op":"view.move","args":{"action":"zoom","direction":"out"}}),
        ("material Part 8 رو Titanium بذار",{},{"route":"do","op":"metadata.property.set","args":{"part_name":"Part 8","property":"material","value":"Titanium"}}),
        ("یه plane بساز با اسم datum alpha",{},{"route":"do","op":"feature.add","args":{"feature_type":"plane","name":"datum alpha"}}),
        ("اسم Fillet 3 بشه corner A",{},{"route":"do","op":"feature.patch","args":{"feature_name":"Fillet 3","new_name":"corner A"}}),
    ]
    prefixes=["","لطفاً ","اگه میشه ","می‌خوام ","خب، ","ممنون می‌شم "]
    suffixes=[""," لطفاً","، مرسی"," ممنون"," اگه میشه","؟"]
    metamorphic_count=0
    for base,ctx,want in envelope_bases:
        for pre in prefixes:
            for suf in suffixes:
                c,_=compiled(pre+base+suf,ctx)
                assert_eq(c,want,f"envelope-metamorphic:{pre}|{base}|{suf}")
                metamorphic_count+=1
    checks.append(f"envelope-metamorphic:{metamorphic_count}")

    # Literal payloads stay opaque even when they contain operation/target/quantity language.
    opaque_values=[
        "fit hide","zoom out","delete top","selection clear","follow participant",
        "Draft 7 angle 15 deg","Part 9 material Titanium","rollback after Extrude 5",
        "pattern 4 copies 5 mm","suppress false mirror hole"
    ]
    opacity_count=0
    for value in opaque_values:
        c,ev=compiled("اسم Fillet 3 بشه "+value)
        assert_eq(c,{"route":"do","op":"feature.patch","args":{"feature_name":"Fillet 3","new_name":value}},f"opaque-name:{value}")
        c,ev=compiled("Part 5 description بذار "+value)
        assert_eq(c,{"route":"do","op":"metadata.property.set","args":{"part_name":"Part 5","property":"description","value":value}},f"opaque-description:{value}")
        opacity_count+=2
    checks.append(f"literal-opacity-metamorphic:{opacity_count}")

    # Conditional wrappers around otherwise executable commands must fail closed.
    conditional_bases=[
        "Part 5 رو مخفی کن",
        "نمای top رو بده",
        "شعاع Fillet 4 رو 3.5 mm کن",
        "selection رو کامل خالی کن",
        "زوم کن بیرون",
        "material Part 8 رو Titanium بذار",
    ]
    conditional_count=0
    for base in conditional_bases:
        for pre in ["اگر لازم بود ","اگه selection خالی بود ","مگر اینکه لازم نباشه "]:
            c,_=compiled(pre+base,{"selection_count":1})
            assert_eq(c,{"route":"ask","op":None,"args":{}},f"conditional-metamorphic:{pre}|{base}")
            conditional_count+=1
    checks.append(f"conditional-metamorphic:{conditional_count}")

    # Pairwise independent effects are never silently collapsed to the first action.
    multi_effects=[
        "Part 5 رو مخفی کن",
        "نمای top رو بده",
        "selection رو کامل خالی کن",
        "زوم کن بیرون",
        "Part 3 رو قرمز کن",
        "Extrude 4 رو خاموش کن",
    ]
    pair_count=0
    for i,a in enumerate(multi_effects):
        for b in multi_effects[i+1:]:
            c,_=compiled(a+" و بعد "+b,{"selection_count":1})
            assert_eq(c,{"route":"ask","op":None,"args":{}},f"pairwise-multi-action:{a}|{b}")
            pair_count+=1
    checks.append(f"pairwise-multi-action:{pair_count}")

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
