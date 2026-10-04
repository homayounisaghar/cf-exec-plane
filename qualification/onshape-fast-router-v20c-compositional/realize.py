from __future__ import annotations
import argparse, json, pathlib, re

PREFIXES=[
"این بار برای همین مرحله دستور روشن من این است: ",
"برای حرکت بعدی در محیط مدل‌سازی فقط این را اجرا کن: ",
"در ادامهٔ کار روی همین سند درخواست مشخص من این است: ",
"برای این نوبت از کار روی مدل همین تغییر را انجام بده: ",
"الان روی وضعیت فعلی مدل فقط این اقدام را انجام بده: ",
"برای قدم بعدی بدون حدس اضافه این دستور را اجرا کن: ",
"در همین بخش از کار روی مدل درخواست من دقیقاً این است: ",
"برای ادامهٔ این ویرایش روی مدل همین کار را انجام بده: ",
"در وضعیت فعلی سند فرمان بعدی من این است: ",
"برای مرحلهٔ جاری مدل‌سازی فقط همین دستور را اجرا کن: ",
"این نوبت روی مدل درخواست اجرایی من این است: ",
"در ادامهٔ همین کار لطفاً فقط این اقدام را انجام بده: ",
"برای همین وضعیت فعلی مدل دستور بعدی من این است: ",
"روی سندی که الان باز است همین تغییر را انجام بده: ",
"برای این مرحلهٔ مشخص از مدل‌سازی درخواست من این است: ",
"در همین نمای فعلی فقط دستور زیر را اجرا کن: ",
"برای ادامهٔ کار در همین سند همین اقدام را انجام بده: ",
"الان بدون تغییر جانبی فقط این دستور را روی مدل اجرا کن: ",
"برای قدم فعلی از این کار درخواست دقیق من این است: ",
"در همین لحظه روی مدل همین فرمان را اجرا کن: ",
"برای مرحلهٔ بعدی کار روی سند فقط همین را انجام بده: ",
"در وضعیت فعلی مدل درخواست بعدی من این است: ",
"برای این بخش از ویرایش مدل همین دستور را اجرا کن: ",
"روی همین مدل و در همین مرحله فقط این کار را انجام بده: ",
"برای ادامهٔ همین جلسهٔ مدل‌سازی فرمان من این است: "
]

MIDS=[
"دقیقاً ",
"فقط ",
"در همین وضعیت ",
"روی وضعیت فعلی ",
"بدون کار اضافه ",
"طبق همین درخواست ",
"در همین مرحله "
]

SUFFIXES=[
"؛ هیچ اثر دیگری ایجاد نکن.",
"؛ چیز دیگری را دست نزن.",
"؛ فقط همین نتیجه را می‌خواهم.",
"؛ بقیهٔ وضعیت همان‌طور بماند.",
"؛ اقدام اضافه‌ای انجام نشود.",
"؛ نتیجه به همین تغییر محدود بماند.",
"؛ غیر از این مورد چیزی عوض نشود.",
"؛ همین یک درخواست را اجرا کن.",
"؛ تغییر دیگری همراهش نکن.",
"؛ فقط اثر همین فرمان اعمال شود.",
"؛ باقی مدل بدون تغییر بماند.",
"؛ این درخواست را مستقل از کارهای دیگر اجرا کن.",
"؛ روی مورد دیگری اثر نگذار.",
"؛ از این دستور فراتر نرو.",
"؛ همین خروجی کافی است.",
"؛ فقط همین اثر منظور من است.",
"؛ هیچ تصمیم طراحی اضافه‌ای نگیر.",
"؛ همین فرمان را جداگانه انجام بده.",
"؛ فقط نتیجهٔ همین دستور لازم است.",
"؛ بقیهٔ سند را تغییر نده."
]

def read_jsonl(path):
    out=[]
    with open(path,encoding="utf-8") as f:
        for line in f:
            if line.strip(): out.append(json.loads(line))
    return out

def write_jsonl(path,rows):
    with open(path,"w",encoding="utf-8") as f:
        for r in rows:
            f.write(json.dumps(r,ensure_ascii=False,sort_keys=True,separators=(",",":"))+"\n")

def sid_index(sid):
    m=re.search(r"_(\d{4})$",sid)
    return int(m.group(1)) if m else 0

def fdir(x):
    return {"left":"سمت چپ","right":"سمت راست","up":"به بالا","down":"به پایین",
            "clockwise":"در جهت ساعت‌گرد","counterclockwise":"در جهت پادساعت‌گرد",
            "in":"به داخل","out":"به بیرون"}.get(x,str(x))

