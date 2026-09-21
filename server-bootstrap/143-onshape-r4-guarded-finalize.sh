#!/usr/bin/env bash
set -euo pipefail
umask 077
[[ "$(id -u)" -eq 0 ]] || exit 2

RELEASES=/var/lib/capability-fabric/releases
STATE=/var/lib/capability-fabric/state
ACTIVE=/opt/capability-fabric/current
PREVIOUS=/opt/capability-fabric/previous
CONTROL=/var/lib/capability-fabric/onshape/runtime-control/ONSHAPE_RUNTIME_CONTROL.json
MIRROR_BLOB=/var/lib/capability-fabric/onshape/runtime-control/git-blob-sha
GATE="$STATE/release-in-progress"
LOCK=/run/lock/capability-fabric-pull.lock
TIMER=capability-fabric-pull.timer
GATEWAY=capability-fabric-onshape-gateway
SERVER=capability-fabric-onshape-server
FABRIC=capability-fabric-onshape-fabric
DB=/var/lib/capability-fabric/onshape/fabric-state/execution.sqlite3
AGENT_DIR=/var/lib/capability-fabric/onshape/fabric-agent
QUARANTINE=/var/lib/capability-fabric/onshape/fabric-state/quarantine/D-018-attempt-f6d80f46.json
ROLLBACK_GUARD=/usr/local/libexec/capability-fabric-onshape-rollback-contract

expected_control=3b7b05f78c89d7fed2f8bb964cda42347924a329
expected_manifest=f2631a7f94ec5f6e5af5e9d3b3211cf440354eef0b55ff6fee7ab65cec50bfb9
did=84d077d8370c21c4b3045263
wid=aa8c5ad631e1836645149d09

active="$(readlink -f "$ACTIVE")"
previous="$(readlink -f "$PREVIOUS")"
[[ "$active" == "$RELEASES/onshape-vps-hardened-production-r4" ]] || exit 20
[[ "$previous" == "$RELEASES/onshape-vps-hardened-production-r3" ]] || exit 20
[[ "$(sha256sum "$active/manifest.json" | awk '{print $1}')" == "$expected_manifest" ]] || exit 20
[[ "$(git hash-object "$CONTROL")" == "$expected_control" ]] || exit 20
[[ "$(tr -d '\r\n' < "$MIRROR_BLOB")" == "$expected_control" ]] || exit 20
[[ -f "$GATE" ]] || exit 20
grep -Fxq RELEASE_IN_PROGRESS "$GATE"
if systemctl is-active --quiet "$TIMER"; then exit 20; fi
[[ "$(docker inspect -f '{{.State.Running}}' "$GATEWAY")" == false ]]
[[ "$(docker inspect -f '{{.State.Running}}' "$SERVER")" == true ]]
[[ "$(docker inspect -f '{{.State.Running}}' "$FABRIC")" == true ]]

python3 - "$active/manifest.json" "$previous/manifest.json" "$CONTROL" <<'PY'
import json,sys
m=json.load(open(sys.argv[1])); p=json.load(open(sys.argv[2])); x=json.load(open(sys.argv[3]))
a=x["authority"]; g=a["productionGuard"]; v=a["planes"]["vps-fabric"]; android=a["planes"]["android-v1"]
assert m["sequence"]==67 and m["release_id"]=="onshape-vps-hardened-production-r4"
assert p["sequence"]==66 and p["release_id"]=="onshape-vps-hardened-production-r3"
assert x["controlRevision"]==534 and a["productionEpoch"]==5
assert a["mode"]=="VPS_PRODUCTION" and a["materialAuthority"]=="vps-fabric"
assert android["ingress"]=="CLOSED" and android["materialEffectsAllowed"] is False
assert v["ingress"]=="ADMITTED" and v["materialEffectsAllowed"] is True
assert v["releaseSequence"]==67 and v["releaseId"]=="onshape-vps-hardened-production-r4"
assert v["manifestSha256"]=="f2631a7f94ec5f6e5af5e9d3b3211cf440354eef0b55ff6fee7ab65cec50bfb9"
assert a["reconciliationHold"]["active"] is False
assert x["lease"]["state"]=="FREE"
assert g["schema"]=="capability-fabric.onshape-production-guard.v1"
assert g["generation"]==1 and g["killSwitch"]=="ENGAGED"
assert g["allowedDocumentIds"]==[]
assert g["mutationBudget"]=={"budgetId":"epoch4-seq67-stabilization-closed","maxMutations":0}
print("CF_R4_FINAL_AUTHORITY=epoch5-vps-production")
print("CF_R4_FINAL_GUARD=engaged-empty-zero")
print("CF_R4_FINAL_ANDROID=CLOSED")
print("CF_R4_FINAL_RELEASE=seq67")
PY

