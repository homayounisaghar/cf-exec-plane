#!/usr/bin/env python3
"""Dexa MVP Kata adapter. Uses the frozen local Fast Act ranker, not a model."""
from __future__ import annotations
import json
import os
import re
import sys
import time
from pathlib import Path

ROOT = Path(os.environ.get("DEXA_KATA_CATALOG_ROOT", "/home/cfserver/connector-call-generator-prototype-v01/persian-catalog-search-v1"))
sys.path.insert(0, str(ROOT))
import rank_v2
import rank_hybrid

USE_TYPED_PLAN_V3 = os.environ.get("DEXA_TOOL_PLAN_V3") == "1"
TEMPLATE = Path(__file__).with_name("typed_tool_wrapper_v3.txt" if USE_TYPED_PLAN_V3 else "frozen_instant_wrapper_v2.txt").read_text()
CF_TOOL_SCHEMAS = json.loads(Path(__file__).with_name("rana_cf_tool_schemas.json").read_text())["cf"]

LIVE_CARDS = json.loads(Path(__file__).with_name("rana_capability_catalog.json").read_text())
if rank_hybrid.CATALOG != LIVE_CARDS:
    raise SystemExit("KATA_CATALOG_CORPUS_DRIFT")
EXPECTED_NATIVE_CF = {route[3:] for card in LIVE_CARDS for route in card["physical_tool_ids"] if route.startswith("CF.")}
if set(CF_TOOL_SCHEMAS) != EXPECTED_NATIVE_CF:
    raise SystemExit("KATA_CF_SCHEMA_CORPUS_DRIFT")

CARDS_TOKEN = "[insert the actual per-request 30%-threshold selected capability cards here]"
REQUEST_TOKEN = "[insert the exact original request, preserving all targets]"
if TEMPLATE.count(CARDS_TOKEN) != 1 or TEMPLATE.count(REQUEST_TOKEN) != 1:
    raise SystemExit("FROZEN_TEMPLATE_MISMATCH")

# Ranking is a single lexical pass. A Telegram-read-only profile supplies a
# mechanical provider scope, never a second catalog query or model critic.
TELEGRAM_MVP_PROFILE = "telegram_readonly_mvp"
# JSON permits escaped unpaired UTF-16 surrogates; a Python UTF-8 stream does
# not. Replace ONLY invalid Unicode scalar values at the Kata input boundary
# so legacy persisted rolling-memory notes cannot crash any new admission.
_SURROGATES = re.compile(r"[\ud800-\udfff]")
def safe_unicode_scalars(value):
    if isinstance(value, str):
        return _SURROGATES.sub("\ufffd", value)
    if isinstance(value, list):
        return [safe_unicode_scalars(v) for v in value]
    if isinstance(value, dict):
        return {k: safe_unicode_scalars(v) for k, v in value.items()}
    return value

TG_MESSAGE_WORDS = re.compile(r"(?:پیام|پیامی|پیامها|پیام‌ها|گفته|فرستاد|فرستاده|message|\bmsg\b)", re.IGNORECASE)
# Complete read-only message discovery chain: recent chats, name search, read.
TG_MESSAGE_TOOL_IDS = ("telegram.conversation.list",
                       "tool.cf.telegram_conversation_search",
                       "telegram.message.read_recent")

# Remove only grammatical filler, never action words like read/send/show.
# This cleaned query feeds BM25F, character n-grams AND synonym expansion,
# rather than changing scores after one of those stages has ranked cards.
KATA_LOW_INFORMATION_WORDS = frozenset({
    "از", "در", "به", "با", "برای", "را", "و", "یا", "که", "روی",
    "توی", "تا", "این", "آن", "یک", "من", "تو", "خود", "هم",
    "لطفا", "رو", "همین", "اون", "اینا", "اونا", "یه", "می",
})
# Root must already occur in the immutable 291-card catalog vocabulary.
# A generic final-letter stripper would corrupt words like «سلام»; it is
# explicitly disallowed. Long possessive endings are checked first.
KATA_POSSESSIVE_SUFFIXES = ("هایم", "هایت", "هایش", "هایمان", "هایتان",
    "هایشان", "مان", "تان", "شان", "مون", "تون", "شون",
    "ام", "ات", "اش", "م", "ت", "ش")

