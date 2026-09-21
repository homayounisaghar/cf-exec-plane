#!/usr/bin/env bash
set -euo pipefail
umask 077

[[ "$(id -u)" -eq 0 ]] || { echo "CF_QUARANTINE_REQUIRES_ROOT" >&2; exit 2; }

release="$(readlink -f /opt/capability-fabric/current)"
[[ "$release" == /var/lib/capability-fabric/releases/* ]] || exit 20
python3 - "$release/manifest.json" <<'PY'
import json,sys
m=json.load(open(sys.argv[1]))
assert m["sequence"] == 63, m
assert m["release_id"] == "onshape-vps-hardened-rollback-r1", m
print("CF_QUARANTINE_RELEASE=seq63")
PY

control=/var/lib/capability-fabric/onshape/runtime-control/ONSHAPE_RUNTIME_CONTROL.json
python3 - "$control" <<'PY'
import json,sys
r=json.load(open(sys.argv[1])); a=r["authority"]
assert r["controlRevision"] == 529
assert r["lease"]["state"] == "FREE"
assert a["productionEpoch"] == 1
assert a["mode"] == "ANDROID_PRODUCTION"
assert a["materialAuthority"] == "android-v1"
assert a["planes"]["vps-fabric"]["materialEffectsAllowed"] is False
print("CF_QUARANTINE_AUTHORITY=android-epoch1")
print("CF_QUARANTINE_LEASE=FREE")
PY

db=/var/lib/capability-fabric/onshape/fabric-state/execution.sqlite3
python3 - "$db" <<'PY'
import json,sqlite3,sys
db=sys.argv[1]
attempt="attempt:f6d80f46-b4ff-4798-9848-9b0b28bca1b8"
operation="operation:3cbb9823-a285-4d55-9cdc-cf57a2cb0cd2"
c=sqlite3.connect(f"file:{db}?mode=ro",uri=True); c.row_factory=sqlite3.Row
try:
    row=c.execute("""
      SELECT o.state AS operation_state,a.state AS attempt_state,
             a.observation_payload
      FROM operations o JOIN attempts a ON a.operation_id=o.operation_id
      WHERE o.operation_id=? AND a.attempt_id=?
    """,(operation,attempt)).fetchone()
    assert row is not None
    assert row["operation_state"] == "IN_DOUBT"
    assert row["attempt_state"] == "IN_DOUBT"
    obs=json.loads(row["observation_payload"])
    ev=obs.get("evidence") or {}
    assert "TimeoutError" in str(obs.get("detail") or "")
    assert ev.get("sequenceCompleted") is False
    assert ev.get("completedSteps") is None
    assert ev.get("effectSent") is None
    print("CF_QUARANTINE_SOURCE_STATE=IN_DOUBT")
    print("CF_QUARANTINE_SOURCE_EVIDENCE=ambiguous-ui-timeout")
finally:
    c.close()
PY

dir=/var/lib/capability-fabric/onshape/fabric-state/quarantine
mkdir -p "$dir"
chmod 0700 "$dir"
file="$dir/D-018-attempt-f6d80f46.json"
tmp="$file.tmp.$$"

cat >"$tmp" <<'JSON'
{
  "schema": "capability-fabric.onshape-quarantine.v1",
  "classification": "QUARANTINED",
  "decisionId": "D-018",
  "decisionFileBlobSha": "b0cccadac1ce89cf07ae7be5c5cad3b3b7823446",
  "decisionCommit": "d3ddff985a024e73c8e2006a64cd0ffe96006efc",
  "operatorApprovalReference": "operator-chat-2026-09-21T07:49:10Z",
  "attemptId": "attempt:f6d80f46-b4ff-4798-9848-9b0b28bca1b8",
  "operationId": "operation:3cbb9823-a285-4d55-9cdc-cf57a2cb0cd2",
  "effect": "onshape.ui.input.sequence.mutation_risk",
  "historicalOutcome": "UNPROVEN",
  "replayAllowed": false,
  "gateExceptionScope": "THIS_EXACT_ATTEMPT_AND_OPERATION_ONLY",
  "auditVisibilityRequired": true
}
JSON
chmod 0600 "$tmp"

python3 - "$tmp" <<'PY'
import json,sys
v=json.load(open(sys.argv[1]))
assert v == {
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
print("CF_QUARANTINE_RECORD_VALID=pass")
PY

if [[ -e "$file" ]]; then
  cmp -s "$tmp" "$file" || { echo "CF_QUARANTINE_EXISTING_MISMATCH" >&2; rm -f "$tmp"; exit 24; }
  rm -f "$tmp"
  echo CF_QUARANTINE_WRITE=UNCHANGED
else
  mv "$tmp" "$file"
  chown root:root "$file"
  chmod 0600 "$file"
  echo CF_QUARANTINE_WRITE=CHANGED
fi

sha="$(sha256sum "$file" | awk '{print $1}')"
echo "CF_QUARANTINE_RECORD_SHA256=$sha"
echo CF_QUARANTINE_CLASSIFICATION=QUARANTINED
echo CF_QUARANTINE_DECISION=D-018
echo CF_QUARANTINE_REPLAY_ALLOWED=false
echo CF_QUARANTINE=pass
