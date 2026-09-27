#!/usr/bin/env bash
set -euo pipefail
umask 077
STATE=/var/lib/capability-fabric/state
CONTROL=/var/lib/capability-fabric/onshape/runtime-control/ONSHAPE_RUNTIME_CONTROL.json
GATE="$STATE/release-in-progress"
TIMER=capability-fabric-pull.timer
SERVICE=capability-fabric-pull.service
GATEWAY=capability-fabric-onshape-gateway
SERVER=capability-fabric-onshape-server

ensure_closed() {
  local tmp="$GATE.tmp.r9-warm.$$"
  printf "%s\n" RELEASE_IN_PROGRESS >"$tmp"
  chmod 0600 "$tmp"; chown root:root "$tmp"; mv -f "$tmp" "$GATE"
  docker stop "$GATEWAY" >/dev/null 2>&1 || true
  systemctl stop "$TIMER" >/dev/null 2>&1 || true
}
trap ensure_closed EXIT
ensure_closed
for _ in $(seq 1 30); do systemctl is-active --quiet "$SERVICE" || break; sleep 1; done
! systemctl is-active --quiet "$SERVICE"

python3 - "$CONTROL" <<'PY'
import json,sys
d=json.load(open(sys.argv[1])); a=d["authority"]; v=a["planes"]["vps-fabric"]; g=a["productionGuard"]
assert d["controlRevision"]==557 and a["productionEpoch"]==28
assert a["mode"]=="QUIESCED_RECONCILING" and a["materialAuthority"] is None
assert v["ingress"]=="CLOSED" and v["materialEffectsAllowed"] is False
assert v["releaseSequence"]==74 and v["releaseId"]=="onshape-vps-hardened-r9"
assert d["lease"]["state"]=="FREE" and a["reconciliationHold"]["active"] is False
assert g["killSwitch"]=="ENGAGED" and g["allowedDocumentIds"]==[] and g["mutationBudget"]["maxMutations"]==0
print("CF_R9_WARM_AUTHORITY=quiesced")
PY

[[ "$(basename "$(readlink -f /opt/capability-fabric/current)")" == "onshape-vps-hardened-r9" ]]
[[ "$(docker inspect -f '{{.State.Running}}' "$SERVER")" == true ]]
[[ "$(docker inspect -f '{{.State.Health.Status}}' "$SERVER")" == healthy ]]
[[ "$(docker inspect -f '{{.State.Running}}' "$GATEWAY")" == false ]]

# Gate blocks even loopback operator tools; open only the local backend while external gateway remains stopped and authority remains closed.
rm -f "$GATE"

