from __future__ import annotations

import json
import os
import re
import statistics
import time
import urllib.error
import urllib.request
from dataclasses import dataclass

MODEL = "openai/gpt-oss-20b"
ENDPOINT = "https://api.groq.com/openai/v1/chat/completions"
BATCH_SIZE = int(os.environ.get("BATCH_SIZE", "10"))
MAX_BATCH_RETRIES = int(os.environ.get("MAX_BATCH_RETRIES", "8"))

PERSIAN_DIGITS = str.maketrans("۰۱۲۳۴۵۶۷۸۹٠١٢٣٤٥٦٧٨٩", "01234567890123456789")
ARABIC_NORMALIZE = str.maketrans({"ي":"ی","ك":"ک"})

INTENTS = {
    "camera_move": "orbit/pan/zoom camera",
    "fit": "fit whole view or current selection",
    "top_view": "show top view",
    "clear_selection": "clear current viewer selection",
    "inspect": "inspect selection/viewer/collaboration state",
    "follow": "follow collaborator",
    "edge_on_selection": "fillet/chamfer current selection",
    "feature_parameter": "edit existing feature parameter",
    "feature_suppressed": "suppress/unsuppress existing feature",
    "feature_rename": "rename existing feature",
    "feature_delete": "delete existing feature",
    "part_delete": "delete existing part",
    "part_visibility": "hide/show part",
    "part_property": "set part name/color/material/description",
    "add_plane": "create plane",
    "add_pattern": "create linear pattern",
    "add_edge_feature": "create new empty fillet/chamfer",
    "feature_reorder": "move feature before/after another feature",
    "rollback": "move rollback bar",
    "create_part_studio": "create Part Studio",
    "rename_document": "rename document",
}

MATERIAL_INTENTS = {
    "edge_on_selection","feature_parameter","feature_suppressed","feature_rename",
    "feature_delete","part_delete","part_visibility","part_property","add_plane",
    "add_pattern","add_edge_feature","feature_reorder","rollback",
    "create_part_studio","rename_document",
}

WORD_NUM = {
    "صفر":0,"یک":1,"یه":1,"يه":1,"دو":2,"سه":3,"چهار":4,"پنج":5,"شش":6,
    "هفت":7,"هشت":8,"نه":9,"ده":10,"یازده":11,"دوازده":12,"سیزده":13,
    "چهارده":14,"پانزده":15,"شانزده":16,"هفده":17,"هجده":18,"نوزده":19,
}
TENS = {"بیست":20,"سی":30,"چهل":40,"پنجاه":50,"شصت":60,"هفتاد":70,"هشتاد":80,"نود":90}
HUNDREDS = {
    "صد":100,"یکصد":100,"دویست":200,"سیصد":300,"چهارصد":400,
    "پانصد":500,"ششصد":600,"هفتصد":700,"هشتصد":800,"نهصد":900,
}
FRACTION_DENOMS = {"دهم":10,"صدم":100,"هزارم":1000}

def norm_text(text):
    t = text.translate(PERSIAN_DIGITS).translate(ARABIC_NORMALIZE).replace("\u200c"," ").replace("٫",".")
    t = re.sub(r"\s+"," ",t).strip()
    return t

def low(text):
    return norm_text(text).lower()

def has_any(t, xs):
    return any(x in t for x in xs)

_LEADING_ENVELOPE_RE=re.compile(
    r"^(?:(?:لطفاً|لطفا|بی\s*زحمت|بی‌زحمت|اگه میشه|اگر میشه|میشه لطف کنی|می شه لطف کنی|میشه|الان|یه لحظه|برای من|فقط|"
    r"خب|باشه|ممنون می شم|ممنون می‌شم|زحمت میشه|وقتی آماده ای|وقتی آماده‌ای|"
    r"سریع|آروم|دقیقاً|دقیقا|فعلاً|فعلا|اول از همه|اگه امکانش هست|می‌خوام|می خوام|"
    r"یه زحمت|لطف می‌کنی|لطف می کنی|می‌تونی|می تونی|واسه من|میشه لطف کنی|می شه لطف کنی|"
    r"اگه اوکیه|اگر اوکیه|اگه زحمتی نیست|اگر زحمتی نیست|اگه می‌تونی|اگه می تونی|اگر می‌تونی|اگر می تونی|"
    r"یه کار کن|فقط اینو انجام بده|حالا|لطفاً یه لحظه|لطفا یه لحظه|یه لطفی کن|خب پس|ببین|"
    r"راستی|یه کار دیگه|این یکی رو|ممکنه|زحمتش رو بکش و|خب این بار)[،,:]?\s+)+",
    re.I,
)
_TRAILING_ENVELOPE_RE=re.compile(
    r"(?:[،,؛;]\s*)?(?:لطفاً|لطفا|بی\s*زحمت|بی‌زحمت|اگه میشه|اگر میشه|مرسی|ممنون|"
    r"همین الان|برای من|فعلاً|فعلا|یه لحظه|و تموم|بعدش تموم|ممنون ازت|مرسی ازت|اگه اوکیه|"
    r"اگر اوکیه|اگر امکانش هست|اگه زحمتی نیست|اگر زحمتی نیست|وقتی فرصت داری|"
    r"لطف می‌کنی|لطف می کنی|لطفاً انجامش بده|خواهشاً|لطف داری|ممنونت می‌شم|ممنونت می شم|ممنون می‌شم|ممنون می شم|"
    r"همینو می‌خوام|همینو می خوام|همین|اگه می‌تونی|اگه می تونی|اگر می‌تونی|اگر می تونی|"
    r"دیگه کاری ندارم|همین کافیه|لطف کردی|تموم|همین خوبه|فقط همین|اوکی|دیگه بسه|انجامش بده لطفاً|انجامش بده لطفا)\s*$",
    re.I,
)

def utterance_core(text):
    """Remove conversational envelope while preserving the semantic command."""
    s=norm_text(text).strip().strip("«»\"'“”")
    prev=None
    while s!=prev:
        prev=s
        s=_LEADING_ENVELOPE_RE.sub("",s).strip()
        s=re.sub(r"[؟?!]+\s*$","",s).strip()
        s=re.sub(r"[،,؛;]\s*باشه\s*$","",s,flags=re.I).strip()
        s=_TRAILING_ENVELOPE_RE.sub("",s).strip()
        s=re.sub(r"[؟?!]+\s*$","",s).strip()
    return s

def mask_spans(text, spans):
    out=text
    for start,end in sorted(spans,reverse=True):
        if 0 <= start <= end <= len(out):
            out=out[:start]+(" "*(end-start))+out[end:]
    return out

def _negated_action_clause(seg):
    q=low(seg).strip()
    return (
        has_any(q,["نکن","نزن","نساز","نده","نذار","نگذار","نبر","نچرخون","نچرخان","نکش","نیار","نیاور"]) or
        bool(re.search(r"(?:^|\s)نه\s*$",q))
    )

def mask_negated_action_clauses(text):
    """Mask cancelled action scope while preserving later corrections and external targets."""
    chars=list(text)
    masked=0
    neg_re=re.compile(r"(?:نکن|نزن|نساز|نده|نذار|نگذار|نبر|نچرخون|نچرخان|نکش|نیار|نیاور)")
    for m in re.finditer(r"[^،,؛;]+",text):
        seg=m.group(0)
        nm=neg_re.search(seg)
        if nm:
            after=seg[nm.end():]
            end=m.start()+nm.end() if _ACTION_MARKER_RE.search(after) else m.end()
            for i in range(m.start(),end):
                chars[i]=" "
            masked+=1
            continue
        no=re.search(r"(?:^|\s)نه(?:\s|$)",seg)
        if no and _ACTION_MARKER_RE.search(seg[:no.start()]) and _ACTION_MARKER_RE.search(seg[no.end():]):
            for i in range(m.start(),m.start()+no.end()):
                chars[i]=" "
            masked+=1
        elif no and not seg[no.end():].strip():
            for i in range(m.start(),m.end()):
                chars[i]=" "
            masked+=1
    return "".join(chars),masked

_ACTION_MARKER_RE=re.compile(
    r"(?:\b(?:show|hide|fit|zoom|pan|follow|clear|inspect|rename|suppress|unsuppress|"
    r"create|delete|set|rotate|move)\b|کن|بده|بساز|بزن|بذار|بگذار|حذف|پاک|مخفی|نشون|نشان|"
    r"ببر|بکش|بچرخ|برگردون|ول کن|بگو|گزارش|بگیر|بیار|فیت|زوم|فالو|rollback)",
    re.I,
)

def count_effect_clauses(text):
    """Count independent imperative clauses after literals/quantities/negations are masked."""
    parts=re.split(r"(?:[؛;]|\s+و\s+بعد\s+|\s+بعدش\s+|\s+سپس\s+|\s+then\s+|\s+و\s+)",text,flags=re.I)
    return sum(1 for p in parts if _ACTION_MARKER_RE.search(p or ""))

def has_conditional_or_exception(text):
    t=low(text)
    # "اگه/اگر میشه" and "اگه/اگر امکانش هست" are politeness envelopes,
    # even when inserted mid-clause; they are not semantic conditions.
    semantic_t=re.sub(
        r"(?:^|\s)(?:اگر|اگه)\s+(?:میشه|می شه|امکانش هست|اوکیه|زحمتی نیست|می‌تونی|می تونی|می‌توانی|می توانی)(?=\s|$)",
        " ",
        t,
        flags=re.I,
    )
    return (
        bool(re.search(r"(?:^|\s)(?:اگر|اگه|مگر|وقتی|if|unless|when)(?:\s|$)",semantic_t,re.I)) or
        has_any(semantic_t,["به جز","به‌جز","مگر اینکه","در صورتی که","به شرط"])
    )

_DEPENDENT_EFFECT_RE=re.compile(
    r"(?:\b(?:show|hide|fit|zoom|pan|follow|clear|inspect|suppress|unsuppress|delete)\b|"
    r"حذف|پاک|مخفی|نشون|نشان|فیت|زوم|فالو|بگو|گزارش)",
    re.I,
)

def has_dependent_sequence(text):
    t=low(text)
    if not has_any(t,["قبل از","بعد از","before","after"]):
        return False
    # rollback/reorder use before/after as a target relation inside one operation.
    if "rollback" in t:
        return False
    return len(_DEPENDENT_EFFECT_RE.findall(t)) >= 2

def parse_int_words(s):
    """Parse one canonical Persian cardinal phrase. Return None on non-cardinal composition.

    Crucially, "هفتاد و پنج" is a valid cardinal (75), while "یک و دو" is not a
    canonical way to say 3 and therefore remains available for decimal grammar (1.2).
    """
    s=norm_text(s).strip(" ،,")
    if re.fullmatch(r"[+]?\d+",s):
        return int(s)
    if s in WORD_NUM:
        return WORD_NUM[s]
    if s in TENS:
        return TENS[s]
    if s in HUNDREDS:
        return HUNDREDS[s]

    m=re.fullmatch(r"(.+?) هزار(?: و (.+))?",s)
    if m:
        left=m.group(1).strip()
        base=1 if left=="" else parse_int_words(left)
        tail=parse_int_words(m.group(2)) if m.group(2) else 0
        if base is not None and 0 < base < 1000 and tail is not None and 0 <= tail < 1000:
            return base*1000+tail
        return None

    parts=[x.strip() for x in s.split(" و ") if x.strip()]
    if len(parts)==2:
        a,b=parts
        if a in TENS and b in WORD_NUM and 0 < WORD_NUM[b] < 10:
            return TENS[a]+WORD_NUM[b]
        if a in HUNDREDS:
            tail=parse_int_words(b)
            if tail is not None and 0 <= tail < 100:
                return HUNDREDS[a]+tail
    if len(parts)>=2 and parts[0] in HUNDREDS:
        tail=parse_int_words(" و ".join(parts[1:]))
        if tail is not None and 0 <= tail < 100:
            return HUNDREDS[parts[0]]+tail
    return None

def _decimal_tail_value(s):
    s=norm_text(s).strip()
    if re.fullmatch(r"\d+",s):
        return int(s)/(10**len(s)), {"digits":s}
    toks=s.split()
    if toks and all(tok in WORD_NUM and 0 <= WORD_NUM[tok] <= 9 for tok in toks):
        digits="".join(str(WORD_NUM[tok]) for tok in toks)
        return int(digits)/(10**len(digits)), {"digits":digits}
    n=parse_int_words(s)
    if n is not None and 0 <= n < 1000:
        digits=str(n)
        return n/(10**len(digits)), {"spoken_cardinal":n,"digits":digits}
    return None,None

def _fraction_only_ast(s):
    s=norm_text(s).strip(" ،,")
    if s=="نیم":
        return {"value":0.5,"kind":"half","source":s}
    if s=="ربع":
        return {"value":0.25,"kind":"quarter","source":s}
    for word,denom in FRACTION_DENOMS.items():
        suffix=" "+word
        if s.endswith(suffix):
            numerator_phrase=s[:-len(suffix)].strip()
            numerator=parse_int_words(numerator_phrase)
            if numerator is not None and 0 <= numerator < denom:
                return {
                    "value":numerator/denom,
                    "kind":"fraction",
                    "source":s,
                    "numerator":numerator,
                    "denominator":denom,
                }
    return None

