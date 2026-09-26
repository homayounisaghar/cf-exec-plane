#!/usr/bin/env bash
set -euo pipefail
SERVER=capability-fabric-onshape-server
DID=9c19201d51bb3d73a1833128
WID=0a7ff1a635d5448549080491
EID=8047432dd707507a6ebe596e
docker exec -e CF_DID="$DID" -e CF_WID="$WID" -e CF_EID="$EID" -i "$SERVER" sh -lc 'cd /tmp/app && node --input-type=module' <<'NODE'
import fs from "node:fs";
import {Client} from "@modelcontextprotocol/sdk/client/index.js";
import {StreamableHTTPClientTransport} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
const token=fs.readFileSync("/run/secrets/mcp-token","utf8").trim();
const c=new Client({name:"cf-e9-mate-targeted-read",version:"1.0.0"});
await c.connect(new StreamableHTTPClientTransport(new URL("http://127.0.0.1:8788/mcp/"+token)));
const parse=r=>JSON.parse((r?.content||[]).filter(x=>x.type==="text").map(x=>x.text||"").join("\n"));
const wrap=parse(await c.callTool({name:"onshape_fabric_invoke",arguments:{capability_id:"onshape.documented.operation",arguments:{
  operationId:"getPartStudioFeatures",
  pathParams:{did:process.env.CF_DID,wvm:"w",wvmid:process.env.CF_WID,eid:process.env.CF_EID},
  query:{}
}}}));
const r=wrap?.result,e=r?.observation?.evidence||{},b=e.body||{};
if(r?.outcome?.state!=="ACHIEVED"||e.httpStatus!==200||e.effectSent!==false) throw new Error("read");
if(e.apiVersion!=="v17"||e.observedApiVersion!=="v17"||e.apiVersionMatched!==true) throw new Error("version");
console.log("CF_E9_MATE_REF_SOURCE_MICROVERSION="+String(b.sourceMicroversion||""));
const targets=new Set(["FKzbp5AVTcxyATj","Fe6PsC3LkqmEwnQ","F4D5F3ieOBhi3l5","FsqvR1htqYMsjKK","FtXfdTAOwVHYRkf","Fdv6b8J1gRZg1kL","FGzVLhO3o6EnZLD","FhIxU9X8H7G4qaG","FuL4ZV2rBRVQvsV","Fk8Kk48kCKLiOQs","FFazcm9kW1blGWE","FXyNJA8fdequEuf","FCfP1Z5tQcoSupl_5","FNw2DaKskKXLYs2_5","F3SXsDSwe9zdg32_132"]);
for(const [i,f] of (b.features||[]).entries()){
  const serialized=JSON.stringify(f.parameters||[]);
  if(f.featureType==="mateConnector"||targets.has(f.featureId)||serialized.includes("FHTzF0N7ggWpsS6_5")){
    console.log("CF_E9_MATE_REF_FEATURE="+JSON.stringify({
      i,featureId:f.featureId,name:f.name,featureType:f.featureType,btType:f.btType,
      suppressed:f.suppressed,status:b?.featureStates?.[f.featureId]?.featureStatus||f.featureStatus||null,
      parameters:f.parameters
    }));
  }
}
await c.close();
NODE
