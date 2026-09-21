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
[[ -s "$db" ]] || exit 23
python3 - "$db" <<'PY'
import sqlite3,sys
db=sys.argv[1]
c=sqlite3.connect(f"file:{db}?mode=ro",uri=True)
try:
    integrity=c.execute("PRAGMA integrity_check").fetchone()[0]
    if str(integrity).lower()!="ok":
        raise SystemExit("sqlite integrity failed")
    recoverable=c.execute(
        "SELECT COUNT(*) FROM invocations WHERE phase IN ('DISPATCH_FINALIZED','DISPATCH_INTENT','OBSERVED')"
    ).fetchone()[0]
    in_doubt_ops=c.execute("SELECT COUNT(*) FROM operations WHERE state='IN_DOUBT'").fetchone()[0]
    in_doubt_attempts=c.execute("SELECT COUNT(*) FROM attempts WHERE state='IN_DOUBT'").fetchone()[0]
    in_flight_ops=c.execute("SELECT COUNT(*) FROM operations WHERE state='IN_FLIGHT'").fetchone()[0]
    dispatch_attempts=c.execute("SELECT COUNT(*) FROM attempts WHERE state='DISPATCH_INTENT'").fetchone()[0]
    if any(int(x)!=0 for x in [recoverable,in_doubt_ops,in_doubt_attempts,in_flight_ops,dispatch_attempts]):
        raise SystemExit(f"unresolved fabric state: recoverable={recoverable} in_doubt_ops={in_doubt_ops} in_doubt_attempts={in_doubt_attempts} in_flight_ops={in_flight_ops} dispatch_attempts={dispatch_attempts}")
    print("CF_PREQUIESCE_SQLITE_INTEGRITY=pass")
    print("CF_PREQUIESCE_FABRIC_RECOVERABLE=0")
    print("CF_PREQUIESCE_FABRIC_IN_DOUBT=0")
    print("CF_PREQUIESCE_FABRIC_IN_FLIGHT=0")
finally:
    c.close()
PY

agent_dir=/var/lib/capability-fabric/onshape/fabric-agent
python3 - "$agent_dir" <<'PY'
import json,sys,pathlib
root=pathlib.Path(sys.argv[1])
unresolved=[]
terminal=0
for p in root.glob("*.json"):
    try:
        v=json.loads(p.read_text())
    except Exception:
        continue
    state=str(v.get("state",""))
    if state in {"EXECUTING","UNCERTAIN"}:
        unresolved.append((p.name,state,v.get("attemptId")))
    elif state in {"SUCCEEDED","REJECTED"}:
        terminal += 1
if unresolved:
    raise SystemExit("unresolved agent records: "+repr(unresolved))
print("CF_PREQUIESCE_AGENT_UNRESOLVED=0")
print("CF_PREQUIESCE_AGENT_TERMINAL_RECORDS="+str(terminal))
PY

echo CF_PREQUIESCE_SNAPSHOT=pass
