from __future__ import annotations

import json
import os
import re
import statistics
import time
import urllib.error
import urllib.request

MODEL = "openai/gpt-oss-20b"
ENDPOINT = "https://api.groq.com/openai/v1/chat/completions"
MAX_BATCH_RETRIES = int(os.environ.get("MAX_BATCH_RETRIES", "8"))

INTENTS = {
    "camera_move": "orbit, pan or zoom the camera",
    "fit": "fit the whole view or current selection",
    "top_view": "show exact Top standard view",
    "clear_selection": "clear current viewer selection",
    "inspect": "read viewer selection/state/collaboration",
    "follow": "follow another collaborator",
    "edge_on_selection": "fillet/chamfer the CURRENT selection",
    "feature_parameter": "edit one parameter of an EXISTING feature",
    "feature_suppressed": "suppress/unsuppress an existing feature",
    "feature_rename": "rename an existing feature",
    "feature_delete": "delete an existing feature",
    "part_delete": "delete an existing part/body",
    "part_visibility": "hide/show an existing part",
    "part_property": "set one part property: color/material/description/name",
    "add_plane": "create a new plane",
    "add_pattern": "create a linear pattern",
    "add_edge_feature": "create a NEW/EMPTY fillet/chamfer feature",
    "feature_reorder": "move one feature before/after another",
    "rollback": "move rollback position",
    "create_part_studio": "create a new Part Studio",
    "rename_document": "rename the document",
}

MATERIAL_OPS = {
    "feature.from_selection", "feature.parameter.set", "feature.patch", "feature.delete",
    "feature.delete_part", "feature.add", "feature.reorder", "part.visibility",
    "metadata.property.set", "rollback.set", "documented.createPartStudio",
    "documented.updateDocumentAttributes", "documented.updateWVEPMetadata",
}
REVERSIBLE_OPS = {
    "view.move", "view.fit", "view.standard", "viewer.selection.clear",
    "viewer.inspect", "view.follow",
}

PERSIAN_DIGITS = str.maketrans(
    "۰۱۲۳۴۵۶۷۸۹٠١٢٣٤٥٦٧٨٩",
    "01234567890123456789",
)
CHAR_REPL = str.maketrans({"ي": "ی", "ك": "ک", "ۀ": "ه", "ة": "ه"})

ONES = {
    "صفر": 0, "یک": 1, "يه": 1, "یه": 1, "دو": 2, "سه": 3, "چهار": 4,
    "پنج": 5, "شش": 6, "هفت": 7, "هشت": 8, "نه": 9, "ده": 10,
    "یازده": 11, "دوازده": 12, "سیزده": 13, "چهارده": 14, "پانزده": 15,
    "شانزده": 16, "هفده": 17, "هجده": 18, "نوزده": 19,
}
TENS = {
    "بیست": 20, "سی": 30, "چهل": 40, "پنجاه": 50,
    "شصت": 60, "هفتاد": 70, "هشتاد": 80, "نود": 90,
}
HUNDREDS = {
    "صد": 100, "یکصد": 100, "دویست": 200, "سیصد": 300, "چهارصد": 400,
    "پانصد": 500, "ششصد": 600, "هفتصد": 700, "هشتصد": 800, "نهصد": 900,
}
COLOR_MAP = {
    "قرمز": "red", "آبی": "blue", "ابي": "blue", "سبز": "green",
    "مشکی": "black", "سیاه": "black", "سفید": "white",
    "خاکستری": "gray", "طوسی": "gray", "زرد": "yellow",
    "red": "red", "blue": "blue", "green": "green", "black": "black",
    "white": "white", "gray": "gray", "grey": "gray", "yellow": "yellow",
}
MATERIAL_MAP = {
    "فولاد": "Steel", "استیل": "Steel", "آلومینیوم": "Aluminum",
    "الومینیوم": "Aluminum", "aluminum": "Aluminum", "steel": "Steel",
}

def norm_text(text: str) -> str:
    t = str(text).translate(PERSIAN_DIGITS).translate(CHAR_REPL).replace("\u200c", " ")
    t = re.sub(r"\s+", " ", t).strip()
    return t

def low(text: str) -> str:
    return norm_text(text).lower()

def has_any(text: str, terms) -> bool:
    return any(x in text for x in terms)

def _fmt_num(v: float) -> str:
    if abs(v - round(v)) < 1e-9:
        return str(int(round(v)))
    return f"{v:.8f}".rstrip("0").rstrip(".")

def parse_integer_words(phrase: str):
    p = norm_text(phrase).strip(" ،,.؛;")
    if re.fullmatch(r"[+-]?\d+", p):
        return int(p)
    if not p:
        return None
    parts = [x.strip() for x in p.split(" و ") if x.strip()]
    if not parts:
        return None
    total = 0
    for part in parts:
        if part in ONES:
            total += ONES[part]
        elif part in TENS:
            total += TENS[part]
        elif part in HUNDREDS:
            total += HUNDREDS[part]
        else:
            return None
    return total

def parse_number_phrase(phrase: str):
    p = norm_text(phrase).lower().strip(" ،,.؛;")
    if not p:
        return None
    m = re.fullmatch(r"[+-]?\d+(?:[.,]\d+)?", p)
    if m:
        return float(p.replace(",", "."))
    if p == "نیم":
        return 0.5
    if p == "ربع":
        return 0.25
    if p.endswith(" و ربع"):
        base = parse_integer_words(p[:-7])
        return None if base is None else base + 0.25
    if p.endswith(" ربع"):
        n = parse_integer_words(p[:-4])
        if n is not None and 0 <= n <= 4:
            return n / 4.0

    if p.endswith(" و نیم"):
        base = parse_integer_words(p[:-6])
        return None if base is None else base + 0.5

    if p.endswith(" دهم"):
        core = p[:-4].strip()
        # "یک و پنج دهم" => 1.5. Otherwise "هشت دهم" => 0.8.
        bits = core.split(" و ")
        if len(bits) >= 2:
            for cut in range(1, len(bits)):
                left = parse_integer_words(" و ".join(bits[:cut]))
                right = parse_integer_words(" و ".join(bits[cut:]))
                if left is not None and right is not None and 0 <= right < 10:
                    return left + right / 10.0
        n = parse_integer_words(core)
        return None if n is None else n / 10.0

    if p.endswith(" صدم"):
        core = p[:-4].strip()
        bits = core.split(" و ")
        if len(bits) >= 2:
            # Prefer the earliest split whose fractional side is <100.
            for cut in range(1, len(bits)):
                left = parse_integer_words(" و ".join(bits[:cut]))
                right = parse_integer_words(" و ".join(bits[cut:]))
                if left is not None and right is not None and 0 <= right < 100:
                    return left + right / 100.0
        n = parse_integer_words(core)
        return None if n is None else n / 100.0

    return parse_integer_words(p)

def _word_quantity_before_unit(t: str, unit_start: int):
    prefix = t[:unit_start].rstrip()
    tokens = prefix.split()
    best = None
    for n in range(1, min(8, len(tokens)) + 1):
        phrase = " ".join(tokens[-n:])
        val = parse_number_phrase(phrase)
        if val is not None:
            best = (val, phrase)
    return best

