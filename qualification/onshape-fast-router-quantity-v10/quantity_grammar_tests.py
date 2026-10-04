from __future__ import annotations
import json
import math
import evidence_v06 as e

NUMBER_CASES = [
    ("0",0.0),("۱",1.0),("2.5",2.5),("۲.۵",2.5),
    ("یک",1.0),("بیست و پنج",25.0),("صد و بیست و پنج",125.0),
    ("نیم",0.5),("ربع",0.25),("دو و نیم",2.5),
    ("هشت دهم",0.8),("هفتاد و پنج صدم",0.75),
    ("یک و دو دهم",1.2),("دو و دو دهم",2.2),
    ("دو و بیست و پنج صدم",2.25),("یک و بیست صدم",1.2),
    ("یک ممیز دو",1.2),("دو ممیز بیست و پنج",2.25),
    ("صفر ممیز هفتاد و پنج",0.75),
]

EXTRACTION_CASES = [
    ("روی انتخاب فیلت یک و دو دهم میل بزن","mm",1.2),
    ("لبه ها رو هفتاد و پنج صدم میل پخ بزن","mm",0.75),
    ("همین لبه ها رو پخ یک میل و نیم","mm",1.5),
    ("یه fillet خالی دو و دو دهم میل بساز","mm",2.2),
    ("چمفر دو و بیست و پنج صدم میلی بساز","mm",2.25),
    ("شعاعش ۲.۵ mm بشه","mm",2.5),
    ("زاویه رو سی درجه کن","deg",30.0),
    ("زاویه رو ۳۰ deg کن","deg",30.0),
    ("فاصله یک میلی متر","mm",1.0),
    ("پخ دو دهم میل","mm",0.2),
    ("پخ یک میل و دو دهم","mm",1.2),
]

def close(a,b):
    return math.isclose(float(a),float(b),rel_tol=0,abs_tol=1e-9)

def main():
    checks=[]
    for phrase,want in NUMBER_CASES:
        ast=e.parse_spoken_number_ast(phrase)
        got=None if ast is None else ast["value"]
        ok=got is not None and close(got,want)
        checks.append({"kind":"number","phrase":phrase,"want":want,"got":got,"ok":ok,"ast":ast})
    for text,unit,want in EXTRACTION_CASES:
        qs,issues=e.extract_quantity_evidence(text)
        got=[q for q in qs if q["unit"]==unit]
        value=got[0]["value"] if len(got)==1 else None
        ok=len(got)==1 and not issues and close(value,want)
        checks.append({"kind":"extract","text":text,"want":want,"got":value,"issues":issues,"ok":ok,"q":got})

    qs,issues=e.extract_quantity_evidence("فیلت یک و و دو دهم میل بزن")
    checks.append({
        "kind":"fail_closed_partial",
        "text":"فیلت یک و و دو دهم میل بزن",
        "ok":bool(issues) and len(qs)==0,
        "issues":issues,"q":qs,
    })

    failures=[x for x in checks if not x["ok"]]
    result={"checks":len(checks),"passed":len(checks)-len(failures),"failed":len(failures),"failures":failures}
    print(json.dumps(result,ensure_ascii=False,indent=2))
    return 1 if failures else 0

if __name__=="__main__":
    raise SystemExit(main())
