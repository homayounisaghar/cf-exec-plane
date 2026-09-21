#!/usr/bin/env bash
set -euo pipefail
umask 077

[[ "$(id -u)" -eq 0 ]] || { echo "CF_PREQUIESCE_REQUIRES_ROOT" >&2; exit 2; }

release="$(readlink -f /opt/capability-fabric/current)"
[[ "$release" == /var/lib/capability-fabric/releases/* ]] || exit 20
python3 - "$release/manifest.json" <<'PY'
import json,sys
m=json.load(open(sys.argv[1]))
assert m["sequence"] == 63, m
assert m["release_id"] == "onshape-vps-hardened-rollback-r1", m
print("CF_PREQUIESCE_RELEASE=seq63")
PY

[[ ! -e /var/lib/capability-fabric/state/release-in-progress ]] || {
  echo "CF_PREQUIESCE_RELEASE_GATE=active" >&2
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
assert a["planes"]["android-v1"]["ingress"] == "ADMITTED", a
assert a["planes"]["android-v1"]["materialEffectsAllowed"] is True, a
assert a["planes"]["vps-fabric"]["ingress"] == "SHADOW", a
assert a["planes"]["vps-fabric"]["materialEffectsAllowed"] is False, a
assert a["reconciliationHold"]["active"] is False, a
print("CF_PREQUIESCE_AUTHORITY=android-epoch1")
print("CF_PREQUIESCE_LEASE=FREE")
PY

db=/var/lib/capability-fabric/onshape/fabric-state/execution.sqlite3
quarantine=/var/lib/capability-fabric/onshape/fabric-state/quarantine/D-018-attempt-f6d80f46.json
[[ -s "$db" && -s "$quarantine" ]] || exit 23
python3 - "$db" "$quarantine" <<'PY'
import json,os,sqlite3,sys
db,qpath=sys.argv[1:3]
expected={
  "schema":"capability-fabric.onshape-quarantine.v1",
  "classification":"QUARANTINED",
  "decisionId":"D-018",
  "decisionFileBlobSha":"b0cccadac1ce89cf07ae7be5c5cad3b3b7823446",
  "decisionCommit":"d3ddff985a024e73c8e2006a64cd0ffe96006efc",
  "operatorApprovalReference":"operator-chat-2026-09-21T07:49:10Z",
  "attemptId":"attempt:f6d80f46-b4ff-4798-9848-9b0b28bca1b8",
  "operationId":"operation:3cbb9823-a285-4d55-9cdc-cf57a2cb0cd2",
  "effect":"onshape.ui.input.sequence.mutation_risk",
  "historicalOutcome":"UNPROVEN",
  "replayAllowed":False,
  "gateExceptionScope":"THIS_EXACT_ATTEMPT_AND_OPERATION_ONLY",
  "auditVisibilityRequired":True,
}
st=os.stat(qpath)
assert (st.st_mode & 0o777) == 0o600, oct(st.st_mode & 0o777)
q=json.load(open(qpath))
assert q == expected, q
attempt=q["attemptId"]; operation=q["operationId"]

c=sqlite3.connect(f"file:{db}?mode=ro",uri=True)
c.row_factory=sqlite3.Row
try:
    integrity=c.execute("PRAGMA integrity_check").fetchone()[0]
    if str(integrity).lower()!="ok":
        raise SystemExit("sqlite integrity failed")

    rows=c.execute("""
      SELECT i.invocation_id,i.phase,
             o.operation_id,o.state AS operation_state,o.outcome_payload,
             a.attempt_id,a.state AS attempt_state,a.observation_payload
      FROM invocations i
      LEFT JOIN operations o ON o.invocation_id=i.invocation_id
      LEFT JOIN attempts a ON a.operation_id=o.operation_id
      WHERE i.phase IN ('DISPATCH_FINALIZED','DISPATCH_INTENT','OBSERVED')
      ORDER BY i.rowid
    """).fetchall()

    raw_recoverable=len(rows)
    quarantined_rows=[]
    blocking=[]
    for r in rows:
        exact=(r["operation_id"]==operation and r["attempt_id"]==attempt)
        if exact:
            assert r["phase"] == "OBSERVED", dict(r)
            assert r["operation_state"] == "IN_DOUBT", dict(r)
            assert r["attempt_state"] == "IN_DOUBT", dict(r)
            assert r["outcome_payload"] is None, dict(r)
            assert r["observation_payload"] is not None, dict(r)
            quarantined_rows.append(r)
        else:
            blocking.append(r)

    assert len(quarantined_rows) == 1, len(quarantined_rows)

    in_doubt_ops=c.execute("SELECT operation_id FROM operations WHERE state='IN_DOUBT'").fetchall()
    in_doubt_attempts=c.execute("SELECT attempt_id,operation_id FROM attempts WHERE state='IN_DOUBT'").fetchall()
    in_flight_ops=c.execute("SELECT operation_id FROM operations WHERE state='IN_FLIGHT'").fetchall()
    dispatch_attempts=c.execute("SELECT attempt_id,operation_id FROM attempts WHERE state='DISPATCH_INTENT'").fetchall()

    other_in_doubt_ops=[r for r in in_doubt_ops if r["operation_id"]!=operation]
    other_in_doubt_attempts=[r for r in in_doubt_attempts if not (r["attempt_id"]==attempt and r["operation_id"]==operation)]

    if blocking or other_in_doubt_ops or other_in_doubt_attempts or in_flight_ops or dispatch_attempts:
        raise SystemExit(
          "blocking fabric state remains: "
          f"recoverable={len(blocking)} "
          f"in_doubt_ops={len(other_in_doubt_ops)} "
          f"in_doubt_attempts={len(other_in_doubt_attempts)} "
          f"in_flight_ops={len(in_flight_ops)} "
          f"dispatch_attempts={len(dispatch_attempts)}"
        )

    print("CF_PREQUIESCE_SQLITE_INTEGRITY=pass")
    print("CF_PREQUIESCE_QUARANTINE_DECISION=D-018")
    print("CF_PREQUIESCE_QUARANTINE_EXACT_MATCH=pass")
    print("CF_PREQUIESCE_FABRIC_RECOVERABLE_RAW="+str(raw_recoverable))
    print("CF_PREQUIESCE_FABRIC_QUARANTINED=1")
    print("CF_PREQUIESCE_FABRIC_RECOVERABLE=0")
    print("CF_PREQUIESCE_FABRIC_IN_DOUBT_RAW_OPS="+str(len(in_doubt_ops)))
    print("CF_PREQUIESCE_FABRIC_IN_DOUBT_RAW_ATTEMPTS="+str(len(in_doubt_attempts)))
    print("CF_PREQUIESCE_FABRIC_IN_DOUBT=0")
    print("CF_PREQUIESCE_FABRIC_IN_FLIGHT=0")
finally:
    c.close()
PY

agent_dir=/var/lib/capability-fabric/onshape/fabric-agent
python3 - "$agent_dir" "$quarantine" <<'PY'
import json,sys,pathlib
root=pathlib.Path(sys.argv[1])
q=json.load(open(sys.argv[2]))
attempt=q["attemptId"]
raw_unresolved=[]
blocking=[]
quarantined=[]
terminal=0
for p in root.glob("*.json"):
    try:
        v=json.loads(p.read_text())
    except Exception:
        continue
    state=str(v.get("state",""))
    aid=str(v.get("attemptId") or "")
    if state in {"EXECUTING","UNCERTAIN"}:
        raw_unresolved.append((p.name,state,aid))
        if aid==attempt and state=="UNCERTAIN":
            quarantined.append((p.name,state,aid))
        else:
            blocking.append((p.name,state,aid))
    elif state in {"SUCCEEDED","REJECTED"}:
        terminal += 1
if len(quarantined)!=1:
    raise SystemExit("exact quarantined agent record missing or duplicated: "+repr(quarantined))
if blocking:
    raise SystemExit("unresolved agent records: "+repr(blocking))
print("CF_PREQUIESCE_AGENT_UNRESOLVED_RAW="+str(len(raw_unresolved)))
print("CF_PREQUIESCE_AGENT_QUARANTINED=1")
print("CF_PREQUIESCE_AGENT_UNRESOLVED=0")
print("CF_PREQUIESCE_AGENT_TERMINAL_RECORDS="+str(terminal))
PY

echo CF_PREQUIESCE_SNAPSHOT=pass
