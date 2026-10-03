from __future__ import annotations

import json
import os
import re
import statistics
import time
import urllib.error
import urllib.request

MODEL = "openai/gpt-oss-20b"
ENDPOINT = "https://api.groq.com/openai/v1/chat/completions"
CASE_DELAY = float(os.environ.get("CASE_DELAY", "5.0"))
MAX_RETRIES = 3

OPS = [
    "view.move",
    "view.fit",
    "view.standard",
    "viewer.selection.clear",
    "viewer.inspect",
    "view.follow",
    "feature.from_selection",
    "feature.parameter.set",
    "feature.patch",
    "feature.delete",
    "feature.delete_part",
    "feature.add",
    "feature.reorder",
    "part.visibility",
    "metadata.property.set",
    "rollback.set",
    "documented.createPartStudio",
    "documented.updateDocumentAttributes",
    "documented.updateWVEPMetadata",
]

SYSTEM = """You are the fast intent compiler for a personal Onshape operator.
Translate one short Persian/mixed spoken command into ONE compact recipe.

Return JSON only:
{"route":"do|ask|think","op":"operation-or-null","args":{}}

do = routine action is clear and grounded enough.
ask = routine action needs a missing target/value, is unsupported by this fast lane, or a material mutation is ambiguous.
think = open-ended design/engineering judgment is required.

For ask/think: op=null and args={}. Never invent an operation.
Use context for pronouns and follow-ups. Current Viewer selection is a first-class target.
Camera moves are low-risk/reversible: short wording like "zoom" may act rather than ask.

Operations:
view.move(action=orbit|pan|zoom,direction=left|right|up|down|clockwise|counterclockwise|in|out,intensity? number,angle_degrees? number)
view.fit(action=fit|fit_selection)
view.standard(view=top)
viewer.selection.clear()
viewer.inspect(mode=state|selection|collaboration)
view.follow(candidate_index? integer; ask if 3+ collaborators and none identified)
feature.from_selection(feature_type=fillet|chamfer,amount)
feature.parameter.set(feature_name,parameter,amount|value)
feature.patch(feature_name,suppressed?|new_name?)
feature.delete(feature_name?|position=last|first)
feature.delete_part(part_name)
feature.add(feature_type=plane|linearPattern|fillet|chamfer,name?|part_name?|copies?|distance?|amount?|target?)
feature.reorder(source_feature,target_feature,placement=before|after)
part.visibility(part_name,visible)
metadata.property.set(part_name?,property,value)
rollback.set(before_feature?|after_feature?|position=start|end)
documented.createPartStudio(new_name)
documented.updateDocumentAttributes(new_name)
documented.updateWVEPMetadata(part_name,property,value)

Preserve engineering quantities as short strings such as "2 mm" or "45 deg".
For "more" repeat the previous camera direction. For "back" reverse it.
Never use fuzzy confidence to execute ambiguous geometry/document mutation.
"""

CASES = []

def add(category, cid, text, expected, ctx=None):
    CASES.append({
        "category": category,
        "id": cid,
        "text": text,
        "ctx": ctx or {},
        "expected": expected if isinstance(expected, list) else [expected],
    })

def do(op, args=None):
    return {"route": "do", "op": op, "args": args or {}}

def ask():
    return {"route": "ask"}

def think():
    return {"route": "think"}

