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
const client=new Client({name:"cf-e9-part-grammar",version:"1.0.0"});
await client.connect(new StreamableHTTPClientTransport(new URL("http://127.0.0.1:8788/mcp/"+token)));
const parse=res=>JSON.parse((res?.content||[]).filter(x=>x.type==="text").map(x=>x.text||"").join("\n"));
async function probe(label,expr){
 const script='function(context is Context, queries) { return size(evaluateQuery(context, '+expr+')); }';
 const wrap=parse(await client.callTool({name:"onshape_fabric_invoke",arguments:{capability_id:"onshape.documented.operation",arguments:{
   operationId:"evalFeatureScript",pathParams:{did:process.env.CF_DID,wvm:"w",wvmid:process.env.CF_WID,eid:process.env.CF_EID},query:{},body:{script}
 }}}));
 const e=wrap?.result?.observation?.evidence||{}, body=e.body||{};
 if(wrap?.result?.outcome?.state!=="ACHIEVED"||e.httpStatus!==200||e.effectSent!==false) throw new Error(label+" transport");
 if(e.apiVersion!=="v17"||e.observedApiVersion!=="v17"||e.apiVersionMatched!==true) throw new Error(label+" version");
 console.log("CF_E9_PART_"+label+"="+JSON.stringify(body));
}
const F='FwHDp7GXelUCXDl_0';
const point='vector(0.021753765216512438 * meter, 0.01565687540839336 * meter, 0.01 * meter)';
const bodies='qCreatedBy(makeId("'+F+'"), EntityType.BODY)';
const part='qContainsPoint('+bodies+', '+point+')';
const cap='qCapEntity(makeId("'+F+'"), CapType.END, EntityType.FACE)';
const face='qIntersection(['+cap+', qOwnedByBody('+part+', EntityType.FACE)])';
const edge='qAdjacent('+face+', AdjacencyType.EDGE, EntityType.EDGE)';
await probe("PART",part);
await probe("FACE",face);
await probe("EDGE",edge);
await client.close();
NODE
