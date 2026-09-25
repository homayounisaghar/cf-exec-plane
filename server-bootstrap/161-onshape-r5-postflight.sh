#!/usr/bin/env bash
set -euo pipefail
umask 077
[[ "$(id -u)" -eq 0 ]] || exit 2

ACTIVE=/opt/capability-fabric/current
PREVIOUS=/opt/capability-fabric/previous
STATE=/var/lib/capability-fabric/state
CONTROL=/var/lib/capability-fabric/onshape/runtime-control/ONSHAPE_RUNTIME_CONTROL.json
GATE="$STATE/release-in-progress"
TIMER=capability-fabric-pull.timer
GATEWAY=capability-fabric-onshape-gateway
SERVER=capability-fabric-onshape-server

EXPECTED_MANIFEST=01f31143e3574c02d430a6b4f67a9be3ef24590a39f4e27459131da4beece057
EXPECTED_SOURCE=a05f6299a8e7c4ec0d801ae0de58684f8757cab2
EXPECTED_CONTROL=6ac33244f7968c142e30b2f815d090f74dac49f3

active="$(readlink -f "$ACTIVE")"
previous="$(readlink -f "$PREVIOUS")"
[[ "$(basename "$active")" == "onshape-vps-hardened-production-r5" ]] || exit 20
[[ "$(basename "$previous")" == "capability-fabric-isolated-telegram-ingress-r69" ]] || exit 20
[[ "$(cat "$STATE/last-good-sequence")" == "70" ]] || exit 20
[[ "$(cat "$STATE/last-good-release")" == "onshape-vps-hardened-production-r5" ]] || exit 20
[[ ! -s "$STATE/last-failed-commit" ]] || exit 20
[[ "$(sha256sum "$active/manifest.json" | awk '{print $1}')" == "$EXPECTED_MANIFEST" ]] || exit 20
[[ "$(tr -d '\r\n' < "$active/source-commit")" == "$EXPECTED_SOURCE" ]] || exit 20
[[ "$(git hash-object "$CONTROL")" == "$EXPECTED_CONTROL" ]] || exit 20
[[ ! -e "$GATE" ]] || exit 20
systemctl is-active --quiet "$TIMER"
[[ "$(docker inspect -f '{{.State.Running}}' "$GATEWAY")" == true ]]
[[ "$(docker inspect -f '{{.State.Running}}' "$SERVER")" == true ]]
[[ "$(curl -fsS --max-time 3 http://127.0.0.1:8787/)" == "cf-onshape-single ok" ]]

python3 - "$CONTROL" <<'PY'
import json,sys
x=json.load(open(sys.argv[1])); a=x["authority"]; g=a["productionGuard"]
assert x["controlRevision"]==540
assert a["productionEpoch"]==11 and a["mode"]=="VPS_PRODUCTION" and a["materialAuthority"]=="vps-fabric"
assert a["reconciliationHold"]["active"] is False
assert x["lease"]["state"]=="FREE"
assert g["killSwitch"]=="ENGAGED" and g["allowedDocumentIds"]==[] and g["mutationBudget"]["maxMutations"]==0
print("CF_R5_POST_AUTHORITY=epoch11-vps-production")
print("CF_R5_POST_GUARD=engaged-empty-zero")
print("CF_R5_POST_LEASE=FREE")
PY

docker exec -i "$SERVER" sh -lc 'cd /tmp/app && node --input-type=module' <<'NODE'
import fs from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
const token=fs.readFileSync("/run/secrets/mcp-token","utf8").trim();
const client=new Client({name:"cf-r5-postflight",version:"1.0.0"});
const transport=new StreamableHTTPClientTransport(new URL("http://127.0.0.1:8788/mcp/"+token));
await client.connect(transport);
const parse=(res)=>{
  const raw=(res?.content||[]).filter(x=>x.type==="text").map(x=>x.text||"").join("\n");
  if(!raw) throw new Error("empty tool response");
  return JSON.parse(raw);
};
const caps=parse(await client.callTool({name:"onshape_fabric_capabilities",arguments:{}}));
const pool=parse(await client.callTool({name:"onshape_pool_status",arguments:{}}));
if(caps?.build_id!=="onshape-vps-hardened-r5"||caps?.public_surface!=="semantic-only") throw new Error("wrong live surface");
if(pool?.pool_enabled!==true||pool?.warming!==false||pool?.size!==3) throw new Error("pool disabled");
if(pool?.active_count!==0||pool?.queued_count!==0||pool?.document_lock_count!==0) throw new Error("pool busy");
if(pool?.material_mutator_session_id!=="session-1"||pool?.session_fingerprints_distinct!==true) throw new Error("pool identity");
for(const s of pool?.sessions||[]) if(s?.auth?.state!=="PROVEN") throw new Error("auth "+String(s?.session_id));
console.log("CF_R5_POST_BUILD=onshape-vps-hardened-r5");
console.log("CF_R5_POST_SURFACE=semantic-only");
console.log("CF_R5_POST_POOL=3-of-3-PROVEN-idle");
await client.close();
NODE

echo CF_R5_POST_ACTIVE_RELEASE=seq70-r5
echo CF_R5_POST_PREVIOUS_RELEASE=seq69
echo CF_R5_POST_LAST_GOOD_SEQUENCE=70
echo CF_R5_POST_LAST_FAILED=none
echo CF_R5_POST_MANIFEST_SHA256=$EXPECTED_MANIFEST
echo CF_R5_POST_RELEASE_GATE=clear
echo CF_R5_POST_PULL_TIMER=active
echo CF_R5_POST_GATEWAY=running
echo CF_R5_POST_MCP_ROOT=pass
echo CF_R5_POST=pass