# 1) Camera / view — 24
add("camera", "orbit_right_small", "یه کم به راست بچرخون", do("view.move", {"action":"orbit","direction":"right"}))
add("camera", "orbit_left", "مدل رو به چپ بچرخون", do("view.move", {"action":"orbit","direction":"left"}))
add("camera", "orbit_up", "یه ذره رو به بالا بچرخونش", do("view.move", {"action":"orbit","direction":"up"}))
add("camera", "orbit_down", "بچرخونش پایین", do("view.move", {"action":"orbit","direction":"down"}))
add("camera", "orbit_clockwise", "ساعتگرد بچرخون", do("view.move", {"action":"orbit","direction":"clockwise"}))
add("camera", "orbit_counterclockwise", "یه کم پادساعتگرد", do("view.move", {"action":"orbit","direction":"counterclockwise"}))
add("camera", "orbit_angle", "سی درجه به راست بچرخون", do("view.move", {"action":"orbit","direction":"right","angle_degrees":30}))
add("camera", "pan_left", "نما رو یکم ببر چپ", do("view.move", {"action":"pan","direction":"left"}))
add("camera", "pan_right", "صفحه رو ببر سمت راست", do("view.move", {"action":"pan","direction":"right"}))
add("camera", "pan_up", "یکم پن کن بالا", do("view.move", {"action":"pan","direction":"up"}))
add("camera", "pan_down", "pan down یه کوچولو", do("view.move", {"action":"pan","direction":"down"}))
add("camera", "zoom_in", "یه کم زوم کن داخل", do("view.move", {"action":"zoom","direction":"in"}))
add("camera", "zoom_out", "خیلی زوم اوت کن", do("view.move", {"action":"zoom","direction":"out"}))
add("camera", "more_context", "بیشتر", do("view.move", {"action":"orbit","direction":"right"}), {"last_move":{"action":"orbit","direction":"right","intensity":0.25}})
add("camera", "back_context", "زیادی شد یه کم برگرد", do("view.move", {"action":"orbit","direction":"left"}), {"last_move":{"action":"orbit","direction":"right","intensity":0.7}})
add("camera", "back_zoom", "برگرد عقب یه ذره", do("view.move", {"action":"zoom","direction":"out"}), {"last_move":{"action":"zoom","direction":"in","intensity":0.4}})
add("camera", "fit_all", "همه چی رو فیت کن", do("view.fit", {"action":"fit"}), {"selection_count":0})
add("camera", "fit_selection", "روی همین انتخاب فیت کن", do("view.fit", {"action":"fit_selection"}), {"selection_count":2,"selection_types":["edge","edge"]})
add("camera", "top_view", "از بالا نشون بده", do("view.standard", {"view":"top"}))
add("camera", "clear_selection", "انتخاب رو پاک کن", do("viewer.selection.clear"))
add("camera", "bare_zoom", "زوم", do("view.move", {"action":"zoom","direction":"in"}), {"interaction_mode":"camera"})
add("camera", "mixed_rotate", "rotate right یه کم", do("view.move", {"action":"orbit","direction":"right"}))
add("camera", "voice_zoom_out", "یکم زوم اوت ترش کن", do("view.move", {"action":"zoom","direction":"out"}))
add("camera", "unsupported_front", "front view رو نشون بده", ask())

# 2) Inspect / selection / follow — 10
add("inspect_follow", "inspect_selection", "الان چی انتخاب شده؟", do("viewer.inspect", {"mode":"selection"}))
add("inspect_follow", "inspect_state", "وضعیت ویور رو بگو", do("viewer.inspect", {"mode":"state"}))
add("inspect_follow", "inspect_collab", "ببین چه کسایی توی این سشن هستن", do("viewer.inspect", {"mode":"collaboration"}))
add("inspect_follow", "follow_two", "نمای اون یکی نفر رو فالو کن", do("view.follow"), {"collaborator_count":2})
add("inspect_follow", "follow_three_ambiguous", "یکی از اون دو نفر رو فالو کن", ask(), {"collaborator_count":3})
add("inspect_follow", "follow_candidate", "نفر دوم رو فالو کن", do("view.follow", {"candidate_index":2}), {"collaborator_count":3})
add("inspect_follow", "select_deictic_unbound", "این رو انتخاب کن", ask(), {"selection_count":0})
add("inspect_follow", "add_edge_unbound", "اون لبه رو هم به انتخاب اضافه کن", ask(), {"selection_count":1})
add("inspect_follow", "clear_mixed", "selection رو خالی کن", do("viewer.selection.clear"))
add("inspect_follow", "inspect_short", "چی انتخابه؟", do("viewer.inspect", {"mode":"selection"}))

# 3) Feature from current selection — 12
add("from_selection", "fillet_2", "این دو تا لبه رو دو میلیمتر فیلت کن", do("feature.from_selection", {"feature_type":"fillet","amount":"2 mm"}), {"selection_count":2,"selection_types":["edge","edge"]})
add("from_selection", "fillet_half", "همین لبه‌ها رو نیم میل فیلت کن", do("feature.from_selection", {"feature_type":"fillet","amount":"0.5 mm"}), {"selection_count":2,"selection_types":["edge","edge"]})
add("from_selection", "chamfer_1", "این دوتا رو یک میلی پخ بزن", do("feature.from_selection", {"feature_type":"chamfer","amount":"1 mm"}), {"selection_count":2,"selection_types":["edge","edge"]})
add("from_selection", "mixed_fillet", "Fillet selected edges 1.5 mm", do("feature.from_selection", {"feature_type":"fillet","amount":"1.5 mm"}), {"selection_count":2,"selection_types":["edge","edge"]})
add("from_selection", "face_chamfer", "همین فیس رو دو میل chamfer کن", do("feature.from_selection", {"feature_type":"chamfer","amount":"2 mm"}), {"selection_count":1,"selection_types":["face"]})
add("from_selection", "fillet_missing_amount", "همین انتخاب رو فیلت کن", ask(), {"selection_count":2,"selection_types":["edge","edge"]})
add("from_selection", "fillet_no_selection", "دو میل فیلت کن", ask(), {"selection_count":0})
add("from_selection", "chamfer_missing_amount", "این دوتا رو چمفر کن", ask(), {"selection_count":2,"selection_types":["edge","edge"]})
add("from_selection", "colloquial_3", "همین دوتا سه میل فیلت", do("feature.from_selection", {"feature_type":"fillet","amount":"3 mm"}), {"selection_count":2,"selection_types":["edge","edge"]})
add("from_selection", "pakh_125", "لبه‌های انتخاب شده رو یک و بیست و پنج صدم میلی پخ بزن", do("feature.from_selection", {"feature_type":"chamfer","amount":"1.25 mm"}), {"selection_count":2,"selection_types":["edge","edge"]})
add("from_selection", "fillet_10", "با همین انتخاب یه فیلت ده میلی بزن", do("feature.from_selection", {"feature_type":"fillet","amount":"10 mm"}), {"selection_count":2,"selection_types":["edge","edge"]})
add("from_selection", "voice_fillet", "این دوتا رو دو میل فیلِت کن", do("feature.from_selection", {"feature_type":"fillet","amount":"2 mm"}), {"selection_count":2,"selection_types":["edge","edge"]})

