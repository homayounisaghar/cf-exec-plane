from __future__ import annotations

import json
import os
import time
import urllib.error
import urllib.request
from collections import defaultdict

import benchmark as b

SHARD_INDEX = int(os.environ.get("SHARD_INDEX", "0"))
SHARD_COUNT = int(os.environ.get("SHARD_COUNT", "4"))
BATCH_SIZE = int(os.environ.get("BATCH_SIZE", "4"))
BATCH_DELAY = float(os.environ.get("BATCH_DELAY", "8.2"))
INITIAL_STAGGER = float(os.environ.get("INITIAL_STAGGER", "2.0"))
OUT_DIR = os.environ.get("OUT_DIR", "artifacts/onshape-fast-router-groq-v03-broad")
MAX_RETRIES = 4


def build_batches():
    groups = defaultdict(list)
    for case in b.BASE_CASES:
        family = b.classify_family(case["text"], case.get("ctx", {}))
        groups[family].append(case)

    batches = []
    for family in sorted(groups):
        cases = groups[family]
        for i in range(0, len(cases), BATCH_SIZE):
            batches.append((family, cases[i:i + BATCH_SIZE]))
    return batches


def system_for_family(family):
    cards = b.FAMILY_CARDS.get(family, [])
    if cards:
        card_text = "\n".join(f"- {name}: {b.CARDS[name]}" for name in cards)
    else:
        card_text = "- no executable capability card applies; choose ask or think."
    return b.SYSTEM_BASE + """
Interpret EACH input independently. Return JSON only:
{"items":[{"id":"...","decision":"act|ask|think","intent":"card-name-or-null","slots":{}}]}
Return exactly one item for every input id, in the same order. Never let one command affect another.
""" + "\nCapability cards for THIS batch only:\n" + card_text


def call_batch(key, batch_id, family, cases):
    user_items = []
    for case in cases:
        user_items.append({
            "id": case["id"],
            "command": b.norm_text(case["text"]),
            "context": case.get("ctx", {}),
            "lexical_hint": b.lexical_hints(case["text"], case.get("ctx", {})),
        })

    body = {
        "model": b.MODEL,
        "messages": [
            {"role": "system", "content": system_for_family(family)},
            {"role": "user", "content": json.dumps({"inputs": user_items}, ensure_ascii=False, separators=(",", ":"))},
        ],
        "reasoning_effort": "low",
        "temperature": 0,
        "max_completion_tokens": 900,
        "response_format": {"type": "json_object"},
    }

    req = urllib.request.Request(
        b.ENDPOINT,
        data=json.dumps(body, ensure_ascii=False).encode("utf-8"),
        headers={
            "Authorization": "Bearer " + key,
            "Content-Type": "application/json",
            "User-Agent": "cf-exec-plane-onshape-router-broad-batch/1.0",
        },
        method="POST",
    )

    t0 = time.perf_counter()
    try:
        with urllib.request.urlopen(req, timeout=90) as resp:
            raw = resp.read().decode("utf-8")
            ms = (time.perf_counter() - t0) * 1000
            data = json.loads(raw)
            parsed = json.loads(data["choices"][0]["message"]["content"])
            items = parsed.get("items")
            if not isinstance(items, list):
                raise ValueError("batch response missing items")
            return {
                "ok": True,
                "batch_id": batch_id,
                "batch_latency_ms": ms,
                "items": items,
                "usage": data.get("usage", {}),
            }
    except urllib.error.HTTPError as e:
        txt = e.read().decode("utf-8", "replace")
        return {
            "ok": False,
            "batch_id": batch_id,
            "batch_latency_ms": (time.perf_counter() - t0) * 1000,
            "status": e.code,
            "retry_after": e.headers.get("retry-after"),
            "error": f"HTTP {e.code}: {txt[:1200]}",
        }
    except Exception as e:
        return {
            "ok": False,
            "batch_id": batch_id,
            "batch_latency_ms": (time.perf_counter() - t0) * 1000,
            "error": repr(e),
        }


def call_batch_robust(key, batch_id, family, cases):
    last = None
    for attempt in range(MAX_RETRIES):
        last = call_batch(key, batch_id, family, cases)
        if last.get("ok"):
            return last
        err = str(last.get("error") or "")
        if "json_validate_failed" in err or "Failed to generate JSON" in err:
            time.sleep(2 + attempt)
            continue
        wait = 10.0 * (attempt + 1)
        if last.get("retry_after"):
            try:
                wait = max(wait, float(last["retry_after"]) + 1.0)
            except Exception:
                pass
        time.sleep(wait)
    return last


