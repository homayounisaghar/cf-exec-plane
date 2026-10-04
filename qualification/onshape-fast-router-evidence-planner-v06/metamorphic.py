CASES = []

def add(cid, text, expected, ctx=None, group=None):
    CASES.append({
        "category": "metamorphic",
        "id": cid,
        "text": text,
        "ctx": ctx or {},
        "expected": expected if isinstance(expected, list) else [expected],
        "group": group,
    })

def do(op, args=None):
    return {"route": "do", "op": op, "args": args or {}}

def ask():
    return {"route": "ask"}

def think():
    return {"route": "think"}

# Numeric equivalence: digit vs colloquial Persian fractions.
add("meta_num_01", "همین دوتا رو 2.5 mm فیلت کن",
    do("feature.from_selection", {"feature_type":"fillet","amount":"2.5 mm"}),
    {"selection_count":2,"selection_types":["edge","edge"]}, "num_2_5")
add("meta_num_02", "همین دوتا رو دو و نیم میل فیلت کن",
    do("feature.from_selection", {"feature_type":"fillet","amount":"2.5 mm"}),
    {"selection_count":2,"selection_types":["edge","edge"]}, "num_2_5")
add("meta_num_03", "همین دوتا رو هشت دهم میل پخ بزن",
    do("feature.from_selection", {"feature_type":"chamfer","amount":"0.8 mm"}),
    {"selection_count":2,"selection_types":["edge","edge"]}, "num_0_8")
add("meta_num_04", "همین دوتا رو 0.8 میلی چمفر کن",
    do("feature.from_selection", {"feature_type":"chamfer","amount":"0.8 mm"}),
    {"selection_count":2,"selection_types":["edge","edge"]}, "num_0_8")
add("meta_num_05", "همین دوتا رو یک و بیست و پنج صدم میلی پخ بزن",
    do("feature.from_selection", {"feature_type":"chamfer","amount":"1.25 mm"}),
    {"selection_count":2,"selection_types":["edge","edge"]}, "num_1_25")
add("meta_num_06", "همین دوتا رو 1.25 mm چمفر کن",
    do("feature.from_selection", {"feature_type":"chamfer","amount":"1.25 mm"}),
    {"selection_count":2,"selection_types":["edge","edge"]}, "num_1_25")

# Negation/state flip must be exact.
add("meta_vis_01", "Part 4 رو نشون بده", do("part.visibility", {"part_name":"Part 4","visible":True}), group="vis_flip")
add("meta_vis_02", "Part 4 رو نشون نده", do("part.visibility", {"part_name":"Part 4","visible":False}), group="vis_flip")
add("meta_vis_03", "Part 4 رو قایم کن", do("part.visibility", {"part_name":"Part 4","visible":False}), group="vis_hide_syn")
add("meta_vis_04", "Part 4 رو مخفی کن", do("part.visibility", {"part_name":"Part 4","visible":False}), group="vis_hide_syn")

# Relative edits use context as the base; they are never absolute model guesses.
ctx_radius = {"last_feature":"Fillet 2","feature_parameters":{"radius":"3 mm"}}
add("meta_rel_01", "یه میل بیشترش کن",
    do("feature.parameter.set", {"feature_name":"Fillet 2","parameter":"radius","amount":"4 mm"}),
    ctx_radius, "relative")
add("meta_rel_02", "یه میل کمترش کن",
    do("feature.parameter.set", {"feature_name":"Fillet 2","parameter":"radius","amount":"2 mm"}),
    ctx_radius, "relative")
add("meta_rel_03", "یه کم بیشترش کن", ask(), ctx_radius, "relative_vague")

# Reorder relation flip.
add("meta_order_01", "Fillet 1 رو قبل از Extrude 2 ببر",
    do("feature.reorder", {"source_feature":"Fillet 1","target_feature":"Extrude 2","placement":"before"}),
    group="order_flip")
add("meta_order_02", "Fillet 1 رو بعد از Extrude 2 ببر",
    do("feature.reorder", {"source_feature":"Fillet 1","target_feature":"Extrude 2","placement":"after"}),
    group="order_flip")
add("meta_order_03", "Fillet 1 رو بالای Extrude 2 ببر",
    do("feature.reorder", {"source_feature":"Fillet 1","target_feature":"Extrude 2","placement":"before"}),
    group="order_syn")
add("meta_order_04", "Fillet 1 رو زیر Extrude 2 ببر",
    do("feature.reorder", {"source_feature":"Fillet 1","target_feature":"Extrude 2","placement":"after"}),
    group="order_syn")

# Camera correction is the inverse of the verified previous move.
ctx_move = {"last_move":{"action":"orbit","direction":"right","intensity":0.4}}
add("meta_cam_01", "باز یه ذره همون طرف",
    do("view.move", {"action":"orbit","direction":"right"}), ctx_move, "camera_inverse")
add("meta_cam_02", "زیادی شد، برش گردون",
    do("view.move", {"action":"orbit","direction":"left"}), ctx_move, "camera_inverse")
add("meta_cam_03", "یه ربع دور به راست بچرخون",
    do("view.move", {"action":"orbit","direction":"right","angle_degrees":90}), group="camera_quarter")

# Multi-action residue must fail closed rather than executing a subset.
add("meta_multi_01", "Part 1 رو قرمز کن و مخفیش کن", ask(), group="multi_block")
add("meta_multi_02", "این دوتا رو دو میل فیلت و بعد یه میل پخ بزن", ask(),
    {"selection_count":2,"selection_types":["edge","edge"]}, "multi_block")

# Design language must leave the fast lane.
add("meta_design_01", "این رو حرفه‌ای‌ترش کن", think(), group="design")
add("meta_design_02", "وزنشو کم کن ولی سفت بمونه", think(), group="design")
add("meta_design_03", "برای تولید راحت‌ترش کن", think(), group="design")

# Name/identity forms should normalize without model-created targets.
add("meta_id_01", "فیلت سه رو شش میل کن",
    do("feature.parameter.set", {"feature_name":"Fillet 3","parameter":"radius","amount":"6 mm"}), group="feature_name")
add("meta_id_02", "Fillet 3 رو 6 mm کن",
    do("feature.parameter.set", {"feature_name":"Fillet 3","parameter":"radius","amount":"6 mm"}), group="feature_name")
add("meta_id_03", "پارت چهار رو قایم کن",
    do("part.visibility", {"part_name":"Part 4","visible":False}), group="part_name")
add("meta_id_04", "Part 4 رو قایم کن",
    do("part.visibility", {"part_name":"Part 4","visible":False}), group="part_name")

assert len(CASES) == 29, len(CASES)