# 4) Existing feature / delete — 18
add("feature_edit", "radius_named", "فیلت ۳ رو بکن ۴ میلیمتر", do("feature.parameter.set", {"feature_name":"Fillet 3","parameter":"radius","amount":"4 mm"}))
add("feature_edit", "radius_context", "شعاع همین فیلت رو دو میلی کن", do("feature.parameter.set", {"feature_name":"Fillet 3","parameter":"radius","amount":"2 mm"}), {"last_feature":"Fillet 3"})
add("feature_edit", "radius_relative", "شعاع همین فیلت رو یه میل بیشتر کن", do("feature.parameter.set", {"feature_name":"Fillet 3","parameter":"radius","amount":"4 mm"}), {"last_feature":"Fillet 3","feature_parameters":{"radius":"3 mm"}})
add("feature_edit", "suppress", "Extrude 2 رو خاموش کن", do("feature.patch", {"feature_name":"Extrude 2","suppressed":True}))
add("feature_edit", "unsuppress", "Extrude 2 رو دوباره روشن کن", do("feature.patch", {"feature_name":"Extrude 2","suppressed":False}))
add("feature_edit", "rename_feature", "اسم Fillet 1 رو بذار لبه نرم", do("feature.patch", {"feature_name":"Fillet 1","new_name":"لبه نرم"}))
add("feature_edit", "delete_named", "Fillet 4 رو پاک کن", do("feature.delete", {"feature_name":"Fillet 4"}))
add("feature_edit", "delete_last", "آخرین فیچر رو پاک کن", do("feature.delete", {"position":"last"}))
add("feature_edit", "delete_first", "اولین فیچر رو حذف کن", do("feature.delete", {"position":"first"}))
add("feature_edit", "delete_part_named", "Part 4 رو حذف کن", do("feature.delete_part", {"part_name":"Part 4"}))
add("feature_edit", "delete_part_context", "همین پارت رو پاک کن", do("feature.delete_part", {"part_name":"Part 2"}), {"last_part":"Part 2"})
add("feature_edit", "depth_extrude", "عمق Extrude 2 رو ۱۲ میلی کن", do("feature.parameter.set", {"feature_name":"Extrude 2","parameter":"depth","amount":"12 mm"}))
add("feature_edit", "angle_feature", "زاویه Draft 1 رو ۴۵ درجه کن", do("feature.parameter.set", {"feature_name":"Draft 1","parameter":"angle","amount":"45 deg"}))
add("feature_edit", "boolean_param", "flip direction رو برای Extrude 1 روشن کن", do("feature.parameter.set", {"feature_name":"Extrude 1","parameter":"flip direction","value":True}))
add("feature_edit", "pronoun_unsuppress", "دوباره روشنش کن", do("feature.patch", {"feature_name":"Extrude 2","suppressed":False}), {"last_feature":"Extrude 2","last_action":"suppress"})
add("feature_edit", "ambiguous_edit", "این فیچر رو ویرایش کن", ask())
add("feature_edit", "unspecified_parameter", "Extrude 2 رو پنج میلی کن", ask())
add("feature_edit", "delete_context_feature", "اون فیچر رو پاک کن", do("feature.delete", {"feature_name":"Fillet 2"}), {"last_feature":"Fillet 2"})

