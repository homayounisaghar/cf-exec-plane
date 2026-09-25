#!/usr/bin/env bash
set -euo pipefail
umask 077
SERVER=capability-fabric-onshape-server
DID=1e9b8b9b2b0dc2e6c0bc0997
WID=fb99dfc47912a65cb7bd9bd4
EID=c27839aa1a21f678e6ae9c45

docker exec -e CF_DID="$DID" -e CF_WID="$WID" -e CF_EID="$EID" -i "$SERVER" sh -lc 'cd /tmp/app && node --input-type=module' <<'NODE'
import fs from "node:fs";
import {Client} from "@modelcontextprotocol/sdk/client/index.js";
import {StreamableHTTPClientTransport} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
const token=fs.readFileSync("/run/secrets/mcp-token","utf8").trim();
const client=new Client({name:"cf-e9-pathology-ref",version:"1.0.0"});
await client.connect(new StreamableHTTPClientTransport(new URL("http://127.0.0.1:8788/mcp/"+token)));
const parse=res=>JSON.parse((res?.content||[]).filter(x=>x.type==="text").map(x=>x.text||"").join("\n"));
const wrap=parse(await client.callTool({name:"onshape_fabric_invoke",arguments:{
  capability_id:"onshape.documented.operation",
  arguments:{operationId:"getPartStudioFeatures",pathParams:{did:process.env.CF_DID,wvm:"w",wvmid:process.env.CF_WID,eid:process.env.CF_EID},query:{}}
}}));
const r=wrap.result,e=r?.observation?.evidence||{},b=e.body||{};
if(r?.outcome?.state!=="ACHIEVED"||e.httpStatus!==200||e.effectSent!==false) throw new Error("read");
if(e.apiVersion!=="v17"||e.observedApiVersion!=="v17"||e.apiVersionMatched!==true) throw new Error("version");
console.log("CF_E9_PATH_REF_COUNT="+String((b.features||[]).length));
for(const [i,f] of (b.features||[]).entries()){
 console.log("CF_E9_PATH_REF_FEATURE="+JSON.stringify({i,featureId:f.featureId,name:f.name,featureType:f.featureType,btType:f.btType,suppressed:f.suppressed,featureStatus:f.featureStatus,parameters:f.parameters}));
}
await client.close();
NODE