def core(s):
    fam=s["family"]; g=s["gold"]; a=g.get("args") or {}; c=s.get("context") or {}; i=sid_index(s["scenario_id"])
    if fam=="orbit_horizontal":
        return f"دوربین را در مدار افقی دور مدل به {fdir(a['direction'])} بچرخان"
    if fam=="orbit_vertical":
        return f"دوربین را در مدار عمودی دور مدل {fdir(a['direction'])} ببر"
    if fam=="orbit_roll":
        return f"نمای دوربین را حول محور نگاه {fdir(a['direction'])} roll کن"
    if fam=="pan_horizontal":
        return f"viewport را بدون orbit به صورت افقی به {fdir(a['direction'])} pan کن"
    if fam=="pan_vertical":
        return f"viewport را بدون orbit به صورت عمودی {fdir(a['direction'])} pan کن"
    if fam=="zoom":
        return "بزرگ‌نمایی نما را بیشتر کن" if a["direction"]=="in" else "بزرگ‌نمایی نما را کمتر کن"
    if fam=="fit_all":
        return "کادر دوربین را طوری تنظیم کن که کل هندسهٔ مدل یکجا در نما جا شود"
    if fam=="fit_selection":
        return "کادر دوربین را فقط روی selection فعلی تنظیم کن تا انتخاب‌ها در نما جا شوند"
    if fam=="top_view":
        return "نمای استاندارد Top را برای viewer فعال کن"
    if fam=="clear_selection":
        return "تمام انتخاب‌های فعلی viewer را پاک کن تا selection خالی شود"
    if fam=="inspect_selection":
        return "بدون تغییر selection گزارش بده الان چه entityهایی انتخاب شده‌اند"
    if fam=="inspect_state":
        return "بدون تغییر مدل وضعیت فعلی viewer و camera را گزارش بده"
    if fam=="inspect_collaboration":
        return "فهرست collaboratorهای حاضر در session فعلی سند را گزارش بده"
    if fam=="follow_pair":
        return "وقتی دو collaborator حاضرند نمای نفر دیگر را در viewer من follow کن"
    if fam=="follow_three":
        return f"بین سه collaborator نمای نفر شماره {a['candidate_index']} را follow کن"
    if fam=="selected_fillet":
        return f"روی edgeهای selected یک fillet با اندازه {a['amount']} اعمال کن"
    if fam=="selected_chamfer":
        return f"روی edge selected یک chamfer با اندازه {a['amount']} اعمال کن"
    if fam=="new_fillet":
        return f"در حالی که selection خالی است یک feature fillet تازه با مقدار {a['amount']} ایجاد کن"
    if fam=="new_chamfer":
        return f"در حالی که selection خالی است یک feature chamfer تازه با مقدار {a['amount']} ایجاد کن"
    if fam in {"fillet_radius","extrude_depth","draft_angle"}:
        return f"پارامتر {a['parameter']} در {a['feature_name']} را دقیقاً روی {a['amount']} تنظیم کن"
    if fam=="flip_direction":
        return f"پارامتر flip direction در {a['feature_name']} را روی {'true' if a['value'] else 'false'} بگذار"
    if fam=="suppress":
        return f"feature موجود {a['feature_name']} را suppress کن"
    if fam=="unsuppress":
        return f"feature موجود {a['feature_name']} را از حالت suppress خارج کن"
    if fam=="feature_rename":
        return f"نام feature {a['feature_name']} را دقیقاً به {a['new_name']} تغییر بده"
    if fam=="feature_delete":
        return f"feature موجود {a['feature_name']} را از feature tree حذف کن"
    if fam=="part_hide":
        return f"{a['part_name']} را در viewport نامرئی کن"
    if fam=="part_show":
        return f"{a['part_name']} را در viewport دوباره قابل‌دیدن کن"
    if fam=="part_delete":
        return f"خود {a['part_name']} را از مدل حذف کن"
    if fam=="part_color":
        return f"property رنگ ظاهری {a['part_name']} را روی {a['value']} تنظیم کن"
    if fam=="part_material":
        return f"property material مربوط به {a['part_name']} را دقیقاً روی {a['value']} بگذار"
    if fam=="part_description":
        return f"property description مربوط به {a['part_name']} را دقیقاً برابر {a['value']} ثبت کن"
    if fam=="part_rename":
        return f"نام خود part یعنی {a['part_name']} را دقیقاً به {a['value']} تغییر بده"
    if fam=="plane_named":
        return f"یک reference plane تازه بساز و نام آن را دقیقاً {a['name']} بگذار"
    if fam=="plane_plain":
        return "یک reference plane تازه بدون نام سفارشی ایجاد کن"
    if fam=="linear_pattern":
        return f"از {a['part_name']} یک linear pattern با {a['copies']} نسخه و فاصله {a['distance']} بساز"
    if fam=="feature_reorder":
        return f"در feature tree، {a['source_feature']} را {('قبل از' if a['placement']=='before' else 'بعد از')} {a['target_feature']} قرار بده"
    if fam=="rollback":
        if "before_feature" in a:
            return f"rollback bar را بلافاصله قبل از {a['before_feature']} قرار بده"
        return f"rollback bar را بلافاصله بعد از {a['after_feature']} قرار بده"
    if fam=="create_part_studio":
        return f"یک Part Studio تازه با نام دقیق {a['new_name']} ایجاد کن"
    if fam=="rename_document":
        return f"نام document فعلی را دقیقاً به {a['new_name']} تغییر بده"
    if fam=="context_camera_continue":
        lm=c["last_move"]; return f"همان حرکت قبلی camera را با action {lm['action']} و همان جهت {fdir(lm['direction'])} یک بار دیگر ادامه بده"
    if fam=="context_camera_reverse":
        return "جهت آخرین حرکت camera را معکوس کن و یک حرکت دقیقاً مخالف قبلی انجام بده"
    if fam=="context_relative":
        return f"radius مربوط به {a['feature_name']} را طوری تغییر بده که مقدار نهایی دقیقاً {a['amount']} شود"
    if fam=="negation_correction":
        m=i%5
        if m==0: return "Part 8 را hide نکن؛ برعکس visible نگهش دار"
        if m==1: return "zoom in نکن؛ به‌جایش zoom out انجام بده"
        if m==2: return "Top view را فعال نکن؛ در عوض selection فعلی را کامل clear کن"
        if m==3: return "Fillet 7 را حذف نکن؛ هیچ عمل جایگزین دیگری هم درخواست نمی‌کنم"
        return "selection را clear نکن؛ فقط بدون تغییرش بگو چه چیزهایی selected هستند"
    if fam=="multi_action_safe_ask":
        return [
          "هم Part 6 را hide کن و هم نمای استاندارد Top را فعال کن",
          "selection فعلی را clear کن و علاوه بر آن رنگ Part 9 را blue بگذار",
          "Fillet 8 را delete کن و همزمان Extrude 11 را suppress کن",
          "هم zoom out انجام بده و هم viewport را به سمت راست pan کن",
          "selection فعلی را fit کن و همزمان نمای collaborator دیگر را follow کن"
        ][i%5]
    if fam=="conditional_safe_ask":
        return [
          "فقط اگر selection الان خالی است نمای Top را فعال کن",
          "فقط در صورتی Part 7 را show کن که الان hidden باشد",
          "Fillet 9 را تنها وقتی حذف کن که در وضعیت active باشد",
          "فقط اگر حداقل یک entity selected است fit selection انجام بده",
          "Extrude 5 را فقط در صورتی suppress کن که الان active باشد"
        ][i%5]
    if fam=="invalid_quantity_safe_ask":
        lits=s.get("value_provenance",{}).get("preserve_literals",[])
        if i%5 in {0,4}: return f"برای {lits[0]} مقدار radius نامعتبر {lits[1]} را اعمال کن"
        if i%5==1: return f"برای {lits[0]} مقدار angle نامعتبر {lits[1]} را تنظیم کن"
        if i%5==2: return f"برای {lits[0]} مقدار depth نامعتبر {lits[1]} را قرار بده"
        return f"برای {lits[0]} linear pattern با count نامعتبر {lits[1]} و spacing {lits[2]} بساز"
    if fam=="ambiguous_target_safe_ask":
        if i%4==0: return "یکی از Part 4 یا Part 7 را hide کن ولی مشخص نمی‌کنم کدام‌یک"
        if i%4==1: return "یکی از Fillet 4 یا Fillet 6 را delete کن ولی هدف دقیق را مشخص نمی‌کنم"
        if i%4==2: return "همان face را select کن، بدون اینکه شناسه یا اشارهٔ زمینی‌شده‌ای برای face داده باشم"
        return "همان edge را select کن، بدون اینکه شناسه یا اشارهٔ زمینی‌شده‌ای برای edge داده باشم"
    raise KeyError(fam)

def realize(s):
    i=sid_index(s["scenario_id"])
    return PREFIXES[i%len(PREFIXES)] + MIDS[i%len(MIDS)] + core(s) + SUFFIXES[(i*7)%len(SUFFIXES)]

def main():
    p=argparse.ArgumentParser(); p.add_argument("--scenarios",required=True); p.add_argument("--output",required=True); a=p.parse_args()
    rows=read_jsonl(a.scenarios); out=[]
    for s in rows:
        text=realize(s)
        for lit in s.get("value_provenance",{}).get("preserve_literals",[]):
            if str(lit) not in text:
                raise SystemExit(f"literal missing {s['scenario_id']} {lit!r}")
        out.append({"scenario_id":s["scenario_id"],"family":s["family"],"text":text,"context":s.get("context",{})})
    write_jsonl(a.output,out)
    print(json.dumps({"cases":len(out),"generator":"v20c-semantic-compositional-grammar-v1","router_source_read":False,"prior_holdout_text_read":False},ensure_ascii=False))

if __name__=="__main__": main()
