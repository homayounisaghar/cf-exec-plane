#!/usr/bin/env bash
set -euo pipefail
umask 077
[[ "$(id -u)" -eq 0 ]] || exit 2

ACTIVE=/opt/capability-fabric/current
PREVIOUS=/opt/capability-fabric/previous
STATE=/var/lib/capability-fabric/state
CONTROL=/var/lib/capability-fabric/onshape/runtime-control/ONSHAPE_RUNTIME_CONTROL.json
MIRROR_BLOB=/var/lib/capability-fabric/onshape/runtime-control/git-blob-sha
GATE="$STATE/release-in-progress"
LOCK=/run/lock/capability-fabric-pull.lock
TIMER=capability-fabric-pull.timer
SERVICE=capability-fabric-pull.service
PULL=/usr/local/libexec/capability-fabric-pull-agent
GATEWAY=capability-fabric-onshape-gateway
SERVER=capability-fabric-onshape-server
FABRIC=capability-fabric-onshape-fabric
DB=/var/lib/capability-fabric/onshape/fabric-state/execution.sqlite3
AGENT_DIR=/var/lib/capability-fabric/onshape/fabric-agent
QUARANTINE=/var/lib/capability-fabric/onshape/fabric-state/quarantine/D-018-attempt-f6d80f46.json
ROLLBACK_GUARD=/usr/local/libexec/capability-fabric-onshape-rollback-contract

PREV_CONTROL=417a443c78550348ed3e9b41b1da4542f9b686dd
TARGET_CONTROL=79ea04caa91462d85021ae46392b636b217a6cc8
EXPECTED_MANIFEST=01f31143e3574c02d430a6b4f67a9be3ef24590a39f4e27459131da4beece057
TEST_DID=881affea8ea63c33ae4e6c78

active="$(readlink -f "$ACTIVE")"
previous="$(readlink -f "$PREVIOUS")"
[[ "$(basename "$active")" == "onshape-vps-hardened-production-r5" ]] || exit 20
[[ "$(basename "$previous")" == "capability-fabric-isolated-telegram-ingress-r69" ]] || exit 20
[[ "$(cat "$STATE/last-good-sequence")" == "70" ]] || exit 20
[[ "$(cat "$STATE/last-good-release")" == "onshape-vps-hardened-production-r5" ]] || exit 20
[[ ! -s "$STATE/last-failed-commit" ]] || exit 20
[[ "$(sha256sum "$active/manifest.json" | awk '{print $1}')" == "$EXPECTED_MANIFEST" ]] || exit 20
[[ "$(git hash-object "$CONTROL")" == "$PREV_CONTROL" ]] || exit 20
[[ "$(tr -d '\r\n' < "$MIRROR_BLOB")" == "$PREV_CONTROL" ]] || exit 20
[[ -f "$GATE" ]] && grep -Fxq RELEASE_IN_PROGRESS "$GATE"
if systemctl is-active --quiet "$TIMER"; then exit 20; fi
if systemctl is-active --quiet "$SERVICE"; then echo CF_R5_AUTH_FINAL_PULL_SERVICE=busy >&2; exit 20; fi
[[ "$(docker inspect -f '{{.State.Running}}' "$GATEWAY")" == false ]] || exit 20
[[ "$(docker inspect -f '{{.State.Running}}' "$SERVER")" == true ]] || exit 20
[[ "$(docker inspect -f '{{.State.Running}}' "$FABRIC")" == true ]] || exit 20

python3 - "$CONTROL" <<'PY'
import json,sys
x=json.load(open(sys.argv[1])); a=x["authority"]; g=a["productionGuard"]; v=a["planes"]["vps-fabric"]; d=a["planes"]["android-v1"]
assert x["controlRevision"]==541
assert a["productionEpoch"]==12 and a["mode"]=="QUIESCED_RECONCILING" and a["materialAuthority"] is None
assert d["ingress"]=="CLOSED" and d["materialEffectsAllowed"] is False
assert v["ingress"]=="CLOSED" and v["materialEffectsAllowed"] is False
assert v["releaseSequence"]==70 and v["releaseId"]=="onshape-vps-hardened-production-r5"
assert v["manifestSha256"]=="01f31143e3574c02d430a6b4f67a9be3ef24590a39f4e27459131da4beece057"
assert a["reconciliationHold"]["active"] is False
assert x["lease"]["state"]=="FREE"
assert g["generation"]==3 and g["killSwitch"]=="ENGAGED"
assert g["allowedDocumentIds"]==[] and g["mutationBudget"]["maxMutations"]==0
print("CF_R5_AUTH_FINAL_PRE=epoch12-quiesced")
PY

