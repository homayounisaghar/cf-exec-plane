CASES=[]

def add(cat,cid,text,expected,ctx=None):
    CASES.append({"category":cat,"id":cid,"text":text,"ctx":ctx or {},"expected":expected if isinstance(expected,list) else [expected]})
def do(op,args=None): return {"route":"do","op":op,"args":args or {}}
def ask(): return {"route":"ask"}
def think(): return {"route":"think"}

# Camera / viewer: 14
add("camera","v08_c01","مدل رو یه خورده به راست بچرخون",do("view.move",{"action":"orbit","direction":"right"}))
add("camera","v08_c02","یکم rotate left",do("view.move",{"action":"orbit","direction":"left"}))
add("camera","v08_c03","یه ذره ساعتگرد",do("view.move",{"action":"orbit","direction":"clockwise"}))
add("camera","v08_c04","پادساعتگرد بچرخونش",do("view.move",{"action":"orbit","direction":"counterclockwise"}))
add("camera","v08_c05","۴۵ درجه سمت راست بچرخون",do("view.move",{"action":"orbit","direction":"right","angle_degrees":45}))
add("camera","v08_c06","نما رو بکش پایین",do("view.move",{"action":"pan","direction":"down"}))
add("camera","v08_c07","pan left کن",do("view.move",{"action":"pan","direction":"left"}))
add("camera","v08_c08","یه کم zoom in",do("view.move",{"action":"zoom","direction":"in"}))
add("camera","v08_c09","زوم اوت کن",do("view.move",{"action":"zoom","direction":"out"}))
add("camera","v08_c10","کل قطعه رو توی کادر جا بده",do("view.fit",{"action":"fit"}))
add("camera","v08_c11","روی چیزایی که انتخاب کردم fit کن",do("view.fit",{"action":"fit_selection"}),{"selection_count":2,"selection_types":["edge","edge"]})
add("camera","v08_c12","نمای بالا رو بیار",do("view.standard",{"view":"top"}))
add("camera","v08_c13","selection رو پاک کن",do("viewer.selection.clear",{}))
add("camera","v08_c14","نمای front رو بده",ask())

# Inspect / follow: 6
add("inspect","v08_i01","الان چی انتخاب کردم؟",do("viewer.inspect",{"mode":"selection"}))
add("inspect","v08_i02","وضعیت viewer الان چطوره",do("viewer.inspect",{"mode":"state"}))
add("inspect","v08_i03","ببین توی سشن چند نفریم",do("viewer.inspect",{"mode":"collaboration"}))
add("inspect","v08_i04","طرف مقابلم رو فالو کن",do("view.follow",{}),{"collaborator_count":2})
add("inspect","v08_i05","نفر دوم رو دنبال کن",do("view.follow",{"candidate_index":2}),{"collaborator_count":3})
add("inspect","v08_i06","یکی از اون دوتا رو دنبال کن",ask(),{"collaborator_count":3})