def parse_spoken_number_ast(s):
    s=norm_text(s).strip(" ،,")
    if not s:
        return None
    if re.fullmatch(r"[+-]?\d+(?:[.,]\d+)?",s):
        return {"value":float(s.replace(",",".")),"kind":"numeric_literal","source":s}
    if s=="نیم":
        return {"value":0.5,"kind":"half","source":s}
    if s=="ربع":
        return {"value":0.25,"kind":"quarter","source":s}

    m=re.fullmatch(r"(.+?) ممیز (.+)",s)
    if m:
        whole=parse_int_words(m.group(1))
        frac,meta=_decimal_tail_value(m.group(2))
        if whole is not None and frac is not None:
            return {
                "value":whole+frac,
                "kind":"spoken_decimal",
                "source":s,
                "whole":whole,
                "fraction":meta,
            }

    m=re.fullmatch(r"(.+?) و نیم",s)
    if m:
        whole=parse_int_words(m.group(1))
        if whole is not None:
            return {"value":whole+0.5,"kind":"whole_plus_half","source":s,"whole":whole}

    # Denominator binds to a canonical cardinal numerator first:
    # "هفتاد و پنج صدم" => 75/100, not 70 + 5/100.
    for word,denom in FRACTION_DENOMS.items():
        suffix=" "+word
        if not s.endswith(suffix):
            continue
        pre=s[:-len(suffix)].strip()
        numerator=parse_int_words(pre)
        if numerator is not None:
            return {
                "value":numerator/denom,
                "kind":"fraction",
                "source":s,
                "numerator":numerator,
                "denominator":denom,
            }

        # If the entire pre-denominator phrase is not a canonical cardinal, allow
        # an explicit whole + fractional numerator composition:
        # "یک و دو دهم" => 1 + 2/10
        # "دو و بیست و پنج صدم" => 2 + 25/100
        candidates=[]
        joins=[m.start() for m in re.finditer(r" و ",pre)]
        for pos in joins:
            left=pre[:pos].strip()
            right=pre[pos+3:].strip()
            whole=parse_int_words(left)
            frac_num=parse_int_words(right)
            if whole is not None and frac_num is not None and 0 <= frac_num < denom:
                candidates.append((whole,frac_num))
        values={(whole+frac_num/denom) for whole,frac_num in candidates}
        if len(values)==1 and candidates:
            whole,frac_num=candidates[0]
            return {
                "value":whole+frac_num/denom,
                "kind":"whole_plus_fraction",
                "source":s,
                "whole":whole,
                "numerator":frac_num,
                "denominator":denom,
            }
        return None

    cardinal=parse_int_words(s)
    if cardinal is not None:
        return {"value":float(cardinal),"kind":"cardinal","source":s,"cardinal":cardinal}
    return None

def parse_spoken_number(s):
    ast=parse_spoken_number_ast(s)
    return ast["value"] if ast else None

NUMBER_PHRASE = r"(?:[+-]?\d+(?:[.,]\d+)?|نیم|ربع|(?:یک|یه|دو|سه|چهار|پنج|شش|هفت|هشت|نه|ده|یازده|دوازده|سیزده|چهارده|پانزده|شانزده|هفده|هجده|نوزده|بیست|سی|چهل|پنجاه|شصت|هفتاد|هشتاد|نود)(?: و (?:نیم|(?:یک|یه|دو|سه|چهار|پنج|شش|هفت|هشت|نه|ده|یازده|دوازده|سیزده|چهارده|پانزده|شانزده|هفده|هجده|نوزده|بیست|سی|چهل|پنجاه|شصت|هفتاد|هشتاد|نود)(?: دهم| صدم)?))?)"

def _longest_spoken_number_before(t, unit_start):
    prefix=t[:unit_start].rstrip()
    toks=list(re.finditer(r"\S+",prefix))
    for k in range(min(10,len(toks)),0,-1):
        start=toks[-k].start()
        cand=prefix[start:].strip(" ،,")
        ast=parse_spoken_number_ast(cand)
        if ast is not None:
            return start,cand,ast
    return None

def _post_unit_fraction(t, unit_end):
    tail=t[unit_end:]
    m=re.match(r"\s*و\s+(.+)$",tail)
    if not m:
        return None
    rest=m.group(1)
    rest_abs_start=unit_end+m.start(1)
    toks=list(re.finditer(r"\S+",rest))
    for k in range(min(5,len(toks)),0,-1):
        cand=rest[:toks[k-1].end()].strip(" ،,")
        ast=_fraction_only_ast(cand)
        if ast is not None:
            return rest_abs_start, rest_abs_start+toks[k-1].end(), cand, ast
    return None

def _looks_numeric_tail(s):
    s=norm_text(s).strip()
    if not s:
        return False
    token=s.split()[-1]
    return (
        token in WORD_NUM or token in TENS or token in HUNDREDS or
        token in FRACTION_DENOMS or token in {"نیم","ربع","ممیز","و"} or
        bool(re.fullmatch(r"\d+(?:[.,]\d+)?",token))
    )

def extract_quantity_evidence(text):
    t=low(text)
    out=[]
    issues=[]
    seen=set()
    unit_pat=re.compile(r"(?:میلی\s*متر|میلیمتر|میلی|میل(?:ش)?|mm|درجه|degrees?|deg)\b",re.I)
    for um in unit_pat.finditer(t):
        parsed=_longest_spoken_number_before(t,um.start())
        if not parsed:
            # Numeric-looking language immediately before a unit that cannot be
            # fully parsed is an ambiguity, never permission to guess.
            prefix=t[:um.start()].rstrip()
            if _looks_numeric_tail(prefix):
                issues.append({"kind":"unparsed_quantity_before_unit","unit_span":[um.start(),um.end()]})
            continue
        start,cand,ast=parsed

        # A partial numeric suffix must not be accepted. Example: if only
        # "دو دهم" parsed from an intended "یک و دو دهم", the preceding
        # conjunction exposes the partial match and forces fail-closed behavior.
        prefix_before=t[:start].rstrip()
        if prefix_before.endswith("منفی"):
            issues.append({
                "kind":"negative_spoken_quantity",
                "text":cand,
                "span":[start,um.end()],
            })
            continue
        if prefix_before.endswith(" و") or prefix_before.endswith(" ممیز"):
            issues.append({
                "kind":"partial_numeric_match",
                "text":cand,
                "span":[start,um.end()],
            })
            continue

        raw_unit=um.group(0).lower().replace(" ","")
        if raw_unit=="میلش":
            raw_unit="میل"
        unit="deg" if raw_unit in {"درجه","deg","degree","degrees"} else "mm"
        end=um.end()
        combined_ast=ast

        post=_post_unit_fraction(t,um.end())
        if post is not None:
            _,post_end,post_text,post_ast=post
            combined_ast={
                "value":ast["value"]+post_ast["value"],
                "kind":"unit_then_fraction",
                "source":t[start:post_end],
                "base":ast,
                "post_fraction":post_ast,
            }
            end=post_end

        key=(start,end,unit)
        if key in seen:
            continue
        seen.add(key)
        out.append({
            "id":f"q{len(out)+1}",
            "value":combined_ast["value"],
            "unit":unit,
            "text":t[start:end],
            "span":[start,end],
            "ast":combined_ast,
            "provenance":"canonical_quantity_grammar",
        })

    # "ربع دور" is a camera magnitude = 90 degrees.
    for m in re.finditer(r"\bربع\s+دور\b",t):
        key=(m.start(),m.end(),"deg")
        if key not in seen:
            out.append({
                "id":f"q{len(out)+1}",
                "value":90.0,
                "unit":"deg",
                "text":m.group(0),
                "span":[m.start(),m.end()],
                "ast":{"value":90.0,"kind":"quarter_turn","source":m.group(0)},
                "provenance":"camera_quarter_turn",
            })

    out.sort(key=lambda x:x["span"][0])
    for i,q in enumerate(out,1):
        q["id"]=f"q{i}"
    return out,issues

def extract_quantities(text):
    out,_=extract_quantity_evidence(text)
    return out

def quantity_string(q):
    if q is None: return None
    v=q["value"]; unit=q["unit"]
    if float(v).is_integer(): s=str(int(v))
    else: s=(f"{v:.6f}").rstrip("0").rstrip(".")
    return f"{s} {unit}"

def extract_named_features(text):
    t=norm_text(text)
    out=[]
    for m in re.finditer(r"\b(Fillet|Extrude|Draft|Sketch)\s*(\d+)\b",t,re.I):
        out.append({"id":f"f{len(out)+1}","name":m.group(1).title()+" "+m.group(2),"span":[m.start(),m.end()]})
    for m in re.finditer(r"(فیلت|فیلِت|اکسترود)\s*("+NUMBER_PHRASE+r")",t,re.I):
        suffix=t[m.end():].lstrip()
        if re.match(r"(?:میلی(?:متر)?|میل|mm)\b",suffix,re.I):
            continue
        n=parse_spoken_number(m.group(2))
        if n is not None and float(n).is_integer():
            name=("Fillet" if m.group(1) in {"فیلت","فیلِت"} else "Extrude")+" "+str(int(n))
            if name not in [x["name"] for x in out]:
                out.append({"id":f"f{len(out)+1}","name":name,"span":[m.start(),m.end()]})
    out.sort(key=lambda x:x["span"][0])
    for i,x in enumerate(out,1): x["id"]=f"f{i}"
    return out

def extract_parts(text):
    t=norm_text(text)
    out=[]
    for m in re.finditer(r"\bPart\s*("+NUMBER_PHRASE+r")\b",t,re.I):
        n=parse_spoken_number(m.group(1))
        if n is not None and float(n).is_integer():
            out.append({"id":f"p{len(out)+1}","name":"Part "+str(int(n)),"span":[m.start(),m.end()]})
    for m in re.finditer(r"پارت\s*("+NUMBER_PHRASE+r")\b",t,re.I):
        n=parse_spoken_number(m.group(1))
        if n is not None and float(n).is_integer():
            name="Part "+str(int(n))
            if name not in [x["name"] for x in out]:
                out.append({"id":f"p{len(out)+1}","name":name,"span":[m.start(),m.end()]})
    for name in ("Cap","Bracket"):
        m=re.search(rf"\b{re.escape(name)}\b",t,re.I)
        if m and name not in [x["name"] for x in out]:
            out.append({"id":f"p{len(out)+1}","name":name,"span":[m.start(),m.end()]})
    out.sort(key=lambda x:x["span"][0])
    for i,x in enumerate(out,1): x["id"]=f"p{i}"
    return out

def _strip_literal_tail(value):
    """Remove imperative/copular tails from typed payloads without touching payload-internal keywords."""
    v=norm_text(str(value)).strip(" ،,.;؛؟?!")
    tails=[
        r"\s+(?:بساز|ایجاد\s+کن|اضافه\s+کن|ثبت\s+کن|تنظیم\s+کن|قرار\s+بده|بگذار|بذار|نام\s*گذاری\s+کن|نام‌گذاری\s+کن|صدا\s+کن|تغییر\s+بده)$",
        r"\s+(?:باشد|بشه|بشود|شود)$",
    ]
    prev=None
    while v!=prev:
        prev=v
        for pat in tails:
            v=re.sub(pat,"",v,flags=re.I).strip(" ،,.;؛؟?!")
    return v

