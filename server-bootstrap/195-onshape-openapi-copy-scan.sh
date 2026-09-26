#!/usr/bin/env bash
set -euo pipefail
SERVER=capability-fabric-onshape-server
docker exec -i "$SERVER" sh -lc 'cd /tmp/app && node --input-type=module' <<'NODE'
import fs from "node:fs";
import {Client} from "@modelcontextprotocol/sdk/client/index.js";
import {StreamableHTTPClientTransport} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
const token=fs.readFileSync("/run/secrets/mcp-token","utf8").trim();
const c=new Client({name:"cf-openapi-copy-scan",version:"1.0.0"});
await c.connect(new StreamableHTTPClientTransport(new URL("http://127.0.0.1:8788/mcp/"+token)));
const parse=r=>JSON.parse((r?.content||[]).filter(x=>x.type==="text").map(x=>x.text||"").join("\n"));
const w=parse(await c.callTool({name:"onshape_fabric_invoke",arguments:{
 capability_id:"onshape.documented.operation",
 arguments:{operationId:"getOpenApiSchema",pathParams:{},query:{}}
}}));
const rr=w?.result,e=rr?.observation?.evidence||{},b=e.body||{};
if(rr?.outcome?.state!=="ACHIEVED"||e.httpStatus!==200||e.effectSent!==false) throw new Error("openapi read");
for(const [p,item] of Object.entries(b.paths||{})){
 for(const [method,op] of Object.entries(item||{})){
  if(!op||typeof op!=="object") continue;
  const id=String(op.operationId||"");
  const text=(id+" "+String(op.summary||"")+" "+p).toLowerCase();
  if(/copy|clone|duplicate|workspace|document/.test(text) && /(copy|clone|duplicate)/.test(text)){
    console.log("CF_COPY_OP="+JSON.stringify({operationId:id,method:method.toUpperCase(),path:p,summary:op.summary||""}));
  }
 }
}
await c.close();
NODE
