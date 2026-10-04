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
