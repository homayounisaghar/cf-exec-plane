#!/usr/bin/env python3
from __future__ import annotations

import json
from pathlib import Path
import sys

RUNTIME_SCHEMA = "capability-fabric.onshape-runtime-control.v1"
AUTHORITY_SCHEMA = "capability-fabric.onshape-production-authority.v1"
MODES = {"ANDROID_PRODUCTION", "QUIESCED_RECONCILING", "VPS_PRODUCTION"}


def fail(msg: str) -> None:
    raise SystemExit(msg)


def load(path: str) -> tuple[bytes, dict]:
    raw = Path(path).read_bytes()
    try:
        root = json.loads(raw.decode("utf-8"))
    except Exception as exc:
        fail(f"runtime control invalid json: {exc}")
    if not isinstance(root, dict):
        fail("runtime control root must be object")
    if root.get("schema") != RUNTIME_SCHEMA:
        fail("runtime control schema mismatch")
    rev = root.get("controlRevision")
    if not isinstance(rev, int) or isinstance(rev, bool) or rev <= 0:
        fail("controlRevision invalid")
    return raw, root


def parse(root: dict) -> dict:
    routing = root.get("routing")
    lease = root.get("lease")
    authority = root.get("authority")
    if not isinstance(routing, dict) or not isinstance(lease, dict) or not isinstance(authority, dict):
        fail("routing/lease/authority required")
    if authority.get("schema") != AUTHORITY_SCHEMA:
        fail("authority schema mismatch")

    epoch = authority.get("productionEpoch")
    mode = authority.get("mode")
    material = authority.get("materialAuthority")
    if not isinstance(epoch, int) or isinstance(epoch, bool) or epoch <= 0:
        fail("productionEpoch invalid")
    if mode not in MODES:
        fail("authority mode invalid")

    planes = authority.get("planes")
    if not isinstance(planes, dict):
        fail("authority planes missing")
    android = planes.get("android-v1")
    vps = planes.get("vps-fabric")
    if not isinstance(android, dict) or not isinstance(vps, dict):
        fail("authority planes incomplete")

    aa = android.get("materialEffectsAllowed")
    va = vps.get("materialEffectsAllowed")
    ai = android.get("ingress")
    vi = vps.get("ingress")
    if not isinstance(aa, bool) or not isinstance(va, bool):
        fail("material flags invalid")
    if not isinstance(ai, str) or not ai or not isinstance(vi, str) or not vi:
        fail("ingress invalid")

    rstate = routing.get("state")
    rallowed = routing.get("materialCommandsAllowed")
    bus = routing.get("busGeneration")
    mailbox = routing.get("activeMailboxIssue")
    abus = android.get("busGeneration")
    if not isinstance(rstate, str) or not isinstance(rallowed, bool):
        fail("legacy routing invalid")
    for name, value in (("routing busGeneration", bus), ("android busGeneration", abus), ("activeMailboxIssue", mailbox)):
        if not isinstance(value, int) or isinstance(value, bool) or value <= 0:
            fail(f"{name} invalid")
    if bus != abus:
        fail("legacy/authority Android busGeneration mismatch")

    raw_guard = authority.get("productionGuard")
    guard = None
    if raw_guard is not None:
        if not isinstance(raw_guard, dict):
            fail("productionGuard must be object")
        if raw_guard.get("schema") != "capability-fabric.onshape-production-guard.v1":
            fail("productionGuard schema invalid")
        generation = raw_guard.get("generation")
        kill_switch = raw_guard.get("killSwitch")
        allowed = raw_guard.get("allowedDocumentIds")
        budget = raw_guard.get("mutationBudget")
        if not isinstance(generation, int) or isinstance(generation, bool) or generation <= 0:
            fail("productionGuard generation invalid")
        if kill_switch not in {"OPEN", "ENGAGED"}:
            fail("productionGuard killSwitch invalid")
        if not isinstance(allowed, list):
            fail("productionGuard allowedDocumentIds invalid")
        normalized_allowed = []
        for value in allowed:
            if not isinstance(value, str) or len(value) != 24 or any(c not in "0123456789abcdefABCDEF" for c in value):
                fail("productionGuard allowed document id invalid")
            normalized_allowed.append(value.lower())
        if len(set(normalized_allowed)) != len(normalized_allowed):
            fail("productionGuard allowedDocumentIds duplicate")
        if not isinstance(budget, dict):
            fail("productionGuard mutationBudget invalid")
        budget_id = budget.get("budgetId")
        max_mutations = budget.get("maxMutations")
        if not isinstance(budget_id, str) or not budget_id or len(budget_id) > 128:
            fail("productionGuard budgetId invalid")
        if any(c not in "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._:-" for c in budget_id):
            fail("productionGuard budgetId invalid")
        if not isinstance(max_mutations, int) or isinstance(max_mutations, bool) or not (0 <= max_mutations <= 100000):
            fail("productionGuard maxMutations invalid")
        guard = {
            "schema": raw_guard["schema"],
            "generation": generation,
            "killSwitch": kill_switch,
            "allowedDocumentIds": tuple(sorted(normalized_allowed)),
            "budgetId": budget_id,
            "maxMutations": max_mutations,
        }

    if mode == "ANDROID_PRODUCTION":
        if material != "android-v1" or not aa or va or ai != "ADMITTED":
            fail("ANDROID_PRODUCTION authority invariant failed")
        if rstate != "ADMITTED" or not rallowed:
            fail("Android legacy ingress is not admitted with authority")
    elif mode == "QUIESCED_RECONCILING":
        if material is not None or aa or va:
            fail("QUIESCED_RECONCILING authority invariant failed")
        if rstate == "ADMITTED" or rallowed:
            fail("Android legacy ingress not closed while quiesced")
    elif mode == "VPS_PRODUCTION":
        if material != "vps-fabric" or aa or not va or vi != "ADMITTED":
            fail("VPS_PRODUCTION authority invariant failed")
        if rstate == "ADMITTED" or rallowed:
            fail("Android legacy ingress not closed in VPS_PRODUCTION")
        seq = vps.get("releaseSequence")
        rid = vps.get("releaseId")
        msh = vps.get("manifestSha256")
        if not isinstance(seq, int) or isinstance(seq, bool) or seq <= 0:
            fail("VPS release sequence invalid")
        if not isinstance(rid, str) or not rid:
            fail("VPS release id invalid")
        if not isinstance(msh, str) or len(msh) != 64 or any(c not in "0123456789abcdefABCDEF" for c in msh):
            fail("VPS manifest hash invalid")

    return {
        "revision": root["controlRevision"],
        "epoch": epoch,
        "mode": mode,
        "material": material,
        "android_allowed": aa,
        "vps_allowed": va,
        "android_ingress": ai,
        "vps_ingress": vi,
        "bus": bus,
        "mailbox": mailbox,
        "lease_state": str(lease.get("state") or ""),
        "guard": guard,
    }


