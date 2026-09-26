#!/usr/bin/env bash
set -euo pipefail
SERVER=capability-fabric-onshape-server
DID=6efc214ada1e9b6924774296
WID=016101547d28c3b18e0156d2
EID=47bda9eeb9d5fbaeffe5df73
FID=FHTzF0N7ggWpsS6_5

docker exec -e CF_DID="$DID" -e CF_WID="$WID" -e CF_EID="$EID" -e CF_FID="$FID" -i "$SERVER" sh -lc 'cd /tmp/app && node --input-type=module' <<'NODE'
import fs from "node:fs";
import {Client} from "@modelcontextprotocol/sdk/client/index.js";
import {StreamableHTTPClientTransport} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
const DID=process.env.CF_DID,WID=process.env.CF_WID,EID=process.env.CF_EID,FID=process.env.CF_FID;
const token=fs.readFileSync("/run/secrets/mcp-token","utf8").trim();
const c=new Client({name:"cf-e9-mate-frame-probe",version:"1.0.0"});
await c.connect(new StreamableHTTPClientTransport(new URL("http://127.0.0.1:8788/mcp/"+token)));
const parse=r=>{
 const raw=(r?.content||[]).filter(x=>x.type==="text").map(x=>x.text||"").join("\n");
 if(!raw) throw new Error("empty");
 return JSON.parse(raw);
};
const invoke=async(operationId,args={})=>parse(await c.callTool({name:"onshape_fabric_invoke",arguments:{capability_id:"onshape.documented.operation",arguments:{operationId,...args}}}));
const q='qBodyType(qCreatedBy(makeId("'+FID+'"), EntityType.BODY), BodyType.MATE_CONNECTOR)';
const spec=JSON.parse(fs.readFileSync("/openapi/onshape-openapi.json","utf8"));
for(const wanted of ["addPartStudioFeature","deletePartStudioFeature","updatePartStudioFeature"]){
  for(const [p,item] of Object.entries(spec.paths||{})){
    for(const [m,op] of Object.entries(item||{})){
      if(op?.operationId!==wanted) continue;
      console.log("CF_E9_MATE_PROBE_OPENAPI_"+wanted+"="+JSON.stringify({path:p,method:m,parameters:[...(item.parameters||[]),...(op.parameters||[])],requestBody:op.requestBody}));
    }
  }
}
for(const [label,script] of [
 ["COUNT",'function(context is Context, queries) { return size(evaluateQuery(context, '+q+')); }'],
 ["FRAME",'function(context is Context, queries) { return evMateConnector(context, {'mateConnector' : '+q+'}); }']
]){
 const w=await invoke("evalFeatureScript",{pathParams:{did:DID,wvm:"w",wvmid:WID,eid:EID},query:{},body:{script}});
 console.log("CF_E9_MATE_PROBE_"+label+"_WRAP="+JSON.stringify(w));
 const r=w?.result,e=r?.observation?.evidence||{};
 if(r?.outcome?.state!=="ACHIEVED") throw new Error(label+" outcome "+String(r?.outcome?.state));
 if(e.httpStatus!==200||e.effectSent!==false) throw new Error(label+" transport");
 if(e.apiVersion!=="v17"||e.observedApiVersion!=="v17"||e.apiVersionMatched!==true) throw new Error(label+" version");
}
await c.close();
NODE
