#!/usr/bin/env bash
set -euo pipefail
umask 077
[[ "$(id -u)" -eq 0 ]] || exit 2

ACTIVE=/opt/capability-fabric/current
STATE=/var/lib/capability-fabric/state
CONTROL=/var/lib/capability-fabric/onshape/runtime-control/ONSHAPE_RUNTIME_CONTROL.json
MIRROR_BLOB=/var/lib/capability-fabric/onshape/runtime-control/git-blob-sha
GATE="$STATE/release-in-progress"
TIMER=capability-fabric-pull.timer
GATEWAY=capability-fabric-onshape-gateway
SERVER=capability-fabric-onshape-server

EXPECTED_CONTROL=1b9c248d8b57385a86c5c157bf99ef4f1f6928ce
EXPECTED_MANIFEST=08873ac1a6830ed42f15ebe340604ed6ffea33b8e7cb12b3a192982f3dcd6e9c
DID=da5689feb22b7481daab16cc
WID=ee2c6d041c71ef84eaf9e714
EID=7208aa16c65ca25764a922bb

[[ -L "$ACTIVE" ]] || { echo CF_LLAO_BASELINE_ACTIVE=missing; exit 20; }
active="$(readlink -f "$ACTIVE")"
echo "CF_LLAO_BASELINE_ACTIVE=$(basename "$active")"
[[ "$(basename "$active")" == "onshape-vps-hardened-production-r8" ]] || exit 20
[[ "$(cat "$STATE/last-good-sequence")" == "73" ]] || exit 20
[[ "$(sha256sum "$active/manifest.json" | awk '{print $1}')" == "$EXPECTED_MANIFEST" ]] || exit 20
[[ "$(git hash-object "$CONTROL")" == "$EXPECTED_CONTROL" ]] || exit 20
[[ "$(tr -d '\r\n' < "$MIRROR_BLOB")" == "$EXPECTED_CONTROL" ]] || exit 20

if [[ -e "$GATE" ]]; then echo CF_LLAO_BASELINE_RELEASE_GATE=present; else echo CF_LLAO_BASELINE_RELEASE_GATE=absent; fi
if systemctl is-active --quiet "$TIMER"; then echo CF_LLAO_BASELINE_PULL_TIMER=active; else echo CF_LLAO_BASELINE_PULL_TIMER=inactive; fi
if [[ "$(docker inspect -f '{{.State.Running}}' "$GATEWAY" 2>/dev/null || echo false)" == true ]]; then echo CF_LLAO_BASELINE_GATEWAY=running; else echo CF_LLAO_BASELINE_GATEWAY=stopped; fi
if [[ "$(docker inspect -f '{{.State.Running}}' "$SERVER" 2>/dev/null || echo false)" == true ]]; then echo CF_LLAO_BASELINE_SERVER=running; else echo CF_LLAO_BASELINE_SERVER=stopped; exit 30; fi

python3 - "$CONTROL" <<'PY'
import json,sys
x=json.load(open(sys.argv[1])); a=x["authority"]; g=a["productionGuard"]; v=a["planes"]["vps-fabric"]
assert x["controlRevision"]==556
assert a["productionEpoch"]==27
assert a["mode"]=="VPS_PRODUCTION" and a["materialAuthority"]=="vps-fabric"
assert v["ingress"]=="ADMITTED" and v["materialEffectsAllowed"] is True
assert v["releaseSequence"]==73 and v["releaseId"]=="onshape-vps-hardened-production-r8"
assert a["planes"]["android-v1"]["ingress"]=="CLOSED"
assert a["planes"]["android-v1"]["materialEffectsAllowed"] is False
assert a["reconciliationHold"]["active"] is False
assert x["lease"]["state"]=="FREE"
assert g["generation"]==11 and g["killSwitch"]=="ENGAGED"
assert g["allowedDocumentIds"]==[]
assert g["mutationBudget"]=={"budgetId":"e9-mate-durability-complete-closed","maxMutations":0}
print("CF_LLAO_BASELINE_AUTHORITY=rev556-epoch27-seq73-r8")
print("CF_LLAO_BASELINE_LEASE=FREE")
print("CF_LLAO_BASELINE_GUARD=engaged-empty-zero")
PY

