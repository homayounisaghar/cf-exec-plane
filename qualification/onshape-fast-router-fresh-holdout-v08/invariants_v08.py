from __future__ import annotations
import json
import evidence_v06 as e

def case(cid,text,ctx=None):
    return {"id":cid,"text":text,"ctx":ctx or {},"expected":[{"route":"ask"}]}

def compiled(text,intent,ctx=None):
    c=case("x",text,ctx)
    ev=e.extract_evidence(text,ctx or {})
    return ev,e.compile_intent(c,"act",intent,ev)

checks=[]

def ok(name, cond, detail=None):
    checks.append({"name":name,"ok":bool(cond),"detail":detail})
    if not cond:
        raise AssertionError(name+": "+repr(detail))

# Numeric equivalence and spoken fractions.
vals=[]
for text in ["فیلت دو و نیم میل روی انتخاب","فیلت 2.5 mm روی انتخاب","فیلت ۲.۵ میلی روی انتخاب"]:
    ev=e.extract_evidence(text,{"selection_count":1,"selection_types":["edge"]})
    vals.append(e.quantity_string(ev["quantities"][0]) if ev["quantities"] else None)
ok("quantity-equivalence-2.5", vals==["2.5 mm","2.5 mm","2.5 mm"], vals)
ev=e.extract_evidence("پخ یک و بیست و پنج صدم میلی روی انتخاب",{"selection_count":1,"selection_types":["edge"]})
ok("spoken-hundredths", bool(ev["quantities"]) and e.quantity_string(ev["quantities"][0])=="1.25 mm",ev["quantities"])
ev=e.extract_evidence("پخ هشت دهم روی همینا",{"selection_count":2,"selection_types":["edge","edge"]})
ok("bare-fraction-edge-mm", bool(ev["quantities"]) and e.quantity_string(ev["quantities"][0])=="0.8 mm",ev["quantities"])

# Feature-name vs amount disambiguation.
ev=e.extract_evidence("روی انتخاب فیلت دو میل بزن",{"selection_count":1,"selection_types":["edge"]})
ok("fillet-amount-not-feature-name", len(ev["features"])==0,ev["features"])
ev=e.extract_evidence("فیلت دو رو شش میل کن",{})
ok("spoken-feature-name", [x["name"] for x in ev["features"]]==["Fillet 2"],ev["features"])

# Negation/state and flip-direction boolean.
ev1,p1=compiled("Part 7 رو نشون بده","part_visibility")
ev2,p2=compiled("Part 7 رو نشون نده","part_visibility")
ok("visibility-negation",p1["compiled"]["args"].get("visible") is True and p2["compiled"]["args"].get("visible") is False,[p1,p2])
_,b1=compiled("flip direction رو برای Extrude 1 روشن کن","feature_parameter")
_,b2=compiled("flip direction رو برای Extrude 1 خاموش کن","feature_parameter")
ok("flip-direction-boolean",b1["compiled"]["args"].get("value") is True and b2["compiled"]["args"].get("value") is False,[b1,b2])

# Relative edits are operators over verified context.
ctx={"last_feature":"Fillet 2","feature_parameters":{"radius":"4 mm"}}
_,r1=compiled("این فیلت رو یه میل بیشتر کن","feature_parameter",ctx)
_,r2=compiled("این فیلت رو نیم میل کمتر کن","feature_parameter",ctx)
ok("relative-add-subtract",r1["compiled"]["args"].get("amount")=="5 mm" and r2["compiled"]["args"].get("amount")=="3.5 mm",[r1,r2])

# Missing parameter must fail closed even if intent selection says feature edit.
_,u=compiled("Extrude 2 رو پنج میل کن","feature_parameter")
ok("unspecified-extrude-fail-closed",u["accepted"] is False and u["compiled"]["route"]=="ask",u)

# Multi-action semantic residue must fail closed.
c=case("m","Part 2 رو قرمز کن و مخفیش کن",{})
ev=e.extract_evidence(c["text"],{})
p=e.compile_intent(c,"act","part_visibility",ev)
ok("multi-action-residue",ev["multi_action"] is True and p["accepted"] is False,[ev["action_cues"],p])

# Rollback relation is one semantic action, not reorder residue.
ev=e.extract_evidence("rollback رو قبل Fillet 3 بذار",{})
d,i=e.direct_intent(case("r","rollback رو قبل Fillet 3 بذار"),ev)
ok("rollback-single-action",ev["multi_action"] is False and i=="rollback",[ev["action_cues"],d,i])

# Camera correction uses inverse of verified last move.
ctx={"last_move":{"action":"orbit","direction":"right","intensity":0.5}}
c=case("cam","نه برش گردون",ctx)
ev=e.extract_evidence(c["text"],ctx)
p=e.compile_intent(c,"act","camera_move",ev)
ok("camera-inverse",p["compiled"]["args"]=={"action":"orbit","direction":"left"},p)

# Fit selection requires and preserves selection semantics.
_,p=compiled("روی انتخاب فعلی فیت کن","fit",{"selection_count":2,"selection_types":["edge","edge"]})
ok("fit-selection",p["compiled"]["args"].get("action")=="fit_selection",p)

# Names: explicit value required; imperative suffix not swallowed.
ev=e.extract_evidence("یه Part Studio به اسم rough shell بساز",{})
ok("part-studio-name-clean",ev["name_value"]=="rough shell",ev["name_value"])
ev=e.extract_evidence("اسمش رو عوض کن",{"last_part":"Part 2"})
ok("rename-without-value",ev["name_value"] is None,ev["name_value"])

# Design language stays out of fast material execution.
for text in ["وزنشو کم کن ولی سفت بمونه","جوری تغییرش بده که قالب گیری راحت تر شه","فیچرهای به دردنخور رو جمع کن"]:
    ev=e.extract_evidence(text,{})
    d,i=e.direct_intent(case("d",text),ev)
    ok("design:"+text,d=="think" and i is None,[d,i,ev["design"]])

print(json.dumps({"checks":len(checks),"passed":sum(x["ok"] for x in checks),"results":checks},ensure_ascii=False,indent=2))
