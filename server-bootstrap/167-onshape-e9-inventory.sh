#!/usr/bin/env bash
set -euo pipefail
umask 077
[[ "$(id -u)" -eq 0 ]] || exit 2

CONTROL=/var/lib/capability-fabric/onshape/runtime-control/ONSHAPE_RUNTIME_CONTROL.json
SERVER=capability-fabric-onshape-server
GATEWAY=capability-fabric-onshape-gateway
DID=8ca702971e2419cfa45cc87c
WID=8bbf262de8f6c2015d72fd7d
EID=dc6eb5c8b694395c14024558
EXPECTED_CONTROL=79ea04caa91462d85021ae46392b636b217a6cc8

[[ "$(git hash-object "$CONTROL")" == "$EXPECTED_CONTROL" ]] || exit 20
[[ "$(docker inspect -f '{{.State.Running}}' "$SERVER")" == true ]]
[[ "$(docker inspect -f '{{.State.Running}}' "$GATEWAY")" == true ]]

docker exec -e CF_DID="$DID" -e CF_WID="$WID" -e CF_EID="$EID" -i "$SERVER" sh -lc 'cd /tmp/app && node --input-type=module' <<'NODE'
import fs from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
const DID=process.env.CF_DID,WID=process.env.CF_WID,EID=process.env.CF_EID;
const token=fs.readFileSync("/run/secrets/mcp-token","utf8").trim();
const client=new Client({name:"cf-e9-inventory",version:"1.0.0"});
const tr=new StreamableHTTPClientTransport(new URL("http://127.0.0.1:8788/mcp/"+token));
await client.connect(tr);
const parse=res=>{
  const raw=(res?.content||[]).filter(x=>x.type==="text").map(x=>x.text||"").join("\n");
  if(!raw) throw new Error("empty response");
  return JSON.parse(raw);
};
const call=async(operationId,args={})=>parse(await client.callTool({name:"onshape_fabric_invoke",arguments:{
  capability_id:"onshape.documented.operation",
  arguments:{operationId,...args}
}}));
const feat=await call("getPartStudioFeatures",{pathParams:{did:DID,wvm:"w",wvmid:WID,eid:EID},query:{}});
const fr=feat?.result,fe=fr?.observation?.evidence||{},fb=fe.body||{};
if(fr?.outcome?.state!=="ACHIEVED"||fe.httpStatus!==200||fe.effectSent!==false) throw new Error("feature list failed");
if(fe.apiVersion!=="v17"||fe.observedApiVersion!=="v17"||fe.apiVersionMatched!==true) throw new Error("feature list version mismatch");
console.log("CF_E9_INV_FEATURE_API_VERSION=v17");
console.log("CF_E9_INV_FEATURE_COUNT="+String((fb.features||[]).length));
console.log("CF_E9_INV_SOURCE_MICROVERSION="+String(fb.sourceMicroversion||""));
console.log("CF_E9_INV_LIBRARY_VERSION="+String(fb.libraryVersion||""));
console.log("CF_E9_INV_SERIALIZATION_VERSION="+String(fb.serializationVersion||""));
for(const [i,f] of (fb.features||[]).entries()){
  console.log("CF_E9_INV_FEATURE="+JSON.stringify({
    index:i,
    featureId:f.featureId,
    name:f.name,
    featureType:f.featureType,
    btType:f.btType,
    suppressed:f.suppressed,
    featureStatus:f.featureStatus,
    parameters:(f.parameters||[]).map(p=>({
      parameterId:p.parameterId,
      btType:p.btType,
      value:p.value,
      expression:p.expression,
      query:p.query,
      queries:p.queries,
      enumName:p.enumName
    }))
  }));
}
const body=await call("getPartStudioBodyDetails",{pathParams:{did:DID,wvm:"w",wvmid:WID,eid:EID},query:{}});
const br=body?.result,be=br?.observation?.evidence||{},bb=be.body||{};
if(br?.outcome?.state!=="ACHIEVED"||be.httpStatus!==200||be.effectSent!==false) throw new Error("body details failed");
console.log("CF_E9_INV_BODY_DETAILS="+JSON.stringify(bb));
await client.close();
NODE