ponr="$("$ROLLBACK_GUARD" decide --db "$DB" --control "$CONTROL" --quarantine "$QUARANTINE")"
printf '%s\n' "$ponr"
printf '%s\n' "$ponr" | grep -Fxq 'CF_A4_PONR=true'
printf '%s\n' "$ponr" | grep -Fxq 'CF_A4_PONR_COUNT=2'
printf '%s\n' "$ponr" | grep -Fxq 'CF_A4_UNRESOLVED_BLOCKING=0'
printf '%s\n' "$ponr" | grep -Fxq 'CF_A4_ZERO_UNRESOLVED=pass'
echo CF_R4_FINAL_SAFETY_PRE=pass

exec 9>"$LOCK"
flock -w 30 9 || exit 21
echo CF_R4_FINAL_PULL_LOCK=held

before_mutations="$(python3 - "$DB" <<'PY'
import json,sqlite3,sys
c=sqlite3.connect(f"file:{sys.argv[1]}?mode=ro",uri=True)
n=0
for (payload,) in c.execute("select dispatch_payload from invocations where dispatch_payload is not null"):
    try: d=json.loads(payload)
    except Exception: continue
    if (d.get("execution_payload") or {}).get("agentEffect")=="MUTATION": n+=1
print(n)
c.close()
PY
)"
before_reservations="$(find "$AGENT_DIR/mutation-budgets" -type f -name '*.json' 2>/dev/null | wc -l | tr -d ' ')"

finalized=no
local_window=no
cleanup(){
  rc=$?
  set +e
  if [[ "$finalized" != yes ]]; then
    systemctl stop "$TIMER" >/dev/null 2>&1 || true
    docker stop "$GATEWAY" >/dev/null 2>&1 || true
    if [[ ! -f "$GATE" ]]; then
      tmp="$GATE.tmp.$$"
      printf '%s\n' RELEASE_IN_PROGRESS >"$tmp"
      chmod 0600 "$tmp"
      chown root:root "$tmp"
      mv -f "$tmp" "$GATE"
    fi
    echo CF_R4_FINAL_FAIL_CLOSED=retained
  fi
  exit "$rc"
}
trap cleanup EXIT

rm -f "$GATE"
local_window=yes
[[ ! -e "$GATE" ]]
[[ "$(docker inspect -f '{{.State.Running}}' "$GATEWAY")" == false ]]
if systemctl is-active --quiet "$TIMER"; then exit 22; fi
echo CF_R4_FINAL_LOCAL_WINDOW=open

node_out="$(docker exec -i "$SERVER" sh -lc 'cd /tmp/app && node --input-type=module' <<'NODE'
import fs from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
const DID="84d077d8370c21c4b3045263";
const WID="aa8c5ad631e1836645149d09";
const token=fs.readFileSync("/run/secrets/mcp-token","utf8").trim();
const client=new Client({name:"cf-r4-guarded-finalizer",version:"1.0.0"});
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
if(caps.build_id!=="onshape-vps-hardened-r4"||caps.public_surface!=="semantic-only"||caps.qualification_only!==false) throw new Error("wrong live surface");
const pool=parse(await client.callTool({name:"onshape_pool_status",arguments:{}}));
if(pool.pool_enabled!==true||pool.size!==3||pool.active_count!==0||pool.queued_count!==0||pool.document_lock_count!==0) throw new Error("pool not idle");
if(pool.material_mutator_session_id!=="session-1") throw new Error("wrong mutator");
for(const s of pool.sessions||[]) if(s?.auth?.state!=="PROVEN") throw new Error("session not proven");

const read=parse(await client.callTool({name:"onshape_fabric_invoke",arguments:{
  capability_id:"onshape.documented.operation",
  arguments:{operationId:"getDocument",pathParams:{did:DID},query:{}}
}}));
const rr=read?.result, ev=rr?.observation?.evidence||{}, body=ev.body||{};
if(read?.build_id!=="onshape-vps-hardened-r4"||rr?.outcome?.state!=="ACHIEVED"||ev.httpStatus!==200||ev.effectSent!==false) throw new Error("read failed");
if(body.id!==DID||body.name!=="Speedtest 2"||body?.defaultWorkspace?.id!==WID) throw new Error("wrong document state");
console.log("CF_R4_FINAL_READ=pass");
console.log("CF_R4_FINAL_READ_EFFECT_SENT=false");
console.log("CF_R4_FINAL_POOL=3-of-3-PROVEN-idle");

