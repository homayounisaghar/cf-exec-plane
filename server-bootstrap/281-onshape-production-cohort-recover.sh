#!/usr/bin/env bash
set -euo pipefail
umask 077
[[ "$(id -u)" -eq 0 ]] || { echo CF_PROD_COHORT_RECOVER_REQUIRES_ROOT >&2; exit 2; }

container="capability-fabric-onshape-server"
[[ "$(docker inspect -f '{{.State.Running}}' "$container" 2>/dev/null || echo false)" == true ]] || {
  echo CF_PROD_COHORT_RECOVER_SERVER=not-running >&2
  exit 20
}

docker exec -i "$container" sh -lc 'cd /tmp/app && node --input-type=module' <<'NODE'
import fs from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const token=fs.readFileSync("/run/secrets/mcp-token","utf8").trim();
const c=new Client({name:"cf-production-cohort-recover",version:"1.0"});
await c.connect(new StreamableHTTPClientTransport(new URL("http://127.0.0.1:8788/mcp/"+token)));

const parse=r=>JSON.parse((r.content||[]).filter(x=>x.type==="text").map(x=>x.text||"").join("\n"));
const call=async(name,args={})=>parse(await c.callTool({name,arguments:args},undefined,{timeout:180000}));

async function status(){
  return call("onshape_pool_status");
}
function proven(session){
  return session?.auth?.state==="PROVEN" && session?.auth?.http_status===200;
}
async function recoverSession(sid){
  for(let authAttempt=1;authAttempt<=2;authAttempt++){
    const before=await status();
    const selectedBefore=(before.sessions||[]).find(x=>x.session_id===sid);
    if(proven(selectedBefore)){
      console.log("CF_PROD_COHORT_RECOVER_SKIP="+sid+"=PROVEN");
      return;
    }

    console.log("CF_PROD_COHORT_RECOVER_START="+sid+":attempt="+authAttempt);
    const started=await call("onshape_pool_session_reauth",{session_id:sid});
    const op=String(started.operation_id||"");
    if(!op) throw new Error("missing reauth operation "+sid);

    let terminal=null;
    for(let i=0;i<180;i++){
      const state=await call("onshape_operation_status",{operation_id:op});
      if(["SUCCEEDED","FAILED","AWAITING_INPUT"].includes(state.status)){terminal=state;break;}
      await new Promise(r=>setTimeout(r,1000));
    }
    if(!terminal) throw new Error("reauth timeout "+sid);

    if(terminal.status==="AWAITING_INPUT"){
      console.log("CF_PROD_COHORT_RECOVER_INPUT_REQUIRED="+sid+":"+String(terminal.input_required||"UNKNOWN"));
      await c.close().catch(()=>{});
      process.exit(42);
    }

    const after=await status();
    const selected=(after.sessions||[]).find(x=>x.session_id===sid);
    const selectedProven=proven(selected);

    if(terminal.status==="SUCCEEDED"){
      if(!selectedProven) throw new Error("terminal success without PROVEN readback "+sid);
      console.log("CF_PROD_COHORT_RECOVER_PASS="+sid+":attempt="+authAttempt);
      return;
    }

    const code=String(terminal?.error?.code||"");
    if(code==="POOL_FINAL_AUTH_NOT_PROVEN" && selectedProven){
      console.log("CF_PROD_COHORT_RECOVER_STAGED="+sid+"=PROVEN");
      return;
    }
    if(code==="LOGIN_STATE_UNRESOLVED" && selectedProven){
      console.log("CF_PROD_COHORT_RECOVER_READBACK_PROVEN="+sid);
      return;
    }
    if(code==="LOGIN_STATE_UNRESOLVED" && !selectedProven && authAttempt===1){
      console.log("CF_PROD_COHORT_RECOVER_BOUNDED_RETRY="+sid);
      continue;
    }
    throw new Error("reauth failed "+sid+" "+JSON.stringify(terminal.error||terminal));
  }
  throw new Error("selected session did not recover "+sid);
}

try {
  const initial=await status();
  if(!Number.isInteger(initial.size)||initial.size<1||initial.size>5) throw new Error("invalid pool size");
  const ids=(initial.sessions||[]).map(x=>String(x.session_id||"")).sort();
  if(ids.length!==initial.size || ids.some(id=>!/^session-[1-5]$/.test(id))) throw new Error("invalid pool session ids");

  for(const sid of ids) await recoverSession(sid);

  const final=await status();
  if(final.pool_enabled!==true) throw new Error("final pool disabled");
  if(final.session_fingerprints_distinct!==true) throw new Error("final fingerprints not distinct");
  if(final.active_count!==0||final.queued_count!==0||final.document_lock_count!==0) throw new Error("final pool not idle");
  const sessions=final.sessions||[];
  if(sessions.length!==final.size||sessions.some(x=>!proven(x))) throw new Error("final cohort not fully PROVEN");
  const accounts=new Set(sessions.map(x=>x?.auth?.account_id).filter(Boolean));
  if(accounts.size!==1) throw new Error("final cohort account mismatch");
  console.log("CF_PROD_COHORT_RECOVER_FINAL="+final.size+"of"+final.size+"-PROVEN-idle");
} finally {
  await c.close().catch(()=>{});
}
NODE