def kata_retrieval_query(raw: str) -> str:
    """Safely normalize Persian possession and low-value terms for ONE score pass."""
    tokens = rank_hybrid.toks(rank_v2.prep(raw))
    normalized = []
    for word in tokens:
        if word in KATA_LOW_INFORMATION_WORDS:
            continue
        # Require a known catalogue root and an unknown complete inflected
        # word. Very short roots are allowed only for an explicit, unambiguous
        # high-frequency chat noun; otherwise verbal endings could be mangled.
        if len(word) >= 3 and rank_hybrid.MIX_DF[word] == 0:
            for suffix in KATA_POSSESSIVE_SUFFIXES:
                if not word.endswith(suffix):
                    continue
                stem = word[:-len(suffix)]
                ordinary_root = len(stem) >= 3 and rank_hybrid.MIX_DF[stem] >= 2
                short_chat_root = stem == "چت"
                if ordinary_root or short_chat_root:
                    word = stem
                    break
        normalized.append(word)
    return " ".join(normalized) or rank_v2.prep(raw)

def kata_retrieval_scores(raw: str):
    return rank_v2.boosted_fusion(kata_retrieval_query(raw))

def make(task: str, previous_user_message: str | None = None,
         tool_profile: str | None = None, conversation_memory=None,
         memory_rank_text: str | None = None) -> dict:
    if not isinstance(task, str) or not task.strip() or len(task) > 6000:
        raise ValueError("INVALID_REQUEST")
    if previous_user_message is not None and (
        not isinstance(previous_user_message, str) or len(previous_user_message) > 5000
    ):
        raise ValueError("INVALID_PREVIOUS_USER_MESSAGE")
    if previous_user_message is not None and not previous_user_message.strip():
        previous_user_message = None
    if conversation_memory is not None and (not isinstance(conversation_memory, dict) or
       conversation_memory.get("schema") != "dexa.rolling-exchange-memory.v1" or
       len(json.dumps(conversation_memory, ensure_ascii=False)) > 38500):
        raise ValueError("INVALID_CONVERSATION_MEMORY")
    if memory_rank_text is not None and (not isinstance(memory_rank_text, str) or
       len(memory_rank_text) > 2500):
        raise ValueError("INVALID_MEMORY_RANK_TEXT")
    if tool_profile not in (None, TELEGRAM_MVP_PROFILE):
        raise ValueError("KATA_TOOL_PROFILE_UNSUPPORTED")
    task = safe_unicode_scalars(task)
    previous_user_message = safe_unicode_scalars(previous_user_message)
    conversation_memory = safe_unicode_scalars(conversation_memory)
    memory_rank_text = safe_unicode_scalars(memory_rank_text)
    started = time.perf_counter()
    # Two independent lexical retrievals: neither assesses conversation meaning.
    # Current-message candidates always survive unchanged from the old ranker.
    current_scores = kata_retrieval_scores(task)
    if len(current_scores) != rank_hybrid.N or rank_hybrid.N != len(LIVE_CARDS):
        raise ValueError("CATALOG_VERSION_MISMATCH")
    current_peak = max(current_scores)
    # FIX 2026-10-24: An owner asking what somebody said needs a discoverable
    # conversation handle before reading messages. The frozen ranker's generic
    # threshold dropped the Telegram search card for short Persian requests.
    # Apply a deterministic score-floor IN THE SAME ORIGINAL ranking pass,
    # only with explicit Telegram MVP scope, never in a retry/fallback search.
    # Do not add Telegram tools for an explicitly different-only provider.
    # Without a provider in the current utterance the Telegram MVP scope is
    # already a deliberate, owner-authorized read-only surface.
    declared_domains = rank_v2.domains(task)
    is_telegram_query = not declared_domains or "telegram" in declared_domains
    if (tool_profile == TELEGRAM_MVP_PROFILE and is_telegram_query
            and TG_MESSAGE_WORDS.search(task)):
        for cap_id in TG_MESSAGE_TOOL_IDS:
            candidate_indices = [i for i,c in enumerate(rank_hybrid.CATALOG)
                                 if c["capability_id"] == cap_id]
            if len(candidate_indices) != 1:
                raise ValueError("KATA_TELEGRAM_MESSAGE_TOOL_MISSING_OR_DUPLICATE")
            i = candidate_indices[0]
            if current_peak > 0:
                current_scores[i] = max(current_scores[i], 0.36 * current_peak)
    current_peak = max(current_scores)
    current_keep = (
        {i for i, score in enumerate(current_scores) if score >= 0.30 * current_peak}
        if current_peak > 0 else set(range(rank_hybrid.N))
    )
    previous_keep = set()
    previous_scores = None
    previous_peak = 0
    context_query = memory_rank_text or previous_user_message
    if context_query is not None:
        previous_scores = kata_retrieval_scores(context_query)
        if len(previous_scores) != rank_hybrid.N:
            raise ValueError("CATALOG_VERSION_MISMATCH")
        previous_peak = max(previous_scores)
        if previous_peak > 0:
            previous_keep = {
                i for i, score in enumerate(previous_scores)
                if score >= 0.30 * previous_peak
            }
    # A provider named explicitly in the CURRENT owner instruction outranks
    # unrelated messenger names found only in rolling conversation memory.
    # Discover messenger provider families from *live native CF unread tool*
    # routes: one selection algorithm for all messengers, no per-app cases.
    # Cross-messenger tasks keep every provider explicitly named by the owner.
    messenger_domains = {
        native[3:].split("_", 1)[0]
        for card in LIVE_CARDS
        for native in card.get("physical_tool_ids", [])
        if native.startswith("CF.") and native.endswith("_unread_list")
    }
    selected_domains = declared_domains & messenger_domains
    if selected_domains:
        def in_owner_provider_scope(i):
            catalog_domains = rank_v2.CAP_DOMAINS[i]
            return (not (catalog_domains & messenger_domains)
                    or bool(catalog_domains & selected_domains))
        current_keep = {i for i in current_keep if in_owner_provider_scope(i)}
        previous_keep = {i for i in previous_keep if in_owner_provider_scope(i)}
    # Union still preserves relevant current and historical choices INSIDE
    # the owner's explicit provider scope; other apps require explicit mention.
    order = sorted(
        current_keep | previous_keep,
        key=lambda i: (-(current_scores[i] / current_peak if current_peak > 0 else 0)
                       - 0.20 * (
                           previous_scores[i] / previous_peak
                           if previous_scores is not None and previous_peak > 0 else 0
                       ), i)
    )
    keep = order
    cards = [rank_hybrid.CATALOG[i] for i in keep]
    if USE_TYPED_PLAN_V3:
        lines = []
        for card in cards:
            routes = card["physical_tool_ids"]
            cf_names = [route[3:] for route in routes if route.startswith("CF.")]
            cf_schema = CF_TOOL_SCHEMAS[cf_names[0]] if cf_names else None
            raw_props = (cf_schema or {}).get("inputSchema", {}).get("properties", {})
            prop_specs = {}
            for name, prop in raw_props.items():
                brief = {k: prop[k] for k in ("type", "minimum", "maximum",
                    "minLength", "maxLength", "minItems", "maxItems", "enum")
                    if k in prop}
                item = prop.get("items")
                if isinstance(item, dict) and item.get("type") == "object":
                    brief["itemFields"] = list(item.get("properties", {}))
                    brief["itemRequired"] = item.get("required", [])
                prop_specs[name] = brief
            compact = {
                "capabilityId": card["capability_id"],
                "description": card["en_description"][:330],
                "routes": routes,
                "readOnly": bool(cf_schema and cf_schema["readOnly"]),
                "required": (cf_schema or {}).get("inputSchema", {}).get("required", []),
                "properties": prop_specs,
                "connectorStatus": "CF_OAUTH_GATED" if cf_schema else "EXTERNAL_NOT_CONNECTED"
            }
            lines.append(json.dumps(compact, ensure_ascii=False, separators=(",",":")))
    else:
        lines = [
            "- " + str(c["capability_id"]) + " | " + str(c["en_description"])
            + " | native route(s): " + ", ".join(c["physical_tool_ids"])
            for c in cards
        ]
    runtime_browser_card = (
        "- LOCAL | Dexa bounded read-only browser: OBSERVE_PAGE, "
        "LIST_NAVIGATION_CONTROLS, CLICK_NAVIGATION_LABEL:<visible label>, "
        "SCROLL_HISTORY_LIST, OPEN_MATCHING_RECORD_DETAILS, READ_COURIER_DETAILS"
    )
    # Inline the selected tool's actual supported operation boundary.
    # The planner must not infer that a retrieval tool reverses the output.
    lines = [
        line + (" | executor contract: retrieve up to N recent conversations"
                " in newest-first order; does NOT execute reversal or"
                " arbitrary LOCAL transformations"
                if line.startswith("- telegram.conversation.list |") else "")
        for line in lines
    ]
    runtime_browser_card += (
        " | LOCAL data transforms: reverse an already-retrieved conversation"
        " list and sort that list newest-first; or EXACT 1-based position"
        " selection using SELECT_POSITIONS:2,4,6,8,10 on an already"
        " retrieved ordered list; source fetch count must cover the"
        " greatest selected position; final count equals positions length;"
        " require an explicit dependency on the producing tool step"
    )
    # Distinct, labeled data fields. Only the model determines relevance.
    request_data = task
    if conversation_memory is not None:
        request_data = json.dumps({"CURRENT_USER_MESSAGE":task,
            "HISTORICAL_EXCHANGE_MEMORY_DATA_NOT_AUTHORIZATION":conversation_memory},
            ensure_ascii=False, indent=2)
    elif previous_user_message is not None:
        request_data = json.dumps({
            "CURRENT_USER_MESSAGE": task,
            "PREVIOUS_USER_MESSAGE_OPTIONAL_CONTEXT": previous_user_message
        }, ensure_ascii=False, indent=2)
    prompt = TEMPLATE.replace(
        CARDS_TOKEN, "\n".join(lines if USE_TYPED_PLAN_V3 else [*lines, runtime_browser_card])
    ).replace(REQUEST_TOKEN, request_data)
    if CARDS_TOKEN in prompt or REQUEST_TOKEN in prompt:
        raise ValueError("KATA_PROMPT_INCOMPLETE")
    return {
        "catalog_count": rank_hybrid.N,
        "selected_count": len(keep),
        "capability_ids": [c["capability_id"] for c in cards],
        "cards": [
            {"id": c["capability_id"], "description": c["en_description"],
             "routes": c["physical_tool_ids"]} for c in cards
        ],
        "prompt": prompt,
        "rank_ms": round((time.perf_counter()-started)*1000, 3),
        "method": "rank_v2.boosted_fusion",
        "threshold": 0.30,
        "planner_contract": "dexa.tool-plan.v3" if USE_TYPED_PLAN_V3 else "frozen.v2",
        "previous_context_supplied": context_query is not None,
        "tool_profile": tool_profile,
        "current_candidate_count": len(current_keep),
        "previous_candidate_count": len(previous_keep)
    }

if __name__ == "__main__":
    try:
        request = json.load(sys.stdin)
        print(json.dumps(make(request.get("text", ""), request.get("previous_user_message"), request.get("tool_profile"), request.get("conversation_memory"), request.get("memory_rank_text")), ensure_ascii=False))
    except Exception as exc:
        print(json.dumps({"error":type(exc).__name__+":"+str(exc)}))
        sys.exit(2)