def extract_quantities(text: str):
    t = low(text)
    found = []
    unit_re = re.compile(r"(?:mm|میلی\s*متر|میلیمتر|میلی|میل|deg|درجه)\b", re.I)
    for m in unit_re.finditer(t):
        unit = "deg" if m.group(0).lower() in {"deg", "درجه"} else "mm"
        before = _word_quantity_before_unit(t, m.start())
        if before is None:
            continue
        val, phrase = before
        found.append({
            "value": f"{_fmt_num(float(val))} {unit}",
            "surface": f"{phrase} {m.group(0)}",
            "end": m.end(),
        })

    # Quarter/half-turn camera magnitude.
    if "ربع دور" in t:
        found.append({"value": "90 deg", "surface": "ربع دور", "end": t.index("ربع دور") + len("ربع دور")})
    if "نیم دور" in t:
        found.append({"value": "180 deg", "surface": "نیم دور", "end": t.index("نیم دور") + len("نیم دور")})
    if "سه ربع دور" in t:
        found.append({"value": "270 deg", "surface": "سه ربع دور", "end": t.index("سه ربع دور") + len("سه ربع دور")})

    dedup = []
    seen = set()
    for x in found:
        key = (x["value"], x["end"])
        if key not in seen:
            seen.add(key)
            dedup.append(x)
    return dedup

def _feature_name(kind: str, n: int) -> str:
    k = kind.lower()
    mp = {
        "فیلت": "Fillet", "fillet": "Fillet",
        "اکسترود": "Extrude", "extrude": "Extrude",
        "درفت": "Draft", "draft": "Draft",
        "اسکچ": "Sketch", "sketch": "Sketch",
    }
    return f"{mp[k]} {n}"

def extract_features(text: str):
    t = norm_text(text)
    out = []
    spans = []
    for m in re.finditer(r"\b(Fillet|Extrude|Draft|Sketch)\s*(\d+)\b(?![.,]\d)", t, re.I):
        out.append({"value": f"{m.group(1).title()} {m.group(2)}", "surface": m.group(0), "pos": m.start()})
        spans.append(m.span())
    for m in re.finditer(r"(فیلت|اکسترود|درفت|اسکچ)\s+([^\s،,.؛;]+(?:\s+و\s+[^\s،,.؛;]+)?)", t, re.I):
        phrase = m.group(2)
        # Strip a common Persian object marker if the simple regex captured it.
        phrase = re.sub(r"\s+(?:رو|را)$", "", phrase).strip()
        n = parse_integer_words(phrase)
        after_raw = t[m.end():]
        after = after_raw.lstrip()
        if n is not None and not re.match(r"^[.,]\d", after_raw) and not re.match(r"^(?:mm|میلی\s*متر|میلیمتر|میلی|میل|deg|درجه)\b", after, re.I):
            out.append({"value": _feature_name(m.group(1), n), "surface": m.group(0), "pos": m.start()})
    dedup = []
    seen = set()
    for x in sorted(out, key=lambda z: z["pos"]):
        if x["value"] not in seen:
            seen.add(x["value"])
            dedup.append(x)
    return dedup

def extract_parts(text: str):
    t = norm_text(text)
    out = []
    for m in re.finditer(r"\bPart\s*(\d+)\b", t, re.I):
        out.append({"value": f"Part {m.group(1)}", "surface": m.group(0), "pos": m.start()})
    for m in re.finditer(r"پارت\s+([^\s،,.؛;]+(?:\s+و\s+[^\s،,.؛;]+)?)", t, re.I):
        phrase = re.sub(r"\s+(?:رو|را)$", "", m.group(1)).strip()
        n = parse_integer_words(phrase)
        if n is not None:
            out.append({"value": f"Part {n}", "surface": m.group(0), "pos": m.start()})

    # Named-part positions: grammar around a capital/identifier token.
    pats = [
        r"\b([A-Za-z][A-Za-z0-9_.-]*)\s+(?:رو|را)\b",
        r"\b([A-Za-z][A-Za-z0-9_.-]*)\s+(?:رنگش|متریالش|اسمش)\b",
        r"(?:از|برای)\s+([A-Za-z][A-Za-z0-9_.-]*)\b",
        r"(?:رنگ|color)\s+([A-Za-z][A-Za-z0-9_.-]*)\b",
        r"description\s+(?:پارت\s+)?([A-Za-z][A-Za-z0-9_.-]*)\b",
        r"linear\s+pattern\s+([A-Za-z][A-Za-z0-9_.-]*)\b",
    ]
    for pat in pats:
        for m in re.finditer(pat, t, re.I):
            val = m.group(1)
            if val.lower() not in {
                "color", "part", "pattern", "description", "feature", "body", "fillet",
                "extrude", "draft", "sketch", "plane", "document", "viewer", "selection",
                "edge", "face", "studio", "rollback"
            }:
                out.append({"value": val[0].upper() + val[1:] if val.lower() in {"cap", "bracket"} else val,
                            "surface": val, "pos": m.start(1)})

    dedup = []
    seen = set()
    for x in sorted(out, key=lambda z: z["pos"]):
        if x["value"].lower() not in seen:
            seen.add(x["value"].lower())
            dedup.append(x)
    return dedup

def extract_name_tail(text: str):
    s = norm_text(text)
    patterns = [
        r"(?:عوض\s+کن\s+به|rename\s+کن\s+به)\s+(.+)$",
        r"(?:بذار|بگذار)\s+(.+)$",
        r"(?:بشه|بشود)\s+(.+)$",
        r"(?:به\s+اسم|اسمش)\s+(.+)$",
        r"\b(?:called|named|to)\s+(.+)$",
    ]
    for pat in patterns:
        m = re.search(pat, s, re.I)
        if m:
            v = m.group(1).strip(" ،,.;؛")
            v = re.sub(r"\s+(?:بساز|درست\s+کن|ایجاد\s+کن)$", "", v, flags=re.I).strip()
            if v:
                return v
    return None

def extract_count(text: str):
    t = low(text)
    m = re.search(r"\b(\d+)\s*(?:تایی|تا|بار|copies)\b", t)
    if m:
        return int(m.group(1))
    for word, n in {**ONES, **TENS}.items():
        if re.search(rf"\b{re.escape(word)}\s*(?:تایی|تا|بار|copies)\b", t):
            return int(n)
        if re.search(rf"\b{re.escape(word)}تایی\b", t):
            return int(n)
    return None

def extract_candidate_index(text: str):
    t = low(text)
    m = re.search(r"نفر\s*(\d+)", t)
    if m:
        return int(m.group(1))
    mp = {"اول": 1, "اولین": 1, "دوم": 2, "دومی": 2, "سوم": 3, "سومی": 3}
    for w, n in mp.items():
        if f"نفر {w}" in t:
            return n
    bare = {"اولی":1,"دومی":2,"سومی":3,"چهارمی":4}
    for w,n in bare.items():
        if re.search(rf"(?<!\w){re.escape(w)}(?!\w)", t):
            return n
    return None

