#!/usr/bin/env bash
set -euo pipefail
umask 077
[[ "$(id -u)" -eq 0 ]] || exit 2

ACTIVE=/opt/capability-fabric/current
PREVIOUS=/opt/capability-fabric/previous
STATE=/var/lib/capability-fabric/state
CONTROL=/var/lib/capability-fabric/onshape/runtime-control/ONSHAPE_RUNTIME_CONTROL.json
GATE="$STATE/release-in-progress"
LOCK=/run/lock/capability-fabric-pull.lock
TIMER=capability-fabric-pull.timer
GATEWAY=capability-fabric-onshape-gateway
SERVER=capability-fabric-onshape-server
DB=/var/lib/capability-fabric/onshape/fabric-state/execution.sqlite3
QUARANTINE=/var/lib/capability-fabric/onshape/fabric-state/quarantine/D-018-attempt-f6d80f46.json
ROLLBACK_GUARD=/usr/local/libexec/capability-fabric-onshape-rollback-contract

EXPECTED_CONTROL=6ac33244f7968c142e30b2f815d090f74dac49f3
EXPECTED_MANIFEST=01f31143e3574c02d430a6b4f67a9be3ef24590a39f4e27459131da4beece057
EXPECTED_SOURCE=a05f6299a8e7c4ec0d801ae0de58684f8757cab2
TEST_DID=881affea8ea63c33ae4e6c78

active="$(readlink -f "$ACTIVE")"
previous="$(readlink -f "$PREVIOUS")"
[[ "$(basename "$active")" == "onshape-vps-hardened-production-r5" ]] || { echo CF_R5_FINAL_ACTIVE=mismatch >&2; exit 20; }
[[ "$(basename "$previous")" == "capability-fabric-isolated-telegram-ingress-r69" ]] || { echo CF_R5_FINAL_PREVIOUS=mismatch >&2; exit 20; }
[[ "$(sha256sum "$active/manifest.json" | awk '{print $1}')" == "$EXPECTED_MANIFEST" ]] || { echo CF_R5_FINAL_MANIFEST=mismatch >&2; exit 20; }
[[ "$(tr -d '\r\n' < "$active/source-commit")" == "$EXPECTED_SOURCE" ]] || { echo CF_R5_FINAL_SOURCE=mismatch >&2; exit 20; }
[[ "$(cat "$STATE/last-good-sequence")" == "70" ]] || { echo CF_R5_FINAL_SEQUENCE=mismatch >&2; exit 20; }
[[ "$(cat "$STATE/last-good-release")" == "onshape-vps-hardened-production-r5" ]] || { echo CF_R5_FINAL_LAST_GOOD=mismatch >&2; exit 20; }
[[ ! -s "$STATE/last-failed-commit" ]] || { echo CF_R5_FINAL_LAST_FAILED=present >&2; exit 20; }
[[ "$(git hash-object "$CONTROL")" == "$EXPECTED_CONTROL" ]] || { echo CF_R5_FINAL_CONTROL=mismatch >&2; exit 20; }
[[ -f "$GATE" ]] && grep -Fxq RELEASE_IN_PROGRESS "$GATE"
if systemctl is-active --quiet "$TIMER"; then echo CF_R5_FINAL_TIMER=unexpected-active >&2; exit 20; fi
[[ "$(docker inspect -f '{{.State.Running}}' "$GATEWAY")" == false ]] || { echo CF_R5_FINAL_GATEWAY=unexpected-running >&2; exit 20; }
[[ "$(docker inspect -f '{{.State.Running}}' "$SERVER")" == true ]] || { echo CF_R5_FINAL_SERVER=not-running >&2; exit 20; }

