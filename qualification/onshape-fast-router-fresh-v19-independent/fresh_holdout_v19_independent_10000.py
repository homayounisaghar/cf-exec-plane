from __future__ import annotations
import importlib.util
import pathlib

v18_path=pathlib.Path(__file__).resolve().parent.parent/"onshape-fast-router-fresh-v18-independent"/"fresh_holdout_v18_independent_10000.py"
spec=importlib.util.spec_from_file_location("v18_source",v18_path)
v18=importlib.util.module_from_spec(spec)
spec.loader.exec_module(v18)

CANDIDATES=[]
FAMILY_COUNTS={}

OPENERS=[
    "برای مورد بعدی، ","این بار می‌خوام ","روی همین کار، ","یه درخواست تازه: ",
    "الان لطفاً ","در ادامه، ","مورد بعد اینه: ","برای این یکی، ",
    "یه تغییر دیگه: ","این فرمان رو انجام بده: "
]
CLOSERS=[
    "","؛ همین.","، فقط همین کار.","، ممنون.","؛ مورد دیگه‌ای نیست.",
    "، همین کافی است.","؛ اجراش کن.","، تمام.","؛ همین را انجام بده.","، لطفاً."
]

def style(core,i):
    s=OPENERS[i%10]+core+CLOSERS[(i//10)%10]
    if (i//100)%2:
        s="«"+s+"»"
    return s

def first_do(c):
    return next((x for x in c["expected"] if x.get("route")=="do"),None)

def dword(d):
    return {"left":"چپ","right":"راست","up":"بالا","down":"پایین"}.get(d,d)

def core_for(c,i):
    cat=c["category"]; d=first_do(c); a=(d or {}).get("args",{})
    if cat=="orbit_horizontal":
        w=dword(a["direction"]); return [f"دور مدل، زاویهٔ دید را افقی به {w} بگردان",f"camera را حول جسم سمت {w} orbit بده",f"نگاه سه‌بعدی را از پهلو به {w} بچرخان",f"حول قطعه یک چرخش افقی به {w} انجام بده"][i%4]
    if cat=="orbit_vertical":
        w=dword(a["direction"]); return [f"زاویهٔ دید را عمودی دور مدل به {w} ببر",f"camera را حول جسم رو به {w} orbit کن",f"نگاه سه‌بعدی را روی قوس عمودی به {w} جابه‌جا کن",f"دور قطعه یک چرخش عمودی سمت {w} بده"][i%4]
    if cat=="orbit_roll":
        w="خلاف جهت ساعت" if a["direction"]=="counterclockwise" else "هم‌جهت ساعت"
        return [f"view را حول محور تصویر {w} بچرخان",f"صفحهٔ دید را {w} roll بده",f"camera roll را {w} انجام بده",f"جهت صفحه را حول خودش {w} بگردان"][i%4]
    if cat=="pan_horizontal":
        w=dword(a["direction"]); return [f"بدون چرخش، view را افقی به {w} هل بده",f"viewport را در صفحه به {w} pan کن",f"کادر دید را فقط به {w} منتقل کن",f"camera framing را صاف سمت {w} جابه‌جا کن"][i%4]
    if cat=="pan_vertical":
        w=dword(a["direction"]); return [f"بدون دوران، view را عمودی به {w} ببر",f"viewport را در صفحه به سمت {w} pan کن",f"کادر دید را فقط {w} منتقل کن",f"camera framing را صاف به {w} جابه‌جا کن"][i%4]
    if cat=="zoom":
        inside=a["direction"]=="in"
        return [("به مدل نزدیک‌تر شو" if inside else "از مدل فاصله بگیر"),("zoom را بیشتر کن" if inside else "zoom را کمتر کن"),("مدل در تصویر بزرگ‌تر دیده شود" if inside else "مدل در تصویر کوچک‌تر دیده شود"),("camera را به قطعه نزدیک کن" if inside else "camera را از قطعه دور کن")][i%4]
    if cat=="fit_all":
        return ["تمام هندسه را یکجا داخل viewport جا بده","کادر را طوری تنظیم کن که کل مدل دیده شود","همهٔ مدل را در صفحه fit کن","frame را روی کل geometry تنظیم کن"][i%4]
    if cat=="fit_selection":
        return ["فقط موارد selected را داخل قاب جا بده","frame را روی selection فعلی تنظیم کن","انتخاب‌های الان تمام viewport را پر کنند","روی چیزهایی که گرفته‌ام fit selection انجام بده"][i%4]
    if cat=="top_view":
        return ["دوربین را روی نمای استاندارد از بالا بگذار","view را به Top استاندارد ببر","نگاه را عمود بر مدل از بالا تنظیم کن","نمای سه‌بعدی را روی top view قرار بده"][i%4]
    if cat=="clear_selection":
        return ["تمام selection فعلی را آزاد کن","هرچه selected است deselect شود","انتخاب‌های موجود را کامل پاک کن","هیچ entity انتخاب‌شده‌ای باقی نماند"][i%4]
    if cat=="inspect_selection":
        return ["فهرست چیزهای selected فعلی را بگو","الان چه entityهایی انتخاب شده‌اند؟","محتوای selection کنونی را گزارش کن","بگو در حال حاضر چه چیزهایی گرفته شده‌اند"][i%4]
    if cat=="inspect_state":
        return ["وضع کنونی viewer را گزارش کن","state فعلی دوربین و view را بگو","الان نمای مدل در چه وضعی است؟","وضعیت جاری صفحهٔ سه‌بعدی را بخوان"][i%4]
    if cat=="inspect_collaboration":
        return ["افراد حاضر در همکاری را فهرست کن","بگو چه participantهایی الان داخل سند هستند","وضع حضور همکارها در session را گزارش کن","چه کسانی هم‌اکنون روی سند آنلاین‌اند؟"][i%4]
    if cat=="follow_pair":
        return ["نمای همکار مقابل را روی دوربین من دنبال کن","camera من را با view همکار دیگر sync کن","دید نفر دیگر را follow کن","من را به نمای participant مقابل وصل کن"][i%4]
    if cat=="follow_three":
        return ["در بین سه نفر، view نفر دوم را follow کن","camera را با participant شماره دو sync کن","دید همکار دوم را دنبال کن","از سه participant، دومی را برای follow انتخاب کن"][i%4]
    if cat=="selected_fillet":
        x=a["amount"]; return [f"روی edgeهای selected فیلت با اندازه {x} بزن",f"لبه‌های انتخاب‌شده radius {x} بگیرند",f"برای selection فعلی fillet مقدار {x} اعمال کن",f"همین لبه‌های گرفته‌شده را با {x} گرد کن"][i%4]
    if cat=="selected_chamfer":
        x=a["amount"]; return [f"روی edge selected پخ با اندازه {x} بده",f"لبهٔ انتخابی chamfer {x} بگیرد",f"برای selection فعلی bevel مقدار {x} اعمال کن",f"همین لبهٔ گرفته‌شده را {x} پخ کن"][i%4]
    if cat=="new_fillet":
        x=a["amount"]; return [f"بدون selection، یک feature فیلت تازه با {x} بساز",f"fillet جدید با radius {x} و بدون target ایجاد کن",f"یک feature fillet خالی با مقدار {x} اضافه کن",f"وقتی لبه‌ای انتخاب نیست، fillet تازه {x} بساز"][i%4]
    if cat=="new_chamfer":
        x=a["amount"]; return [f"بدون selection، یک feature chamfer تازه با {x} بساز",f"پخ جدید با اندازه {x} و بدون target ایجاد کن",f"یک feature bevel خالی با مقدار {x} اضافه کن",f"وقتی لبه‌ای انتخاب نیست، chamfer تازه {x} بساز"][i%4]
    if cat in {"fillet_radius","extrude_depth","draft_angle"}:
        f=a["feature_name"]; x=a["amount"]; p=a["parameter"]; fa={"radius":"radius","depth":"depth","angle":"angle"}[p]
        return [f"روی {f} مقدار {fa} را به {x} تغییر بده",f"{fa} مربوط به {f} باید {x} شود",f"پارامتر {fa} در {f} = {x}",f"برای {f}، {fa} را دقیقاً {x} تنظیم کن"][i%4]
    if cat=="flip_direction":
        f=a["feature_name"]; v=a["value"]; vv="فعال" if v else "غیرفعال"
        return [f"در {f} گزینهٔ flip direction را {vv} کن",f"جهت معکوس {f} {'on' if v else 'off'} باشد",f"برای {f} مقدار flip = {'true' if v else 'false'}",f"حالت reverse direction روی {f} را {'روشن' if v else 'خاموش'} کن"][i%4]
    if cat=="suppress":
        f=a["feature_name"]; return [f"{f} را suppress کن",f"{f} فعلاً در regeneration محاسبه نشود",f"feature {f} را موقتاً disable کن",f"{f} را از اجرای مدل خارج کن"][i%4]
    if cat=="unsuppress":
        f=a["feature_name"]; return [f"{f} را از suppress خارج کن",f"{f} دوباره در regeneration محاسبه شود",f"feature {f} را دوباره enable کن",f"{f} را به اجرای مدل برگردان"][i%4]
    if cat=="feature_rename":
        f=a["feature_name"]; n=a["new_name"]; return [f"نام {f} را به {n} عوض کن",f"برای feature {f} عنوان {n} ثبت کن",f"{f} از این به بعد {n} نام داشته باشد",f"rename {f} to {n}"][i%4]
    if cat=="feature_delete":
        f=a["feature_name"]; return [f"{f} را از feature tree حذف کن",f"feature {f} را کامل پاک کن",f"{f} دیگر در history وجود نداشته باشد",f"remove {f} from the feature tree"][i%4]
    if cat=="part_hide":
        p=a["part_name"]; return [f"{p} را از دید مخفی کن",f"visibility {p} را off کن",f"{p} در viewport دیده نشود",f"نمایش {p} را خاموش کن"][i%4]
    if cat=="part_show":
        p=a["part_name"]; return [f"{p} را دوباره قابل‌دیدن کن",f"visibility {p} را on کن",f"{p} در viewport دیده شود",f"نمایش {p} را روشن کن"][i%4]
    if cat=="part_delete":
        p=a["part_name"]; return [f"{p} را به‌طور کامل از مدل حذف کن",f"part {p} را delete کن",f"{p} دیگر به‌عنوان قطعه وجود نداشته باشد",f"خود قطعهٔ {p} را از مدل بردار"][i%4]
    if cat=="part_color":
        p=a["part_name"]; v=a["value"]; return [f"appearance color {p} را {v} قرار بده",f"رنگ نمایشی {p} باید {v} باشد",f"برای {p} color property = {v}",f"{p} را با رنگ {v} نمایش بده"][i%4]
    if cat=="part_material":
        p=a["part_name"]; v=a["value"]; return [f"material مربوط به {p} را {v} بگذار",f"جنس {p} باید {v} باشد",f"برای {p} material property = {v}",f"متریال قطعهٔ {p} را به {v} تغییر بده"][i%4]
    if cat=="part_description":
        p=a["part_name"]; v=a["value"]; return [f"برای {p} description را این بگذار: {v}",f"یادداشت قطعهٔ {p} باید {v} باشد",f"description {p} = {v}",f"روی {p} متن توضیح {v} ثبت کن"][i%4]
    if cat=="part_rename":
        p=a["part_name"]; v=a["value"]; return [f"نام part {p} را به {v} تغییر بده",f"{p} از حالا {v} نام داشته باشد",f"برای قطعهٔ {p} عنوان {v} ثبت کن",f"rename {p} to {v}"][i%4]
    if cat=="plane_named":
        n=a["name"]; return [f"یک reference plane تازه با نام {n} ایجاد کن",f"plane جدیدی بساز که عنوانش {n} باشد",f"صفحهٔ مرجع {n} را اضافه کن",f"create a new plane named {n}"][i%4]
    if cat=="plane_plain":
        return ["یک reference plane تازه و خالی بساز","یک صفحهٔ مرجع جدید بدون نام خاص اضافه کن","plane feature خالی ایجاد کن","یک صفحهٔ کمکی تازه بساز"][i%4]
    if cat=="linear_pattern":
        p=a["part_name"]; n=a["copies"]; dist=a["distance"]; return [f"از {p} یک linear pattern با {n} کپی و فاصله {dist} بساز",f"{p} را در خط {n} بار با spacing {dist} تکرار کن",f"pattern خطی {p}: count {n}, pitch {dist}",f"{n} نسخه از {p} با گام {dist} در یک خط ایجاد کن"][i%4]
    if cat=="feature_reorder":
        x=a["source_feature"]; y=a["target_feature"]; before=a["placement"]=="before"
        return [f"در feature tree، {x} را {'قبل از' if before else 'بعد از'} {y} قرار بده",f"ترتیب history را طوری عوض کن که {x} {'پیش از' if before else 'پس از'} {y} باشد",f"{x} را {'جلوتر از' if before else 'عقب‌تر از'} {y} منتقل کن",f"move {x} {'before' if before else 'after'} {y}"][i%4]
    if cat=="rollback":
        b=a.get("before_feature"); aft=a.get("after_feature"); t=b or aft; before=bool(b)
        return [f"rollback را {'قبل از' if before else 'بعد از'} {t} قرار بده",f"history bar باید {'پیش از' if before else 'پس از'} {t} بایستد",f"نقطهٔ بازگشت را {'جلوتر از' if before else 'بعدتر از'} {t} بگذار",f"set rollback {'before' if before else 'after'} {t}"][i%4]
    if cat=="create_part_studio":
        n=a["new_name"]; return [f"یک Part Studio تازه با نام {n} بساز",f"تب جدید Part Studio با عنوان {n} ایجاد کن",f"workspace از نوع Part Studio به اسم {n} اضافه کن",f"create Part Studio named {n}"][i%4]
    if cat=="rename_document":
        n=a["new_name"]; return [f"نام document فعلی را به {n} تغییر بده",f"title سند جاری را {n} بگذار",f"فایل کنونی از این به بعد {n} نام داشته باشد",f"rename this document to {n}"][i%4]
    if cat=="context_camera_continue":
        return ["حرکت قبلی camera را یک مرحله دیگر ادامه بده","همان مسیر آخر view را تکرار کن","دوربین را باز هم در جهت حرکت قبلی ببر","آخرین حرکت دید را یک بار دیگر انجام بده"][i%4]
    if cat=="context_camera_reverse":
        return ["دوربین را دقیقاً خلاف جهت حرکت قبلی ببر","آخرین مسیر view را معکوس کن","یک حرکت مخالف آخرین جابه‌جایی camera انجام بده","جهت حرکت قبلی دید را برگردان"][i%4]
    if cat=="context_relative":
        f=a["feature_name"]; final=a["amount"]; cur=c.get("ctx",{}).get("feature_parameters",{}).get("radius")
        try:
            cv=float(str(cur).split()[0]); fv=float(str(final).split()[0]); delta=abs(fv-cv); ds=("%g"%delta)+" mm"; inc=fv>cv
        except Exception:
            ds="0.5 mm"; inc=True
        return [f"radius همین {f} را {ds} {'زیاد' if inc else 'کم'} کن",f"برای همان feature شعاع را {ds} {'بیشتر' if inc else 'کمتر'} کن",f"مقدار radius فعلی را {ds} {'بالا' if inc else 'پایین'} ببر",f"radius همان {f} باید در پایان {final} شود"][i%4]
    if cat=="negation_correction":
        return ["Part 8 را hide نکن؛ visible باقی بماند","zoom in انجام نده؛ به‌جایش از مدل دور شو","Top view را اجرا نکن؛ فقط selection را clear کن","Fillet 7 را حذف نکن و تغییرش نده","selection را پاک نکن؛ فقط محتویاتش را گزارش کن"][i%5]
    if cat=="multi_action_safe_ask":
        return ["Part 6 را مخفی کن و بعد Top view را هم فعال کن","selection را clear کن، سپس Part 9 را آبی کن","هم Fillet 8 را پاک کن و هم Extrude 11 را suppress کن","هم zoom out بده هم pan right","اول selection را fit کن و بعد follow همکار را انجام بده"][i%5]
    if cat=="conditional_safe_ask":
        return ["اگر selection خالی است Top view را بیاور","اگر Part 7 مخفی است آن را show کن","تنها در صورت فعال بودن Fillet 9 آن را حذف کن","اگر چیزی selected است fit selection بزن","به شرط active بودن Extrude 5، آن را suppress کن"][i%5]
    if cat=="invalid_quantity_safe_ask":
        return [f"Fillet {3+i%40} را با radius منفی 3 mm تنظیم کن",f"زاویهٔ Draft {3+i%40} را 135 deg بگذار",f"depth مربوط به Extrude {3+i%40} را 0 mm کن",f"برای Part {3+i%40} یک linear pattern با صفر copy و فاصله 6 mm بساز",f"شعاع Fillet {3+i%40} باید -0.5 mm باشد"][i%5]
    if cat=="ambiguous_target_safe_ask":
        return ["هر دو Part 4 و Part 7 را hide کن","Fillet 4 و Fillet 6 را با هم حذف کن","همین face را انتخاب کن","آن edge را select کن"][i%4]
    if cat=="scope_boundary":
        if c.get("filter_reason")=="design_or_engineering_judgment":
            return ["این براکت را برای نسبت استحکام به وزن بهتر بازطراحی کن","بهترین هندسه را برای تولید انبوه خودت انتخاب کن","طراحی را برای عمر خستگی بالاتر بهینه کن","برای کاهش هزینهٔ ساخت، فرم قطعه را خودت اصلاح کن","مدل را طوری بازطراحی کن که در برابر تغییر پارامترها robust باشد"][i%5]
        return ["یک loft چندمقطعی مناسب بین این پروفایل‌ها خودت بساز","قیدهای کامل این sketch را مهندسی و اعمال کن","drawing ساخت کامل این assembly را آماده کن","ضخامت مناسب shell را تشخیص بده و بساز","mate مناسب این دو سطح را خودت انتخاب و اعمال کن"][i%5]
    raise KeyError(cat)

for c in v18.CANDIDATES:
    i=int(c["id"].rsplit("_",1)[1])
    nc=dict(c)
    nc["id"]="v19_"+c["id"][4:]
    nc["text"]=style(core_for(c,i),i)
    nc["axes"]=list(c.get("axes",[]))+["v19_independent_rewording"]
    CANDIDATES.append(nc)
    FAMILY_COUNTS[nc["category"]]=FAMILY_COUNTS.get(nc["category"],0)+1

CASES=[c for c in CANDIDATES if c.get("scope")=="apprentice"]
FILTERED=[c for c in CANDIDATES if c.get("scope")!="apprentice"]
assert len(CANDIDATES)==10000
assert len(CASES)==9800 and len(FILTERED)==200