def extract_relation(text: str):
    t = low(text)
    if has_any(t, ["قبل از", "قبل ", "بالای", "بالاتر از"]):
        return "before"
    if has_any(t, ["بعد از", "بعد ", "زیر ", "پایین تر از", "پایین‌تر از"]):
        return "after"
    return None

def extract_visibility(text: str, ctx: dict):
    t = low(text)
    if has_any(t, ["نشون نده", "نشان نده", "نمایش نده", "show نده", "دیگه نشون نده", "دیده نشه", "دیده نشود"]):
        return False
    if has_any(t, ["مخفی", "قایم", "پنهان", "hide"]):
        return False
    if has_any(t, ["نشون بده", "نشان بده", "نشونش بده", "نشانش بده", "نمایش بده", "show"]):
        return True
    if has_any(t, ["دوباره بیار", "دوباره برگردونش", "بیارش", "برگردون توی دید", "برگردون تو دید"]) and ctx.get("last_part"):
        return True
    return None

def extract_suppressed(text: str, ctx: dict):
    t = low(text)
    if has_any(t, ["روشن", "unsuppress"]):
        return False
    if "خاموش" in t or re.search(r"(?<!un)\bsuppress\b", t):
        return True
    if has_any(t, ["برش گردون", "برگردونش", "دوباره برش گردون"]) and ctx.get("last_action") == "suppress":
        return False
    return None

def extract_color(text: str):
    t = low(text)
    for k, v in COLOR_MAP.items():
        if re.search(rf"(?<!\w){re.escape(k)}(?!\w)", t, re.I):
            return v
    return None

def extract_material(text: str):
    t = low(text)
    for k, v in MATERIAL_MAP.items():
        if re.search(rf"(?<!\w){re.escape(k)}(?!\w)", t, re.I):
            return v
    m = re.search(r"(?:متریال|material).*?(?:رو|را|=|to)\s*([A-Za-z][A-Za-z0-9 _.-]*?)(?:\s+(?:بذار|بگذار|کن)|$)", norm_text(text), re.I)
    if m:
        return m.group(1).strip()
    return None

def extract_description(text: str):
    s = norm_text(text)
    if "description" not in s.lower():
        return None
    pats = [
        r"description.*?(?:بذار|بگذار)\s+(.+)$",
        r"description.*?(?:=|to)\s*(.+)$",
    ]
    for pat in pats:
        m = re.search(pat, s, re.I)
        if m:
            return m.group(1).strip(" ،,.;")
    return None

def is_design_language(text: str):
    t = low(text)
    terms = [
        "حرفه ای", "حرفه‌ای", "خوشگل", "پریمیوم", "طراحی بهتر", "بهینه",
        "قوی تر", "قوی‌تر", "استحکام", "سبک تر", "سبک‌تر", "تزریق پلاستیک",
        "اضافی", "تولیدش راحت", "تولیدش ساده", "وزنشو کم", "وزنش رو کم",
        "سفت بمونه", "زیباتر", "بهترش کن", "طراحی رو درست", "طراحی را درست",
        "تولید راحت", "تولیدش راحت", "قالب گیری", "به درد نمی", "هرچی اضافه",
        "اضافه ست", "اضافه است",
    ]
    return has_any(t, terms)

def is_unsupported(text: str):
    t = low(text)
    return has_any(t, [
        "public", "share", "pdf", "export", " step ", "step بگیر", "mate",
        "شرکت onshape", "company", "ایزو", "ایزومتریک", "نمای روبرو", "front view",
        "mirror", "سوراخ", "hole",
    ])

def is_global_destructive(text: str):
    t = low(text)
    return has_any(t, ["کل مدل رو حذف", "همه رو پاک", "همه را پاک", "همه چی رو پاک", "همه چیز رو پاک"])

def action_signature(text: str, ctx: dict):
    t = low(text)
    sig = []
    # Edge operations count as actions only when used operationally, not as a named feature entity.
    named_feature = bool(extract_features(text))
    if has_any(t, ["فیلت", "fillet", "فیلِت"]) and (ctx.get("selection_count", 0) > 0 or has_any(t, ["همین", "این دوتا", "لبه"])) and not named_feature:
        sig.append("edge:fillet")
    if has_any(t, ["پخ", "چمفر", "chamfer"]) and (ctx.get("selection_count", 0) > 0 or has_any(t, ["همین", "این دوتا", "لبه"])):
        sig.append("edge:chamfer")
    if extract_color(text) is not None:
        sig.append("part:color")
    if extract_material(text) is not None:
        sig.append("part:material")
    if extract_visibility(text, ctx) is not None:
        sig.append("part:visibility")
    # Keep unique order.
    out = []
    for x in sig:
        if x not in out:
            out.append(x)
    return out