python3 - "$CONTROL" <<'PY'
import json,sys
x=json.load(open(sys.argv[1]))
a=x["authority"]; g=a["productionGuard"]; v=a["planes"]["vps-fabric"]; d=a["planes"]["android-v1"]
assert x["controlRevision"]==540
assert a["productionEpoch"]==11 and a["mode"]=="VPS_PRODUCTION" and a["materialAuthority"]=="vps-fabric"
assert a["reconciliationHold"]["active"] is False
assert x["lease"]["state"]=="FREE"
assert d["ingress"]=="CLOSED" and d["materialEffectsAllowed"] is False
assert v["ingress"]=="ADMITTED" and v["materialEffectsAllowed"] is True
assert v["releaseSequence"]==67 and v["releaseId"]=="onshape-vps-hardened-production-r4"
assert g["killSwitch"]=="ENGAGED" and g["allowedDocumentIds"]==[]
assert g["mutationBudget"]["maxMutations"]==0
print("CF_R5_FINAL_AUTHORITY=epoch11-vps-production")
print("CF_R5_FINAL_GUARD=engaged-empty-zero")
print("CF_R5_FINAL_LEASE=FREE")
PY

ponr="$("$ROLLBACK_GUARD" decide --db "$DB" --control "$CONTROL" --quarantine "$QUARANTINE")"
printf '%s\n' "$ponr"
printf '%s\n' "$ponr" | grep -Fxq 'CF_A4_PONR=true'
printf '%s\n' "$ponr" | grep -Fxq 'CF_A4_PONR_COUNT=4'
printf '%s\n' "$ponr" | grep -Fxq 'CF_A4_UNRESOLVED_BLOCKING=0'
echo CF_R5_FINAL_SAFETY_PRE=pass

exec 9>"$LOCK"
flock -w 30 9 || { echo CF_R5_FINAL_PULL_LOCK=busy >&2; exit 21; }

finished=no
cleanup(){
  rc=$?
  set +e
  if [[ "$finished" != yes ]]; then
    systemctl stop "$TIMER" >/dev/null 2>&1 || true
    docker stop "$GATEWAY" >/dev/null 2>&1 || true
    if [[ ! -f "$GATE" ]]; then
      tmp="$GATE.tmp.final.$$"
      printf '%s\n' RELEASE_IN_PROGRESS >"$tmp"
      chmod 0600 "$tmp"
      chown root:root "$tmp"
      mv -f "$tmp" "$GATE"
    fi
    echo CF_R5_FINAL_FAIL_CLOSED=retained
  fi
  exit "$rc"
}
trap cleanup EXIT

rm -f "$GATE"
[[ ! -e "$GATE" ]]
echo CF_R5_FINAL_LOCAL_WINDOW=open

node_out="$(docker exec -e CF_TEST_DID="$TEST_DID" -i "$SERVER" sh -lc 'cd /tmp/app && node --input-type=module' <<'NODE'
import fs from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const DID=process.env.CF_TEST_DID;
const token=fs.readFileSync("/run/secrets/mcp-token","utf8").trim();
const client=new Client({name:"cf-r5-v17-finalizer",version:"1.0.0"});
const transport=new StreamableHTTPClientTransport(new URL("http://127.0.0.1:8788/mcp/"+token));
await client.connect(transport);

function parse(res){
  const raw=(res?.content||[]).filter(x=>x.type==="text").map(x=>x.text||"").join("\n");
  if(!raw) throw new Error("empty tool response");
  return JSON.parse(raw);
}

const tools=(await client.listTools()).tools.map(x=>x.name);
for(const n of ["onshape_pool_status","onshape_fabric_capabilities","onshape_fabric_invoke"]){
  if(!tools.includes(n)) throw new Error("missing "+n);
}
if(tools.includes("onshape_ui_input_sequence")||tools.includes("onshape_ui_native")){
  throw new Error("effectful UI unexpectedly exposed");
}

const caps=parse(await client.callTool({name:"onshape_fabric_capabilities",arguments:{}}));
if(caps?.build_id!=="onshape-vps-hardened-r5") throw new Error("wrong build id "+String(caps?.build_id));
if(caps?.public_surface!=="semantic-only"||caps?.qualification_only!==false) throw new Error("wrong public surface");