# 5) Part visibility / metadata — 12
add("part_metadata", "hide_part", "Part 2 رو مخفی کن", do("part.visibility", {"part_name":"Part 2","visible":False}))
add("part_metadata", "show_part", "Part 2 رو نشون بده", do("part.visibility", {"part_name":"Part 2","visible":True}))
add("part_metadata", "show_context", "دوباره نشونش بده", do("part.visibility", {"part_name":"Part 2","visible":True}), {"last_part":"Part 2","last_action":"hide"})
add("part_metadata", "hide_context", "همینو قایم کن", do("part.visibility", {"part_name":"Cap","visible":False}), {"last_part":"Cap"})
add("part_metadata", "color_red", "Part 1 رو قرمز کن", do("metadata.property.set", {"part_name":"Part 1","property":"color","value":"red"}))
add("part_metadata", "color_blue", "رنگ Cap رو آبی کن", do("metadata.property.set", {"part_name":"Cap","property":"color","value":"blue"}))
add("part_metadata", "color_mixed", "Part 3 color = green", do("metadata.property.set", {"part_name":"Part 3","property":"color","value":"green"}))
add("part_metadata", "rename_part", "اسم Part 2 رو عوض کن به cap", [
    do("documented.updateWVEPMetadata", {"part_name":"Part 2","property":"name","value":"cap"}),
    do("metadata.property.set", {"part_name":"Part 2","property":"name","value":"cap"}),
])
add("part_metadata", "rename_part_mixed", "rename Part 4 to bracket", [
    do("documented.updateWVEPMetadata", {"part_name":"Part 4","property":"name","value":"bracket"}),
    do("metadata.property.set", {"part_name":"Part 4","property":"name","value":"bracket"}),
])
add("part_metadata", "material", "متریال Part 1 رو Aluminum بذار", do("metadata.property.set", {"part_name":"Part 1","property":"material","value":"Aluminum"}))
add("part_metadata", "description", "description پارت Cap رو بذار cover prototype", do("metadata.property.set", {"part_name":"Cap","property":"description","value":"cover prototype"}))
add("part_metadata", "missing_part", "پارت رو مخفی کن", ask())

# 6) Feature creation — 14
add("feature_add", "plane", "یه plane جدید بساز", do("feature.add", {"feature_type":"plane"}))
add("feature_add", "plane_named", "یه plane بساز اسمش Datum A", do("feature.add", {"feature_type":"plane","name":"Datum A"}))
add("feature_add", "pattern_5", "یه الگوی خطی ۵ تایی با فاصله ۲۰ میلی روی Part 1 بساز", do("feature.add", {"feature_type":"linearPattern","part_name":"Part 1","copies":5,"distance":"20 mm"}))
add("feature_add", "pattern_3", "Part 2 رو سه بار هر ده میلی pattern کن", do("feature.add", {"feature_type":"linearPattern","part_name":"Part 2","copies":3,"distance":"10 mm"}))
add("feature_add", "pattern_mixed", "linear pattern Cap, 4 copies, 7.5 mm", do("feature.add", {"feature_type":"linearPattern","part_name":"Cap","copies":4,"distance":"7.5 mm"}))
add("feature_add", "pattern_missing_copies", "روی Part 1 یه linear pattern با فاصله ۲۰ میلی بساز", ask())
add("feature_add", "pattern_missing_distance", "Part 1 رو پنج‌تایی pattern کن", ask())
add("feature_add", "empty_fillet", "یه fillet خالی با radius ده میلی بساز، انتخاب فعلاً نمی‌دم", do("feature.add", {"feature_type":"fillet","amount":"10 mm"}))
add("feature_add", "empty_chamfer", "یه chamfer خالی دو میلی بساز بدون انتخاب", do("feature.add", {"feature_type":"chamfer","amount":"2 mm"}))
add("feature_add", "fillet_missing_amount", "یه فیلت جدید بساز ولی چیزی انتخاب نکن", ask())
add("feature_add", "plane_right_underspecified", "یه plane روی Right بساز", ask())
add("feature_add", "mirror_not_admitted", "Part 1 رو حول Right plane mirror کن", ask())
add("feature_add", "extrude_not_admitted", "Sketch 2 رو ده میلی extrude کن", ask())
add("feature_add", "hole_not_admitted", "روی این فیس یه سوراخ شش میل بزن", ask(), {"selection_count":1,"selection_types":["face"]})

# 7) Reorder / rollback / document — 12
add("document_order", "reorder_before", "Fillet 1 رو قبل از Extrude 3 ببر", do("feature.reorder", {"source_feature":"Fillet 1","target_feature":"Extrude 3","placement":"before"}))
add("document_order", "reorder_after", "Extrude 2 رو بعد از Sketch 4 ببر", do("feature.reorder", {"source_feature":"Extrude 2","target_feature":"Sketch 4","placement":"after"}))
add("document_order", "reorder_context", "همین فیچر رو ببر قبل از Fillet 5", do("feature.reorder", {"source_feature":"Extrude 2","target_feature":"Fillet 5","placement":"before"}), {"last_feature":"Extrude 2"})
add("document_order", "rollback_before", "rollback رو قبل از Fillet 4 ببر", do("rollback.set", {"before_feature":"Fillet 4"}))
add("document_order", "rollback_after", "rollback رو بعد از Extrude 3 بذار", do("rollback.set", {"after_feature":"Extrude 3"}))
add("document_order", "rollback_end", "rollback رو ببر آخر", do("rollback.set", {"position":"end"}))
add("document_order", "rollback_start", "rollback رو ببر اول", do("rollback.set", {"position":"start"}))
add("document_order", "create_ps", "یه Part Studio جدید بساز به اسم تست", do("documented.createPartStudio", {"new_name":"تست"}))
add("document_order", "create_ps_mixed", "new Part Studio called bracket experiments", do("documented.createPartStudio", {"new_name":"bracket experiments"}))
add("document_order", "rename_doc", "اسم داکیومنت رو بذار بسته‌بندی", do("documented.updateDocumentAttributes", {"new_name":"بسته‌بندی"}))
add("document_order", "rename_doc_mixed", "rename document to Pump Housing R2", do("documented.updateDocumentAttributes", {"new_name":"Pump Housing R2"}))
add("document_order", "rename_part_documented", "اسم Part 6 رو بذار spacer", [
    do("documented.updateWVEPMetadata", {"part_name":"Part 6","property":"name","value":"spacer"}),
    do("metadata.property.set", {"part_name":"Part 6","property":"name","value":"spacer"}),
])

