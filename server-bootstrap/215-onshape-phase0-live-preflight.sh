#!/usr/bin/env bash
set -euo pipefail
umask 077
[[ "$(id -u)" -eq 0 ]] || { echo CF_PHASE0_PREFLIGHT_REQUIRES_ROOT >&2; exit 2; }

expected_control_blob="7c03d59b613a7c91249f4c56efd045e1ed13a8dc"
fixture="a19e0fa5152af9f7ce106b6e:e5e7d0173fd1f1d0307a2cb6:e0929361aadb6135b5cecffa"
control=/var/lib/capability-fabric/onshape/runtime-control/ONSHAPE_RUNTIME_CONTROL.json
active=/opt/capability-fabric/current
gate=/var/lib/capability-fabric/state/release-in-progress
lock=/run/lock/capability-fabric-pull.lock

[[ -s "$control" ]] || { echo CF_PHASE0_PREFLIGHT_CONTROL=missing; exit 20; }
actual_control_blob="$(git hash-object "$control")"
echo CF_PHASE0_PREFLIGHT_CONTROL_BLOB="$actual_control_blob"
[[ "$actual_control_blob" == "$expected_control_blob" ]] || { echo CF_PHASE0_PREFLIGHT_CONTROL=freshness-mismatch; exit 21; }

python3 - "$control" <<'PY'
import json,sys
r=json.load(open(sys.argv[1]))
a=r["authority"]
assert r["controlRevision"]==555
assert r["lease"]["state"]=="FREE"
assert r["routing"]["state"]=="CLOSED"
assert r["routing"]["materialCommandsAllowed"] is False
assert a["productionEpoch"]==26
assert a["mode"]=="VPS_PRODUCTION"
assert a["materialAuthority"]=="vps-fabric"
assert a["planes"]["android-v1"]["ingress"]=="CLOSED"
assert a["planes"]["android-v1"]["materialEffectsAllowed"] is False
v=a["planes"]["vps-fabric"]
assert v["ingress"]=="ADMITTED" and v["materialEffectsAllowed"] is True
assert v["releaseSequence"]==73
assert v["releaseId"]=="onshape-vps-hardened-production-r8"
assert v["manifestSha256"]=="08873ac1a6830ed42f15ebe340604ed6ffea33b8e7cb12b3a192982f3dcd6e9c"
assert a["reconciliationHold"]["active"] is False
print("CF_PHASE0_PREFLIGHT_AUTHORITY=pass")
print("CF_PHASE0_PREFLIGHT_LEASE=FREE")
PY

