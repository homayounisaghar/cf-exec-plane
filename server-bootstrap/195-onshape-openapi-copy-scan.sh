#!/usr/bin/env bash
set -euo pipefail
SERVER=capability-fabric-onshape-server
docker exec -i "$SERVER" sh -lc 'cd /tmp/app && node --input-type=module' <<'NODE'
import fs from "node:fs";
import {Client} from "@modelcontextprotocol/sdk/client/index.js";
import {StreamableHTTPClientTransport} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
const token=fs.readFileSync("/run/secrets/mcp-token","utf8").trim();
const c=new Client({name:"cf-openapi-copy-lookup",version:"1.0.0"});
await c.connect(new StreamableHTTPClientTransport(new URL("http://127.0.0.1:8788/mcp/"+token)));
const parse=r=>JSON.parse((r?.content||[]).filter(x=>x.type==="text").map(x=>x.text||"").join("\n"));
for(const keyword of ["copy","duplicate","clone"]){
  const w=parse(await c.callTool({name:"onshape_fabric_invoke",arguments:{
    capability_id:"onshape.openapi.lookup",
    arguments:{keyword}
  }}));
  console.log("CF_COPY_LOOKUP_"+keyword.toUpperCase()+"="+JSON.stringify(w));
}
await c.close();
NODE
