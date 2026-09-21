#!/usr/bin/env bash
set -euo pipefail
umask 077
[[ "$(id -u)" -eq 0 ]] || { echo CF_PA_REQUIRES_ROOT >&2; exit 2; }

active=/opt/capability-fabric/current
candidate=/var/lib/capability-fabric/releases/onshape-vps-hardened-production-r3
control=/var/lib/capability-fabric/onshape/runtime-control/ONSHAPE_RUNTIME_CONTROL.json
db=/var/lib/capability-fabric/onshape/fabric-state/execution.sqlite3
agent_dir=/var/lib/capability-fabric/onshape/fabric-agent
quarantine=/var/lib/capability-fabric/onshape/fabric-state/quarantine/D-018-attempt-f6d80f46.json
gate=/var/lib/capability-fabric/state/release-in-progress
trust=/etc/capability-fabric/trust/deploy-signing.pub
expected_sha=857b7ca6d5a6bcf79b820594801a4f88642fe9520dad1ae18fc064eae6073d7c

[[ -L "$active" && -d "$candidate" && -s "$control" && -s "$db" && -s "$quarantine" && -s "$trust" ]] || exit 20
[[ ! -e "$gate" ]] || { echo CF_PA_RELEASE_GATE=active >&2; exit 20; }

active_dir="$(readlink -f "$active")"
python3 - "$active_dir/manifest.json" "$candidate/manifest.json" "$control" <<'PY'
import json,sys
a=json.load(open(sys.argv[1])); c=json.load(open(sys.argv[2])); r=json.load(open(sys.argv[3]))
assert a["sequence"]==63 and a["release_id"]=="onshape-vps-hardened-rollback-r1",a
assert c["sequence"]==66 and c["release_id"]=="onshape-vps-hardened-production-r3",c
auth=r["authority"]
assert r["controlRevision"]==530,r["controlRevision"]
assert r["lease"]["state"]=="FREE"
assert auth["productionEpoch"]==2
assert auth["mode"]=="QUIESCED_RECONCILING"
assert auth["materialAuthority"] is None
assert auth["planes"]["android-v1"]["ingress"]=="CLOSED"
assert auth["planes"]["android-v1"]["materialEffectsAllowed"] is False
assert auth["planes"]["vps-fabric"]["ingress"]=="CLOSED"
assert auth["planes"]["vps-fabric"]["materialEffectsAllowed"] is False
assert auth["reconciliationHold"]["active"] is False
assert r["routing"]["state"]=="CLOSED"
assert r["routing"]["materialCommandsAllowed"] is False
print("CF_PA_ACTIVE_RELEASE=seq63")
print("CF_PA_CANDIDATE_SEQUENCE=66")
print("CF_PA_AUTHORITY=quiesced-epoch2")
print("CF_PA_BOTH_MATERIAL_PLANES=CLOSED")
print("CF_PA_LEASE=FREE")
PY

sha="$(sha256sum "$candidate/manifest.json" | awk '{print $1}')"
[[ "$sha" == "$expected_sha" ]] || { echo CF_PA_CANDIDATE_SHA=mismatch >&2; exit 21; }
sig="/var/lib/capability-fabric/signatures/$sha.sig"
[[ -s "$sig" ]] || { echo CF_PA_SIGNATURE=missing >&2; exit 21; }
work="$(mktemp -d /var/lib/capability-fabric/.preactivate.XXXXXX)"
trap 'rm -rf "$work"' EXIT
printf 'capability-fabric-deploy %s\n' "$(tr -d '\r\n' < "$trust")" >"$work/allowed"
ssh-keygen -Y verify -f "$work/allowed" -I capability-fabric-deploy -n capability-fabric-deploy -s "$sig" <"$candidate/manifest.json" >/dev/null 2>&1
python3 - "$candidate/manifest.json" "$candidate" <<'PY'
import hashlib,json,os,sys
m=json.load(open(sys.argv[1])); root=sys.argv[2]
for rel,expected in m["files"].items():
    p=os.path.join(root,rel)
    assert os.path.isfile(p),rel
    assert hashlib.sha256(open(p,"rb").read()).hexdigest()==expected,rel
print("CF_PA_FILE_CLOSURE=pass")
PY
echo CF_PA_SIGNATURE=pass
echo "CF_PA_MANIFEST_SHA256=$sha"

