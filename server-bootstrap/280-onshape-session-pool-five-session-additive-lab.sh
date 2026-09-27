#!/usr/bin/env bash
set -euo pipefail
umask 077
[[ "$(id -u)" -eq 0 ]] || exit 2

candidate="774434bd3f442c7d8ec570e66f6620c59add3813"
container="capability-fabric-onshape-pool-lab"
root="/var/lib/capability-fabric/onshape-session-pool-lab"
release="$root/releases/$candidate"
cache="/var/lib/capability-fabric/repo.git"
repo_token="/etc/capability-fabric/secrets/repo-read-token"
git_home="/var/lib/capability-fabric/agent-home"
lab_token="$root/mcp-token"
prod="capability-fabric-onshape-server"

cleanup_lab(){
  docker rm -f "$container" >/dev/null 2>&1 || true
  rm -rf "$root/profile" "$root/agent-state" "$root/state"
}
rc=0
keep_lab=0
finish(){
  rc=$?
  if [[ "$keep_lab" -eq 0 ]]; then cleanup_lab; fi
  exit "$rc"
}
trap finish EXIT

[[ -d "$cache" && -s "$repo_token" ]] || { echo CF_POOL5_LAB_REPO=missing; exit 20; }
[[ "$(docker inspect -f '{{.State.Running}}' "$prod" 2>/dev/null || echo false)" == true ]] || exit 21
[[ "$(docker inspect -f '{{.State.Health.Status}}' "$prod")" == healthy ]] || exit 21
if docker inspect "$container" >/dev/null 2>&1; then
  echo CF_POOL5_LAB_EXISTING=unexpected
  exit 22
fi

mkdir -p "$root/releases" "$root/profile" "$root/agent-state" "$root/state"
chmod 0700 "$root" "$root/releases" "$root/profile" "$root/agent-state" "$root/state"
if [[ ! -d "$release" ]]; then
  tmp="$(mktemp -d "$root/.fetch.XXXXXX")"
  ask="$tmp/askpass"
  cat >"$ask" <<'ASK'
#!/usr/bin/env bash
case "${1:-}" in
  *Username*) printf "%s\n" x-access-token ;;
  *Password*) cat /etc/capability-fabric/secrets/repo-read-token ;;
  *) exit 1 ;;
esac
ASK
  chmod 0700 "$ask"
  exec 9>/run/lock/capability-fabric-pull.lock
  flock -w 30 9 || exit 23
  GIT_ASKPASS="$ask" GIT_TERMINAL_PROMPT=0 HOME="$git_home" git --git-dir="$cache" fetch --quiet --force --depth=1 origin "$candidate"
  [[ "$(git --git-dir="$cache" rev-parse FETCH_HEAD)" == "$candidate" ]] || exit 24
  mkdir "$tmp/release"
  git --git-dir="$cache" archive "$candidate" | tar -x -C "$tmp/release"
  mv "$tmp/release" "$release"
  flock -u 9
  rm -rf "$tmp"
fi
[[ -s "$release/server-deploy/current/server.js" && -s "$release/server-deploy/current/session-pool.js" ]] || exit 25

if [[ ! -s "$lab_token" ]]; then
  python3 - <<'PY' >"$lab_token"
import secrets
print(secrets.token_urlsafe(36))
PY
  chmod 0600 "$lab_token"
fi

image="$(docker inspect -f '{{.Config.Image}}' "$prod")"
echo "CF_POOL5_LAB_IMAGE=$image"

