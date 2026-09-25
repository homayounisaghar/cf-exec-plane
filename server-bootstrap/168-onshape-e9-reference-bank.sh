#!/usr/bin/env bash
set -euo pipefail
umask 077
[[ "$(id -u)" -eq 0 ]] || exit 2
SERVER=capability-fabric-onshape-server
DID=9c19201d51bb3d73a1833128
WID=0a7ff1a635d5448549080491
EID=8047432dd707507a6ebe596e

docker exec -e CF_DID="$DID" -e CF_WID="$WID" -e CF_EID="$EID" -i "$SERVER" sh -lc 'cd /tmp/app && node --input-type=module' <<'NODE'
import fs from "node:fs";
import {Client} from "@modelcontextprotocol/sdk/client/index.js";
import {StreamableHTTPClientTransport} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
const token=fs.readFileSync("/run/secrets/mcp-token","utf8").trim();
const client=new Client({name:"cf-e9-reference-bank",version:"1.0.0"});
await client.connect(new StreamableHTTPClientTransport(new URL("http://127.0.0.1:8788/mcp/"+token)));
const parse=res=>JSON.parse((res?.content||[]).filter(x=>x.type==="text").map(x=>x.text||"").join("\n"));
const wrap=parse(await client.callTool({name:"onshape_fabric_invoke",arguments:{
  capability_id:"onshape.documented.operation",
  arguments:{operationId:"getPartStudioFeatures",pathParams:{did:process.env.CF_DID,wvm:"w",wvmid:process.env.CF_WID,eid:process.env.CF_EID},query:{}}
}}));
const r=wrap.result,e=r?.observation?.evidence||{},b=e.body||{};
if(r?.outcome?.state!=="ACHIEVED"||e.httpStatus!==200||e.effectSent!==false) throw new Error("read failed");
if(e.apiVersion!=="v17"||e.observedApiVersion!=="v17"||e.apiVersionMatched!==true) throw new Error("version");
console.log("CF_E9_REF_COUNT="+String((b.features||[]).length));
const wanted=/fillet|chamfer|split|transform|mate|plane|offset|pattern|boolean|move|replace|delete/i;
for(const [i,f] of (b.features||[]).entries()){
  const ps=(f.parameters||[]).map(p=>({
    parameterId:p.parameterId,btType:p.btType,value:p.value,expression:p.expression,
    enumName:p.enumName,queries:p.queries,query:p.query
  }));
  const serialized=JSON.stringify({i,featureId:f.featureId,name:f.name,featureType:f.featureType,btType:f.btType,suppressed:f.suppressed,featureStatus:f.featureStatus,parameters:ps});
  if(wanted.test(String(f.name||""))||wanted.test(String(f.featureType||""))||/qCreatedBy|qOwnedByBody|qOwnerBody|qNthElement|qAdjacent|qContainsPoint|mateConnector/i.test(serialized)){
    console.log("CF_E9_REF_FEATURE="+serialized);
  }
}
await client.close();
NODE
