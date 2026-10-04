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
    return {"route":"do","op":op,"args":args or {}}

def ask():
    return {"route":"ask"}

def think():
    return {"route":"think"}

# 1) Camera / view — 20
add("camera","fresh_cam_01","مدل رو یه کوچولو بپیچون سمت راست",do("view.move",{"action":"orbit","direction":"right"}))
add("camera","fresh_cam_02","یه خرده بچرخونش سمت چپ",do("view.move",{"action":"orbit","direction":"left"}))
add("camera","fresh_cam_03","نمای کارو کمی هل بده پایین",do("view.move",{"action":"pan","direction":"down"}))
add("camera","fresh_cam_04","صفحه رو یه ذره بکش بالا",do("view.move",{"action":"pan","direction":"up"}))
add("camera","fresh_cam_05","zoom in یه کوچولو",do("view.move",{"action":"zoom","direction":"in"}))
add("camera","fresh_cam_06","یه مقدار zoom out",do("view.move",{"action":"zoom","direction":"out"}))
add("camera","fresh_cam_07","چهل و پنج درجه به چپ بچرخون",do("view.move",{"action":"orbit","direction":"left","angle_degrees":45}))
add("camera","fresh_cam_08","نیم دور ساعتگرد بچرخون",do("view.move",{"action":"orbit","direction":"clockwise","angle_degrees":180}))
add("camera","fresh_cam_09","کلشو جمع کن تو کادر",do("view.fit",{"action":"fit"}))
add("camera","fresh_cam_10","انتخاب فعلی رو تو کادر جا بده",do("view.fit",{"action":"fit_selection"}),{"selection_count":1,"selection_types":["face"]})
add("camera","fresh_cam_11","نمای بالا رو بیار",do("view.standard",{"view":"top"}))
add("camera","fresh_cam_12","سلکشن رو خالی کن",do("viewer.selection.clear"))
add("camera","fresh_cam_13","یه ذره دیگه همونجوری",do("view.move",{"action":"orbit","direction":"left"}),{"last_move":{"action":"orbit","direction":"left","intensity":0.25}})
add("camera","fresh_cam_14","نه نه برگرد، زیادی رفت",do("view.move",{"action":"orbit","direction":"right"}),{"last_move":{"action":"orbit","direction":"left","intensity":0.7}})
add("camera","fresh_cam_15","همون زوم رو باز یه کم بیشتر کن",do("view.move",{"action":"zoom","direction":"in"}),{"last_move":{"action":"zoom","direction":"in","intensity":0.25}})
add("camera","fresh_cam_16","از زومی که کردی یه کم عقب بیا",do("view.move",{"action":"zoom","direction":"out"}),{"last_move":{"action":"zoom","direction":"in","intensity":0.5}})
add("camera","fresh_cam_17","نمای جلو رو بده",ask())
add("camera","fresh_cam_18","یه نمای ایزومتریک بده",ask())
add("camera","fresh_cam_19","فقط همین انتخابو فیت کن",ask(),{"selection_count":0})
add("camera","fresh_cam_20","یه کم نزدیک‌ترش کن",do("view.move",{"action":"zoom","direction":"in"}),{"last_move":{"action":"zoom","direction":"in","intensity":0.2}})

# 2) Inspect / follow — 10
add("inspect","fresh_ins_01","ببین چی الان select شده",do("viewer.inspect",{"mode":"selection"}))
add("inspect","fresh_ins_02","یه وضعیت از viewer بده",do("viewer.inspect",{"mode":"state"}))
add("inspect","fresh_ins_03","الان چند نفریم توی session؟",do("viewer.inspect",{"mode":"collaboration"}))
add("inspect","fresh_ins_04","اون یکی آدمو follow کن",do("view.follow"),{"collaborator_count":2})
add("inspect","fresh_ins_05","سومی رو فالو کن",do("view.follow",{"candidate_index":3}),{"collaborator_count":4})
add("inspect","fresh_ins_06","یکی از بقیه رو فالو کن",ask(),{"collaborator_count":4})
add("inspect","fresh_ins_07","این وجه رو انتخاب کن",ask(),{"selection_count":0})
add("inspect","fresh_ins_08","اون edge کناری رو هم بگیر",ask(),{"selection_count":1})
add("inspect","fresh_ins_09","selection فعلی چیه؟",do("viewer.inspect",{"mode":"selection"}))
add("inspect","fresh_ins_10","همه انتخابا رو clear کن",do("viewer.selection.clear"))