# Edge / selection: 12
add("edge","v08_e01","روی این لبه ها فیلت یک میل",do("feature.from_selection",{"feature_type":"fillet","amount":"1 mm"}),{"selection_count":2,"selection_types":["edge","edge"]})
add("edge","v08_e02","این انتخاب رو چمفر دو میل کن",do("feature.from_selection",{"feature_type":"chamfer","amount":"2 mm"}),{"selection_count":1,"selection_types":["edge"]})
add("edge","v08_e03","پخ یک و هفتاد و پنج صدم میلی روی همینا",do("feature.from_selection",{"feature_type":"chamfer","amount":"1.75 mm"}),{"selection_count":2,"selection_types":["edge","edge"]})
add("edge","v08_e04","فیلت چهار دهم روی انتخاب",do("feature.from_selection",{"feature_type":"fillet","amount":"0.4 mm"}),{"selection_count":1,"selection_types":["edge"]})
add("edge","v08_e05","فیلت ۲.۵ میلی روی این دوتا",do("feature.from_selection",{"feature_type":"fillet","amount":"2.5 mm"}),{"selection_count":2,"selection_types":["edge","edge"]})
add("edge","v08_e06","پخ نیم میل روی همین انتخاب",do("feature.from_selection",{"feature_type":"chamfer","amount":"0.5 mm"}),{"selection_count":1,"selection_types":["edge"]})
add("edge","v08_e07","این انتخاب رو chamfer کن",ask(),{"selection_count":2,"selection_types":["edge","edge"]})
add("edge","v08_e08","سه میل فیلت بزن",ask(),{"selection_count":0})
add("edge","v08_e09","یه fillet خالی شش میل بساز",do("feature.add",{"feature_type":"fillet","amount":"6 mm"}))
add("edge","v08_e10","یه پخ جدید نیم میل بدون لبه بساز",do("feature.add",{"feature_type":"chamfer","amount":"0.5 mm"}))
add("edge","v08_e11","دو میل فیلت کن بعد یک میل پخ",ask(),{"selection_count":2,"selection_types":["edge","edge"]})
add("edge","v08_e12","فیلت کن و بعد مخفیش کن",ask(),{"selection_count":1,"selection_types":["edge"],"last_part":"Part 3"})

# Feature edits: 14
add("feature","v08_f01","Fillet 2 شعاعش بشه ۸ میل",do("feature.parameter.set",{"feature_name":"Fillet 2","parameter":"radius","amount":"8 mm"}))
add("feature","v08_f02","عمق Extrude 5 رو پانزده میل بذار",do("feature.parameter.set",{"feature_name":"Extrude 5","parameter":"depth","amount":"15 mm"}))
add("feature","v08_f03","Extrude 5 رو پانزده میل کن",ask())
add("feature","v08_f04","Draft 3 رو روی ۹ درجه بذار",ask())
add("feature","v08_f05","زاویه Draft 3 رو نه درجه کن",do("feature.parameter.set",{"feature_name":"Draft 3","parameter":"angle","amount":"9 deg"}))
add("feature","v08_f06","این فیلت رو دو میل بیشترش کن",do("feature.parameter.set",{"feature_name":"Fillet 1","parameter":"radius","amount":"7 mm"}),{"last_feature":"Fillet 1","feature_parameters":{"radius":"5 mm"}})
add("feature","v08_f07","این فیلت رو یک میل کمتر کن",do("feature.parameter.set",{"feature_name":"Fillet 1","parameter":"radius","amount":"4 mm"}),{"last_feature":"Fillet 1","feature_parameters":{"radius":"5 mm"}})
add("feature","v08_f08","این اکسترود رو یه کم بیشتر کن",ask(),{"last_feature":"Extrude 1","feature_parameters":{"depth":"20 mm"}})
add("feature","v08_f09","Extrude 6 رو خاموش کن",do("feature.patch",{"feature_name":"Extrude 6","suppressed":True}))
add("feature","v08_f10","Extrude 6 رو unsuppress کن",do("feature.patch",{"feature_name":"Extrude 6","suppressed":False}))
add("feature","v08_f11","اسم Fillet 7 رو بذار نرم کن",do("feature.patch",{"feature_name":"Fillet 7","new_name":"نرم کن"}))
add("feature","v08_f12","آخرین فیچر رو حذف کن",do("feature.delete",{"position":"last"}))
add("feature","v08_f13","Extrude 7 رو پاک کن",do("feature.delete",{"feature_name":"Extrude 7"}))
add("feature","v08_f14","flip direction برای Extrude 2 off باشه",do("feature.parameter.set",{"feature_name":"Extrude 2","parameter":"flip direction","value":False}))