const pool=parse(await client.callTool({name:"onshape_pool_status",arguments:{}}));
if(pool?.pool_enabled!==true||pool?.warming!==false||pool?.size!==3) throw new Error("pool not enabled");
if(pool?.active_count!==0||pool?.queued_count!==0||pool?.document_lock_count!==0) throw new Error("pool not idle");
if(pool?.material_mutator_session_id!=="session-1") throw new Error("wrong mutator");
if(pool?.session_fingerprints_distinct!==true) throw new Error("fingerprints not distinct");
for(const s of pool?.sessions||[]){
  if(s?.auth?.state!=="PROVEN") throw new Error("session not proven "+String(s?.session_id));
}
console.log("CF_R5_FINAL_POOL=3-of-3-PROVEN-idle");

const read=parse(await client.callTool({name:"onshape_fabric_invoke",arguments:{
  capability_id:"onshape.documented.operation",
  arguments:{operationId:"getDocument",pathParams:{did:DID},query:{}}
}}));

const rr=read?.result;
const ev=rr?.observation?.evidence||{};
const body=ev.body||{};

if(read?.build_id!=="onshape-vps-hardened-r5") throw new Error("wrong invocation build");
if(rr?.outcome?.state!=="ACHIEVED") throw new Error("read outcome "+String(rr?.outcome?.state));
if(ev.httpStatus!==200) throw new Error("read HTTP "+String(ev.httpStatus));
if(ev.effectSent!==false) throw new Error("read effectSent not false");
if(body.id!==DID) throw new Error("wrong document id");
if(ev.apiVersion!=="v17") throw new Error("pinned API version "+String(ev.apiVersion));
if(ev.observedApiVersion!=="v17") throw new Error("observed API version "+String(ev.observedApiVersion));
if(ev.apiVersionMatched!==true) throw new Error("API version not matched");

console.log("CF_R5_FINAL_READ=pass");
console.log("CF_R5_FINAL_READ_EFFECT_SENT=false");
console.log("CF_R5_FINAL_API_VERSION=v17");
console.log("CF_R5_FINAL_OBSERVED_API_VERSION=v17");
console.log("CF_R5_FINAL_API_VERSION_MATCHED=true");

await client.close();
NODE
)"
printf '%s\n' "$node_out"
printf '%s\n' "$node_out" | grep -Fxq 'CF_R5_FINAL_POOL=3-of-3-PROVEN-idle'
printf '%s\n' "$node_out" | grep -Fxq 'CF_R5_FINAL_READ=pass'
printf '%s\n' "$node_out" | grep -Fxq 'CF_R5_FINAL_API_VERSION_MATCHED=true'

[[ "$(git hash-object "$CONTROL")" == "$EXPECTED_CONTROL" ]]
python3 - "$CONTROL" <<'PY'
import json,sys
x=json.load(open(sys.argv[1])); a=x["authority"]; g=a["productionGuard"]
assert x["lease"]["state"]=="FREE"
assert a["productionEpoch"]==11 and a["mode"]=="VPS_PRODUCTION"
assert a["reconciliationHold"]["active"] is False
assert g["killSwitch"]=="ENGAGED" and g["allowedDocumentIds"]==[] and g["mutationBudget"]["maxMutations"]==0
PY
ponr2="$("$ROLLBACK_GUARD" decide --db "$DB" --control "$CONTROL" --quarantine "$QUARANTINE")"
printf '%s\n' "$ponr2" | grep -Fxq 'CF_A4_PONR_COUNT=4'
printf '%s\n' "$ponr2" | grep -Fxq 'CF_A4_UNRESOLVED_BLOCKING=0'
echo CF_R5_FINAL_SAFETY_POST=pass

systemctl start "$TIMER"
systemctl is-active --quiet "$TIMER"
docker start "$GATEWAY" >/dev/null
[[ "$(docker inspect -f '{{.State.Running}}' "$GATEWAY")" == true ]]
[[ ! -e "$GATE" ]]

finished=yes
trap - EXIT
echo CF_R5_FINAL_ACTIVE_RELEASE=seq70-r5
echo CF_R5_FINAL_PREVIOUS_RELEASE=seq69
echo CF_R5_FINAL_MANIFEST_SHA256=$EXPECTED_MANIFEST
echo CF_R5_FINAL_PULL_TIMER=active
echo CF_R5_FINAL_GATEWAY=running
echo CF_R5_FINAL_RELEASE_GATE=clear
echo CF_R5_FINAL=pass
