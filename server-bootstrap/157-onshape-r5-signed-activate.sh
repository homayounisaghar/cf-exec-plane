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
DB=/var/lib/capability-fabric/onshape/fabric-state/execution.sqlite3
QUARANTINE=/var/lib/capability-fabric/onshape/fabric-state/quarantine/D-018-attempt-f6d80f46.json
ROLLBACK_GUARD=/usr/local/libexec/capability-fabric-onshape-rollback-contract
EXPECTED_CONTROL=6ac33244f7968c142e30b2f815d090f74dac49f3
EXPECTED_MANIFEST=01f31143e3574c02d430a6b4f67a9be3ef24590a39f4e27459131da4beece057
EXPECTED_RELEASE=onshape-vps-hardened-production-r5
EXPECTED_SEQUENCE=70
TEST_DID=881affea8ea63c33ae4e6c78

[[ -x "$PULL" && -x "$ROLLBACK_GUARD" && -s "$CONTROL" && -s "$DB" && -s "$QUARANTINE" ]] || exit 20
[[ -f "$GATE" ]] || { echo CF_R5_ACT_GATE=missing >&2; exit 21; }
grep -Fxq RELEASE_IN_PROGRESS "$GATE" || { echo CF_R5_ACT_GATE=unexpected >&2; exit 21; }
if systemctl is-active --quiet "$TIMER"; then echo CF_R5_ACT_TIMER=unexpected-active >&2; exit 21; fi
if systemctl is-active --quiet "$SERVICE"; then echo CF_R5_ACT_PULL_SERVICE=busy >&2; exit 21; fi
[[ "$(docker inspect -f '{{.State.Running}}' "$GATEWAY")" == false ]] || { echo CF_R5_ACT_GATEWAY=unexpected-running >&2; exit 21; }
[[ "$(basename "$(readlink -f "$ACTIVE")")" == "capability-fabric-isolated-telegram-ingress-r69" ]] || { echo CF_R5_ACT_ACTIVE_PRE=mismatch >&2; exit 21; }
[[ "$(cat "$STATE/last-good-sequence")" == "69" ]] || exit 21
[[ "$(cat "$STATE/last-good-release")" == "capability-fabric-isolated-telegram-ingress-r69" ]] || exit 21
[[ "$(git hash-object "$CONTROL")" == "$EXPECTED_CONTROL" ]] || { echo CF_R5_ACT_CONTROL_BLOB=mismatch >&2; exit 21; }

python3 - "$CONTROL" <<'PY'
import json,sys
x=json.load(open(sys.argv[1])); a=x["authority"]; g=a["productionGuard"]; v=a["planes"]["vps-fabric"]
assert x["controlRevision"]==540 and a["productionEpoch"]==11
assert a["mode"]=="VPS_PRODUCTION" and a["materialAuthority"]=="vps-fabric"
assert v["releaseSequence"]==67 and v["releaseId"]=="onshape-vps-hardened-production-r4"
assert a["reconciliationHold"]["active"] is False
assert x["lease"]["state"]=="FREE"
assert g["killSwitch"]=="ENGAGED" and g["allowedDocumentIds"]==[] and g["mutationBudget"]["maxMutations"]==0
print("CF_R5_ACT_AUTHORITY_PRE=pass")
PY

ponr="$("$ROLLBACK_GUARD" decide --db "$DB" --control "$CONTROL" --quarantine "$QUARANTINE")"
printf '%s\n' "$ponr" | grep -Fxq 'CF_A4_PONR=true'
printf '%s\n' "$ponr" | grep -Fxq 'CF_A4_PONR_COUNT=4'
printf '%s\n' "$ponr" | grep -Fxq 'CF_A4_UNRESOLVED_BLOCKING=0'
echo CF_R5_ACT_SAFETY_PRE=pass