release="$(readlink -f "$active")"
[[ "$release" == /var/lib/capability-fabric/releases/* ]] || { echo CF_PHASE0_PREFLIGHT_ACTIVE_RELEASE=invalid; exit 22; }
[[ -s "$release/manifest.json" ]] || { echo CF_PHASE0_PREFLIGHT_MANIFEST=missing; exit 23; }
python3 - "$release/manifest.json" "$control" <<'PY'
import hashlib,json,sys
mraw=open(sys.argv[1],"rb").read()
m=json.loads(mraw)
r=json.load(open(sys.argv[2]))
v=r["authority"]["planes"]["vps-fabric"]
assert m["sequence"]==v["releaseSequence"]==73
assert m["release_id"]==v["releaseId"]=="onshape-vps-hardened-production-r8"
digest=hashlib.sha256(mraw).hexdigest()
assert digest==v["manifestSha256"]
print("CF_PHASE0_PREFLIGHT_RELEASE=pass")
print("CF_PHASE0_PREFLIGHT_RELEASE_MANIFEST_SHA256="+digest)
PY

for c in capability-fabric-onshape-server capability-fabric-onshape-fabric; do
  [[ "$(docker inspect -f '{{.State.Running}}' "$c" 2>/dev/null || echo false)" == true ]] || { echo "CF_PHASE0_PREFLIGHT_CONTAINER_$c=not-running"; exit 24; }
  echo "CF_PHASE0_PREFLIGHT_CONTAINER_$c=running"
done
gateway=capability-fabric-onshape-gateway
gateway_running="$(docker inspect -f '{{.State.Running}}' "$gateway" 2>/dev/null || echo false)"
[[ "$gateway_running" == false ]] || { echo CF_PHASE0_PREFLIGHT_GATEWAY=unexpectedly-running; exit 24; }
echo CF_PHASE0_PREFLIGHT_GATEWAY=closed-as-authorized

server=capability-fabric-onshape-server
env_dump="$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$server")"
grep -Fxq 'CF_PUBLIC_SURFACE=semantic-only' <<<"$env_dump"
grep -Fxq 'CF_FABRIC_REQUIRE_PRODUCTION_AUTHORITY=1' <<<"$env_dump"
grep -Fxq 'CF_PRIVILEGED_NATIVE_ENABLED=0' <<<"$env_dump"
echo CF_PHASE0_PREFLIGHT_PRODUCTION_ENV=pass

for p in 8788 8789 8791; do
  ss -lnt | awk -v x="127.0.0.1:$p" '$4==x{f=1} END{exit f?0:1}' || { echo "CF_PHASE0_PREFLIGHT_PROD_PORT_$p=missing"; exit 25; }
done
if ss -lnt | awk '$4=="127.0.0.1:8787"{f=1} END{exit f?0:1}'; then
  echo CF_PHASE0_PREFLIGHT_GATEWAY_PORT=unexpectedly-present
  exit 25
fi
echo CF_PHASE0_PREFLIGHT_PRODUCTION_PORTS=pass-routing-closed

for p in 8898 8899 8901; do
  if ss -lnt | awk -v x="127.0.0.1:$p" '$4==x{f=1} END{exit f?0:1}'; then
    echo "CF_PHASE0_PREFLIGHT_RESEARCH_PORT_$p=busy"
    exit 26
  fi
  if ss -lnt | awk -v x="$p" '$4=="0.0.0.0:"x || $4=="[::]:"x || $4=="*:"x {f=1} END{exit f?0:1}'; then
    echo "CF_PHASE0_PREFLIGHT_RESEARCH_PORT_$p=wildcard-busy"
    exit 26
  fi
  echo "CF_PHASE0_PREFLIGHT_RESEARCH_PORT_$p=free"
done

[[ -s /etc/capability-fabric/secrets/repo-read-token ]] || { echo CF_PHASE0_PREFLIGHT_REPO_READ_TOKEN=missing; exit 27; }
[[ -s /etc/capability-fabric/secrets/onshape/account && -s /etc/capability-fabric/secrets/onshape/password ]] || { echo CF_PHASE0_PREFLIGHT_ONSHAPE_CREDENTIALS=missing; exit 27; }
[[ -s /etc/capability-fabric/secrets/mcp-token ]] || { echo CF_PHASE0_PREFLIGHT_PROD_MCP_TOKEN=missing; exit 27; }
echo CF_PHASE0_PREFLIGHT_SECRETS=present

[[ -f "$gate" ]] && grep -Fxq RELEASE_IN_PROGRESS "$gate" || { echo CF_PHASE0_PREFLIGHT_RELEASE_GATE=unexpected; exit 29; }
echo CF_PHASE0_PREFLIGHT_RELEASE_GATE=closed-as-authorized
exec 9>"$lock"
flock -w 10 9 || { echo CF_PHASE0_PREFLIGHT_SHARED_LOCK=busy; exit 30; }
echo CF_PHASE0_PREFLIGHT_SHARED_LOCK=free

docker exec -i "$server" sh -lc 'cd /tmp/app && node --input-type=module' <<'NODE'
import fs from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const token=fs.readFileSync("/run/secrets/mcp-token","utf8").trim();
const client=new Client({name:"cf-phase0-live-preflight",version:"1.0.0"});
const transport=new StreamableHTTPClientTransport(new URL("http://127.0.0.1:8788/mcp/"+token));
const assert=(v,m)=>{if(!v) throw new Error(m)};
const parse=(res)=>{
  const raw=(res?.content||[]).filter(x=>x.type==="text").map(x=>x.text||"").join("\n");
  assert(raw,"empty MCP result");
  return JSON.parse(raw);
};
await client.connect(transport);
try {
  const tools=(await client.listTools()).tools.map(x=>x.name).sort();
  for(const required of ["onshape_fabric_capabilities","onshape_fabric_invoke","onshape_pool_status"]) assert(tools.includes(required),"missing "+required);
  for(const forbidden of ["onshape_ui_native","onshape_ui_input","onshape_request","onshape_artifact","onshape_openapi","onshape_documents_create"]) assert(!tools.includes(forbidden),"forbidden production tool "+forbidden);
  console.log("CF_PHASE0_PREFLIGHT_PROD_TOOL_CATALOG=pass");

  const caps=parse(await client.callTool({name:"onshape_fabric_capabilities",arguments:{}}));
  assert(caps.status==="FAILED" && caps?.error?.code==="RELEASE_IN_PROGRESS","closed production capability gate not enforced");
  console.log("CF_PHASE0_PREFLIGHT_PROD_CAPABILITY_GATE=closed-as-authorized");

  const pool=parse(await client.callTool({name:"onshape_pool_status",arguments:{}}));
  assert(pool.status==="FAILED" && pool?.error?.code==="RELEASE_IN_PROGRESS","closed production pool gate not enforced");
  console.log("CF_PHASE0_PREFLIGHT_PROD_POOL_GATE=closed-as-authorized");
} finally {
  await client.close().catch(()=>{});
}
NODE

for c in capability-fabric-onshape-phase0-research capability-fabric-onshape-phase0-fabric; do
  if docker inspect "$c" >/dev/null 2>&1; then
    state="$(docker inspect -f '{{.State.Running}}' "$c")"
    echo "CF_PHASE0_PREFLIGHT_EXISTING_$c=$state"
    [[ "$state" == false ]] || exit 28
  else
    echo "CF_PHASE0_PREFLIGHT_EXISTING_$c=absent"
  fi
done

echo CF_PHASE0_PREFLIGHT_FIXTURE="$fixture"
echo CF_PHASE0_PREFLIGHT_DEPLOYMENT=none
echo CF_PHASE0_PREFLIGHT_ONSHAPE_INTERACTION=none
echo CF_PHASE0_LIVE_PREFLIGHT=pass