docker run -d --name "$container" \
  --memory=2560m --cpus=2 --pids-limit=256 \
  -p 127.0.0.1:8918:8788 -p 127.0.0.1:8919:8789 \
  --read-only --tmpfs /tmp:rw,size=2048m \
  -v "$release:/release:ro" \
  -v "$lab_token:/run/secrets/mcp-token:ro" \
  -v /etc/capability-fabric/secrets/onshape:/run/onshape-secrets:ro \
  -v /var/lib/capability-fabric/onshape/openapi:/openapi:ro \
  -v "$root/profile:/profile:rw" \
  -v "$root/agent-state:/agent-state:rw" \
  -v "$root/state:/run/cf-state:ro" \
  -v /var/lib/capability-fabric/onshape/runtime-control:/run/cf-authority:ro \
  -e HOST=0.0.0.0 \
  -e PORT=8788 \
  -e CF_DIAGNOSTIC_PORT=8789 \
  -e CF_FABRIC_SIDECAR_URL=http://127.0.0.1:8791 \
  -e CF_FABRIC_AGENT_STATE_DIR=/agent-state \
  -e CF_ONSHAPE_RUNTIME_CONTROL_FILE=/run/cf-authority/ONSHAPE_RUNTIME_CONTROL.json \
  -e CF_FABRIC_REQUIRE_PRODUCTION_AUTHORITY=0 \
  -e CF_PRIVILEGED_NATIVE_ENABLED=0 \
  -e CF_PUBLIC_SURFACE=shadow \
  -e MCP_TOKEN_FILE=/run/secrets/mcp-token \
  -e ONSHAPE_PROFILE_DIR=/profile \
  -e ONSHAPE_ACCOUNT_FILE=/run/onshape-secrets/account \
  -e ONSHAPE_PASSWORD_FILE=/run/onshape-secrets/password \
  -e ONSHAPE_COMPANY_OWNER_ID=64a4114074132e1ea68137a8 \
  -e ONSHAPE_ANTI_FORGERY_HEADER_NAME=x-xsrf-token \
  -e ONSHAPE_UI_API_VERSION=v14 \
  -e ONSHAPE_OPENAPI_FILE=/openapi/onshape-openapi.json \
  -e ONSHAPE_POOL_SIZE=2 \
  -e ONSHAPE_POOL_TMP_ROOT=/tmp/onshape-session-pool \
  -e CF_RELEASE_GATE_FILE=/run/cf-state/release-in-progress \
  -e PCG_WEB_SOCKET=/run/pcg/web.sock \
  -e NODE_ENV=production \
  -e NPM_CONFIG_CACHE=/tmp/npm-cache \
  -e PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
  -e HOME=/tmp \
  "$image" sh -lc '
    umask 077 && mkdir -p /tmp/app &&
    cp /release/server-deploy/current/package.json /release/server-deploy/current/server.js /release/server-deploy/current/core.js /release/server-deploy/current/browser.js /release/server-deploy/current/session-pool.js /release/server-deploy/current/onshape-request.cjs /release/server-deploy/current/fabric-agent.js /release/server-deploy/current/telegram-ingress.mjs /tmp/app/ &&
    cd /tmp/app &&
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install --omit=dev --ignore-scripts --no-audit --no-fund --package-lock=false &&
    exec node server.js
  ' >/dev/null

for i in $(seq 1 90); do
  if curl -fsS http://127.0.0.1:8918/ 2>/dev/null | grep -Fxq "cf-onshape-single ok" && curl -fsS http://127.0.0.1:8919/ 2>/dev/null | grep -Fxq "cf-onshape-single ok"; then break; fi
  [[ "$(docker inspect -f '{{.State.Running}}' "$container" 2>/dev/null || echo false)" == true ]] || { docker logs --tail 120 "$container" 2>&1 || true; exit 26; }
  sleep 2
done
curl -fsS http://127.0.0.1:8918/ | grep -Fxq "cf-onshape-single ok"
echo CF_POOL5_LAB_SERVER=ready

docker exec -i "$container" sh -lc 'cd /tmp/app && node --input-type=module' <<'NODE'
import fs from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
const token=fs.readFileSync("/run/secrets/mcp-token","utf8").trim();
const c=new Client({name:"cf-pool5-lab",version:"1.0"});
await c.connect(new StreamableHTTPClientTransport(new URL("http://127.0.0.1:8788/mcp/"+token)));
const parse=r=>JSON.parse((r.content||[]).filter(x=>x.type==="text").map(x=>x.text||"").join("\n"));
const call=async(name,args={})=>parse(await c.callTool({name,arguments:args},undefined,{timeout:180000}));
try {
  const before=await call("onshape_pool_status");
  if(before.size!==2) throw new Error("lab pool size mismatch");
  const start=await call("onshape_pool_warmup");
  const opId=String(start.operation_id||"");
  if(!opId) throw new Error("warmup operation id missing");
  let terminal=null;
  for(let i=0;i<240;i++){
    const op=await call("onshape_operation_status",{operation_id:opId});
    if(op.status==="SUCCEEDED"||op.status==="FAILED"||op.status==="AWAITING_INPUT"){terminal=op;break;}
    await new Promise(r=>setTimeout(r,1000));
  }
  if(!terminal) throw new Error("warmup timeout");
  if(terminal.status==="AWAITING_INPUT"){
    console.log("CF_POOL5_LAB_NEEDS_VERIFICATION="+String(terminal.input_required||"UNKNOWN"));
    process.exitCode=42;
    return;
  }
  if(terminal.status!=="SUCCEEDED"){
    if(terminal?.error?.code==="POOL_INTERACTIVE_INPUT_REQUIRED"){
      console.log("CF_POOL5_LAB_NEEDS_VERIFICATION=EMAIL_VERIFICATION_CODE");
      process.exitCode=42;
      return;
    }
    throw new Error("warmup failed:"+JSON.stringify(terminal.error||terminal));
  }
  const status=await call("onshape_pool_status");
  if(status.pool_enabled!==true||status.size!==2||status.session_fingerprints_distinct!==true) throw new Error("lab pool not qualified");
  if(!status.sessions.every(s=>s?.auth?.state==="PROVEN"&&s?.auth?.http_status===200)) throw new Error("lab auth not proven");
  const t0=performance.now();
  const [a,b]=await Promise.all([
    call("onshape_request",{method:"GET",path:"/api/users/current"}),
    call("onshape_request",{method:"GET",path:"/api/users/current"})
  ]);
  const ids=[a?.pool_execution?.session_id,b?.pool_execution?.session_id];
  if(new Set(ids).size!==2) throw new Error("lab concurrent reads did not use two distinct slots");
  console.log("CF_POOL5_LAB_WARMUP=pass");
  console.log("CF_POOL5_LAB_READ_SESSIONS="+ids.sort().join(","));
  console.log("CF_POOL5_LAB_TWO_READ_WALL_MS="+(performance.now()-t0).toFixed(2));
} finally { await c.close().catch(()=>{}); }
NODE
node_rc=$?
if (( node_rc == 42 )); then
  keep_lab=1
  echo CF_POOL5_LAB=awaiting-verification
  exit 42
