#!/usr/bin/env bash
set -euo pipefail
umask 077
[[ "$(id -u)" -eq 0 ]] || { echo CF_PROD_BOUNDARY_REQUIRES_ROOT >&2; exit 2; }
active=/opt/capability-fabric/current
[[ -L "$active" ]] || { echo CF_PROD_BOUNDARY_ACTIVE_RELEASE=missing >&2; exit 20; }
release="$(readlink -f "$active")"
[[ "$release" == /var/lib/capability-fabric/releases/* ]] || { echo CF_PROD_BOUNDARY_ACTIVE_RELEASE=invalid >&2; exit 20; }
[[ -s "$release/compose.yaml" && -s "$release/server.js" && -s "$release/fabric-agent.js" ]] || { echo CF_PROD_BOUNDARY_RELEASE_FILES=missing >&2; exit 20; }
grep -Eq 'CF_PUBLIC_SURFACE:[[:space:]]*semantic-only' "$release/compose.yaml" || exit 21
grep -Eq 'CF_FABRIC_REQUIRE_PRODUCTION_AUTHORITY:[[:space:]]*"1"' "$release/compose.yaml" || exit 21
grep -Eq 'CF_FABRIC_QUALIFICATION_MODE:[[:space:]]*"0"' "$release/compose.yaml" || exit 21
grep -Eq 'CF_PRIVILEGED_NATIVE_ENABLED:[[:space:]]*"0"' "$release/compose.yaml" || exit 21
[[ ! -e "$release/browser-native.js" ]] || { echo CF_PROD_BOUNDARY_NATIVE_RELEASE_ABSENCE=fail >&2; exit 21; }
for p in 8787 8788 8789 8791; do
  ss -lnt | awk -v x="127.0.0.1:$p" '$4 == x {f=1} END {exit f?0:1}' || exit 22
  if ss -lnt | awk -v x="$p" '$4 == "0.0.0.0:"x || $4 == "[::]:"x || $4 == "*:"x {f=1} END {exit f?0:1}'; then exit 22; fi
done
[[ -s /etc/caddy/Caddyfile ]] || exit 23
grep -Eq 'reverse_proxy[[:space:]]+127\.0\.0\.1:8787([[:space:]]|$)' /etc/caddy/Caddyfile || exit 23
if grep -Eq 'reverse_proxy[[:space:]]+127\.0\.0\.1:(8788|8789|8791)([[:space:]]|$)' /etc/caddy/Caddyfile; then exit 23; fi
container=capability-fabric-onshape-server
[[ "$(docker inspect -f '{{.State.Running}}' "$container" 2>/dev/null || echo false)" == true ]] || exit 24
docker exec "$container" test ! -e /tmp/app/browser-native.js || exit 24
docker exec "$container" sh -lc 'test "$CF_PUBLIC_SURFACE" = semantic-only; test "$CF_FABRIC_REQUIRE_PRODUCTION_AUTHORITY" = 1; test "${CF_PRIVILEGED_NATIVE_ENABLED:-0}" = 0' || exit 24
token="$(tr -d '\r\n' < /etc/capability-fabric/secrets/mcp-token)"
[[ "$token" =~ ^[A-Za-z0-9_-]{32,}$ ]] || exit 25
[[ "$(curl -sS -o /dev/null -w '%{http_code}' --max-time 2 "http://127.0.0.1:8789/mcp/$token" || true)" == 404 ]] || exit 25
[[ "$(curl -sS -o /dev/null -w '%{http_code}' --max-time 2 http://127.0.0.1:8789/internal/fabric/not-a-valid-key || true)" == 404 ]] || exit 25
docker exec -i "$container" sh -lc 'cd /tmp/app && node --input-type=module' <<'NODE'
import fs from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
const token=fs.readFileSync("/run/secrets/mcp-token","utf8").trim();
const client=new Client({name:"cf-production-boundary-proof",version:"1.0.0"});
const transport=new StreamableHTTPClientTransport(new URL("http://127.0.0.1:8788/mcp/"+token));
await client.connect(transport);
const names=(await client.listTools()).tools.map(x=>x.name).sort();
const expected=["cf_echo","onshape_fabric_capabilities","onshape_fabric_invoke","onshape_fabric_reconcile"].sort();
if(JSON.stringify(names)!==JSON.stringify(expected)) throw new Error("catalog:"+JSON.stringify(names));
for(const capability_id of ["onshape.ui.native","onshape.ui.input.sequence"]){
  const denied=await client.callTool({name:"onshape_fabric_invoke",arguments:{capability_id,arguments:{}}});
  const body=denied.content.filter(x=>x.type==="text").map(x=>x.text||"").join("\n");
  const value=JSON.parse(body);
  if(value?.status!=="FAILED"||value?.error?.code!=="CAPABILITY_NOT_ADMITTED") throw new Error("not denied:"+capability_id);
}
console.log("CF_PROD_BOUNDARY_TOOL_CATALOG=pass");
console.log("CF_PROD_BOUNDARY_GENERIC_PRIVILEGED_DENY=pass");
await client.close();
NODE
echo CF_PROD_BOUNDARY_PROOF_BEGIN
echo "ACTIVE_RELEASE=$(basename "$release")"
echo CF_PROD_BOUNDARY_LOOPBACK_ONLY=pass
echo CF_PROD_BOUNDARY_CADDY_GATEWAY_ONLY=pass
echo CF_PROD_BOUNDARY_NATIVE_RELEASE_ABSENCE=pass
echo CF_PROD_BOUNDARY_NATIVE_RUNTIME_ABSENCE=pass
echo CF_PROD_BOUNDARY_RAW_DIAGNOSTIC_MCP_ABSENT=pass
echo CF_PROD_BOUNDARY_INTERNAL_KEY_DENY=pass
echo CF_PROD_BOUNDARY_PROOF_END