def extract_literal_payloads(text):
    """Extract typed effect-bearing payloads with precise, non-overlapping spans."""
    s=utterance_core(text)
    t=low(s)
    out=[]

    def claimed(start,end):
        return any(start < x["span"][1] and end > x["span"][0] for x in out)

    def add(field,value,span,provenance,scope=None):
        value=_strip_literal_tail(value)
        if not value:
            return
        if claimed(span[0],span[1]):
            return
        out.append({
            "id":f"lit{len(out)+1}",
            "kind":"literal_payload",
            "field":field,
            "value":value,
            "span":[span[0],span[1]],
            "scope":scope,
            "effect_bearing":True,
            "provenance":provenance,
        })

    # Opaque free-text fields are claimed first so keywords inside them never
    # become secondary semantic payloads.
    name_patterns=[
        r"(?:اسم\s+تازه(?:ٔ|ی)?\s+(?:Fillet|Extrude|Draft|Sketch)\s+\d+\s+رو\s+(?:بذار|بگذار))\s+(.+)$",
        r"(?:Fillet|Extrude|Draft|Sketch)\s+\d+\s+از\s+حالا\s+با\s+عنوان\s+(.+?)\s+(?:باشه|باشد|بشه|بشود)$",
        r"برای\s+feature\s+(?:Fillet|Extrude|Draft|Sketch)\s+\d+\s+نام\s+(.+?)\s+ثبت\s+کن$",
        r"(?:Part\s+Studio).*?اضافه\s+کن\s+با\s+عنوان\s+(.+)$",
        r"workspace\s+جدید\s+از\s+نوع\s+Part\s+Studio\s+بساز[؛;,]?\s*اسمش\s+(.+)$",
        r"(?:یک\s+)?تب\s+Part\s+Studio\s+به\s+نام\s+(.+?)\s+ایجاد\s+کن$",
        r"Part\s+Studio\s+تازه(?:‌|\s)*ای\s+بساز\s+و\s+name\s+آن\s+(.+?)\s+(?:باشه|باشد|بشه|بشود)$",
        r"اسم\s+فایل\s+فعلی\s+رو\s+(.+?)\s+کن$",
        r"title\s+این\s+document\s+رو\s+(?:بذار|بگذار)\s+(.+)$",
        r"سند\s+فعلی\s+از\s+حالا\s+(.+?)\s+نام\s+داشته\s+(?:باشه|باشد|بشه|بشود)$",
        r"rename\s+current\s+document\s+to\s+(.+)$",
        r"(?:یک\s+)?plane\s+تازه\s+با\s+اسم\s+(.+?)\s+اضافه\s+کن$",
        r"صفحه\s+مرجع\s+جدید\s+رو\s+(.+?)\s+نام[‌ ]?گذاری\s+کن$",
        r"reference\s+plane\s+بساز\s+با\s+title\s+(.+)$",
        r"plane\s+feature\s+تازه(?:‌|\s)*ای\s+به\s+نام\s+(.+?)\s+ایجاد\s+کن$",
        r"اسم\s+(?:Part\s+\d+|پارت\s+\S+)\s+رو\s+(?:بذار|بگذار)\s+(.+)$",
        r"(?:Part\s+\d+|پارت\s+\S+)\s+از\s+حالا\s+عنوانش\s+(.+?)\s+(?:باشه|باشد|بشه|بشود)$",
        r"rename\s+part\s+(?:Part\s+\d+|پارت\s+\S+)\s+to\s+(.+)$",
        r"برای\s+قطعه\s+(?:Part\s+\d+|پارت\s+\S+)\s+نام\s+(.+?)\s+ثبت\s+کن$",
        r"(?:Fillet|Extrude|Draft|Sketch)\s+\d+\s+را\s+از\s+این\s+به\s+بعد\s+(.+?)\s+صدا\s+کن$",
        r"عنوان\s+feature\s+(?:Fillet|Extrude|Draft|Sketch)\s+\d+\s+را\s+(?:بگذار|بذار)\s+(.+)$",
        r"برای\s+(?:Fillet|Extrude|Draft|Sketch)\s+\d+\s+نام\s+تازه\s+(.+?)\s+ثبت\s+کن$",
        r"اسم\s+(?:Fillet|Extrude|Draft|Sketch)\s+\d+\s+را\s+تبدیل\s+کن\s+به\s+(.+)$",
        r"(?:تب|محیط)\s+Part\s+Studio.*?(?:با\s+نام|به\s+اسم)\s+(.+?)(?:\s+(?:بساز|ایجاد\s+کن|اضافه\s+کن))?$",
        r"Part\s+Studio\s+جدیدی\s+ایجاد\s+کن\s+و\s+عنوانش\s+(.+?)\s+(?:باشد|بشه|بشود)$",
        r"workspace\s+نوع\s+Part\s+Studio\s+با\s+نام\s+(.+?)\s+ایجاد\s+کن$",
        r"عنوان\s+سند\s+را\s+به\s+(.+?)\s+تغییر\s+بده$",
        r"document\s+فعلی\s+را\s+(.+?)\s+نام[‌ ]?گذاری\s+کن$",
        r"اسم\s+این\s+سند\s+از\s+این\s+به\s+بعد\s+(.+?)\s+(?:باشد|بشه|بشود)$",
        r"نام\s+document\s+را\s+(?:بگذار|بذار)\s+(.+)$",
        r"(?:صفحه\s+مرجع|reference\s+plane|plane\s+مرجع|plane).*?(?:با\s+عنوان|به\s+نام|نامش\s+را|اسم\s+آن)\s+(.+?)(?:\s+(?:بساز|ایجاد\s+کن|ثبت\s+کن|باشد|بشه|بشود))?$",
        r"قطعه\s+(?:Part\s+\d+|پارت\s+\S+)\s+را\s+(.+?)\s+نام[‌ ]?گذاری\s+کن$",
        r"عنوان\s+(?:Part\s+\d+|پارت\s+\S+)\s+را\s+(?:بگذار|بذار)\s+(.+)$",
        r"برای\s+(?:Part\s+\d+|پارت\s+\S+)\s+اسم\s+تازه\s+(.+?)\s+ثبت\s+کن$",
        r"نام\s+(?:Part\s+\d+|پارت\s+\S+)\s+از\s+این\s+به\s+بعد\s+(.+?)\s+(?:باشد|بشه|بشود)$",
        r"برای\s+(?:Fillet|Extrude|Draft|Sketch)\s+\d+\s+(?:اسم|نام)(?:\s+جدید)?\s+(?:بذار|بگذار)\s+(.+)$",
        r"(?:اسم|نام)\s+feature\s+(?:Fillet|Extrude|Draft|Sketch)\s+\d+\s+(?:بشه|بشود)\s+(.+)$",
        r"\brename\s+(?:روی\s+)?(?:Fillet|Extrude|Draft|Sketch)\s+\d+\s*:\s*(.+)$",
        r"\b(?:Fillet|Extrude|Draft|Sketch)\s+\d+\s+name\s*=\s*(.+)$",
        r"\bcreate\s+(?:a\s+)?new\s+Part\s+Studio\s+named\s+(.+)$",
        r"پارت\s+استودیو\s+جدید\s+ایجاد\s+کن[،,]?\s*(?:اسم|نام)\s+(.+)$",
        r"\bnew\s+Part\s+Studio\s+name\s*=\s*(.+)$",
        r"(?:Part\s+Studio|پارت\s+استودیو).*?(?:با\s+(?:اسم|نام)|named|name\s*=)\s*(.+)$",
        r"\bdocument\s+title\s+(?:بشه|بشود|=)\s*(.+)$",
        r"(?:نام|اسم)\s+داکیومنت\s+رو\s+(.+?)\s+قرار\s+بده$",
        r"(?:plane|صفحه\s+مرجع).*?(?:اسمش\s+رو\s+بذار|با\s+نام|called|name\s*=)\s*(.+?)(?:\s+(?:ایجاد\s+کن|بساز))?$",
        r"(?:به|با)\s+(?:اسم|نام)\s+(.+?)\s+(?:یه\s+)?(?:plane|صفحه مرجع)\s+(?:جدید\s+)?(?:بساز|ایجاد کن)$",
        r"(?:به|با)\s+(?:اسم|نام)\s+(.+?)(?:\s+بساز)?$",
        r"(?:(?:اسم|نام)(?:ش)?\s+(?:بشه|بشود))\s+(.+?)(?:\s+بساز)?$",
        r"(?:(?:اسم|نام)\s+.+?\s+(?:بشه|بشود))\s+(.+?)(?:\s+بساز)?$",
        r"(?:اسم|نام)ش\s+(?!رو\b|را\b)(.+?)(?:\s+بساز)?$",
        r"\bcalled\s+(.+?)(?:\s+بساز)?$",
        r"(?:(?:اسم|نام)\s+.+?\s+رو\s+بذار)\s+(.+?)(?:\s+بساز)?$",
        r"(?:عوض کن به)\s+(.+)$",
        r"\brename\s+document\s+to\s+(.+)$",
        r"\brename\s+کن\s+به\s+(.+)$",
        r"\bdocument\s+name\s*=\s*(.+)$",
        r"\b(?:Part\s+\d+|پارت\s+\S+)\s+name\s*=\s*(.+)$",
        r"\bnew\s+part\s+studio\s*:\s*(.+)$",
        r"\brename\s+.+?\s+to\s+(.+)$",
        r"(?:داکیومنت(?:و| رو)?\s+rename\s+کن\s+به)\s+(.+)$",
        r"(?:نام|اسم)\s+داکیومنت\s+رو\s+بذار\s+(.+)$",
    ]
    for pat in name_patterns:
        m=re.search(pat,s,re.I)
        if m:
            scope="document" if re.search(r"(?:document|داکیومنت)",s,re.I) else None
            add("name",m.group(1),(m.start(1),m.end(1)),"typed_literal_name",scope)
            break

    for pat in [
        r"توضیحات\s+(?:Part\s+\d+|پارت\s+\S+)\s+رو\s+(?:بذار|بگذار)\s+(.+)$",
        r"description\s+(?:Part\s+\d+|پارت\s+\S+)\s+(?:بشه|بشود|باشه|باشد)\s+(.+)$",
        r"روی\s+(?:Part\s+\d+|پارت\s+\S+)\s+یادداشت\s+(.+?)\s+ثبت\s+کن$",
        r"متن\s+توضیح\s+قطعه\s+(?:Part\s+\d+|پارت\s+\S+)\s*:\s*(.+)$",
        r"یادداشت\s+(?:Part\s+\d+|پارت\s+\S+)\s+را\s+(?:بگذار|بذار)\s+(.+)$",
        r"متن\s+description\s+برای\s+(?:Part\s+\d+|پارت\s+\S+)\s+این\s+(?:باشد|بشه|بشود)\s*:?\s*(.+)$",
        r"برای\s+(?:Part\s+\d+|پارت\s+\S+)\s+توضیح\s+(.+?)\s+ثبت\s+کن$",
        r"description\s+قطعه\s+(?:Part\s+\d+|پارت\s+\S+)\s+را\s+به\s+(.+?)\s+تغییر\s+بده$",
        r"برای\s+(?:Part\s+\d+|پارت\s+\S+)\s+متن\s+توضیح\s+رو\s+(.+?)\s+قرار\s+بده$",
        r"\bdescription\b.*?(?:بذار|بگذار|=|to)\s+(.+)$",
        r"(?:توضیحات|توضیح).*?(?:بذار|بگذار|=|to|بشه|بشود)\s+(.+)$",
    ]:
        m=re.search(pat,s,re.I)
        if m and not claimed(m.start(1),m.end(1)):
            add("description",m.group(1),(m.start(1),m.end(1)),"typed_literal_description")
            break

    # Once an opaque name/description is claimed, payload keywords inside it are
    # invisible to later payload extractors. Scan only the still-unclaimed text.
    payload_scan_s=mask_spans(s,[x["span"] for x in out])
    payload_scan_t=low(payload_scan_s)

    aliases={"فولاد":"Steel","آلومینیوم":"Aluminum","الومینیوم":"Aluminum"}
    if has_any(payload_scan_t,["متریال","material","جنس"]):
        found=False
        for k,v in aliases.items():
            for m in re.finditer(re.escape(k),payload_scan_s,re.I):
                if not claimed(m.start(),m.end()):
                    add("material",v,(m.start(),m.end()),"typed_literal_material")
                    found=True
                    break
            if found:
                break
        if not found:
            patterns=[
                r"متریال\s+(?:Part\s+\d+|پارت\s+\S+)\s+رو\s+روی\s+(.+?)\s+تنظیم\s+کن$",
                r"(?:Part\s+\d+|پارت\s+\S+)\s+جنسش\s+(.+?)\s+(?:باشه|باشد|بشه|بشود)$",
                r"material\s+property\s+برای\s+(?:Part\s+\d+|پارت\s+\S+)\s*=\s*(.+)$",
                r"برای\s+قطعه\s+(?:Part\s+\d+|پارت\s+\S+)\s+جنس\s+(.+?)\s+ثبت\s+کن$",
                r"جنس\s+(?:Part\s+\d+|پارت\s+\S+)\s+را\s+(.+?)\s+ثبت\s+کن$",
                r"material\s+قطعه\s+(?:Part\s+\d+|پارت\s+\S+)\s+برابر\s+(.+?)\s+(?:باشد|بشه|بشود)$",
                r"(?:Part\s+\d+|پارت\s+\S+)\s+از\s+جنس\s+(.+?)\s+تنظیم\s+(?:شود|بشه|بشود)$",
                # Target-bearing forms must precede generic material/value grammar,
                # otherwise the target itself can be swallowed into the literal.
                r"\bmaterial\s+(?:Part\s+\d+|پارت\s+\S+)\s*(?:رو|را)?\s+(.+?)\s+(?:قرار\s+بده|بذار|بگذار|کن)$",
                r"برای\s+(?:Part\s+\d+|پارت\s+\S+)\s+(?:material|متریال(?:ش)?)\s*(?:رو|را)?\s+(.+?)\s+(?:قرار\s+بده|بذار|بگذار|کن)$",
                r"(?:Part\s+\d+|پارت\s+\S+)\s+(?:material|متریال)\s*(?:رو|را|=|بشه|بشود)?\s+(.+?)(?:\s+(?:قرار\s+بده|بذار|بگذار|کن))?$",
                r"جنس\s+(?:Part\s+\d+|پارت\s+\S+)\s+رو\s+(.+?)\s+(?:قرار\s+بده|بذار|بگذار)$",
                r"(?:material|متریال(?:ش)?)\s*(?:رو|را)?\s+(.+?)\s+(?:قرار\s+بده|بذار|بگذار|کن)$",
                r"(?:متریال|material).*?(?:رو|را|=|to|بشه|بشود)\s+(.+?)(?:\s+(?:بذار|بگذار|کن))?$",
                r"(?:متریالش رو)\s+(.+?)\s+کن$",
                r"^(.+?)\s+(?:بذار|بگذار)\s+(?:متریال|material)\b",
                r"(?:Part\s+\d+|پارت\s+\S+)\s+(?:material|متریال)\s+(?!(?:رو|را)\s*$)(.+)$",
                r"\bmaterial\s+(?:Part\s+\d+|پارت\s+\S+)\s+(?!(?:رو|را)\s*$)(.+)$",
            ]
            for pat in patterns:
                m=re.search(pat,payload_scan_s,re.I)
                if m and not claimed(m.start(1),m.end(1)):
                    raw=m.group(1).strip()
                    if raw:
                        add("material",aliases.get(low(raw),raw),(m.start(1),m.end(1)),"typed_literal_material")
                        break

    payload_scan_s=mask_spans(s,[x["span"] for x in out])
    colors={
        "قرمز":"red","آبی":"blue","ابي":"blue","سبز":"green","مشکی":"black",
        "سیاه":"black","خاکستری":"gray","سفید":"white","زرد":"yellow",
        "red":"red","blue":"blue","green":"green","black":"black","white":"white",
        "yellow":"yellow","gray":"gray","grey":"gray",
    }
    for k,v in colors.items():
        pat=(rf"\b{re.escape(k)}\b" if re.fullmatch(r"[a-z]+",k,re.I) else re.escape(k))
        found=False
        for m in re.finditer(pat,payload_scan_s,re.I):
            if not claimed(m.start(),m.end()):
                add("color",v,(m.start(),m.end()),"typed_literal_color")
                found=True
                break
        if found:
            break

    out.sort(key=lambda x:x["span"][0])
    for i,x in enumerate(out,1):
        x["id"]=f"lit{i}"
    return out

def payload_value(payloads,field):
    vals=[x["value"] for x in payloads if x["field"]==field]
    return vals[0] if len(vals)==1 else None

def extract_name_value(text):
    return payload_value(extract_literal_payloads(text),"name")

def extract_property_value(text, ctx, payloads=None):
    payloads=payloads if payloads is not None else extract_literal_payloads(text)
    for field in ("color","material","description","name"):
        v=payload_value(payloads,field)
        if v is not None:
            return (field,v)
    return (None,None)

