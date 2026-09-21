#!/usr/bin/env bash
set -euo pipefail
umask 077

[[ "$(id -u)" -eq 0 ]] || { echo "CF_PREQUIESCE_INVENTORY_REQUIRES_ROOT" >&2; exit 2; }

release="$(readlink -f /opt/capability-fabric/current)"
[[ "$release" == /var/lib/capability-fabric/releases/* ]] || exit 20
python3 - "$release/manifest.json" <<'PY'
import json,sys
m=json.load(open(sys.argv[1]))
assert m["sequence"] == 63, m
assert m["release_id"] == "onshape-vps-hardened-rollback-r1", m
print("CF_PREQUIESCE_INVENTORY_RELEASE=seq63")
PY

[[ ! -e /var/lib/capability-fabric/state/release-in-progress ]] || {
  echo "CF_PREQUIESCE_INVENTORY_RELEASE_GATE=active" >&2
  exit 21
}

control=/var/lib/capability-fabric/onshape/runtime-control/ONSHAPE_RUNTIME_CONTROL.json
[[ -s "$control" ]] || exit 22
python3 - "$control" <<'PY'
import json,sys
r=json.load(open(sys.argv[1]))
a=r["authority"]
assert r["controlRevision"] == 529, r["controlRevision"]
assert r["lease"]["state"] == "FREE", r["lease"]
assert a["productionEpoch"] == 1, a
assert a["mode"] == "ANDROID_PRODUCTION", a
assert a["materialAuthority"] == "android-v1", a
assert a["planes"]["android-v1"]["materialEffectsAllowed"] is True, a
assert a["planes"]["vps-fabric"]["materialEffectsAllowed"] is False, a
assert a["reconciliationHold"]["active"] is False, a
print("CF_PREQUIESCE_INVENTORY_AUTHORITY=android-epoch1")
print("CF_PREQUIESCE_INVENTORY_LEASE=FREE")
PY

db=/var/lib/capability-fabric/onshape/fabric-state/execution.sqlite3
agent_dir=/var/lib/capability-fabric/onshape/fabric-agent
[[ -s "$db" ]] || exit 23

python3 - "$db" "$agent_dir" <<'PY'
import hashlib,json,pathlib,sqlite3,sys

db,agent_dir=sys.argv[1],pathlib.Path(sys.argv[2])
c=sqlite3.connect(f"file:{db}?mode=ro",uri=True)
c.row_factory=sqlite3.Row
try:
    integrity=c.execute("PRAGMA integrity_check").fetchone()[0]
    if str(integrity).lower()!="ok":
        raise SystemExit("sqlite integrity failed")
    rows=c.execute("""
        SELECT i.invocation_id,i.phase,i.dispatch_payload,
               o.operation_id,o.payload AS operation_payload,o.state AS operation_state,
               a.attempt_id,a.ordinal,a.state AS attempt_state,a.observation_payload
        FROM invocations i
        LEFT JOIN operations o ON o.invocation_id=i.invocation_id
        LEFT JOIN attempts a ON a.operation_id=o.operation_id
        WHERE i.phase IN ('DISPATCH_FINALIZED','DISPATCH_INTENT','OBSERVED')
           OR o.state IN ('IN_FLIGHT','IN_DOUBT')
           OR a.state IN ('DISPATCH_INTENT','IN_DOUBT')
        ORDER BY i.invocation_id,o.operation_id,a.ordinal
        LIMIT 20
    """).fetchall()
    print("CF_PREQUIESCE_INVENTORY_COUNT="+str(len(rows)))
    for idx,row in enumerate(rows,1):
        op_payload=json.loads(row["operation_payload"]) if row["operation_payload"] else {}
        dispatch=json.loads(row["dispatch_payload"]) if row["dispatch_payload"] else {}
        effect=str(op_payload.get("effect") or dispatch.get("effect") or "UNKNOWN")
        attempt_id=row["attempt_id"]
        agent_state="MISSING"
        agent_observation="none"
        agent_effect_sent="unknown"
        if attempt_id:
            name=hashlib.sha256(str(attempt_id).encode()).hexdigest()+".json"
            p=agent_dir/name
            if p.is_file():
                try:
                    agent=json.loads(p.read_text())
                    if agent.get("attemptId") != attempt_id:
                        agent_state="IDENTITY_MISMATCH"
                    else:
                        agent_state=str(agent.get("state","UNKNOWN"))
                        obs=agent.get("observation")
                        if isinstance(obs,dict):
                            agent_observation=str(obs.get("state","UNKNOWN"))
                            evidence=obs.get("evidence")
                            if isinstance(evidence,dict) and "effectSent" in evidence:
                                agent_effect_sent=str(evidence.get("effectSent")).lower()
                except Exception:
                    agent_state="INVALID_JSON"
        item={
            "index":idx,
            "invocationId":row["invocation_id"],
            "operationId":row["operation_id"],
            "attemptId":attempt_id,
            "attemptOrdinal":row["ordinal"],
            "effect":effect,
            "invocationPhase":row["phase"],
            "operationState":row["operation_state"],
            "attemptState":row["attempt_state"],
            "storedObservation": row["observation_payload"] is not None,
            "agentRecordState":agent_state,
            "agentObservationState":agent_observation,
            "agentEffectSent":agent_effect_sent,
        }
        print("CF_PREQUIESCE_INVENTORY_ITEM="+json.dumps(item,sort_keys=True,separators=(",",":")))
finally:
    c.close()
PY

echo CF_PREQUIESCE_INVENTORY=pass