# 8) Ambiguity / design / unsupported / high-impact — 18
add("escalation", "design_pretty", "این قطعه رو یه کم خوشگل‌تر کن", think())
add("escalation", "design_premium", "یه طراحی بهتر برای این درپوش بده که پریمیوم‌تر بشه", think())
add("escalation", "design_lighter", "این براکت رو سبک‌تر کن ولی استحکامش کم نشه", think())
add("escalation", "design_stronger", "این قسمت رو قوی‌ترش کن", think())
add("escalation", "design_injection", "برای تزریق پلاستیک بهینه‌ش کن", think())
add("escalation", "design_fix", "این طراحی رو درستش کن", think())
add("escalation", "delete_all", "همه رو پاک کن", ask())
add("escalation", "delete_it", "اون رو حذف کن", ask())
add("escalation", "hide_it", "مخفیش کن", ask())
add("escalation", "fillet_bare", "فیلت بزن", ask(), {"selection_count":0})
add("escalation", "amount_bare", "دو میلیمترش کن", ask())
add("escalation", "same_bare", "همون کار رو دوباره بکن", ask())
add("escalation", "isometric_unsupported", "ایزومتریک نشون بده", ask())
add("escalation", "assembly_mate", "این دو قطعه رو mate کن", ask())
add("escalation", "export_pdf", "از این یه PDF بگیر", ask())
add("escalation", "share_public", "داکیومنت رو public کن", ask())
add("escalation", "company_admin", "اسم شرکت Onshape رو عوض کن", ask())
add("escalation", "ambiguous_color", "قرمزش کن", ask())

assert len(CASES) == 120, len(CASES)

STABILITY_IDS = [
    "orbit_right_small",
    "more_context",
    "fit_selection",
    "inspect_selection",
    "follow_three_ambiguous",
    "fillet_2",
    "radius_named",
    "delete_part_context",
    "rename_part",
    "pattern_5",
    "design_lighter",
    "delete_all",
]

PERSIAN_DIGITS = str.maketrans("۰۱۲۳۴۵۶۷۸۹٠١٢٣٤٥٦٧٨٩", "01234567890123456789")
COLOR_MAP = {
    "قرمز": "red",
    "آبی": "blue",
    "ابي": "blue",
    "سبز": "green",
}

def norm_string(v):
    s = str(v).translate(PERSIAN_DIGITS).replace("\u200c", " ").strip()
    s = re.sub(r"\s+", " ", s)
    low = s.lower()
    if low in COLOR_MAP:
        return COLOR_MAP[low]
    m = re.fullmatch(r"([+-]?\d+(?:[.,]\d+)?)\s*(?:mm|میلی(?:متر)?|میل)", low)
    if m:
        return m.group(1).replace(",", ".") + " mm"
    m = re.fullmatch(r"([+-]?\d+(?:[.,]\d+)?)\s*(?:deg|degree|degrees|درجه)", low)
    if m:
        return m.group(1).replace(",", ".") + " deg"
    return low

def norm_scalar(v):
    if isinstance(v, str):
        return norm_string(v)
    return v

def subset_match(expected, got):
    if isinstance(expected, dict):
        return isinstance(got, dict) and all(k in got and subset_match(v, got[k]) for k, v in expected.items())
    if isinstance(expected, list):
        return isinstance(got, list) and len(got) >= len(expected) and all(subset_match(v, got[i]) for i, v in enumerate(expected))
    return norm_scalar(expected) == norm_scalar(got)

def expected_match(case, got):
    return any(subset_match(exp, got) for exp in case["expected"])