def extract_evidence(text, ctx=None):
    ctx=ctx or {}
    core=utterance_core(text)

    # Literal-first architecture: payload values are opaque before targets,
    # quantities, semantic cues or action families are extracted.
    payloads=extract_literal_payloads(core)
    semantic_text=mask_spans(core,[x["span"] for x in payloads])
    t=low(semantic_text)
    qs,quantity_issues=extract_quantity_evidence(semantic_text)
    # In contextual edits that explicitly state both current and final values,
    # only the final value is an effect-bearing command value.
    if len(qs)>1 and ctx.get("last_feature") and "فعلی" in t and "نهایی" in t:
        final_pos=t.find("نهایی")
        final_qs=[q for q in qs if q["span"][0] > final_pos]
        if len(final_qs)==1:
            qs=final_qs
            qs[0]["id"]="q1"
    if not qs and re.search(r"(?:میلی\s*متر|میلیمتر|میلی|میل(?:ش)?|mm|درجه|degrees?|deg)\b",low(semantic_text),re.I):
        quantity_issues.append({"kind":"unit_without_parseable_quantity"})
    fs=extract_named_features(semantic_text)
    ps=extract_parts(semantic_text)
    name_value=payload_value(payloads,"name")
    prop,pval=extract_property_value(core,ctx,payloads)
    copy_count=extract_copy_count(semantic_text)

    # Explicitly cancelled clauses do not contribute action semantics.
    cue_t,negated_clause_count=mask_negated_action_clauses(t)

    # Canonical cue layer: normalize paraphrase families after typed literals,
    # quantities and targets are extracted, so rewrites cannot corrupt spans.
    cue_t=re.sub(r"خلاف\s+جهت\s+عقربه(?:‌|\s)*(?:های)?\s*ساعت","پادساعتگرد",cue_t,flags=re.I)
    cue_t=re.sub(r"هم[‌\s-]*جهت\s+عقربه(?:‌|\s)*(?:های)?\s*ساعت","ساعتگرد",cue_t,flags=re.I)
    cue_t=re.sub(r"\bبزرگنمایی\s+را\s+بیشتر\s+کن\b","zoom in",cue_t,flags=re.I)
    cue_t=re.sub(r"\bبزرگنمایی\s+را\s+کمتر\s+کن\b","zoom out",cue_t,flags=re.I)

    visibility=None
    part_visibility_target=bool(ps or ctx.get("last_part")) and not (prop=="color" and has_any(cue_t,["با رنگ","ظاهر رنگی"]))
    if part_visibility_target and (re.search(r"\bvisibility\b.*?(?:\boff\b|خاموش)",cue_t,re.I) or re.search(r"نمایش\s+(?:Part\s+\d+|پارت\s+\S+)\s+(?:را|رو)\s+خاموش",cue_t,re.I)):
        visibility=False
    elif part_visibility_target and (re.search(r"\bvisibility\b.*?(?:\bon\b|روشن)",cue_t,re.I) or re.search(r"نمایش\s+(?:Part\s+\d+|پارت\s+\S+)\s+(?:را|رو)\s+روشن",cue_t,re.I)):
        visibility=True
    elif part_visibility_target and (re.search(r"(?:نشون|نشان)\s+نده",cue_t) or "نشون نده" in cue_t or "نشان نده" in cue_t):
        visibility=False
    elif part_visibility_target and has_any(cue_t,["مخفی","قایم","پنهان","hide","هاید","نامرئی","invisible","قایم بشه","نمایش رو ببند","نمایش را ببند","نشونش نده","نشانش نده","از جلوی چشم بردار","از نما بردار","از توی نما بردار","دیده نشه","دیده نشود","نمایش داده نشود","نمایش داده نشه","نمایش را خاموش","نمایش رو خاموش"]):
        visibility=False
    elif part_visibility_target and has_any(cue_t,["نشون بده","نشان بده","نشونش بده","نشانش بده","show","visible","مرئی","نمایش رو باز","نمایش را باز","پیدا باشه","پیدا باشد","به دید برگردان","به دید برگردون","دوباره بیار","دوباره توی viewport بیار","برگردونش توی نما","برگردون تو نما","برگردون توی نما","نمایش داده شود","نمایش داده بشه","نمایش را روشن","نمایش رو روشن"]):
        visibility=True
    elif part_visibility_target and has_any(cue_t,["دیده بشه","دیده بشود","دیده شه","دوباره دیده"]):
        visibility=True

    suppressed=None
    feature_suppression_target=bool(fs or ctx.get("last_feature"))
    if feature_suppression_target and re.search(r"\b(?:suppressed|suppression)\b.*?(?:خاموش|off|false)",cue_t,re.I):
        suppressed=False
    elif feature_suppression_target and re.search(r"\b(?:suppressed|suppression)\b.*?(?:روشن|on|true)",cue_t,re.I):
        suppressed=True
    elif feature_suppression_target and has_any(cue_t,["از حالت suppress دربیار","از حالت suppress در بیار","از حالت suppressed خارج","دوباره فعال کن","دوباره به محاسبه برگرد","به محاسبه برگرد","برگرده توی regeneration","برگرده تو regeneration","regeneration برای","unsuppress","enable کن","دوباره enable","حساب بشه","حساب شود","برگردون به اجرا","برگردان به اجرا"]) and has_any(cue_t,["دوباره","خارج","روشن","فعال","برگرد","unsuppress"]):
        suppressed=False
    elif feature_suppression_target and has_any(cue_t,["خاموش","suppress","غیرفعال باشه","غیرفعال باشد","غیرفعال کن","از regeneration خارج کن","از محاسبه خارج کن","disable کن","حساب نشه","حساب نشود","از اجرا خارج کن"]):
        suppressed=True
    if suppressed is None and feature_suppression_target and has_any(cue_t,["دوباره روشن","روشنش کن","روشن کن","unsuppress","دوباره فعال باشه","دوباره فعال باشد","دوباره فعال کن","enable کن","دوباره enable","حساب بشه","حساب شود","برگردون به اجرا","برگردان به اجرا"]) or (
        "روشن" in cue_t and has_any(cue_t,["برگردون","برگردان","برش گردون","برگردونش"])
    ): suppressed=False
    if feature_suppression_target and ctx.get("last_action")=="suppress" and has_any(cue_t,["برش گردون","برگردونش","دوباره بیارش"]):
        suppressed=False
    if (fs or ctx.get("last_feature")) and has_any(cue_t,["feature","فیچر"]) and has_any(cue_t,["برگردون","برگردان"]):
        suppressed=False

    relation=None
    relation_t=re.sub(r"از\s+این\s+به\s+بعد"," ",cue_t,flags=re.I)
    if has_any(relation_t,["قبل از","قبل ","بالای","بالا ی","جلوتر از","پیش از"]) or re.search(r"\bbefore\b",relation_t,re.I): relation="before"
    elif has_any(relation_t,["بعد از","بعد ","زیر","بعدتر از","پس از","عقب‌تر از","عقب تر از"]) or re.search(r"\bafter\b",relation_t,re.I): relation="after"

    relative=None
    if has_any(cue_t,["زیادش کن","زیاد کن","بیشترش کن","بیشتر کن","یه میل بیشتر","یک میل بیشتر"]) or re.search(r"\bبیشتر\s+کن\b",cue_t):
        relative="add"
    elif has_any(cue_t,["کمترش کن","کم کن","یه میل کمتر","یک میل کمتر"]) or re.search(r"\bکمتر\s+کن\b",cue_t):
        relative="subtract"
    elif ctx.get("last_feature") and qs and (re.search(r"(?:^|\s)بیشتر(?:\s|$)",cue_t) or has_any(cue_t,["بالا ببر","بالا ببرش"])):
        relative="add"
    elif ctx.get("last_feature") and qs and (re.search(r"(?:^|\s)کمتر(?:\s|$)",cue_t) or has_any(cue_t,["پایین ببر","پایین ببرش"])):
        relative="subtract"

    design = has_any(cue_t,[
        "خوشگل","پریمیوم","حرفه ای تر","حرفه‌ای‌تر","تولیدش راحت","تولید راحت",
        "سبک تر","سبک‌تر","وزنشو کم","وزنش رو کم","سفت بمونه","استحکام","قوی تر","قوی‌تر",
        "تزریق پلاستیک","طراحی بهتر","طراحی رو درست","اضافی",
        "مقاومتش کم نشه","مقاومت کم نشه","قالب گیری","قالب‌گیری","به دردنخور",
        "محکم تر","محکم‌تر","وزن قطعه","ضعیف نشه","تولید انبوه","غیرضروری",
        "تزریق","منطقی تر","منطقی‌تر","مرتبش کن","تمیزتر بشه","تمیزتر شه",
        "جمع و جورتر","بهتر دربیار","بهترش کن","بهترین","تداخل نداشته باشه",
        "تداخل نداشته باشد","جوری تغییر بده","طوری تغییر بده","بررسی کن بعد بهترین",
        "پرینت سه بعدی","قابل اعتمادتر","stress concentration","clearance مونتاژ",
        "ارزون تر تولیدپذیر","ارزان تر تولیدپذیر","robust کن","با تغییر اندازه خراب نشه"
    ])
    weight_design = has_any(cue_t,["سبکش کن","سبک کن"])
    tree_design = has_any(cue_t,["درخت فیچر","درخت feature","feature tree"]) and has_any(cue_t,["مرتب","خلوت","شلوغ","منطقی","تمیز","سامان"])
    design = design or weight_design or tree_design
    unsupported = (
        has_any(cue_t,["شرکت onshape","fully constrain","constraint","کانسترینت","سوراخ","shell","loft","sweep",
                       "mirror","revolve","drawing","configuration","mass properties","center of mass",
                       "thread","counterbore","boolean union","stl","tangent","center rectangle",
                       "extrude symmetric","dimension کن","تا سطح بعدی"]) or
        bool(re.search(r"\b(?:public|share|pdf|export|step|mate|company|hole|shell|loft|sweep|mirror|revolve|drawing|configuration|thread|stl|tangent|dimension)\b",cue_t,re.I))
    )

    camera_action=None; camera_direction=None; camera_inverse=False
    if has_any(cue_t,["زوم","zoom","بزرگنمایی","بزرگ نمایی","درشت‌تر","درشت تر","ریزتر","ریز تر","نزدیک تر شو","نزدیک‌تر شو","نزدیک شو","نزدیک‌ترش کن","نزدیک ترش کن","نزدیک تر شود","نزدیک‌تر شود","دورتر شو","دور تر شو","دور شو","دورترش کن","دور ترش کن","ازش دور شو","ازش دورتر شو","از مدل فاصله بگیر","فاصله دید رو کمتر","فاصله دید رو بیشتر","فاصله بیشتری بگیرد","فاصله دوربین با قطعه کمتر","فاصله دوربین با قطعه بیشتر"]): camera_action="zoom"
    else:
        pan_negated=has_any(cue_t,["بدون pan","بدون پن","نه pan","نه پن"])
        orbit_negated=has_any(cue_t,["بدون orbit","نه orbit","بدون چرخش","بدون دوران","بدون چرخوندن","بدون چرخاندن"])
        explicit_pan=(re.search(r"\bpan\b",cue_t,re.I) or "پن " in cue_t) and not pan_negated
        view_translate=(
            has_any(cue_t,["viewport","نما","صفحه","کادر","دوربین"]) and
            has_any(cue_t,["هل بده","بکش","ببر","جابه جا","جابه‌جا","منتقل کن","انتقال بده","انتقال","سر بده","شیفت بده","شیفت"]) and
            has_any(cue_t,["چپ","راست","بالا","پایین","left","right","up","down"])
        )
        orbit_phrase=(has_any(cue_t,["بچرخ","بچرخان","چرخش","گردش","قوس بده","متمایل کن","رول کن","ساعتگرد","پادساعتگرد","ربع دور","عقربه"]) or bool(re.search(r"\b(?:rotate|orbit|rotation|roll|clockwise|counterclockwise)\b",cue_t,re.I))) or (
            has_any(cue_t,["دور مدل","دور قطعه","دور جسم","حول مدل","حول قطعه","حول جسم"]) and has_any(cue_t,["چپ","راست","بالا","پایین","left","right","up","down"])
        ) or (
            re.search(r"\bcamera\b",cue_t,re.I) and has_any(cue_t,["ببر","move"]) and
            has_any(cue_t,["چپ","راست","بالا","پایین","left","right","up","down"])
        )
        if explicit_pan or (view_translate and orbit_negated):
            camera_action="pan"
        elif orbit_phrase and not orbit_negated:
            camera_action="orbit"
        elif view_translate and not pan_negated:
            camera_action="pan"
    if "پادساعتگرد" in cue_t or "خلاف ساعتگرد" in cue_t or re.search(r"\bcounterclockwise\b",cue_t) or re.search(r"خلاف(?:\s+جهت)?\s+عقربه(?:\s*ها)?",cue_t) or has_any(cue_t,["برعکس عقربه"]): camera_direction="counterclockwise"
    elif "ساعتگرد" in cue_t or re.search(r"\bclockwise\b",cue_t) or has_any(cue_t,["در جهت عقربه","با عقربه","با جهت عقربه"]): camera_direction="clockwise"
    elif has_any(cue_t,["سمت راست","به راست","طرف راست","راست بچرخ","هل بده راست"]): camera_direction="right"
    elif has_any(cue_t,["سمت چپ","به چپ","طرف چپ","چپ بچرخ","هل بده چپ"]): camera_direction="left"
    elif has_any(cue_t,["ببر بالا","پن کن بالا","بالا بچرخ","بکش بالا"]): camera_direction="up"
    elif has_any(cue_t,["ببر پایین","پن کن پایین","پایین بچرخ","بکش پایین"]): camera_direction="down"
    elif camera_action and re.search(r"\b(right|راست)\b",cue_t): camera_direction="right"
    elif camera_action and re.search(r"\b(left|چپ)\b",cue_t): camera_direction="left"
    elif camera_action and re.search(r"\b(up|بالا)\b",cue_t): camera_direction="up"
    elif camera_action and re.search(r"\b(down|پایین)\b",cue_t): camera_direction="down"
    if has_any(cue_t,["زیادی شد","برش گردون","برگرد","عقب تر","عقب‌تر","برعکس کن","وارونه کن","خلاف همون حرکت","خلافش","خلاف جهت قبلی","جهت قبلی رو برعکس","جهت آخرین حرکت","آخرین حرکت دوربین رو برگردون","برعکس آخرین مسیر","جهت مخالف","حرکت قبل را در جهت مخالف"]):
        camera_inverse=True
    if camera_action=="zoom":
        zoom_out=has_any(cue_t,["دورتر شو","دور تر شو","دور شو","دورترش کن","دور ترش کن","دورتر برو","ازش دور شو","ازش دورتر شو","از مدل فاصله بگیر","فاصله دید رو بیشتر","فاصله بیشتری بگیرد","فاصله دوربین با قطعه بیشتر","بزرگنمایی را کمتر","بزرگ نمایی رو کم","ریزتر","اوت","out","بیرون"])
        zoom_in=has_any(cue_t,["نزدیک تر شو","نزدیک‌تر شو","نزدیک شو","نزدیک‌ترش کن","نزدیک ترش کن","نزدیک‌تر شود","نزدیک تر شود","فاصله دید رو کمتر","فاصله دوربین با قطعه کمتر","بزرگنمایی را بیشتر","بزرگ نمایی رو زیاد","درشت‌تر","داخل","zoom in"])
        if zoom_out and zoom_in:
            camera_direction=None
        elif zoom_out:
            camera_direction="out"
        elif zoom_in:
            camera_direction="in"
        elif camera_direction is None and has_any(cue_t,["زومشو","زوم کن","zoom"]):
            camera_direction="in"

    lm=ctx.get("last_move") or {}
    if camera_inverse and lm:
        camera_action=lm.get("action",camera_action)
        camera_direction=opposite(lm.get("direction"))
    elif not camera_direction and lm and has_any(cue_t,["بیشتر","همون طرف","همون سمت","همون جهت","همان جهت","جهت آخر","همون حرکت","همان حرکت","ادامه بده","ادامه","باز هم","یه بار دیگه","یک بار دیگر","حرکت قبلی","آخرین حرکت","مسیر قبلی","همون مسیر","روند حرکت","تکرار کن","دوباره انجام بده","دوباره طی"]):
        camera_action=lm.get("action",camera_action)
        camera_direction=lm.get("direction")

    fit_selection_cue = has_any(cue_t,[
        "انتخاب","selection","انتخابم","همین انتخاب","انتخاب ها","انتخاب‌ها","چیزای انتخاب","چیزهای انتخاب","چیزهای انتخاب شده","چیزهای انتخاب‌شده"
    ])
    fit_all_cue = has_any(cue_t,[
        "کل مدل","همه مدل","کلش","همه اش","همه‌اش","همه چی","همه‌چی","کل چیزی که داریم","همه هندسه","تمام مدل","همه قطعه","همهٔ قطعه","کل هندسه"
    ])
    fit_verb = has_any(cue_t,[
        "فیت","fit","تو کادر جا","توی کادر جا","تو کادر باشه","توی کادر باشه","در کادر دیده","کادر را پر","کادر رو پر",
        "تو صفحه جا","توی صفحه جا","توی viewport جا","تو viewport جا","داخل viewport جا","اندازه viewport","اندازه پنجره","با اندازه پنجره جور",
        "توی دید جا","تو دید جا","همه هندسه را یکجا","همه هندسه رو یکجا","اندازه صفحه","معلوم باشه","دیده بشه","جا بگیرد","جا بگیره",
        "بزرگ شه تو صفحه","بزرگ بشه تو صفحه","بزرگ کن تو صفحه","توی دید بزرگ","تو دید بزرگ","کادر را روی","کادر رو روی","داخل قاب جا","توی یک قاب","قاب رو پر","قاب را پر","قاب بندی","قاب‌بندی","داخل صفحه بیفته","داخل صفحه بیفتد","جور کن"
    ])
    fit_selection = fit_verb and fit_selection_cue
    fit_all = fit_verb and not fit_selection and (fit_all_cue or has_any(cue_t,["فیت","fit"]))
    fit_target = "selection" if fit_selection else ("all" if fit_all else None)
    top_view = has_any(cue_t,["از بالا","از جهت بالا","عمود از بالا","عمود از بالای","بالای مدل و رو به پایین","بالای مدل و رو به پائین","top view","نمای بالا","نمای استاندارد بالا","دید استاندارد بالا","top استاندارد","top رو","top را","روی top","روی top تنظیم"]) or bool(
        re.search(r"(?:نمای|نما).*?\btop\b|\btop\s+(?:view|نما)",cue_t,re.I)
    )
    clear_selection = (
        has_any(cue_t,["انتخاب رو پاک","انتخاب را پاک","selection رو پاک","selection را پاک",
                       "selection فعلی رو صفر","انتخاب فعلی رو صفر","selectionها رو خالی","selection ها رو خالی","انتخابارو ول کن","انتخاب ها رو ول کن","clear selection","selection رو clear","selection را clear",
                       "selection ro clear","selection ro clear kon","select شده آزادش کن","انتخاب شده آزادش کن","انتخاب‌شده آزادش کن",
                       "هیچ چیز انتخاب شده نمونه","هیچ چیز انتخاب‌شده نمونه","هیچ انتخابی در viewer باقی نماند","هیچ انتخابی باقی نماند","از حالت انتخاب خارج کن","همه انتخاب‌ها را آزاد کن","همه انتخاب ها را آزاد کن","selection فعلی را کاملاً خالی کن","selection فعلی رو کاملاً خالی کن","انتخاب‌ها را خالی کن","انتخاب ها را خالی کن","انتخاب‌های فعلی رو لغو کن","انتخاب های فعلی رو لغو کن","هیچی selected نمونه","کل selection رو deselect کن","کل selection را deselect کن","هرچی گرفته شده رها کن"]) or
        bool(re.search(r"(?:هر چی|هرچی).*(?:انتخاب|selection|select).*(?:پاک|خالی|ول کن|آزاد|clear)",cue_t)) or
        bool(re.search(r"(?:انتخاب|selection)\s+(?:رو|را)\s+(?:کامل\s+)?خالی(?:\s+کن)?(?=$|\s)",cue_t)) or
        bool(re.search(r"(?:انتخاب|selection).*?(?:پاک|clear)(?:\s+کن)?",cue_t))
    )

    collab_terms=has_any(cue_t,["سشن","session","جلسه","آنلاین","حاضرند","حاضرن","آدم ها","آدم‌ها","آدم های حاضر","آدم‌های حاضر","افراد حاضر","افراد داخل session","همکارها","همکارهای","participant","participants","participantها","توی همکاری هستیم","تو همکاری هستیم","توی سند هستن","داخل session"])
    collab_inspect_signal=has_any(cue_t,["بگو","گزارش","گزارش بده","لیست","فهرست","list","چند نفر","چند نفریم","کیا","چه کسایی","چه کسانی","چه آدم","چه همکار","چه participant","وضع","وضعیت","آنلاین"])
    collaboration_cue = (
        (collab_terms and collab_inspect_signal) or
        has_any(cue_t,["چند نفر","چند نفریم","کیا وصلن"])
    )
    # A selection mention is a referent, not an inspect request.  Inspection needs
    # independent interrogative/state evidence; this prevents "fillet this selection"
    # from being hijacked into viewer.inspect.
    selection_inspect_cue = (
        bool(re.search(r"(?<!\S)چی\s+(?:الان\s+)?(?:انتخاب|سلکت|دستم|دستمه|گرفتم)",cue_t)) or
        bool(re.search(r"(?:(?<!\S)چی(?=\s|$)|چه چیزی).*?(?:دست|گرفت|انتخاب|سلکت)",cue_t)) or
        bool(re.search(r"(?:انتخاب|selection|سلکت|سلکشن).*?(?:چیه|چی هست|چی شده|شامل چیه)",cue_t)) or
        bool(re.search(r"(?:چی|چه)\s+(?:selected|entity)",cue_t,re.I)) or
        bool(re.search(r"(?:لیست\s+)?انتخاب\s+فعلی.*(?:بگو|چیه)",cue_t)) or
        bool(re.search(r"(?:چه چیزهایی|کدام entity|فهرست چیزهای).*?(?:گرفته|انتخاب|selected)",cue_t,re.I)) or
        bool(re.search(r"(?:محتویات\s+selection|selection\s+فعلی).*?(?:گزارش|چی|فهرست)",cue_t,re.I)) or
        bool(re.search(r"(?:entity|entityها|entityهایی).*?(?:دستم|دستمه)",cue_t,re.I)) or
        has_any(cue_t,["وضعیت selection","وضعیت انتخاب","selection status"]) or
        bool(re.search(r"(?:دستم|دستمه|دست من).*?(?:چیه|چی هست|چی شده)",cue_t)) or
        bool(re.search(r"(?:چی ها|چی‌ها).*?(?:انتخاب|selected)",cue_t,re.I)) or
        bool(re.search(r"selected(?:ها|های)?\s+فعلی.*?(?:فهرست|بگو|بخون)",cue_t,re.I)) or
        bool(re.search(r"(?:محتوای|محتویات)\s+selection.*?(?:بخون|بگو|گزارش)",cue_t,re.I))
    )
    if clear_selection:
        selection_inspect_cue=False
    selection_action = None
    if clear_selection:
        selection_action = "clear"
    elif has_any(cue_t,["انتخاب کن","انتخابش کن","select کن","سلکت کن"]) and not has_any(cue_t,["دنبال","follow","deselect","unselect"]):
        selection_action = "select"
    state_cue = has_any(cue_t,["وضعیت ویور","وضعیت viewer","وضع فعلی viewer","viewer state","state فعلی نمای مدل","وضعیت صفحه","state صفحه","وضعیت نما","وضع دوربین و صفحه","وضعیت فعلی نمای سه بعدی","وضعیت فعلی نمای سه‌بعدی","وضع موجود صفحه مدل","viewer در چه وضعی","viewer الان چه حالتی","ویور استیت","چه وضعیه","چه وضعی است","گزارش کن","گزارش بده","بهم بگو","بخون","گزارش از viewer state","گزارش از state فعلی viewer"]) and has_any(cue_t,["ویور","viewer","صفحه","نما","state","وضعیت","وضع"])
    inspect_target = "collaboration" if collaboration_cue else ("selection" if selection_inspect_cue else ("state" if state_cue else None))

    parameter_hint=None
    feature_target_present=bool(fs or ctx.get("last_feature"))
    if feature_target_present:
        if re.search(r"(?:flip\s+direction|جهت\s+flip|flip\s+جهت|جهت\s+برعکس|گزینه\s+flip|\bflip\b)",cue_t,re.I): parameter_hint="flip direction"
        elif has_any(cue_t,["عمق","depth","دیپث"]): parameter_hint="depth"
        elif has_any(cue_t,["زاویه","angle"]): parameter_hint="angle"
        elif has_any(cue_t,["شعاع","radius","ریدیوس"]): parameter_hint="radius"

    # A precise typed parameter edit is not design judgment merely because it
    # uses a generic phrase such as "طوری تغییر بده".
    if design and feature_target_present and parameter_hint in {"radius","depth","angle","flip direction"} and qs:
        strong_design=has_any(cue_t,["استحکام","سفتی","تولید","stress","تمرکز تنش","robust","ماشین کاری","ماشین‌کاری","اقتصادی","بهینه","وزن","بهترین","طراحی"])
        if not strong_design:
            design=False

    # روشن/خاموش is the boolean slot of flip-direction when that typed parameter
    # is explicit; it must not simultaneously become feature-suppression evidence.
    explicit_suppression_verb=bool(re.search(r"\b(?:suppress|unsuppress)\b",cue_t,re.I))
    if parameter_hint=="flip direction" and not explicit_suppression_verb:
        suppressed=None

    boolean_value=None
    if parameter_hint=="flip direction" and has_any(cue_t,["غیرفعال"]): boolean_value=False
    elif parameter_hint=="flip direction" and has_any(cue_t,["فعال"]): boolean_value=True
    elif has_any(cue_t,["خاموش"]) or re.search(r"\b(?:off|false)\b",cue_t): boolean_value=False
    elif has_any(cue_t,["روشن"]) or re.search(r"\b(?:on|true)\b",cue_t): boolean_value=True

    follow_candidate_index = 2 if has_any(cue_t,["نفر دوم","دومی","دوم رو","second","شماره دو","participant شماره دو","participant دوم","همکار دوم"]) else None
    delete_position = "last" if "آخرین" in cue_t else ("first" if "اولین" in cue_t else None)
    rollback_position = "end" if "آخر" in cue_t else ("start" if "اول" in cue_t else None)
    rollback_explicit = has_any(cue_t,["rollback","نقطه بازگشت","نقطه تاریخچه","نشانگر بازگشت","history bar","rollback point","rollback bar","تاریخچه رو تا","تاریخچه را تا","history rollback"]) or bool(re.search(r"برگرد(?:ون|ان)?\s+تا\s+(?:قبل|بعد)",cue_t))
    feature_word = has_any(cue_t,["فیچر","feature"])
    delete_cue = has_any(cue_t,["پاک کن","حذف کن","بنداز دور","حذفش کن","پاک","حذف"])
    plane_explicit = has_any(cue_t,["plane","صفحه مرجع","صفحه کمکی"])
    plane_create_explicit = has_any(cue_t,["بساز","ایجاد","create","جدید","خالی","اضافه"])
    plane_reference_direction = next((x for x in ("right","left","top","front") if x in cue_t),None)
    pattern_explicit = (
        has_any(cue_t,["pattern","الگو"]) or
        ("تکرار" in cue_t and copy_count is not None and bool(ps or ctx.get("last_part"))) or
        ("خطی" in cue_t and copy_count is not None and bool(ps or ctx.get("last_part"))) or
        (has_any(cue_t,["در یک خط","نسخه","کپی","گام","pitch","spacing","count"]) and copy_count is not None and bool(ps or ctx.get("last_part")))
    )
    selection_referent=has_any(cue_t,["selection","انتخاب","لبه انتخاب","لبه‌های انتخاب","لبه هاي انتخاب","edgeهای","edge ها","edgeها"])
    explicit_selection_absence=has_any(cue_t,["بدون انتخاب","بدون selection","بدون edge انتخابی","بدون لبه انتخابی","بدون اینکه edgeای انتخاب باشه","بدون اینکه edge ای انتخاب باشه","بدون target فعلی","selection نداریم","انتخاب نداریم","selection خالیه","selection خالی است","selection خالی باشد","انتخاب خالیه","انتخاب خالی است","لبه انتخاب نشده","edge انتخاب نشده"])
    edge_new_explicit = explicit_selection_absence or (
        has_any(cue_t,["جدید","خالی","تازه"]) and not selection_referent and ctx.get("selection_count",0)<=0
    )

    edge_kind=None
    if has_any(cue_t,["پخ","چمفر","chamfer","bevel"]): edge_kind="chamfer"
    elif has_any(cue_t,["فیلت","fillet","فیلِت","گرد کن","گردی","نرم کن","نرمش کن"]): edge_kind="fillet"

    # In the owner's CAD shorthand, a bare fractional edge size is millimetres.
    # Keep this bounded to explicit fractional forms so "فیلت دو" can never become 2 mm.
    if edge_kind and not qs:
        frac_pat=r"(?:نیم|(?:یک|یه|دو|سه|چهار|پنج|شش|هفت|هشت|نه|ده|بیست|سی|چهل|پنجاه|شصت|هفتاد|هشتاد|نود)(?:\s+و\s+نیم|\s+(?:دهم|صدم)))"
        for fm in re.finditer(frac_pat,t):
            n=parse_spoken_number(fm.group(0))
            if n is not None:
                ast=parse_spoken_number_ast(fm.group(0))
                qs.append({"id":"q1","value":n,"unit":"mm","text":fm.group(0),
                           "span":[fm.start(),fm.end()],"implicit_unit":True,
                           "ast":ast,"provenance":"bounded_implicit_edge_mm"})
                break

    action_cues=[]
    def cue(name, cond):
        if cond: action_cues.append(name)

    feature_target=bool(fs or ctx.get("last_feature"))
    part_target=bool(ps or ctx.get("last_part"))
    rename_cue = has_any(cue_t,["اسم","نام","عنوان","title","rename","نام گذاری","نام‌گذاری","صدا کن"]) or bool(re.search(r"\bname\b",cue_t,re.I))
    named_feature_context = bool(fs) and (relation is not None or rename_cue or has_any(cue_t,["پاک","حذف","بنداز دور"]))
    edge_effect_context = (ctx.get("selection_count",0)>0 or has_any(cue_t,["لبه","انتخاب","selected"]) or has_any(cue_t,["جدید","خالی","بدون انتخاب"]))
    cue("edge_fillet", has_any(cue_t,["فیلت","fillet","فیلِت"]) and edge_effect_context and not named_feature_context)
    cue("edge_chamfer", has_any(cue_t,["پخ","چمفر","chamfer","bevel"]) and edge_effect_context and not named_feature_context)
    cue("part_visibility", visibility is not None and part_target)
    cue("part_property", prop is not None and part_target)
    cue("feature_rename", name_value is not None and feature_target and rename_cue)
    cue("delete", delete_cue and (feature_target or part_target) and not clear_selection)
    cue("reorder", relation is not None and len(fs)>=1 and not rollback_explicit)
    cue("rollback", rollback_explicit)
    cue("create_plane", plane_explicit and plane_create_explicit)
    cue("pattern", pattern_explicit)
    cue("feature_parameter", parameter_hint is not None and feature_target)
    cue("feature_suppression", suppressed is not None and feature_target)
    cue("clear_selection", clear_selection)
    cue("selection_select", selection_action=="select")
    cue("fit", fit_target is not None)
    cue("standard_view", top_view)
    cue("inspect", inspect_target is not None)
    follow_cue = (
        has_any(cue_t,["فالو","follow","دنبال کن","دنبال‌کردن","دنبال کردن","دنبال","sync","سینک"]) or
        (has_any(cue_t,["طرف مقابل","دومی","نفر دوم","participant مقابل","همکار روبرو","همکار دوم","همکار دیگر","اون یکی همکار","آن یکی همکار","نفر دیگه","نفر دیگر"]) and has_any(cue_t,["بگیر","وصل کن","وصل شو","دنبال","sync","سینک"]))
    )
    cue("follow", follow_cue)
    cue("camera", camera_action is not None)
    part_studio_create = has_any(cue_t,["part studio","پارت استودیو"]) and has_any(cue_t,["بساز","جدید","new","create","تازه","ایجاد","اضافه","workspace","محیط","تب"])
    document_rename = has_any(cue_t,["داکیومنت","document","سند"]) and name_value is not None and rename_cue
    cue("create_part_studio", part_studio_create)
    cue("rename_document", document_rename)

    # Clause/scope layer: quantities cannot create fake conjunctions and cancelled
    # clauses cannot create fake effects. Two independent imperative clauses fail closed.
    clause_text=mask_spans(cue_t,[q["span"] for q in qs])
    effect_clause_count=count_effect_clauses(clause_text)
    conditional=has_conditional_or_exception(cue_t)
    dependent_sequence=has_dependent_sequence(cue_t)
    action_families=sorted(set(action_cues))
    payload_binding_single_effect = bool(name_value) and (
        (plane_explicit and plane_create_explicit) or part_studio_create or document_rename
    )
    paired_actions=bool(re.search(r"(?:^|\s)هم\s+.+?\s+هم\s+",clause_text,re.I))
    multi_action=(len(action_families)>1 or paired_actions or (effect_clause_count>1 and not payload_binding_single_effect))
    negated_action_only=(negated_clause_count>0 and effect_clause_count==0)

    return {
        "text":norm_text(text),
        "core_text":core,
        "quantities":qs,
        "quantity_issues":quantity_issues,
        "features":fs,
        "parts":ps,
        "context_feature":ctx.get("last_feature"),
        "context_part":ctx.get("last_part"),
        "selection_count":ctx.get("selection_count",0),
        "selection_types":ctx.get("selection_types",[]),
        "last_move":ctx.get("last_move"),
        "feature_parameters":ctx.get("feature_parameters",{}),
        "last_action":ctx.get("last_action"),
        "collaborator_count":ctx.get("collaborator_count"),
        "visibility":visibility,
        "suppressed":suppressed,
        "relation":relation,
        "relative":relative,
        "property":prop,
        "property_value":pval,
        "name_value":name_value,
        "payloads":payloads,
        "inspect_target":inspect_target,
        "selection_action":selection_action,
        "parameter_hint":parameter_hint,
        "boolean_value":boolean_value,
        "follow_candidate_index":follow_candidate_index,
        "follow_cue":follow_cue,
        "delete_position":delete_position,
        "rollback_position":rollback_position,
        "rollback_explicit":rollback_explicit,
        "part_studio_create":part_studio_create,
        "document_rename":document_rename,
        "rename_cue":rename_cue,
        "feature_word":feature_word,
        "delete_cue":delete_cue,
        "plane_explicit":plane_explicit,
        "plane_create_explicit":plane_create_explicit,
        "plane_reference_direction":plane_reference_direction,
        "pattern_explicit":pattern_explicit,
        "edge_new_explicit":edge_new_explicit,
        "selection_referent":selection_referent,
        "copy_count":copy_count,
        "cue_text":cue_t,
        "design":design,
        "unsupported":unsupported,
        "camera_action":camera_action,
        "camera_direction":camera_direction,
        "camera_inverse":camera_inverse,
        "fit_all":fit_all,
        "fit_selection":fit_selection,
        "fit_target":fit_target,
        "top_view":top_view,
        "clear_selection":clear_selection,
        "edge_kind":edge_kind,
        "multi_action":multi_action,
        "effect_clause_count":effect_clause_count,
        "conditional":conditional,
        "dependent_sequence":dependent_sequence,
        "negated_clause_count":negated_clause_count,
        "negated_action_only":negated_action_only,
        "action_cues":action_cues,
        "action_families":action_families,
    }