def row_from_ir(case, ir, batch):
    post = b.compile_ir(case, ir)
    outcome = b.classify_outcome(case, post)
    return {
        "case": case,
        "ok": True,
        "ir": ir,
        "post": post,
        "outcome": outcome,
        "batch_id": batch["batch_id"],
        "batch_latency_ms": batch["batch_latency_ms"],
        "usage": batch.get("usage", {}),
        "inference_mode": "batch",
    }


def fallback_single(key, case, reason):
    row = b.run_one(key, case)
    row["inference_mode"] = "single_fallback"
    row["batch_fallback_reason"] = reason
    return row


def main():
    if SHARD_COUNT < 1 or SHARD_INDEX < 0 or SHARD_INDEX >= SHARD_COUNT:
        raise SystemExit("invalid shard")
    key = os.environ.get("GROQ_API_KEY", "").strip()
    if not key:
        raise SystemExit("GROQ_API_KEY missing")

    os.makedirs(OUT_DIR, exist_ok=True)
    all_batches = build_batches()
    selected = [(i, fam, cases) for i, (fam, cases) in enumerate(all_batches) if i % SHARD_COUNT == SHARD_INDEX]
    time.sleep(SHARD_INDEX * INITIAL_STAGGER)

    rows = []
    batch_stats = []
    for j, (global_i, family, cases) in enumerate(selected, 1):
        batch_id = f"{family}-{global_i}"
        result = call_batch_robust(key, batch_id, family, cases)
        batch_stats.append({
            "batch_id": batch_id,
            "family": family,
            "case_ids": [c["id"] for c in cases],
            **{k: v for k, v in result.items() if k not in {"items"}},
        })

        if result.get("ok"):
            by_id = {x.get("id"): x for x in result.get("items", []) if isinstance(x, dict)}
            for case in cases:
                raw = by_id.get(case["id"])
                if raw and all(k in raw for k in ("decision", "intent", "slots")):
                    ir = {"decision": raw["decision"], "intent": raw["intent"], "slots": raw["slots"]}
                    row = row_from_ir(case, ir, result)
                else:
                    row = fallback_single(key, case, "missing-or-malformed-batch-item")
                rows.append(row)
        else:
            for case in cases:
                rows.append(fallback_single(key, case, "batch-call-failed"))

        print(json.dumps({
            "shard": SHARD_INDEX,
            "batch": j,
            "batches": len(selected),
            "batch_id": batch_id,
            "case_ids": [c["id"] for c in cases],
            "batch_ok": result.get("ok"),
            "batch_latency_ms": round(result.get("batch_latency_ms", 0), 1),
            "outcomes": [r["outcome"] for r in rows[-len(cases):]],
            "error": result.get("error"),
        }, ensure_ascii=False), flush=True)

        with open(os.path.join(OUT_DIR, f"shard-{SHARD_INDEX}.json"), "w", encoding="utf-8") as f:
            json.dump(rows, f, ensure_ascii=False, indent=2)
        with open(os.path.join(OUT_DIR, f"shard-{SHARD_INDEX}-batches.json"), "w", encoding="utf-8") as f:
            json.dump(batch_stats, f, ensure_ascii=False, indent=2)

        if j != len(selected):
            time.sleep(BATCH_DELAY)

    summary = {
        "shard": SHARD_INDEX,
        "cases": len(rows),
        "batches": len(selected),
        "api_success": sum(bool(r.get("ok")) for r in rows),
        "exact_correct": sum(r["outcome"] == "correct" for r in rows),
        "wrong_material_accepted": sum(r["outcome"] == "wrong_material_accepted" for r in rows),
        "false_execute": sum(r["outcome"] == "false_execute" for r in rows),
        "single_fallbacks": sum(r.get("inference_mode") == "single_fallback" for r in rows),
    }
    with open(os.path.join(OUT_DIR, f"shard-{SHARD_INDEX}-summary.json"), "w", encoding="utf-8") as f:
        json.dump(summary, f, ensure_ascii=False, indent=2)
    print("SHARD_SUMMARY=" + json.dumps(summary, ensure_ascii=False, sort_keys=True), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