# 3) Feature from current selection — 16
add("selection","fresh_sel_01","روی این لبه‌ها یک و نیم میل fillet بزن",do("feature.from_selection",{"feature_type":"fillet","amount":"1.5 mm"}),{"selection_count":2,"selection_types":["edge","edge"]})
add("selection","fresh_sel_02","این انتخابو سه دهم میل پخ بزن",do("feature.from_selection",{"feature_type":"chamfer","amount":"0.3 mm"}),{"selection_count":2,"selection_types":["edge","edge"]})
add("selection","fresh_sel_03","همین edgeها رو 2.2mm فیلت کن",do("feature.from_selection",{"feature_type":"fillet","amount":"2.2 mm"}),{"selection_count":3,"selection_types":["edge","edge","edge"]})
add("selection","fresh_sel_04","چمفر یک و هفتاد و پنج صدم میلی روی همین انتخاب",do("feature.from_selection",{"feature_type":"chamfer","amount":"1.75 mm"}),{"selection_count":2,"selection_types":["edge","edge"]})
add("selection","fresh_sel_05","روی این فیس یه پخ دو میل بده",do("feature.from_selection",{"feature_type":"chamfer","amount":"2 mm"}),{"selection_count":1,"selection_types":["face"]})
add("selection","fresh_sel_06","اینارو نیم میل فیلت کن",do("feature.from_selection",{"feature_type":"fillet","amount":"0.5 mm"}),{"selection_count":2,"selection_types":["edge","edge"]})
add("selection","fresh_sel_07","همینارو یک میل chamfer",do("feature.from_selection",{"feature_type":"chamfer","amount":"1 mm"}),{"selection_count":2,"selection_types":["edge","edge"]})
add("selection","fresh_sel_08","این انتخابو فیلت بزن",ask(),{"selection_count":2,"selection_types":["edge","edge"]})
add("selection","fresh_sel_09","پخ دو میل بزن",ask(),{"selection_count":0})
add("selection","fresh_sel_10","روی همینا گردی بده یک میل",ask(),{"selection_count":2,"selection_types":["edge","edge"]})
add("selection","fresh_sel_11","این دو تا رو فیلت و پخ کن",ask(),{"selection_count":2,"selection_types":["edge","edge"]})
add("selection","fresh_sel_12","اول یک میل پخ بعد دو میل فیلت",ask(),{"selection_count":2,"selection_types":["edge","edge"]})
add("selection","fresh_sel_13","لبه‌های انتخابی رو ده صدم میلی chamfer کن",do("feature.from_selection",{"feature_type":"chamfer","amount":"0.1 mm"}),{"selection_count":2,"selection_types":["edge","edge"]})
add("selection","fresh_sel_14","فیلت 0.25 میل روی انتخاب فعلی",do("feature.from_selection",{"feature_type":"fillet","amount":"0.25 mm"}),{"selection_count":1,"selection_types":["edge"]})
add("selection","fresh_sel_15","همین دوتا رو چهار میل پخ بزن",do("feature.from_selection",{"feature_type":"chamfer","amount":"4 mm"}),{"selection_count":2,"selection_types":["edge","edge"]})
add("selection","fresh_sel_16","روی انتخاب فعلی یه fillet هفت دهم بزن",ask(),{"selection_count":2,"selection_types":["edge","edge"]})

