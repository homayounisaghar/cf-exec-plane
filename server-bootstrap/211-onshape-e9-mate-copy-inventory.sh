#!/usr/bin/env bash
set -euo pipefail
SERVER=capability-fabric-onshape-server
DID=6efc214ada1e9b6924774296
WID=016101547d28c3b18e0156d2
EID=8047432dd707507a6ebe596e

docker exec -e CF_DID="$DID" -e CF_WID="$WID" -e CF_EID="$EID" -i "$SERVER" sh -lc 'cd /tmp/app && node --input-type=module' <<'NODE'
import fs from "node:fs";
import {Client} from "@modelcontextprotocol/sdk/client/index.js";
import {StreamableHTTPClientTransport} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
const DID=process.env.CF_DID,WID=process.env.CF_WID,EID=process.env.CF_EID;
const token=fs.readFileSync("/run/secrets/mcp-token","utf8").trim();
const c=new Client({name:"cf-e9-mate-copy-inventory",version:"1.0.0"});
await c.connect(new StreamableHTTPClientTransport(new URL("http://127.0.0.1:8788/mcp/"+token)));
const parse=r=>JSON.parse((r?.content||[]).filter(x=>x.type==="text").map(x=>x.text||"").join("\n"));
const invoke=async(operationId,args={})=>parse(await c.callTool({name:"onshape_fabric_invoke",arguments:{capability_id:"onshape.documented.operation",arguments:{operationId,...args}}}));
const fl=await invoke("getPartStudioFeatures",{pathParams:{did:DID,wvm:"w",wvmid:WID,eid:EID},query:{}});
const rr=fl?.result,ev=rr?.observation?.evidence||{},b=ev.body||{};
if(rr?.outcome?.state!=="ACHIEVED"||ev.httpStatus!==200||ev.effectSent!==false) throw new Error("feature read");
if(ev.apiVersion!=="v17"||ev.observedApiVersion!=="v17"||ev.apiVersionMatched!==true) throw new Error("version");
console.log("CF_E9_MATE_COPY_INV_MICROVERSION="+String(b.sourceMicroversion||""));
const wanted=new Set(["F4D5F3ieOBhi3l5","FsqvR1htqYMsjKK","FKzbp5AVTcxyATj","Fe6PsC3LkqmEwnQ","F3SXsDSwe9zdg32_132"]);
for(const [i,f] of (b.features||[]).entries()){
  if(!(wanted.has(f.featureId)||f.featureType==="mateConnector")) continue;
  const params=(f.parameters||[]).map(p=>{
    const o={parameterId:p.parameterId,btType:p.btType};
    for(const k of ["expression","value","enumName"]) if(p[k]!==undefined) o[k]=p[k];
    if(Array.isArray(p.queries)) o.queries=p.queries.map(q=>({
      btType:q.btType,featureId:q.featureId,entityType:q.entityType,bodyType:q.bodyType,
      queryString:q.queryString
    }));
    return o;
  });
  console.log("CF_E9_MATE_COPY_INV_FEATURE="+JSON.stringify({
    i,featureId:f.featureId,name:f.name,featureType:f.featureType,btType:f.btType,
    status:b?.featureStates?.[f.featureId]?.featureStatus||f.featureStatus||null,
    suppressed:f.suppressed,parameters:params
  }));
}

for(const fid of ["F4D5F3ieOBhi3l5","FsqvR1htqYMsjKK","FKzbp5AVTcxyATj","Fe6PsC3LkqmEwnQ"]){
  const q='qBodyType(qCreatedBy(makeId("'+fid+'"), EntityType.BODY), BodyType.MATE_CONNECTOR)';
  const countScript='function(context is Context, queries) { return size(evaluateQuery(context, '+q+')); }';
  const cw=await invoke("evalFeatureScript",{pathParams:{did:DID,wvm:"w",wvmid:WID,eid:EID},query:{},body:{script:countScript}});
  const ce=cw?.result?.observation?.evidence||{},cb=ce.body||{};
  console.log("CF_E9_MATE_COPY_INV_COUNT="+fid+"="+String(cb?.result?.value));
  const frameScript='function(context is Context, queries) { return evMateConnector(context, {mateConnector : '+q+'}); }';
  try{
    const fw=await invoke("evalFeatureScript",{pathParams:{did:DID,wvm:"w",wvmid:WID,eid:EID},query:{},body:{script:frameScript}});
    const fe=fw?.result?.observation?.evidence||{},fb=fe.body||{};
    console.log("CF_E9_MATE_COPY_INV_FRAME="+fid+"="+JSON.stringify(fb?.result||fb));
  }catch(e){
    console.log("CF_E9_MATE_COPY_INV_FRAME_ERROR="+fid+"="+String(e));
  }
}
await c.close();
NODE
