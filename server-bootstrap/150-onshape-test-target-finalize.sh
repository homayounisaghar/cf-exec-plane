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
DB=/var/lib/capability-fabric/onshape/fabric-state/execution.sqlite3
AGENT_DIR=/var/lib/capability-fabric/onshape/fabric-agent
QUARANTINE=/var/lib/capability-fabric/onshape/fabric-state/quarantine/D-018-attempt-f6d80f46.json
ROLLBACK_GUARD=/usr/local/libexec/capability-fabric-onshape-rollback-contract

expected_control=499a1372a0416d5f8d0bbcecbef39cee20373f5b
expected_manifest=f2631a7f94ec5f6e5af5e9d3b3211cf440354eef0b55ff6fee7ab65cec50bfb9
did=881affea8ea63c33ae4e6c78
wid=7b1e64a5ce7f95e660a9a5f2
closed_budget_id=epoch7-post-test-closed
closed_budget_key="$(printf '%s' "3:$closed_budget_id" | sha256sum | awk '{print $1}')"
closed_budget_dir="$AGENT_DIR/mutation-budgets/$closed_budget_key"

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

python3 - "$active/manifest.json" "$CONTROL" <<'PY'
import json,sys
m=json.load(open(sys.argv[1])); x=json.load(open(sys.argv[2]))
a=x["authority"]; g=a["productionGuard"]; v=a["planes"]["vps-fabric"]; android=a["planes"]["android-v1"]
assert m["sequence"]==67 and m["release_id"]=="onshape-vps-hardened-production-r4"
assert x["controlRevision"]==536 and a["productionEpoch"]==7
assert a["mode"]=="VPS_PRODUCTION" and a["materialAuthority"]=="vps-fabric"
assert android["ingress"]=="CLOSED" and android["materialEffectsAllowed"] is False
assert v["ingress"]=="ADMITTED" and v["materialEffectsAllowed"] is True
assert v["releaseSequence"]==67 and v["releaseId"]=="onshape-vps-hardened-production-r4"
assert v["manifestSha256"]=="f2631a7f94ec5f6e5af5e9d3b3211cf440354eef0b55ff6fee7ab65cec50bfb9"
assert a["reconciliationHold"]["active"] is False
assert x["lease"]["state"]=="FREE"
assert g["generation"]==3 and g["killSwitch"]=="ENGAGED"
assert g["allowedDocumentIds"]==[]
assert g["mutationBudget"]=={"budgetId":"epoch7-post-test-closed","maxMutations":0}
print("CF_TARGET_FINAL_AUTHORITY=rev536-epoch7-vps")
print("CF_TARGET_FINAL_GUARD=gen3-engaged-empty-zero")
print("CF_TARGET_FINAL_ANDROID=CLOSED")
print("CF_TARGET_FINAL_RELEASE=seq67")
PY

ponr="$("$ROLLBACK_GUARD" decide --db "$DB" --control "$CONTROL" --quarantine "$QUARANTINE")"
printf '%s\n' "$ponr"
printf '%s\n' "$ponr" | grep -Fxq 'CF_A4_PONR=true'
printf '%s\n' "$ponr" | grep -Fxq 'CF_A4_PONR_COUNT=4'
printf '%s\n' "$ponr" | grep -Fxq 'CF_A4_UNRESOLVED_BLOCKING=0'
printf '%s\n' "$ponr" | grep -Fxq 'CF_A4_ZERO_UNRESOLVED=pass'
echo CF_TARGET_FINAL_SAFETY_PRE=pass

if [[ -d "$closed_budget_dir" ]]; then
  before_closed_res="$(find "$closed_budget_dir" -maxdepth 1 -type f -name '*.json' -print | wc -l | tr -d ' ')"
else
  before_closed_res=0
fi
[[ "$before_closed_res" == 0 ]]
echo CF_TARGET_FINAL_CLOSED_BUDGET_BEFORE=0

before_mutation_dispatches="$(python3 - "$DB" <<'PY'
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

exec 9>"$LOCK"
flock -w 30 9 || exit 21
echo CF_TARGET_FINAL_PULL_LOCK=held

finalized=no
window_open=no
cleanup(){
  rc=$?
  set +e
  if [[ "$finalized" != yes ]]; then
    if [[ "$window_open" == yes || ! -f "$GATE" ]]; then
      tmp="$GATE.tmp.$$"
      printf '%s\n' RELEASE_IN_PROGRESS >"$tmp"
      chmod 0600 "$tmp"
      chown root:root "$tmp"
      mv -f "$tmp" "$GATE"
    fi
    systemctl stop "$TIMER" >/dev/null 2>&1 || true
    docker stop "$GATEWAY" >/dev/null 2>&1 || true
    echo CF_TARGET_FINAL_FAIL_CLOSED=retained
  fi
  exit "$rc"
}
trap cleanup EXIT

rm -f "$GATE"
window_open=yes
[[ ! -e "$GATE" ]]
[[ "$(docker inspect -f '{{.State.Running}}' "$GATEWAY")" == false ]]
if systemctl is-active --quiet "$TIMER"; then exit 22; fi
echo CF_TARGET_FINAL_LOCAL_WINDOW=open