out="$("$PULL" pull)"
printf '%s\n' "$out"
printf '%s\n' "$out" | grep -Fxq 'CF_RUNTIME_CONTROL_MIRROR=updated'
printf '%s\n' "$out" | grep -Fxq 'CF_PULL_NO_CHANGE'

[[ "$(git hash-object "$CONTROL")" == "$TARGET_CONTROL" ]] || { echo CF_R5_AUTH_FINAL_CONTROL=mismatch >&2; exit 30; }
[[ "$(tr -d '\r\n' < "$MIRROR_BLOB")" == "$TARGET_CONTROL" ]] || exit 30
[[ "$(basename "$(readlink -f "$ACTIVE")")" == "onshape-vps-hardened-production-r5" ]] || exit 30
[[ "$(cat "$STATE/last-good-sequence")" == "70" ]] || exit 30
[[ "$(cat "$STATE/last-good-release")" == "onshape-vps-hardened-production-r5" ]] || exit 30
[[ -f "$GATE" ]] && grep -Fxq RELEASE_IN_PROGRESS "$GATE"
if systemctl is-active --quiet "$TIMER"; then exit 30; fi
[[ "$(docker inspect -f '{{.State.Running}}' "$GATEWAY")" == false ]] || exit 30

python3 - "$CONTROL" <<'PY'
import json,sys
x=json.load(open(sys.argv[1])); a=x["authority"]; g=a["productionGuard"]; v=a["planes"]["vps-fabric"]; d=a["planes"]["android-v1"]
assert x["controlRevision"]==542
assert a["productionEpoch"]==13 and a["mode"]=="VPS_PRODUCTION" and a["materialAuthority"]=="vps-fabric"
assert d["ingress"]=="CLOSED" and d["materialEffectsAllowed"] is False
assert v["ingress"]=="ADMITTED" and v["materialEffectsAllowed"] is True
assert v["releaseSequence"]==70 and v["releaseId"]=="onshape-vps-hardened-production-r5"
assert v["manifestSha256"]=="01f31143e3574c02d430a6b4f67a9be3ef24590a39f4e27459131da4beece057"
assert a["reconciliationHold"]["active"] is False
assert x["lease"]["state"]=="FREE"
assert g["generation"]==3 and g["killSwitch"]=="ENGAGED"
assert g["allowedDocumentIds"]==[] and g["mutationBudget"]["maxMutations"]==0
assert x["routing"]["state"]=="CLOSED" and x["routing"]["materialCommandsAllowed"] is False
print("CF_R5_AUTH_FINAL_AUTHORITY=epoch13-seq70-r5")
print("CF_R5_AUTH_FINAL_GUARD=engaged-empty-zero")
print("CF_R5_AUTH_FINAL_LEASE=FREE")
PY

ponr="$("$ROLLBACK_GUARD" decide --db "$DB" --control "$CONTROL" --quarantine "$QUARANTINE")"
printf '%s\n' "$ponr"
printf '%s\n' "$ponr" | grep -Fxq 'CF_A4_PONR=true'
printf '%s\n' "$ponr" | grep -Fxq 'CF_A4_PONR_COUNT=4'
printf '%s\n' "$ponr" | grep -Fxq 'CF_A4_UNRESOLVED_BLOCKING=0'
printf '%s\n' "$ponr" | grep -Fxq 'CF_A4_ZERO_UNRESOLVED=pass'
echo CF_R5_AUTH_FINAL_SAFETY_PRE=pass

exec 9>"$LOCK"
flock -w 30 9 || { echo CF_R5_AUTH_FINAL_PULL_LOCK=busy >&2; exit 31; }

before_mutations="$(python3 - "$DB" <<'PY'
import json,sqlite3,sys
c=sqlite3.connect(f"file:{sys.argv[1]}?mode=ro",uri=True)
n=0
for (payload,) in c.execute("select dispatch_payload from invocations where dispatch_payload is not null"):
    try:d=json.loads(payload)
    except Exception:continue
    if (d.get("execution_payload") or {}).get("agentEffect")=="MUTATION": n+=1
print(n)
c.close()
PY
)"
before_reservations="$(find "$AGENT_DIR/mutation-budgets" -type f -name '*.json' 2>/dev/null | wc -l | tr -d ' ')"

finished=no
window=no
cleanup(){
  rc=$?
  set +e
  if [[ "$finished" != yes ]]; then
    if [[ "$window" == yes || ! -f "$GATE" ]]; then
      tmp="$GATE.tmp.auth-final.$$"
      printf '%s\n' RELEASE_IN_PROGRESS >"$tmp"
      chmod 0600 "$tmp"
      chown root:root "$tmp"
      mv -f "$tmp" "$GATE"
    fi
    systemctl stop "$TIMER" >/dev/null 2>&1 || true
    docker stop "$GATEWAY" >/dev/null 2>&1 || true
    echo CF_R5_AUTH_FINAL_FAIL_CLOSED=retained
  fi
  exit "$rc"
}
trap cleanup EXIT