def choose_feature(ev):
    if ev["features"]: return ev["features"][0]["name"]
    return ev.get("context_feature")

def choose_part(ev):
    if ev["parts"]: return ev["parts"][0]["name"]
    return ev.get("context_part")

def first_quantity(ev, unit=None):
    for q in ev["quantities"]:
        if unit is None or q["unit"]==unit: return q
    return None

def all_quantities(ev, unit=None):
    return [q for q in ev["quantities"] if unit is None or q["unit"]==unit]

def opposite(d):
    return {"left":"right","right":"left","up":"down","down":"up",
            "in":"out","out":"in","clockwise":"counterclockwise",
            "counterclockwise":"clockwise"}.get(d)

FEATURE_PARAMETER_COMPAT = {
    "fillet": {"radius"},
    "extrude": {"depth", "flip direction"},
    "draft": {"angle"},
}

def feature_type_from_name(name):
    if not name:
        return None
    first=low(str(name)).split()[0]
    aliases={"فیلت":"fillet","اکسترود":"extrude","درفت":"draft"}
    first=aliases.get(first,first)
    return first if first in FEATURE_PARAMETER_COMPAT else None

def feature_parameter_compatible(feature_name, parameter):
    ftype=feature_type_from_name(feature_name)
    if ftype is None:
        return False
    return parameter in FEATURE_PARAMETER_COMPAT.get(ftype,set())

