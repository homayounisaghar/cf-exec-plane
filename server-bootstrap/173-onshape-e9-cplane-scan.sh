#!/usr/bin/env bash
set -euo pipefail
SERVER=capability-fabric-onshape-server
docker exec -i "$SERVER" sh -lc 'cd /tmp/app && node --input-type=module' <<'NODE'
import fs from "node:fs";
import {Client} from "@modelcontextprotocol/sdk/client/index.js";
import {StreamableHTTPClientTransport} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
const token=fs.readFileSync("/run/secrets/mcp-token","utf8").trim();
const client=new Client({name:"cf-e9-cplane-scan",version:"1.0.0"});
await client.connect(new StreamableHTTPClientTransport(new URL("http://127.0.0.1:8788/mcp/"+token)));
const parse=res=>JSON.parse((res?.content||[]).filter(x=>x.type==="text").map(x=>x.text||"").join("\n"));
const targets=[
 ["52326aa681e54d6c04f2aa38","2febe514d072481a590d7efd","28234a8af43c23e3983de607"],
 ["0d652d94d5c2322ff732b488","3dd056cfc1e00f121f07c164","235a81d85234fe0f9d424335"]
];
for(const [did,wid,eid] of targets){
 const wrap=parse(await client.callTool({name:"onshape_fabric_invoke",arguments:{capability_id:"onshape.documented.operation",arguments:{
   operationId:"getPartStudioFeatures",pathParams:{did,wvm:"w",wvmid:wid,eid},query:{}
 }}}));
 const r=wrap.result,e=r?.observation?.evidence||{},b=e.body||{};
 if(r?.outcome?.state!=="ACHIEVED"||e.httpStatus!==200||e.effectSent!==false) throw new Error("read "+eid);
 for(const [i,f] of (b.features||[]).entries()){
   if(/cplane|plane|mateconnector|mate connector/i.test(String(f.featureType||"")+" "+String(f.name||""))){
     console.log("CF_E9_CPLANE_REF="+JSON.stringify({did,wid,eid,i,featureId:f.featureId,name:f.name,featureType:f.featureType,btType:f.btType,suppressed:f.suppressed,featureStatus:f.featureStatus,parameters:f.parameters}));
   }
 }
}
await client.close();
NODE
