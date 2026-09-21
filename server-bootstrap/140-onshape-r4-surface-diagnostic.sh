#!/usr/bin/env bash
set -euo pipefail
umask 077
[[ "$(id -u)" -eq 0 ]] || exit 2

ACTIVE=/opt/capability-fabric/current
CONTROL=/var/lib/capability-fabric/onshape/runtime-control/ONSHAPE_RUNTIME_CONTROL.json
GATE=/var/lib/capability-fabric/state/release-in-progress
GATEWAY=capability-fabric-onshape-gateway
SERVER=capability-fabric-onshape-server

[[ "$(readlink -f "$ACTIVE")" == /var/lib/capability-fabric/releases/onshape-vps-hardened-production-r4 ]]
[[ "$(git hash-object "$CONTROL")" == 177ddde1070c6a75f7cf94a15db1a0c93fa45159 ]]
[[ -f "$GATE" ]]
[[ "$(docker inspect -f '{{.State.Running}}' "$GATEWAY")" == false ]]
[[ "$(docker inspect -f '{{.State.Running}}' "$SERVER")" == true ]]

docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$SERVER" | grep -E '^(CF_PUBLIC_SURFACE|CF_FABRIC_REQUIRE_PRODUCTION_AUTHORITY|CF_PRIVILEGED_NATIVE_ENABLED)=' | sort

docker exec -i "$SERVER" sh -lc 'cd /tmp/app && node --input-type=module' <<'NODE'
import fs from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
const token=fs.readFileSync("/run/secrets/mcp-token","utf8").trim();
const client=new Client({name:"cf-r4-surface-diagnostic",version:"1.0.0"});
const transport=new StreamableHTTPClientTransport(new URL("http://127.0.0.1:8788/mcp/"+token));
await client.connect(transport);
const rawRes=await client.callTool({name:"onshape_fabric_capabilities",arguments:{}});
const raw=(rawRes?.content||[]).filter(x=>x.type==="text").map(x=>x.text||"").join("\n");
if(!raw) throw new Error("empty capabilities response");
const caps=JSON.parse(raw);
console.log("CF_R4_DIAG_BUILD_ID="+String(caps.build_id));
console.log("CF_R4_DIAG_PUBLIC_SURFACE="+String(caps.public_surface));
console.log("CF_R4_DIAG_QUALIFICATION_ONLY="+String(caps.qualification_only));
console.log("CF_R4_DIAG_IS_ERROR="+String(rawRes?.isError===true));
console.log("CF_R4_DIAG_CAPABILITY_COUNT="+String((caps.capabilities||[]).length));
const tools=(await client.listTools()).tools.map(x=>x.name).sort();
console.log("CF_R4_DIAG_TOOL_NAMES="+tools.join(","));
await client.close();
NODE

echo CF_R4_DIAG=pass
