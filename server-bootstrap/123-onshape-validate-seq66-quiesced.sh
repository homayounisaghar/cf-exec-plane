#!/usr/bin/env bash
set -euo pipefail
umask 077
[[ "$(id -u)" -eq 0 ]] || exit 2

active=/opt/capability-fabric/current
previous=/opt/capability-fabric/previous
control=/var/lib/capability-fabric/onshape/runtime-control/ONSHAPE_RUNTIME_CONTROL.json
state=/var/lib/capability-fabric/state
gate="$state/release-in-progress"
expected_sha=857b7ca6d5a6bcf79b820594801a4f88642fe9520dad1ae18fc064eae6073d7c

a="$(readlink -f "$active")"
p="$(readlink -f "$previous")"
python3 - "$a/manifest.json" "$p/manifest.json" "$control" <<'PY'
import json,sys
a=json.load(open(sys.argv[1])); p=json.load(open(sys.argv[2])); r=json.load(open(sys.argv[3]))
assert a["sequence"]==66 and a["release_id"]=="onshape-vps-hardened-production-r3",a
assert p["sequence"]==63 and p["release_id"]=="onshape-vps-hardened-rollback-r1",p
x=r["authority"]
assert r["controlRevision"]==530 and x["productionEpoch"]==2
assert x["mode"]=="QUIESCED_RECONCILING" and x["materialAuthority"] is None
assert x["planes"]["android-v1"]["ingress"]=="CLOSED" and x["planes"]["android-v1"]["materialEffectsAllowed"] is False
assert x["planes"]["vps-fabric"]["ingress"]=="CLOSED" and x["planes"]["vps-fabric"]["materialEffectsAllowed"] is False
assert r["routing"]["state"]=="CLOSED" and r["routing"]["materialCommandsAllowed"] is False
print("CF_AV_ACTIVE_RELEASE=seq66")
print("CF_AV_PREVIOUS_RELEASE=seq63")
print("CF_AV_AUTHORITY=quiesced-epoch2")
print("CF_AV_BOTH_MATERIAL_PLANES=CLOSED")
PY
[[ "$(sha256sum "$a/manifest.json" | awk '{print $1}')" == "$expected_sha" ]]
[[ ! -e "$gate" ]]
[[ "$(cat "$state/last-good-sequence")" == 66 ]]
[[ "$(cat "$state/last-good-release")" == onshape-vps-hardened-production-r3 ]]
systemctl is-active --quiet capability-fabric-pull.timer
echo CF_AV_RELEASE_GATE=clear
echo CF_AV_PULL_TIMER=active
echo CF_AV_LAST_GOOD=seq66

for c in capability-fabric-onshape-server capability-fabric-onshape-fabric capability-fabric-onshape-gateway; do
  [[ "$(docker inspect -f '{{.State.Running}}' "$c")" == true ]]
done
echo CF_AV_CONTAINERS=running

# Exact runtime config and build identity.
backend_env="$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' capability-fabric-onshape-server)"
fabric_env="$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' capability-fabric-onshape-fabric)"
printf '%s\n' "$backend_env" | grep -Fxq 'CF_PUBLIC_SURFACE=semantic-only'
printf '%s\n' "$backend_env" | grep -Fxq 'CF_FABRIC_REQUIRE_PRODUCTION_AUTHORITY=1'
printf '%s\n' "$backend_env" | grep -Fxq 'CF_PRIVILEGED_NATIVE_ENABLED=0'
printf '%s\n' "$fabric_env" | grep -Fxq 'CF_FABRIC_REQUIRE_PRODUCTION_AUTHORITY=1'
printf '%s\n' "$fabric_env" | grep -Fxq 'CF_FABRIC_QUALIFICATION_MODE=0'
grep -Fq 'const BUILD_ID = "onshape-vps-hardened-r3";' "$a/server.js"
echo CF_AV_PRODUCTION_CONFIG=pass
echo CF_AV_BUILD_ID=onshape-vps-hardened-r3

# Loopback-only backend/raw/sidecar boundaries.
ss -lnt | awk '
  $4=="127.0.0.1:8787"{a=1}
  $4=="127.0.0.1:8788"{b=1}
  $4=="127.0.0.1:8789"{c=1}
  $4=="127.0.0.1:8791"{d=1}
  END{exit a&&b&&c&&d?0:1}'
if ss -lnt | awk '$4 ~ /^(0\.0\.0\.0|\[::\]|\*):(8787|8788|8789|8791)$/ {f=1} END{exit f?0:1}'; then exit 30; fi
[[ "$(curl -sS -o /dev/null -w '%{http_code}' --max-time 3 http://127.0.0.1:8787/internal/fabric/not-public)" == 404 ]]
echo CF_AV_LOOPBACK_ONLY=pass
echo CF_AV_PUBLIC_INTERNAL_DENY=pass

# Semantic catalog/pool must be live, but material mutation must remain
# authority-denied while quiesced.
docker exec -i capability-fabric-onshape-server sh -lc 'cd /tmp/app && node --input-type=module' <<'NODE'
import fs from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
const token=fs.readFileSync("/run/secrets/mcp-token","utf8").trim();
const client=new Client({name:"cf-post-activation",version:"1.0.0"});
const transport=new StreamableHTTPClientTransport(new URL("http://127.0.0.1:8788/mcp/"+token));
await client.connect(transport);
const tools=(await client.listTools()).tools.map(x=>x.name).sort();
for(const required of ["onshape_pool_status","onshape_fabric_capabilities","onshape_fabric_invoke"]){
  if(!tools.includes(required)) throw new Error("missing "+required);
}
if(tools.includes("onshape_ui_input_sequence")||tools.includes("onshape_ui_native")) throw new Error("effectful UI exposed");
const capsRes=await client.callTool({name:"onshape_fabric_capabilities",arguments:{}});
const capsRaw=(capsRes.content||[]).filter(x=>x.type==="text").map(x=>x.text||"").join("\n");
const caps=JSON.parse(capsRaw);
const ids=(caps.capabilities||[]).map(x=>x.id);
if(ids.includes("onshape.ui.input.sequence")||ids.includes("onshape.ui.native")) throw new Error("effectful UI capability exposed");
const lookup=await client.callTool({name:"onshape_fabric_invoke",arguments:{capability_id:"onshape.openapi.lookup",arguments:{keyword:"getDocument"}}});
if(lookup.isError===true) throw new Error("semantic lookup failed");
const ps=await client.callTool({name:"onshape_pool_status",arguments:{}});
const raw=(ps.content||[]).filter(x=>x.type==="text").map(x=>x.text||"").join("\n");
const pool=JSON.parse(raw);
if(pool.pool_enabled!==true||pool.size!==3||pool.active_count!==0||pool.queued_count!==0) throw new Error(raw);
if(pool.material_mutator_session_id!=="session-1") throw new Error(raw);
for(const s of pool.sessions){if(s?.auth?.state!=="PROVEN") throw new Error(raw);}
console.log("CF_AV_TOOL_CATALOG=pass");
console.log("CF_AV_UI_EFFECTFUL_CLOSED=pass");
console.log("CF_AV_SEMANTIC_READ=pass");
console.log("CF_AV_POOL_AUTH=3-of-3-PROVEN");
console.log("CF_AV_POOL_IDLE=pass");
await client.close();
NODE

echo CF_AV=pass