def validate_recipe(recipe, ctx):
    if not isinstance(recipe, dict) or set(recipe.keys()) != {"route", "op", "args"}:
        return False, "top-level-shape"
    route = recipe.get("route")
    op = recipe.get("op")
    args = recipe.get("args")
    if route not in {"do", "ask", "think"}:
        return False, "route"
    if not isinstance(args, dict):
        return False, "args-not-object"
    if route != "do":
        if op is not None or args:
            return False, "escalation-carries-op"
        return True, "ok"
    if op not in OPS:
        return False, "unknown-op"

    def keys(allowed):
        return set(args).issubset(set(allowed))

    if op == "view.move":
        if not keys(["action","direction","intensity","angle_degrees"]):
            return False, "view-extra-key"
        a, d = args.get("action"), args.get("direction")
        allowed = {
            "orbit":{"left","right","up","down","clockwise","counterclockwise"},
            "pan":{"left","right","up","down"},
            "zoom":{"in","out"},
        }
        if a not in allowed or d not in allowed[a]:
            return False, "view-action-direction"
        if "intensity" in args and not isinstance(args["intensity"], (int,float)):
            return False, "intensity-type"
        if "angle_degrees" in args and not isinstance(args["angle_degrees"], (int,float)):
            return False, "angle-type"
        return True, "ok"

    if op == "view.fit":
        return (keys(["action"]) and args.get("action") in {"fit","fit_selection"}, "fit")
    if op == "view.standard":
        return (keys(["view"]) and args.get("view") == "top", "standard")
    if op == "viewer.selection.clear":
        return (not args, "selection-clear")
    if op == "viewer.inspect":
        return (keys(["mode"]) and args.get("mode") in {"state","selection","collaboration"}, "inspect")
    if op == "view.follow":
        if not keys(["candidate_index"]):
            return False, "follow-extra-key"
        if "candidate_index" in args and not isinstance(args["candidate_index"], int):
            return False, "follow-index-type"
        if ctx.get("collaborator_count", 0) >= 3 and "candidate_index" not in args:
            return False, "follow-ambiguous"
        return True, "ok"
    if op == "feature.from_selection":
        if not keys(["feature_type","amount"]):
            return False, "from-selection-extra-key"
        if args.get("feature_type") not in {"fillet","chamfer"} or not isinstance(args.get("amount"), str):
            return False, "from-selection-shape"
        if ctx.get("selection_count", 0) <= 0:
            return False, "from-selection-ungrounded"
        return True, "ok"
    if op == "feature.parameter.set":
        if not keys(["feature_name","parameter","amount","value"]):
            return False, "parameter-extra-key"
        if not isinstance(args.get("feature_name"), str) or not isinstance(args.get("parameter"), str):
            return False, "parameter-target"
        if ("amount" in args) == ("value" in args):
            return False, "parameter-value-cardinality"
        return True, "ok"
    if op == "feature.patch":
        if not keys(["feature_name","suppressed","new_name"]):
            return False, "patch-extra-key"
        if not isinstance(args.get("feature_name"), str):
            return False, "patch-target"
        if "suppressed" not in args and "new_name" not in args:
            return False, "patch-no-change"
        if "suppressed" in args and not isinstance(args["suppressed"], bool):
            return False, "suppressed-type"
        return True, "ok"
    if op == "feature.delete":
        if not keys(["feature_name","position"]):
            return False, "delete-extra-key"
        if ("feature_name" in args) == ("position" in args):
            return False, "delete-target-cardinality"
        if "position" in args and args["position"] not in {"last","first"}:
            return False, "delete-position"
        return True, "ok"
    if op == "feature.delete_part":
        return (keys(["part_name"]) and isinstance(args.get("part_name"), str), "delete-part")
    if op == "feature.add":
        if not keys(["feature_type","name","part_name","copies","distance","amount","target"]):
            return False, "add-extra-key"
        ft = args.get("feature_type")
        if ft not in {"plane","linearPattern","fillet","chamfer"}:
            return False, "add-feature-type"
        if "copies" in args and not isinstance(args["copies"], int):
            return False, "copies-type"
        if ft == "linearPattern":
            for k in ("part_name","copies","distance"):
                if k not in args:
                    return False, "pattern-missing-"+k
        if ft in {"fillet","chamfer"} and "amount" not in args:
            return False, "edge-feature-missing-amount"
        return True, "ok"
    if op == "feature.reorder":
        if not keys(["source_feature","target_feature","placement"]):
            return False, "reorder-extra-key"
        return (
            isinstance(args.get("source_feature"), str)
            and isinstance(args.get("target_feature"), str)
            and args.get("placement") in {"before","after"},
            "reorder",
        )
    if op == "part.visibility":
        return (
            keys(["part_name","visible"])
            and isinstance(args.get("part_name"), str)
            and isinstance(args.get("visible"), bool),
            "visibility",
        )
    if op == "metadata.property.set":
        if not keys(["part_name","property","value"]):
            return False, "metadata-extra-key"
        if not isinstance(args.get("property"), str) or "value" not in args:
            return False, "metadata-shape"
        return True, "ok"
    if op == "rollback.set":
        if not keys(["before_feature","after_feature","position"]):
            return False, "rollback-extra-key"
        present = [k for k in ("before_feature","after_feature","position") if k in args]
        if len(present) != 1:
            return False, "rollback-cardinality"
        if "position" in args and args["position"] not in {"start","end"}:
            return False, "rollback-position"
        return True, "ok"
    if op == "documented.createPartStudio":
        return (keys(["new_name"]) and isinstance(args.get("new_name"), str), "create-ps")
    if op == "documented.updateDocumentAttributes":
        return (keys(["new_name"]) and isinstance(args.get("new_name"), str), "doc-attrs")
    if op == "documented.updateWVEPMetadata":
        return (
            keys(["part_name","property","value"])
            and isinstance(args.get("part_name"), str)
            and isinstance(args.get("property"), str)
            and "value" in args,
            "wvep-metadata",
        )
    return False, "unhandled-op"

