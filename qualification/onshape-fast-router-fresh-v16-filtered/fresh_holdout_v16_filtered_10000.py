from __future__ import annotations

CANDIDATES=[]
FAMILY_COUNTS={}

def do(op,args=None):
    return {"route":"do","op":op,"args":args or {}}

def ask():
    return {"route":"ask"}

def think():
    return {"route":"think"}

def add(category,cid,text,expected,ctx=None,axes=None,scope="apprentice",filter_reason=None):
    CANDIDATES.append({
        "category":category,
        "id":cid,
        "text":text,
        "ctx":ctx or {},
        "expected":expected if isinstance(expected,list) else [expected],
        "axes":axes or [],
        "scope":scope,
        "filter_reason":filter_reason,
    })
    FAMILY_COUNTS[category]=FAMILY_COUNTS.get(category,0)+1

OPENERS=[
    "","یه زحمت، ","لطف می‌کنی ","می‌تونی ","واسه من ","الان، ",
    "میشه لطف کنی ","اگه اوکیه ","یه کار کن: ","فقط اینو انجام بده: "
]
CLOSERS=[
    ""," مرسی"," ممنونت می‌شم"," لطف داری"," اگه زحمتی نیست",
    " همینو می‌خوام"," بعدش تموم"," لطفاً"," اگه اوکیه"," ممنون"
]

