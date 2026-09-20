#!/usr/bin/env bash
set -euo pipefail
umask 077
[[ "$(id -u)" -eq 0 ]] || { echo CF_PROD_REAUTH_REQUIRES_ROOT >&2; exit 2; }
container=capability-fabric-onshape-server
[[ "$(docker inspect -f '{{.State.Running}}' "$container" 2>/dev/null || echo false)" == true ]] || { echo CF_PROD_REAUTH_CONTAINER_NOT_RUNNING >&2; exit 20; }
docker exec -i "$container" sh -lc 'cd /tmp/app && node --input-type=module' <<'NODE'
import fs from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
const token=fs.readFileSync("/run/secrets/mcp-token","utf8").trim();
const client=new Client({name:"cf-production-session-reauth",version:"1.0.0"});
const transport=new StreamableHTTPClientTransport(new URL("http://127.0.0.1:8788/mcp/"+token));
await client.connect(transport);
function valueOf(result){
  const raw=(result.content||[]).filter(x=>x.type==="text").map(x=>x.text||"").join("\n");
  if(!raw) throw new Error("empty tool result");
  return JSON.parse(raw);
}
const started=valueOf(await client.callTool({name:"onshape_pool_session_reauth",arguments:{session_id:"session-1"}}));
if(started.status==="FAILED") throw new Error("reauth start failed:"+JSON.stringify(started.error));
const operationId=String(started.operation_id||"");
if(!operationId) throw new Error("reauth operation id missing");
console.log("CF_PROD_REAUTH_OPERATION_ID="+operationId);
let terminal=null;
for(let i=0;i<60;i++){
  const state=valueOf(await client.callTool({name:"onshape_operation_status",arguments:{operation_id:operationId}}));
  if(state.status==="AWAITING_INPUT"){
    console.log("CF_PROD_REAUTH_STATUS=AWAITING_INPUT");
    console.log("CF_PROD_REAUTH_INPUT_REQUIRED="+String(state.input_required||"UNKNOWN"));
    await client.close();
    process.exit(42);
  }
  if(state.status==="SUCCEEDED"||state.status==="FAILED"){ terminal=state; break; }
  await new Promise(resolve=>setTimeout(resolve,1000));
}
if(!terminal) throw new Error("reauth operation did not reach terminal state");
if(terminal.status!=="SUCCEEDED") throw new Error("reauth failed:"+JSON.stringify(terminal.error||terminal));
const pool=valueOf(await client.callTool({name:"onshape_pool_status",arguments:{}}));
if(pool.pool_enabled!==true) throw new Error("pool not enabled after reauth");
if(pool.session_fingerprints_distinct!==true) throw new Error("session fingerprints are not distinct");
if(pool.material_mutator_session_id!=="session-1") throw new Error("mutator session identity changed");
if(!Array.isArray(pool.sessions)||pool.sessions.length!==3) throw new Error("unexpected pool session count");
const accounts=new Set();
for(const session of pool.sessions){
  if(session?.auth?.state!=="PROVEN") throw new Error("session not PROVEN:"+session?.session_id);
  if(session?.auth?.account_id) accounts.add(session.auth.account_id);
}
if(accounts.size!==1) throw new Error("pool sessions do not share one account");
const s1=pool.sessions.find(x=>x.session_id==="session-1");
if(s1?.role!=="MATERIAL_MUTATOR") throw new Error("session-1 lost material mutator role");
for(const id of ["session-2","session-3"]){
  const s=pool.sessions.find(x=>x.session_id===id);
  if(s?.role!=="OBSERVER_RECOVERY") throw new Error(id+" writer-role violation");
}
console.log("CF_PROD_REAUTH_STATUS=SUCCEEDED");
console.log("CF_PROD_REAUTH_POOL_ENABLED=pass");
console.log("CF_PROD_REAUTH_ALL_SESSIONS_PROVEN=pass");
console.log("CF_PROD_REAUTH_DISTINCT_FINGERPRINTS=pass");
console.log("CF_PROD_REAUTH_ONE_MUTATOR_ROLE=pass");
await client.close();
NODE