def build_evidence(text: str, ctx: dict | None = None):
    ctx = dict(ctx or {})
    t = low(text)
    items = []
    counters = {}

    def add(kind, value, source="text", surface=None, meta=None):
        counters[kind] = counters.get(kind, 0) + 1
        prefix = {
            "quantity": "q", "feature": "f", "part": "p", "name": "n",
            "relation": "r", "state": "s", "color": "c", "material": "m",
            "description": "d", "count": "k", "direction": "v", "action": "a",
            "angle": "g",
        }.get(kind, kind[:1])
        item = {
            "id": f"{prefix}{counters[kind]}",
            "kind": kind,
            "value": value,
            "source": source,
        }
        if surface is not None:
            item["surface"] = surface
        if meta:
            item["meta"] = meta
        items.append(item)
        return item

    for q in extract_quantities(text):
        add("quantity", q["value"], "text", q["surface"])
    for f in extract_features(text):
        add("feature", f["value"], "text", f["surface"], {"pos": f["pos"]})
    for p in extract_parts(text):
        add("part", p["value"], "text", p["surface"], {"pos": p["pos"]})

    if ctx.get("last_feature"):
        add("feature", ctx["last_feature"], "context", "last_feature")
    if ctx.get("last_part"):
        add("part", ctx["last_part"], "context", "last_part")

    rel = extract_relation(text)
    if rel:
        add("relation", rel, "text")
    vis = extract_visibility(text, ctx)
    if vis is not None:
        add("state", {"kind": "visible", "value": vis}, "text")
    sup = extract_suppressed(text, ctx)
    if sup is not None:
        add("state", {"kind": "suppressed", "value": sup}, "text")
    color = extract_color(text)
    if color is not None:
        add("color", color, "text")
    material = extract_material(text)
    if material is not None:
        add("material", material, "text")
    desc = extract_description(text)
    if desc is not None:
        add("description", desc, "text")
    name = extract_name_tail(text)
    if name is not None:
        add("name", name, "text")
    count = extract_count(text)
    if count is not None:
        add("count", count, "text")

    # Camera evidence.
    action = None
    direction = None
    if has_any(t, ["نزدیک تر", "نزدیک‌تر"]):
        action = "zoom"
        direction = "in"
    elif has_any(t, ["دورتر"]):
        action = "zoom"
        direction = "out"
    elif has_any(t, ["زوم", "zoom"]):
        action = "zoom"
    elif has_any(t, ["pan", "پن ", "نما رو", "صفحه رو", "هل بده"]):
        action = "pan"
    elif has_any(t, ["بچرخ", "rotate", "ساعتگرد", "پادساعتگرد"]) or (has_any(t, ["مدل", "مدلو"]) and has_any(t, ["راست", "چپ", "بالا", "پایین"])):
        action = "orbit"

    if "پادساعتگرد" in t:
        direction = "counterclockwise"
    elif "ساعتگرد" in t:
        direction = "clockwise"
    elif has_any(t, ["سمت راست", "به راست", "طرف راست", "راست"]) or re.search(r"\bright\b", t):
        direction = "right"
    elif has_any(t, ["سمت چپ", "به چپ", "طرف چپ", "چپ"]) or re.search(r"\bleft\b", t):
        direction = "left"
    elif has_any(t, ["بالا", "رو به بالا"]) or re.search(r"\bup\b", t):
        direction = "up"
    elif has_any(t, ["پایین", "رو به پایین"]) or re.search(r"\bdown\b", t):
        direction = "down"

    last_move = ctx.get("last_move") or {}
    correction = has_any(t, ["زیادی شد", "برش گردون", "برگرد", "برگردون"])
    more = has_any(t, ["بیشتر", "یه ذره همون طرف", "همون طرف", "باز یه ذره", "همونجوری", "همون جوری", "یه ذره دیگه"])
    if last_move and correction and ctx.get("last_action") != "suppress":
        opp = {
            "left": "right", "right": "left", "up": "down", "down": "up",
            "in": "out", "out": "in", "clockwise": "counterclockwise",
            "counterclockwise": "clockwise",
        }
        action = last_move.get("action")
        direction = opp.get(last_move.get("direction"))
    elif last_move and more and direction is None:
        if action is None or action == last_move.get("action"):
            action = last_move.get("action")
            direction = last_move.get("direction")

    if last_move and has_any(t, ["عقب تر", "عقب‌تر", "عقب برو"]) and last_move.get("action") == "zoom":
        action = "zoom"
        direction = "out"

    if action == "zoom" and direction not in {"in", "out"}:
        if t.strip() in {"زوم", "zoom"} and ctx.get("interaction_mode") == "camera":
            direction = "in"
        elif has_any(t, ["اوت", "out", "بیرون", "عقب"]):
            direction = "out"
        elif has_any(t, ["داخل", "in", "بیشتر"]):
            direction = "in"

    if action:
        add("action", action, "text_or_context")
    if direction:
        add("direction", direction, "text_or_context")
    angles = [x for x in items if x["kind"] == "quantity" and str(x["value"]).endswith(" deg")]
    if angles:
        try:
            add("angle", float(str(angles[0]["value"]).split()[0]), angles[0]["source"], angles[0].get("surface"))
        except Exception:
            pass

    relative = None
    if has_any(t, ["بیشتر", "زیادش کن", "اضافه کن"]):
        relative = "add"
    if has_any(t, ["کمتر", "کم کن", "کمترش کن"]):
        relative = "subtract"

    sig = action_signature(text, ctx)
    multi_action = len(sig) > 1
    if " و بعد " in t and len(sig) >= 1:
        multi_action = True

    return {
        "text": norm_text(text),
        "low": t,
        "ctx": ctx,
        "items": items,
        "selection_count": int(ctx.get("selection_count", 0) or 0),
        "selection_types": list(ctx.get("selection_types", []) or []),
        "candidate_index": extract_candidate_index(text),
        "relative": relative,
        "action_signature": sig,
        "multi_action": multi_action,
        "design": is_design_language(text),
        "unsupported": is_unsupported(text),
        "global_destructive": is_global_destructive(text),
    }

def items(ev, kind, source=None):
    xs = [x for x in ev["items"] if x["kind"] == kind]
    if source is not None:
        xs = [x for x in xs if x["source"] == source]
    return xs

def unique_item(ev, kind, prefer_text=True):
    xs = items(ev, kind)
    if prefer_text:
        tx = [x for x in xs if x["source"] == "text"]
        if len(tx) == 1:
            return tx[0]
        if len(tx) > 1:
            return None
    if len(xs) == 1:
        return xs[0]
    # If one text and one context are the same value, text wins.
    if xs:
        vals = {json.dumps(x["value"], sort_keys=True, ensure_ascii=False) for x in xs}
        if len(vals) == 1:
            return xs[0]
    return None

def text_item(ev, kind):
    xs = items(ev, kind, "text")
    return xs[0] if len(xs) == 1 else None

def context_item(ev, kind):
    xs = items(ev, kind, "context")
    return xs[0] if len(xs) == 1 else None

def _mm(v):
    if not isinstance(v, str):
        return None
    m = re.fullmatch(r"([+-]?\d+(?:\.\d+)?) mm", v.strip())
    return float(m.group(1)) if m else None

def _canonical_param(feature, ev):
    t = ev["low"]
    if has_any(t, ["شعاع", "radius"]) or (feature and str(feature).lower().startswith("fillet")):
        return "radius"
    if has_any(t, ["عمق", "depth"]):
        return "depth"
    if has_any(t, ["زاویه", "angle"]):
        return "angle"
    if "flip direction" in t:
        return "flip direction"
    return None

def _feature_for_mutation(ev):
    tx = items(ev, "feature", "text")
    if len(tx) == 1:
        return tx[0]
    cx = items(ev, "feature", "context")
    if not tx and len(cx) == 1:
        return cx[0]
    return None

def _part_for_mutation(ev):
    tx = items(ev, "part", "text")
    if len(tx) == 1:
        return tx[0]
    cx = items(ev, "part", "context")
    if not tx and len(cx) == 1:
        return cx[0]
    return None

def _edge_kind(ev):
    t = ev["low"]
    f = has_any(t, ["فیلت", "fillet", "فیلِت"])
    c = has_any(t, ["پخ", "چمفر", "chamfer"])
    if f and c:
        return None
    if c:
        return "chamfer"
    if f:
        return "fillet"
    return None

def _has_new_edge_cue(ev):
    return has_any(ev["low"], ["جدید", "خالی", "new", "empty", "بدون انتخاب", "فعلاً بدون"])

def _is_delete(ev):
    return has_any(ev["low"], ["حذف کن", "حذفش کن", "پاک کن", "پاکش کن", "بنداز دور", "delete", "remove"])

def _name_cue(ev):
    return has_any(ev["low"], ["اسم", "rename"])

def _plane_cue(ev):
    return has_any(ev["low"], ["plane", "صفحه مرجع"])

def _pattern_cue(ev):
    return has_any(ev["low"], ["pattern", "الگو", "خطی تکرار"])

def _part_studio_cue(ev):
    return has_any(ev["low"], ["part studio", "پارت استودیو"])

def _document_cue(ev):
    return has_any(ev["low"], ["داکیومنت", "document"])

def _rollback_cue(ev):
    return "rollback" in ev["low"]

def _fit_cue(ev):
    return has_any(ev["low"], ["فیت", "fit", "تو کادر جا", "توی کادر جا", "کادر جا بشه"])