docker exec -e CF_DID="$DID" -e CF_WID="$WID" -e CF_EID="$EID" -i "$SERVER" sh -lc 'cd /tmp/app && node --input-type=module' <<'NODE'
import fs from "node:fs";
import {Client} from "@modelcontextprotocol/sdk/client/index.js";
import {StreamableHTTPClientTransport} from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const DID=process.env.CF_DID,WID=process.env.CF_WID,EID=process.env.CF_EID;
const token=fs.readFileSync("/run/secrets/mcp-token","utf8").trim();
const c=new Client({name:"cf-llao-onshape-baseline",version:"1.0.0"});
await c.connect(new StreamableHTTPClientTransport(new URL("http://127.0.0.1:8788/mcp/"+token)));
const parse=res=>{
  const raw=(res?.content||[]).filter(x=>x.type==="text").map(x=>x.text||"").join("\n");
  if(!raw) throw new Error("empty MCP response");
  return JSON.parse(raw);
};
const call=async(name,args={})=>parse(await c.callTool({name,arguments:args},undefined,{timeout:180000}));
const invoke=async(operationId,args={})=>call("onshape_fabric_invoke",{
  capability_id:"onshape.documented.operation",
  arguments:{operationId,...args},
});
try{
  const tools=(await c.listTools()).tools.map(x=>x.name).sort();
  for(const n of ["onshape_pool_status","onshape_fabric_capabilities","onshape_fabric_invoke","onshape_fabric_reconcile"]){
    if(!tools.includes(n)) throw new Error("missing tool "+n);
  }
  const caps=await call("onshape_fabric_capabilities");
  console.log("CF_LLAO_BASELINE_BUILD="+String(caps?.build_id||""));
  console.log("CF_LLAO_BASELINE_SURFACE="+String(caps?.public_surface||""));
  if(caps?.build_id!=="onshape-vps-hardened-r8"||caps?.public_surface!=="semantic-only"||caps?.qualification_only!==false) throw new Error("wrong capability surface");

  const pool=await call("onshape_pool_status");
  console.log("CF_LLAO_BASELINE_POOL="+JSON.stringify({
    enabled:pool?.pool_enabled,
    size:pool?.size,
    active:pool?.active_count,
    queued:pool?.queued_count,
    locks:pool?.document_lock_count,
    mutator:pool?.material_mutator_session_id,
    auth:(pool?.sessions||[]).map(s=>({id:s?.session_id,state:s?.auth?.state}))
  }));
  if(pool?.pool_enabled!==true||pool?.size!==3||pool?.active_count!==0||pool?.queued_count!==0||pool?.document_lock_count!==0){
    throw new Error("pool not idle");
  }
  for(const s of pool.sessions||[]) if(s?.auth?.state!=="PROVEN") throw new Error("session not proven "+String(s?.session_id));

  const doc=await invoke("getDocument",{pathParams:{did:DID},query:{}});
  const dr=doc?.result,de=dr?.observation?.evidence||{},db=de.body||{};
  if(dr?.outcome?.state!=="ACHIEVED"||de.httpStatus!==200||de.effectSent!==false||db.id!==DID) throw new Error("document read failed");
  console.log("CF_LLAO_BASELINE_DOCUMENT="+JSON.stringify({
    id:db.id,
    name:db.name,
    defaultWorkspaceId:db?.defaultWorkspace?.id||null,
    effectSent:de.effectSent,
    apiVersion:de.apiVersion||null,
    observedApiVersion:de.observedApiVersion||null,
    apiVersionMatched:de.apiVersionMatched
  }));

  const features=await invoke("getPartStudioFeatures",{pathParams:{did:DID,wvm:"w",wvmid:WID,eid:EID},query:{}});
  const fr=features?.result,fe=fr?.observation?.evidence||{},fb=fe.body||{};
  if(fr?.outcome?.state!=="ACHIEVED"||fe.httpStatus!==200||fe.effectSent!==false) throw new Error("feature list read failed");
  const list=Array.isArray(fb.features)?fb.features:[];
  const states=fb.featureStates||{};
  const summary=list.slice(0,50).map(f=>({
    id:String(f?.featureId||""),
    name:String(f?.name||""),
    featureType:String(f?.featureType||""),
    btType:String(f?.btType||""),
    suppressed:!!f?.suppressed,
    status:String(states?.[f?.featureId]?.featureStatus||f?.featureStatus||"")
  }));
  console.log("CF_LLAO_BASELINE_FEATURE_COUNT="+list.length);
  console.log("CF_LLAO_BASELINE_FEATURES="+JSON.stringify(summary));
  console.log("CF_LLAO_BASELINE_SOURCE_MICROVERSION="+String(fb.sourceMicroversion||""));
  console.log("CF_LLAO_BASELINE_TARGET=readable-partstudio");
  console.log("CF_LLAO_BASELINE=pass");
} finally {
  await c.close().catch(()=>{});
}
NODE