let rejected=false;
try{
  const mut=await client.callTool({name:"onshape_fabric_invoke",arguments:{
    capability_id:"onshape.documented.operation",
    arguments:{
      operationId:"updateDocumentAttributes",
      pathParams:{did:DID},query:{},
      body:{name:"MUST NOT APPLY - R4 GUARDED FINALIZER"},
      verification:{kind:"document_name_equals",value:"MUST NOT APPLY - R4 GUARDED FINALIZER"}
    }
  }});
  const parsed=parse(mut);
  const joined=JSON.stringify(parsed||{});
  if(mut?.isError===true || /kill switch|guard|allowlist|budget|permission/i.test(joined)) rejected=true;
  if(parsed?.result?.outcome?.state==="ACHIEVED"||parsed?.result?.observation?.evidence?.effectSent===true) throw new Error("negative mutation unexpectedly achieved");
}catch(e){
  if(/kill switch|guard|allowlist|budget|permission|tool returned|MCP/i.test(String(e))) rejected=true;
  else throw e;
}
if(!rejected) throw new Error("guarded negative mutation not conclusively rejected");
console.log("CF_R4_FINAL_NEGATIVE_MUTATION=rejected-pre-effect");

const read2=parse(await client.callTool({name:"onshape_fabric_invoke",arguments:{
  capability_id:"onshape.documented.operation",
  arguments:{operationId:"getDocument",pathParams:{did:DID},query:{}}
}}));
const r2=read2?.result,e2=r2?.observation?.evidence||{},b2=e2.body||{};
if(r2?.outcome?.state!=="ACHIEVED"||e2.effectSent!==false||b2.name!=="Speedtest 2") throw new Error("target changed");
console.log("CF_R4_FINAL_POST_NEGATIVE_READ=unchanged");
await client.close();
NODE
)"
printf '%s\n' "$node_out"

after_mutations="$(python3 - "$DB" <<'PY'
import json,sqlite3,sys
c=sqlite3.connect(f"file:{sys.argv[1]}?mode=ro",uri=True)
n=0
for (payload,) in c.execute("select dispatch_payload from invocations where dispatch_payload is not null"):
    try: d=json.loads(payload)
    except Exception: continue
    if (d.get("execution_payload") or {}).get("agentEffect")=="MUTATION": n+=1
print(n)
c.close()
PY
)"
after_reservations="$(find "$AGENT_DIR/mutation-budgets" -type f -name '*.json' 2>/dev/null | wc -l | tr -d ' ')"
[[ "$after_mutations" == "$before_mutations" ]] || exit 40
[[ "$after_reservations" == "$before_reservations" ]] || exit 41
echo "CF_R4_FINAL_MUTATION_ROWS=$after_mutations"
echo "CF_R4_FINAL_BUDGET_RESERVATIONS=$after_reservations"
echo CF_R4_FINAL_NEGATIVE_NO_DISPATCH=pass
echo CF_R4_FINAL_NEGATIVE_NO_BUDGET_RESERVATION=pass

ponr2="$("$ROLLBACK_GUARD" decide --db "$DB" --control "$CONTROL" --quarantine "$QUARANTINE")"
printf '%s\n' "$ponr2" | grep -Fxq 'CF_A4_PONR_COUNT=2'
printf '%s\n' "$ponr2" | grep -Fxq 'CF_A4_UNRESOLVED_BLOCKING=0'
echo CF_R4_FINAL_SAFETY_POST=pass

systemctl start "$TIMER"
systemctl is-active --quiet "$TIMER"
docker start "$GATEWAY" >/dev/null
[[ "$(docker inspect -f '{{.State.Running}}' "$GATEWAY")" == true ]]
[[ ! -e "$GATE" ]]
finalized=yes
local_window=no
trap - EXIT
echo CF_R4_FINAL_RELEASE_GATE=clear
echo CF_R4_FINAL_PULL_TIMER=active
echo CF_R4_FINAL_GATEWAY=running
echo CF_R4_FINAL=pass
