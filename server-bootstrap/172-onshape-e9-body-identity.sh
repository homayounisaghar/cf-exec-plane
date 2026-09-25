#!/usr/bin/env bash
set -euo pipefail
SERVER=capability-fabric-onshape-server
DID=8ca702971e2419cfa45cc87c
WID=8bbf262de8f6c2015d72fd7d
EID=dc6eb5c8b694395c14024558
docker exec -e CF_DID="$DID" -e CF_WID="$WID" -e CF_EID="$EID" -i "$SERVER" sh -lc 'cd /tmp/app && node --input-type=module' <<'NODE'
import fs from "node:fs";
import {Client} from "@modelcontextprotocol/sdk/client/index.js";
import {StreamableHTTPClientTransport} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
const token=fs.readFileSync("/run/secrets/mcp-token","utf8").trim();
const client=new Client({name:"cf-e9-body-identity",version:"1.0.0"});
await client.connect(new StreamableHTTPClientTransport(new URL("http://127.0.0.1:8788/mcp/"+token)));
const parse=res=>JSON.parse((res?.content||[]).filter(x=>x.type==="text").map(x=>x.text||"").join("\n"));
const wrap=parse(await client.callTool({name:"onshape_fabric_invoke",arguments:{capability_id:"onshape.documented.operation",arguments:{
 operationId:"getPartStudioBodyDetails",pathParams:{did:process.env.CF_DID,wvm:"w",wvmid:process.env.CF_WID,eid:process.env.CF_EID},query:{}
}}}));
const b=wrap?.result?.observation?.evidence?.body||{};
for(const body of b.bodies||[]){
 console.log("CF_E9_BODY_IDENTITY="+JSON.stringify({
   id:body.id,name:body.name,type:body.type,
   keys:Object.keys(body),
   faces:(body.faces||[]).map(f=>({id:f.id,orientation:f.orientation,surface:f.surface})),
   edges:(body.edges||[]).map(e=>({id:e.id,curve:e.curve}))
 }));
}
await client.close();
NODE
