#!/usr/bin/env bash
set -euo pipefail
umask 077
release=/var/lib/capability-fabric/releases/onshape-three-session-v46-fabric-shadow-r10-pointer-ui
image='mcr.microsoft.com/playwright:v1.62.1-resolute@sha256:aebd85bce8056dcdc2269853fd94ea432b6a201da4f0ef125b509489ecd52ddb'
name=cf-onshape-semantic-only-proof
[[ "$(readlink -f /opt/capability-fabric/current)" == "$release" ]] || { echo CF_FABRIC_SEMANTIC_ONLY_RELEASE=not-current; exit 20; }
[[ -d "$release" && -s "$release/server.js" && -s "$release/gateway.js" ]] || { echo CF_FABRIC_SEMANTIC_ONLY_RELEASE=missing; exit 20; }

ss -lnt | awk '
  $4 == "127.0.0.1:8787" {gateway=1}
  $4 == "127.0.0.1:8788" {backend=1}
  $4 == "127.0.0.1:8789" {diagnostic=1}
  $4 == "127.0.0.1:8791" {fabric=1}
  END {exit gateway && backend && diagnostic && fabric ? 0 : 1}'
if ss -lnt | awk '$4 ~ /^(0\.0\.0\.0|\[::\]|\*):(8787|8788|8789|8791)$/ {found=1} END {exit found ? 0 : 1}'; then
  echo CF_FABRIC_SEMANTIC_ONLY_LOOPBACK_ONLY=fail
  exit 20
fi
[[ "$(curl -sS -o /dev/null -w '%{http_code}' --max-time 2 http://127.0.0.1:8787/internal/fabric/not-public || true)" == 404 ]] || { echo CF_FABRIC_SEMANTIC_ONLY_PUBLIC_INTERNAL_DENY=fail; exit 20; }
[[ -s /etc/caddy/Caddyfile ]] || { echo CF_FABRIC_SEMANTIC_ONLY_CADDY=missing; exit 20; }
grep -Eq 'reverse_proxy[[:space:]]+127\.0\.0\.1:8787([[:space:]]|$)' /etc/caddy/Caddyfile || { echo CF_FABRIC_SEMANTIC_ONLY_CADDY_GATEWAY=fail; exit 20; }
if grep -Eq 'reverse_proxy[[:space:]]+127\.0\.0\.1:(8788|8789|8791)([[:space:]]|$)' /etc/caddy/Caddyfile; then
  echo CF_FABRIC_SEMANTIC_ONLY_CADDY_INTERNAL_EXPOSURE=fail
  exit 20
fi

tmp="$(mktemp -d /var/lib/capability-fabric/.semantic-only-proof.XXXXXX)"
cleanup(){ docker rm -f "$name" >/dev/null 2>&1 || true; rm -rf "$tmp"; }
trap cleanup EXIT
install -d -m 0700 "$tmp/profile" "$tmp/openapi" "$tmp/secrets" "$tmp/agent-state" "$tmp/cf-state"
: > "$tmp/secrets/account"; : > "$tmp/secrets/password"
printf '%064d\n' 0 > "$tmp/mcp-token"
chmod 0600 "$tmp/secrets/account" "$tmp/secrets/password" "$tmp/mcp-token"

docker rm -f "$name" >/dev/null 2>&1 || true
docker run -d --name "$name" --network bridge --read-only --tmpfs /tmp:rw,nosuid,size=1g --cap-drop ALL --security-opt no-new-privileges:true \
  -e HOST=127.0.0.1 -e PORT=8788 -e CF_DIAGNOSTIC_PORT=8789 \
  -e CF_FABRIC_SIDECAR_URL=http://127.0.0.1:8791 -e CF_FABRIC_AGENT_STATE_DIR=/agent-state -e CF_PUBLIC_SURFACE=semantic-only \
  -e MCP_TOKEN_FILE=/run/secrets/mcp-token -e ONSHAPE_PROFILE_DIR=/profile \
  -e ONSHAPE_ACCOUNT_FILE=/run/onshape-secrets/account -e ONSHAPE_PASSWORD_FILE=/run/onshape-secrets/password \
  -e ONSHAPE_COMPANY_OWNER_ID=64a4114074132e1ea68137a8 -e ONSHAPE_ANTI_FORGERY_HEADER_NAME=x-xsrf-token -e ONSHAPE_UI_API_VERSION=v14 \
  -e ONSHAPE_OPENAPI_FILE=/openapi/onshape-openapi.json -e ONSHAPE_POOL_SIZE=3 -e ONSHAPE_POOL_TMP_ROOT=/tmp/onshape-session-pool \
  -e CF_RELEASE_GATE_FILE=/run/cf-state/release-in-progress -e HOME=/tmp -e NODE_ENV=production -e NPM_CONFIG_CACHE=/tmp/npm-cache -e PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
  -v "$release:/release:ro" -v "$tmp/mcp-token:/run/secrets/mcp-token:ro" -v "$tmp/secrets:/run/onshape-secrets:rw" \
  -v "$tmp/profile:/profile:rw" -v "$tmp/openapi:/openapi:rw" -v "$tmp/agent-state:/agent-state:rw" -v "$tmp/cf-state:/run/cf-state:rw" \
  "$image" sh -lc 'umask 077 && chmod 0700 /profile /run/onshape-secrets && mkdir -p /tmp/app && cp /release/package.json /release/server.js /release/gateway.js /release/core.js /release/browser.js /release/session-pool.js /release/onshape-request.cjs /release/fabric-agent.js /tmp/app/ && cd /tmp/app && PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install --omit=dev --ignore-scripts --no-audit --no-fund --package-lock=false && node server.js >/tmp/server.log 2>&1 & server_pid=$!; trap "kill $server_pid >/dev/null 2>&1 || true" EXIT TERM INT; for _ in $(seq 1 120); do curl -fsS http://127.0.0.1:8788/ >/dev/null 2>&1 && break; kill -0 $server_pid 2>/dev/null || { cat /tmp/server.log >&2; exit 1; }; sleep 1; done; exec node /tmp/app/gateway.js' >/dev/null

