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
DB=/var/lib/capability-fabric/onshape/fabric-state/execution.sqlite3
QUARANTINE=/var/lib/capability-fabric/onshape/fabric-state/quarantine/D-018-attempt-f6d80f46.json
ROLLBACK_GUARD=/usr/local/libexec/capability-fabric-onshape-rollback-contract

EXPECTED_CONTROL=1b9c248d8b57385a86c5c157bf99ef4f1f6928ce
EXPECTED_MANIFEST=08873ac1a6830ed42f15ebe340604ed6ffea33b8e7cb12b3a192982f3dcd6e9c
DID=1e9b8b9b2b0dc2e6c0bc0997
WID=fb99dfc47912a65cb7bd9bd4
EID=c27839aa1a21f678e6ae9c45

[[ "$(basename "$(readlink -f "$ACTIVE")")" == "onshape-vps-hardened-production-r8" ]] || exit 20
[[ "$(cat "$STATE/last-good-sequence")" == "73" ]] || exit 20
[[ "$(sha256sum "$(readlink -f "$ACTIVE")/manifest.json" | awk '{print $1}')" == "$EXPECTED_MANIFEST" ]] || exit 20
[[ "$(git hash-object "$CONTROL")" == "$EXPECTED_CONTROL" ]] || exit 20
[[ "$(tr -d '\r\n' < "$MIRROR_BLOB")" == "$EXPECTED_CONTROL" ]] || exit 20

# E10 must not compete with another work item that owns the shared fail-closed
# production boundary. This readiness probe runs only after that boundary is free.
[[ ! -e "$GATE" ]] || { echo CF_E10_READINESS_SHARED_GATE=busy; exit 30; }
systemctl is-active --quiet "$TIMER" || { echo CF_E10_READINESS_PULL_TIMER=inactive; exit 30; }
[[ "$(docker inspect -f '{{.State.Running}}' "$GATEWAY" 2>/dev/null || echo false)" == true ]] || { echo CF_E10_READINESS_GATEWAY=stopped; exit 30; }
[[ "$(docker inspect -f '{{.State.Running}}' "$SERVER" 2>/dev/null || echo false)" == true ]] || exit 20

python3 - "$CONTROL" <<'PY'
import json,sys
x=json.load(open(sys.argv[1])); a=x["authority"]; g=a["productionGuard"]; v=a["planes"]["vps-fabric"]
assert x["controlRevision"]==556 and a["productionEpoch"]==27
assert a["mode"]=="VPS_PRODUCTION" and a["materialAuthority"]=="vps-fabric"
assert v["releaseSequence"]==73 and v["releaseId"]=="onshape-vps-hardened-production-r8"
assert a["planes"]["android-v1"]["ingress"]=="CLOSED"
assert a["reconciliationHold"]["active"] is False and x["lease"]["state"]=="FREE"
assert g["generation"]==11 and g["killSwitch"]=="ENGAGED"
assert g["allowedDocumentIds"]==[]
assert g["mutationBudget"]=={"budgetId":"e9-mate-durability-complete-closed","maxMutations":0}
print("CF_E10_READINESS_AUTHORITY=pass")
print("CF_E10_READINESS_GUARD=engaged-empty-zero")
PY

ponr="$("$ROLLBACK_GUARD" decide --db "$DB" --control "$CONTROL" --quarantine "$QUARANTINE")"
printf '%s\n' "$ponr" | grep -Fxq 'CF_A4_UNRESOLVED_BLOCKING=0'
printf '%s\n' "$ponr" | grep -Fxq 'CF_A4_ZERO_UNRESOLVED=pass'
echo CF_E10_READINESS_UNRESOLVED=zero

