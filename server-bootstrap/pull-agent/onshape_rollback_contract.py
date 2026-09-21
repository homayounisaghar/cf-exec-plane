#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
from pathlib import Path
import sqlite3
import sys

Q_ATTEMPT="attempt:f6d80f46-b4ff-4798-9848-9b0b28bca1b8"
Q_OPERATION="operation:3cbb9823-a285-4d55-9cdc-cf57a2cb0cd2"


def die(msg: str, code: int = 2) -> None:
    print(msg, file=sys.stderr)
    raise SystemExit(code)


def load_json(path: str) -> dict:
    v=json.loads(Path(path).read_text())
    if not isinstance(v,dict):
        die(f"not an object: {path}")
    return v


def authority(path: str) -> dict:
    root=load_json(path)
    a=root.get("authority") or {}
    planes=a.get("planes") or {}
    android=planes.get("android-v1") or {}
    vps=planes.get("vps-fabric") or {}
    return {
      "revision":root.get("controlRevision"),
      "epoch":a.get("productionEpoch"),
      "mode":a.get("mode"),
      "material":a.get("materialAuthority"),
      "android_ingress":android.get("ingress"),
      "android_allowed":android.get("materialEffectsAllowed"),
      "vps_ingress":vps.get("ingress"),
      "vps_allowed":vps.get("materialEffectsAllowed"),
      "bus":(root.get("routing") or {}).get("busGeneration"),
      "mailbox":(root.get("routing") or {}).get("activeMailboxIssue"),
      "lease":(root.get("lease") or {}).get("state"),
    }


def quarantine(path: str | None) -> tuple[str,str] | None:
    if not path:
        return None
    v=load_json(path)
    assert v["schema"]=="capability-fabric.onshape-quarantine.v1"
    assert v["classification"]=="QUARANTINED"
    assert v["decisionId"]=="D-018"
    assert v["attemptId"]==Q_ATTEMPT
    assert v["operationId"]==Q_OPERATION
    assert v["replayAllowed"] is False
    assert v["gateExceptionScope"]=="THIS_EXACT_ATTEMPT_AND_OPERATION_ONLY"
    return Q_ATTEMPT,Q_OPERATION


def db_state(path: str, q: tuple[str,str] | None) -> dict:
    c=sqlite3.connect(f"file:{path}?mode=ro",uri=True)
    c.row_factory=sqlite3.Row
    try:
        if str(c.execute("PRAGMA integrity_check").fetchone()[0]).lower()!="ok":
            die("sqlite integrity failed")

        rows=c.execute("""
          SELECT i.rowid AS invocation_rowid,i.phase,i.dispatch_payload,
                 o.operation_id,o.state AS operation_state,o.outcome_payload,
                 a.attempt_id,a.state AS attempt_state
          FROM invocations i
          LEFT JOIN operations o ON o.invocation_id=i.invocation_id
          LEFT JOIN attempts a ON a.operation_id=o.operation_id
          ORDER BY i.rowid
        """).fetchall()

        ponr=[]
        raw_unresolved=[]
        blocking=[]
        for r in rows:
            dispatch={}
            if r["dispatch_payload"]:
                dispatch=json.loads(r["dispatch_payload"])
            ep=dispatch.get("execution_payload") or {}
            pre=ep.get("preconditions") or {}
            pa=pre.get("productionAuthority") or {}
            production_mutation=(
              ep.get("agentEffect")=="MUTATION"
              and pa.get("materialAuthority")=="vps-fabric"
              and pa.get("mode")=="VPS_PRODUCTION"
              and isinstance(pa.get("productionEpoch"),int)
            )
            if production_mutation and r["operation_state"]=="ACHIEVED":
                ponr.append({
                  "rowid":r["invocation_rowid"],
                  "operationId":r["operation_id"],
                  "attemptId":r["attempt_id"],
                  "epoch":pa.get("productionEpoch"),
                })

            unresolved=(
              r["phase"] in ("DISPATCH_FINALIZED","DISPATCH_INTENT","OBSERVED")
              or r["operation_state"] in ("IN_FLIGHT","IN_DOUBT")
              or r["attempt_state"] in ("DISPATCH_INTENT","IN_DOUBT")
            )
            if unresolved:
                item=(str(r["attempt_id"] or ""),str(r["operation_id"] or ""),str(r["phase"]))
                raw_unresolved.append(item)
                if q is None or item[:2] != q:
                    blocking.append(item)

        ponr.sort(key=lambda x:x["rowid"])
        return {
          "ponr":ponr,
          "raw_unresolved":raw_unresolved,
          "blocking_unresolved":blocking,
        }
    finally:
        c.close()


