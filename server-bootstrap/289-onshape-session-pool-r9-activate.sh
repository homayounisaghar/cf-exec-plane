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
EXPECTED_MANIFEST=5abb7ec2ba3525f3f1e3cf535323106436b42d264150fb20c911b221ef3af7a3

[[ "$(basename "$(readlink -f "$ACTIVE")")" == "onshape-vps-hardened-production-r8" ]]
[[ "$(cat "$STATE/last-good-sequence")" == "73" ]]
[[ "$(cat "$STATE/last-good-release")" == "onshape-vps-hardened-production-r8" ]]
[[ ! -s "$STATE/last-failed-commit" ]]
[[ "$(git hash-object "$CONTROL")" == "$EXPECTED_CONTROL" ]]
[[ -f "$GATE" ]] && grep -Fxq RELEASE_IN_PROGRESS "$GATE"
! systemctl is-active --quiet "$TIMER"
! systemctl is-active --quiet "$SERVICE"
[[ "$(docker inspect -f '{{.State.Running}}' "$GATEWAY")" == false ]]

python3 - "$CONTROL" <<'PY'
import json,sys
d=json.load(open(sys.argv[1])); a=d["authority"]; v=a["planes"]["vps-fabric"]; g=a["productionGuard"]
assert d["controlRevision"]==557 and a["productionEpoch"]==28
assert a["mode"]=="QUIESCED_RECONCILING" and a["materialAuthority"] is None
assert v["ingress"]=="CLOSED" and v["materialEffectsAllowed"] is False
assert v["releaseSequence"]==74 and v["releaseId"]=="onshape-vps-hardened-r9"
assert v["manifestSha256"]=="5abb7ec2ba3525f3f1e3cf535323106436b42d264150fb20c911b221ef3af7a3"
assert a["reconciliationHold"]["active"] is False
assert d["lease"]["state"]=="FREE"
assert g["killSwitch"]=="ENGAGED" and g["allowedDocumentIds"]==[] and g["mutationBudget"]["maxMutations"]==0
print("CF_POOL_R9_ACTIVATE_AUTHORITY=quiesced")
PY

out="$("$PULL" pull)"
printf '%s
' "$out"
printf '%s
' "$out" | grep -Fxq 'CF_PULL_APPLY=success'

active="$(readlink -f "$ACTIVE")"
previous="$(readlink -f "$PREVIOUS")"
[[ "$(basename "$active")" == "onshape-vps-hardened-production-r9" ]]
[[ "$(basename "$previous")" == "onshape-vps-hardened-production-r8" ]]
[[ "$(cat "$STATE/last-good-sequence")" == "74" ]]
[[ "$(cat "$STATE/last-good-release")" == "onshape-vps-hardened-production-r9" ]]
[[ ! -s "$STATE/last-failed-commit" ]]
[[ "$(sha256sum "$active/manifest.json" | awk '{print $1}')" == "$EXPECTED_MANIFEST" ]]
[[ "$(git hash-object "$CONTROL")" == "$EXPECTED_CONTROL" ]]

# The pull-agent health path may reopen ordinary services. Re-establish the quiesced boundary.
systemctl stop "$TIMER" >/dev/null 2>&1 || true
for _ in $(seq 1 30); do systemctl is-active --quiet "$SERVICE" || break; sleep 1; done
! systemctl is-active --quiet "$SERVICE"
docker stop "$GATEWAY" >/dev/null 2>&1 || true
tmp="$GATE.tmp.r9.$$"; printf '%s
' RELEASE_IN_PROGRESS >"$tmp"; chmod 0600 "$tmp"; chown root:root "$tmp"; mv -f "$tmp" "$GATE"

[[ "$(docker inspect -f '{{.State.Running}}' "$SERVER")" == true ]]
[[ "$(docker inspect -f '{{.State.Health.Status}}' "$SERVER")" == healthy ]]
[[ "$(docker inspect -f '{{.State.Running}}' "$GATEWAY")" == false ]]
! systemctl is-active --quiet "$TIMER"

docker exec -i "$SERVER" sh -lc 'cd /tmp/app && node --input-type=module' <<'NODE'
import fs from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
const token=fs.readFileSync("/run/secrets/mcp-token","utf8").trim();
const c=new Client({name:"cf-r9-activate-proof",version:"1.0"});
await c.connect(new StreamableHTTPClientTransport(new URL("http://127.0.0.1:8788/mcp/"+token)));
const parse=r=>JSON.parse((r.content||[]).filter(x=>x.type==="text").map(x=>x.text||"").join("\n"));
try{
  const p=parse(await c.callTool({name:"onshape_pool_status",arguments:{}},undefined,{timeout:180000}));
  if(p.build_id!=="onshape-vps-hardened-r9") throw new Error("wrong build");
  if(p.pool_enabled!==true||p.size!==5) throw new Error("five-slot pool not enabled");
  if(p.session_fingerprints_distinct!==true) throw new Error("fingerprints not distinct");
  if(p.active_count!==0||p.queued_count!==0||p.document_lock_count!==0) throw new Error("pool not idle");
  if((p.sessions||[]).length!==5||p.sessions.some(x=>x?.auth?.state!=="PROVEN"||x?.auth?.http_status!==200)) throw new Error("cohort not 5/5 PROVEN");
  const accounts=new Set(p.sessions.map(x=>x?.auth?.account_id).filter(Boolean));
  if(accounts.size!==1) throw new Error("account mismatch");
  console.log("CF_POOL_R9_ACTIVATE_POOL=5of5-PROVEN-idle");
  console.log("CF_POOL_R9_ACTIVATE_NAV_LIMIT="+String(p.navigation_limit));
} finally { await c.close().catch(()=>{}); }
NODE

echo CF_POOL_R9_ACTIVATE_ACTIVE=seq74-r9
echo CF_POOL_R9_ACTIVATE_PREVIOUS=seq73-r8
echo CF_POOL_R9_ACTIVATE_GATE=active
echo CF_POOL_R9_ACTIVATE_GATEWAY=stopped
echo CF_POOL_R9_ACTIVATE=pass