finished=no
cleanup(){
  rc=$?
  set +e
  if [[ "$finished" != yes ]]; then
    systemctl stop "$TIMER" >/dev/null 2>&1 || true
    docker stop "$GATEWAY" >/dev/null 2>&1 || true
    if [[ ! -f "$GATE" ]]; then
      tmp="$GATE.tmp.$$"
      printf '%s\n' RELEASE_IN_PROGRESS >"$tmp"
      chmod 0600 "$tmp"
      chown root:root "$tmp"
      mv -f "$tmp" "$GATE"
    fi
    echo CF_R5_ACT_FAIL_CLOSED=retained
  fi
  exit "$rc"
}
trap cleanup EXIT

pull_out="$("$PULL" pull)"
printf '%s\n' "$pull_out"
printf '%s\n' "$pull_out" | grep -Fxq 'CF_PULL_APPLY=success'

active="$(readlink -f "$ACTIVE")"
previous="$(readlink -f "$PREVIOUS")"
[[ "$(basename "$active")" == "$EXPECTED_RELEASE" ]] || { echo CF_R5_ACT_ACTIVE_POST=mismatch >&2; exit 30; }
[[ "$(basename "$previous")" == "capability-fabric-isolated-telegram-ingress-r69" ]] || { echo CF_R5_ACT_PREVIOUS_POST=mismatch >&2; exit 30; }
[[ "$(cat "$STATE/last-good-sequence")" == "$EXPECTED_SEQUENCE" ]] || exit 30
[[ "$(cat "$STATE/last-good-release")" == "$EXPECTED_RELEASE" ]] || exit 30
[[ ! -s "$STATE/last-failed-commit" ]] || { echo CF_R5_ACT_LAST_FAILED=present >&2; exit 30; }
[[ "$(sha256sum "$active/manifest.json" | awk '{print $1}')" == "$EXPECTED_MANIFEST" ]] || { echo CF_R5_ACT_MANIFEST_SHA=mismatch >&2; exit 30; }
[[ "$(git hash-object "$CONTROL")" == "$EXPECTED_CONTROL" ]] || { echo CF_R5_ACT_CONTROL_CHANGED >&2; exit 30; }
[[ ! -e "$GATE" ]] || { echo CF_R5_ACT_PULL_GATE_NOT_CLEARED >&2; exit 30; }

source_commit="$(tr -d '\r\n' < "$active/source-commit")"
manifest_file_sha="$(tr -d '\r\n' < "$active/manifest.sha256")"
[[ "$source_commit" =~ ^[0-9a-f]{40}$ ]] || exit 30
[[ "$manifest_file_sha" == "$EXPECTED_MANIFEST" ]] || exit 30

docker stop "$GATEWAY" >/dev/null
[[ "$(docker inspect -f '{{.State.Running}}' "$GATEWAY")" == false ]]
[[ "$(docker inspect -f '{{.State.Running}}' "$SERVER")" == true ]]

node_out="$(docker exec -i "$SERVER" sh -lc 'cd /tmp/app && node --input-type=module' <<NODE
import fs from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
const DID="${TEST_DID}";
const token=fs.readFileSync("/run/secrets/mcp-token","utf8").trim();
const client=new Client({name:"cf-r5-v17-live-proof",version:"1.0.0"});
const transport=new StreamableHTTPClientTransport(new URL("http://127.0.0.1:8788/mcp/"+token));
await client.connect(transport);
const parse=(res)=>{
  const raw=(res?.content||[]).filter(x=>x.type==="text").map(x=>x.text||"").join("\n");
  if(!raw) return null;
  try{return JSON.parse(raw);}catch{return {raw};}
};
const tools=(await client.listTools()).tools.map(x=>x.name);
for(const n of ["onshape_pool_status","onshape_fabric_capabilities","onshape_fabric_invoke"]) if(!tools.includes(n)) throw new Error("missing "+n);
if(tools.includes("onshape_ui_input_sequence")||tools.includes("onshape_ui_native")) throw new Error("effectful UI exposed");
const caps=parse(await client.callTool({name:"onshape_fabric_capabilities",arguments:{}}));
if(caps?.build_id!=="onshape-vps-hardened-r5"||caps?.public_surface!=="semantic-only"||caps?.qualification_only!==false) throw new Error("wrong r5 surface");
const pool=parse(await client.callTool({name:"onshape_pool_status",arguments:{}}));
if(pool?.pool_enabled!==true||pool?.size!==3||pool?.active_count!==0||pool?.queued_count!==0||pool?.document_lock_count!==0) throw new Error("pool not idle");
if(pool?.material_mutator_session_id!=="session-1") throw new Error("wrong mutator");
for(const s of pool?.sessions||[]) if(s?.auth?.state!=="PROVEN") throw new Error("session not proven");