def style(core,i):
    o=OPENERS[i%10]
    c=CLOSERS[(i//10)%10]
    if (i//100)%2:
        return o+core+"؟"+c
    return o+core+c

def fa_digits(v):
    return str(v).translate(str.maketrans("0123456789.","۰۱۲۳۴۵۶۷۸۹٫"))

def amt(v,unit="mm"):
    return f"{('%g'%v)} {unit}"

parts=[f"Part {i}" for i in range(3,83)]

# 01 horizontal orbit
for i in range(200):
    d="left" if i%2==0 else "right"
    w="چپ" if d=="left" else "راست"
    forms=[
        f"دید رو با چرخش ببر سمت {w}",
        f"مدل رو افقی به {w} rotate کن",
        f"camera رو دور مدل به {w} بچرخون",
        f"یه orbit به {w} بده",
    ]
    add("orbit_horizontal",f"v16_orbh_{i:04d}",style(forms[(i//2)%4],i),
        do("view.move",{"action":"orbit","direction":d}),axes=["camera","orbit","horizontal","fresh_style"])

# 02 vertical orbit
for i in range(200):
    d="up" if i%2==0 else "down"
    w="بالا" if d=="up" else "پایین"
    forms=[
        f"دید رو با orbit ببر {w}",
        f"مدل رو عمودی به {w} بچرخون",
        f"camera رو دور قطعه به {w} rotate کن",
        f"زاویه دید رو {w} ببر با چرخش",
    ]
    add("orbit_vertical",f"v16_orbv_{i:04d}",style(forms[(i//2)%4],i),
        do("view.move",{"action":"orbit","direction":d}),axes=["camera","orbit","vertical"])

# 03 roll orbit
for i in range(200):
    d="clockwise" if i%2==0 else "counterclockwise"
    w="ساعتگرد" if d=="clockwise" else "خلاف ساعتگرد"
    forms=[
        f"نما رو {w} بچرخون",
        f"orbit رو {w} انجام بده",
        f"camera rotation {w}",
        f"حول دید {w} rotate کن",
    ]
    add("orbit_roll",f"v16_orbr_{i:04d}",style(forms[(i//2)%4],i),
        do("view.move",{"action":"orbit","direction":d}),axes=["camera","orbit","roll"])

# 04 horizontal pan
for i in range(200):
    d="left" if i%2==0 else "right"
    w="چپ" if d=="left" else "راست"
    forms=[
        f"بدون چرخش viewport رو بکش {w}",
        f"pan افقی به {w}",
        f"صفحه رو هل بده سمت {w}",
        f"نما رو صاف جابه‌جا کن به {w}",
    ]
    add("pan_horizontal",f"v16_panh_{i:04d}",style(forms[(i//2)%4],i),
        do("view.move",{"action":"pan","direction":d}),axes=["camera","pan","horizontal"])

# 05 vertical pan
for i in range(200):
    d="up" if i%2==0 else "down"
    w="بالا" if d=="up" else "پایین"
    forms=[
        f"viewport رو مستقیم بکش {w}",
        f"pan عمودی به {w}",
        f"صفحه رو بدون rotate ببر {w}",
        f"نما رو صاف جابه‌جا کن {w}",
    ]
    add("pan_vertical",f"v16_panv_{i:04d}",style(forms[(i//2)%4],i),
        do("view.move",{"action":"pan","direction":d}),axes=["camera","pan","vertical"])

# 06 zoom
for i in range(200):
    d="in" if i%2==0 else "out"
    forms_in=["یکم نزدیک‌ترش کن","zoom رو ببر داخل","به مدل نزدیک شو","فاصله دید رو کمتر کن"]
    forms_out=["یکم دورترش کن","zoom رو ببر بیرون","از مدل فاصله بگیر","فاصله دید رو بیشتر کن"]
    forms=forms_in if d=="in" else forms_out
    add("zoom",f"v16_zoom_{i:04d}",style(forms[(i//2)%4],i),
        do("view.move",{"action":"zoom","direction":d}),axes=["camera","zoom","polarity"])

# 07 fit all
for i in range(200):
    forms=[
        "کل چیزی که داریم داخل viewport جا بشه",
        "همه مدل رو اندازه صفحه کن",
        "کل مدل رو توی دید جا بده",
        "fit رو برای کل مدل انجام بده",
    ]
    add("fit_all",f"v16_fitall_{i:04d}",style(forms[i%4],i),
        do("view.fit",{"action":"fit"}),axes=["view","fit","all"])

# 08 fit selection
for i in range(200):
    n=1+(i%3)
    forms=[
        "فقط چیزهای انتخاب‌شده رو اندازه صفحه کن",
        "selection فعلی رو داخل viewport جا بده",
        "روی انتخاب‌ها fit بزن",
        "همین انتخاب فعلی رو توی دید بزرگ کن",
    ]
    add("fit_selection",f"v16_fitsel_{i:04d}",style(forms[i%4],i),
        do("view.fit",{"action":"fit_selection"}),
        {"selection_count":n,"selection_types":["edge"]*n},axes=["view","fit","selection"])

# 09 top view
for i in range(200):
    forms=[
        "دوربین رو دقیق از بالا قرار بده",
        "نمای استاندارد بالا رو بیار",
        "view رو روی top تنظیم کن",
        "از جهت بالا نشونش بده",
    ]
    add("top_view",f"v16_top_{i:04d}",style(forms[i%4],i),
        do("view.standard",{"view":"top"}),axes=["view","standard","top"])

# 10 clear selection
for i in range(200):
    forms=[
        "هرچی الان select شده آزادش کن",
        "انتخاب فعلی رو صفر کن",
        "selectionها رو خالی کن",
        "هیچ چیز انتخاب‌شده نمونه",
    ]
    add("clear_selection",f"v16_clear_{i:04d}",style(forms[i%4],i),
        do("viewer.selection.clear",{}),axes=["selection","clear"])

# 11 inspect selection
for i in range(200):
    forms=[
        "بگو الان دقیقاً چی selected هست",
        "لیست انتخاب فعلی رو بگو",
        "چه entityهایی دستمه الان",
        "selection الان شامل چیه",
    ]
    add("inspect_selection",f"v16_insel_{i:04d}",style(forms[i%4],i),
        do("viewer.inspect",{"mode":"selection"}),{"selection_count":i%4},
        axes=["inspect","selection"])

# 12 inspect state
for i in range(200):
    forms=[
        "وضع فعلی viewer رو گزارش بده",
        "state صفحه رو بگو",
        "الان وضعیت نما چطوره",
        "یه گزارش از viewer state بده",
    ]
    add("inspect_state",f"v16_instate_{i:04d}",style(forms[i%4],i),
        do("viewer.inspect",{"mode":"state"}),axes=["inspect","state"])

# 13 inspect collaboration
for i in range(200):
    forms=[
        "بگو چه participantهایی الان حاضرن",
        "وضعیت افراد داخل session رو بده",
        "الان چند نفر توی همکاری هستیم",
        "لیست آدم‌های حاضر در جلسه رو بگو",
    ]
    add("inspect_collaboration",f"v16_incollab_{i:04d}",style(forms[i%4],i),
        do("viewer.inspect",{"mode":"collaboration"}),axes=["inspect","collaboration"])

# 14 follow pair
for i in range(200):
    forms=[
        "دید اون یک نفر دیگه رو دنبال کن",
        "روی participant مقابل follow شو",
        "view همکار روبرو رو بگیر",
        "دوربینم رو به نفر دیگه وصل کن",
    ]
    add("follow_pair",f"v16_follow2_{i:04d}",style(forms[i%4],i),
        do("view.follow",{}),{"collaborator_count":2},axes=["follow","collaboration","two_person"])

# 15 follow three
for i in range(200):
    forms=[
        "بین سه نفر، participant دوم رو دنبال کن",
        "follow رو روی نفر دوم بذار",
        "view دومی رو بگیر",
        "دوربین نفر دوم رو دنبال کن",
    ]
    add("follow_three",f"v16_follow3_{i:04d}",style(forms[i%4],i),
        do("view.follow",{"candidate_index":2}),{"collaborator_count":3},
        axes=["follow","collaboration","ordinal"])

vals=[0.3,0.45,0.65,0.9,1.1,1.35,1.8,2.2,2.6,3.25]

# 16 selected fillet
for i in range(200):
    v=vals[i%10]
    forms=[
        f"لبه‌های فعلی رو با radius {amt(v)} fillet کن",
        f"روی edgeهای انتخابی فیلت {amt(v)} بزن",
        f"selection فعلی یه fillet {amt(v)} بگیره",
        f"همین لبه‌های گرفته‌شده رو {amt(v)} گرد کن",
    ]
    n=1+(i%3)
    add("selected_fillet",f"v16_selfillet_{i:04d}",style(forms[(i//10)%4],i),
        do("feature.from_selection",{"feature_type":"fillet","amount":amt(v)}),
        {"selection_count":n,"selection_types":["edge"]*n},
        axes=["edge","fillet","selection","quantity"])

# 17 selected chamfer
for i in range(200):
    v=vals[(i+4)%10]
    forms=[
        f"لبه‌های فعلی رو {amt(v)} chamfer کن",
        f"روی edge انتخاب‌شده پخ {amt(v)} بزن",
        f"selection فعلی bevel {amt(v)} بگیره",
        f"همین لبه رو به اندازه {amt(v)} پخ کن",
    ]
    add("selected_chamfer",f"v16_selchamfer_{i:04d}",style(forms[(i//10)%4],i),
        do("feature.from_selection",{"feature_type":"chamfer","amount":amt(v)}),
        {"selection_count":1,"selection_types":["edge"]},
        axes=["edge","chamfer","selection","quantity"])

# 18 new fillet
for i in range(200):
    v=vals[(i+1)%10]
    forms=[
        f"یک feature fillet تازه با مقدار {amt(v)} بساز، انتخاب نداریم",
        f"بدون selection یه فیلت جدید {amt(v)} ایجاد کن",
        f"new empty fillet با اندازه {amt(v)} بساز",
        f"فیلت جدید {amt(v)} بساز ولی هنوز لبه انتخاب نشده",
    ]
    add("new_fillet",f"v16_newfillet_{i:04d}",style(forms[(i//10)%4],i),
        do("feature.add",{"feature_type":"fillet","amount":amt(v)}),
        axes=["creation","fillet","selection_absence"])

# 19 new chamfer
for i in range(200):
    v=vals[(i+6)%10]
    forms=[
        f"یک feature chamfer تازه {amt(v)} بساز، selection خالیه",
        f"بدون انتخاب یه پخ جدید {amt(v)} ایجاد کن",
        f"new empty chamfer با اندازه {amt(v)} بساز",
        f"پخ جدید {amt(v)} بساز ولی edge انتخاب نشده",
    ]
    add("new_chamfer",f"v16_newchamfer_{i:04d}",style(forms[(i//10)%4],i),
        do("feature.add",{"feature_type":"chamfer","amount":amt(v)}),
        axes=["creation","chamfer","selection_absence"])

# 20 fillet radius
for i in range(200):
    n=3+(i%60); v=0.4+(i%24)*0.2
    forms=[
        f"روی Fillet {n} مقدار radius رو {amt(v)} قرار بده",
        f"Fillet {n} شعاعش بشه {amt(v)}",
        f"radius برای Fillet {n} = {amt(v)}",
        f"شعاع feature Fillet {n} رو به {amt(v)} برسون",
    ]
    add("fillet_radius",f"v16_radius_{i:04d}",style(forms[(i//60)%4],i),
        do("feature.parameter.set",{"feature_name":f"Fillet {n}","parameter":"radius","amount":amt(v)}),
        axes=["feature_parameter","radius"])

# 21 extrude depth
for i in range(200):
    n=3+(i%60); v=2+(i%35)
    forms=[
        f"برای Extrude {n} depth رو {amt(v)} تنظیم کن",
        f"Extrude {n} عمقش بشه {amt(v)}",
        f"مقدار depth در Extrude {n} = {amt(v)}",
        f"عمق feature Extrude {n} رو به {amt(v)} برسون",
    ]
    add("extrude_depth",f"v16_depth_{i:04d}",style(forms[(i//60)%4],i),
        do("feature.parameter.set",{"feature_name":f"Extrude {n}","parameter":"depth","amount":amt(v)}),
        axes=["feature_parameter","depth"])

# 22 draft angle
for i in range(200):
    n=3+(i%60); v=2+(i%25)
    forms=[
        f"برای Draft {n} زاویه رو {v} deg تنظیم کن",
        f"Draft {n} angle بشه {v} درجه",
        f"angle در Draft {n} = {v} deg",
        f"زاویه feature Draft {n} رو به {v} درجه برسون",
    ]
    add("draft_angle",f"v16_angle_{i:04d}",style(forms[(i//60)%4],i),
        do("feature.parameter.set",{"feature_name":f"Draft {n}","parameter":"angle","amount":amt(v,"deg")}),
        axes=["feature_parameter","angle"])

# 23 flip direction
for i in range(200):
    n=3+(i%60); val=(i%2)==0
    w="روشن" if val else "خاموش"
    en="true" if val else "false"
    forms=[
        f"روی Extrude {n} flip direction رو {w} بذار",
        f"flip direction Extrude {n} = {en}",
        f"جهت flip برای Extrude {n} {w} باشه",
        f"گزینه flip direction در Extrude {n} رو {w} کن",
    ]
    add("flip_direction",f"v16_flip_{i:04d}",style(forms[(i//2)%4],i),
        do("feature.parameter.set",{"feature_name":f"Extrude {n}","parameter":"flip direction","value":val}),
        axes=["feature_parameter","boolean","flip"])

# 24 suppress
for i in range(200):
    n=3+(i%60)
    forms=[
        f"feature Extrude {n} رو موقتاً suppress کن",
        f"Extrude {n} فعلاً خاموش باشه",
        f"Extrude {n} رو از regeneration خارج کن",
        f"suppressed برای Extrude {n} روشن بشه",
    ]
    add("suppress",f"v16_sup_{i:04d}",style(forms[(i//60)%4],i),
        do("feature.patch",{"feature_name":f"Extrude {n}","suppressed":True}),
        axes=["feature_state","suppress"])

# 25 unsuppress
for i in range(200):
    n=3+(i%60)
    forms=[
        f"feature Extrude {n} رو دوباره فعال کن",
        f"Extrude {n} رو از حالت suppress دربیار",
        f"Extrude {n} برگرده توی regeneration",
        f"suppressed برای Extrude {n} خاموش بشه",
    ]
    add("unsuppress",f"v16_unsup_{i:04d}",style(forms[(i//60)%4],i),
        do("feature.patch",{"feature_name":f"Extrude {n}","suppressed":False}),
        axes=["feature_state","unsuppress"])

# 26 feature rename with opaque values
name_bits=["fit orbit","steel pan","delete selection","top radius","follow material","zoom rollback","hide pattern","draft color"]
for i in range(200):
    n=3+(i%60); name=f"{name_bits[i%len(name_bits)]} node {i%41}"
    forms=[
        f"برای Fillet {n} اسم جدید بذار {name}",
        f"نام feature Fillet {n} بشه {name}",
        f"rename روی Fillet {n}: {name}",
        f"Fillet {n} name = {name}",
    ]
    add("feature_rename",f"v16_frename_{i:04d}",style(forms[(i//60)%4],i),
        do("feature.patch",{"feature_name":f"Fillet {n}","new_name":name}),
        axes=["feature","rename","opaque_literal"])

# 27 feature delete
for i in range(200):
    n=3+(i%60)
    forms=[
        f"feature Extrude {n} رو کامل پاک کن",
        f"Extrude {n} رو از feature tree حذف کن",
        f"delete feature Extrude {n}",
        f"Extrude {n} دیگه نباشه، حذفش کن",
    ]
    add("feature_delete",f"v16_fdelete_{i:04d}",style(forms[(i//60)%4],i),
        do("feature.delete",{"feature_name":f"Extrude {n}"}),axes=["feature","delete"])

# 28 part hide
for i in range(200):
    p=parts[i%len(parts)]
    forms=[
        f"{p} رو توی viewport نامرئی کن",
        f"visibility {p} رو off کن",
        f"{p} فعلاً دیده نشه",
        f"hide برای {p} انجام بده",
    ]
    add("part_hide",f"v16_phide_{i:04d}",style(forms[(i//80)%4],i),
        do("part.visibility",{"part_name":p,"visible":False}),axes=["part","visibility","hide"])

# 29 part show
for i in range(200):
    p=parts[(i+11)%len(parts)]
    forms=[
        f"{p} رو دوباره توی viewport بیار",
        f"visibility {p} رو on کن",
        f"{p} دوباره دیده بشه",
        f"show برای {p} انجام بده",
    ]
    add("part_show",f"v16_pshow_{i:04d}",style(forms[(i//80)%4],i),
        do("part.visibility",{"part_name":p,"visible":True}),axes=["part","visibility","show"])

# 30 part delete
for i in range(200):
    p=parts[(i+19)%len(parts)]
    forms=[
        f"خود {p} رو از مدل حذف کن",
        f"delete part {p}",
        f"{p} رو بنداز دور",
        f"این part یعنی {p} دیگه نباشه",
    ]
    add("part_delete",f"v16_pdelete_{i:04d}",style(forms[(i//80)%4],i),
        do("feature.delete_part",{"part_name":p}),axes=["part","delete"])

# 31 part color
colors=[("قرمز","red"),("آبی","blue"),("سبز","green"),("مشکی","black"),("سفید","white"),("زرد","yellow"),("gray","gray"),("blue","blue")]
for i in range(200):
    p=parts[(i+7)%len(parts)]; w,val=colors[i%len(colors)]
    forms=[
        f"برای {p} رنگ {w} بذار",
        f"{p} color = {w}",
        f"ظاهر رنگی {p} بشه {w}",
        f"{p} رو با color {w} تنظیم کن",
    ]
    add("part_color",f"v16_color_{i:04d}",style(forms[(i//80)%4],i),
        do("metadata.property.set",{"part_name":p,"property":"color","value":val}),
        axes=["part","color","property"])

# 32 part material
materials=["Steel","Titanium","ABS","Aluminum","Nylon","Copper","Brass","PEEK"]
for i in range(200):
    p=parts[(i+23)%len(parts)]; m=materials[i%len(materials)]
    forms=[
        f"برای {p} material رو {m} قرار بده",
        f"{p} متریالش بشه {m}",
        f"{p} material = {m}",
        f"جنس {p} رو {m} بذار",
    ]
    add("part_material",f"v16_material_{i:04d}",style(forms[(i//80)%4],i),
        do("metadata.property.set",{"part_name":p,"property":"material","value":m}),
        axes=["part","material","property"])

# 33 part description
for i in range(200):
    p=parts[(i+31)%len(parts)]
    val=f"orbit steel note {i%53} fit"
    forms=[
        f"description برای {p} بذار {val}",
        f"{p} description = {val}",
        f"توضیح {p} بشه {val}",
        f"برای {p} متن توضیح رو {val} قرار بده",
    ]
    add("part_description",f"v16_pdesc_{i:04d}",style(forms[(i//80)%4],i),
        do("metadata.property.set",{"part_name":p,"property":"description","value":val}),
        axes=["part","description","opaque_literal"])

# 34 part rename
for i in range(200):
    p=parts[(i+37)%len(parts)]
    val=f"top material assembly {i%47}"
    forms=[
        f"اسم {p} رو عوض کن به {val}",
        f"{p} name = {val}",
        f"نام part {p} بشه {val}",
        f"rename {p} to {val}",
    ]
    add("part_rename",f"v16_prename_{i:04d}",style(forms[(i//80)%4],i),
        do("documented.updateWVEPMetadata",{"part_name":p,"property":"name","value":val}),
        axes=["part","rename","opaque_literal"])

# 35 named plane
for i in range(200):
    name=f"fit top ref {i%61}"
    forms=[
        f"یه plane مرجع تازه بساز و اسمش رو بذار {name}",
        f"صفحه مرجع جدید با نام {name} ایجاد کن",
        f"create reference plane called {name}",
        f"plane جدید بساز، name = {name}",
    ]
    add("plane_named",f"v16_plane_named_{i:04d}",style(forms[i%4],i),
        do("feature.add",{"feature_type":"plane","name":name}),
        axes=["plane","creation","name","opaque_literal"])

# 36 plain plane
for i in range(200):
    forms=[
        "یه plane مرجع خالی جدید ایجاد کن",
        "reference plane تازه بساز",
        "صفحه مرجع جدید اضافه کن",
        "create empty plane feature",
    ]
    add("plane_plain",f"v16_plane_plain_{i:04d}",style(forms[i%4],i),
        do("feature.add",{"feature_type":"plane"}),axes=["plane","creation"])

# 37 linear pattern
for i in range(200):
    p=parts[(i+13)%len(parts)]
    copies=2+(i%7)
    dist=3+(i%15)
    forms=[
        f"از {p} یه linear pattern با {copies} copies و فاصله {dist} mm بساز",
        f"{p} رو {copies} تا با گام {dist} mm خطی تکرار کن",
        f"pattern خطی {p}: {copies} تا، فاصله {dist} mm",
        f"برای {p} الگوی خطی {copies} تایی با spacing {dist} mm ایجاد کن",
    ]
    add("linear_pattern",f"v16_pattern_{i:04d}",style(forms[i%4],i),
        do("feature.add",{"feature_type":"linearPattern","part_name":p,"copies":copies,"distance":f"{dist} mm"}),
        axes=["pattern","copy_count","distance"])

# 38 reorder
for i in range(200):
    a=f"Extrude {3+(i%50)}"; b=f"Fillet {20+(i%40)}"
    placement="before" if i%2==0 else "after"
    fa="قبل از" if placement=="before" else "بعد از"
    forms=[
        f"{a} رو در tree {fa} {b} قرار بده",
        f"move {a} {placement} {b}",
        f"ترتیب رو طوری کن که {a} {fa} {b} باشه",
        f"جای {a} رو ببر {fa} {b}",
    ]
    add("feature_reorder",f"v16_reorder_{i:04d}",style(forms[(i//2)%4],i),
        do("feature.reorder",{"source_feature":a,"target_feature":b,"placement":placement}),
        axes=["feature_tree","reorder","relation"])

# 39 rollback
for i in range(200):
    t=f"Extrude {4+(i%55)}"
    before=(i%2)==0
    forms_before=[f"rollback bar رو درست قبل {t} بذار",f"برگرد تا قبل {t}",f"rollback point before {t}",f"نقطه بازگشت رو قبل {t} قرار بده"]
    forms_after=[f"rollback bar رو درست بعد {t} بذار",f"برگرد تا بعد {t}",f"rollback point after {t}",f"نقطه بازگشت رو بعد {t} قرار بده"]
    forms=forms_before if before else forms_after
    exp=do("rollback.set",{"before_feature":t} if before else {"after_feature":t})
    add("rollback",f"v16_rollback_{i:04d}",style(forms[(i//2)%4],i),exp,axes=["rollback","relation"])

# 40 create Part Studio
for i in range(200):
    name=f"orbit fit workspace {i%67}"
    forms=[
        f"یک Part Studio تازه بساز با اسم {name}",
        f"create a new Part Studio named {name}",
        f"پارت استودیو جدید ایجاد کن، اسم {name}",
        f"new Part Studio name = {name}",
    ]
    add("create_part_studio",f"v16_partstudio_{i:04d}",style(forms[i%4],i),
        do("documented.createPartStudio",{"new_name":name}),
        axes=["document","part_studio","creation","opaque_literal"])

# 41 rename document
for i in range(200):
    name=f"selection orbit project {i%71}"
    forms=[
        f"اسم document رو عوض کن به {name}",
        f"document title بشه {name}",
        f"نام داکیومنت رو {name} قرار بده",
        f"rename document to {name}",
    ]
    add("rename_document",f"v16_docrename_{i:04d}",style(forms[i%4],i),
        do("documented.updateDocumentAttributes",{"new_name":name}),
        axes=["document","rename","opaque_literal"])

# 42 contextual camera continuation
for i in range(200):
    dirs=["left","right","up","down"]
    d=dirs[i%4]
    forms=[
        "همون حرکت دوربین رو یک مرحله دیگه ادامه بده",
        "باز هم تو همون جهت برو",
        "همین جابه‌جایی دید رو ادامه بده",
        "یه بار دیگه همون سمت حرکت کن",
    ]
    add("context_camera_continue",f"v16_ctx_continue_{i:04d}",style(forms[(i//4)%4],i),
        do("view.move",{"action":"orbit","direction":d}),
        {"last_move":{"action":"orbit","direction":d}},
        axes=["context","camera","anaphora","continuation"])

# 43 contextual camera reverse
for i in range(200):
    dirs=["left","right","up","down"]
    d=dirs[i%4]
    opp={"left":"right","right":"left","up":"down","down":"up"}[d]
    forms=[
        "زیادی شد، جهت قبلی رو برعکس کن",
        "برگرد خلاف همون حرکت قبل",
        "همون حرکت دوربین رو برش گردون",
        "یک قدم در خلاف جهت قبلی برو",
    ]
    add("context_camera_reverse",f"v16_ctx_reverse_{i:04d}",style(forms[(i//4)%4],i),
        do("view.move",{"action":"orbit","direction":opp}),
        {"last_move":{"action":"orbit","direction":d}},
        axes=["context","camera","anaphora","inverse"])

# 44 contextual relative parameter
for i in range(200):
    cur=2.5+(i%8)*0.5
    delta=0.25+(i%3)*0.25
    addop=(i%2)==0
    verb="بیشتر" if addop else "کمتر"
    result=cur+(delta if addop else -delta)
    forms=[
        f"همین فیلت رو {amt(delta)} {verb} کن",
        f"radius همین feature رو {amt(delta)} {verb} ببر",
        f"برای همون Fillet مقدار رو {amt(delta)} {verb} کن",
        f"{amt(delta)} {verb}ش کن برای همین feature",
    ]
    add("context_relative",f"v16_ctx_rel_{i:04d}",style(forms[(i//2)%4],i),
        do("feature.parameter.set",{"feature_name":"Fillet 9","parameter":"radius","amount":amt(result)}),
        {"last_feature":"Fillet 9","feature_parameters":{"radius":amt(cur)}},
        axes=["context","relative","quantity"])

# 45 negation/correction
for i in range(200):
    mode=i%5
    if mode==0:
        core="Part 8 رو hide نکن، show کن"; exp=do("part.visibility",{"part_name":"Part 8","visible":True}); ctx={}
    elif mode==1:
        core="zoom in نه، zoom out کن"; exp=do("view.move",{"action":"zoom","direction":"out"}); ctx={}
    elif mode==2:
        core="top view نده، فقط selection رو پاک کن"; exp=do("viewer.selection.clear",{}); ctx={"selection_count":2}
    elif mode==3:
        core="Fillet 7 رو حذف نکن"; exp=ask(); ctx={}
    else:
        core="selection رو clear نکن، فقط بگو چی selected هست"; exp=do("viewer.inspect",{"mode":"selection"}); ctx={"selection_count":2}
    add("negation_correction",f"v16_neg_{i:04d}",style(core,i),exp,ctx,
        axes=["negation","correction","scope"])

# 46 multiple independent actions -> ask
multi=[
    "Part 6 رو مخفی کن و بعد top view بده",
    "selection رو پاک کن و Part 9 رو آبی کن",
    "Fillet 8 رو حذف کن و Extrude 11 رو suppress کن",
    "zoom out کن و pan راست هم انجام بده",
    "fit selection کن و بعد follow نفر مقابل شو",
]
for i in range(200):
    add("multi_action_safe_ask",f"v16_multi_{i:04d}",style(multi[i%len(multi)],i),ask(),
        {"selection_count":2,"selection_types":["edge","edge"],"collaborator_count":2},
        axes=["multi_action","semantic_residue","fail_closed"])

# 47 true conditions -> ask
conds=[
    "اگر selection خالی بود top view بده",
    "اگه Part 7 مخفی بود نشونش بده",
    "وقتی Fillet 9 فعال بود حذفش کن",
    "unless selection empty باشه fit selection کن",
    "در صورتی که Extrude 5 روشن بود suppress کن",
]
for i in range(200):
    add("conditional_safe_ask",f"v16_cond_{i:04d}",style(conds[i%len(conds)],i),ask(),
        {"selection_count":1,"selection_types":["edge"]},
        axes=["condition","scope","fail_closed"])

# 48 invalid quantities -> ask
for i in range(200):
    mode=i%5
    if mode==0: core=f"Fillet {3+i%40} radius رو -1 mm کن"
    elif mode==1: core=f"Draft {3+i%40} رو 120 deg کن"
    elif mode==2: core=f"Extrude {3+i%40} depth رو 0 mm کن"
    elif mode==3: core=f"از Part {3+i%40} یه pattern یک تایی با فاصله 5 mm بساز"
    else: core=f"Fillet {3+i%40} رو منفی دو میل کن"
    add("invalid_quantity_safe_ask",f"v16_qbad_{i:04d}",style(core,i),ask(),
        axes=["quantity","bounds","fail_closed"])

# 49 ambiguous ordinary target -> ask
for i in range(200):
    mode=i%4
    if mode==0: core="Part 4 و Part 7 رو مخفی کن"
    elif mode==1: core="Fillet 4 و Fillet 6 رو حذف کن"
    elif mode==2: core="این face رو انتخاب کن"
    else: core="اون لبه رو بگیر"
    add("ambiguous_target_safe_ask",f"v16_amb_{i:04d}",style(core,i),ask(),
        axes=["ambiguity","target_cardinality","deictic","fail_closed"])

# 50 pre-score scope boundary: deliberately generated, then excluded before scoring.
design=[
    "این bracket رو سبک‌تر کن ولی سفتی کم نشه",
    "مدل رو برای تولید انبوه بهتر کن",
    "این قطعه رو برای CNC اقتصادی‌تر طراحی کن",
    "گوشه‌ها رو برای کاهش تمرکز تنش بهینه کن",
    "مدل رو طوری robust کن که تغییر ابعاد خرابش نکنه",
]
advanced=[
    "بین این دو profile یک loft حرفه‌ای بساز",
    "برای این sketch قیدهای کامل مهندسی تعیین کن",
    "از این assembly یک drawing کامل تولید کن",
    "روی این بدنه shell با ضخامت مناسب طراحی کن",
    "بین این دو face یک mate مناسب انتخاب و اعمال کن",
]
for i in range(200):
    if i<100:
        core=design[i%len(design)]
        add("scope_boundary",f"v16_scope_{i:04d}",style(core,i),think(),
            axes=["pre_score_filter","design_judgment"],scope="out_of_scope",
            filter_reason="design_or_engineering_judgment")
    else:
        core=advanced[i%len(advanced)]
        add("scope_boundary",f"v16_scope_{i:04d}",style(core,i),ask(),
            axes=["pre_score_filter","advanced_operation"],scope="out_of_scope",
            filter_reason="advanced_beyond_apprentice_contract")

if len(CANDIDATES)!=10000:
    raise AssertionError(f"candidate_count={len(CANDIDATES)}")

CASES=[c for c in CANDIDATES if c["scope"]=="apprentice"]
FILTERED=[c for c in CANDIDATES if c["scope"]!="apprentice"]

if len(CASES)+len(FILTERED)!=10000:
    raise AssertionError("filter accounting mismatch")
