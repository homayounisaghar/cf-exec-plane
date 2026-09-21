#!/usr/bin/env bash
set -euo pipefail
umask 077
[[ "$(id -u)" -eq 0 ]] || exit 2

gateway=capability-fabric-onshape-gateway
server=capability-fabric-onshape-server
control=/var/lib/capability-fabric/onshape/runtime-control/ONSHAPE_RUNTIME_CONTROL.json
db=/var/lib/capability-fabric/onshape/fabric-state/execution.sqlite3
agent_dir=/var/lib/capability-fabric/onshape/fabric-agent
quarantine=/var/lib/capability-fabric/onshape/fabric-state/quarantine/D-018-attempt-f6d80f46.json
guard=/usr/local/libexec/capability-fabric-onshape-rollback-contract
expected_control_blob=81f73bb89c5517080a80ada3047c58c287874c50
did=84d077d8370c21c4b3045263
wid=aa8c5ad631e1836645149d09

[[ "$(docker inspect -f '{{.State.Running}}' "$gateway")" == false ]]
[[ "$(docker inspect -f '{{.State.Running}}' "$server")" == true ]]
[[ "$(git hash-object "$control")" == "$expected_control_blob" ]]
echo CF_CANARY_RECOVERY_GATEWAY=stopped
echo CF_CANARY_RECOVERY_CONTROL=exact

python3 - "$db" "$agent_dir" "$quarantine" <<'PY'
import json,pathlib,sqlite3,sys
db,agent_dir,qpath=sys.argv[1:]
q=json.load(open(qpath)); qa=q["attemptId"]; qo=q["operationId"]
c=sqlite3.connect(f"file:{db}?mode=ro",uri=True); c.row_factory=sqlite3.Row
try:
    assert str(c.execute("PRAGMA integrity_check").fetchone()[0]).lower()=="ok"
    rows=c.execute("""SELECT i.phase,o.operation_id,o.state operation_state,a.attempt_id,a.state attempt_state
      FROM invocations i LEFT JOIN operations o ON o.invocation_id=i.invocation_id
      LEFT JOIN attempts a ON a.operation_id=o.operation_id
      WHERE i.phase IN ('DISPATCH_FINALIZED','DISPATCH_INTENT','OBSERVED')
         OR o.state IN ('IN_FLIGHT','IN_DOUBT')
         OR a.state IN ('DISPATCH_INTENT','IN_DOUBT')""").fetchall()
    blocking=[]
    for r in rows:
        if r["operation_id"]==qo and r["attempt_id"]==qa:
            continue
        blocking.append(dict(r))
    assert not blocking,blocking
finally:
    c.close()
executing=[]; uncertain=[]
for p in pathlib.Path(agent_dir).glob("*.json"):
    try: v=json.loads(p.read_text())
    except Exception: continue
    state=str(v.get("state","")); aid=str(v.get("attemptId") or "")
    if state=="EXECUTING": executing.append((p.name,aid))
    if state=="UNCERTAIN" and aid!=qa: uncertain.append((p.name,aid))
assert not executing,executing
assert not uncertain,uncertain
print("CF_CANARY_RECOVERY_SQLITE=clean")
print("CF_CANARY_RECOVERY_EFFECTIVE_UNRESOLVED=0")
print("CF_CANARY_RECOVERY_AGENT_EXECUTING=0")
print("CF_CANARY_RECOVERY_AGENT_UNCERTAIN=0")
PY

ponr="$(python3 "$guard" decide --db "$db" --control "$control" --quarantine "$quarantine")"
printf '%s\n' "$ponr"
printf '%s\n' "$ponr" | grep -Fxq 'CF_A4_PONR=false'
printf '%s\n' "$ponr" | grep -Fxq 'CF_A4_PONR_COUNT=0'
printf '%s\n' "$ponr" | grep -Fxq 'CF_A4_UNRESOLVED_BLOCKING=0'
echo CF_CANARY_RECOVERY_PONR=false

docker exec -i "$server" sh -lc 'cd /tmp/app && node --input-type=module' <<'NODE'
import fs from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
const DID="84d077d8370c21c4b3045263";
const WID="aa8c5ad631e1836645149d09";
const token=fs.readFileSync("/run/secrets/mcp-token","utf8").trim();
const client=new Client({name:"cf-canary-preeffect-recovery-proof",version:"1.0.0"});
const transport=new StreamableHTTPClientTransport(new URL("http://127.0.0.1:8788/mcp/"+token));
await client.connect(transport);
const parse=(res)=>{
  if(res?.isError===true) throw new Error("tool error");
  const raw=(res.content||[]).filter(x=>x.type==="text").map(x=>x.text||"").join("\n");
  return JSON.parse(raw);
};
const pool=parse(await client.callTool({name:"onshape_pool_status",arguments:{}}));
if(pool.pool_enabled!==true||pool.size!==3||pool.active_count!==0||pool.queued_count!==0||pool.document_lock_count!==0) throw new Error("pool not idle");
for(const s of pool.sessions||[]) if(s?.auth?.state!=="PROVEN") throw new Error("session not proven");
const wrapper=parse(await client.callTool({name:"onshape_fabric_invoke",arguments:{
  capability_id:"onshape.documented.operation",
  arguments:{operationId:"getDocument",pathParams:{did:DID},query:{}}
}}));
const r=wrapper.result;
const ev=r?.observation?.evidence||{};
const body=ev.body||{};
if(r?.outcome?.state!=="ACHIEVED"||ev.httpStatus!==200||ev.effectSent!==false) throw new Error("read proof failed");
if(body.id!==DID||body.name!=="Speedtest 2"||body?.defaultWorkspace?.id!==WID) throw new Error("canary target changed");
console.log("CF_CANARY_RECOVERY_DOCUMENT_NAME="+body.name);
console.log("CF_CANARY_RECOVERY_MICROVERSION="+body.defaultWorkspace.microversion);
console.log("CF_CANARY_RECOVERY_READ_EFFECT_SENT=false");
console.log("CF_CANARY_RECOVERY_POOL=3-of-3-PROVEN-idle");
await client.close();
NODE

# The failure was a JavaScript parse error before any semantic invocation. Keep
# the public gateway stopped so the corrected canary can resume with no exposure.
[[ "$(docker inspect -f '{{.State.Running}}' "$gateway")" == false ]]
echo CF_CANARY_RECOVERY_NO_EFFECT=pass
echo CF_CANARY_RECOVERY_GATEWAY_FINAL=stopped
