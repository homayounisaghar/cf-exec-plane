#!/usr/bin/env bash
set -euo pipefail
umask 077

[[ "$(id -u)" -eq 0 ]] || { echo CF_P3_REQUIRES_ROOT >&2; exit 2; }

active=/opt/capability-fabric/current
candidate=/var/lib/capability-fabric/releases/onshape-vps-hardened-production-r3
control=/var/lib/capability-fabric/onshape/runtime-control/ONSHAPE_RUNTIME_CONTROL.json
db=/var/lib/capability-fabric/onshape/fabric-state/execution.sqlite3
agent_dir=/var/lib/capability-fabric/onshape/fabric-agent
quarantine=/var/lib/capability-fabric/onshape/fabric-state/quarantine/D-018-attempt-f6d80f46.json
gate=/var/lib/capability-fabric/state/release-in-progress
expected_candidate_sha=857b7ca6d5a6bcf79b820594801a4f88642fe9520dad1ae18fc064eae6073d7c

[[ -L "$active" && -d "$candidate" && -s "$control" && -s "$db" && -s "$quarantine" ]] || exit 20
[[ ! -e "$gate" ]] || { echo CF_P3_RELEASE_GATE=active >&2; exit 20; }
active_before="$(readlink -f "$active")"
control_sha_before="$(sha256sum "$control" | awk '{print $1}')"

python3 - "$active_before/manifest.json" "$candidate/manifest.json" "$control" <<'PY'
import json,sys
a=json.load(open(sys.argv[1])); c=json.load(open(sys.argv[2])); r=json.load(open(sys.argv[3]))
assert a["sequence"]==63 and a["release_id"]=="onshape-vps-hardened-rollback-r1",a
assert c["sequence"]==66 and c["release_id"]=="onshape-vps-hardened-production-r3",c
auth=r["authority"]
assert r["controlRevision"]==529
assert r["lease"]["state"]=="FREE"
assert auth["productionEpoch"]==1
assert auth["mode"]=="ANDROID_PRODUCTION"
assert auth["materialAuthority"]=="android-v1"
assert auth["planes"]["android-v1"]["ingress"]=="ADMITTED"
assert auth["planes"]["android-v1"]["materialEffectsAllowed"] is True
assert auth["planes"]["vps-fabric"]["ingress"]=="SHADOW"
assert auth["planes"]["vps-fabric"]["materialEffectsAllowed"] is False
assert auth["reconciliationHold"]["active"] is False
print("CF_P3_ACTIVE_RELEASE=seq63")
print("CF_P3_CANDIDATE_SEQUENCE=66")
print("CF_P3_AUTHORITY=android-epoch1")
print("CF_P3_LEASE=FREE")
PY

candidate_sha="$(sha256sum "$candidate/manifest.json" | awk '{print $1}')"
[[ "$candidate_sha" == "$expected_candidate_sha" ]] || { echo CF_P3_CANDIDATE_SHA=mismatch >&2; exit 21; }
[[ "$active_before" != "$candidate" ]] || { echo CF_P3_CANDIDATE_ALREADY_ACTIVE >&2; exit 21; }
echo "CF_P3_CANDIDATE_MANIFEST_SHA256=$candidate_sha"
echo CF_P3_CANDIDATE_UNACTIVATED=pass
echo CF_P3_RELEASE_GATE=clear

python3 - "$db" "$quarantine" <<'PY'
import json,sqlite3,sys
db,qpath=sys.argv[1:3]
q=json.load(open(qpath))
assert q["classification"]=="QUARANTINED"
assert q["decisionId"]=="D-018"
assert q["attemptId"]=="attempt:f6d80f46-b4ff-4798-9848-9b0b28bca1b8"
assert q["operationId"]=="operation:3cbb9823-a285-4d55-9cdc-cf57a2cb0cd2"
assert q["replayAllowed"] is False
attempt=q["attemptId"]; operation=q["operationId"]
c=sqlite3.connect(f"file:{db}?mode=ro",uri=True); c.row_factory=sqlite3.Row
try:
    assert str(c.execute("PRAGMA integrity_check").fetchone()[0]).lower()=="ok"
    rows=c.execute("""
      SELECT i.phase,o.operation_id,o.state AS operation_state,
             a.attempt_id,a.state AS attempt_state
      FROM invocations i
      LEFT JOIN operations o ON o.invocation_id=i.invocation_id
      LEFT JOIN attempts a ON a.operation_id=o.operation_id
      WHERE i.phase IN ('DISPATCH_FINALIZED','DISPATCH_INTENT','OBSERVED')
      ORDER BY i.rowid
    """).fetchall()
    blocking=[]
    quarantined=[]
    for r in rows:
        exact=(r["operation_id"]==operation and r["attempt_id"]==attempt)
        if exact:
            assert r["phase"]=="OBSERVED" and r["operation_state"]=="IN_DOUBT" and r["attempt_state"]=="IN_DOUBT",dict(r)
            quarantined.append(r)
        else:
            blocking.append(r)
    assert len(quarantined)==1,len(quarantined)
    in_flight=c.execute("SELECT count(*) FROM operations WHERE state='IN_FLIGHT'").fetchone()[0]
    dispatch_intent=c.execute("SELECT count(*) FROM attempts WHERE state='DISPATCH_INTENT'").fetchone()[0]
    other_doubt_ops=c.execute("SELECT count(*) FROM operations WHERE state='IN_DOUBT' AND operation_id<>?",(operation,)).fetchone()[0]
    other_doubt_attempts=c.execute("SELECT count(*) FROM attempts WHERE state='IN_DOUBT' AND NOT (attempt_id=? AND operation_id=?)",(attempt,operation)).fetchone()[0]
    assert len(blocking)==0,blocking
    assert in_flight==0,in_flight
    assert dispatch_intent==0,dispatch_intent
    assert other_doubt_ops==0,other_doubt_ops
    assert other_doubt_attempts==0,other_doubt_attempts
    print("CF_P3_SQLITE_INTEGRITY=pass")
    print("CF_P3_QUARANTINE_EXACT=D-018")
    print("CF_P3_EFFECTIVE_RECOVERABLE=0")
    print("CF_P3_IN_FLIGHT=0")
    print("CF_P3_DISPATCH_INTENT=0")
    print("CF_P3_EFFECTIVE_IN_DOUBT=0")
