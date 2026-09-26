#!/usr/bin/env bash
set -euo pipefail
umask 077
[[ "$(id -u)" -eq 0 ]] || exit 2

ACTIVE=/opt/capability-fabric/current
CONTROL=/var/lib/capability-fabric/onshape/runtime-control/ONSHAPE_RUNTIME_CONTROL.json
STATE=/var/lib/capability-fabric/state
GATE="$STATE/release-in-progress"
LOCK=/run/lock/capability-fabric-pull.lock
TIMER=capability-fabric-pull.timer
GATEWAY=capability-fabric-onshape-gateway
SERVER=capability-fabric-onshape-server
EXPECTED_CONTROL=ed50203283fc49d30af5b27c08607740edc6e696
EXPECTED_MANIFEST=08873ac1a6830ed42f15ebe340604ed6ffea33b8e7cb12b3a192982f3dcd6e9c

active="$(readlink -f "$ACTIVE")"
[[ "$(basename "$active")" == "onshape-vps-hardened-production-r8" ]] || exit 20
[[ "$(sha256sum "$active/manifest.json" | awk '{print $1}')" == "$EXPECTED_MANIFEST" ]] || exit 20
[[ "$(git hash-object "$CONTROL")" == "$EXPECTED_CONTROL" ]] || exit 20
[[ -f "$GATE" ]] && grep -Fxq RELEASE_IN_PROGRESS "$GATE"
[[ "$(docker inspect -f '{{.State.Running}}' "$GATEWAY")" == false ]]
[[ "$(docker inspect -f '{{.State.Running}}' "$SERVER")" == true ]]
if systemctl is-active --quiet "$TIMER"; then exit 20; fi

python3 - "$CONTROL" <<'PY'
import json,sys
x=json.load(open(sys.argv[1])); a=x["authority"]; g=a["productionGuard"]
assert x["controlRevision"]==552 and a["productionEpoch"]==23
assert a["mode"]=="VPS_PRODUCTION" and a["materialAuthority"]=="vps-fabric"
assert a["planes"]["vps-fabric"]["releaseSequence"]==72
assert a["planes"]["vps-fabric"]["releaseId"]=="onshape-vps-hardened-production-r8"
assert x["lease"]["state"]=="FREE"
assert g["killSwitch"]=="ENGAGED" and g["allowedDocumentIds"]==[] and g["mutationBudget"]["maxMutations"]==0
PY

exec 9>"$LOCK"
flock -w 30 9 || exit 21
restore=yes
cleanup(){
  rc=$?
  set +e
  if [[ "$restore" == yes && ! -e "$GATE" ]]; then
    tmp="$GATE.tmp.r8reauth.$$"; printf '%s\n' RELEASE_IN_PROGRESS >"$tmp"; chmod 0600 "$tmp"; chown root:root "$tmp"; mv -f "$tmp" "$GATE"
  fi
  exit "$rc"
}
trap cleanup EXIT
rm -f "$GATE"
echo CF_R8_REAUTH_WINDOW=open

set +e
docker exec -i "$SERVER" sh -lc 'cd /tmp/app && node --input-type=module' <<'NODE'
import fs from "node:fs";
import {Client} from "@modelcontextprotocol/sdk/client/index.js";
import {StreamableHTTPClientTransport} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
const token=fs.readFileSync("/run/secrets/mcp-token","utf8").trim();
const c=new Client({name:"cf-r8-cohort-reauth",version:"1.0.0"});
await c.connect(new StreamableHTTPClientTransport(new URL("http://127.0.0.1:8788/mcp/"+token)));
const parse=res=>{
 const raw=(res?.content||[]).filter(x=>x.type==="text").map(x=>x.text||"").join("\n");
 if(!raw) throw new Error("empty tool response");
 return JSON.parse(raw);
};
const tool=async(name,args={})=>parse(await c.callTool({name,arguments:args}));
const waitOp=async(id,sid,timeoutMs=120000)=>{
 const deadline=Date.now()+timeoutMs;
 while(Date.now()<deadline){
  const v=await tool("onshape_operation_status",{operation_id:id});
  const op=v.result||v,status=String(op.status||v.status||"");
  if(status==="AWAITING_INPUT"){
   console.log("CF_R8_REAUTH_AWAITING_INPUT_SESSION="+sid);
   return {terminal:status,value:v};
  }
  if(status==="SUCCEEDED"||status==="FAILED") return {terminal:status,value:v};
  await new Promise(r=>setTimeout(r,1000));
 }
 throw new Error("operation timeout "+id);
};
const pool=()=>tool("onshape_pool_status",{});
const state=(p,id)=>(p.sessions||[]).find(s=>s.session_id===id);
let p=await pool();
if(p.build_id!=="onshape-vps-hardened-r8") throw new Error("wrong build "+String(p.build_id));
if(p.active_count!==0||p.queued_count!==0||p.document_lock_count!==0) throw new Error("pool busy");
for(const [index,sid] of ["session-1","session-2","session-3"].entries()){
 const start=await tool("onshape_pool_session_reauth",{session_id:sid});
 if(start.status==="FAILED") throw new Error("reauth start failed "+sid);
 const opId=start.operation_id||start?.result?.operation_id;
 if(!opId) throw new Error("missing op id "+sid);
 console.log("CF_R8_REAUTH_OPERATION_"+sid.replace("-","_")+"="+opId);
 const done=await waitOp(opId,sid);
 if(done.terminal==="AWAITING_INPUT"){await c.close();process.exit(42);}
 p=await pool();
 const s=state(p,sid);
 console.log("CF_R8_REAUTH_TERMINAL_"+sid.replace("-","_")+"="+done.terminal);
 console.log("CF_R8_REAUTH_AUTH_"+sid.replace("-","_")+"="+String(s?.auth?.state));
 if(String(s?.auth?.state)!=="PROVEN") throw new Error(sid+" not PROVEN");
 if(index<2){
   if(p.pool_enabled===true) throw new Error("pool enabled early");
 }else{
   if(done.terminal!=="SUCCEEDED") throw new Error("final reauth failed");
   if(p.pool_enabled!==true||p.warming!==false||p.size!==3||p.active_count!==0||p.queued_count!==0||p.document_lock_count!==0) throw new Error("final pool invalid "+JSON.stringify(p));
   if(p.material_mutator_session_id!=="session-1"||p.session_fingerprints_distinct!==true) throw new Error("pool identity invalid");
   for(const x of p.sessions||[]) if(x?.auth?.state!=="PROVEN") throw new Error("session not PROVEN "+x?.session_id);
   console.log("CF_R8_REAUTH_FINAL_POOL=3-of-3-PROVEN-idle");
   console.log("CF_R8_REAUTH_FINGERPRINTS_DISTINCT=true");
 }
}
await c.close();
console.log("CF_R8_REAUTH=pass");
NODE
node_rc=$?
set -e

tmp="$GATE.tmp.r8reauth.$$"; printf '%s\n' RELEASE_IN_PROGRESS >"$tmp"; chmod 0600 "$tmp"; chown root:root "$tmp"; mv -f "$tmp" "$GATE"
restore=no
echo CF_R8_REAUTH_WINDOW=closed
if [[ "$node_rc" -eq 42 ]]; then echo CF_R8_REAUTH=awaiting-user-verification; exit 42; fi
[[ "$node_rc" -eq 0 ]] || exit "$node_rc"
echo CF_R8_REAUTH_GATE_RESTORED=pass