python3 - "$db" "$quarantine" <<'PY'
import json,sqlite3,sys
db,qpath=sys.argv[1:3]
q=json.load(open(qpath)); qa=q["attemptId"]; qo=q["operationId"]
c=sqlite3.connect(f"file:{db}?mode=ro",uri=True); c.row_factory=sqlite3.Row
try:
    assert str(c.execute("PRAGMA integrity_check").fetchone()[0]).lower()=="ok"
    rows=c.execute("""SELECT i.phase,o.operation_id,o.state operation_state,a.attempt_id,a.state attempt_state
      FROM invocations i LEFT JOIN operations o ON o.invocation_id=i.invocation_id
      LEFT JOIN attempts a ON a.operation_id=o.operation_id
      WHERE i.phase IN ('DISPATCH_FINALIZED','DISPATCH_INTENT','OBSERVED') ORDER BY i.rowid""").fetchall()
    blocking=[]
    exact=0
    for r in rows:
        if r["operation_id"]==qo and r["attempt_id"]==qa:
            assert r["phase"]=="OBSERVED" and r["operation_state"]=="IN_DOUBT" and r["attempt_state"]=="IN_DOUBT"
            exact+=1
        else: blocking.append(dict(r))
    assert exact==1 and not blocking,(exact,blocking)
    assert c.execute("SELECT count(*) FROM operations WHERE state='IN_FLIGHT'").fetchone()[0]==0
    assert c.execute("SELECT count(*) FROM attempts WHERE state='DISPATCH_INTENT'").fetchone()[0]==0
    assert c.execute("SELECT count(*) FROM operations WHERE state='IN_DOUBT' AND operation_id<>?",(qo,)).fetchone()[0]==0
    assert c.execute("SELECT count(*) FROM attempts WHERE state='IN_DOUBT' AND attempt_id<>?",(qa,)).fetchone()[0]==0
    print("CF_PA_SQLITE_INTEGRITY=pass")
    print("CF_PA_EFFECTIVE_UNRESOLVED=0")
finally: c.close()
PY

python3 - "$agent_dir" "$quarantine" <<'PY'
import json,pathlib,sys
root=pathlib.Path(sys.argv[1]); q=json.load(open(sys.argv[2])); exact=q["attemptId"]
executing=[]; other_uncertain=[]; raw_uncertain=[]
for p in root.glob("*.json"):
    try: v=json.loads(p.read_text())
    except Exception: continue
    s=str(v.get("state","")); aid=str(v.get("attemptId") or "")
    if s=="EXECUTING": executing.append((p.name,aid))
    if s=="UNCERTAIN":
        raw_uncertain.append((p.name,aid))
        if aid!=exact: other_uncertain.append((p.name,aid))
assert not executing,executing
assert not other_uncertain,other_uncertain
assert len(raw_uncertain)==1 and raw_uncertain[0][1]==exact,raw_uncertain
print("CF_PA_AGENT_EXECUTING=0")
print("CF_PA_AGENT_UNCERTAIN_EFFECTIVE=0")
PY

container=capability-fabric-onshape-server
docker exec -i "$container" sh -lc 'cd /tmp/app && node --input-type=module' <<'NODE'
import fs from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
const token=fs.readFileSync("/run/secrets/mcp-token","utf8").trim();
const client=new Client({name:"cf-preactivate",version:"1.0.0"});
const transport=new StreamableHTTPClientTransport(new URL("http://127.0.0.1:8788/mcp/"+token));
await client.connect(transport);
const res=await client.callTool({name:"onshape_pool_status",arguments:{}});
const raw=(res.content||[]).filter(x=>x.type==="text").map(x=>x.text||"").join("\n");
const pool=JSON.parse(raw);
if(pool.pool_enabled!==true||pool.size!==3||pool.material_mutator_session_id!=="session-1") throw new Error(raw);
if(pool.active_count!==0||pool.queued_count!==0||pool.document_lock_count!==0) throw new Error(raw);
if(!Array.isArray(pool.sessions)||pool.sessions.length!==3) throw new Error(raw);
for(const s of pool.sessions){ if(s?.auth?.state!=="PROVEN") throw new Error(raw); }
console.log("CF_PA_POOL_AUTH=3-of-3-PROVEN");
console.log("CF_PA_POOL_IDLE=pass");
console.log("CF_PA_POOL_MUTATOR=session-1");
await client.close();
NODE

echo CF_PA_RELEASE_GATE=clear
echo CF_PA=pass
