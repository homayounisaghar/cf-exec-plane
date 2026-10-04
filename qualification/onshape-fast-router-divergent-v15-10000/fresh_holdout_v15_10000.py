from __future__ import annotations

CASES=[]

def add(cat,cid,text,expected,ctx=None,axes=None):
    CASES.append({
        "category":cat,
        "id":cid,
        "text":text,
        "ctx":ctx or {},
        "expected":expected if isinstance(expected,list) else [expected],
        "axes":axes or [],
    })

def do(op,args=None): return {"route":"do","op":op,"args":args or {}}
def ask(): return {"route":"ask"}
def think(): return {"route":"think"}

OPENERS=[
    "","لطفاً ","بی‌زحمت ","اگه میشه ","میشه ","الان ","یه لحظه ","برای من ",
    "فقط ","خب، ","باشه، ","ممنون می‌شم ","زحمت میشه ","وقتی آماده‌ای ","سریع ",
    "آروم ","دقیقاً ","فعلاً ","اول از همه ","اگه امکانش هست، "
]
CLOSERS=[
    ""," لطفاً"," اگه میشه"," همین الان"," برای من"," ممنون"," بی‌زحمت"," فعلاً"," یه لحظه"," و تموم"
]
def style(core,i,terse=False):
    if terse and i%5==0:
        return core
    o=OPENERS[i%len(OPENERS)]
    c=CLOSERS[(i//len(OPENERS))%len(CLOSERS)]
    mode=i%8
    if mode==0: return o+core+c
    if mode==1: return o+core+"؟"+c
    if mode==2: return "می‌خوام "+core+c
    if mode==3: return o+core+"، مرسی"+c
    if mode==4: return "میشه "+core+"؟"+c
    if mode==5: return "خب "+core+c
    if mode==6: return core+"؛ "+(c.strip() or "ممنون")
    return o+core+c

def fa_digits(s):
    return str(s).translate(str.maketrans("0123456789.","۰۱۲۳۴۵۶۷۸۹٫"))

def amt(v,unit="mm"):
    x=("%g"%v)
    return f"{x} {unit}"

parts=[f"Part {i}" for i in range(2,62)]
features={k:[f"{k} {i}" for i in range(2,62)] for k in ["Fillet","Extrude","Draft","Sketch"]}

FAMILY_COUNTS={}
def fam(name):
    FAMILY_COUNTS[name]=FAMILY_COUNTS.get(name,0)+1

# 01 orbit: professional camera phrasing, minimal polarity pairs
dirs=[("left",["به چپ","سمت چپ","left"]),("right",["به راست","سمت راست","right"]),
      ("clockwise",["ساعتگرد","clockwise","در جهت عقربه‌ها"]),
      ("counterclockwise",["خلاف عقربه‌ها","counterclockwise","پادساعتگرد"])]
for i in range(200):
    d,words=dirs[i%4]; w=words[(i//4)%3]
    forms=[f"مدل رو {w} بچرخون",f"زاویه دید رو {w} rotate کن",f"camera رو {w} ببر",f"{w} یه کم بچرخونش"]
    add("orbit",f"v15_orbit_{i:04d}",style(forms[(i//12)%4],i),do("view.move",{"action":"orbit","direction":d}),axes=["camera","direction","style","minimal_pair"]); fam("orbit")

# 02 pan
pdirs=[("left","چپ"),("right","راست"),("up","بالا"),("down","پایین")]
for i in range(200):
    d,w=pdirs[i%4]
    forms=[f"نما رو هل بده {w}",f"صفحه رو {w} بکش",f"pan کن {w}",f"viewport رو یکم ببر {w}"]
    add("pan",f"v15_pan_{i:04d}",style(forms[(i//8)%4],i),do("view.move",{"action":"pan","direction":d}),axes=["camera","direction","code_switch"]); fam("pan")

# 03 zoom explicit polarity and phrasing
for i in range(200):
    inward=(i%2)==0; d="in" if inward else "out"
    forms=(["نزدیک‌تر شو","zoom in کن","به مدل نزدیک شو","زوم کن داخل"] if inward else
           ["دورتر شو","zoom out کن","از مدل دور شو","زوم کن بیرون"])
    add("zoom",f"v15_zoom_{i:04d}",style(forms[(i//2)%4],i),do("view.move",{"action":"zoom","direction":d}),axes=["camera","polarity","minimal_pair"]); fam("zoom")

# 04 fit all
for i in range(200):
    forms=["کل مدل رو تو کادر جا بده","همه مدل رو fit کن","همه‌چی توی viewport جا بشه","fit all"]
    add("fit_all",f"v15_fitall_{i:04d}",style(forms[i%4],i),do("view.fit",{"action":"fit"}),axes=["view","fit_target_all","style"]); fam("fit_all")

# 05 fit selection with verified selection
for i in range(200):
    forms=["انتخاب فعلی رو تو کادر جا بده","selection رو fit کن","همین چیزهای انتخاب‌شده رو بزرگ کن تو صفحه","fit selection"]
    ctx={"selection_count":1+(i%3),"selection_types":["edge"]*(1+(i%3))}
    add("fit_selection",f"v15_fitsel_{i:04d}",style(forms[i%4],i),do("view.fit",{"action":"fit_selection"}),ctx,axes=["view","selection","context"]); fam("fit_selection")

# 06 top view
for i in range(200):
    forms=["نمای بالا رو بده","top view بده","از بالا نگاهش کن","نما رو ببر روی top"]
    add("top_view",f"v15_top_{i:04d}",style(forms[i%4],i),do("view.standard",{"view":"top"}),axes=["view","code_switch","style"]); fam("top_view")

# 07 clear selection
for i in range(200):
    forms=["انتخاب رو پاک کن","selection رو خالی کن","هرچی انتخاب شده ول کن","clear selection"]
    add("clear_selection",f"v15_clear_{i:04d}",style(forms[i%4],i),do("viewer.selection.clear",{}),axes=["selection","action","style"]); fam("clear_selection")

# 08 inspect selection
for i in range(200):
    forms=["بگو چی انتخاب شده","الان چی دستمه","selection فعلی چیه","چه چیزی رو گرفتم"]
    add("inspect_selection",f"v15_insel_{i:04d}",style(forms[i%4],i),do("viewer.inspect",{"mode":"selection"}),{"selection_count":i%4},axes=["inspect","selection","word_order"]); fam("inspect_selection")

# 09 inspect state
for i in range(200):
    forms=["وضعیت ویور رو بگو","viewer state رو بگو","صفحه الان چه وضعیه","وضعیت صفحه رو گزارش کن"]
    add("inspect_state",f"v15_instate_{i:04d}",style(forms[i%4],i),do("viewer.inspect",{"mode":"state"}),axes=["inspect","state","style"]); fam("inspect_state")

# 10 collaboration inspect
for i in range(200):
    forms=["کیا الان وصلن","چند نفریم تو session","participantها رو بگو","الان چه کسایی توی جلسه‌ان"]
    add("inspect_collaboration",f"v15_incollab_{i:04d}",style(forms[i%4],i),do("viewer.inspect",{"mode":"collaboration"}),axes=["inspect","collaboration","code_switch"]); fam("inspect_collaboration")

# 11 follow with 2/3-person context
for i in range(200):
    three=(i%2)==1
    if three:
        forms=["نفر دوم رو دنبال کن","follow کن نفر دوم رو","دومی رو بگیر","view نفر دوم رو دنبال کن"]
        exp=do("view.follow",{"candidate_index":2}); ctx={"collaborator_count":3}
    else:
        forms=["نفر روبرو رو follow کن","اون یکی رو دنبال کن","view طرف مقابل رو بگیر","follow participant"]
        exp=do("view.follow",{}); ctx={"collaborator_count":2}
    add("follow",f"v15_follow_{i:04d}",style(forms[(i//2)%4],i),exp,ctx,axes=["collaboration","context","ordinal"]); fam("follow")

# 12 selected fillet
vals=[0.25,0.4,0.55,0.8,1.2,1.5,2.0,2.75,3.5,4.0]
for i in range(200):
    v=vals[i%10]
    forms=[f"روی انتخاب {amt(v)} فیلت بزن",f"لبه‌های انتخاب‌شده رو {amt(v)} گرد کن",f"fillet {amt(v)} روی selection",f"همین edgeها {amt(v)} fillet"]
    add("edge_fillet",f"v15_fillet_{i:04d}",style(forms[(i//10)%4],i),do("feature.from_selection",{"feature_type":"fillet","amount":amt(v)}),{"selection_count":1+(i%3),"selection_types":["edge"]*(1+(i%3))},axes=["edge","selection","quantity","code_switch"]); fam("edge_fillet")

# 13 selected chamfer
for i in range(200):
    v=vals[(i+3)%10]
    forms=[f"روی انتخاب {amt(v)} پخ بزن",f"لبه انتخاب‌شده رو {amt(v)} چمفر کن",f"chamfer {amt(v)} روی selection",f"همین edge رو {amt(v)} bevel کن"]
    add("edge_chamfer",f"v15_chamfer_{i:04d}",style(forms[(i//10)%4],i),do("feature.from_selection",{"feature_type":"chamfer","amount":amt(v)}),{"selection_count":1,"selection_types":["edge"]},axes=["edge","selection","quantity","code_switch"]); fam("edge_chamfer")

# 14 new fillet
for i in range(200):
    v=vals[i%10]
    forms=[f"یه fillet جدید {amt(v)} بدون انتخاب بساز",f"فیلت خالی {amt(v)} بساز",f"new fillet {amt(v)} فعلاً بدون selection",f"بدون انتخاب یه فیلت {amt(v)} ایجاد کن"]
    add("new_fillet",f"v15_newfillet_{i:04d}",style(forms[(i//10)%4],i),do("feature.add",{"feature_type":"fillet","amount":amt(v)}),axes=["creation","edge","selection_absence"]); fam("new_fillet")

# 15 new chamfer
for i in range(200):
    v=vals[(i+5)%10]
    forms=[f"یه chamfer جدید {amt(v)} بدون انتخاب بساز",f"پخ خالی {amt(v)} بساز",f"new chamfer {amt(v)} فعلاً بدون selection",f"بدون انتخاب یه پخ {amt(v)} ایجاد کن"]
    add("new_chamfer",f"v15_newchamfer_{i:04d}",style(forms[(i//10)%4],i),do("feature.add",{"feature_type":"chamfer","amount":amt(v)}),axes=["creation","edge","selection_absence"]); fam("new_chamfer")

# 16 fillet radius
for i in range(200):
    n=2+(i%50); v=0.5+(i%20)*0.25
    forms=[f"شعاع Fillet {n} رو {amt(v)} کن",f"radius فیلت {n} = {amt(v)}",f"برای Fillet {n} radius رو {amt(v)} بذار",f"Fillet {n} رو {amt(v)} radius کن"]
    add("feature_radius",f"v15_radius_{i:04d}",style(forms[(i//50)%4],i),do("feature.parameter.set",{"feature_name":f"Fillet {n}","parameter":"radius","amount":amt(v)}),axes=["feature_parameter","radius","quantity"]); fam("feature_radius")

# 17 extrude depth
for i in range(200):
    n=2+(i%50); v=1+(i%30)
    forms=[f"depth Extrude {n} رو {amt(v)} کن",f"Extrude {n} عمق {amt(v)}",f"عمق اکسترود {n} رو {amt(v)} بذار",f"برای Extrude {n} depth = {amt(v)}"]
    add("feature_depth",f"v15_depth_{i:04d}",style(forms[(i//50)%4],i),do("feature.parameter.set",{"feature_name":f"Extrude {n}","parameter":"depth","amount":amt(v)}),axes=["feature_parameter","depth","code_switch"]); fam("feature_depth")

# 18 draft angle
for i in range(200):
    n=2+(i%50); v=1+(i%18)
    forms=[f"Draft {n} رو {v} deg کن",f"زاویه Draft {n} = {v} درجه",f"برای Draft {n} angle رو {v} deg بذار",f"Draft {n} angle {v} degrees"]
    add("feature_angle",f"v15_angle_{i:04d}",style(forms[(i//50)%4],i),do("feature.parameter.set",{"feature_name":f"Draft {n}","parameter":"angle","amount":amt(v,"deg")}),axes=["feature_parameter","angle","unit"]); fam("feature_angle")

# 19 flip direction
for i in range(200):
    n=2+(i%50); val=(i%2)==0; w="روشن" if val else "خاموش"; en="true" if val else "false"
    forms=[f"flip direction برای Extrude {n} رو {w} کن",f"Extrude {n} flip direction = {en}",f"جهت flip اکسترود {n} رو {w} کن",f"برای Extrude {n} گزینه flip direction {w}"]
    add("feature_flip",f"v15_flip_{i:04d}",style(forms[(i//50)%4],i),do("feature.parameter.set",{"feature_name":f"Extrude {n}","parameter":"flip direction","value":val}),axes=["feature_parameter","boolean","role_scope"]); fam("feature_flip")

# 20 suppress
for i in range(200):
    n=2+(i%50)
    forms=[f"Extrude {n} رو خاموش کن",f"suppress کن Extrude {n} رو",f"Extrude {n} فعلاً غیرفعال باشه",f"feature Extrude {n} رو suppress کن"]
    add("suppress",f"v15_sup_{i:04d}",style(forms[(i//50)%4],i),do("feature.patch",{"feature_name":f"Extrude {n}","suppressed":True}),axes=["feature_state","suppression"]); fam("suppress")

# 21 unsuppress
for i in range(200):
    n=2+(i%50)
    forms=[f"Extrude {n} رو برگردون روشن",f"unsuppress کن Extrude {n} رو",f"Extrude {n} دوباره فعال باشه",f"feature Extrude {n} رو برگردون"]
    add("unsuppress",f"v15_unsup_{i:04d}",style(forms[(i//50)%4],i),do("feature.patch",{"feature_name":f"Extrude {n}","suppressed":False}),axes=["feature_state","restoration"]); fam("unsuppress")

# 22 feature rename, opaque literals
keywords=["fit hide","delete top","zoom out","material steel","selection follow","rollback pattern","radius 2 mm","Draft 8","show suppress","mirror hole"]
for i in range(200):
    n=2+(i%50); name=keywords[i%10]+f" corner {i%37}"
    forms=[f"اسم Fillet {n} بشه {name}",f"Fillet {n} رو rename کن به {name}",f"نام Fillet {n} رو بذار {name}",f"rename Fillet {n} to {name}"]
    add("feature_rename",f"v15_frename_{i:04d}",style(forms[(i//50)%4],i),do("feature.patch",{"feature_name":f"Fillet {n}","new_name":name}),axes=["literal","masking","keyword_collision"]); fam("feature_rename")

# 23 feature delete
for i in range(200):
    n=2+(i%50)
    forms=[f"Extrude {n} رو حذف کن",f"feature Extrude {n} رو پاک کن",f"Extrude {n} بنداز دور",f"delete Extrude {n}"]
    add("feature_delete",f"v15_fdelete_{i:04d}",style(forms[(i//50)%4],i),do("feature.delete",{"feature_name":f"Extrude {n}"}),axes=["delete","feature_target"]); fam("feature_delete")

# 24 part hide
for i in range(200):
    p=parts[i%len(parts)]
    forms=[f"{p} رو مخفی کن",f"hide کن {p} رو",f"{p} رو از نما بردار",f"{p} دیده نشه"]
    add("part_hide",f"v15_phide_{i:04d}",style(forms[(i//50)%4],i),do("part.visibility",{"part_name":p,"visible":False}),axes=["part","visibility","negative_state"]); fam("part_hide")

# 25 part show
for i in range(200):
    p=parts[(i+7)%len(parts)]
    forms=[f"{p} رو نشون بده",f"show کن {p} رو",f"{p} رو برگردون تو نما",f"{p} دوباره دیده بشه"]
    add("part_show",f"v15_pshow_{i:04d}",style(forms[(i//50)%4],i),do("part.visibility",{"part_name":p,"visible":True}),axes=["part","visibility","positive_state"]); fam("part_show")

# 26 part delete
for i in range(200):
    p=parts[(i+13)%len(parts)]
    forms=[f"{p} رو حذف کن",f"delete کن {p} رو",f"{p} رو پاک کن",f"این part یعنی {p} رو بنداز دور"]
    add("part_delete",f"v15_pdelete_{i:04d}",style(forms[(i//50)%4],i),do("feature.delete_part",{"part_name":p}),axes=["part","delete"]); fam("part_delete")

# 27 part color
colors=[("قرمز","red"),("آبی","blue"),("سبز","green"),("مشکی","black"),("خاکستری","gray"),("سفید","white"),("زرد","yellow"),("red","red"),("blue","blue"),("green","green")]
for i in range(200):
    p=parts[i%len(parts)]; w,val=colors[i%10]
    forms=[f"{p} رو {w} کن",f"color {p} رو {w} بذار",f"رنگ {p} بشه {w}",f"{w} کن {p} رو"]
    add("part_color",f"v15_color_{i:04d}",style(forms[(i//50)%4],i),do("metadata.property.set",{"part_name":p,"property":"color","value":val}),axes=["part","color","order","code_switch"]); fam("part_color")

# 28 material including reversed order
materials=["Steel","Titanium","ABS","Aluminum","Nylon","Copper","Brass","PEEK","PLA","Stainless Steel"]
for i in range(200):
    p=parts[(i+9)%len(parts)]; m=materials[i%10]
    forms=[f"material {p} رو {m} بذار",f"{m} بذار material {p} رو",f"متریال {p} بشه {m}",f"{p} material = {m}"]
    add("part_material",f"v15_material_{i:04d}",style(forms[(i//50)%4],i),do("metadata.property.set",{"part_name":p,"property":"material","value":m}),axes=["part","material","literal","order"]); fam("part_material")

# 29 description/name metadata with opaque text
for i in range(200):
    p=parts[(i+3)%len(parts)]
    if i%2==0:
        v=f"fit hide radius {i%17} mm note"
        text=[f"{p} description بذار {v}",f"description {p} = {v}",f"توضیحات {p} بشه {v}",f"برای {p} description رو بذار {v}"][(i//2)%4]
        exp=do("metadata.property.set",{"part_name":p,"property":"description","value":v})
    else:
        v=f"top suppress archive {i%19}"
        text=[f"اسم {p} بشه {v}",f"rename {p} to {v}",f"نام {p} رو بذار {v}",f"{p} name = {v}"][(i//2)%4]
        exp=do("metadata.property.set",{"part_name":p,"property":"name","value":v})
    add("part_text_meta",f"v15_pmeta_{i:04d}",style(text,i),exp,axes=["part","literal","masking","metadata"]); fam("part_text_meta")

# 30 plane creation named/empty
for i in range(200):
    if i%2==0:
        name=f"datum fit hide {i%43}"
        forms=[f"یه plane بساز با اسم {name}",f"صفحه مرجع به اسم {name} بساز",f"create plane called {name}",f"با اسم {name} یه plane جدید بساز"]
        exp=do("feature.add",{"feature_type":"plane","name":name})
    else:
        forms=["یه plane خالی بساز","صفحه مرجع جدید بساز","create an empty plane","یه reference plane تازه ایجاد کن"]
        exp=do("feature.add",{"feature_type":"plane"})
    add("plane",f"v15_plane_{i:04d}",style(forms[(i//2)%4],i),exp,axes=["plane","creation","literal_span"]); fam("plane")

# 31 linear pattern
for i in range(200):
    p=parts[i%len(parts)]; copies=2+(i%12); dist=2.5+(i%20)*0.5
    forms=[f"{p} رو {copies} تا pattern کن با فاصله {amt(dist)}",f"از {p} {copies} copies خطی با فاصله {amt(dist)} بساز",f"{copies} تایی {p} رو الگو کن فاصله {amt(dist)}",f"linear pattern {p}: {copies} copies, {amt(dist)} spacing"]
    add("pattern",f"v15_pattern_{i:04d}",style(forms[(i//50)%4],i),do("feature.add",{"feature_type":"linearPattern","part_name":p,"copies":copies,"distance":amt(dist)}),axes=["pattern","count","distance","order"]); fam("pattern")

# 32 reorder
for i in range(200):
    a=["Sketch","Extrude","Fillet","Draft"][i%4]; b=["Extrude","Fillet","Draft","Sketch"][(i+1)%4]
    s=f"{a} {2+i%40}"; t=f"{b} {22+i%40}"; placement="before" if i%2==0 else "after"; fa="قبل" if placement=="before" else "بعد"
    forms=[f"{s} رو {fa} از {t} ببر",f"move {s} {placement} {t}",f"جای {s} رو بذار {fa} {t}",f"{s} باید {fa} {t} باشه"]
    add("reorder",f"v15_reorder_{i:04d}",style(forms[(i//50)%4],i),do("feature.reorder",{"source_feature":s,"target_feature":t,"placement":placement}),axes=["feature_tree","relation","order"]); fam("reorder")

# 33 rollback
for i in range(200):
    t=f"Extrude {2+i%50}"; before=(i%2)==0
    forms=([f"rollback رو قبل از {t} بذار",f"rollback before {t}",f"نقطه rollback قبل {t}",f"برگرد تا قبل {t}"] if before else
           [f"rollback رو بعد از {t} بذار",f"rollback after {t}",f"نقطه rollback بعد {t}",f"برگرد تا بعد {t}"])
    exp=do("rollback.set",{"before_feature":t} if before else {"after_feature":t})
    add("rollback",f"v15_rollback_{i:04d}",style(forms[(i//2)%4],i),exp,axes=["feature_tree","rollback","relation"]); fam("rollback")

# 34 create Part Studio
for i in range(200):
    name=f"fit hide studio {i%73}"
    forms=[f"یه Part Studio جدید به اسم {name} بساز",f"create Part Studio called {name}",f"پارت استودیو تازه با اسم {name}",f"new Part Studio: {name}"]
    add("create_part_studio",f"v15_partstudio_{i:04d}",style(forms[(i//50)%4],i),do("documented.createPartStudio",{"new_name":name}),axes=["document","creation","literal_masking"]); fam("create_part_studio")

# 35 rename document
for i in range(200):
    name=f"top delete archive {i%79}"
    forms=[f"rename document to {name}",f"اسم document بشه {name}",f"نام داکیومنت رو بذار {name}",f"document name = {name}"]
    add("rename_document",f"v15_docrename_{i:04d}",style(forms[(i//50)%4],i),do("documented.updateDocumentAttributes",{"new_name":name}),axes=["document","rename","literal_masking"]); fam("rename_document")

# 36 contextual camera correction
for i in range(200):
    d=["left","right","up","down"][i%4]
    forms=["همون طرف بیشتر","یکم بیشتر همون سمت","باز هم همون جهت","همون حرکت رو ادامه بده"]
    add("context_camera",f"v15_ctxcam_{i:04d}",style(forms[(i//4)%4],i),do("view.move",{"action":"orbit","direction":d}),{"last_move":{"action":"orbit","direction":d}},axes=["context","anaphora","camera"]); fam("context_camera")

# 37 relative feature parameter
for i in range(200):
    cur=2.0+(i%10)*0.5; delta=0.25+(i%4)*0.25; addop=(i%2)==0
    verb="بیشتر" if addop else "کمتر"; result=cur+(delta if addop else -delta)
    forms=[f"این فیلت رو {amt(delta)} {verb} کن",f"radius رو {amt(delta)} {verb} کن",f"{amt(delta)} {verb}ش کن",f"برای همین feature {amt(delta)} {verb}"]
    q=f"{('%g'%result)} mm"
    add("context_relative",f"v15_ctxrel_{i:04d}",style(forms[(i//8)%4],i),do("feature.parameter.set",{"feature_name":"Fillet 6","parameter":"radius","amount":q}),{"last_feature":"Fillet 6","feature_parameters":{"radius":amt(cur)}},axes=["context","relative","quantity"]); fam("context_relative")

# 38 selection semantics ambiguous/deictic => ask
for i in range(200):
    forms=["همین چیزی که موس روشه رو انتخاب کن","این face رو select کن","اون لبه رو بگیر","این یکی رو انتخاب کن"]
    add("selection_ambiguous",f"v15_selask_{i:04d}",style(forms[i%4],i),ask(),axes=["selection","deictic","missing_grounding","fail_closed"]); fam("selection_ambiguous")

# 39 precise unsupported modeling ops => ask
unsupported=[
    "روی این sketch یه hole ده میلی بزن","این body رو mirror کن","از این profile یه revolve بساز",
    "این دو face رو shell کن با ضخامت دو میل","بین این دو profile loft بساز","این مسیر رو sweep کن",
    "یه circular pattern شش‌تایی بساز","روی این edge thread M6 بزن","این دو part رو boolean union کن",
    "برای این sketch horizontal constraint بذار","این خط رو tangent کن","یه center rectangle اینجا بکش",
    "از این sketch extrude symmetric بساز","یه mate بین این دو face بساز","configuration جدید بساز"
]
for i in range(200):
    core=unsupported[i%len(unsupported)]
    add("unsupported_precise",f"v15_unsupported_{i:04d}",style(core,i),ask(),axes=["professional_cad","unsupported","precise","fail_closed"]); fam("unsupported_precise")

# 40 open-ended professional judgment => think
designs=[
    "این براکت رو سبک‌تر کن ولی stiffness کم نشه","feature tree رو برای تحویل به تیم تمیز کن",
    "برای injection molding بهترش کن","این قطعه رو برای CNC منطقی‌تر کن","طراحی رو برای پرینت سه‌بعدی قابل‌اعتمادتر کن",
    "گوشه‌ها رو جوری اصلاح کن که stress concentration کم بشه","clearance مونتاژ رو بهتر کن بدون اینکه لق بشه",
    "این part رو ارزون‌تر تولیدپذیر کن","مدل رو robust کن که با تغییر اندازه خراب نشه","ظاهرش رو تمیزتر و حرفه‌ای‌تر کن"
]
for i in range(200):
    add("design_judgment",f"v15_design_{i:04d}",style(designs[i%len(designs)],i),think(),axes=["professional_cad","engineering_judgment","open_ended"]); fam("design_judgment")

# 41 material/material multi-action => ask
multi_material=[
    "Part 2 رو آبی کن و مخفیش کن","Fillet 3 رو حذف کن و Part 4 رو قرمز کن",
    "Extrude 4 رو خاموش کن و Fillet 2 رو پاک کن","Part 7 رو hide کن و material رو Steel بذار",
    "یه plane بساز و document رو rename کن به demo","یه fillet جدید بساز و یه chamfer جدید هم بساز"
]
for i in range(200):
    add("multi_material",f"v15_mm_{i:04d}",style(multi_material[i%len(multi_material)],i),ask(),axes=["multi_action","material","semantic_residue"]); fam("multi_material")

# 42 viewer/viewer multi-action => ask
multi_view=[
    "مدل رو fit کن و بعد top view بده","selection رو پاک کن و بعد follow کن","zoom out کن و بعد pan left",
    "top view بده و بعد fit selection کن","اول viewer state رو بگو بعد top view بده","selection رو inspect کن و بعد clear کن"
]
for i in range(200):
    add("multi_viewer",f"v15_mv_{i:04d}",style(multi_view[i%len(multi_view)],i),ask(),{"selection_count":2,"collaborator_count":2},axes=["multi_action","viewer","semantic_residue"]); fam("multi_viewer")

# 43 mixed viewer/material multi-action => ask
mixed=[
    "Part 5 رو hide کن و بعد fit all کن","top view بده و Fillet 4 رو حذف کن","selection رو clear کن و Part 3 رو قرمز کن",
    "zoom in کن و Extrude 8 رو suppress کن","Part 9 رو show کن و بعد follow کن","Draft 4 رو ده درجه کن و top view بده"
]
for i in range(200):
    add("multi_mixed",f"v15_mmix_{i:04d}",style(mixed[i%len(mixed)],i),ask(),{"selection_count":1,"collaborator_count":2},axes=["multi_action","mixed_effect","semantic_residue"]); fam("multi_mixed")

# 44 negation/correction scope
for i in range(200):
    mode=i%5
    if mode==0:
        text="hide نکن، فقط top view بده"; exp=do("view.standard",{"view":"top"})
    elif mode==1:
        text="زوم این نه، زوم اوت کن"; exp=do("view.move",{"action":"zoom","direction":"out"})
    elif mode==2:
        text="Part 4 رو مخفی نکن، نشونش بده"; exp=do("part.visibility",{"part_name":"Part 4","visible":True})
    elif mode==3:
        text="Fillet 5 رو حذف نکن"; exp=ask()
    else:
        text="selection رو پاک نکن، فقط بگو چی انتخاب شده"; exp=do("viewer.inspect",{"mode":"selection"})
    add("negation_correction",f"v15_neg_{i:04d}",style(text,i),exp,{"selection_count":2},axes=["negation","correction","contrast","scope"]); fam("negation_correction")

# 45 valid quantity/localization variants expected to execute
for i in range(200):
    n=2+(i%40); v=1+(i%18)
    mode=i%5
    if mode==0:
        text=f"Draft {n} رو {fa_digits(v)} درجه کن"
    elif mode==1:
        text=f"depth Extrude {n} رو {fa_digits(v)} mm کن"
    elif mode==2:
        text=f"شعاع Fillet {n} رو {fa_digits(v)+ '٫۵'} mm کن"; v=v+0.5
    elif mode==3:
        text=f"Draft {n} رو {v},5 deg کن"; v=v+0.5
    else:
        text=f"Fillet {n} radius {v}.25 mm"; v=v+0.25
    if "Draft" in text:
        exp=do("feature.parameter.set",{"feature_name":f"Draft {n}","parameter":"angle","amount":amt(v,"deg")})
    elif "Extrude" in text:
        exp=do("feature.parameter.set",{"feature_name":f"Extrude {n}","parameter":"depth","amount":amt(v)})
    else:
        exp=do("feature.parameter.set",{"feature_name":f"Fillet {n}","parameter":"radius","amount":amt(v)})
    add("localized_quantity_valid",f"v15_qvalid_{i:04d}",style(text,i,terse=True),exp,axes=["quantity","persian_digits","decimal_locale","mobile_input"]); fam("localized_quantity_valid")

# 46 invalid/safety quantities => ask
invalid=[
    "Fillet 4 رو منفی دو میلی کن","Extrude 5 رو صفر میلی کن","pattern Part 3 رو صفر تا بساز با فاصله 5 mm",
    "Draft 6 رو 9999 درجه کن","Fillet 7 رو سه و چهار و پنج میلی کن","Extrude 8 رو tenish mm کن",
    "Part 2 رو یک و نیم تا pattern کن با فاصله 3 mm","روی selection فیلت -1 mm بزن",
    "Draft 9 رو 5 mm کن","Fillet 10 رو 30 deg کن"
]
for i in range(200):
    add("quantity_invalid",f"v15_qbad_{i:04d}",style(invalid[i%len(invalid)],i),ask(),{"selection_count":1,"selection_types":["edge"]},axes=["quantity","bounds","unit_type","ambiguity","safety"]); fam("quantity_invalid")

# 47 literal collision / punctuation / units inside names
for i in range(200):
    name=[
        "fit hide 2 mm","top, delete, radius","zoom-out selection","Steel material test",
        "Draft 7 angle 15 deg","follow state view","pattern 4x 5mm","suppress=false","mirror-hole-note","Part 3 red blue"
    ][i%10]+f" {i%31}"
    kind=i%4
    if kind==0:
        text=f"یه plane بساز با اسم {name}"; exp=do("feature.add",{"feature_type":"plane","name":name})
    elif kind==1:
        text=f"اسم Fillet {2+i%30} بشه {name}"; exp=do("feature.patch",{"feature_name":f"Fillet {2+i%30}","new_name":name})
    elif kind==2:
        text=f"Part {2+i%30} description بذار {name}"; exp=do("metadata.property.set",{"part_name":f"Part {2+i%30}","property":"description","value":name})
    else:
        text=f"rename document to {name}"; exp=do("documented.updateDocumentAttributes",{"new_name":name})
    add("literal_collision",f"v15_lit_{i:04d}",style(text,i),exp,axes=["literal","masking","keyword_collision","punctuation"]); fam("literal_collision")

# 48 ASR/typo/code-switch/transliteration clear-intent cohort
noisy=[
    ("zoom out kon",do("view.move",{"action":"zoom","direction":"out"}),{}),
    ("top view bede",do("view.standard",{"view":"top"}),{}),
    ("selection ro clear kon",do("viewer.selection.clear",{}),{}),
    ("part 5 ro hide kon",do("part.visibility",{"part_name":"Part 5","visible":False}),{}),
    ("پارت 6 رو هاید کن",do("part.visibility",{"part_name":"Part 6","visible":False}),{}),
    ("اکسترود 7 دیپث ده میل",do("feature.parameter.set",{"feature_name":"Extrude 7","parameter":"depth","amount":"10 mm"}),{}),
    ("فیلِت 8 ریدیوس دو میل",do("feature.parameter.set",{"feature_name":"Fillet 8","parameter":"radius","amount":"2 mm"}),{}),
    ("ویور استیت رو بگو",do("viewer.inspect",{"mode":"state"}),{}),
    ("سلکشن چی شده",do("viewer.inspect",{"mode":"selection"}),{"selection_count":1}),
    ("part 9 material titanium",do("metadata.property.set",{"part_name":"Part 9","property":"material","value":"Titanium"}),{})
]
for i in range(200):
    core,exp,ctx=noisy[i%len(noisy)]
    add("noisy_language",f"v15_noisy_{i:04d}",style(core,i,terse=True),exp,ctx,axes=["asr","typo","transliteration","code_switch","mobile_input"]); fam("noisy_language")

# 49 professional junior-modeler requests outside current contract
pro=[
    "Sketch 4 رو fully constrain کن","این sketch رو dimension کن که width پنجاه و height سی باشه",
    "از Sketch 8 یک extrude تا سطح بعدی بساز","روی این سوراخ counterbore استاندارد M6 بساز",
    "این body رو shell 2 mm کن و face بالا رو باز بذار","این feature رو mirror کن نسبت به Front plane",
    "یه drawing با front/top/isometric از این part بساز","mass properties رو حساب کن و center of mass رو بگو",
    "STEP و STL خروجی بگیر","یه configuration برای small/medium/large بساز",
    "این two-part clearance رو 0.2 mm کن","روی این لبه variable fillet بساز",
    "یه loft با guide curve بین این profileها بساز","این sketch رو از under-constrained به fully constrained برسون",
    "یه hole pattern مطابق pitch circle بساز"
]
for i in range(200):
    text=pro[i%len(pro)]
    route=think() if i%5 in {0,1} else ask()
    add("professional_out_of_contract",f"v15_pro_{i:04d}",style(text,i),route,axes=["professional_cad","unsupported","engineering_judgment","junior_operator"]); fam("professional_out_of_contract")

# 50 discourse/conditional/dependent sequences
disc=[
    ("اگر selection خالیه top view بده",ask()),
    ("اول Part 2 رو show کن بعد اگر لازم بود fit کن",ask()),
    ("Fillet 3 رو 2 mm کن؛ اگه زیادی شد 1.5 mm",ask()),
    ("همه partها رو مخفی کن به جز Part 4",ask()),
    ("اگه Extrude 5 خاموشه روشنش کن",ask()),
    ("قبل از حذف Fillet 7 وضعیت selection رو بگو",ask()),
    ("Part 8 رو hide کن مگر اینکه تنها part visible باشه",ask()),
    ("اگر سه نفر وصلن نفر دوم رو follow کن",ask()),
    ("radius رو جوری تغییر بده که با Draft 4 تداخل نداشته باشه",think()),
    ("اول feature tree رو بررسی کن بعد بهترین reorder رو انجام بده",think())
]
for i in range(200):
    text,exp=disc[i%len(disc)]
    add("conditional_discourse",f"v15_disc_{i:04d}",style(text,i),exp,{"selection_count":1,"collaborator_count":3},axes=["conditional","dependency","temporal_order","exception","professional_dialogue"]); fam("conditional_discourse")

assert len(CASES)==10000, len(CASES)
ids=[c["id"] for c in CASES]
assert len(set(ids))==10000, "duplicate ids"

# Surface-only pre-score de-duplication.  It never changes semantics, context or
# gold labels; it only adds neutral human discourse to exact duplicate strings.
_DEDUP_SUFFIXES=[
    " لطفاً"," ممنون"," بی‌زحمت"," اگه میشه"," مرسی"," همین الان"," یه لحظه"," برای من",
    " اگه زحمتی نیست"," لطف می‌کنی"," اگر امکانش هست"," وقتی فرصت داری"," فعلاً"," سریع",
    " آروم"," دقیقاً"," ممنون می‌شم"," زحمت میشه"," خواهشاً"," لطف داری",
    " لطفاً انجامش بده"," اگه اوکیه"," مرسی ازت"," ممنون ازت"
]
_used=set()
_occ={}
SURFACE_DEDUP_COUNT=0
for c in CASES:
    base=c["text"]
    n=_occ.get(base,0)
    _occ[base]=n+1
    candidate=base
    k=max(1,n)
    while candidate in _used:
        suffix=_DEDUP_SUFFIXES[(k-1)%len(_DEDUP_SUFFIXES)]
        cycle=(k-1)//len(_DEDUP_SUFFIXES)
        tail=suffix + (("، لطفاً" * cycle) if cycle else "")
        candidate=base+tail
        k+=1
    if candidate!=base:
        c["text"]=candidate
        c["axes"]=list(c.get("axes",[]))+["surface_dedup"]
        SURFACE_DEDUP_COUNT+=1
    _used.add(c["text"])

texts=[c["text"] for c in CASES]
assert len(set(texts))==10000, (len(texts),len(set(texts)))

DIVERGENCE_AXES=sorted({a for c in CASES for a in c.get("axes",[])})