docker exec -e CF_DID="$DID" -e CF_WID="$WID" -e CF_EID="$EID" -i "$SERVER" sh -lc 'cd /tmp/app && node --input-type=module' <<'NODE'
import fs from "node:fs";
import {Client} from "@modelcontextprotocol/sdk/client/index.js";
import {StreamableHTTPClientTransport} from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const DID=process.env.CF_DID,WID=process.env.CF_WID,EID=process.env.CF_EID;
const token=fs.readFileSync("/run/secrets/mcp-token","utf8").trim();
const c=new Client({name:"cf-e10-pathology-readiness",version:"1.0.0"});
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
  const pool=await call("onshape_pool_status");
  if(pool?.build_id!=="onshape-vps-hardened-r8"||pool?.pool_enabled!==true||pool?.size!==3||pool?.active_count!==0||pool?.queued_count!==0||pool?.document_lock_count!==0) throw new Error("pool");
  for(const s of pool.sessions||[]) if(s?.auth?.state!=="PROVEN") throw new Error("auth "+String(s?.session_id));
  console.log("CF_E10_READINESS_POOL=3-of-3-PROVEN-idle");

  const wrap=await invoke("getPartStudioFeatures",{pathParams:{did:DID,wvm:"w",wvmid:WID,eid:EID},query:{}});
  const r=wrap?.result,e=r?.observation?.evidence||{},b=e.body||{};
  if(r?.outcome?.state!=="ACHIEVED"||e.httpStatus!==200||e.effectSent!==false) throw new Error("feature-list transport");
  if(e.apiVersion!=="v17"||e.observedApiVersion!=="v17"||e.apiVersionMatched!==true) throw new Error("feature-list version");
  const features=b.features||[];
  const states=b.featureStates||{};
  const linear=features.filter(f=>f?.name==="Linear pattern 1");
  if(linear.length!==1) throw new Error("expected exactly one Linear pattern 1, found "+linear.length);

  function walk(v,acc){
    if(Array.isArray(v)){ for(const x of v) walk(x,acc); return; }
    if(!v||typeof v!=="object") return;
    if(typeof v.btType==="string" && /Query/.test(v.btType)) acc.queryTypes.add(v.btType);
    if(typeof v.queryString==="string"){
      acc.queryStrings++;
      if(/qNothing\s*\(/.test(v.queryString)) acc.qNothing++;
      if(v.queryString.trim()) acc.nonEmptyQueryStrings++;
    }
    if(typeof v.parameterId==="string") acc.parameterIds.add(v.parameterId);
    for(const x of Object.values(v)) walk(x,acc);
  }
  const summarize=f=>{
    const acc={queryTypes:new Set(),parameterIds:new Set(),queryStrings:0,nonEmptyQueryStrings:0,qNothing:0};
    walk(f,acc);
    return {
      featureId:String(f.featureId||""),
      name:String(f.name||""),
      featureType:String(f.featureType||""),
      status:String(states?.[f.featureId]?.featureStatus||f.featureStatus||""),
      suppressed:!!f.suppressed,
      queryTypes:[...acc.queryTypes].sort(),
      parameterIds:[...acc.parameterIds].sort(),
      queryStrings:acc.queryStrings,
      nonEmptyQueryStrings:acc.nonEmptyQueryStrings,
      qNothing:acc.qNothing,
    };
  };

  const damaged=summarize(linear[0]);
  console.log("CF_E10_PATHOLOGY_LINEAR="+JSON.stringify(damaged));
  if(damaged.qNothing<1) throw new Error("retained pathology no longer contains qNothing");

  const healthy=[];
  for(const f of features){
    const x=summarize(f);
    if(x.status==="OK" && x.nonEmptyQueryStrings>0 && x.qNothing===0) healthy.push(x);
  }
  console.log("CF_E10_HEALTHY_QUERY_CANDIDATE_COUNT="+healthy.length);
  for(const x of healthy.slice(0,12)) console.log("CF_E10_HEALTHY_QUERY_CANDIDATE="+JSON.stringify(x));
  if(healthy.length<1) throw new Error("no healthy query-bearing candidate in Pathology Lab");

  console.log("CF_E10_SOURCE_MICROVERSION="+String(b.sourceMicroversion||""));
  console.log("CF_E10_READINESS=pass");
} finally {
  await c.close().catch(()=>{});
}
NODE