def _clear_selection_cue(ev):
    t = ev["low"]
    return has_any(t, ["انتخاب رو پاک", "انتخاب را پاک", "selection رو خالی", "selection را خالی",
                       "clear selection", "انتخابارو ول کن", "انتخابا رو ول کن"])

def _top_cue(ev):
    return has_any(ev["low"], ["top view", "از بالا"])

def _inspect_cue(ev):
    return has_any(ev["low"], ["چی انتخاب", "وضعیت ویور", "viewer", "سشن", "session", "چند نفر تو این سشن", "select شده"])

def _follow_cue(ev):
    return has_any(ev["low"], ["فالو", "follow"])

def _camera_cue(ev):
    return bool(items(ev, "action")) or bool(ev["ctx"].get("last_move") and has_any(ev["low"], ["بیشتر", "برگرد", "عقب"]))

def _visibility_cue(ev):
    return any(x["kind"] == "state" and x["value"].get("kind") == "visible" for x in ev["items"])

def _suppression_cue(ev):
    return any(x["kind"] == "state" and x["value"].get("kind") == "suppressed" for x in ev["items"])

def reflex_decision(ev):
    """Return (decision, intent_or_none). None means ask the compact model for intent only."""
    if ev["design"]:
        return "think", None
    if ev["unsupported"] or ev["global_destructive"]:
        return "ask", None
    if ev["multi_action"]:
        return "ask", None

    if _clear_selection_cue(ev):
        return "act", "clear_selection"
    if _top_cue(ev):
        return "act", "top_view"
    if _fit_cue(ev):
        return "act", "fit"
    if _follow_cue(ev):
        return "act", "follow"
    if _inspect_cue(ev):
        return "act", "inspect"
    if _camera_cue(ev):
        return "act", "camera_move"

    if _rollback_cue(ev):
        return "act", "rollback"
    if _part_studio_cue(ev):
        return "act", "create_part_studio"
    if _document_cue(ev) and _name_cue(ev):
        return "act", "rename_document"

    feats_text = items(ev, "feature", "text")
    parts_text = items(ev, "part", "text")
    if _is_delete(ev) and has_any(ev["low"], ["آخرین فیچر", "آخرین فیچرو", "اولین فیچر", "اولین فیچرو", "آخرین feature", "اولین feature"]):
        return "act", "feature_delete"
    if items(ev, "relation") and (len(feats_text) >= 2 or (len(feats_text) == 1 and context_item(ev, "feature"))):
        return "act", "feature_reorder"

    if _pattern_cue(ev):
        return "act", "add_pattern"
    if _plane_cue(ev):
        return "act", "add_plane"

    edge_kind = _edge_kind(ev)
    if edge_kind and _has_new_edge_cue(ev):
        return "act", "add_edge_feature"

    if feats_text or context_item(ev, "feature"):
        if _is_delete(ev):
            return "act", "feature_delete"
        if _name_cue(ev):
            return "act", "feature_rename"
        if has_any(ev["low"], ["شعاع", "عمق", "depth", "زاویه", "angle", "flip direction"]) or ev["relative"]:
            return "act", "feature_parameter"
        if _suppression_cue(ev):
            return "act", "feature_suppressed"
        if edge_kind:
            return "act", "feature_parameter"

    if parts_text or context_item(ev, "part"):
        if _is_delete(ev):
            return "act", "part_delete"
        if _visibility_cue(ev):
            return "act", "part_visibility"
        if items(ev, "color") or items(ev, "material") or items(ev, "description") or _name_cue(ev):
            return "act", "part_property"

    if edge_kind:
        return "act", "edge_on_selection"

    return None, None

def _state(ev, kind):
    xs = [x for x in items(ev, "state") if x["value"].get("kind") == kind]
    return xs[0] if len(xs) == 1 else None

def _prov(item, extra=None):
    if item is None:
        return None
    p = f"{item['source']}:{item['id']}"
    if extra:
        return [p, extra] if isinstance(extra, str) else [p, *extra]
    return p

def accept(op, args, provenance, intent, model_used=False):
    return {
        "accepted": True,
        "reason": "ok",
        "compiled": {"route": "do", "op": op, "args": args},
        "intent": intent,
        "provenance": provenance,
        "model_used": model_used,
    }

def reject(reason, intent=None, route="ask", model_used=False):
    return {
        "accepted": False,
        "reason": reason,
        "compiled": {"route": route, "op": None, "args": {}},
        "intent": intent,
        "provenance": {},
        "model_used": model_used,
    }