docker exec -i "$SERVER" sh -lc 'cd /tmp/app && node --input-type=module' <<'NODE'
import fs from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
const token=fs.readFileSync("/run/secrets/mcp-token","utf8").trim();
const c=new Client({name:"cf-r9-warm",version:"1.0"});
await c.connect(new StreamableHTTPClientTransport(new URL("http://127.0.0.1:8788/mcp/"+token)));
const parse=r=>JSON.parse((r.content||[]).filter(x=>x.type==="text").map(x=>x.text||"").join("\n"));
const call=async(name,args={})=>parse(await c.callTool({name,arguments:args},undefined,{timeout:180000}));
const terminal=async(op)=>{
 for(let i=0;i<360;i++){
  const st=await call("onshape_operation_status",{operation_id:op});
  if(["SUCCEEDED","FAILED","AWAITING_INPUT"].includes(st.status)) return st;
  await new Promise(r=>setTimeout(r,1000));
 }
 throw new Error("operation timeout");
};
try{
  let p=await call("onshape_pool_status");
  if(p.build_id!=="onshape-vps-hardened-r9"||p.size!==5) throw new Error("wrong r9 pool identity "+JSON.stringify({build:p.build_id,size:p.size}));
  const ready=()=>p.pool_enabled===true&&p.session_fingerprints_distinct===true&&(p.sessions||[]).length===5&&p.sessions.every(x=>x?.auth?.state==="PROVEN"&&x?.auth?.http_status===200);
  if(!ready()){
    const started=await call("onshape_pool_warmup");
    const op=String(started.operation_id||"");
    if(!op) throw new Error("missing warmup operation");
    const st=await terminal(op);
    if(st.status==="AWAITING_INPUT"){
      console.log("CF_R9_WARM_INPUT_REQUIRED="+String(st.input_required||"UNKNOWN"));
      process.exitCode=42;
      return;
    }
    if(st.status!=="SUCCEEDED") throw new Error("warmup failed "+JSON.stringify(st.error||st));
    p=await call("onshape_pool_status");
  }
  if(!ready()) throw new Error("pool did not reach 5/5 PROVEN");
  if(p.active_count!==0||p.queued_count!==0||p.document_lock_count!==0) throw new Error("pool not idle");
  if(new Set(p.sessions.map(x=>x?.auth?.account_id).filter(Boolean)).size!==1) throw new Error("account mismatch");
  console.log("CF_R9_WARM_POOL=5of5-PROVEN-idle");
  console.log("CF_R9_WARM_NAV_LIMIT="+String(p.navigation_limit));

  // Prove five opaque semantic contexts through the real Fabric path: one MATERIAL placement + four READ_ONLY placements.
  const ctx=[];
  const invoke=async(capability_id,args)=>{
    const x=await call("onshape_fabric_invoke",{capability_id,arguments:args});
    const result=x?.result;
    if(!result) throw new Error("missing fabric result for "+capability_id);
    return result;
  };
  for(let i=0;i<5;i++){
    const accessMode=i===0?"MATERIAL":"READ_ONLY";
    const r=await invoke("onshape.execution.context.acquire",{workItem:"r9-prod-qualify-"+(i+1),accessMode});
    const id=r?.outcome?.evidence?.executionContextId ?? r?.outcome?.evidence?.executionContext?.executionContextId ?? r?.observation?.evidence?.executionContextId;
    if(typeof id!=="string"||!/^ctx_[0-9a-f]{32}$/.test(id)) throw new Error("context acquire missing opaque id "+JSON.stringify(r));
    ctx.push(id);
  }
  if(new Set(ctx).size!==5) throw new Error("context ids not distinct");
  for(const id of ctx){
    const s=await invoke("onshape.execution.context.status",{executionContextId:id});
    const ev=s?.outcome?.evidence ?? s?.observation?.evidence ?? {};
    const raw=JSON.stringify(ev);
    if(raw.includes("session_id")||raw.includes("profile")) throw new Error("physical placement leaked");
  }
  const mid=await call("onshape_pool_status");
  if(mid.workflow_lease_count!==5) throw new Error("expected five workflow leases");
  console.log("CF_R9_WARM_CONTEXTS=5-opaque-active");
  for(const id of ctx){
    const rr=await invoke("onshape.execution.context.release",{executionContextId:id});
    const ev=rr?.outcome?.evidence ?? rr?.observation?.evidence ?? {};
    if(ev.contextReleased!==true) throw new Error("context release failed "+id);
  }
  const end=await call("onshape_pool_status");
  if(end.workflow_lease_count!==0||end.active_count!==0||end.queued_count!==0||end.document_lock_count!==0) throw new Error("context cleanup not idle");
  console.log("CF_R9_WARM_CONTEXT_LIFECYCLE=pass");
} finally { await c.close().catch(()=>{}); }
NODE
rc=$?
ensure_closed
trap - EXIT
if (( rc == 42 )); then exit 42; fi
(( rc == 0 ))
[[ -f "$GATE" ]] && grep -Fxq RELEASE_IN_PROGRESS "$GATE"
[[ "$(docker inspect -f '{{.State.Running}}' "$GATEWAY")" == false ]]
! systemctl is-active --quiet "$TIMER"
echo CF_R9_WARM=pass