def normalize_recipe(recipe):
    if not isinstance(recipe, dict):
        return recipe
    out = {"route": recipe.get("route"), "op": recipe.get("op"), "args": {}}
    args = recipe.get("args")
    if isinstance(args, dict):
        for k in sorted(args):
            v = args[k]
            out["args"][k] = norm_scalar(v)
    return out

def classify_miss(case, recipe, valid, correct):
    if correct and valid:
        return "correct"
    gold_routes = {x.get("route") for x in case["expected"]}
    got_route = recipe.get("route") if isinstance(recipe, dict) else None
    if not valid:
        return "contract_invalid"
    if got_route == "do" and gold_routes <= {"ask","think"}:
        return "false_execute"
    if "do" in gold_routes and got_route in {"ask","think"}:
        return "conservative_escalation"
    if "do" in gold_routes and got_route == "do":
        op = recipe.get("op")
        if op in {"view.move","view.fit","view.standard","viewer.selection.clear","viewer.inspect","view.follow"}:
            return "wrong_reversible_recipe"
        return "wrong_material_recipe"
    return "route_mismatch"

def call_groq(key, case):
    body = {
        "model": MODEL,
        "messages": [
            {"role":"system","content":SYSTEM},
            {"role":"user","content":json.dumps(
                {"command":case["text"],"context":case.get("ctx",{})},
                ensure_ascii=False,
                separators=(",",":"),
            )},
        ],
        "reasoning_effort":"low",
        "temperature":0,
        "max_completion_tokens":140,
        "response_format":{"type":"json_object"},
    }
    req = urllib.request.Request(
        ENDPOINT,
        data=json.dumps(body,ensure_ascii=False).encode("utf-8"),
        headers={
            "Authorization":"Bearer "+key,
            "Content-Type":"application/json",
            "User-Agent":"cf-exec-plane-onshape-router-benchmark/3.0",
        },
        method="POST",
    )
    t0 = time.perf_counter()
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            raw = resp.read().decode("utf-8")
            ms = (time.perf_counter()-t0)*1000
            data = json.loads(raw)
            output = json.loads(data["choices"][0]["message"]["content"])
            usage = data.get("usage",{})
            headers = {
                k.lower():v for k,v in resp.headers.items()
                if k.lower().startswith("x-ratelimit") or k.lower()=="retry-after"
            }
            return {"ok":True,"latency_ms":ms,"output":output,"usage":usage,"headers":headers}
    except urllib.error.HTTPError as e:
        ms=(time.perf_counter()-t0)*1000
        txt=e.read().decode("utf-8","replace")
        return {
            "ok":False,
            "latency_ms":ms,
            "error":f"HTTP {e.code}: {txt[:1200]}",
            "status":e.code,
            "retry_after":e.headers.get("retry-after"),
        }
    except Exception as e:
        return {"ok":False,"latency_ms":(time.perf_counter()-t0)*1000,"error":repr(e)}

def call_with_retry(key, case):
    last = None
    for attempt in range(MAX_RETRIES):
        last = call_groq(key, case)
        if last.get("ok"):
            return last
        status = last.get("status")
        if status not in {429,500,502,503,504}:
            return last
        wait = 8.0 * (attempt + 1)
        if last.get("retry_after"):
            try:
                wait = max(wait, float(last["retry_after"]) + 0.5)
            except Exception:
                pass
        time.sleep(wait)
    return last

def percentile(values, p):
    if not values:
        return None
    s = sorted(values)
    idx = max(0, min(len(s)-1, int(round((len(s)-1)*p))))
    return s[idx]

