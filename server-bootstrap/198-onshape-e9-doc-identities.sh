#!/usr/bin/env bash
set -euo pipefail
SERVER=capability-fabric-onshape-server
DIDS='9c19201d51bb3d73a1833128 52326aa681e54d6c04f2aa38 0d652d94d5c2322ff732b488 1e9b8b9b2b0dc2e6c0bc0997 8ca702971e2419cfa45cc87c'
docker exec -e CF_DIDS="$DIDS" -i "$SERVER" sh -lc 'cd /tmp/app && node --input-type=module' <<'NODE'
import fs from "node:fs";
import {Client} from "@modelcontextprotocol/sdk/client/index.js";
import {StreamableHTTPClientTransport} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
const token=fs.readFileSync("/run/secrets/mcp-token","utf8").trim();
const c=new Client({name:"cf-e9-doc-identities",version:"1.0.0"});
await c.connect(new StreamableHTTPClientTransport(new URL("http://127.0.0.1:8788/mcp/"+token)));
const parse=r=>JSON.parse((r?.content||[]).filter(x=>x.type==="text").map(x=>x.text||"").join("\n"));
for(const did of process.env.CF_DIDS.split(/\s+/).filter(Boolean)){
 const w=parse(await c.callTool({name:"onshape_fabric_invoke",arguments:{capability_id:"onshape.documented.operation",arguments:{
  operationId:"getDocument",pathParams:{did},query:{}
 }}}));
 const r=w?.result,e=r?.observation?.evidence||{},b=e.body||{};
 if(r?.outcome?.state!=="ACHIEVED"||e.httpStatus!==200||e.effectSent!==false) throw new Error("read "+did);
 console.log("CF_E9_DOC="+JSON.stringify({did,name:b.name,description:b.description,owner:b.owner,defaultWorkspace:b.defaultWorkspace,public:b.public,trash:b.trash,createdAt:b.createdAt,modifiedAt:b.modifiedAt}));
}
await c.close();
NODE