def assert_both_closed(a: dict) -> None:
    if not (
      a["material"] is None
      and a["android_allowed"] is False
      and a["vps_allowed"] is False
      and a["android_ingress"]!="ADMITTED"
      and a["vps_ingress"]!="ADMITTED"
    ):
        die("both material ingresses must remain closed while reconciliation hold is required",31)


def decide(args) -> None:
    q=quarantine(args.quarantine)
    s=db_state(args.db,q)
    a=authority(args.control)
    ponr=bool(s["ponr"])
    unresolved=len(s["blocking_unresolved"])

    print("CF_A4_PONR="+("true" if ponr else "false"))
    print("CF_A4_PONR_COUNT="+str(len(s["ponr"])))
    if ponr:
        first=s["ponr"][0]
        print("CF_A4_FIRST_PRODUCTION_MUTATION_OPERATION="+first["operationId"])
        print("CF_A4_FIRST_PRODUCTION_MUTATION_ATTEMPT="+first["attemptId"])
        print("CF_A4_FIRST_PRODUCTION_MUTATION_EPOCH="+str(first["epoch"]))
    print("CF_A4_UNRESOLVED_RAW="+str(len(s["raw_unresolved"])))
    print("CF_A4_UNRESOLVED_BLOCKING="+str(unresolved))
    if q is not None:
        print("CF_A4_QUARANTINE_D018=recognized")

    # Any unresolved execution state makes reopening either material ingress
    # unsafe. This is stricter than the minimum post-PONR rule.
    if unresolved:
        assert_both_closed(a)
        print("CF_A4_ROLLBACK_DIRECTIVE=HOLD_BOTH_CLOSED")
        print("CF_A4_RECONCILIATION_HOLD=pass")
        return

    print("CF_A4_ZERO_UNRESOLVED=pass")
    print("CF_A4_ROLLBACK_DIRECTIVE=ROLLBACK_ALLOWED")
    print("CF_A4_ROLLBACK_DECISION=pass")


def transition(args) -> None:
    prev=authority(args.previous)
    nxt=authority(args.candidate)
    if not isinstance(prev["epoch"],int) or not isinstance(nxt["epoch"],int):
        die("invalid epoch")
    if nxt["epoch"] <= prev["epoch"]:
        die("rollback/authority transition must advance productionEpoch",40)
    if prev["mode"]=="VPS_PRODUCTION" and nxt["mode"]=="ANDROID_PRODUCTION":
        die("direct VPS-to-Android transition forbidden; quiesced intermediate required",41)
    if nxt["mode"]=="ANDROID_PRODUCTION":
        if not (nxt["android_allowed"] is True and nxt["vps_allowed"] is False and nxt["lease"]=="FREE"):
            die("Android rollback target invariants failed",42)
        if not isinstance(prev["bus"],int) or not isinstance(nxt["bus"],int) or nxt["bus"] <= prev["bus"]:
            die("Android rollback requires newer busGeneration",43)
        if nxt["mailbox"] == prev["mailbox"]:
            die("Android rollback requires a new mailbox",44)
    print("CF_A4_ROLLBACK_PREVIOUS_EPOCH="+str(prev["epoch"]))
    print("CF_A4_ROLLBACK_CANDIDATE_EPOCH="+str(nxt["epoch"]))
    print("CF_A4_ROLLBACK_TRANSITION=pass")


def main():
    ap=argparse.ArgumentParser()
    sub=ap.add_subparsers(dest="cmd",required=True)
    d=sub.add_parser("decide")
    d.add_argument("--db",required=True)
    d.add_argument("--control",required=True)
    d.add_argument("--quarantine")
    t=sub.add_parser("transition")
    t.add_argument("--previous",required=True)
    t.add_argument("--candidate",required=True)
    args=ap.parse_args()
    if args.cmd=="decide": decide(args)
    else: transition(args)


if __name__=="__main__":
    main()