def compile_intent(intent, ev, model_used=False):
    if intent not in INTENTS:
        return reject("intent-not-admitted", intent, model_used=model_used)
    if ev["multi_action"]:
        return reject("multi-action-residue", intent, model_used=model_used)
    if ev["global_destructive"]:
        return reject("global-destructive", intent, model_used=model_used)
    if ev["unsupported"]:
        return reject("unsupported-language", intent, model_used=model_used)
    if ev["design"]:
        return reject("design-needs-reasoning", intent, route="think", model_used=model_used)

    t = ev["low"]
    ctx = ev["ctx"]

    if intent == "camera_move":
        a = unique_item(ev, "action")
        d = unique_item(ev, "direction")
        if not a or not d:
            return reject("camera-evidence-missing", intent, model_used=model_used)
        action, direction = a["value"], d["value"]
        allowed = {
            "orbit": {"left", "right", "up", "down", "clockwise", "counterclockwise"},
            "pan": {"left", "right", "up", "down"},
            "zoom": {"in", "out"},
        }
        if action not in allowed or direction not in allowed[action]:
            return reject("camera-shape", intent, model_used=model_used)
        args = {"action": action, "direction": direction}
        prov = {"action": _prov(a), "direction": _prov(d)}
        ang = unique_item(ev, "angle")
        if ang and action == "orbit":
            args["angle_degrees"] = ang["value"]
            prov["angle_degrees"] = _prov(ang)
        return accept("view.move", args, prov, intent, model_used)

    if intent == "fit":
        selection = has_any(t, ["انتخاب", "selection"])
        if selection and ev["selection_count"] <= 0:
            return reject("fit-selection-ungrounded", intent, model_used=model_used)
        return accept("view.fit", {"action": "fit_selection" if selection else "fit"},
                      {"action": "text:fit-semantics"}, intent, model_used)

    if intent == "top_view":
        return accept("view.standard", {"view": "top"}, {"view": "text:top-semantics"}, intent, model_used)

    if intent == "clear_selection":
        return accept("viewer.selection.clear", {}, {}, intent, model_used)

    if intent == "inspect":
        mode = "state"
        if has_any(t, ["سشن", "session", "چند نفر", "کسایی", "کسانی"]):
            mode = "collaboration"
        elif has_any(t, ["انتخاب", "selection", "چی انتخاب", "select شده"]):
            mode = "selection"
        return accept("viewer.inspect", {"mode": mode}, {"mode": "text:inspect-semantics"}, intent, model_used)

    if intent == "follow":
        idx = ev.get("candidate_index")
        if int(ctx.get("collaborator_count", 0) or 0) >= 3 and idx is None:
            return reject("follow-ambiguous", intent, model_used=model_used)
        args = {} if idx is None else {"candidate_index": idx}
        prov = {} if idx is None else {"candidate_index": "text:candidate-index"}
        return accept("view.follow", args, prov, intent, model_used)

    if intent == "edge_on_selection":
        if ev["selection_count"] <= 0:
            return reject("selection-ungrounded", intent, model_used=model_used)
        kind = _edge_kind(ev)
        q = unique_item(ev, "quantity")
        if not kind or q is None or not str(q["value"]).endswith(" mm"):
            return reject("edge-evidence-missing", intent, model_used=model_used)
        return accept("feature.from_selection",
                      {"feature_type": kind, "amount": q["value"]},
                      {"feature_type": "text:edge-kind", "amount": _prov(q),
                       "selection": "context:selection"},
                      intent, model_used)

    if intent == "feature_parameter":
        f = _feature_for_mutation(ev)
        if not f:
            return reject("feature-ungrounded", intent, model_used=model_used)
        param = _canonical_param(f["value"], ev)
        if not param:
            return reject("feature-parameter-ambiguous", intent, model_used=model_used)

        if param == "flip direction":
            if has_any(t, ["روشن", " on", "true"]):
                val = True
            elif has_any(t, ["خاموش", " off", "false"]):
                val = False
            else:
                return reject("feature-boolean-missing", intent, model_used=model_used)
            return accept("feature.parameter.set",
                          {"feature_name": f["value"], "parameter": param, "value": val},
                          {"feature_name": _prov(f), "parameter": "text:param-semantics",
                           "value": "text:boolean"},
                          intent, model_used)

        q = unique_item(ev, "quantity")
        if ev["relative"]:
            if not q or not str(q["value"]).endswith(" mm"):
                return reject("relative-delta-missing", intent, model_used=model_used)
            current = (ctx.get("feature_parameters") or {}).get(param)
            cm = _mm(current)
            dm = _mm(q["value"])
            if cm is None or dm is None:
                return reject("relative-base-missing", intent, model_used=model_used)
            result = cm + dm if ev["relative"] == "add" else cm - dm
            if result < 0:
                return reject("relative-result-invalid", intent, model_used=model_used)
            value = f"{_fmt_num(result)} mm"
            prov = {
                "feature_name": _prov(f),
                "parameter": "text:param-semantics",
                "amount": [_prov(q), f"context:feature_parameters.{param}", f"deterministic:{ev['relative']}"],
            }
        else:
            if q is None:
                return reject("feature-value-missing", intent, model_used=model_used)
            value = q["value"]
            prov = {
                "feature_name": _prov(f),
                "parameter": "text:param-semantics",
                "amount": _prov(q),
            }
        return accept("feature.parameter.set",
                      {"feature_name": f["value"], "parameter": param, "amount": value},
                      prov, intent, model_used)

    if intent == "feature_suppressed":
        f = _feature_for_mutation(ev)
        s = _state(ev, "suppressed")
        if not f or not s:
            return reject("suppress-evidence-missing", intent, model_used=model_used)
        return accept("feature.patch",
                      {"feature_name": f["value"], "suppressed": s["value"]["value"]},
                      {"feature_name": _prov(f), "suppressed": _prov(s)}, intent, model_used)

    if intent == "feature_rename":
        f = _feature_for_mutation(ev)
        n = unique_item(ev, "name")
        if not f or not n:
            return reject("feature-rename-missing", intent, model_used=model_used)
        return accept("feature.patch",
                      {"feature_name": f["value"], "new_name": n["value"]},
                      {"feature_name": _prov(f), "new_name": _prov(n)}, intent, model_used)

    if intent == "feature_delete":
        if "آخرین" in t:
            return accept("feature.delete", {"position": "last"}, {"position": "text:last"}, intent, model_used)
        if "اولین" in t:
            return accept("feature.delete", {"position": "first"}, {"position": "text:first"}, intent, model_used)
        f = _feature_for_mutation(ev)
        if not f:
            return reject("delete-feature-ungrounded", intent, model_used=model_used)
        return accept("feature.delete", {"feature_name": f["value"]},
                      {"feature_name": _prov(f)}, intent, model_used)

    if intent == "part_delete":
        p = _part_for_mutation(ev)
        if not p:
            return reject("delete-part-ungrounded", intent, model_used=model_used)
        return accept("feature.delete_part", {"part_name": p["value"]},
                      {"part_name": _prov(p)}, intent, model_used)

    if intent == "part_visibility":
        p = _part_for_mutation(ev)
        s = _state(ev, "visible")
        if not p or not s:
            return reject("visibility-evidence-missing", intent, model_used=model_used)
        return accept("part.visibility",
                      {"part_name": p["value"], "visible": s["value"]["value"]},
                      {"part_name": _prov(p), "visible": _prov(s)}, intent, model_used)

    if intent == "part_property":
        p = _part_for_mutation(ev)
        if not p:
            return reject("part-property-target-missing", intent, model_used=model_used)
        c = unique_item(ev, "color")
        m = unique_item(ev, "material")
        d = unique_item(ev, "description")
        n = unique_item(ev, "name")
        candidates = [("color", c), ("material", m), ("description", d)]
        if _name_cue(ev):
            candidates.append(("name", n))
        candidates = [(k, x) for k, x in candidates if x is not None]
        if len(candidates) != 1:
            return reject("part-property-evidence-ambiguous", intent, model_used=model_used)
        prop, item = candidates[0]
        op = "documented.updateWVEPMetadata" if prop == "name" else "metadata.property.set"
        return accept(op,
                      {"part_name": p["value"], "property": prop, "value": item["value"]},
                      {"part_name": _prov(p), "property": "text:property-semantics", "value": _prov(item)},
                      intent, model_used)

    if intent == "add_plane":
        # Reference-plane construction is intentionally not in this compact proof-carrying shape.
        if has_any(t, ["روی right", "روی left", "روی top", "روی front", "on right", "on left", "on top", "on front"]):
            return reject("plane-reference-unsupported-shape", intent, model_used=model_used)
        n = unique_item(ev, "name")
        args = {"feature_type": "plane"}
        prov = {"feature_type": "text:plane"}
        if n:
            args["name"] = n["value"]
            prov["name"] = _prov(n)
        return accept("feature.add", args, prov, intent, model_used)

    if intent == "add_pattern":
        if not _pattern_cue(ev):
            return reject("pattern-intent-not-grounded", intent, model_used=model_used)
        p = _part_for_mutation(ev)
        k = unique_item(ev, "count")
        qs = [x for x in items(ev, "quantity") if str(x["value"]).endswith(" mm")]
        q = qs[0] if len(qs) == 1 else None
        if not p or not k or not q:
            return reject("pattern-evidence-missing", intent, model_used=model_used)
        return accept("feature.add",
                      {"feature_type": "linearPattern", "part_name": p["value"],
                       "copies": k["value"], "distance": q["value"]},
                      {"feature_type": "text:pattern", "part_name": _prov(p),
                       "copies": _prov(k), "distance": _prov(q)}, intent, model_used)

    if intent == "add_edge_feature":
        if not _has_new_edge_cue(ev):
            return reject("new-edge-not-explicit", intent, model_used=model_used)
        kind = _edge_kind(ev)
        q = unique_item(ev, "quantity")
        if not kind or not q or not str(q["value"]).endswith(" mm"):
            return reject("new-edge-evidence-missing", intent, model_used=model_used)
        return accept("feature.add", {"feature_type": kind, "amount": q["value"]},
                      {"feature_type": "text:edge-kind", "amount": _prov(q)}, intent, model_used)

    if intent == "feature_reorder":
        rel = unique_item(ev, "relation")
        tx = items(ev, "feature", "text")
        cx = context_item(ev, "feature")
        if len(tx) >= 2:
            source, target = tx[0], tx[1]
        elif len(tx) == 1 and cx:
            source, target = cx, tx[0]
        else:
            return reject("reorder-features-missing", intent, model_used=model_used)
        if not rel:
            return reject("reorder-relation-missing", intent, model_used=model_used)
        return accept("feature.reorder",
                      {"source_feature": source["value"], "target_feature": target["value"],
                       "placement": rel["value"]},
                      {"source_feature": _prov(source), "target_feature": _prov(target),
                       "placement": _prov(rel)}, intent, model_used)

    if intent == "rollback":
        rel = unique_item(ev, "relation")
        tx = items(ev, "feature", "text")
        if rel and len(tx) == 1:
            key = "before_feature" if rel["value"] == "before" else "after_feature"
            return accept("rollback.set", {key: tx[0]["value"]},
                          {key: _prov(tx[0]), "placement": _prov(rel)}, intent, model_used)
        if "آخر" in t or "ته" in t:
            return accept("rollback.set", {"position": "end"}, {"position": "text:end"}, intent, model_used)
        if "اول" in t:
            return accept("rollback.set", {"position": "start"}, {"position": "text:start"}, intent, model_used)
        return reject("rollback-evidence-missing", intent, model_used=model_used)

    if intent == "create_part_studio":
        n = unique_item(ev, "name")
        if not n:
            return reject("part-studio-name-missing", intent, model_used=model_used)
        return accept("documented.createPartStudio", {"new_name": n["value"]},
                      {"new_name": _prov(n)}, intent, model_used)

    if intent == "rename_document":
        n = unique_item(ev, "name")
        if not n:
            return reject("document-name-missing", intent, model_used=model_used)
        return accept("documented.updateDocumentAttributes", {"new_name": n["value"]},
                      {"new_name": _prov(n)}, intent, model_used)

    return reject("unhandled-intent", intent, model_used=model_used)

