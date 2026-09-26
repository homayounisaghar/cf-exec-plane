#!/usr/bin/env bash
set -euo pipefail
SERVER=capability-fabric-onshape-server
DID=6efc214ada1e9b6924774296
WID=016101547d28c3b18e0156d2

docker exec -e CF_DID="$DID" -e CF_WID="$WID" -i "$SERVER" sh -lc 'cd /tmp/app && node --input-type=module' <<'NODE'
import fs from "node:fs";
import {Client} from "@modelcontextprotocol/sdk/client/index.js";
import {StreamableHTTPClientTransport} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
const DID=process.env.CF_DID,WID=process.env.CF_WID;
const spec=JSON.parse(fs.readFileSync("/openapi/onshape-openapi.json","utf8"));
const candidates=[];
for(const [p,item] of Object.entries(spec.paths||{})){
  for(const [method,op] of Object.entries(item||{})){
    if(method.toLowerCase()!=="get"||!op?.operationId) continue;
    if(!/elements/i.test(p+" "+op.operationId)) continue;
    const params=[...(item.parameters||[]),...(op.parameters||[])].filter(x=>x?.in==="path").map(x=>x.name);
    if(params.includes("did") && (params.includes("wid")||params.includes("wvmid"))) candidates.push({p,operationId:op.operationId,params});
  }
}
console.log("CF_E9_MATE_COPY_ELEMENT_OP_CANDIDATES="+JSON.stringify(candidates));
const exact=candidates.find(x=>/\/elements\/?$/.test(x.p));
if(!exact) throw new Error("no official document elements GET operation");
console.log("CF_E9_MATE_COPY_ELEMENT_OP="+JSON.stringify(exact));

const token=fs.readFileSync("/run/secrets/mcp-token","utf8").trim();
const c=new Client({name:"cf-e9-mate-copy-resolve",version:"1.0.0"});
await c.connect(new StreamableHTTPClientTransport(new URL("http://127.0.0.1:8788/mcp/"+token)));
const parse=r=>JSON.parse((r?.content||[]).filter(x=>x.type==="text").map(x=>x.text||"").join("\n"));
const invoke=async(operationId,args={})=>parse(await c.callTool({name:"onshape_fabric_invoke",arguments:{capability_id:"onshape.documented.operation",arguments:{operationId,...args}}}));
const pathParams={};
for(const n of exact.params){
  if(n==="did") pathParams[n]=DID;
  else if(n==="wid") pathParams[n]=WID;
  else if(n==="wvm") pathParams[n]="w";
  else if(n==="wvmid") pathParams[n]=WID;
  else throw new Error("unexpected path param "+n);
}
const ew=await invoke(exact.operationId,{pathParams,query:{}});
const er=ew?.result,ee=er?.observation?.evidence||{},eb=ee.body;
if(er?.outcome?.state!=="ACHIEVED"||ee.httpStatus!==200||ee.effectSent!==false) throw new Error("elements read");
if(ee.apiVersion!=="v17"||ee.observedApiVersion!=="v17"||ee.apiVersionMatched!==true) throw new Error("elements version");
const elements=Array.isArray(eb)?eb:(eb?.items||eb?.elements||[]);
console.log("CF_E9_MATE_COPY_ELEMENTS="+JSON.stringify(elements.map(x=>({id:x.id,name:x.name,elementType:x.elementType,microversionId:x.microversionId}))));
const targetIds=new Set(["F4D5F3ieOBhi3l5","FsqvR1htqYMsjKK","FKzbp5AVTcxyATj","Fe6PsC3LkqmEwnQ","F3SXsDSwe9zdg32_132"]);
let found=null;
for(const el of elements){
  const eid=String(el.id||"");
  if(!/^[0-9a-f]{24}$/i.test(eid)) continue;
  try{
    const fw=await invoke("getPartStudioFeatures",{pathParams:{did:DID,wvm:"w",wvmid:WID,eid},query:{}});
    const fr=fw?.result,fe=fr?.observation?.evidence||{},fb=fe.body||{};
    if(fr?.outcome?.state!=="ACHIEVED"||fe.httpStatus!==200||fe.effectSent!==false) continue;
    const ids=new Set((fb.features||[]).map(f=>f.featureId));
    if([...targetIds].some(id=>ids.has(id))){ found={eid,fb}; break; }
  }catch{}
}
if(!found) throw new Error("reference Part Studio not found in copy");
console.log("CF_E9_MATE_COPY_EID="+found.eid);
console.log("CF_E9_MATE_COPY_SOURCE_MICROVERSION="+String(found.fb.sourceMicroversion||""));
for(const [i,f] of (found.fb.features||[]).entries()){
  if(!(targetIds.has(f.featureId)||f.featureType==="mateConnector")) continue;
  const params=(f.parameters||[]).map(p=>{
    const o={parameterId:p.parameterId,btType:p.btType};
    for(const k of ["expression","value","enumName"]) if(p[k]!==undefined) o[k]=p[k];
    if(Array.isArray(p.queries)) o.queries=p.queries.map(q=>({btType:q.btType,featureId:q.featureId,entityType:q.entityType,bodyType:q.bodyType,queryString:q.queryString}));
    return o;
  });
  console.log("CF_E9_MATE_COPY_FEATURE="+JSON.stringify({i,featureId:f.featureId,name:f.name,featureType:f.featureType,status:found.fb?.featureStates?.[f.featureId]?.featureStatus||f.featureStatus||null,parameters:params}));
}
for(const fid of ["F4D5F3ieOBhi3l5","FsqvR1htqYMsjKK","FKzbp5AVTcxyATj","Fe6PsC3LkqmEwnQ"]){
  const q='qBodyType(qCreatedBy(makeId("'+fid+'"), EntityType.BODY), BodyType.MATE_CONNECTOR)';
  const countScript='function(context is Context, queries) { return size(evaluateQuery(context, '+q+')); }';
  const cw=await invoke("evalFeatureScript",{pathParams:{did:DID,wvm:"w",wvmid:WID,eid:found.eid},query:{},body:{script:countScript}});
  const cb=cw?.result?.observation?.evidence?.body||{};
  console.log("CF_E9_MATE_COPY_COUNT="+fid+"="+String(cb?.result?.value));
  const frameScript='function(context is Context, queries) { return evMateConnector(context, {mateConnector : '+q+'}); }';
  try{
    const fw=await invoke("evalFeatureScript",{pathParams:{did:DID,wvm:"w",wvmid:WID,eid:found.eid},query:{},body:{script:frameScript}});
    const fb=fw?.result?.observation?.evidence?.body||{};
    console.log("CF_E9_MATE_COPY_FRAME="+fid+"="+JSON.stringify(fb?.result||fb));
  }catch(e){ console.log("CF_E9_MATE_COPY_FRAME_ERROR="+fid+"="+String(e)); }
}
await c.close();
NODE
