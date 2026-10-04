from __future__ import annotations
import importlib.util
import pathlib

v16_path=pathlib.Path(__file__).resolve().parent.parent/"onshape-fast-router-fresh-v16-filtered"/"fresh_holdout_v16_filtered_10000.py"
spec=importlib.util.spec_from_file_location("v16_source",v16_path)
v16=importlib.util.module_from_spec(spec)
spec.loader.exec_module(v16)

CANDIDATES=[]
FAMILY_COUNTS={}
OPENERS=["","حالا ","لطفاً یه لحظه ","اگه می‌تونی ","یه لطفی کن ","فقط ","خب پس ","برای من ","وقتی آماده‌ای ","ببین "]
CLOSERS=["","؛ ممنون"," لطفاً","، همین","، باشه؟"," اگه می‌تونی","، دیگه کاری ندارم","، مرسی","، ممنون می‌شم","، همین کافیه"]

def style(core,i):
    s=OPENERS[i%10]+core+CLOSERS[(i//10)%10]
    return s+("؟" if (i//100)%2 else "")

def first_do(c):
    return next((x for x in c["expected"] if x.get("route")=="do"),None)

def pword(d):
    return {"left":"چپ","right":"راست","up":"بالا","down":"پایین"}.get(d,d)

def core_for(c,i):
    cat=c["category"]; d=first_do(c); a=(d or {}).get("args",{})
    if cat=="orbit_horizontal":
        w=pword(a["direction"]); return [f"زاویه دید را دور قطعه به سمت {w} گردش بده",f"دوربین را افقی دور مدل ببر طرف {w}",f"مدل را در نما به جهت {w} بچرخان بدون pan",f"یک گردش افقی دور جسم به {w} انجام بده"][i%4]
    if cat=="orbit_vertical":
        w=pword(a["direction"]); return [f"دوربین را دور مدل به سمت {w} قوس بده",f"زاویه دید را عمودی به {w} بچرخان",f"یک orbit عمودی به طرف {w} انجام بده",f"دید را دور قطعه به {w} منتقل کن، نه pan"][i%4]
    if cat=="orbit_roll":
        w="خلاف جهت عقربه‌های ساعت" if a["direction"]=="counterclockwise" else "هم‌جهت عقربه‌های ساعت"
        return [f"صفحه دید را {w} بچرخان",f"چرخش دوربین حول محور دید {w} باشد",f"نمای فعلی را {w} rotate کن",f"حول خط دید {w} گردش بده"][i%4]
    if cat=="pan_horizontal":
        w=pword(a["direction"]); return [f"کادر را بدون دوران به {w} انتقال بده",f"viewport را صاف به سمت {w} جابه‌جا کن",f"فقط pan افقی به {w} انجام بده",f"دوربین را بدون orbit در صفحه به {w} بکش"][i%4]
    if cat=="pan_vertical":
        w=pword(a["direction"]); return [f"کادر را بدون چرخش به {w} منتقل کن",f"viewport را مستقیم به {w} جابه‌جا کن",f"فقط pan عمودی به {w} بزن",f"نما را در صفحه به سمت {w} بکش، بدون orbit"][i%4]
    if cat=="zoom":
        inside=a["direction"]=="in"; return [("فقط زوم کن و مدل را نزدیک‌تر بیاور" if inside else "فقط زوم کن و مدل را دورتر ببر"),("بزرگنمایی را بیشتر کن" if inside else "بزرگنمایی را کمتر کن"),("دوربین به مدل نزدیک‌تر شود" if inside else "دوربین از مدل فاصله بیشتری بگیرد"),("zoom in انجام بده" if inside else "zoom out انجام بده")][i%4]
    if cat=="fit_all": return ["مدل کامل طوری جا بگیرد که همه‌اش در کادر دیده شود","نمای کل مدل را با اندازه پنجره جور کن","همه هندسه را یکجا در viewport جا بده","fit کامل برای تمام مدل بزن"][i%4]
    if cat=="fit_selection": return ["فقط انتخاب‌های فعلی کادر را پر کنند","نمای دوربین را روی چیزهای انتخاب‌شده fit کن","همین selection را اندازه viewport کن","کادر را روی انتخاب فعلی تنظیم کن"][i%4]
    if cat=="top_view": return ["دوربین را عمود از بالای مدل قرار بده","جهت دید استاندارد بالا را فعال کن","نما را دقیقاً از بالا ببینم","Top استاندارد را روی viewer بگذار"][i%4]
    if cat=="clear_selection": return ["هیچ انتخابی در viewer باقی نماند","هر چیزی گرفته شده را از حالت انتخاب خارج کن","selection فعلی را کاملاً خالی کن","همه انتخاب‌ها را آزاد کن"][i%4]
    if cat=="inspect_selection": return ["بگو چه چیزهایی همین الان گرفته شده‌اند","محتویات selection فعلی را گزارش کن","الان دقیقاً کدام entityها انتخاب‌اند","فهرست چیزهای انتخاب‌شده را بده"][i%4]
    if cat=="inspect_state": return ["وضعیت فعلی نمای سه‌بعدی را بگو","یک گزارش از state فعلی viewer بده","الان viewer در چه وضعی است","وضع موجود صفحه مدل را گزارش کن"][i%4]
    if cat=="inspect_collaboration": return ["بگو چه کسانی الان در این جلسه حاضرند","وضع افراد حاضر در سند را گزارش کن","participantهای فعال را فهرست کن","الان چه همکارهایی در session هستند"][i%4]
    if cat=="follow_pair": return ["نمای همان همکار دیگر را دنبال کن","دوربینم را روی participant مقابل follow کن","دید نفر دیگر را برای من بگیر","به view همکار دوم وصل شو"][i%4]
    if cat=="follow_three": return ["از بین افراد حاضر، دید نفر دوم را دنبال کن","participant شماره دو را follow کن","دوربینم را به view دومی وصل کن","نفر دوم را برای دنبال‌کردن انتخاب کن"][i%4]
    if cat=="selected_fillet":
        x=a["amount"]; return [f"روی لبه‌های انتخاب‌شده گردی با شعاع {x} اعمال کن",f"برای selection فعلی fillet به اندازه {x} بساز",f"لبه‌های گرفته‌شده را با {x} گرد کن",f"همین edgeها fillet {x} بگیرند"][i%4]
    if cat=="selected_chamfer":
        x=a["amount"]; return [f"روی لبه انتخابی پخ با اندازه {x} اعمال کن",f"برای selection فعلی chamfer {x} بساز",f"همین edge را به مقدار {x} bevel کن",f"لبه گرفته‌شده پخ {x} بگیرد"][i%4]
    if cat=="new_fillet":
        x=a["amount"]; return [f"بدون لبه انتخابی یک feature fillet با مقدار {x} ایجاد کن",f"یک fillet خالی تازه با اندازه {x} بساز",f"feature جدید fillet {x} بساز؛ selection نداریم",f"فیلت {x} را به‌صورت feature تازه و بدون انتخاب بساز"][i%4]
    if cat=="new_chamfer":
        x=a["amount"]; return [f"بدون edge انتخابی یک feature chamfer {x} ایجاد کن",f"یک chamfer خالی تازه با اندازه {x} بساز",f"feature جدید پخ {x} بساز؛ selection نداریم",f"پخ {x} را به‌صورت feature تازه و بدون انتخاب بساز"][i%4]
    if cat in {"fillet_radius","extrude_depth","draft_angle"}:
        f=a["feature_name"]; x=a["amount"]; p=a["parameter"]; fa={"radius":"شعاع","depth":"عمق","angle":"زاویه"}[p]
        return [f"{fa} {f} را روی {x} تنظیم کن",f"برای {f} مقدار {p} برابر {x} باشد",f"{f}: {p} را به {x} تغییر بده",f"پارامتر {fa} در {f} بشود {x}"][i%4]
    if cat=="flip_direction":
        f=a["feature_name"]; v=a["value"]; w="فعال" if v else "غیرفعال"
        return [f"گزینه flip direction در {f} را {w} کن",f"برای {f} حالت flip direction {w} باشد",f"{f} مقدار flip direction را {'true' if v else 'false'} بگیرد",f"جهت برعکس در {f} را {w} بگذار"][i%4]
    if cat=="suppress":
        f=a["feature_name"]; return [f"{f} را موقتاً از محاسبه خارج کن",f"feature {f} را غیرفعال کن",f"{f} در حالت suppressed قرار بگیرد",f"regeneration برای {f} فعلاً خاموش باشد"][i%4]
    if cat=="unsuppress":
        f=a["feature_name"]; return [f"{f} را دوباره به محاسبه برگردان",f"feature {f} را دوباره فعال کن",f"{f} از حالت suppressed خارج شود",f"regeneration برای {f} دوباره روشن باشد"][i%4]
    if cat=="feature_rename":
        f=a["feature_name"]; n=a["new_name"]; return [f"{f} را از این به بعد {n} صدا کن",f"عنوان feature {f} را بگذار {n}",f"برای {f} نام تازه {n} ثبت کن",f"اسم {f} را تبدیل کن به {n}"][i%4]
    if cat=="feature_delete":
        f=a["feature_name"]; return [f"{f} را از درخت feature پاک کن",f"feature {f} را کامل حذف کن",f"{f} دیگر در مدل نباشد؛ delete کن",f"این feature یعنی {f} را بردار"][i%4]
    if cat=="part_hide":
        p=a["part_name"]; return [f"{p} را از دید پنهان کن",f"{p} در viewport نمایش داده نشود",f"نمایش {p} را خاموش کن",f"{p} را فعلاً invisible کن"][i%4]
    if cat=="part_show":
        p=a["part_name"]; return [f"{p} را به دید برگردان",f"{p} دوباره در viewport نمایش داده شود",f"نمایش {p} را روشن کن",f"{p} را دوباره visible کن"][i%4]
    if cat=="part_delete":
        p=a["part_name"]; return [f"خود قطعه {p} را از مدل بردار",f"part {p} را کامل delete کن",f"{p} دیگر به‌عنوان part وجود نداشته باشد",f"قطعه {p} را حذف کن"][i%4]
    if cat=="part_color":
        p=a["part_name"]; v=a["value"]; return [f"رنگ {p} را {v} قرار بده",f"color قطعه {p} برابر {v} باشد",f"برای {p} ظاهر رنگی {v} تنظیم کن",f"{p} را با رنگ {v} نشان بده"][i%4]
    if cat=="part_material":
        p=a["part_name"]; v=a["value"]; return [f"جنس {p} را {v} ثبت کن",f"material قطعه {p} برابر {v} باشد",f"برای {p} متریال {v} قرار بده",f"{p} از جنس {v} تنظیم شود"][i%4]
    if cat=="part_description":
        p=a["part_name"]; v=a["value"]; return [f"یادداشت {p} را بگذار {v}",f"متن description برای {p} این باشد: {v}",f"برای {p} توضیح {v} ثبت کن",f"description قطعه {p} را به {v} تغییر بده"][i%4]
    if cat=="part_rename":
        p=a["part_name"]; v=a["value"]; return [f"قطعه {p} را {v} نام‌گذاری کن",f"عنوان {p} را بگذار {v}",f"برای {p} اسم تازه {v} ثبت کن",f"نام {p} از این به بعد {v} باشد"][i%4]
    if cat=="plane_named":
        n=a["name"]; return [f"یک صفحه مرجع تازه با عنوان {n} بساز",f"reference plane جدیدی به نام {n} ایجاد کن",f"plane مرجع بساز و نامش را {n} ثبت کن",f"یک plane تازه ایجاد کن؛ اسم آن {n} باشد"][i%4]
    if cat=="plane_plain": return ["یک صفحه مرجع خالی تازه اضافه کن","reference plane جدید بدون نام خاص بساز","یک plane مرجع جدید ایجاد کن","feature صفحه مرجع خالی اضافه کن"][i%4]
    if cat=="linear_pattern":
        p=a["part_name"]; n=a["copies"]; dist=a["distance"]; return [f"از {p} در یک خط {n} نسخه با گام {dist} بساز",f"{p} را به صورت linear pattern با count {n} و spacing {dist} تکرار کن",f"الگوی خطی برای {p}: تعداد {n}، فاصله {dist}",f"برای {p} تکرار خطی {n} تایی با فاصله {dist} ایجاد کن"][i%4]
    if cat=="feature_reorder":
        x=a["source_feature"]; y=a["target_feature"]; before=a["placement"]=="before"; rel="جلوتر از" if before else "بعدتر از"
        return [f"در feature tree، {x} را {rel} {y} قرار بده",f"ترتیب را طوری بچین که {x} {rel} {y} باشد",f"جای {x} در درخت باید {rel} {y} شود",f"{x} را در تاریخچه {'قبل' if before else 'بعد'} {y} منتقل کن"][i%4]
    if cat=="rollback":
        b=a.get("before_feature"); aft=a.get("after_feature"); t=b or aft; rel="قبل" if b else "بعد"
        return [f"نقطه تاریخچه را تا درست {rel} از {t} برگردان",f"rollback را {rel} {t} قرار بده",f"نشانگر بازگشت در درخت {rel} {t} باشد",f"history bar را به {rel} {t} منتقل کن"][i%4]
    if cat=="create_part_studio":
        n=a["new_name"]; return [f"یک تب Part Studio تازه با نام {n} بساز",f"Part Studio جدیدی ایجاد کن و عنوانش {n} باشد",f"یک محیط Part Studio جدید به اسم {n} اضافه کن",f"workspace نوع Part Studio با نام {n} ایجاد کن"][i%4]
    if cat=="rename_document":
        n=a["new_name"]; return [f"عنوان سند را به {n} تغییر بده",f"document فعلی را {n} نام‌گذاری کن",f"اسم این سند از این به بعد {n} باشد",f"نام document را بگذار {n}"][i%4]
    if cat=="context_camera_continue": return ["یک بار دیگر دقیقاً همان حرکت دوربین را ادامه بده","همان جهت قبلی را یک مرحله دیگر برو","حرکت قبلی view را تکرار کن","دوربین همان مسیر قبلی را دوباره طی کند"][i%4]
    if cat=="context_camera_reverse": return ["حرکت قبلی دوربین را وارونه کن","یک قدم دقیقاً خلاف جهت قبلی برو","جهت آخرین حرکت view را برعکس کن","همان حرکت قبل را در جهت مخالف انجام بده"][i%4]
    if cat=="context_relative":
        f=a["feature_name"]; x=a["amount"]; cur=c.get("ctx",{}).get("feature_parameters",{}).get("radius")
        return [f"شعاع همین feature را طوری تغییر بده که بشود {x}",f"برای همان {f} مقدار radius نهایی {x} باشد",f"همین فیلت را به شعاع {x} برسان",f"radius فعلی {cur} است؛ مقدار نهایی را {x} کن"][i%4]
    if cat=="negation_correction": return ["Part 8 را پنهان نکن؛ برعکس نشانش بده","نزدیک نیا؛ فقط zoom out کن","نمای بالا نده؛ انتخاب‌ها را خالی کن","Fillet 7 را اصلاً حذف نکن","selection را پاک نکن؛ فقط بگو چه چیزهایی انتخاب‌اند"][i%5]
    if cat=="multi_action_safe_ask": return ["Part 6 را پنهان کن و بعد دوربین را از بالا ببر","انتخاب‌ها را خالی کن و سپس Part 9 را آبی کن","Fillet 8 را حذف کن و Extrude 11 را هم خاموش کن","هم zoom out کن هم نما را به راست pan کن","روی selection fit کن و بعد نفر دیگر را follow کن"][i%5]
    if cat=="conditional_safe_ask": return ["اگر هیچ چیزی انتخاب نیست، نمای بالا را فعال کن","در صورتی که Part 7 مخفی است آن را نشان بده","وقتی Fillet 9 فعال است آن را حذف کن","اگر selection وجود داشت روی آن fit کن","به شرط روشن بودن Extrude 5 آن را suppress کن"][i%5]
    if cat=="invalid_quantity_safe_ask": return [f"شعاع Fillet {3+i%40} را منفی یک میلی‌متر کن",f"زاویه Draft {3+i%40} را 120 درجه بگذار",f"عمق Extrude {3+i%40} را صفر میلی‌متر کن",f"از Part {3+i%40} pattern با فقط یک نسخه و گام 5 mm بساز",f"برای Fillet {3+i%40} مقدار radius را -2 mm ثبت کن"][i%5]
    if cat=="ambiguous_target_safe_ask": return ["Part 4 و Part 7 هر دو را پنهان کن","Fillet 4 و Fillet 6 را با هم حذف کن","همین face را بگیر","آن edge را انتخاب کن"][i%4]
    if cat=="scope_boundary":
        if c.get("filter_reason")=="design_or_engineering_judgment":
            return ["این قطعه را طوری بازطراحی کن که با وزن کمتر همان استحکام را نگه دارد","برای تولید سری این مدل بهترین هندسه را انتخاب کن","هندسه را برای کمترین تمرکز تنش بهینه‌سازی کن","طرح را برای ماشین‌کاری اقتصادی‌تر بازمهندسی کن","مدل را در برابر تغییر پارامترها مقاوم‌تر طراحی کن"][i%5]
        return ["از این پروفایل‌ها یک loft مهندسی‌شده کامل بساز","قیدگذاری کامل sketch را خودت طراحی و اعمال کن","drawing تولیدی کامل این assembly را بساز","برای این بدنه shell مناسب را انتخاب و ایجاد کن","برای این دو face نوع mate مناسب را انتخاب و اعمال کن"][i%5]
    raise KeyError(cat)

for c in v16.CANDIDATES:
    i=int(c["id"].rsplit("_",1)[1])
    nc=dict(c)
    nc["id"]="v17_"+c["id"][4:]
    nc["text"]=style(core_for(c,i),i)
    nc["axes"]=list(c.get("axes",[]))+["v17_independent_surface"]
    CANDIDATES.append(nc)
    FAMILY_COUNTS[nc["category"]]=FAMILY_COUNTS.get(nc["category"],0)+1

CASES=[c for c in CANDIDATES if c.get("scope")=="apprentice"]
FILTERED=[c for c in CANDIDATES if c.get("scope")!="apprentice"]
assert len(CANDIDATES)==10000
assert len(CASES)==9800 and len(FILTERED)==200
