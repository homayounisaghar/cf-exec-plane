#!/usr/bin/env bash
set -euo pipefail
umask 077
SERVER=capability-fabric-onshape-server
DID=9c19201d51bb3d73a1833128
WID=0a7ff1a635d5448549080491
EIDS='8047432dd707507a6ebe596e 4d351fc962530efc756f4ab7 654bc9cd8c4b49435a1a005f 0a258b43c39cc71979174786 a5de8dabb7c175d2f71bea4d 564e03da78ab1ac3c8af73c7 12374b349df0a39189ff31b7'

docker exec -e CF_DID="$DID" -e CF_WID="$WID" -e CF_EIDS="$EIDS" -i "$SERVER" sh -lc 'cd /tmp/app && node --input-type=module' <<'NODE'
import fs from "node:fs";
import {Client} from "@modelcontextprotocol/sdk/client/index.js";
import {StreamableHTTPClientTransport} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
const token=fs.readFileSync("/run/secrets/mcp-token","utf8").trim();
const client=new Client({name:"cf-e9-ref-scan",version:"1.0.0"});
await client.connect(new StreamableHTTPClientTransport(new URL("http://127.0.0.1:8788/mcp/"+token)));
const parse=res=>JSON.parse((res?.content||[]).filter(x=>x.type==="text").map(x=>x.text||"").join("\n"));
for(const eid of process.env.CF_EIDS.split(/\s+/).filter(Boolean)){
  const wrap=parse(await client.callTool({name:"onshape_fabric_invoke",arguments:{
    capability_id:"onshape.documented.operation",
    arguments:{operationId:"getPartStudioFeatures",pathParams:{did:process.env.CF_DID,wvm:"w",wvmid:process.env.CF_WID,eid},query:{}}
  }}));
  const r=wrap.result,e=r?.observation?.evidence||{},b=e.body||{};
  if(r?.outcome?.state!=="ACHIEVED"||e.httpStatus!==200||e.effectSent!==false) throw new Error("read "+eid);
  for(const [i,f] of (b.features||[]).entries()){
    if(/plane|mateconnector|mate connector/i.test(String(f.featureType||"")+" "+String(f.name||""))){
      console.log("CF_E9_REF_SCAN="+JSON.stringify({eid,i,featureId:f.featureId,name:f.name,featureType:f.featureType,btType:f.btType,suppressed:f.suppressed,featureStatus:f.featureStatus,parameters:f.parameters}));
    }
  }
}
await client.close();
NODE
