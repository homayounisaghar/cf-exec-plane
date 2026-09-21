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
expected_control=177ddde1070c6a75f7cf94a15db1a0c93fa45159

[[ "$(readlink -f "$ACTIVE")" == /var/lib/capability-fabric/releases/onshape-vps-hardened-production-r4 ]]
[[ "$(git hash-object "$CONTROL")" == "$expected_control" ]]
[[ -f "$GATE" ]]
grep -Fxq RELEASE_IN_PROGRESS "$GATE"
[[ "$(docker inspect -f '{{.State.Running}}' "$GATEWAY")" == false ]]
[[ "$(docker inspect -f '{{.State.Running}}' "$SERVER")" == true ]]
if systemctl is-active --quiet "$TIMER"; then exit 20; fi

python3 - "$CONTROL" <<'PY'
import json,sys
x=json.load(open(sys.argv[1])); a=x["authority"]; g=a["productionGuard"]
assert x["controlRevision"]==532 and a["productionEpoch"]==4
assert a["mode"]=="QUIESCED_RECONCILING" and a["materialAuthority"] is None
assert a["planes"]["android-v1"]["ingress"]=="CLOSED" and a["planes"]["android-v1"]["materialEffectsAllowed"] is False
assert a["planes"]["vps-fabric"]["ingress"]=="CLOSED" and a["planes"]["vps-fabric"]["materialEffectsAllowed"] is False
assert g["killSwitch"]=="ENGAGED" and g["allowedDocumentIds"]==[] and g["mutationBudget"]["maxMutations"]==0
print("CF_R4_REAUTH_AUTHORITY=epoch4-quiesced-guard-closed")
PY

exec 9>"$LOCK"
flock -w 30 9 || exit 21

restore_gate=yes
cleanup() {
  rc=$?
  set +e
  if [[ "$restore_gate" == yes && ! -e "$GATE" ]]; then
    tmp="$GATE.tmp.reauth.$$"
    printf '%s\n' RELEASE_IN_PROGRESS >"$tmp"
    chmod 0600 "$tmp"
    chown root:root "$tmp"
    mv -f "$tmp" "$GATE"
  fi
  exit "$rc"
}
trap cleanup EXIT

rm -f "$GATE"
[[ ! -e "$GATE" ]]
[[ "$(docker inspect -f '{{.State.Running}}' "$GATEWAY")" == false ]]
if systemctl is-active --quiet "$TIMER"; then exit 22; fi
echo CF_R4_REAUTH_WINDOW=open

set +e
docker exec -i "$SERVER" sh -lc 'cd /tmp/app && node --input-type=module' <<'NODE'
import fs from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const token=fs.readFileSync("/run/secrets/mcp-token","utf8").trim();
const client=new Client({name:"cf-r4-cohort-reauth",version:"1.0.0"});
const transport=new StreamableHTTPClientTransport(new URL("http://127.0.0.1:8788/mcp/"+token));
await client.connect(transport);

function parse(res){
  const raw=(res?.content||[]).filter(x=>x.type==="text").map(x=>x.text||"").join("\n");
  if(!raw) throw new Error("empty tool response");
  return JSON.parse(raw);
}
async function tool(name,args={}){
  return parse(await client.callTool({name,arguments:args}));
}
async function waitOp(id, sessionId, timeoutMs=120000){
  const deadline=Date.now()+timeoutMs;
  while(Date.now()<deadline){
    const v=await tool("onshape_operation_status",{operation_id:id});
    const status=String(v.status||v?.result?.status||"");
    const op=v.result||v;
    const opStatus=String(op.status||status);
    if(opStatus==="AWAITING_INPUT"){
      console.log("CF_R4_REAUTH_AWAITING_INPUT_SESSION="+sessionId);
      console.log("CF_R4_REAUTH_AWAITING_INPUT_KIND="+String(op.input_required||""));
      return {terminal:"AWAITING_INPUT", value:v};
    }
    if(opStatus==="SUCCEEDED"||opStatus==="FAILED"){
      return {terminal:opStatus, value:v};
    }
    await new Promise(r=>setTimeout(r,1000));
  }
  throw new Error("operation timeout "+id);
}
async function pool(){
  return await tool("onshape_pool_status",{});
}
function sessionState(p,id){
  return (p.sessions||[]).find(s=>s.session_id===id);
}

let p=await pool();
if(p.build_id!=="onshape-vps-hardened-r4") throw new Error("wrong build");
if(p.active_count!==0||p.queued_count!==0||p.document_lock_count!==0) throw new Error("pool not idle before reauth");

for(const [index,sessionId] of ["session-1","session-2","session-3"].entries()){
  const start=await tool("onshape_pool_session_reauth",{session_id:sessionId});
  if(start.status==="FAILED") throw new Error("reauth start failed "+sessionId+" "+JSON.stringify(start));
  const opId=start.operation_id||start?.result?.operation_id;
  if(!opId) throw new Error("missing operation id "+sessionId+" "+JSON.stringify(start));
  console.log("CF_R4_REAUTH_OPERATION_"+sessionId.replace("-","_")+"="+opId);
  const done=await waitOp(opId,sessionId);
  if(done.terminal==="AWAITING_INPUT"){
    await client.close();
    process.exit(42);
  }
  p=await pool();
  const s=sessionState(p,sessionId);
  console.log("CF_R4_REAUTH_TERMINAL_"+sessionId.replace("-","_")+"="+done.terminal);
  console.log("CF_R4_REAUTH_AUTH_"+sessionId.replace("-","_")+"="+String(s?.auth?.state));
  if(String(s?.auth?.state)!=="PROVEN"){
    throw new Error(sessionId+" failed to become PROVEN "+JSON.stringify(done.value));
  }
  if(index<2){
    // Until all three are established, final cohort reprobe may fail. That is
    // acceptable only while routing stays disabled and the recovered session is
    // itself PROVEN.
    if(p.pool_enabled===true) throw new Error("pool enabled before all sessions established");
  } else {
    if(done.terminal!=="SUCCEEDED") throw new Error("final reauth did not succeed "+JSON.stringify(done.value));
    if(p.pool_enabled!==true||p.warming!==false||p.size!==3||p.active_count!==0||p.queued_count!==0||p.document_lock_count!==0){
      throw new Error("final pool state invalid "+JSON.stringify(p));
    }
    if(p.material_mutator_session_id!=="session-1"||p.session_fingerprints_distinct!==true) throw new Error("final pool identity invalid");
    for(const x of p.sessions||[]) if(x?.auth?.state!=="PROVEN") throw new Error("session not PROVEN "+x?.session_id);
    console.log("CF_R4_REAUTH_FINAL_POOL=3-of-3-PROVEN-idle");
    console.log("CF_R4_REAUTH_FINGERPRINTS_DISTINCT=true");
  }
}
await client.close();
console.log("CF_R4_REAUTH=pass");
NODE
node_rc=$?
set -e

tmp="$GATE.tmp.reauth.$$"
printf '%s\n' RELEASE_IN_PROGRESS >"$tmp"
chmod 0600 "$tmp"
chown root:root "$tmp"
mv -f "$tmp" "$GATE"
restore_gate=no
grep -Fxq RELEASE_IN_PROGRESS "$GATE"
echo CF_R4_REAUTH_WINDOW=closed

if [[ "$node_rc" -eq 42 ]]; then
  echo CF_R4_REAUTH=awaiting-user-verification
  exit 42
fi
[[ "$node_rc" -eq 0 ]] || exit "$node_rc"
echo CF_R4_REAUTH_GATE_RESTORED=pass