def summarize(rows):
    good = [r for r in rows if r.get("ok")]
    lats = [r["latency_ms"] for r in good]
    valid = [r for r in good if r.get("valid")]
    correct = [r for r in good if r.get("correct")]
    safe_correct = [r for r in good if r.get("correct") and r.get("valid")]
    miss_counts = {}
    for r in rows:
        miss_counts[r.get("miss_class","api_failure")] = miss_counts.get(r.get("miss_class","api_failure"),0)+1

    categories = {}
    for cat in sorted({r["category"] for r in rows}):
        cr = [r for r in rows if r["category"] == cat]
        categories[cat] = {
            "n": len(cr),
            "api_success": sum(bool(x.get("ok")) for x in cr),
            "gold_correct": sum(bool(x.get("correct")) for x in cr),
            "valid_and_correct": sum(bool(x.get("correct") and x.get("valid")) for x in cr),
            "false_execute": sum(x.get("miss_class") == "false_execute" for x in cr),
        }

    return {
        "model": MODEL,
        "requests": len(rows),
        "api_success": len(good),
        "gold_correct": len(correct),
        "gold_accuracy": len(correct)/len(rows) if rows else 0,
        "contract_valid": len(valid),
        "contract_valid_rate": len(valid)/len(rows) if rows else 0,
        "valid_and_correct": len(safe_correct),
        "valid_and_correct_rate": len(safe_correct)/len(rows) if rows else 0,
        "p50_ms": statistics.median(lats) if lats else None,
        "p95_ms": percentile(lats, 0.95),
        "p99_ms": percentile(lats, 0.99),
        "mean_ms": statistics.mean(lats) if lats else None,
        "input_tokens": sum((r.get("usage",{}).get("prompt_tokens") or 0) for r in good),
        "output_tokens": sum((r.get("usage",{}).get("completion_tokens") or 0) for r in good),
        "miss_classes": miss_counts,
        "categories": categories,
    }

def main():
    outdir = os.environ.get("OUT_DIR","artifacts/onshape-fast-router-groq-v02")
    os.makedirs(outdir, exist_ok=True)
    key = os.environ.get("GROQ_API_KEY","").strip()
    if not key:
        raise SystemExit("GROQ_API_KEY missing")

    warm = call_with_retry(key, {"text":"از بالا نشون بده","ctx":{},"id":"warm"})
    if not warm.get("ok"):
        raise SystemExit("warmup failed: "+warm.get("error","unknown"))
    time.sleep(CASE_DELAY)

    rows = []
    by_id = {}
    for idx, case in enumerate(CASES):
        r = call_with_retry(key, case)
        row = {
            "category":case["category"],
            "id":case["id"],
            "text":case["text"],
            "ctx":case["ctx"],
            "expected":case["expected"],
            **r,
        }
        if r.get("ok"):
            valid, why = validate_recipe(r.get("output"), case.get("ctx",{}))
            correct = expected_match(case, r.get("output"))
            row["valid"] = bool(valid)
            row["validation"] = why
            row["correct"] = bool(correct)
            row["miss_class"] = classify_miss(case, r.get("output"), valid, correct)
            row["normalized_output"] = normalize_recipe(r.get("output"))
        else:
            row["valid"] = False
            row["correct"] = False
            row["miss_class"] = "api_failure"
        rows.append(row)
        by_id[case["id"]] = row
        print(json.dumps({
            "i":idx+1,
            "n":len(CASES),
            "id":case["id"],
            "ok":row.get("ok"),
            "valid":row.get("valid"),
            "correct":row.get("correct"),
            "miss":row.get("miss_class"),
            "latency_ms":round(row.get("latency_ms",0),1),
        },ensure_ascii=False))
        if idx != len(CASES)-1:
            time.sleep(CASE_DELAY)

    stability = []
    for sid in STABILITY_IDS:
        case = next(c for c in CASES if c["id"] == sid)
        time.sleep(CASE_DELAY)
        r = call_with_retry(key, case)
        first = by_id[sid]
        same = bool(
            r.get("ok")
            and first.get("ok")
            and normalize_recipe(r.get("output")) == first.get("normalized_output")
        )
        stability.append({
            "id":sid,
            "same_as_first":same,
            "first":first.get("output"),
            "repeat":r.get("output"),
            "repeat_latency_ms":r.get("latency_ms"),
            "ok":r.get("ok"),
            "error":r.get("error"),
        })

    summary = summarize(rows)
    summary["warmup_latency_ms"] = warm.get("latency_ms")
    summary["stability_repeats"] = len(stability)
    summary["stability_same"] = sum(x["same_as_first"] for x in stability)
    summary["stability_rate"] = summary["stability_same"]/len(stability)

    with open(os.path.join(outdir,"summary.json"),"w",encoding="utf-8") as f:
        json.dump(summary,f,ensure_ascii=False,indent=2)
    with open(os.path.join(outdir,"rows.json"),"w",encoding="utf-8") as f:
        json.dump(rows,f,ensure_ascii=False,indent=2)
    with open(os.path.join(outdir,"stability.json"),"w",encoding="utf-8") as f:
        json.dump(stability,f,ensure_ascii=False,indent=2)

    print("FINAL_SUMMARY="+json.dumps(summary,ensure_ascii=False,sort_keys=True))
    return 0 if len([r for r in rows if not r.get("ok")]) == 0 else 1

if __name__ == "__main__":
    raise SystemExit(main())