finally:
    c.close()
PY

python3 - "$agent_dir" "$quarantine" <<'PY'
import json,pathlib,sys
root=pathlib.Path(sys.argv[1]); q=json.load(open(sys.argv[2])); exact=q["attemptId"]
executing=[]; uncertain=[]; other_uncertain=[]
for p in root.glob("*.json"):
    try: v=json.loads(p.read_text())
    except Exception: continue
    state=str(v.get("state","")); aid=str(v.get("attemptId") or "")
    if state=="EXECUTING": executing.append((p.name,aid))
    if state=="UNCERTAIN":
        uncertain.append((p.name,aid))
        if aid!=exact: other_uncertain.append((p.name,aid))
assert not executing,executing
assert len(uncertain)==1 and uncertain[0][1]==exact,uncertain
assert not other_uncertain,other_uncertain
print("CF_P3_AGENT_EXECUTING=0")
print("CF_P3_AGENT_UNCERTAIN_RAW=1")
print("CF_P3_AGENT_QUARANTINED=1")
print("CF_P3_AGENT_UNCERTAIN_EFFECTIVE=0")
PY

if docker ps -a --format '{{.Names}}' | grep -Eq '^cf-seq66-qual-'; then
  echo CF_P3_QUALIFICATION_CLEANUP=fail >&2
  docker ps -a --format 'CF_P3_LEFTOVER={{.Names}}|{{.Status}}' | grep 'CF_P3_LEFTOVER=cf-seq66-qual-' || true
  exit 22
fi
echo CF_P3_QUALIFICATION_CLEANUP=pass

for c in capability-fabric-onshape-server capability-fabric-onshape-fabric capability-fabric-onshape-gateway; do
  [[ "$(docker inspect -f '{{.State.Running}}' "$c" 2>/dev/null || echo false)" == true ]] || { echo "CF_P3_LIVE_CONTAINER_$c=not-running" >&2; exit 23; }
done
echo CF_P3_LIVE_CONTAINERS=running

container=capability-fabric-onshape-server
docker exec -i "$container" sh -lc 'cd /tmp/app && node --input-type=module' <<'NODE'
import fs from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
const token=fs.readFileSync("/run/secrets/mcp-token","utf8").trim();
const client=new Client({name:"cf-final-preflight-pool",version:"1.0.0"});
const transport=new StreamableHTTPClientTransport(new URL("http://127.0.0.1:8788/mcp/"+token));
await client.connect(transport);
const res=await client.callTool({name:"onshape_pool_status",arguments:{}});
const raw=(res.content||[]).filter(x=>x.type==="text").map(x=>x.text||"").join("\n");
const pool=JSON.parse(raw);
if(pool.pool_enabled!==true||pool.size!==3||pool.material_mutator_session_id!=="session-1") throw new Error("pool invariant:"+raw);
if(pool.active_count!==0||pool.queued_count!==0||pool.document_lock_count!==0) throw new Error("pool not idle:"+raw);
if(pool.session_fingerprints_distinct!==true) throw new Error("fingerprints not distinct");
if(!Array.isArray(pool.sessions)||pool.sessions.length!==3) throw new Error("session count");
for(const s of pool.sessions){ if(s?.auth?.state!=="PROVEN") throw new Error("session auth:"+s?.session_id+":"+JSON.stringify(s?.auth)); }
console.log("CF_P3_LIVE_POOL_AUTH=3-of-3-PROVEN");
console.log("CF_P3_LIVE_POOL_IDLE=pass");
console.log("CF_P3_LIVE_POOL_MUTATOR=session-1");
await client.close();
NODE

[[ "$(readlink -f "$active")" == "$active_before" ]] || { echo CF_P3_ACTIVE_POINTER=changed >&2; exit 24; }
[[ "$(sha256sum "$control" | awk '{print $1}')" == "$control_sha_before" ]] || { echo CF_P3_RUNTIME_CONTROL=changed >&2; exit 24; }
[[ ! -e "$gate" ]] || { echo CF_P3_RELEASE_GATE=changed >&2; exit 24; }
echo CF_P3_ACTIVE_POINTER=unchanged
echo CF_P3_RUNTIME_CONTROL=unchanged
echo CF_P3=pass