def verify_provenance(post):
    if not post.get("accepted"):
        return True, None
    op = post["compiled"].get("op")
    if op not in MATERIAL_OPS:
        return True, None
    prov = post.get("provenance") or {}
    # Any model-origin material field is forbidden. The model in v06 is intent-only,
    # but keep this invariant explicit so later schema changes fail closed.
    for key, source in prov.items():
        vals = source if isinstance(source, list) else [source]
        if any(str(v).startswith("model:") for v in vals):
            return False, f"material-field-from-model:{key}"
    return True, None

def evidence_for_model(ev):
    # Compact typed facts. The model may choose only an intent; it cannot return slots.
    return {
        "cmd": ev["text"],
        "facts": [
            {"id": x["id"], "k": x["kind"], "v": x["value"], "src": x["source"]}
            for x in ev["items"]
        ],
        "ctx_flags": {
            "selection_count": ev["selection_count"],
            "collaborator_count": int(ev["ctx"].get("collaborator_count", 0) or 0),
            "relative": ev["relative"],
        },
    }

def call_intent_batch(key, entries):
    if not entries:
        return {"ok": True, "latency_ms": 0.0, "results": [], "usage": {}, "attempts": 0}
    meanings = INTENTS
    system = (
        "You classify independent colloquial Persian/mixed Onshape commands. "
        "You are NOT allowed to invent or return targets, numbers, names, colors, parameters or slots. "
        "The deterministic compiler owns all effectful values. "
        "Return JSON only: {\"r\":[{\"id\":\"...\",\"d\":\"a|q|t\",\"i\":\"intent-or-null\"}]}. "
        "d=a only when exactly one routine semantic intent is clear; i must be one of the supplied intent names. "
        "d=q for ambiguity, missing information, unsupported requests or multi-action requests. "
        "d=t for open-ended design/engineering judgment. "
        "Never output a slots/s/args/value field. Meanings: "
        + json.dumps(meanings, ensure_ascii=False, separators=(",", ":"))
    )
    user = {"items": [{"id": cid, **evidence_for_model(ev)} for cid, ev in entries]}
    body = {
        "model": MODEL,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": json.dumps(user, ensure_ascii=False, separators=(",", ":"))},
        ],
        "reasoning_effort": "low",
        "temperature": 0,
        "max_completion_tokens": max(240, len(entries) * 48),
        "response_format": {"type": "json_object"},
    }
    payload = json.dumps(body, ensure_ascii=False).encode("utf-8")
    last = None
    for attempt in range(MAX_BATCH_RETRIES):
        req = urllib.request.Request(
            ENDPOINT,
            data=payload,
            headers={
                "Authorization": "Bearer " + key,
                "Content-Type": "application/json",
                "User-Agent": "cf-exec-plane-onshape-evidence-planner-v06/1.0",
            },
            method="POST",
        )
        t0 = time.perf_counter()
        try:
            with urllib.request.urlopen(req, timeout=90) as resp:
                raw = resp.read().decode("utf-8")
                ms = (time.perf_counter() - t0) * 1000
                data = json.loads(raw)
                obj = json.loads(data["choices"][0]["message"]["content"])
                return {
                    "ok": True,
                    "latency_ms": ms,
                    "results": obj.get("r", []),
                    "usage": data.get("usage", {}),
                    "attempts": attempt + 1,
                }
        except urllib.error.HTTPError as e:
            txt = e.read().decode("utf-8", "replace")
            last = {
                "ok": False, "status": e.code,
                "error": f"HTTP {e.code}: {txt[:900]}",
                "latency_ms": (time.perf_counter() - t0) * 1000,
            }
            if e.code not in {400, 429, 500, 502, 503, 504}:
                return last
            ra = e.headers.get("retry-after")
            try:
                wait = float(ra) + 0.5 if ra else 8 * (attempt + 1)
            except Exception:
                wait = 8 * (attempt + 1)
            time.sleep(min(max(wait, 3.0), 90.0))
        except Exception as e:
            last = {
                "ok": False,
                "error": repr(e),
                "latency_ms": (time.perf_counter() - t0) * 1000,
            }
            time.sleep(min(8 * (attempt + 1), 45))
    return last or {"ok": False, "error": "batch-failed"}

def parse_model_decision(obj):
    if not isinstance(obj, dict):
        return "ask", None, "model-shape"
    allowed_keys = {"id", "d", "i"}
    if any(k not in allowed_keys for k in obj):
        return "ask", None, "model-returned-forbidden-fields"
    d = obj.get("d")
    i = obj.get("i")
    if d == "t":
        return "think", None, None
    if d == "q":
        return "ask", None, None
    if d == "a" and isinstance(i, str) and i in INTENTS:
        return "act", i, None
    return "ask", None, "model-shape"