# Parts / metadata: 12
add("part","v08_p01","Part 3 رو hide کن",do("part.visibility",{"part_name":"Part 3","visible":False}))
add("part","v08_p02","Part 3 رو دوباره show کن",do("part.visibility",{"part_name":"Part 3","visible":True}))
add("part","v08_p03","Cap رو نشون نده",do("part.visibility",{"part_name":"Cap","visible":False}))
add("part","v08_p04","Cap رو سبز کن",do("metadata.property.set",{"part_name":"Cap","property":"color","value":"green"}))
add("part","v08_p05","Part 6 رو مشکی کن",do("metadata.property.set",{"part_name":"Part 6","property":"color","value":"black"}))
add("part","v08_p06","اسم Part 8 بشه cover",do("metadata.property.set",{"part_name":"Part 8","property":"name","value":"cover"}))
add("part","v08_p07","متریال Part 4 رو آلومینیوم کن",do("metadata.property.set",{"part_name":"Part 4","property":"material","value":"Aluminum"}))
add("part","v08_p08","description Part 4 رو بذار outer cover",do("metadata.property.set",{"part_name":"Part 4","property":"description","value":"outer cover"}))
add("part","v08_p09","Part 9 رو حذف کن",do("feature.delete_part",{"part_name":"Part 9"}))
add("part","v08_p10","همین پارت رو پاک کن",do("feature.delete_part",{"part_name":"Part 5"}),{"last_part":"Part 5"})
add("part","v08_p11","Part 3 رو آبی کن و قایمش کن",ask())
add("part","v08_p12","اسم همین پارت رو عوض کن",ask(),{"last_part":"Part 3"})

# Create / order / document: 12
add("doc","v08_d01","یه صفحه مرجع خالی بساز",do("feature.add",{"feature_type":"plane"}))
add("doc","v08_d02","یه plane به اسم datum side بساز",do("feature.add",{"feature_type":"plane","name":"datum side"}))
add("doc","v08_d03","plane روی Right درست کن",ask())
add("doc","v08_d04","Part 2 رو linear pattern چهار تایی با فاصله ۱۲ میل کن",do("feature.add",{"feature_type":"linearPattern","part_name":"Part 2","copies":4,"distance":"12 mm"}))
add("doc","v08_d05","Part 2 رو چهارتا کن هر دوازده میل",ask())
add("doc","v08_d06","Fillet 3 رو بالای Extrude 6 ببر",do("feature.reorder",{"source_feature":"Fillet 3","target_feature":"Extrude 6","placement":"before"}))
add("doc","v08_d07","Extrude 6 رو زیر Sketch 4 بذار",do("feature.reorder",{"source_feature":"Extrude 6","target_feature":"Sketch 4","placement":"after"}))
add("doc","v08_d08","rollback قبل Extrude 4",do("rollback.set",{"before_feature":"Extrude 4"}))
add("doc","v08_d09","rollback رو ببر آخر",do("rollback.set",{"position":"end"}))
add("doc","v08_d10","یه Part Studio بساز به اسم fit test",do("documented.createPartStudio",{"new_name":"fit test"}))
add("doc","v08_d11","اسم document بشه shell final",do("documented.updateDocumentAttributes",{"new_name":"shell final"}))
add("doc","v08_d12","rename document to shell archive",do("documented.updateDocumentAttributes",{"new_name":"shell archive"}))

# Escalation / ambiguity: 10
add("escalate","v08_x01","این قسمت رو طوری بهتر کن که محکم تر باشه",think())
add("escalate","v08_x02","وزن قطعه رو کم کن ولی ضعیف نشه",think())
add("escalate","v08_x03","برای تولید انبوه مناسب ترش کن",think())
add("escalate","v08_x04","فیچرهای غیرضروری رو تمیز کن",think())
add("escalate","v08_x05","اون رو حذف کن",ask())
add("escalate","v08_x06","نیم میلش کن",ask())
add("escalate","v08_x07","همون کاری که قبلا کردی اینجا هم بکن",ask())
add("escalate","v08_x08","فایل STEP بده",ask())
add("escalate","v08_x09","share کن با تیم",ask())
add("escalate","v08_x10","داکیومنت رو public کن",ask())

assert len(CASES)==80, len(CASES)