def transition(previous_raw: bytes, previous: dict, candidate_raw: bytes, candidate: dict) -> None:
    p = parse(previous)
    n = parse(candidate)

    if candidate_raw == previous_raw:
        print("CF_AUTH_GUARD_IDENTICAL=pass")
        return

    if n["revision"] <= p["revision"]:
        fail("controlRevision must increase when control bytes change")
    if n["epoch"] < p["epoch"]:
        fail("productionEpoch decrease rejected")
    if n["bus"] < p["bus"]:
        fail("Android busGeneration decrease rejected")

    fence_changed = (
        n["mode"] != p["mode"]
        or n["material"] != p["material"]
        or n["android_allowed"] != p["android_allowed"]
        or n["vps_allowed"] != p["vps_allowed"]
        or n["android_ingress"] != p["android_ingress"]
        or n["vps_ingress"] != p["vps_ingress"]
        or n["guard"] != p["guard"]
    )

    if fence_changed and n["epoch"] <= p["epoch"]:
        fail("authority/fence transition requires strictly newer productionEpoch")
    if not fence_changed and n["epoch"] != p["epoch"]:
        fail("productionEpoch may change only for authority/fence transition")

    if p["mode"] == "ANDROID_PRODUCTION" and n["mode"] == "VPS_PRODUCTION":
        fail("direct Android-to-VPS authority transfer forbidden; quiesce required")
    if p["mode"] == "VPS_PRODUCTION" and n["mode"] == "ANDROID_PRODUCTION":
        fail("direct VPS-to-Android authority transfer forbidden; quiesce required")

    reopening_android = (not p["android_allowed"]) and n["android_allowed"]
    if reopening_android:
        if n["epoch"] <= p["epoch"]:
            fail("Android reopen requires newer productionEpoch")
        if n["bus"] <= p["bus"]:
            fail("Android reopen requires newer busGeneration")
        if n["mailbox"] == p["mailbox"]:
            fail("Android reopen requires new mailbox issue")
        if n["lease_state"] != "FREE":
            fail("Android reopen requires FREE lease")

    if n["bus"] > p["bus"]:
        if n["mailbox"] == p["mailbox"]:
            fail("busGeneration increase requires new mailbox issue")
        if n["lease_state"] != "FREE":
            fail("ordinary bus rollover requires FREE lease")

    print("CF_AUTH_GUARD_PREVIOUS_EPOCH="+str(p["epoch"]))
    print("CF_AUTH_GUARD_CANDIDATE_EPOCH="+str(n["epoch"]))
    print("CF_AUTH_GUARD_PREVIOUS_BUS="+str(p["bus"]))
    print("CF_AUTH_GUARD_CANDIDATE_BUS="+str(n["bus"]))
    print("CF_AUTH_GUARD_FENCE_CHANGED="+str(fence_changed).lower())
    print("CF_AUTH_GUARD_POLICY_CHANGED="+str(n["guard"] != p["guard"]).lower())
    print("CF_AUTH_GUARD_TRANSITION=pass")


def main() -> None:
    if len(sys.argv) not in (2, 3):
        fail("usage: runtime_control_guard.py <candidate> OR <previous> <candidate>")
    if len(sys.argv) == 2:
        raw, root = load(sys.argv[1])
        parse(root)
        print("CF_AUTH_GUARD_CANDIDATE_ONLY=pass")
        return
    praw, proot = load(sys.argv[1])
    nraw, nroot = load(sys.argv[2])
    transition(praw, proot, nraw, nroot)


if __name__ == "__main__":
    main()