const read=parse(await client.callTool({name:"onshape_fabric_invoke",arguments:{
  capability_id:"onshape.documented.operation",
  arguments:{operationId:"getDocument",pathParams:{did:DID},query:{}}
}}));
const rr=read?.result, ev=rr?.observation?.evidence||{}, body=ev.body||{};
if(read?.build_id!=="onshape-vps-hardened-r5") throw new Error("wrong invocation build");
if(rr?.outcome?.state!=="ACHIEVED"||ev.httpStatus!==200||ev.effectSent!==false) throw new Error("semantic read failed");
if(body.id!==DID) throw new Error("wrong document id");
if(ev.apiVersion!=="v17"||ev.observedApiVersion!=="v17"||ev.apiVersionMatched!==true) {
  throw new Error("v17 evidence mismatch "+JSON.stringify({apiVersion:ev.apiVersion,observedApiVersion:ev.observedApiVersion,apiVersionMatched:ev.apiVersionMatched}));
}
console.log("CF_R5_LIVE_BUILD=onshape-vps-hardened-r5");
console.log("CF_R5_LIVE_READ=pass");
console.log("CF_R5_LIVE_READ_EFFECT_SENT=false");
console.log("CF_R5_LIVE_API_VERSION=v17");
console.log("CF_R5_LIVE_OBSERVED_API_VERSION=v17");
console.log("CF_R5_LIVE_API_VERSION_MATCHED=true");
console.log("CF_R5_LIVE_POOL=3-of-3-PROVEN-idle");
await client.close();
NODE
)"
printf '%s\n' "$node_out"
printf '%s\n' "$node_out" | grep -Fxq 'CF_R5_LIVE_READ=pass'
printf '%s\n' "$node_out" | grep -Fxq 'CF_R5_LIVE_API_VERSION_MATCHED=true'

[[ "$(git hash-object "$CONTROL")" == "$EXPECTED_CONTROL" ]]
python3 - "$CONTROL" <<'PY'
import json,sys
x=json.load(open(sys.argv[1])); a=x["authority"]; g=a["productionGuard"]
assert x["lease"]["state"]=="FREE"
assert a["productionEpoch"]==11 and a["mode"]=="VPS_PRODUCTION"
assert g["killSwitch"]=="ENGAGED" and g["allowedDocumentIds"]==[] and g["mutationBudget"]["maxMutations"]==0
PY
ponr2="$("$ROLLBACK_GUARD" decide --db "$DB" --control "$CONTROL" --quarantine "$QUARANTINE")"
printf '%s\n' "$ponr2" | grep -Fxq 'CF_A4_PONR_COUNT=4'
printf '%s\n' "$ponr2" | grep -Fxq 'CF_A4_UNRESOLVED_BLOCKING=0'

systemctl start "$TIMER"
systemctl is-active --quiet "$TIMER"
docker start "$GATEWAY" >/dev/null
[[ "$(docker inspect -f '{{.State.Running}}' "$GATEWAY")" == true ]]
[[ ! -e "$GATE" ]]

finished=yes
trap - EXIT
echo "CF_R5_ACT_SOURCE_COMMIT=$source_commit"
echo "CF_R5_ACT_MANIFEST_SHA256=$EXPECTED_MANIFEST"
echo CF_R5_ACT_ACTIVE_RELEASE=seq70-r5
echo CF_R5_ACT_PREVIOUS_RELEASE=seq69
echo CF_R5_ACT_GUARD=engaged-empty-zero
echo CF_R5_ACT_PULL_TIMER=active
echo CF_R5_ACT_GATEWAY=running
echo CF_R5_ACT=pass