rm -f "$GATE"
window=yes
[[ ! -e "$GATE" ]]
echo CF_R5_AUTH_FINAL_LOCAL_WINDOW=open

node_out="$(docker exec -e CF_TEST_DID="$TEST_DID" -i "$SERVER" sh -lc 'cd /tmp/app && node --input-type=module' <<'NODE'
import fs from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const DID=process.env.CF_TEST_DID;
const token=fs.readFileSync("/run/secrets/mcp-token","utf8").trim();
const client=new Client({name:"cf-r5-authority-finalizer",version:"1.0.0"});
const transport=new StreamableHTTPClientTransport(new URL("http://127.0.0.1:8788/mcp/"+token));
await client.connect(transport);

const parse=(res)=>{
  const raw=(res?.content||[]).filter(x=>x.type==="text").map(x=>x.text||"").join("\n");
  if(!raw) return null;
  try{return JSON.parse(raw);}catch{return {raw};}
};

const tools=(await client.listTools()).tools.map(x=>x.name);
for(const n of ["onshape_pool_status","onshape_fabric_capabilities","onshape_fabric_invoke"]){
  if(!tools.includes(n)) throw new Error("missing "+n);
}
if(tools.includes("onshape_ui_input_sequence")||tools.includes("onshape_ui_native")){
  throw new Error("effectful UI exposed");
}

const caps=parse(await client.callTool({name:"onshape_fabric_capabilities",arguments:{}}));
if(caps?.build_id!=="onshape-vps-hardened-r5"||caps?.public_surface!=="semantic-only"||caps?.qualification_only!==false){
  throw new Error("wrong live surface");
}

const pool=parse(await client.callTool({name:"onshape_pool_status",arguments:{}}));
if(pool?.pool_enabled!==true||pool?.warming!==false||pool?.size!==3) throw new Error("pool not enabled");
if(pool?.active_count!==0||pool?.queued_count!==0||pool?.document_lock_count!==0) throw new Error("pool not idle");
if(pool?.material_mutator_session_id!=="session-1"||pool?.session_fingerprints_distinct!==true) throw new Error("pool identity invalid");
for(const s of pool?.sessions||[]) if(s?.auth?.state!=="PROVEN") throw new Error("session not PROVEN "+String(s?.session_id));
console.log("CF_R5_AUTH_FINAL_POOL=3-of-3-PROVEN-idle");

const read1=parse(await client.callTool({name:"onshape_fabric_invoke",arguments:{
  capability_id:"onshape.documented.operation",
  arguments:{operationId:"getDocument",pathParams:{did:DID},query:{}}
}}));
const r1=read1?.result,e1=r1?.observation?.evidence||{},b1=e1.body||{};
if(read1?.build_id!=="onshape-vps-hardened-r5"||r1?.outcome?.state!=="ACHIEVED"||e1.httpStatus!==200||e1.effectSent!==false){
  throw new Error("pre-read failed");
}
if(b1.id!==DID) throw new Error("wrong document id");
if(e1.apiVersion!=="v17"||e1.observedApiVersion!=="v17"||e1.apiVersionMatched!==true){
  throw new Error("pre-read version mismatch");
}
const originalName=String(b1.name||"");
if(!originalName) throw new Error("missing original document name");
console.log("CF_R5_AUTH_FINAL_READ=pass");
console.log("CF_R5_AUTH_FINAL_API_VERSION=v17");
console.log("CF_R5_AUTH_FINAL_OBSERVED_API_VERSION=v17");
console.log("CF_R5_AUTH_FINAL_API_VERSION_MATCHED=true");

const forbiddenName="MUST NOT APPLY - R5 AUTHORITY REBIND";
let rejected=false;
try{
  const mut=await client.callTool({name:"onshape_fabric_invoke",arguments:{
    capability_id:"onshape.documented.operation",
    arguments:{
      operationId:"updateDocumentAttributes",
      pathParams:{did:DID},
      query:{},
      body:{name:forbiddenName},
      verification:{kind:"document_name_equals",value:forbiddenName}
    }
  }});
  const parsed=parse(mut);
  const joined=JSON.stringify(parsed||{});
  if(mut?.isError===true || /kill switch|guard|allowlist|budget|permission/i.test(joined)) rejected=true;
  if(parsed?.result?.outcome?.state==="ACHIEVED"||parsed?.result?.observation?.evidence?.effectSent===true){
    throw new Error("negative mutation unexpectedly achieved");
  }
}catch(e){
  if(/kill switch|guard|allowlist|budget|permission|tool returned|MCP/i.test(String(e))) rejected=true;
  else throw e;
}
if(!rejected) throw new Error("guarded mutation not conclusively rejected");
console.log("CF_R5_AUTH_FINAL_NEGATIVE_MUTATION=rejected-pre-effect");

