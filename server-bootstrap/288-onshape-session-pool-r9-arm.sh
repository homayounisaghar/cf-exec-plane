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
SERVICE=capability-fabric-pull.service
PULL=/usr/local/libexec/capability-fabric-pull-agent
GATEWAY=capability-fabric-onshape-gateway
SERVER=capability-fabric-onshape-server
EXPECTED_CONTROL=798d9bf888e788d35ee1094136e8dc2ed587a534

[[ "$(basename "$(readlink -f "$ACTIVE")")" == "onshape-vps-hardened-production-r8" ]]
[[ "$(cat "$STATE/last-good-sequence")" == "73" ]]
[[ "$(cat "$STATE/last-good-release")" == "onshape-vps-hardened-production-r8" ]]
[[ ! -s "$STATE/last-failed-commit" ]]

# Stop automatic release movement, then explicitly mirror current canonical control.
systemctl stop "$TIMER"
for _ in $(seq 1 30); do
  systemctl is-active --quiet "$SERVICE" || break
  sleep 1
done
systemctl is-active --quiet "$SERVICE" && exit 20

out="$("$PULL" pull 2>&1 || true)"
printf '%s
' "$out"
printf '%s
' "$out" | grep -Eq 'CF_PULL_NO_CHANGE|CF_PULL_APPLY=success'
[[ "$(basename "$(readlink -f "$ACTIVE")")" == "onshape-vps-hardened-production-r8" ]]
[[ "$(git hash-object "$CONTROL")" == "$EXPECTED_CONTROL" ]]

python3 - "$CONTROL" <<'PY'
import json,sys
d=json.load(open(sys.argv[1])); a=d["authority"]; g=a["productionGuard"]
assert d["controlRevision"]==557
assert d["lease"]["state"]=="FREE"
assert a["productionEpoch"]==28
assert a["mode"]=="QUIESCED_RECONCILING"
assert a["materialAuthority"] is None
assert a["reconciliationHold"]["active"] is False
assert a["planes"]["android-v1"]["ingress"]=="CLOSED"
assert a["planes"]["android-v1"]["materialEffectsAllowed"] is False
v=a["planes"]["vps-fabric"]
assert v["ingress"]=="CLOSED" and v["materialEffectsAllowed"] is False
assert v["releaseSequence"]==74
assert v["releaseId"]=="onshape-vps-hardened-r9"
assert v["manifestSha256"]=="5abb7ec2ba3525f3f1e3cf535323106436b42d264150fb20c911b221ef3af7a3"
assert g["killSwitch"]=="ENGAGED" and g["allowedDocumentIds"]==[]
assert g["mutationBudget"]["maxMutations"]==0
print("CF_POOL_R9_ARM_AUTHORITY=epoch28-quiesced")
PY

# Existing production cohort must still be healthy and idle before closing ingress.
docker exec -i "$SERVER" sh -lc 'cd /tmp/app && node --input-type=module' <<'NODE'
import fs from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
const token=fs.readFileSync("/run/secrets/mcp-token","utf8").trim();
const c=new Client({name:"cf-r9-arm",version:"1.0"});
await c.connect(new StreamableHTTPClientTransport(new URL("http://127.0.0.1:8788/mcp/"+token)));
const parse=r=>JSON.parse((r.content||[]).filter(x=>x.type==="text").map(x=>x.text||"").join("\n"));
const p=parse(await c.callTool({name:"onshape_pool_status",arguments:{}},undefined,{timeout:180000}));
if(p.pool_enabled!==true||p.size!==3||p.active_count!==0||p.queued_count!==0||p.document_lock_count!==0) throw new Error("pool not idle/ready");
if(p.session_fingerprints_distinct!==true||(p.sessions||[]).length!==3||p.sessions.some(x=>x?.auth?.state!=="PROVEN"||x?.auth?.http_status!==200)) throw new Error("pool not 3/3 PROVEN");
console.log("CF_POOL_R9_ARM_POOL=3of3-PROVEN-idle");
await c.close().catch(()=>{});
NODE

tmp="$GATE.tmp.r9-arm.$$"; printf '%s
' RELEASE_IN_PROGRESS >"$tmp"; chmod 0600 "$tmp"; chown root:root "$tmp"; mv -f "$tmp" "$GATE"
docker stop "$GATEWAY" >/dev/null
[[ -f "$GATE" ]] && grep -Fxq RELEASE_IN_PROGRESS "$GATE"
systemctl is-active --quiet "$TIMER" && exit 21
systemctl is-active --quiet "$SERVICE" && exit 21
[[ "$(docker inspect -f '{{.State.Running}}' "$GATEWAY")" == false ]]
[[ "$(docker inspect -f '{{.State.Running}}' "$SERVER")" == true ]]

echo CF_POOL_R9_ARM_GATE=active
echo CF_POOL_R9_ARM_TIMER=stopped
echo CF_POOL_R9_ARM_GATEWAY=stopped
echo CF_POOL_R9_ARM=pass