# 4) Existing feature / part delete — 20
add("feature","fresh_feat_01","رادیوس Fillet 8 رو سه و نیم میل کن",do("feature.parameter.set",{"feature_name":"Fillet 8","parameter":"radius","amount":"3.5 mm"}))
add("feature","fresh_feat_02","شعاع فیلت دو بشه یک و ربع میل",ask())
add("feature","fresh_feat_03","عمق Extrude 3 رو بیست و پنج میل بذار",do("feature.parameter.set",{"feature_name":"Extrude 3","parameter":"depth","amount":"25 mm"}))
add("feature","fresh_feat_04","زاویه Draft 2 رو دوازده درجه کن",do("feature.parameter.set",{"feature_name":"Draft 2","parameter":"angle","amount":"12 deg"}))
add("feature","fresh_feat_05","Fillet 4 رو 2.75 میلی کن",do("feature.parameter.set",{"feature_name":"Fillet 4","parameter":"radius","amount":"2.75 mm"}))
add("feature","fresh_feat_06","نیم میل بهش اضافه کن",do("feature.parameter.set",{"feature_name":"Fillet 4","parameter":"radius","amount":"3.5 mm"}),{"last_feature":"Fillet 4","feature_parameters":{"radius":"3 mm"}})
add("feature","fresh_feat_07","نیم میل ازش کم کن",do("feature.parameter.set",{"feature_name":"Fillet 4","parameter":"radius","amount":"2.5 mm"}),{"last_feature":"Fillet 4","feature_parameters":{"radius":"3 mm"}})
add("feature","fresh_feat_08","یه کم بزرگ‌ترش کن",ask(),{"last_feature":"Fillet 4","feature_parameters":{"radius":"3 mm"}})
add("feature","fresh_feat_09","Extrude 6 رو suppress کن",do("feature.patch",{"feature_name":"Extrude 6","suppressed":True}))
add("feature","fresh_feat_10","Extrude 6 رو unsuppress کن",do("feature.patch",{"feature_name":"Extrude 6","suppressed":False}))
add("feature","fresh_feat_11","دوباره روشنش کن",do("feature.patch",{"feature_name":"Extrude 6","suppressed":False}),{"last_feature":"Extrude 6","last_action":"suppress"})
add("feature","fresh_feat_12","اسم Fillet 2 رو بذار گوشه نرم",do("feature.patch",{"feature_name":"Fillet 2","new_name":"گوشه نرم"}))
add("feature","fresh_feat_13","Fillet 7 رو بنداز دور",do("feature.delete",{"feature_name":"Fillet 7"}))
add("feature","fresh_feat_14","آخرین feature رو حذف کن",do("feature.delete",{"position":"last"}))
add("feature","fresh_feat_15","اولین فیچر رو پاکش کن",do("feature.delete",{"position":"first"}))
add("feature","fresh_feat_16","Part 5 رو پاک کن",do("feature.delete_part",{"part_name":"Part 5"}))
add("feature","fresh_feat_17","همین body رو حذف کن",do("feature.delete_part",{"part_name":"Part 2"}),{"last_part":"Part 2"})
add("feature","fresh_feat_18","Extrude 2 رو 8 میلی کن",ask())
add("feature","fresh_feat_19","flip direction اکسترود یک رو خاموش کن",do("feature.parameter.set",{"feature_name":"Extrude 1","parameter":"flip direction","value":False}))
add("feature","fresh_feat_20","این فیچرو یه جور دیگه تنظیم کن",ask(),{"last_feature":"Extrude 1"})

# 5) Part visibility / metadata — 14
add("part","fresh_part_01","Cap رو از دید قایم کن",do("part.visibility",{"part_name":"Cap","visible":False}))
add("part","fresh_part_02","Part 3 دیگه دیده نشه",do("part.visibility",{"part_name":"Part 3","visible":False}))
add("part","fresh_part_03","Part 3 رو دوباره نشونش بده",do("part.visibility",{"part_name":"Part 3","visible":True}))
add("part","fresh_part_04","اون پارت قبلی رو برگردون توی دید",do("part.visibility",{"part_name":"Cap","visible":True}),{"last_part":"Cap","last_action":"hide"})
add("part","fresh_part_05","Part 1 رو مشکی کن",do("metadata.property.set",{"part_name":"Part 1","property":"color","value":"black"}))
add("part","fresh_part_06","Cap رنگش زرد بشه",do("metadata.property.set",{"part_name":"Cap","property":"color","value":"yellow"}))
add("part","fresh_part_07","این پارتو سفید کن",do("metadata.property.set",{"part_name":"Part 2","property":"color","value":"white"}),{"last_part":"Part 2"})
add("part","fresh_part_08","متریال Part 1 رو فولاد بذار",do("metadata.property.set",{"part_name":"Part 1","property":"material","value":"Steel"}))
add("part","fresh_part_09","متریالش آلومینیوم باشه",do("metadata.property.set",{"part_name":"Part 2","property":"material","value":"Aluminum"}),{"last_part":"Part 2"})
add("part","fresh_part_10","اسم Part 6 رو بذار shell",do("metadata.property.set",{"part_name":"Part 6","property":"name","value":"shell"}))
add("part","fresh_part_11","Part 2 اسمش بشه inner cover",do("metadata.property.set",{"part_name":"Part 2","property":"name","value":"inner cover"}))
add("part","fresh_part_12","description پارت Cap رو بذار sample lid",do("metadata.property.set",{"part_name":"Cap","property":"description","value":"sample lid"}))
add("part","fresh_part_13","قرمزش کن",ask())
add("part","fresh_part_14","Part 1 رو آبی کن و قایمش کن",ask())

