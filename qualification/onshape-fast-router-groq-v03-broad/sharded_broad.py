from __future__ import annotations

import json
import os
import statistics
import time

import benchmark as b

SHARD_INDEX = int(os.environ.get("SHARD_INDEX", "0"))
SHARD_COUNT = int(os.environ.get("SHARD_COUNT", "4"))
CASE_DELAY = float(os.environ.get("CASE_DELAY", "8.2"))
INITIAL_STAGGER = float(os.environ.get("INITIAL_STAGGER", "2.0"))
OUT_DIR = os.environ.get("OUT_DIR", "artifacts/onshape-fast-router-groq-v03-broad")


def run_robust(key, case):
    last = None
    for outer in range(4):
        last = b.run_one(key, case)
        if last.get("ok"):
            return last
        err = str(last.get("error") or "")
        if "json_validate_failed" in err or "Failed to generate JSON" in err:
            time.sleep(1.5 + outer)
            continue
        retry_after = last.get("retry_after")
        wait = 10.0 * (outer + 1)
        if retry_after:
            try:
                wait = max(wait, float(retry_after) + 1.0)
            except Exception:
                pass
        time.sleep(wait)
    return last


def main():
    if SHARD_COUNT < 1 or SHARD_INDEX < 0 or SHARD_INDEX >= SHARD_COUNT:
        raise SystemExit("invalid shard")
    key = os.environ.get("GROQ_API_KEY", "").strip()
    if not key:
        raise SystemExit("GROQ_API_KEY missing")

    os.makedirs(OUT_DIR, exist_ok=True)
    cases = [case for i, case in enumerate(b.BASE_CASES) if i % SHARD_COUNT == SHARD_INDEX]
    time.sleep(SHARD_INDEX * INITIAL_STAGGER)

    rows = []
    for j, case in enumerate(cases, 1):
        row = run_robust(key, case)
        rows.append(row)
        print(json.dumps({
            "shard": SHARD_INDEX,
            "i": j,
            "n": len(cases),
            "id": case["id"],
            "outcome": row["outcome"],
            "latency_ms": round(row.get("latency_ms", 0), 1),
            "reason": row["post"].get("reason"),
            "error": row.get("error"),
        }, ensure_ascii=False), flush=True)

        shard_file = os.path.join(OUT_DIR, f"shard-{SHARD_INDEX}.json")
        with open(shard_file, "w", encoding="utf-8") as f:
            json.dump(rows, f, ensure_ascii=False, indent=2)

        if j != len(cases):
            time.sleep(CASE_DELAY)

    good = [r for r in rows if r.get("ok")]
    lats = [r["latency_ms"] for r in good]
    local = {
        "shard": SHARD_INDEX,
        "cases": len(rows),
        "api_success": len(good),
        "exact_correct": sum(r["outcome"] == "correct" for r in rows),
        "wrong_material_accepted": sum(r["outcome"] == "wrong_material_accepted" for r in rows),
        "false_execute": sum(r["outcome"] == "false_execute" for r in rows),
        "p50_ms": statistics.median(lats) if lats else None,
    }
    with open(os.path.join(OUT_DIR, f"shard-{SHARD_INDEX}-summary.json"), "w", encoding="utf-8") as f:
        json.dump(local, f, ensure_ascii=False, indent=2)
    print("SHARD_SUMMARY=" + json.dumps(local, ensure_ascii=False, sort_keys=True), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