def inferred_feature_parameter(ev):
    """Infer only provider-safe type/unit defaults; explicit parameter evidence wins."""
    if ev.get("parameter_hint"):
        return ev["parameter_hint"]
    feature=choose_feature(ev)
    ftype=feature_type_from_name(feature)
    if ftype=="fillet" and len(all_quantities(ev,"mm"))==1:
        return "radius"
    if ftype=="draft" and len(all_quantities(ev,"deg"))==1:
        return "angle"
    return None

def direct_intent(case, ev):
    t=ev.get("cue_text") or low(case["text"])
    ctx=case.get("ctx",{})

    if ev["design"]: return ("think",None)
    if ev["unsupported"]: return ("ask",None)
    if ev.get("conditional") or ev.get("dependent_sequence"): return ("ask",None)
    if ev.get("negated_action_only"): return ("ask",None)
    if ev["multi_action"]: return ("ask",None)

    if ev["clear_selection"]: return ("act","clear_selection")
    if ev.get("selection_action")=="select":
        return ("ask",None)
    if ev["fit_selection"]: return ("act","fit_selection")
    if ev["fit_all"]: return ("act","fit")
    if ev["top_view"]: return ("act","top_view")
    if ev.get("inspect_target"): return ("act","inspect")
    if ev.get("follow_cue"): return ("act","follow")

    if ev.get("parameter_hint")=="flip direction" and choose_feature(ev):
        return ("act","feature_parameter")
    if ev.get("rename_cue") and choose_feature(ev):
        return ("act","feature_rename")
    if ev.get("delete_position") and ev.get("feature_word") and ev.get("delete_cue"):
        return ("act","feature_delete")
    if "آخرین" in t and has_any(t,["از فیچرها","درخت فیچر"]) and has_any(t,["پاک","حذف"]):
        return ("act","feature_delete")
    if choose_feature(ev) and (has_any(t,["پاک کن","حذف کن","حذفش کن","پاکش کن","بنداز دور","از درخت feature بردار","از درخت فیچر بردار","از history حذف","از درخت","دیگر در مدل نباشد","توی feature tree نباشه","توی feature tree نباشد","remove کن","delete کن","delete "]) or (ev.get("feature_word") and "بردار" in t)):
        return ("act","feature_delete")
    if choose_part(ev) and (has_any(t,["پاک کن","حذف کن","delete کن","delete ","بنداز دور","از مدل بردار","برای همیشه حذف","وجود نداشته باشد","وجود نداشته"]) or re.search(r"از\s+مدل.*?بردار",t)) and not choose_feature(ev):
        return ("act","part_delete")
    if ev.get("rollback_explicit"): return ("act","rollback")
    if ev["relation"] and (len(ev["features"])>=2 or (ctx.get("last_feature") and len(ev["features"])>=1)):
        return ("act","feature_reorder")

    if ev["suppressed"] is not None and choose_feature(ev):
        return ("act","feature_suppressed")
    if ev["visibility"] is not None and choose_part(ev): return ("act","part_visibility")
    if ev["property"] and choose_part(ev): return ("act","part_property")

    if ev["edge_kind"]:
        explicit_new=bool(ev.get("edge_new_explicit"))
        if explicit_new: return ("act","add_edge_feature")
        if choose_feature(ev) and first_quantity(ev) and not (ctx.get("selection_count",0)>0 or has_any(t,["لبه","انتخاب","selected"])):
            return ("act","feature_parameter")
        return ("act","edge_on_selection")

    # Camera direct lane, including contextual correction.
    if ev["camera_action"] or (ev["last_move"] and has_any(t,["بیشتر","برگرد","برش گردون","برگردون","زیادی شد","عقب تر","عقب‌تر","همون طرف","همون جهت","جهت آخر","همون حرکت","آخرین حرکت","مسیر قبلی","روند حرکت","ادامه بده","باز هم","خلافش","برعکس آخرین"])):
        return ("act","camera_move")
    if ev.get("part_studio_create"): return ("act","create_part_studio")
    if ev.get("document_rename"): return ("act","rename_document")

    if ev.get("plane_explicit") and ev.get("plane_create_explicit"): return ("act","add_plane")
    if ev.get("pattern_explicit"): return ("act","add_pattern")

    # Existing-feature parameter cues.
    if choose_feature(ev) and (inferred_feature_parameter(ev) is not None or ev["relative"]):
        return ("act","feature_parameter")

    # Existing-part property by common shorthand.
    if choose_part(ev) and has_any(t,["رنگ","color","متریال","material","description"]):
        return ("act","part_property")

    # Generic missing-grounding shapes fail closed locally.
    if ev.get("quantity_issues") and (choose_feature(ev) or choose_part(ev) or ev.get("edge_kind")):
        return ("ask",None)
    if choose_feature(ev) and first_quantity(ev) and not has_any(t,["شعاع","radius","عمق","depth","زاویه","angle","flip direction"]) and not str(choose_feature(ev)).lower().startswith("fillet"):
        return ("ask",None)
    if (choose_part(ev) or ev.get("context_part")) and has_any(t,["اسم","نام","rename"]) and not ev.get("name_value"):
        return ("ask",None)
    if has_any(t,["plane","صفحه مرجع"]) and has_any(t,["right","left","top","front"]) and not has_any(t,["به اسم","اسمش","called","named"]):
        return ("ask",None)
    if choose_part(ev) and re.search(r"(?:\d+|یک|دو|سه|چهار|پنج|شش|هفت|هشت|نه|ده)\s*تا",t) and not has_any(t,["pattern","الگو","تکرار"]):
        return ("ask",None)
    if has_any(t,["پاک کن","حذف کن","حذفش کن","اون رو حذف","اون رو پاک"]) and not choose_feature(ev) and not choose_part(ev):
        return ("ask",None)
    if ev.get("quantities") and not choose_feature(ev) and not choose_part(ev) and not ev.get("edge_kind") and not ev.get("camera_action"):
        return ("ask",None)
    if has_any(t,["همون کاری که","همین کاری که"]) and not (ev.get("context_feature") or ev.get("context_part") or ev.get("last_move")):
        return ("ask",None)

    # Known unsupported/deictic shapes fail closed.
    if has_any(t,["ایزو","ایزومتریک","front view","نمای front","نمای روبرو","mirror","سوراخ","hole","این رو انتخاب","اون لبه"]) or re.search(r"(?:همین|این|آن|اون)\s+(?:face|edge|لبه|سطح).*?(?:بگیر|انتخاب)",t,re.I):
        return ("ask",None)
    if has_any(t,["همه رو پاک","همه را پاک","کل مدل رو حذف"]):
        return ("ask",None)
    return (None,None)