fi
(( node_rc == 0 )) || exit "$node_rc"

# Re-probe the existing three production sessions after the two new lab logins.
docker exec -i "$prod" sh -lc 'cd /tmp/app && node --input-type=module' <<'NODE'
import fs from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
const token=fs.readFileSync("/run/secrets/mcp-token","utf8").trim();
const c=new Client({name:"cf-pool5-prod-reprobe",version:"1.0"});
await c.connect(new StreamableHTTPClientTransport(new URL("http://127.0.0.1:8788/mcp/"+token)));
const parse=r=>JSON.parse((r.content||[]).filter(x=>x.type==="text").map(x=>x.text||"").join("\n"));
try {
  const p=parse(await c.callTool({name:"onshape_pool_status",arguments:{}},undefined,{timeout:180000}));
  if(p.pool_enabled!==true||p.size!==3||p.session_fingerprints_distinct!==true) throw new Error("production pool degraded");
  if(p.active_count!==0||p.queued_count!==0||p.document_lock_count!==0) throw new Error("production pool unexpectedly busy");
  if(!p.sessions.every(s=>s?.auth?.state==="PROVEN"&&s?.auth?.http_status===200)) throw new Error("production session revoked");
  console.log("CF_POOL5_PRODUCTION_3OF3_REPROBE=pass");
} finally { await c.close().catch(()=>{}); }
NODE

# Re-probe the two lab sessions after production reprobe.
docker exec -i "$container" sh -lc 'cd /tmp/app && node --input-type=module' <<'NODE'
import fs from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
const token=fs.readFileSync("/run/secrets/mcp-token","utf8").trim();
const c=new Client({name:"cf-pool5-lab-reprobe",version:"1.0"});
await c.connect(new StreamableHTTPClientTransport(new URL("http://127.0.0.1:8788/mcp/"+token)));
const parse=r=>JSON.parse((r.content||[]).filter(x=>x.type==="text").map(x=>x.text||"").join("\n"));
try {
  const p=parse(await c.callTool({name:"onshape_pool_status",arguments:{}},undefined,{timeout:180000}));
  if(p.pool_enabled!==true||p.size!==2||p.session_fingerprints_distinct!==true) throw new Error("lab pool degraded");
  if(!p.sessions.every(s=>s?.auth?.state==="PROVEN"&&s?.auth?.http_status===200)) throw new Error("lab session revoked");
  console.log("CF_POOL5_LAB_2OF2_REPROBE=pass");
} finally { await c.close().catch(()=>{}); }
NODE

awk '/^(MemTotal|MemAvailable|SwapTotal|SwapFree):/ {gsub(/:/,"",$1); print "CF_POOL5_"$1"_KIB="$2}' /proc/meminfo
docker stats --no-stream --format '{{.Name}}|{{.CPUPerc}}|{{.MemUsage}}|{{.MemPerc}}|{{.PIDs}}' "$prod" "$container" |
  while IFS='|' read -r name cpu mem memperc pids; do
    safe="$(printf "%s" "$name" | tr -c "A-Za-z0-9" "_")"
    echo "CF_POOL5_DOCKER_${safe}_CPU=$cpu"
    echo "CF_POOL5_DOCKER_${safe}_MEM=$mem"
    echo "CF_POOL5_DOCKER_${safe}_MEM_PCT=$memperc"
    echo "CF_POOL5_DOCKER_${safe}_PIDS=$pids"
  done

echo CF_POOL5_COMBINED_AUTHENTICATED_SESSIONS=5
echo CF_POOL5_PROVIDER_STABILITY=pass
echo CF_POOL5_PHASE2_ADDITIVE_LAB=pass