const read2=parse(await client.callTool({name:"onshape_fabric_invoke",arguments:{
  capability_id:"onshape.documented.operation",
  arguments:{operationId:"getDocument",pathParams:{did:DID},query:{}}
}}));
const r2=read2?.result,e2=r2?.observation?.evidence||{},b2=e2.body||{};
if(r2?.outcome?.state!=="ACHIEVED"||e2.httpStatus!==200||e2.effectSent!==false) throw new Error("post-read failed");
if(String(b2.name||"")!==originalName||String(b2.name||"")===forbiddenName) throw new Error("document changed");
if(e2.apiVersion!=="v17"||e2.observedApiVersion!=="v17"||e2.apiVersionMatched!==true) throw new Error("post-read version mismatch");
console.log("CF_R5_AUTH_FINAL_POST_NEGATIVE_READ=unchanged");
await client.close();
NODE
)"
printf '%s\n' "$node_out"
printf '%s\n' "$node_out" | grep -Fxq 'CF_R5_AUTH_FINAL_READ=pass'
printf '%s\n' "$node_out" | grep -Fxq 'CF_R5_AUTH_FINAL_NEGATIVE_MUTATION=rejected-pre-effect'
printf '%s\n' "$node_out" | grep -Fxq 'CF_R5_AUTH_FINAL_POST_NEGATIVE_READ=unchanged'

after_mutations="$(python3 - "$DB" <<'PY'
import json,sqlite3,sys
c=sqlite3.connect(f"file:{sys.argv[1]}?mode=ro",uri=True)
n=0
for (payload,) in c.execute("select dispatch_payload from invocations where dispatch_payload is not null"):
    try:d=json.loads(payload)
    except Exception:continue
    if (d.get("execution_payload") or {}).get("agentEffect")=="MUTATION": n+=1
print(n)
c.close()
PY
)"
after_reservations="$(find "$AGENT_DIR/mutation-budgets" -type f -name '*.json' 2>/dev/null | wc -l | tr -d ' ')"
[[ "$after_mutations" == "$before_mutations" ]] || { echo CF_R5_AUTH_FINAL_MUTATION_ROWS_CHANGED >&2; exit 40; }
[[ "$after_reservations" == "$before_reservations" ]] || { echo CF_R5_AUTH_FINAL_BUDGET_RESERVED >&2; exit 41; }
echo "CF_R5_AUTH_FINAL_MUTATION_ROWS=$after_mutations"
echo "CF_R5_AUTH_FINAL_BUDGET_RESERVATIONS=$after_reservations"
echo CF_R5_AUTH_FINAL_NEGATIVE_NO_DISPATCH=pass
echo CF_R5_AUTH_FINAL_NEGATIVE_NO_BUDGET_RESERVATION=pass

[[ "$(git hash-object "$CONTROL")" == "$TARGET_CONTROL" ]]
ponr2="$("$ROLLBACK_GUARD" decide --db "$DB" --control "$CONTROL" --quarantine "$QUARANTINE")"
printf '%s\n' "$ponr2" | grep -Fxq 'CF_A4_PONR_COUNT=4'
printf '%s\n' "$ponr2" | grep -Fxq 'CF_A4_UNRESOLVED_BLOCKING=0'
printf '%s\n' "$ponr2" | grep -Fxq 'CF_A4_ZERO_UNRESOLVED=pass'
echo CF_R5_AUTH_FINAL_SAFETY_POST=pass

systemctl start "$TIMER"
systemctl is-active --quiet "$TIMER"
docker start "$GATEWAY" >/dev/null
[[ "$(docker inspect -f '{{.State.Running}}' "$GATEWAY")" == true ]]
[[ ! -e "$GATE" ]]

finished=yes
window=no
trap - EXIT

echo CF_R5_AUTH_FINAL_ACTIVE_RELEASE=seq70-r5
echo CF_R5_AUTH_FINAL_AUTHORITY_RELEASE=seq70-r5
echo CF_R5_AUTH_FINAL_EPOCH=13
echo CF_R5_AUTH_FINAL_RELEASE_GATE=clear
echo CF_R5_AUTH_FINAL_PULL_TIMER=active
echo CF_R5_AUTH_FINAL_GATEWAY=running
echo CF_R5_AUTH_FINAL=pass