def compile_intent(case, decision, intent, ev):
    if decision=="think":
        return reject("design-escalation")
    if decision=="ask" or not intent:
        return reject("clarification")

    if intent not in INTENTS and intent!="fit_selection":
        return reject("intent-not-allowed")

    single_feature_intents={"feature_parameter","feature_suppressed","feature_rename","feature_delete","rollback"}
    single_part_intents={"part_delete","part_visibility","part_property","add_pattern"}
    if intent in single_feature_intents and len(ev.get("features") or [])>1:
        return reject("feature-target-ambiguous")
    if intent in single_part_intents and len(ev.get("parts") or [])>1:
        return reject("part-target-ambiguous")

    if ev.get("conditional"):
        return reject("conditional-needs-resolution")
    if ev.get("dependent_sequence"):
        return reject("dependent-sequence-needs-resolution")
    if ev.get("negated_action_only"):
        return reject("negated-action")
    if ev["multi_action"]:
        return reject("semantic-residue-multi-action")

    if intent in {"camera_move","edge_on_selection","feature_parameter","add_pattern","add_edge_feature"} and ev.get("quantity_issues"):
        return reject("quantity-parse-ambiguous")

    if intent=="camera_move":
        action=ev.get("camera_action")
        direction=ev.get("camera_direction")
        if not action:
            action="orbit"
        allowed={"orbit":{"left","right","up","down","clockwise","counterclockwise"},
                 "pan":{"left","right","up","down"},"zoom":{"in","out"}}
        if action not in allowed or direction not in allowed[action]:
            return reject("camera-ungrounded")
        args={"action":action,"direction":direction}
        q=first_quantity(ev,"deg")
        if q: args["angle_degrees"]=q["value"]
        return accept("view.move",args,{"direction":"text/context","magnitude":q["id"] if q else None})

    if intent=="fit_selection":
        if ev.get("fit_target")!="selection" or ev["selection_count"]<=0:
            return reject("fit-selection-target-unproven")
        return accept("view.fit",{"action":"fit_selection"},{"target":"text+verified-selection-context"})

    if intent=="fit":
        target=ev.get("fit_target")
        if target=="selection":
            if ev["selection_count"]<=0:
                return reject("fit-selection-ungrounded")
            return accept("view.fit",{"action":"fit_selection"},{"target":"text+verified-selection-context"})
        if target=="all":
            return accept("view.fit",{"action":"fit"},{"target":"text"})
        return reject("fit-target-unproven")

    if intent=="top_view":
        if not ev.get("top_view"):
            return reject("standard-view-not-grounded")
        return accept("view.standard",{"view":"top"},{"view":"text"})
    if intent=="clear_selection": return accept("viewer.selection.clear",{},{})

    if intent=="inspect":
        mode=ev.get("inspect_target")
        if mode not in {"selection","collaboration","state"}:
            return reject("inspect-target-ungrounded")
        return accept("viewer.inspect",{"mode":mode},{"mode":"semantic-evidence"})

    if intent=="follow":
        cc=ev.get("collaborator_count")
        idx=ev.get("follow_candidate_index")
        if cc and cc>=3 and idx is None: return reject("follow-ambiguous")
        return accept("view.follow",{} if idx is None else {"candidate_index":idx},{"candidate":"text/context"})

    if intent=="edge_on_selection":
        if ev["selection_count"]<=0: return reject("selection-ungrounded")
        types=[low(str(x)) for x in (ev.get("selection_types") or [])]
        if types and any(x not in {"edge","edges"} for x in types):
            return reject("selection-type-incompatible")
        if ev["edge_kind"] not in {"fillet","chamfer"}: return reject("edge-kind-missing")
        qs=all_quantities(ev,"mm")
        if len(qs)!=1: return reject("edge-amount-ambiguous")
        if not quantity_in_bounds("length",qs[0]["value"]): return reject("edge-amount-out-of-bounds")
        return accept("feature.from_selection",
                      {"feature_type":ev["edge_kind"],"amount":quantity_string(qs[0])},
                      {"kind":"text","amount":qs[0]["id"],"selection":"verified-context"})

    if intent=="feature_parameter":
        feature=choose_feature(ev)
        if not feature: return reject("feature-ungrounded")
        parameter=inferred_feature_parameter(ev)
        if parameter not in {"radius","depth","angle","flip direction"}:
            return reject("feature-parameter-ungrounded")

        if not feature_parameter_compatible(feature,parameter):
            return reject("feature-parameter-incompatible")

        if parameter=="flip direction":
            value=ev.get("boolean_value")
            if value is None: return reject("boolean-value-ungrounded")
            return accept("feature.parameter.set",{"feature_name":feature,"parameter":parameter,"value":value},
                          {"feature":"text/context","value":"text"})

        unit="deg" if parameter=="angle" else "mm"
        qs=all_quantities(ev,unit)
        if ev["relative"]:
            if len(qs)!=1: return reject("relative-delta-ambiguous")
            current=(ev.get("feature_parameters") or {}).get(parameter)
            if current is None and parameter=="radius":
                current=(ev.get("feature_parameters") or {}).get("radius")
            cur=parse_quantity_literal(current,unit)
            if cur is None: return reject("relative-current-missing")
            delta=qs[0]["value"]*(1 if ev["relative"]=="add" else -1)
            value=cur+delta
            bound_kind="angle" if parameter=="angle" else "length"
            if not quantity_in_bounds(bound_kind,value): return reject("relative-result-out-of-bounds")
            qstr=f"{int(value) if float(value).is_integer() else value:g} {unit}"
            return accept("feature.parameter.set",{"feature_name":feature,"parameter":parameter,"amount":qstr},
                          {"feature":"text/context","delta":qs[0]["id"],"current":"verified-context","operator":ev["relative"]})
        if len(qs)!=1: return reject("feature-value-ambiguous")
        bound_kind="angle" if parameter=="angle" else "length"
        if not quantity_in_bounds(bound_kind,qs[0]["value"]): return reject("feature-value-out-of-bounds")
        return accept("feature.parameter.set",{"feature_name":feature,"parameter":parameter,"amount":quantity_string(qs[0])},
                      {"feature":"text/context","value":qs[0]["id"],"parameter":"text/type"})

    if intent=="feature_suppressed":
        feature=choose_feature(ev)
        if not feature or ev["suppressed"] is None: return reject("suppress-ungrounded")
        return accept("feature.patch",{"feature_name":feature,"suppressed":ev["suppressed"]},
                      {"feature":"text/context","state":"text"})

    if intent=="feature_rename":
        feature=choose_feature(ev); name=ev.get("name_value")
        if not feature or not name: return reject("feature-rename-ungrounded")
        return accept("feature.patch",{"feature_name":feature,"new_name":name},
                      {"feature":"text/context","name":"text-span"})

    if intent=="feature_delete":
        if ev.get("delete_position") in {"last","first"}:
            return accept("feature.delete",{"position":ev["delete_position"]},{"position":"semantic-evidence"})
        feature=choose_feature(ev)
        if not feature: return reject("delete-feature-ungrounded")
        return accept("feature.delete",{"feature_name":feature},{"feature":"text/context"})

    if intent=="part_delete":
        part=choose_part(ev)
        if not part: return reject("delete-part-ungrounded")
        return accept("feature.delete_part",{"part_name":part},{"part":"text/context"})

    if intent=="part_visibility":
        part=choose_part(ev)
        if not part or ev["visibility"] is None: return reject("visibility-ungrounded")
        return accept("part.visibility",{"part_name":part,"visible":ev["visibility"]},
                      {"part":"text/context","state":"text-negation-aware"})

    if intent=="part_property":
        part=choose_part(ev); prop=ev.get("property"); value=ev.get("property_value")
        if not part or not prop or value is None: return reject("part-property-ungrounded")
        op="documented.updateWVEPMetadata" if prop=="name" else "metadata.property.set"
        return accept(op,{"part_name":part,"property":prop,"value":value},
                      {"part":"text/context","property":"text","value":"text-span"})

    if intent=="add_plane":
        if not ev.get("plane_explicit"):
            return reject("plane-not-explicit")
        if not ev.get("plane_create_explicit"):
            return reject("plane-create-not-explicit")
        if ev.get("plane_reference_direction") and not ev.get("name_value"):
            return reject("plane-reference-needs-provider-shape")
        args={"feature_type":"plane"}
        if ev.get("name_value"): args["name"]=ev["name_value"]
        return accept("feature.add",args,{"name":"text-span" if ev.get("name_value") else None})

    if intent=="add_pattern":
        if not ev.get("pattern_explicit"):
            return reject("pattern-not-explicit")
        part=choose_part(ev)
        qs=all_quantities(ev,"mm")
        copies=ev.get("copy_count")
        if not part or copies is None or len(qs)!=1: return reject("pattern-ungrounded")
        if not (2 <= copies <= 1000): return reject("pattern-count-out-of-bounds")
        if not quantity_in_bounds("length",qs[0]["value"]): return reject("pattern-distance-out-of-bounds")
        return accept("feature.add",
                      {"feature_type":"linearPattern","part_name":part,"copies":copies,"distance":quantity_string(qs[0])},
                      {"part":"text/context","copies":"text","distance":qs[0]["id"]})

    if intent=="add_edge_feature":
        if not ev.get("edge_new_explicit"):
            return reject("new-edge-not-explicit")
        qs=all_quantities(ev,"mm")
        if ev["edge_kind"] not in {"fillet","chamfer"} or len(qs)!=1:
            return reject("new-edge-ungrounded")
        if not quantity_in_bounds("length",qs[0]["value"]): return reject("new-edge-amount-out-of-bounds")
        return accept("feature.add",{"feature_type":ev["edge_kind"],"amount":quantity_string(qs[0])},
                      {"kind":"text","amount":qs[0]["id"]})

    if intent=="feature_reorder":
        fs=[x["name"] for x in ev["features"]]
        if ev.get("context_feature") and len(fs)==1:
            source=ev["context_feature"]; target=fs[0]
        elif len(fs)>=2:
            source,target=fs[0],fs[1]
        else: return reject("reorder-targets-ungrounded")
        if ev["relation"] not in {"before","after"}: return reject("reorder-relation-ungrounded")
        return accept("feature.reorder",{"source_feature":source,"target_feature":target,"placement":ev["relation"]},
                      {"source":"text/context","target":"text","placement":"text"})

    if intent=="rollback":
        fs=[x["name"] for x in ev["features"]]
        if ev["relation"]=="before" and fs:
            args={"before_feature":fs[-1]}
        elif ev["relation"]=="after" and fs:
            args={"after_feature":fs[-1]}
        elif ev.get("rollback_position")=="end":
            args={"position":"end"}
        elif ev.get("rollback_position")=="start":
            args={"position":"start"}
        else: return reject("rollback-ungrounded")
        return accept("rollback.set",args,{"target":"text"})

    if intent=="create_part_studio":
        name=ev.get("name_value")
        if not name: return reject("part-studio-name-ungrounded")
        return accept("documented.createPartStudio",{"new_name":name},{"name":"text-span"})

    if intent=="rename_document":
        name=ev.get("name_value")
        if not name: return reject("document-name-ungrounded")
        return accept("documented.updateDocumentAttributes",{"new_name":name},{"name":"text-span"})

    return reject("intent-unhandled")

def _payload_consumed(atom, compiled):
    op=compiled.get("op")
    args=compiled.get("args") or {}
    field=atom.get("field")
    value=atom.get("value")
    if field=="name":
        return (
            args.get("name")==value or args.get("new_name")==value or
            (args.get("property")=="name" and args.get("value")==value)
        )
    if field in {"color","material","description"}:
        return args.get("property")==field and args.get("value")==value
    return False

