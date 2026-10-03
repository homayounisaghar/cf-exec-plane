from __future__ import annotations

import glob
import json
import os
import statistics

import benchmark as b

ROOT = os.environ.get("INPUT_ROOT", "downloaded")
OUT_DIR = os.environ.get("OUT_DIR", "artifacts/onshape-fast-router-groq-v03-broad-final")


def pct(values, p):
    if not values:
        return None
    s = sorted(values)
    i = max(0, min(len(s) - 1, round((len(s) - 1) * p)))
    return s[i]


def main():
    files = sorted(glob.glob(os.path.join(ROOT, "**", "shard-[0-9].json"), recursive=True))
    if not files:
        raise SystemExit("no shard row files found")

    rows = []
    for path in files:
        with open(path, encoding="utf-8") as f:
            rows.extend(json.load(f))

    by_id = {}
    for row in rows:
        by_id[row["case"]["id"]] = row
    rows = [by_id[c["id"]] for c in b.BASE_CASES if c["id"] in by_id]

    single_lats = [r["latency_ms"] for r in rows if r.get("ok") and "latency_ms" in r]
    batch_files = sorted(glob.glob(os.path.join(ROOT, "**", "shard-*-batches.json"), recursive=True))
    batch_stats = []
    for path in batch_files:
        with open(path, encoding="utf-8") as f:
            batch_stats.extend(json.load(f))
    batch_lats = [x["batch_latency_ms"] for x in batch_stats if x.get("ok") and x.get("batch_latency_ms") is not None]
    expected_do = [r for r in rows if "do" in b.expected_route(r["case"])]
    categories = {}
    for cat in sorted({r["case"]["category"] for r in rows}):
        cr = [r for r in rows if r["case"]["category"] == cat]
        categories[cat] = {
            "n": len(cr),
            "api_success": sum(bool(r.get("ok")) for r in cr),
            "correct": sum(r["outcome"] == "correct" for r in cr),
            "wrong_material_accepted": sum(r["outcome"] == "wrong_material_accepted" for r in cr),
            "false_execute": sum(r["outcome"] == "false_execute" for r in cr),
            "conservative_escalation": sum(r["outcome"] == "conservative_escalation" for r in cr),
        }

    outcomes = {}
    for r in rows:
        outcomes[r["outcome"]] = outcomes.get(r["outcome"], 0) + 1

    summary = {
        "model": b.MODEL,
        "expected_cases": len(b.BASE_CASES),
        "collected_cases": len(rows),
        "api_success": sum(bool(r.get("ok")) for r in rows),
        "exact_correct": sum(r["outcome"] == "correct" for r in rows),
        "exact_accuracy": sum(r["outcome"] == "correct" for r in rows) / len(b.BASE_CASES),
        "wrong_material_accepted": sum(r["outcome"] == "wrong_material_accepted" for r in rows),
        "wrong_material_ids": [r["case"]["id"] for r in rows if r["outcome"] == "wrong_material_accepted"],
        "false_execute": sum(r["outcome"] == "false_execute" for r in rows),
        "false_execute_ids": [r["case"]["id"] for r in rows if r["outcome"] == "false_execute"],
        "conservative_escalations": sum(r["outcome"] == "conservative_escalation" for r in rows),
        "conservative_ids": [r["case"]["id"] for r in rows if r["outcome"] == "conservative_escalation"],
        "wrong_reversible_accepted": sum(r["outcome"] == "wrong_reversible_accepted" for r in rows),
        "route_mismatch": sum(r["outcome"] == "route_mismatch" for r in rows),
        "routine_expected_do": len(expected_do),
        "routine_auto_accepted": sum(r["post"]["accepted"] for r in expected_do),
        "routine_auto_accept_rate": sum(r["post"]["accepted"] for r in expected_do) / len(expected_do) if expected_do else 0,
        "routine_correct": sum(r["outcome"] == "correct" for r in expected_do),
        "routine_correct_rate": sum(r["outcome"] == "correct" for r in expected_do) / len(expected_do) if expected_do else 0,
        "batch_calls": len(batch_stats),
        "batch_api_success": sum(bool(x.get("ok")) for x in batch_stats),
        "batch_p50_ms": statistics.median(batch_lats) if batch_lats else None,
        "batch_p95_ms": pct(batch_lats, .95),
        "batch_p99_ms": pct(batch_lats, .99),
        "batch_mean_ms": statistics.mean(batch_lats) if batch_lats else None,
        "single_fallbacks": sum(r.get("inference_mode") == "single_fallback" for r in rows),
        "single_fallback_p50_ms": statistics.median(single_lats) if single_lats else None,
        "outcomes": outcomes,
        "categories": categories,
        "missing_ids": [c["id"] for c in b.BASE_CASES if c["id"] not in by_id],
        "api_failure_ids": [r["case"]["id"] for r in rows if not r.get("ok")],
    }

    os.makedirs(OUT_DIR, exist_ok=True)
    with open(os.path.join(OUT_DIR, "summary.json"), "w", encoding="utf-8") as f:
        json.dump(summary, f, ensure_ascii=False, indent=2)
    with open(os.path.join(OUT_DIR, "rows.json"), "w", encoding="utf-8") as f:
        json.dump(rows, f, ensure_ascii=False, indent=2)
    with open(os.path.join(OUT_DIR, "mismatches.json"), "w", encoding="utf-8") as f:
        json.dump([r for r in rows if r["outcome"] != "correct"], f, ensure_ascii=False, indent=2)

    print("FINAL_SUMMARY=" + json.dumps(summary, ensure_ascii=False, sort_keys=True), flush=True)
    return 0 if len(rows) == len(b.BASE_CASES) and not summary["api_failure_ids"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