def route_cases(cases, key, batch_size=12):
    rows = {}
    fallback = []

    for case in cases:
        ev = build_evidence(case["text"], case.get("ctx", {}))
        decision, intent = reflex_decision(ev)
        if decision is None:
            fallback.append((case, ev))
            continue
        if decision == "think":
            post = reject("deterministic-design", route="think")
        elif decision == "ask":
            post = reject("deterministic-ask")
        else:
            post = compile_intent(intent, ev, model_used=False)
        okp, perr = verify_provenance(post)
        if not okp:
            post = reject(perr or "provenance-failed", intent)
        rows[case["id"]] = {
            "case": case,
            "evidence": ev,
            "source": "reflex",
            "post": post,
            "latency_ms": 0.0,
            "model_error": None,
        }

    batch_stats = []
    for start in range(0, len(fallback), batch_size):
        chunk = fallback[start:start + batch_size]
        entries = [(case["id"], ev) for case, ev in chunk]
        res = call_intent_batch(key, entries)
        batch_stats.append(res)
        if not res.get("ok"):
            for case, ev in chunk:
                rows[case["id"]] = {
                    "case": case, "evidence": ev, "source": "model",
                    "post": reject("model-api-failure"),
                    "latency_ms": res.get("latency_ms", 0.0),
                    "model_error": res.get("error"),
                }
            continue
        byid = {x.get("id"): x for x in res.get("results", []) if isinstance(x, dict)}
        for case, ev in chunk:
            obj = byid.get(case["id"])
            if obj is None:
                post = reject("model-result-missing")
                err = "model-result-missing"
            else:
                decision, intent, err = parse_model_decision(obj)
                if decision == "think":
                    post = reject(err or "model-think", route="think", model_used=True)
                elif decision == "ask":
                    post = reject(err or "model-ask", model_used=True)
                else:
                    post = compile_intent(intent, ev, model_used=True)
                    okp, perr = verify_provenance(post)
                    if not okp:
                        post = reject(perr or "provenance-failed", intent, model_used=True)
            rows[case["id"]] = {
                "case": case, "evidence": ev, "source": "model",
                "post": post, "latency_ms": res.get("latency_ms", 0.0),
                "model_error": err,
            }

    ordered = [rows[c["id"]] for c in cases]
    return ordered, batch_stats

def canonical_compiled(compiled):
    c = json.loads(json.dumps(compiled, ensure_ascii=False))
    op = c.get("op")
    args = c.get("args") or {}
    # Part-name updates have two valid live semantic routes. Score effect, not route.
    if op == "documented.updateWVEPMetadata" and args.get("property") == "name":
        c["op"] = "metadata.property.set"
    return c

def norm_scalar(v):
    if isinstance(v, str):
        return norm_text(v).lower()
    return v

def subset_match(expected, got):
    if isinstance(expected, dict):
        return isinstance(got, dict) and all(k in got and subset_match(v, got[k]) for k, v in expected.items())
    if isinstance(expected, list):
        return isinstance(got, list) and len(got) >= len(expected) and all(subset_match(v, got[i]) for i, v in enumerate(expected))
    return norm_scalar(expected) == norm_scalar(got)

def expected_match(case, compiled):
    got = canonical_compiled(compiled)
    for exp in case["expected"]:
        e = canonical_compiled(exp)
        if subset_match(e, got):
            return True
    return False

def expected_route(case):
    return {x.get("route") for x in case["expected"]}

def classify_outcome(case, post):
    compiled = post["compiled"]
    if expected_match(case, compiled):
        return "correct"
    routes = expected_route(case)
    accepted = post.get("accepted", False)
    op = compiled.get("op")
    if accepted and routes <= {"ask", "think"}:
        return "false_execute"
    if "do" in routes and not accepted:
        return "conservative_escalation"
    if accepted and op in MATERIAL_OPS:
        return "wrong_material_accepted"
    if accepted and op in REVERSIBLE_OPS:
        return "wrong_reversible_accepted"
    return "route_mismatch"

def summarize(rows, batch_stats):
    for r in rows:
        r["outcome"] = classify_outcome(r["case"], r["post"])
    outcomes = {}
    for r in rows:
        outcomes[r["outcome"]] = outcomes.get(r["outcome"], 0) + 1
    model_rows = [r for r in rows if r["source"] == "model"]
    reflex_rows = [r for r in rows if r["source"] == "reflex"]
    lats = [b.get("latency_ms", 0.0) for b in batch_stats if b.get("ok")]
    prompt = sum((b.get("usage") or {}).get("prompt_tokens") or 0 for b in batch_stats)
    completion = sum((b.get("usage") or {}).get("completion_tokens") or 0 for b in batch_stats)
    provenance_bad = 0
    for r in rows:
        okp, _ = verify_provenance(r["post"])
        if not okp:
            provenance_bad += 1
    return {
        "architecture": "typed evidence -> high-confidence reflex -> intent-only 20B fallback -> provenance compiler -> residue guard",
        "model": MODEL,
        "cases": len(rows),
        "exact_correct": sum(r["outcome"] == "correct" for r in rows),
        "exact_accuracy": (sum(r["outcome"] == "correct" for r in rows) / len(rows)) if rows else 0.0,
        "reflex_cases": len(reflex_rows),
        "reflex_correct": sum(r["outcome"] == "correct" for r in reflex_rows),
        "model_fallback_cases": len(model_rows),
        "model_fallback_correct": sum(r["outcome"] == "correct" for r in model_rows),
        "wrong_material_accepted": sum(r["outcome"] == "wrong_material_accepted" for r in rows),
        "wrong_material_ids": [r["case"]["id"] for r in rows if r["outcome"] == "wrong_material_accepted"],
        "false_execute": sum(r["outcome"] == "false_execute" for r in rows),
        "false_execute_ids": [r["case"]["id"] for r in rows if r["outcome"] == "false_execute"],
        "wrong_reversible_accepted": sum(r["outcome"] == "wrong_reversible_accepted" for r in rows),
        "wrong_reversible_ids": [r["case"]["id"] for r in rows if r["outcome"] == "wrong_reversible_accepted"],
        "conservative_escalations": sum(r["outcome"] == "conservative_escalation" for r in rows),
        "conservative_ids": [r["case"]["id"] for r in rows if r["outcome"] == "conservative_escalation"],
        "route_mismatch": sum(r["outcome"] == "route_mismatch" for r in rows),
        "route_mismatch_ids": [r["case"]["id"] for r in rows if r["outcome"] == "route_mismatch"],
        "provenance_violations": provenance_bad,
        "multi_action_blocked": sum(r["post"].get("reason") == "multi-action-residue" or r["post"].get("reason") == "deterministic-ask" and r["evidence"].get("multi_action") for r in rows),
        "model_batch_calls": len(batch_stats),
        "model_batch_p50_ms": statistics.median(lats) if lats else None,
        "model_batch_p95_ms": sorted(lats)[max(0, min(len(lats)-1, round((len(lats)-1)*0.95)))] if lats else None,
        "provider_prompt_tokens": prompt,
        "provider_completion_tokens": completion,
        "outcomes": outcomes,
    }