# 6) Feature creation — 14
add("add","fresh_add_01","یه plane خالی بساز",do("feature.add",{"feature_type":"plane"}))
add("add","fresh_add_02","یه plane جدید بساز اسمش datum side",do("feature.add",{"feature_type":"plane","name":"datum side"}))
add("add","fresh_add_03","یه صفحه مرجع بساز به اسم datum B",do("feature.add",{"feature_type":"plane","name":"datum B"}))
add("add","fresh_add_04","Part 1 رو پنج تایی pattern کن با فاصله دوازده میل",do("feature.add",{"feature_type":"linearPattern","part_name":"Part 1","copies":5,"distance":"12 mm"}))
add("add","fresh_add_05","linear pattern برای Part 2، سه تا، گام 6.5mm",do("feature.add",{"feature_type":"linearPattern","part_name":"Part 2","copies":3,"distance":"6.5 mm"}))
add("add","fresh_add_06","از Cap چهار copies با فاصله نه میل pattern بزن",do("feature.add",{"feature_type":"linearPattern","part_name":"Cap","copies":4,"distance":"9 mm"}))
add("add","fresh_add_07","Part 1 رو pattern کن با فاصله ده میل",ask())
add("add","fresh_add_08","Part 2 رو شش تایی pattern کن",ask())
add("add","fresh_add_09","یه fillet خالی سه میل بساز",do("feature.add",{"feature_type":"fillet","amount":"3 mm"}))
add("add","fresh_add_10","یه پخ جدید 1.2 میلی بساز بدون انتخاب",do("feature.add",{"feature_type":"chamfer","amount":"1.2 mm"}))
add("add","fresh_add_11","یه فیلت جدید بساز بدون انتخاب",ask())
add("add","fresh_add_12","یه plane روی Front بساز",ask())
add("add","fresh_add_13","این face رو سوراخ پنج میل بزن",ask(),{"selection_count":1,"selection_types":["face"]})
add("add","fresh_add_14","Part 1 رو mirror کن",ask())

# 7) Reorder / rollback / document — 12
add("order","fresh_ord_01","Fillet 3 رو بالاتر از Extrude 4 ببر",do("feature.reorder",{"source_feature":"Fillet 3","target_feature":"Extrude 4","placement":"before"}))
add("order","fresh_ord_02","Extrude 4 رو زیر Sketch 1 بنداز",do("feature.reorder",{"source_feature":"Extrude 4","target_feature":"Sketch 1","placement":"after"}))
add("order","fresh_ord_03","این فیچر رو ببر قبل Fillet 8",do("feature.reorder",{"source_feature":"Extrude 2","target_feature":"Fillet 8","placement":"before"}),{"last_feature":"Extrude 2"})
add("order","fresh_ord_04","rollback رو بذار قبل از Sketch 3",do("rollback.set",{"before_feature":"Sketch 3"}))
add("order","fresh_ord_05","rollback رو بعد Fillet 2 بذار",do("rollback.set",{"after_feature":"Fillet 2"}))
add("order","fresh_ord_06","rollback تا ته",do("rollback.set",{"position":"end"}))
add("order","fresh_ord_07","rollback بره اول",do("rollback.set",{"position":"start"}))
add("order","fresh_ord_08","یه Part Studio تازه بساز اسمش sandbox",do("documented.createPartStudio",{"new_name":"sandbox"}))
add("order","fresh_ord_09","یه پارت استودیو جدید به اسم تست دوم بساز",do("documented.createPartStudio",{"new_name":"تست دوم"}))
add("order","fresh_ord_10","اسم document رو بذار Housing Rev C",do("documented.updateDocumentAttributes",{"new_name":"Housing Rev C"}))
add("order","fresh_ord_11","این داکیومنت اسمش بشه نمونه جدید",do("documented.updateDocumentAttributes",{"new_name":"نمونه جدید"}))
add("order","fresh_ord_12","Fillet 1 رو یه جایی بالاتر ببر",ask())

# 8) Design / ambiguity / unsupported — 14
add("escalation","fresh_esc_01","یه نسخه جمع و جورتر و حرفه‌ای‌ترش کن",think())
add("escalation","fresh_esc_02","سبک‌ترش کن ولی مقاومتش نریزه",think())
add("escalation","fresh_esc_03","برای پرینت سه بعدی بهترش کن",think())
add("escalation","fresh_esc_04","این گوشه رو طوری درست کن که قالب‌گیریش راحت باشه",think())
add("escalation","fresh_esc_05","فیچرهایی که به درد نمی‌خورن رو حذف کن",think())
add("escalation","fresh_esc_06","هرچی اضافه‌ست پاکش کن",think())
add("escalation","fresh_esc_07","اون رو حذف کن",ask())
add("escalation","fresh_esc_08","یه ذره بزرگ‌ترش کن",ask())
add("escalation","fresh_esc_09","همون قبلی رو برای اینم انجام بده",ask())
add("escalation","fresh_esc_10","ازش STEP خروجی بگیر",ask())
add("escalation","fresh_esc_11","یه PDF ازش بده",ask())
add("escalation","fresh_esc_12","این دو قطعه رو mate کن",ask())
add("escalation","fresh_esc_13","داکیومنتو با همه share کن",ask())
add("escalation","fresh_esc_14","کل مدل رو پاک کن",ask())

assert len(CASES) == 120, len(CASES)