ready=no
for _ in $(seq 1 120); do
  [[ "$(docker inspect -f '{{.State.Running}}' "$name" 2>/dev/null || echo false)" == true ]] || break
  if docker exec "$name" node -e "fetch('http://127.0.0.1:8787/').then(async r=>{if(!r.ok||(await r.text())!=='cf-onshape-single ok')throw Error()}).then(()=>process.exit(0)).catch(()=>process.exit(1))" >/dev/null 2>&1; then ready=yes; break; fi
  sleep 1
done
[[ "$ready" == yes ]] || { docker logs --tail 120 "$name" >&2 || true; echo CF_FABRIC_SEMANTIC_ONLY_READY=fail; exit 21; }

docker exec -i "$name" sh -lc 'cd /tmp/app && node --input-type=module' <<'NODE'
import fs from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
const token=fs.readFileSync("/run/secrets/mcp-token","utf8").trim();
const client=new Client({name:"cf-semantic-only-proof",version:"1.0.0"});
const transport=new StreamableHTTPClientTransport(new URL("http://127.0.0.1:8787/mcp/"+token));
await client.connect(transport);
const listed=await client.listTools();
const names=(listed.tools||[]).map(x=>x.name).sort();
const expected=["cf_echo","onshape_fabric_capabilities","onshape_fabric_invoke","onshape_fabric_reconcile"].sort();
if(JSON.stringify(names)!==JSON.stringify(expected)) throw new Error("semantic-only public catalog mismatch: "+JSON.stringify(names));
for(const forbidden of ["onshape_session_status","onshape_browser_open","onshape_browser_top_view","onshape_browser_mouse_probe","onshape_browser_pointer","onshape_pool_status","onshape_pool_warmup","onshape_login_start","onshape_operation_status","onshape_documents_get_elements","onshape_partstudio_get_features","onshape_documents_create","onshape_artifact","onshape_request","onshape_openapi","onshape_openapi_coverage","onshape_openapi_refresh"]) {
  if(names.includes(forbidden)) throw new Error("raw effect-capable tool exposed: "+forbidden);
}
console.log("CF_FABRIC_SEMANTIC_ONLY_CATALOG=pass");
const echo=await client.callTool({name:"cf_echo",arguments:{text:"semantic-only-proof"}});
const body=(echo.content||[]).filter(x=>x.type==="text").map(x=>x.text||"").join("\n");
const value=JSON.parse(body);
if(value.build_id!=="onshape-three-session-v46-fabric-ingress-pointer-ui") throw new Error("wrong build: "+value.build_id);
if(value.public_surface!=="semantic-only") throw new Error("wrong public surface: "+value.public_surface);
console.log("CF_FABRIC_SEMANTIC_ONLY_RAW_EFFECT_DENY=pass");
console.log("CF_FABRIC_SEMANTIC_ONLY_BROWSER_UI_HIDDEN=pass");
console.log("CF_FABRIC_SEMANTIC_ONLY_GATEWAY=pass");
await client.close();
NODE

set +e
docker exec -e CF_PUBLIC_SURFACE=invalid "$name" sh -lc 'cd /tmp/app && node server.js >/tmp/invalid-mode.log 2>&1'
invalid_rc=$?
set -e
[[ "$invalid_rc" -ne 0 ]] || { echo CF_FABRIC_SEMANTIC_ONLY_INVALID_MODE_FAIL_CLOSED=fail; exit 22; }
docker exec "$name" grep -q 'Invalid CF_PUBLIC_SURFACE' /tmp/invalid-mode.log || { echo CF_FABRIC_SEMANTIC_ONLY_INVALID_MODE_FAIL_CLOSED=wrong-error; exit 22; }

echo CF_FABRIC_SEMANTIC_ONLY_LOOPBACK_ONLY=pass
echo CF_FABRIC_SEMANTIC_ONLY_PUBLIC_INTERNAL_DENY=pass
echo CF_FABRIC_SEMANTIC_ONLY_CADDY_GATEWAY=pass
echo CF_FABRIC_SEMANTIC_ONLY_INVALID_MODE_FAIL_CLOSED=pass
echo "CF_FABRIC_SEMANTIC_ONLY_LIVE_IMPACT=$(docker inspect -f '{{.State.Running}}' capability-fabric-onshape-server 2>/dev/null || echo false)"
[[ "$(docker inspect -f '{{.State.Running}}' capability-fabric-onshape-server 2>/dev/null || echo false)" == true ]]
echo CF_FABRIC_SEMANTIC_ONLY_PROOF=pass