def enforce_evidence_consumption(post, ev):
    """Fail closed if explicit effect-bearing evidence would be silently dropped."""
    if not post.get("accepted"):
        return post
    compiled=post.get("compiled") or {}
    op=compiled.get("op")
    args=compiled.get("args") or {}
    atoms=list(ev.get("payloads") or [])
    if ev.get("inspect_target") is not None:
        atoms.append({"id":"sem:inspect_target","kind":"semantic","field":"inspect_target","value":ev["inspect_target"]})
    if ev.get("visibility") is not None:
        atoms.append({"id":"sem:visibility","kind":"semantic","field":"visibility","value":ev["visibility"]})
    if ev.get("suppressed") is not None:
        atoms.append({"id":"sem:suppressed","kind":"semantic","field":"suppressed","value":ev["suppressed"]})
    if ev.get("camera_direction") is not None:
        atoms.append({"id":"sem:camera_direction","kind":"semantic","field":"camera_direction","value":ev["camera_direction"]})
    if ev.get("fit_target") is not None:
        atoms.append({"id":"sem:fit_target","kind":"semantic","field":"fit_target","value":ev["fit_target"]})
    if ev.get("top_view"):
        atoms.append({"id":"sem:standard_view","kind":"semantic","field":"standard_view","value":"top"})
    if ev.get("delete_position") is not None and ev.get("delete_cue"):
        atoms.append({"id":"sem:delete_position","kind":"semantic","field":"delete_position","value":ev["delete_position"]})
    if ev.get("parameter_hint") is not None:
        atoms.append({"id":"sem:parameter_hint","kind":"semantic","field":"parameter_hint","value":ev["parameter_hint"]})

    unconsumed=[]
    for atom in atoms:
        field=atom.get("field")
        value=atom.get("value")
        if atom.get("kind")=="literal_payload":
            consumed=_payload_consumed(atom,compiled)
        elif field=="inspect_target":
            consumed=(op=="viewer.inspect" and args.get("mode")==value)
        elif field=="visibility":
            consumed=(op=="part.visibility" and args.get("visible")==value)
        elif field=="suppressed":
            consumed=(op=="feature.patch" and args.get("suppressed")==value)
        elif field=="camera_direction":
            consumed=(op=="view.move" and args.get("direction")==value)
        elif field=="fit_target":
            expected_action="fit_selection" if value=="selection" else "fit"
            consumed=(op=="view.fit" and args.get("action")==expected_action)
        elif field=="standard_view":
            consumed=(op=="view.standard" and args.get("view")==value)
        elif field=="delete_position":
            consumed=(op=="feature.delete" and args.get("position")==value)
        elif field=="parameter_hint":
            consumed=(op=="feature.parameter.set" and args.get("parameter")==value)
        else:
            consumed=False
        if not consumed:
            unconsumed.append(atom.get("id") or field)

    if unconsumed:
        blocked=reject("effect-evidence-unconsumed")
        blocked["unconsumed_evidence"]=unconsumed
        return blocked
    post["consumed_evidence_count"]=len(atoms)
    return post

def quantity_in_bounds(kind, value):
    try:
        v=float(value)
    except Exception:
        return False
    if kind=="length":
        return 0.0 < v <= 100000.0
    if kind=="angle":
        return 0.0 <= abs(v) < 90.0
    return False

def parse_quantity_literal(v, unit):
    if v is None: return None
    s=low(str(v))
    m=re.fullmatch(r"([+-]?\d+(?:\.\d+)?)\s*"+re.escape(unit),s)
    return float(m.group(1)) if m else None

def extract_copy_count(text):
    t=low(text)
    pats=[
        rf"({NUMBER_PHRASE})\s*(?:تایی|تا|بار|copies|نسخه|کپی)\b",
        rf"(?:pattern|الگو).*?({NUMBER_PHRASE})\s*(?:تایی|تا|copies|نسخه)\b",
        rf"\bcount\s+({NUMBER_PHRASE})\b",
        rf"(?:تعداد)\s+({NUMBER_PHRASE})\b",
    ]
    for p in pats:
        m=re.search(p,t)
        if m:
            n=parse_spoken_number(m.group(1))
            if n is not None and float(n).is_integer(): return int(n)
    return None

def accept(op,args,provenance):
    return {"accepted":True,"reason":"ok","compiled":{"route":"do","op":op,"args":args},"provenance":provenance}

def reject(reason):
    route="think" if reason=="design-escalation" else "ask"
    return {"accepted":False,"reason":reason,"compiled":{"route":route,"op":None,"args":{}}}

def model_items(cases):
    items=[]
    for c in cases:
        ev=extract_evidence(c["text"],c.get("ctx",{}))
        compact={k:v for k,v in ev.items() if k not in {"feature_parameters","last_move"}}
        compact["feature_parameters"]=ev.get("feature_parameters")
        compact["last_move"]=ev.get("last_move")
        items.append({"id":c["id"],"command":ev.get("core_text") or ev["text"],"evidence":compact})
    return items

def call_model_batch(key,cases):
    meanings=json.dumps(INTENTS,ensure_ascii=False,separators=(",",":"))
    system=(
        "You are a Persian/mixed-language semantic planner for Onshape. "
        "Choose only the user's semantic intent; never invent targets, numbers, names, colors, geometry, or state. "
        "All material values/targets will be derived later from deterministic evidence. "
        "If the sentence requests open-ended design/engineering judgment use d='t'. "
        "If unsupported, ambiguous, missing required information, or more than one independent action/effect is requested use d='q'. "
        "Otherwise use d='a' and choose exactly one intent from the provided intent set. "
        "Return JSON only: {\"r\":[{\"id\":\"...\",\"d\":\"a|q|t\",\"i\":\"intent-or-null\"}]}. "
        "Intent meanings: "+meanings
    )
    body={
        "model":MODEL,
        "messages":[{"role":"system","content":system},
                    {"role":"user","content":json.dumps({"items":model_items(cases)},ensure_ascii=False,separators=(",",":"))}],
        "reasoning_effort":"low","temperature":0,
        "max_completion_tokens":max(300,55*len(cases)),
        "response_format":{"type":"json_object"},
    }
    payload=json.dumps(body,ensure_ascii=False).encode("utf-8")
    last=None
    for attempt in range(MAX_BATCH_RETRIES):
        req=urllib.request.Request(ENDPOINT,data=payload,
            headers={"Authorization":"Bearer "+key,"Content-Type":"application/json",
                     "User-Agent":"cf-exec-plane-onshape-evidence-v06/1.0"},method="POST")
        t0=time.perf_counter()
        try:
            with urllib.request.urlopen(req,timeout=90) as resp:
                data=json.loads(resp.read().decode("utf-8"))
                obj=json.loads(data["choices"][0]["message"]["content"])
                return {"ok":True,"latency_ms":(time.perf_counter()-t0)*1000,
                        "results":obj.get("r",[]),"usage":data.get("usage",{}),"attempts":attempt+1}
        except urllib.error.HTTPError as e:
            txt=e.read().decode("utf-8","replace")
            last={"ok":False,"status":e.code,"error":f"HTTP {e.code}: {txt[:700]}"}
            if e.code not in {400,429,500,502,503,504}: return last
            wait=e.headers.get("retry-after")
            try: wait=float(wait)+0.5 if wait else 10*(attempt+1)
            except Exception: wait=10*(attempt+1)
            time.sleep(min(max(wait,3),120))
        except Exception as e:
            last={"ok":False,"error":repr(e)}
            time.sleep(min(10*(attempt+1),45))
    return last or {"ok":False,"error":"batch-failed"}

def plan_case(case, model_choice=None):
    ev=extract_evidence(case["text"],case.get("ctx",{}))
    d,i=direct_intent(case,ev)
    source="evidence_reflex"
    if d is None:
        if not model_choice:
            return None
        d=model_choice.get("d")
        i=model_choice.get("i") if d=="a" else None
        source="model_intent"
    if d not in {"a","q","t","act","ask","think"}:
        d="q"
    decision={"a":"act","q":"ask","t":"think"}.get(d,d)
    post=compile_intent(case,decision,i,ev)
    post=enforce_evidence_consumption(post,ev)
    return {"case":case,"source":source,"decision":decision,"intent":i,"evidence":ev,"post":post}

def semantic_equivalence_options(expected):
    # Equivalent implementation routes for part-name metadata.
    out=[expected]
    if expected.get("route")=="do" and expected.get("args",{}).get("property")=="name":
        op=expected.get("op")
        if op=="metadata.property.set":
            x=json.loads(json.dumps(expected)); x["op"]="documented.updateWVEPMetadata"; out.append(x)
        elif op=="documented.updateWVEPMetadata":
            x=json.loads(json.dumps(expected)); x["op"]="metadata.property.set"; out.append(x)
    return out

def norm_scalar(v):
    if isinstance(v,str): return low(v)
    return v

def subset_match(expected, got):
    if isinstance(expected,dict):
        return isinstance(got,dict) and all(k in got and subset_match(v,got[k]) for k,v in expected.items())
    if isinstance(expected,list):
        return isinstance(got,list) and len(got)>=len(expected) and all(subset_match(v,got[i]) for i,v in enumerate(expected))
    return norm_scalar(expected)==norm_scalar(got)

def expected_match(case, compiled):
    for e in case["expected"]:
        for exp in semantic_equivalence_options(e):
            if subset_match(exp,compiled): return True
    return False

MATERIAL_OPS={
    "feature.from_selection","feature.parameter.set","feature.patch","feature.delete","feature.delete_part",
    "feature.add","feature.reorder","part.visibility","metadata.property.set","rollback.set",
    "documented.createPartStudio","documented.updateDocumentAttributes","documented.updateWVEPMetadata",
}
REVERSIBLE_OPS={"view.move","view.fit","view.standard","viewer.selection.clear","viewer.inspect","view.follow"}

def classify(case, post):
    compiled=post["compiled"]
    if expected_match(case,compiled): return "correct"
    routes={x.get("route") for x in case["expected"]}
    if post["accepted"] and routes <= {"ask","think"}: return "false_execute"
    if "do" in routes and not post["accepted"]: return "conservative_escalation"
    if post["accepted"] and compiled.get("op") in MATERIAL_OPS: return "wrong_material_accepted"
    if post["accepted"] and compiled.get("op") in REVERSIBLE_OPS: return "wrong_reversible_accepted"
    return "route_mismatch"

def run_suite(cases, key):
    started=time.perf_counter()
    rows_by_id={}
    fallback=[]
    for c in cases:
        row=plan_case(c)
        if row is None: fallback.append(c)
        else:
            row["outcome"]=classify(c,row["post"])
            rows_by_id[c["id"]]=row

    usage={"prompt_tokens":0,"completion_tokens":0}
    model_lats=[]
    calls=0; retries=0
    for start in range(0,len(fallback),BATCH_SIZE):
        batch=fallback[start:start+BATCH_SIZE]
        res=call_model_batch(key,batch)
        calls+=1
        if not res.get("ok"):
            for c in batch:
                post=reject("api-failure")
                row={"case":c,"source":"model_intent","decision":"ask","intent":None,
                     "evidence":extract_evidence(c["text"],c.get("ctx",{})),"post":post,"error":res.get("error")}
                row["outcome"]="api_failure"
                rows_by_id[c["id"]]=row
            continue
        retries+=max(0,res.get("attempts",1)-1)
        usage["prompt_tokens"]+=res.get("usage",{}).get("prompt_tokens") or 0
        usage["completion_tokens"]+=res.get("usage",{}).get("completion_tokens") or 0
        model_lats.append(res.get("latency_ms",0))
        byid={x.get("id"):x for x in res.get("results",[]) if isinstance(x,dict)}
        for c in batch:
            choice=byid.get(c["id"],{"d":"q","i":None})
            row=plan_case(c,choice)
            row["model_choice"]=choice
            row["model_latency_ms"]=res.get("latency_ms",0)
            row["outcome"]=classify(c,row["post"])
            rows_by_id[c["id"]]=row

    rows=[rows_by_id[c["id"]] for c in cases]
    outcomes={}
    for r in rows: outcomes[r["outcome"]]=outcomes.get(r["outcome"],0)+1
    material=[r for r in rows if r["outcome"]=="wrong_material_accepted"]
    falsex=[r for r in rows if r["outcome"]=="false_execute"]
    routine=[r for r in rows if any(e.get("route")=="do" for e in r["case"]["expected"])]
    summary={
        "architecture":"evidence extraction -> deterministic reflex or intent-only 20B -> provenance compiler/residue guard",
        "model":MODEL,
        "cases":len(rows),
        "evidence_reflex_cases":sum(r["source"]=="evidence_reflex" for r in rows),
        "model_intent_cases":sum(r["source"]=="model_intent" for r in rows),
        "model_batch_calls":calls,
        "model_batch_retries":retries,
        "exact_correct":sum(r["outcome"]=="correct" for r in rows),
        "exact_accuracy":sum(r["outcome"]=="correct" for r in rows)/len(rows),
        "wrong_material_accepted":len(material),
        "wrong_material_ids":[r["case"]["id"] for r in material],
        "false_execute":len(falsex),
        "false_execute_ids":[r["case"]["id"] for r in falsex],
        "wrong_reversible_accepted":sum(r["outcome"]=="wrong_reversible_accepted" for r in rows),
        "conservative_escalations":sum(r["outcome"]=="conservative_escalation" for r in rows),
        "route_mismatch":sum(r["outcome"]=="route_mismatch" for r in rows),
        "api_failures":sum(r["outcome"]=="api_failure" for r in rows),
        "routine_expected_do":len(routine),
        "routine_auto_accepted":sum(r["post"]["accepted"] for r in routine),
        "routine_correct":sum(r["outcome"]=="correct" for r in routine),
        "provider_prompt_tokens":usage["prompt_tokens"],
        "provider_completion_tokens":usage["completion_tokens"],
        "model_batch_p50_ms":statistics.median(model_lats) if model_lats else None,
        "model_batch_p95_ms":sorted(model_lats)[max(0,min(len(model_lats)-1,round((len(model_lats)-1)*.95)))] if model_lats else None,
        "wall_seconds":time.perf_counter()-started,
        "outcomes":outcomes,
    }
    return rows,summary
