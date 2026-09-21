#!/usr/bin/env bash
set -euo pipefail
umask 077
[[ "$(id -u)" -eq 0 ]] || exit 2

ACTIVE=/opt/capability-fabric/current
CONTROL=/var/lib/capability-fabric/onshape/runtime-control/ONSHAPE_RUNTIME_CONTROL.json
STATE=/var/lib/capability-fabric/state
GATE="$STATE/release-in-progress"
LOCK=/run/lock/capability-fabric-pull.lock
TIMER=capability-fabric-pull.timer
GATEWAY=capability-fabric-onshape-gateway
SERVER=capability-fabric-onshape-server
expected_control=177ddde1070c6a75f7cf94a15db1a0c93fa45159

[[ "$(readlink -f "$ACTIVE")" == /var/lib/capability-fabric/releases/onshape-vps-hardened-production-r4 ]]
[[ "$(git hash-object "$CONTROL")" == "$expected_control" ]]
[[ -f "$GATE" ]]
grep -Fxq RELEASE_IN_PROGRESS "$GATE"
[[ "$(docker inspect -f '{{.State.Running}}' "$GATEWAY")" == false ]]
[[ "$(docker inspect -f '{{.State.Running}}' "$SERVER")" == true ]]
if systemctl is-active --quiet "$TIMER"; then exit 20; fi

exec 9>"$LOCK"
flock -w 30 9 || exit 21

restore_gate=yes
cleanup() {
  rc=$?
  set +e
  if [[ "$restore_gate" == yes && ! -e "$GATE" ]]; then
    tmp="$GATE.tmp.diag.$$"
    printf '%s\n' RELEASE_IN_PROGRESS >"$tmp"
    chmod 0600 "$tmp"
    chown root:root "$tmp"
    mv -f "$tmp" "$GATE"
  fi
  exit "$rc"
}
trap cleanup EXIT

rm -f "$GATE"
[[ ! -e "$GATE" ]]
echo CF_R4_POOL_DIAG_WINDOW=open

docker exec -i "$SERVER" sh -lc 'cd /tmp/app && node --input-type=module' <<'NODE'
import fs from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
const token=fs.readFileSync("/run/secrets/mcp-token","utf8").trim();
const client=new Client({name:"cf-r4-pool-diagnostic",version:"1.0.0"});
const transport=new StreamableHTTPClientTransport(new URL("http://127.0.0.1:8788/mcp/"+token));
await client.connect(transport);
const parse=(res)=>{
  const raw=(res?.content||[]).filter(x=>x.type==="text").map(x=>x.text||"").join("\n");
  if(!raw) throw new Error("empty tool response");
  return JSON.parse(raw);
};
const pool=parse(await client.callTool({name:"onshape_pool_status",arguments:{}}));
console.log("CF_R4_POOL_DIAG_BUILD_ID="+String(pool.build_id));
console.log("CF_R4_POOL_DIAG_ENABLED="+String(pool.pool_enabled));
console.log("CF_R4_POOL_DIAG_WARMING="+String(pool.warming));
console.log("CF_R4_POOL_DIAG_SIZE="+String(pool.size));
console.log("CF_R4_POOL_DIAG_ACTIVE_COUNT="+String(pool.active_count));
console.log("CF_R4_POOL_DIAG_QUEUED_COUNT="+String(pool.queued_count));
console.log("CF_R4_POOL_DIAG_DOCUMENT_LOCK_COUNT="+String(pool.document_lock_count));
console.log("CF_R4_POOL_DIAG_MUTATOR="+String(pool.material_mutator_session_id));
for(const s of pool.sessions||[]){
  console.log("CF_R4_POOL_DIAG_SESSION="+[
    s.session_id,
    s.role,
    "busy="+String(s.busy),
    "auth="+String(s?.auth?.state),
    "browser="+String(s.browser_started),
    "credential="+String(s.credential_state),
    "ops="+String(s.operations),
    "failures="+String(s.failures),
    "url="+String(s.current_url_kind),
  ].join("|"));
}
await client.close();
NODE

tmp="$GATE.tmp.diag.$$"
printf '%s\n' RELEASE_IN_PROGRESS >"$tmp"
chmod 0600 "$tmp"
chown root:root "$tmp"
mv -f "$tmp" "$GATE"
restore_gate=no
grep -Fxq RELEASE_IN_PROGRESS "$GATE"
echo CF_R4_POOL_DIAG_WINDOW=closed
echo CF_R4_POOL_DIAG=pass
