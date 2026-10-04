from __future__ import annotations

import json
import os
import time

from corpus_v02 import CASES as KNOWN
from synthetic_holdout import CASES as FROZEN
from metamorphic import CASES as META
import evidence_router as r

OUT_DIR = os.environ.get("OUT_DIR", "artifacts/onshape-fast-router-evidence-planner-v06")
BATCH_SIZE = int(os.environ.get("BATCH_SIZE", "12"))

def write_json(path, obj):
    with open(path, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, indent=2)

def compact_row(row):
    ev = row["evidence"]
    return {
        "case": row["case"],
        "source": row["source"],
        "outcome": row.get("outcome"),
        "latency_ms": row.get("latency_ms", 0.0),
        "model_error": row.get("model_error"),
        "post": row["post"],
        "evidence": {
            "text": ev["text"],
            "items": ev["items"],
            "relative": ev["relative"],
            "action_signature": ev["action_signature"],
            "multi_action": ev["multi_action"],
            "design": ev["design"],
            "unsupported": ev["unsupported"],
            "global_destructive": ev["global_destructive"],
        },
    }

def run_suite(name, cases, key):
    t0 = time.perf_counter()
    rows, batches = r.route_cases(cases, key, BATCH_SIZE)
    summary = r.summarize(rows, batches)
    summary["suite"] = name
    summary["wall_seconds"] = time.perf_counter() - t0
    write_json(os.path.join(OUT_DIR, f"{name}-summary.json"), summary)
    write_json(os.path.join(OUT_DIR, f"{name}-rows.json"), [compact_row(x) for x in rows])
    print("SUITE_SUMMARY=" + json.dumps(summary, ensure_ascii=False, sort_keys=True), flush=True)
    return rows, summary

def metamorphic_properties(rows):
    byid = {x["case"]["id"]: x for x in rows}
    props = []

    def comp(cid):
        return r.canonical_compiled(byid[cid]["post"]["compiled"])

    def add(name, ok, detail=None):
        props.append({"name": name, "ok": bool(ok), "detail": detail})

    add("number_2_5_equivalence", comp("meta_num_01") == comp("meta_num_02"))
    add("number_0_8_equivalence", comp("meta_num_03") == comp("meta_num_04"))
    add("number_1_25_equivalence", comp("meta_num_05") == comp("meta_num_06"))

    v1, v2 = comp("meta_vis_01"), comp("meta_vis_02")
    add("negation_flips_visibility",
        v1.get("op") == v2.get("op") == "part.visibility"
        and v1.get("args", {}).get("part_name") == v2.get("args", {}).get("part_name")
        and v1.get("args", {}).get("visible") is True
        and v2.get("args", {}).get("visible") is False)

    add("hide_synonyms_equivalent", comp("meta_vis_03") == comp("meta_vis_04"))

    a, b = comp("meta_rel_01"), comp("meta_rel_02")
    add("relative_add_subtract",
        a.get("args", {}).get("amount") == "4 mm"
        and b.get("args", {}).get("amount") == "2 mm")
    add("relative_vague_fails_closed", comp("meta_rel_03").get("route") == "ask")

    o1, o2 = comp("meta_order_01"), comp("meta_order_02")
    add("before_after_flip",
        o1.get("args", {}).get("placement") == "before"
        and o2.get("args", {}).get("placement") == "after")
    add("order_synonyms_before", comp("meta_order_01") == comp("meta_order_03"))
    add("order_synonyms_after", comp("meta_order_02") == comp("meta_order_04"))

    c1, c2 = comp("meta_cam_01"), comp("meta_cam_02")
    add("camera_correction_inverse",
        c1.get("args", {}).get("direction") == "right"
        and c2.get("args", {}).get("direction") == "left")
    add("quarter_turn_90", comp("meta_cam_03").get("args", {}).get("angle_degrees") == 90)

    add("multi_action_1_blocked", comp("meta_multi_01").get("route") == "ask")
    add("multi_action_2_blocked", comp("meta_multi_02").get("route") == "ask")

    add("design_1_reasoning", comp("meta_design_01").get("route") == "think")
    add("design_2_reasoning", comp("meta_design_02").get("route") == "think")
    add("design_3_reasoning", comp("meta_design_03").get("route") == "think")

    add("feature_name_word_digit_equivalent", comp("meta_id_01") == comp("meta_id_02"))
    add("part_name_word_digit_equivalent", comp("meta_id_03") == comp("meta_id_04"))

    return {
        "properties": len(props),
        "passed": sum(x["ok"] for x in props),
        "failed": [x for x in props if not x["ok"]],
        "all_passed": all(x["ok"] for x in props),
        "details": props,
    }

def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    key = os.environ.get("GROQ_API_KEY", "").strip()
    if not key:
        raise SystemExit("GROQ_API_KEY missing")

    known_rows, known = run_suite("known120", KNOWN, key)
    frozen_rows, frozen = run_suite("frozen96", FROZEN, key)
    meta_rows, meta = run_suite("metamorphic29", META, key)
    props = metamorphic_properties(meta_rows)
    write_json(os.path.join(OUT_DIR, "metamorphic-properties.json"), props)

    aggregate = {
        "architecture": known["architecture"],
        "known120": known,
        "frozen96": frozen,
        "metamorphic29": meta,
        "metamorphic_properties": props,
        "safety_gate": {
            "known_zero_wrong_material": known["wrong_material_accepted"] == 0,
            "known_zero_false_execute": known["false_execute"] == 0,
            "frozen_zero_wrong_material": frozen["wrong_material_accepted"] == 0,
            "frozen_zero_false_execute": frozen["false_execute"] == 0,
            "zero_provenance_violations": (
                known["provenance_violations"] == 0 and
                frozen["provenance_violations"] == 0 and
                meta["provenance_violations"] == 0
            ),
            "metamorphic_all_passed": props["all_passed"],
        },
    }
    aggregate["safety_gate"]["passed"] = all(aggregate["safety_gate"].values())
    write_json(os.path.join(OUT_DIR, "summary.json"), aggregate)
    print("FINAL_SUMMARY=" + json.dumps(aggregate, ensure_ascii=False, sort_keys=True), flush=True)

if __name__ == "__main__":
    main()