node_out="$(docker exec -i "$SERVER" sh -lc 'cd /tmp/app && node --input-type=module' <<'NODE'
import fs from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
const DID="881affea8ea63c33ae4e6c78";
const WID="7b1e64a5ce7f95e660a9a5f2";
const EXPECTED="CF-R4-TARGET-TEST-B";
const FORBIDDEN="CF-R4-TARGET-CLOSED-MUST-NOT-APPLY";
const token=fs.readFileSync("/run/secrets/mcp-token","utf8").trim();
const client=new Client({name:"cf-r4-target-finalizer",version:"1.0.0"});
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
if(caps.build_id!=="onshape-vps-hardened-r4"||caps.public_surface!=="semantic-only"||caps.qualification_only!==false) throw new Error("wrong surface");
const pool=parse(await client.callTool({name:"onshape_pool_status",arguments:{}}));
if(pool.pool_enabled!==true||pool.size!==3||pool.active_count!==0||pool.queued_count!==0||pool.document_lock_count!==0) throw new Error("pool not idle");
if(pool.material_mutator_session_id!=="session-1") throw new Error("wrong mutator");
for(const s of pool.sessions||[]) if(s?.auth?.state!=="PROVEN") throw new Error("session not proven");
console.log("CF_TARGET_FINAL_POOL=3-of-3-PROVEN-idle");

const call=async(args)=>client.callTool({name:"onshape_fabric_invoke",arguments:{capability_id:"onshape.documented.operation",arguments:args}});
const read1=parse(await call({operationId:"getDocument",pathParams:{did:DID},query:{}}));
const r1=read1?.result,e1=r1?.observation?.evidence||{},b1=e1.body||{};
if(r1?.outcome?.state!=="ACHIEVED"||e1.effectSent!==false||b1.id!==DID||b1.name!==EXPECTED||b1?.defaultWorkspace?.id!==WID) throw new Error("pre-negative read mismatch");
console.log("CF_TARGET_FINAL_READ=pass");
console.log("CF_TARGET_FINAL_READ_EFFECT_SENT=false");
console.log("CF_TARGET_FINAL_NAME="+b1.name);

const negRaw=await call({
  operationId:"updateDocumentAttributes",pathParams:{did:DID},query:{},
  body:{name:FORBIDDEN},verification:{kind:"document_name_equals",value:FORBIDDEN}
});
const neg=parse(negRaw);
const text=JSON.stringify(neg||{});
let rejected=false;
if(neg?.status==="FAILED" && /kill.?switch|engaged|production guard|material.*guard/i.test(text)) rejected=true;
const nr=neg?.result,ne=nr?.observation?.evidence||{};
if(nr?.outcome?.state==="ABSENT" && nr?.observation?.ackState==="REJECTED" && ne.effectSent===false && /kill.?switch|engaged|guard/i.test(String(nr?.observation?.detail||""))) rejected=true;
if(nr?.outcome?.state==="ACHIEVED"||ne.effectSent===true) throw new Error("closed-guard mutation achieved");
if(!rejected) throw new Error("closed guard rejection not conclusive: "+text);
console.log("CF_TARGET_FINAL_NEGATIVE=rejected-pre-effect");

const read2=parse(await call({operationId:"getDocument",pathParams:{did:DID},query:{}}));
const r2=read2?.result,e2=r2?.observation?.evidence||{},b2=e2.body||{};
if(r2?.outcome?.state!=="ACHIEVED"||e2.effectSent!==false||b2.name!==EXPECTED) throw new Error("post-negative target changed");
console.log("CF_TARGET_FINAL_POST_NEGATIVE=unchanged");
await client.close();
NODE
)"
printf '%s\n' "$node_out"

after_mutation_dispatches="$(python3 - "$DB" <<'PY'
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
[[ "$after_mutation_dispatches" == "$before_mutation_dispatches" ]] || { echo CF_TARGET_FINAL_NEGATIVE_DISPATCH_CHANGED >&2; exit 40; }
if [[ -d "$closed_budget_dir" ]]; then
  after_closed_res="$(find "$closed_budget_dir" -maxdepth 1 -type f -name '*.json' -print | wc -l | tr -d ' ')"
else
  after_closed_res=0
fi
[[ "$after_closed_res" == 0 ]] || { echo CF_TARGET_FINAL_CLOSED_BUDGET_AFTER="$after_closed_res" >&2; exit 41; }
echo CF_TARGET_FINAL_NEGATIVE_NO_DISPATCH=pass
echo CF_TARGET_FINAL_CLOSED_BUDGET_RESERVATIONS=0

ponr2="$("$ROLLBACK_GUARD" decide --db "$DB" --control "$CONTROL" --quarantine "$QUARANTINE")"
printf '%s\n' "$ponr2" | grep -Fxq 'CF_A4_PONR_COUNT=4'
printf '%s\n' "$ponr2" | grep -Fxq 'CF_A4_UNRESOLVED_BLOCKING=0'
printf '%s\n' "$ponr2" | grep -Fxq 'CF_A4_ZERO_UNRESOLVED=pass'
echo CF_TARGET_FINAL_SAFETY_POST=pass

systemctl start "$TIMER"
systemctl is-active --quiet "$TIMER"
docker start "$GATEWAY" >/dev/null
[[ "$(docker inspect -f '{{.State.Running}}' "$GATEWAY")" == true ]]
[[ ! -e "$GATE" ]]
finalized=yes
window_open=no
trap - EXIT
echo CF_TARGET_FINAL_RELEASE_GATE=clear
echo CF_TARGET_FINAL_PULL_TIMER=active
echo CF_TARGET_FINAL_GATEWAY=running
echo CF_TARGET_FINAL=pass
