from __future__ import annotations
import importlib.util
import pathlib

v17_path=pathlib.Path(__file__).resolve().parent.parent/"onshape-fast-router-fresh-v17-independent"/"fresh_holdout_v17_independent_10000.py"
spec=importlib.util.spec_from_file_location("v17_source",v17_path)
v17=importlib.util.module_from_spec(spec)
spec.loader.exec_module(v17)

CANDIDATES=[]
FAMILY_COUNTS={}

OPENERS=[
    "","راستی، ","اگه میشه الان ","می‌خوام ","یه کار دیگه: ",
    "این یکی رو: ","ممکنه ","زحمتش رو بکش و ","فعلاً ","خب این بار "
]
CLOSERS=[
    "","، لطف کردی","، تموم","؛ مرسی","، همین خوبه",
    "، فقط همین","، ممنون","، اوکی؟","، دیگه بسه","، انجامش بده لطفاً"
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
        w=dword(a["direction"])
        return [f"نگاه رو دور جسم بگردون سمت {w}",f"حول مدل دوربین رو به {w} متمایل کن",f"دید سه‌بعدی به {w} دور مدل گردش کنه",f"مدل رو با orbit افقی طرف {w} بچرخون"][i%4]
    if cat=="orbit_vertical":
        w=dword(a["direction"])
        return [f"نگاه رو دور قطعه به {w} قوس بده",f"حول مدل دوربین رو عمودی به {w} ببر",f"دید سه‌بعدی دور جسم به {w} گردش کنه",f"orbit عمودی رو سمت {w} انجام بده"][i%4]
    if cat=="orbit_roll":
        w="پادساعتگرد" if a["direction"]=="counterclockwise" else "ساعتگرد"
        return [f"صفحهٔ دید رو {w} رول کن",f"دوربین حول محور خودش {w} بچرخه",f"roll نمای فعلی {w} باشه",f"زاویه صفحه رو {w} گردش بده"][i%4]
    if cat=="pan_horizontal":
        w=dword(a["direction"])
        return [f"کادر رو افقی سر بده سمت {w}",f"بدون چرخوندن، نما رو به {w} منتقل کن",f"pan صفحه فقط به {w} باشه",f"viewport رو در صفحه به {w} شیفت بده"][i%4]
    if cat=="pan_vertical":
        w=dword(a["direction"])
        return [f"کادر رو عمودی سر بده {w}",f"بدون دوران، نما رو به {w} منتقل کن",f"pan صفحه فقط به {w} باشه",f"viewport رو در صفحه به سمت {w} شیفت بده"][i%4]
    if cat=="zoom":
        inside=a["direction"]=="in"
        return [("مدل رو درشت‌تر ببینم" if inside else "مدل رو ریزتر ببینم"),("فاصله دوربین با قطعه کمتر شه" if inside else "فاصله دوربین با قطعه بیشتر شه"),("بزرگ‌نمایی رو زیاد کن" if inside else "بزرگ‌نمایی رو کم کن"),("یک zoom in بده" if inside else "یک zoom out بده")][i%4]
    if cat=="fit_all":
        return ["کل مدل رو داخل قاب جا کن","همهٔ قطعه‌ها توی یک قاب دیده بشن","دوربین رو طوری تنظیم کن که کل هندسه داخل صفحه بیفته","برای همه مدل fit بزن"][i%4]
    if cat=="fit_selection":
        return ["فقط چیزایی که گرفتم قاب رو پر کنن","روی selection موجود قاب‌بندی کن","انتخاب فعلی رو fit داخل صفحه کن","دوربین رو فقط با انتخاب‌های الان جور کن"][i%4]
    if cat=="top_view":
        return ["نگاه رو قائم از بالا بذار","دید استاندارد XY از بالا رو بیار","دوربین دقیقاً بالای مدل و رو به پایین باشه","نمای Top استاندارد رو فعال کن"][i%4]
    if cat=="clear_selection":
        return ["همه انتخاب‌های فعلی رو لغو کن","هیچی selected نمونه","کل selection رو deselect کن","هرچی گرفته شده رها کن"][i%4]
    if cat=="inspect_selection":
        return ["الان چی‌ها انتخابن؟","selectedهای فعلی رو برام فهرست کن","بگو چه entityهایی الان گرفته شدن","محتوای selection رو بخون"][i%4]
    if cat=="inspect_state":
        return ["الان وضعیت viewer رو بهم بگو","state فعلی نمای مدل رو بخون","وضع دوربین و صفحه رو گزارش بده","viewer الان چه حالتی داره؟"][i%4]
    if cat=="inspect_collaboration":
        return ["الان چه آدم‌هایی توی سند هستن؟","participantهای حاضر رو گزارش بده","چه کسانی الان داخل session آنلاینن؟","فهرست همکارهای حاضر رو بده"][i%4]
    if cat=="follow_pair":
        return ["نمای همکار دیگه رو sync کن با دوربین من","دوربینم رو به دید نفر مقابل وصل کن","view اون یکی همکار رو follow کن","من رو روی دوربین همکار دیگر ببر"][i%4]
    if cat=="follow_three":
        return ["از بین سه نفر، دوربین نفر دوم رو بگیر","view participant دوم رو دنبال کن","من رو به نفر شماره دو follow کن","دوربینم رو با دومی sync کن"][i%4]
    if cat=="selected_fillet":
        x=a["amount"]
        return [f"لبه‌های گرفته‌شده رو با شعاع {x} نرم کن",f"برای edgeهای selected فیلت {x} اعمال کن",f"روی selection لبه‌ها radius {x} fillet بزن",f"همین لبه‌های انتخابی گردی {x} بگیرن"][i%4]
    if cat=="selected_chamfer":
        x=a["amount"]
        return [f"لبهٔ گرفته‌شده رو {x} پخ بزن",f"برای edge selected یک chamfer {x} اعمال کن",f"روی selection لبه bevel {x} بده",f"همین لبه انتخابی پخ {x} بگیره"][i%4]
    if cat=="new_fillet":
        x=a["amount"]
        return [f"بدون اینکه edgeای انتخاب باشه، یک fillet feature {x} اضافه کن",f"feature فیلت خالی با radius {x} بساز",f"selection نداریم؛ fillet جدید {x} ایجاد کن",f"یک fillet تازه {x} بساز بدون target فعلی"][i%4]
    if cat=="new_chamfer":
        x=a["amount"]
        return [f"بدون اینکه edgeای انتخاب باشه، یک chamfer feature {x} اضافه کن",f"feature پخ خالی با اندازه {x} بساز",f"selection نداریم؛ chamfer جدید {x} ایجاد کن",f"یک پخ تازه {x} بساز بدون target فعلی"][i%4]
    if cat in {"fillet_radius","extrude_depth","draft_angle"}:
        f=a["feature_name"]; x=a["amount"]; p=a["parameter"]
        fa={"radius":"شعاع","depth":"عمق","angle":"زاویه"}[p]
        return [f"{f}، {fa} رو {x} کن",f"مقدار {p} روی {f} باید {x} باشه",f"برای {f} پارامتر {fa} = {x}",f"{fa} فعلی {f} رو به {x} برسون"][i%4]
    if cat=="flip_direction":
        f=a["feature_name"]; v=a["value"]; w="فعال" if v else "غیرفعال"
        return [f"flip direction توی {f} رو {w} بذار",f"برای {f} جهت معکوس {'روشن' if v else 'خاموش'} باشه",f"{f} گزینه flip رو {'on' if v else 'off'} کن",f"حالت جهت برعکس {f} = {'true' if v else 'false'}"][i%4]
    if cat=="suppress":
        f=a["feature_name"]
        return [f"{f} رو موقت disable کن",f"{f} فعلاً توی regeneration حساب نشه",f"suppression {f} رو روشن کن",f"feature {f} رو از اجرا خارج کن"][i%4]
    if cat=="unsuppress":
        f=a["feature_name"]
        return [f"{f} رو دوباره enable کن",f"{f} دوباره توی regeneration حساب بشه",f"suppression {f} رو خاموش کن",f"feature {f} رو برگردون به اجرا"][i%4]
    if cat=="feature_rename":
        f=a["feature_name"]; n=a["new_name"]
        return [f"اسم تازهٔ {f} رو بذار {n}",f"{f} از حالا با عنوان {n} باشه",f"{f} رو rename کن به {n}",f"برای feature {f} نام {n} ثبت کن"][i%4]
    if cat=="feature_delete":
        f=a["feature_name"]
        return [f"{f} رو کلاً از history حذف کن",f"feature {f} رو پاکش کن",f"{f} دیگه توی feature tree نباشه",f"از درخت، {f} رو remove کن"][i%4]
    if cat=="part_hide":
        p=a["part_name"]
        return [f"{p} رو نامرئی کن",f"نمایش {p} رو ببند",f"visibility مربوط به {p} خاموش باشه",f"{p} از viewport قایم بشه"][i%4]
    if cat=="part_show":
        p=a["part_name"]
        return [f"{p} رو مرئی کن",f"نمایش {p} رو باز کن",f"visibility مربوط به {p} روشن باشه",f"{p} دوباره توی viewport پیدا باشه"][i%4]
    if cat=="part_delete":
        p=a["part_name"]
        return [f"خود {p} رو از مدل کامل بردار",f"این part یعنی {p} رو delete کن",f"{p} دیگه به‌عنوان قطعه وجود نداشته باشه",f"part {p} رو برای همیشه حذف کن"][i%4]
    if cat=="part_color":
        p=a["part_name"]; v=a["value"]
        return [f"رنگ ظاهری {p} رو {v} کن",f"appearance color برای {p} بشه {v}",f"{p} رنگ {v} داشته باشه",f"color property {p} = {v}"][i%4]
    if cat=="part_material":
        p=a["part_name"]; v=a["value"]
        return [f"متریال {p} رو روی {v} تنظیم کن",f"{p} جنسش {v} باشه",f"material property برای {p} = {v}",f"برای قطعه {p} جنس {v} ثبت کن"][i%4]
    if cat=="part_description":
        p=a["part_name"]; v=a["value"]
        return [f"توضیحات {p} رو بذار {v}",f"description {p} بشه {v}",f"روی {p} یادداشت {v} ثبت کن",f"متن توضیح قطعه {p}: {v}"][i%4]
    if cat=="part_rename":
        p=a["part_name"]; v=a["value"]
        return [f"اسم {p} رو بذار {v}",f"{p} از حالا عنوانش {v} باشه",f"rename part {p} to {v}",f"برای قطعه {p} نام {v} ثبت کن"][i%4]
    if cat=="plane_named":
        n=a["name"]
        return [f"یک plane تازه با اسم {n} اضافه کن",f"صفحه مرجع جدید رو {n} نام‌گذاری کن",f"reference plane بساز با title {n}",f"plane feature تازه‌ای به نام {n} ایجاد کن"][i%4]
    if cat=="plane_plain":
        return ["یک reference plane خالی اضافه کن","یه صفحه مرجع تازه بدون اسم خاص بساز","plane feature جدید خالی ایجاد کن","یک صفحه کمکی جدید بساز"][i%4]
    if cat=="linear_pattern":
        p=a["part_name"]; n=a["copies"]; dist=a["distance"]
        return [f"{p} رو خطی {n} نسخه کن با pitch {dist}",f"برای {p} linear pattern count {n} spacing {dist}",f"{n} کپی از {p} در خط با فاصله {dist} بساز",f"الگوی خطی {p} رو {n} تایی و گام {dist} بزن"][i%4]
    if cat=="feature_reorder":
        x=a["source_feature"]; y=a["target_feature"]; before=a["placement"]=="before"
        rel="پیش از" if before else "پس از"
        return [f"{x} توی درخت {rel} {y} قرار بگیره",f"history رو طوری بچین که {x} {'قبل' if before else 'بعد'} {y} باشه",f"جای {x} رو {'جلوتر از' if before else 'عقب‌تر از'} {y} کن",f"move {x} {'before' if before else 'after'} {y} in tree"][i%4]
    if cat=="rollback":
        b=a.get("before_feature"); aft=a.get("after_feature"); t=b or aft; rel="پیش از" if b else "پس از"
        return [f"تاریخچه رو تا {rel} {t} عقب ببر",f"rollback bar باید {'قبل' if b else 'بعد'} {t} بایسته",f"نقطه بازگشت رو {'جلوتر از' if b else 'بعدتر از'} {t} بذار",f"history rollback {'before' if b else 'after'} {t}"][i%4]
    if cat=="create_part_studio":
        n=a["new_name"]
        return [f"یه Part Studio نو اضافه کن با عنوان {n}",f"workspace جدید از نوع Part Studio بساز؛ اسمش {n}",f"یک تب Part Studio به نام {n} ایجاد کن",f"Part Studio تازه‌ای بساز و name آن {n} باشه"][i%4]
    if cat=="rename_document":
        n=a["new_name"]
        return [f"اسم فایل فعلی رو {n} کن",f"title این document رو بذار {n}",f"سند فعلی از حالا {n} نام داشته باشه",f"rename current document to {n}"][i%4]
    if cat=="context_camera_continue":
        return ["همین روند حرکت دوربین رو ادامه بده","یه نوبت دیگه همون مسیر قبلی رو برو","آخرین حرکت view رو دوباره انجام بده","همون جهت آخر رو یک قدم دیگه ادامه بده"][i%4]
    if cat=="context_camera_reverse":
        return ["جهت آخرین حرکت دوربین رو برگردون","همین حرکت قبلی رو خلافش انجام بده","یک قدم برعکس آخرین مسیر برو","view رو خلاف حرکت قبلی جابه‌جا کن"][i%4]
    if cat=="context_relative":
        f=a["feature_name"]; final=a["amount"]
        cur=c.get("ctx",{}).get("feature_parameters",{}).get("radius")
        try:
            cv=float(str(cur).split()[0]); fv=float(str(final).split()[0]); delta=abs(fv-cv)
            op="زیاد" if fv>cv else "کم"
            ds=("%g"%delta)+" mm"
        except Exception:
            ds="0.5 mm"; op="زیاد"
        return [f"شعاع همین فیلت رو {ds} {op} کن",f"برای همون {f} radius رو {ds} {'بیشتر' if op=='زیاد' else 'کمتر'} کن",f"مقدار فعلی radius رو به اندازه {ds} {'بالا' if op=='زیاد' else 'پایین'} ببر",f"همین feature باید در نهایت radius {final} داشته باشه"][i%4]
    if cat=="negation_correction":
        return ["Part 8 رو قایم نکن؛ visible نگهش دار","zoom in نکن؛ برعکس دورتر برو","Top رو نیار؛ به جاش همه selection رو deselect کن","به Fillet 7 دست نزن و حذفش نکن","selection رو پاک نکن؛ فقط لیست انتخاب‌ها رو بگو"][i%5]
    if cat=="multi_action_safe_ask":
        return ["Part 6 رو hide کن، بعدش Top رو هم بیار","اول selection رو clear کن و بعد Part 9 رو آبی کن","هم Fillet 8 رو delete کن هم Extrude 11 رو suppress کن","zoom out و pan right رو هر دو انجام بده","selection رو fit کن و بعد follow همکار رو بزن"][i%5]
    if cat=="conditional_safe_ask":
        return ["اگه selection صفر بود برو Top","اگر Part 7 دیده نمی‌شه، show کن","فقط وقتی Fillet 9 فعاله حذفش کن","اگر چیزی انتخاب شده، fit selection انجام بده","به شرط active بودن Extrude 5، suppressش کن"][i%5]
    if cat=="invalid_quantity_safe_ask":
        return [f"برای Fillet {3+i%40} radius = -1 mm",f"Draft {3+i%40} angle رو 120 deg بذار",f"Extrude {3+i%40} depth صفر میلی‌متر باشه",f"برای Part {3+i%40} linear pattern با count یک و spacing 5 mm بزن",f"Fillet {3+i%40} شعاع منفی 2 mm بگیره"][i%5]
    if cat=="ambiguous_target_safe_ask":
        return ["این دو part یعنی Part 4 و Part 7 رو مخفی کن","Fillet 4 و Fillet 6 هر دو حذف بشن","همین سطح رو select کن","اون edge رو بگیر"][i%4]
    if cat=="scope_boundary":
        if c.get("filter_reason")=="design_or_engineering_judgment":
            return ["این براکت رو با حفظ استحکام سبک‌تر طراحی کن","بهترین فرم رو برای تولید تیراژ بالا انتخاب کن","طراحی رو برای عمر خستگی بهتر بهینه کن","هندسه رو برای هزینه ساخت کمتر بازطراحی کن","مدل رو طوری طراحی کن که با تغییر ابعاد پایدار بمونه"][i%5]
        return ["بین این مقطع‌ها loft پیچیده مناسب بساز","قیدگذاری مهندسی کامل این sketch رو خودت تعیین کن","نقشه ساخت کامل این assembly رو تولید کن","shell مناسب این بدنه رو خودت انتخاب و بساز","mate مناسب این دو face رو تشخیص بده و اعمال کن"][i%5]
    raise KeyError(cat)

for c in v17.CANDIDATES:
    i=int(c["id"].rsplit("_",1)[1])
    nc=dict(c)
    nc["id"]="v18_"+c["id"][4:]
    nc["text"]=style(core_for(c,i),i)
    nc["axes"]=list(c.get("axes",[]))+["v18_new_lexicon_and_word_order"]
    CANDIDATES.append(nc)
    FAMILY_COUNTS[nc["category"]]=FAMILY_COUNTS.get(nc["category"],0)+1

CASES=[c for c in CANDIDATES if c.get("scope")=="apprentice"]
FILTERED=[c for c in CANDIDATES if c.get("scope")!="apprentice"]
assert len(CANDIDATES)==10000
assert len(CASES)==9800 and len(FILTERED)==200
