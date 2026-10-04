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

def amt(v,unit="mm"):
    s=("%g" % v)
    return f"{s} {unit}"

fillers=["لطفا","الان","یه لحظه","اگه میشه","همین الان","فقط","فعلا","سریع","آروم","برای من"]
parts=[f"Part {i}" for i in range(2,22)]
features=[]
for kind in ["Fillet","Extrude","Draft","Sketch"]:
    for i in range(2,22):
        features.append(f"{kind} {i}")

# 01 orbit / lexical-order divergence
orbit=[
    ("left","به سمت چپ"),
    ("right","به سمت راست"),
    ("clockwise","ساعتگرد"),
    ("counterclockwise","خلاف جهت عقربه ها"),
]
for i in range(40):
    direction,phrase=orbit[i%4]
    f=fillers[(i//4)%10]
    forms=[
        f"{f} مدل رو {phrase} بچرخون",
        f"{phrase} {f} یه کم rotate کن",
        f"{f} زاویه دید رو {phrase} بچرخون",
        f"مدل {phrase} بره، {f}",
    ]
    text=forms[(i//8)%4]
    add("orbit",f"v14_orbit_{i+1:03d}",text,do("view.move",{"action":"orbit","direction":direction}),axes=["lexical","order","mixed_language"])

# 02 pan
pan=[
    ("left","چپ"),("right","راست"),("up","بالا"),("down","پایین")
]
for i in range(40):
    direction,word=pan[i%4]
    f=fillers[(i//4)%10]
    forms=[
        f"{f} نما رو هل بده {word}",
        f"صفحه رو {word} بکش، {f}",
        f"{f} pan کن {word}",
        f"نما رو یکم ببر {word} {f}",
    ]
    add("pan",f"v14_pan_{i+1:03d}",forms[(i//8)%4],do("view.move",{"action":"pan","direction":direction}),axes=["direction","order","code_switch"])

# 03 zoom
for i in range(40):
    inward=(i%2)==0
    f=fillers[(i//2)%10]
    if inward:
        forms=[f"{f} یه کم نزدیک تر شو",f"یکم zoom in کن {f}",f"{f} به مدل نزدیک‌تر شو",f"زوم کن داخل، {f}"]
        direction="in"
    else:
        forms=[f"{f} یه کم دورتر شو",f"یکم zoom out کن {f}",f"{f} ازش دور شو",f"زوم کن بیرون، {f}"]
        direction="out"
    add("zoom",f"v14_zoom_{i+1:03d}",forms[(i//8)%4],do("view.move",{"action":"zoom","direction":direction}),axes=["polarity","mixed_language","filler"])

# 04 fit / top / clear
for i in range(10):
    text=[
        f"{fillers[i]} کل مدل توی کادر جا بشه",
        f"همه مدل رو fit کن {fillers[i]}",
    ][i%2]
    add("view_state",f"v14_fitall_{i+1:03d}",text,do("view.fit",{"action":"fit"}),axes=["fit_target_all"])
for i in range(10):
    text=[
        f"{fillers[i]} انتخاب فعلی رو تو صفحه جا بده",
        f"selection فعلی رو fit کن {fillers[i]}",
    ][i%2]
    add("view_state",f"v14_fitsel_{i+1:03d}",text,do("view.fit",{"action":"fit_selection"}),{"selection_count":2,"selection_types":["edge","face"]},axes=["fit_target_selection","context"])
for i in range(10):
    text=[f"{fillers[i]} نمای top رو بده",f"از بالا نگاهش کن {fillers[i]}"][i%2]
    add("view_state",f"v14_top_{i+1:03d}",text,do("view.standard",{"view":"top"}),axes=["standard_view","code_switch"])
for i in range(10):
    text=[f"{fillers[i]} selection رو کامل خالی کن",f"انتخاب ها رو ول کن {fillers[i]}"][i%2]
    add("view_state",f"v14_clear_{i+1:03d}",text,do("viewer.selection.clear",{}),axes=["selection_action","negation"])

# 05 inspect / follow
for i in range(10):
    text=[f"{fillers[i]} بگو چی الان دستمه",f"الان چی انتخاب کردم {fillers[i]}"][i%2]
    add("inspect",f"v14_ins_sel_{i+1:03d}",text,do("viewer.inspect",{"mode":"selection"}),{"selection_count":2},axes=["word_order","inspect_target"])
for i in range(10):
    text=[f"{fillers[i]} کیا الان وصلن",f"چند نفریم تو session {fillers[i]}"][i%2]
    add("inspect",f"v14_ins_col_{i+1:03d}",text,do("viewer.inspect",{"mode":"collaboration"}),axes=["collaboration","mixed_language"])
for i in range(10):
    text=[f"{fillers[i]} وضعیت صفحه چطوره",f"viewer state رو بگو {fillers[i]}"][i%2]
    add("inspect",f"v14_ins_state_{i+1:03d}",text,do("viewer.inspect",{"mode":"state"}),axes=["state","mixed_language"])
for i in range(10):
    if i%2==0:
        text=f"{fillers[i]} نفر روبرو رو follow کن"
        exp=do("view.follow",{})
        ctx={"collaborator_count":2}
    else:
        text=f"نفر دوم رو دنبال کن {fillers[i]}"
        exp=do("view.follow",{"candidate_index":2})
        ctx={"collaborator_count":3}
    add("inspect",f"v14_follow_{i+1:03d}",text,exp,ctx,axes=["collaboration_context","ordinal"])

# 06 selected fillet
amounts=[0.35,0.4,0.55,0.65,0.75,0.8,1.1,1.25,1.5,1.7]
for i in range(40):
    v=amounts[i%10]
    f=fillers[(i//4)%10]
    forms=[
        f"{f} روی این انتخاب {amt(v)} فیلت بزن",
        f"لبه های انتخاب شده رو {amt(v)} گرد کن {f}",
        f"{f} fillet {amt(v)} روی همین selection",
        f"همین edge ها {amt(v)} فیلت بشن {f}",
    ]
    add("edge_fillet",f"v14_fillet_{i+1:03d}",forms[(i//10)%4],do("feature.from_selection",{"feature_type":"fillet","amount":amt(v)}),{"selection_count":2,"selection_types":["edge","edge"]},axes=["quantity","selection","code_switch"])

# 07 selected chamfer
for i in range(40):
    v=amounts[(i+3)%10]
    f=fillers[(i//4)%10]
    forms=[
        f"{f} روی این انتخاب {amt(v)} پخ بزن",
        f"لبه انتخاب شده رو {amt(v)} چمفر کن {f}",
        f"{f} chamfer {amt(v)} روی همین selection",
        f"همین edge رو {amt(v)} پخ کن {f}",
    ]
    add("edge_chamfer",f"v14_chamfer_{i+1:03d}",forms[(i//10)%4],do("feature.from_selection",{"feature_type":"chamfer","amount":amt(v)}),{"selection_count":1,"selection_types":["edge"]},axes=["quantity","selection","code_switch"])

# 08 new edge feature
for i in range(40):
    kind="fillet" if i%2==0 else "chamfer"
    fa="فیلت" if kind=="fillet" else "پخ"
    v=amounts[i%10]
    f=fillers[(i//4)%10]
    forms=[
        f"{f} یه {fa} جدید {amt(v)} بدون انتخاب بساز",
        f"یه {kind} خالی {amt(v)} بساز {f}",
        f"{f} {kind} تازه {amt(v)} فعلا بدون انتخاب",
        f"بدون selection یه {fa} {amt(v)} بساز {f}",
    ]
    add("new_edge",f"v14_newedge_{i+1:03d}",forms[(i//10)%4],do("feature.add",{"feature_type":kind,"amount":amt(v)}),axes=["creation","selection_absence","code_switch"])

# 09 valid feature parameters
for i in range(10):
    n=2+i
    v=1.5+i
    add("feature_valid",f"v14_fp_rad_{i+1:03d}",f"شعاع Fillet {n} رو {amt(v)} کن",do("feature.parameter.set",{"feature_name":f"Fillet {n}","parameter":"radius","amount":amt(v)}),axes=["typed_parameter","feature_type"])
for i in range(10):
    n=2+i
    v=8+i
    add("feature_valid",f"v14_fp_dep_{i+1:03d}",f"depth Extrude {n} رو {amt(v)} کن",do("feature.parameter.set",{"feature_name":f"Extrude {n}","parameter":"depth","amount":amt(v)}),axes=["typed_parameter","mixed_language"])
for i in range(10):
    n=2+i
    v=5+i
    add("feature_valid",f"v14_fp_ang_{i+1:03d}",f"Draft {n} رو {v} deg زاویه بده",do("feature.parameter.set",{"feature_name":f"Draft {n}","parameter":"angle","amount":amt(v,"deg")}),axes=["unit","feature_type"])
for i in range(10):
    n=2+i
    val=(i%2)==0
    word="روشن" if val else "خاموش"
    add("feature_valid",f"v14_fp_flip_{i+1:03d}",f"flip direction برای Extrude {n} رو {word} کن",do("feature.parameter.set",{"feature_name":f"Extrude {n}","parameter":"flip direction","value":val}),axes=["boolean","code_switch"])

# 10 incompatible parameter safety
for i in range(10):
    n=2+i
    add("feature_invalid",f"v14_bad_ang_{i+1:03d}",f"angle Extrude {n} رو {10+i} درجه کن",ask(),axes=["compatibility","unsafe_guard"])
for i in range(10):
    n=2+i
    add("feature_invalid",f"v14_bad_dep_{i+1:03d}",f"depth Draft {n} رو {5+i} mm کن",ask(),axes=["compatibility","unsafe_guard"])
for i in range(10):
    n=2+i
    add("feature_invalid",f"v14_bad_fil_{i+1:03d}",f"depth Fillet {n} رو {2+i/10:.1f} mm کن",ask(),axes=["compatibility","unsafe_guard"])
for i in range(10):
    n=2+i
    add("feature_invalid",f"v14_bad_flip_{i+1:03d}",f"flip direction برای Draft {n} رو روشن کن",ask(),axes=["compatibility","boolean"])

# 11 feature state / rename / delete
for i in range(10):
    n=2+i
    add("feature_mutation",f"v14_sup_{i+1:03d}",f"Extrude {n} رو خاموش کن",do("feature.patch",{"feature_name":f"Extrude {n}","suppressed":True}),axes=["suppression"])
for i in range(10):
    n=12+i
    add("feature_mutation",f"v14_unsup_{i+1:03d}",f"Extrude {n} رو برگردون روشن",do("feature.patch",{"feature_name":f"Extrude {n}","suppressed":False}),axes=["restoration","word_order"])
for i in range(10):
    n=2+i
    name=f"fit hide corner {i+1}"
    add("feature_mutation",f"v14_fren_{i+1:03d}",f"اسم Fillet {n} بشه {name}",do("feature.patch",{"feature_name":f"Fillet {n}","new_name":name}),axes=["literal_masking","rename"])
for i in range(5):
    n=12+i
    add("feature_mutation",f"v14_fdel_{i+1:03d}",f"Extrude {n} رو بنداز دور",do("feature.delete",{"feature_name":f"Extrude {n}"}),axes=["delete"])
for i in range(5):
    pos="first" if i%2==0 else "last"
    fa="اولین" if pos=="first" else "آخرین"
    add("feature_mutation",f"v14_fpos_{i+1:03d}",f"{fa} feature رو حذف کن {fillers[i]}",do("feature.delete",{"position":pos}),axes=["ordinal","delete"])

# 12 part visibility / delete
for i in range(15):
    p=parts[i]
    add("part_state",f"v14_phide_{i+1:03d}",f"{p} رو از نما بردار {fillers[i%10]}",do("part.visibility",{"part_name":p,"visible":False}),axes=["visibility","negative_state"])
for i in range(15):
    p=parts[(i+3)%len(parts)]
    add("part_state",f"v14_pshow_{i+1:03d}",f"{p} رو دوباره نشون بده {fillers[i%10]}",do("part.visibility",{"part_name":p,"visible":True}),axes=["visibility","positive_state"])
for i in range(10):
    p=parts[(i+7)%len(parts)]
    add("part_state",f"v14_pdel_{i+1:03d}",f"{p} رو حذف کن {fillers[i]}",do("feature.delete_part",{"part_name":p}),axes=["part_delete"])

# 13 part metadata
colors=[("قرمز","red"),("آبی","blue"),("سبز","green"),("مشکی","black"),("خاکستری","gray"),("سفید","white"),("زرد","yellow"),("سیاه","black"),("blue","blue"),("green","green")]
for i in range(10):
    p=parts[i]; word,val=colors[i]
    add("part_meta",f"v14_color_{i+1:03d}",f"{p} رو {word} کن",do("metadata.property.set",{"part_name":p,"property":"color","value":val}),axes=["color","mixed_language"])
materials=["Steel","Titanium","ABS","Aluminum","Nylon","Copper","Brass","PEEK","PLA","Stainless Steel"]
for i in range(10):
    p=parts[10+i]; m=materials[i]
    add("part_meta",f"v14_mat_{i+1:03d}",f"material {p} رو {m} بذار",do("metadata.property.set",{"part_name":p,"property":"material","value":m}),axes=["material","literal"])
for i in range(10):
    p=parts[i]; v=f"fit hide fillet note {i+1}"
    add("part_meta",f"v14_desc_{i+1:03d}",f"{p} description بذار {v}",do("metadata.property.set",{"part_name":p,"property":"description","value":v}),axes=["description","literal_masking"])
for i in range(10):
    p=parts[10+i]; v=f"top suppress shell {i+1}"
    add("part_meta",f"v14_pname_{i+1:03d}",f"اسم {p} بشه {v}",do("metadata.property.set",{"part_name":p,"property":"name","value":v}),axes=["name","literal_masking"])

# 14 plane creation
for i in range(20):
    name=f"datum hide fit {i+1}"
    forms=[
        f"یه plane بساز با اسم {name}",
        f"یه صفحه مرجع به اسم {name} بساز",
    ]
    add("plane",f"v14_plane_named_{i+1:03d}",forms[i%2],do("feature.add",{"feature_type":"plane","name":name}),axes=["typed_literal","creation","masking"])
for i in range(20):
    forms=[
        f"{fillers[i%10]} یه plane خالی تازه بساز",
        f"یه صفحه مرجع جدید بساز {fillers[i%10]}",
    ]
    text=forms[(i//10)%2] + (" الان" if i>=10 else "")
    add("plane",f"v14_plane_empty_{i+1:03d}",text,do("feature.add",{"feature_type":"plane"}),axes=["creation","no_payload"])

# 15 linear pattern
for i in range(40):
    p=parts[i%len(parts)]
    copies=2+(i%8)
    dist=2.5+(i%10)
    forms=[
        f"{p} رو {copies} تا pattern کن با فاصله {amt(dist)}",
        f"از {p} {copies} copies خطی با فاصله {amt(dist)} بساز",
        f"{copies} تایی {p} رو الگو کن فاصله {amt(dist)}",
        f"برای {p} pattern {copies} تایی با {amt(dist)} فاصله بساز",
    ]
    add("pattern",f"v14_pat_{i+1:03d}",forms[(i//10)%4],do("feature.add",{"feature_type":"linearPattern","part_name":p,"copies":copies,"distance":amt(dist)}),axes=["count","distance","word_order"])

# 16 reorder / rollback
feature_pairs=[("Sketch","Extrude"),("Fillet","Draft"),("Extrude","Fillet"),("Draft","Sketch")]
for i in range(20):
    a,b=feature_pairs[i%4]
    s=f"{a} {2+i%9}"; t=f"{b} {12+i%9}"
    placement="before" if i%2==0 else "after"
    fa="قبل" if placement=="before" else "بعد"
    add("order",f"v14_reorder_{i+1:03d}",f"{s} رو {fa} از {t} ببر",do("feature.reorder",{"source_feature":s,"target_feature":t,"placement":placement}),axes=["relation","feature_order"])
for i in range(20):
    t=f"Extrude {2+i%18}"
    if i%2==0:
        add("order",f"v14_roll_{i+1:03d}",f"rollback رو بعد از {t} بذار",do("rollback.set",{"after_feature":t}),axes=["rollback","relation"])
    else:
        add("order",f"v14_roll_{i+1:03d}",f"rollback رو قبل از {t} بذار",do("rollback.set",{"before_feature":t}),axes=["rollback","relation"])

# 17 document / Part Studio
for i in range(20):
    name=f"fit hide studio {i+1}"
    add("document",f"v14_ps_{i+1:03d}",f"یه Part Studio جدید به اسم {name} بساز",do("documented.createPartStudio",{"new_name":name}),axes=["document_creation","literal_masking"])
for i in range(20):
    name=f"top delete archive {i+1}"
    add("document",f"v14_docren_{i+1:03d}",f"rename document to {name}",do("documented.updateDocumentAttributes",{"new_name":name}),axes=["document_rename","literal_masking"])

# 18 contextual corrections / relative parameter
for i in range(20):
    dirs=["left","right","up","down"]
    d=dirs[i%4]
    text="همون طرف بیشتر" if i%2==0 else "یکم بیشتر همون سمت"
    add("context",f"v14_ctx_cam_{i+1:03d}",text+" "+fillers[i%10],do("view.move",{"action":"orbit","direction":d}),{"last_move":{"action":"orbit","direction":d}},axes=["context","anaphora"])
for i in range(20):
    current=4.0+(i%5)
    delta=0.5+(i%4)*0.25
    addop=(i%2)==0
    verb="بیشتر" if addop else "کمتر"
    result=current+(delta if addop else -delta)
    text=f"این فیلت رو {amt(delta)} {verb} کن"
    add("context",f"v14_ctx_rel_{i+1:03d}",text,do("feature.parameter.set",{"feature_name":"Fillet 6","parameter":"radius","amount":amt(result)}),{"last_feature":"Fillet 6","feature_parameters":{"radius":amt(current)}},axes=["relative","context","quantity"])

# 19 literal-keyword contamination
keywords=["hide fit top","delete suppress","fillet chamfer","red blue","selection follow","rollback pattern","mirror hole","share pdf","clockwise zoom","state inspect"]
for i in range(10):
    name=keywords[i]+f" plane {i+1}"
    add("literal_mask",f"v14_lit_plane_{i+1:03d}",f"یه plane بساز با اسم {name}",do("feature.add",{"feature_type":"plane","name":name}),axes=["opaque_literal","keyword_collision"])
for i in range(10):
    name=keywords[i]+f" corner {i+1}"
    add("literal_mask",f"v14_lit_feature_{i+1:03d}",f"اسم Fillet {2+i} بشه {name}",do("feature.patch",{"feature_name":f"Fillet {2+i}","new_name":name}),axes=["opaque_literal","keyword_collision"])
for i in range(10):
    v=keywords[i]+f" note {i+1}"
    add("literal_mask",f"v14_lit_desc_{i+1:03d}",f"Part {2+i} description بذار {v}",do("metadata.property.set",{"part_name":f"Part {2+i}","property":"description","value":v}),axes=["opaque_literal","keyword_collision"])
for i in range(10):
    name=keywords[i]+f" archive {i+1}"
    add("literal_mask",f"v14_lit_doc_{i+1:03d}",f"rename document to {name}",do("documented.updateDocumentAttributes",{"new_name":name}),axes=["opaque_literal","keyword_collision"])

# 20 selection action vs referent vs inspect
for i in range(10):
    text=[f"همین چیزی که موس روشه رو انتخاب کن {fillers[i]}",f"این face رو select کن {fillers[i]}"][i%2]
    add("selection_semantics",f"v14_sel_ask_{i+1:03d}",text,ask(),axes=["selection_action","deictic","fail_closed"])
for i in range(10):
    text=[f"بگو الان چی انتخاب شده {fillers[i]}",f"selection فعلی چیه {fillers[i]}"][i%2]
    add("selection_semantics",f"v14_sel_ins_{i+1:03d}",text,do("viewer.inspect",{"mode":"selection"}),{"selection_count":2},axes=["inspect_action","referent"])
for i in range(10):
    text=[f"همین selection رو تو کادر جا بده {fillers[i]}",f"انتخاب فعلی رو fit کن {fillers[i]}"][i%2]
    add("selection_semantics",f"v14_sel_fit_{i+1:03d}",text,do("view.fit",{"action":"fit_selection"}),{"selection_count":2},axes=["fit_action","referent"])
for i in range(10):
    v=0.4+i*0.1
    text=f"روی انتخاب فعلی {amt(v)} پخ بزن {fillers[i]}"
    add("selection_semantics",f"v14_sel_edge_{i+1:03d}",text,do("feature.from_selection",{"feature_type":"chamfer","amount":amt(v)}),{"selection_count":1,"selection_types":["edge"]},axes=["edge_action","referent"])

# 21 open-ended design escalation
designs=[
    "سبکش کن ولی استحکام کم نشه",
    "ظاهرش رو حرفه ای تر کن",
    "برای تولید انبوه منطقی ترش کن",
    "درخت feature رو مرتب و خلوت کن",
    "برای تزریق پلاستیک بهترش کن",
    "وزن قطعه رو کم کن ولی ضعیف نشه",
    "طراحیش رو پریمیوم تر کن",
    "feature tree رو تمیز و منطقی کن",
    "برای قالب گیری مناسب ترش کن",
    "جمع و جورترش کن ولی سفت بمونه",
]
for i in range(40):
    text=designs[i%10]+" "+fillers[(i//4)%10]
    if i>=20: text="یه جور "+text
    add("design",f"v14_design_{i+1:03d}",text,think(),axes=["open_ended","engineering_judgment","mixed_language"])

# 22 unsupported / deictic ambiguity
asks=[
    "ازش یه mirror بساز",
    "یه hole اینجا بزن",
    "فایل STEP خروجی بده",
    "این مدل رو share کن",
    "یه PDF ازش export کن",
    "اون آخریه رو حذف کن",
    "سه میلش کن",
    "این رو انتخاب کن",
    "نمای front رو بیار",
    "ایزومتریکش کن",
]
for i in range(40):
    text=asks[i%10]+" "+fillers[(i//4)%10]
    if i>=20: text="حالا "+text
    add("unsupported",f"v14_ask_{i+1:03d}",text,ask(),axes=["unsupported","deictic","missing_grounding"])

# 23 multi-action residue
multi=[
    "Part 2 رو آبی کن و مخفیش کن",
    "روی انتخاب فیلت بزن و بعد پخ کن",
    "Fillet 3 رو حذف کن و Part 4 رو قرمز کن",
    "Part 5 رو نشون بده و اسمش رو عوض کن به spare",
    "یه plane بساز و بعد document رو rename کن به demo",
    "Extrude 4 رو خاموش کن و Fillet 2 رو پاک کن",
    "مدل رو fit کن و بعد top view بده",
    "Part 7 رو hide کن و material رو Steel بذار",
    "انتخاب رو پاک کن و بعد follow کن",
    "یه fillet جدید بساز و یه chamfer جدید هم بساز",
]
for i in range(40):
    text=multi[i%10]+" "+fillers[(i//4)%10]
    if i>=20: text="اول "+text
    add("multi_action",f"v14_multi_{i+1:03d}",text,ask(),axes=["multi_action","semantic_residue","safety"])

# 24 ambiguous quantity / target / parameter
amb=[
    "Fillet 4 رو سه کن",
    "Extrude 5 رو ده میل کن",
    "روی انتخاب فیلت بزن",
    "Part 2 رو pattern کن با فاصله پنج میل",
    "یه plane روی Front بساز",
    "این feature رو حذف کن",
    "اون part رو مخفی کن",
    "Draft 3 رو پنج میل کن",
    "Fillet 7 رو ده درجه کن",
    "دو میلش کن",
]
for i in range(40):
    text=amb[i%10]+" "+fillers[(i//4)%10]
    if i>=20: text="فقط "+text
    add("ambiguous",f"v14_amb_{i+1:03d}",text,ask(),axes=["ambiguity","missing_slot","unit_type"])

# 25 code-switch / reordered valid commands
for i in range(10):
    p=parts[i]
    add("code_switch",f"v14_mix_vis_{i+1:03d}",f"hide کن {p} رو {fillers[i]}",do("part.visibility",{"part_name":p,"visible":False}),axes=["code_switch","order"])
for i in range(10):
    p=parts[10+i]
    m=materials[i]
    add("code_switch",f"v14_mix_mat_{i+1:03d}",f"{m} بذار material {p} رو",do("metadata.property.set",{"part_name":p,"property":"material","value":m}),axes=["code_switch","order"])
for i in range(10):
    n=2+i
    add("code_switch",f"v14_mix_depth_{i+1:03d}",f"{10+i} mm کن depth رو برای Extrude {n}",do("feature.parameter.set",{"feature_name":f"Extrude {n}","parameter":"depth","amount":amt(10+i)}),axes=["code_switch","order","parameter"])
for i in range(10):
    add("code_switch",f"v14_mix_view_{i+1:03d}",f"top view {fillers[i]} بده",do("view.standard",{"view":"top"}),axes=["code_switch","order","view"])

assert len(CASES)==1000, len(CASES)

# Surface-only deterministic de-duplication before first score. This does not change
# semantics/gold labels; it only makes every utterance text distinct.
_seen={}
_suffixes=["، لطفاً","، مرسی","، اگه میشه","، ممنون","، همین الان"]
for c in CASES:
    base=c["text"]
    n=_seen.get(base,0)
    if n:
        suffix=_suffixes[min(n-1,len(_suffixes)-1)]
        candidate=base+suffix
        while candidate in _seen:
            suffix += "، لطفاً"
            candidate=base+suffix
        c["text"]=candidate
        c["axes"]=list(c.get("axes",[]))+["surface_dedup"]
    _seen[base]=n+1
    _seen[c["text"]]=1

texts=[c["text"] for c in CASES]
assert len(set(texts))==1000, (len(texts),len(set(texts)))
ids=[c["id"] for c in CASES]
assert len(set(ids))==1000

FAMILY_COUNTS={}
for c in CASES:
    FAMILY_COUNTS[c["category"]]=FAMILY_COUNTS.get(c["category"],0)+1

DIVERGENCE_AXES=sorted({a for c in CASES for a in c.get("axes",[])})
