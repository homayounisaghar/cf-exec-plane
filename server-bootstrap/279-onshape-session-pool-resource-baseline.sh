#!/usr/bin/env bash
set -euo pipefail
umask 077
[[ "$(id -u)" -eq 0 ]] || exit 2

server="capability-fabric-onshape-server"
fabric="capability-fabric-onshape-fabric"
gateway="capability-fabric-onshape-gateway"

echo CF_POOL_BASELINE_BEGIN
echo "CF_POOL_BASELINE_NPROC=$(nproc)"
awk '/^(MemTotal|MemAvailable|SwapTotal|SwapFree):/ {gsub(/:/,"",$1); print "CF_POOL_BASELINE_"$1"_KIB="$2}' /proc/meminfo

for c in "$server" "$fabric" "$gateway"; do
  safe="$(printf "%s" "$c" | tr -c "A-Za-z0-9" "_")"
  if docker inspect "$c" >/dev/null 2>&1; then
    echo "CF_POOL_BASELINE_CONTAINER_${safe}_STATE=$(docker inspect -f '{{.State.Status}}/{{.State.Running}}{{if .State.Health}}/{{.State.Health.Status}}{{end}}' "$c")"
  else
    echo "CF_POOL_BASELINE_CONTAINER_${safe}_STATE=absent"
  fi
done

docker stats --no-stream --format '{{.Name}}|{{.CPUPerc}}|{{.MemUsage}}|{{.MemPerc}}|{{.PIDs}}' "$server" "$fabric" "$gateway" 2>/dev/null |
  while IFS='|' read -r name cpu mem memperc pids; do
    safe="$(printf "%s" "$name" | tr -c "A-Za-z0-9" "_")"
    echo "CF_POOL_BASELINE_DOCKER_${safe}_CPU=$cpu"
    echo "CF_POOL_BASELINE_DOCKER_${safe}_MEM=$mem"
    echo "CF_POOL_BASELINE_DOCKER_${safe}_MEM_PCT=$memperc"
    echo "CF_POOL_BASELINE_DOCKER_${safe}_PIDS=$pids"
  done

if docker inspect "$server" >/dev/null 2>&1; then
  docker exec "$server" sh -lc '
    total=$(ps -eo rss=,comm= 2>/dev/null | awk '"'"'$2 ~ /(chrome|chromium)/ {s+=$1} END {print s+0}'"'"')
    count=$(ps -eo comm= 2>/dev/null | awk '"'"'$1 ~ /(chrome|chromium)/ {n++} END {print n+0}'"'"')
    echo CF_POOL_BASELINE_CHROMIUM_RSS_KIB=$total
    echo CF_POOL_BASELINE_CHROMIUM_PROCESS_COUNT=$count
    ps -eo pid=,ppid=,rss=,args= 2>/dev/null | awk '"'"'
      /--user-data-dir=/ && /(chrome|chromium)/ {
        slot="unknown";
        if ($0 ~ /--user-data-dir=\/profile([[:space:]]|$)/) slot="session-1";
        else if ($0 ~ /--user-data-dir=\/tmp\/onshape-session-pool\/session-2([[:space:]]|$)/) slot="session-2";
        else if ($0 ~ /--user-data-dir=\/tmp\/onshape-session-pool\/session-3([[:space:]]|$)/) slot="session-3";
        print "CF_POOL_BASELINE_BROWSER_MAIN=" slot "|pid=" $1 "|ppid=" $2 "|rss_kib=" $3;
      }'"'"'
  '
fi

docker exec -i "$server" sh -lc 'cd /tmp/app && node --input-type=module' <<'NODE'
import fs from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
const token=fs.readFileSync("/run/secrets/mcp-token","utf8").trim();
const c=new Client({name:"cf-pool-resource-baseline",version:"1.0"});
await c.connect(new StreamableHTTPClientTransport(new URL("http://127.0.0.1:8788/mcp/"+token)));
const parse=r=>JSON.parse((r.content||[]).filter(x=>x.type==="text").map(x=>x.text||"").join("\n"));
try {
  const p=parse(await c.callTool({name:"onshape_pool_status",arguments:{}},undefined,{timeout:180000}));
  console.log("CF_POOL_BASELINE_POOL="+JSON.stringify({
    build_id:p.build_id,
    pool_enabled:p.pool_enabled,
    size:p.size,
    active_count:p.active_count,
    queued_count:p.queued_count,
    document_lock_count:p.document_lock_count,
    session_fingerprints_distinct:p.session_fingerprints_distinct,
    sessions:(p.sessions||[]).map(s=>({
      session_id:s.session_id,
      role:s.role,
      durability:s.durability,
      busy:s.busy,
      browser_started:s.browser_started,
      auth_state:s.auth?.state,
      http_status:s.auth?.http_status,
      current_url_kind:s.current_url_kind
    }))
  }));
} finally {
  await c.close().catch(()=>{});
}
NODE

echo CF_POOL_BASELINE_END
