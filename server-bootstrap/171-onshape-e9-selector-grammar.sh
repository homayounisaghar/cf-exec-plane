#!/usr/bin/env bash
set -euo pipefail
umask 077
SERVER=capability-fabric-onshape-server
DID=8ca702971e2419cfa45cc87c
WID=8bbf262de8f6c2015d72fd7d
EID=dc6eb5c8b694395c14024558

docker exec -e CF_DID="$DID" -e CF_WID="$WID" -e CF_EID="$EID" -i "$SERVER" sh -lc 'cd /tmp/app && node --input-type=module' <<'NODE'
import fs from "node:fs";
import {Client} from "@modelcontextprotocol/sdk/client/index.js";
import {StreamableHTTPClientTransport} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
const token=fs.readFileSync("/run/secrets/mcp-token","utf8").trim();
const client=new Client({name:"cf-e9-selector-grammar",version:"1.0.0"});
await client.connect(new StreamableHTTPClientTransport(new URL("http://127.0.0.1:8788/mcp/"+token)));
const parse=res=>JSON.parse((res?.content||[]).filter(x=>x.type==="text").map(x=>x.text||"").join("\n"));
async function evalScript(label,script){
 const wrap=parse(await client.callTool({name:"onshape_fabric_invoke",arguments:{
   capability_id:"onshape.documented.operation",
   arguments:{operationId:"evalFeatureScript",pathParams:{did:process.env.CF_DID,wvm:"w",wvmid:process.env.CF_WID,eid:process.env.CF_EID},query:{},body:{script}}
 }}));
 const r=wrap.result,e=r?.observation?.evidence||{};
 if(r?.outcome?.state!=="ACHIEVED"||e.httpStatus!==200||e.effectSent!==false) throw new Error(label+" transport "+JSON.stringify(wrap));
 if(e.apiVersion!=="v17"||e.observedApiVersion!=="v17"||e.apiVersionMatched!==true) throw new Error(label+" version");
 console.log("CF_E9_GRAMMAR_"+label+"="+JSON.stringify(e.body));
}
const F='FwHDp7GXelUCXDl_0';
await evalScript("RIGHT", 'function(context is Context, queries) { return size(evaluateQuery(context, qCreatedBy(makeId("Right"), EntityType.FACE))); }');
await evalScript("BODY", 'function(context is Context, queries) { return size(evaluateQuery(context, qCreatedBy(makeId("'+F+'"), EntityType.BODY))); }');
await evalScript("END_FACE", 'function(context is Context, queries) { return size(evaluateQuery(context, qCapEntity(makeId("'+F+'"), CapType.END, EntityType.FACE))); }');
await evalScript("END_EDGE", 'function(context is Context, queries) { var f = qCapEntity(makeId("'+F+'"), CapType.END, EntityType.FACE); return size(evaluateQuery(context, qAdjacent(f, AdjacencyType.EDGE, EntityType.EDGE))); }');
await client.close();
NODE
