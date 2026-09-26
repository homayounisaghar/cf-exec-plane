#!/usr/bin/env bash
set -euo pipefail
SERVER=capability-fabric-onshape-server
DID=6efc214ada1e9b6924774296
WID=016101547d28c3b18e0156d2
EID=47bda9eeb9d5fbaeffe5df73
docker exec -e CF_DID="$DID" -e CF_WID="$WID" -e CF_EID="$EID" -i "$SERVER" sh -lc 'cd /tmp/app && node --input-type=module' <<'NODE'
import fs from "node:fs";
import {Client} from "@modelcontextprotocol/sdk/client/index.js";
import {StreamableHTTPClientTransport} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
const DID=process.env.CF_DID,WID=process.env.CF_WID,EID=process.env.CF_EID;
const token=fs.readFileSync("/run/secrets/mcp-token","utf8").trim();
const c=new Client({name:"cf-e9-mate-copy-map",version:"1.0.0"});
await c.connect(new StreamableHTTPClientTransport(new URL("http://127.0.0.1:8788/mcp/"+token)));
const parse=r=>JSON.parse((r?.content||[]).filter(x=>x.type==="text").map(x=>x.text||"").join("\n"));
const invoke=async(operationId,args={})=>parse(await c.callTool({name:"onshape_fabric_invoke",arguments:{capability_id:"onshape.documented.operation",arguments:{operationId,...args}}}));
const fl=await invoke("getPartStudioFeatures",{pathParams:{did:DID,wvm:"w",wvmid:WID,eid:EID},query:{}});
const rr=fl?.result,ev=rr?.observation?.evidence||{},b=ev.body||{};
if(rr?.outcome?.state!=="ACHIEVED"||ev.httpStatus!==200||ev.effectSent!==false) throw new Error("feature read");
if(ev.apiVersion!=="v17"||ev.observedApiVersion!=="v17"||ev.apiVersionMatched!==true) throw new Error("version");
console.log("CF_E9_MATE_MAP_MICROVERSION="+String(b.sourceMicroversion||""));
const features=b.features||[];
for(const [i,f] of features.entries()){
  if(!(f.featureType==="mateConnector"||["Transform 1","Split 1","Split 2"].includes(f.name))) continue;
  const params=(f.parameters||[]).map(p=>{
    const o={parameterId:p.parameterId,btType:p.btType};
    for(const k of ["expression","value","enumName"]) if(p[k]!==undefined) o[k]=p[k];
    if(Array.isArray(p.queries)) o.queries=p.queries.map(q=>({btType:q.btType,featureId:q.featureId,entityType:q.entityType,bodyType:q.bodyType,queryString:q.queryString}));
    return o;
  });
  console.log("CF_E9_MATE_MAP_FEATURE="+JSON.stringify({
    i,featureId:f.featureId,name:f.name,featureType:f.featureType,
    status:b?.featureStates?.[f.featureId]?.featureStatus||f.featureStatus||null,
    parameters:params
  }));
}
const transform=features.find(f=>f.name==="Transform 1"&&f.featureType==="transform");
if(!transform) throw new Error("Transform 1 missing");
for(const pid of ["baseConnector","destinationConnector"]){
  const p=(transform.parameters||[]).find(x=>x.parameterId===pid);
  const q=p?.queries?.[0];
  if(!q?.featureId||q.btType!=="BTMIndividualCreatedByQuery-137"||q.bodyType!=="MATE_CONNECTOR") throw new Error(pid+" not qualified mate query");
  const fid=q.featureId;
  console.log("CF_E9_MATE_MAP_DEPENDENCY_"+pid+"="+fid);
  const countQ='qBodyType(qCreatedBy(makeId("'+fid+'"), EntityType.BODY), BodyType.MATE_CONNECTOR)';
  const cw=await invoke("evalFeatureScript",{pathParams:{did:DID,wvm:"w",wvmid:WID,eid:EID},query:{},body:{script:'function(context is Context, queries) { return size(evaluateQuery(context, '+countQ+')); }'}});
  console.log("CF_E9_MATE_MAP_COUNT_"+pid+"="+String(cw?.result?.observation?.evidence?.body?.result?.value));
  const fw=await invoke("evalFeatureScript",{pathParams:{did:DID,wvm:"w",wvmid:WID,eid:EID},query:{},body:{script:'function(context is Context, queries) { return evMateConnector(context, {mateConnector : '+countQ+'}); }'}});
  const fr=fw?.result,fe=fr?.observation?.evidence||{},fb=fe.body||{};
  console.log("CF_E9_MATE_MAP_FRAME_"+pid+"="+JSON.stringify({outcome:fr?.outcome,state:fb?.result||fb}));
}
await c.close();
NODE
