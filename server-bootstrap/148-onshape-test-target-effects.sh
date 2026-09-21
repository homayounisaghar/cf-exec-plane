#!/usr/bin/env bash
set -euo pipefail
umask 077
[[ "$(id -u)" -eq 0 ]] || exit 2

ACTIVE=/opt/capability-fabric/current
CONTROL=/var/lib/capability-fabric/onshape/runtime-control/ONSHAPE_RUNTIME_CONTROL.json
MIRROR_BLOB=/var/lib/capability-fabric/onshape/runtime-control/git-blob-sha
STATE=/var/lib/capability-fabric/state
GATE="$STATE/release-in-progress"
LOCK=/run/lock/capability-fabric-pull.lock
TIMER=capability-fabric-pull.timer
GATEWAY=capability-fabric-onshape-gateway
SERVER=capability-fabric-onshape-server
DB=/var/lib/capability-fabric/onshape/fabric-state/execution.sqlite3
AGENT_DIR=/var/lib/capability-fabric/onshape/fabric-agent
QUARANTINE=/var/lib/capability-fabric/onshape/fabric-state/quarantine/D-018-attempt-f6d80f46.json
ROLLBACK_GUARD=/usr/local/libexec/capability-fabric-onshape-rollback-contract

expected_blob=56fa3abbcfffaa7451f32a0707a569f865ab49bb
expected_manifest=f2631a7f94ec5f6e5af5e9d3b3211cf440354eef0b55ff6fee7ab65cec50bfb9
did=881affea8ea63c33ae4e6c78
wid=7b1e64a5ce7f95e660a9a5f2
budget_id=epoch6-test-881affea-budget2
budget_key="$(printf '%s' "2:$budget_id" | sha256sum | awk '{print $1}')"
budget_dir="$AGENT_DIR/mutation-budgets/$budget_key"

[[ -L "$ACTIVE" && "$(readlink -f "$ACTIVE")" == /var/lib/capability-fabric/releases/onshape-vps-hardened-production-r4 ]]
[[ "$(sha256sum "$(readlink -f "$ACTIVE")/manifest.json" | awk '{print $1}')" == "$expected_manifest" ]]
[[ "$(git hash-object "$CONTROL")" == "$expected_blob" ]]
[[ "$(tr -d '\r\n' < "$MIRROR_BLOB")" == "$expected_blob" ]]
[[ -f "$GATE" ]]
grep -Fxq RELEASE_IN_PROGRESS "$GATE"
if systemctl is-active --quiet "$TIMER"; then exit 20; fi
[[ "$(docker inspect -f '{{.State.Running}}' "$GATEWAY")" == false ]]
[[ "$(docker inspect -f '{{.State.Running}}' "$SERVER")" == true ]]

python3 - "$CONTROL" <<'PY'
import json,sys
x=json.load(open(sys.argv[1])); a=x["authority"]; g=a["productionGuard"]; v=a["planes"]["vps-fabric"]
assert x["controlRevision"]==535
assert a["productionEpoch"]==6 and a["mode"]=="VPS_PRODUCTION" and a["materialAuthority"]=="vps-fabric"
assert a["planes"]["android-v1"]["ingress"]=="CLOSED" and a["planes"]["android-v1"]["materialEffectsAllowed"] is False
assert v["ingress"]=="ADMITTED" and v["materialEffectsAllowed"] is True and v["releaseSequence"]==67
assert x["lease"]["state"]=="FREE"
assert g["generation"]==2 and g["killSwitch"]=="OPEN"
assert g["allowedDocumentIds"]==["881affea8ea63c33ae4e6c78"]
assert g["mutationBudget"]=={"budgetId":"epoch6-test-881affea-budget2","maxMutations":2}
print("CF_TARGET_EFFECTS_AUTHORITY=rev535-epoch6")
print("CF_TARGET_EFFECTS_GUARD=open-one-target-budget2")
PY

if [[ -d "$budget_dir" ]]; then
  before_reservations="$(find "$budget_dir" -maxdepth 1 -type f -name '*.json' -print | wc -l | tr -d ' ')"
else
  before_reservations=0
fi
[[ "$before_reservations" == 0 ]]
echo CF_TARGET_EFFECTS_BUDGET_BEFORE=0

python3 - "$DB" <<'PY'
import sqlite3,sys
c=sqlite3.connect(f"file:{sys.argv[1]}?mode=ro",uri=True)
row=c.execute("select phase, dispatch_payload from invocations where invocation_id=?",("invocation:35ec39ba-89c2-4807-b289-de54c1300823",)).fetchone()
assert row is not None and row[0]=="ROUTED" and row[1] is None
print("CF_TARGET_EFFECTS_ALLOWLIST_PROOF=ROUTED_NO_DISPATCH")
c.close()
PY

exec 9>"$LOCK"
flock -w 30 9 || exit 22
echo CF_TARGET_EFFECTS_PULL_LOCK=held

window_open=no
cleanup(){
  rc=$?
  set +e
  if [[ "$window_open" == yes ]]; then
    tmp="$GATE.tmp.$$"
    printf '%s\n' RELEASE_IN_PROGRESS >"$tmp"
    chmod 0600 "$tmp"
    chown root:root "$tmp"
    mv -f "$tmp" "$GATE"
  fi
  docker stop "$GATEWAY" >/dev/null 2>&1 || true
  systemctl stop "$TIMER" >/dev/null 2>&1 || true
  exit "$rc"
}
trap cleanup EXIT

rm -f "$GATE"
window_open=yes
[[ ! -e "$GATE" ]]
[[ "$(docker inspect -f '{{.State.Running}}' "$GATEWAY")" == false ]]
if systemctl is-active --quiet "$TIMER"; then exit 23; fi
echo CF_TARGET_EFFECTS_LOCAL_WINDOW=open

node_out="$(docker exec -i "$SERVER" sh -lc 'cd /tmp/app && node --input-type=module' <<'NODE'
import fs from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
const DID="881affea8ea63c33ae4e6c78";
const WID="7b1e64a5ce7f95e660a9a5f2";
const NAME1="CF-R4-TARGET-TEST-A";
const NAME2="CF-R4-TARGET-TEST-B";
const NAME3="CF-R4-TARGET-TEST-C-MUST-NOT-APPLY";
const token=fs.readFileSync("/run/secrets/mcp-token","utf8").trim();
const client=new Client({name:"cf-r4-target-effects",version:"1.0.0"});
const transport=new StreamableHTTPClientTransport(new URL("http://127.0.0.1:8788/mcp/"+token));
await client.connect(transport);
const parse=(res)=>{
  const raw=(res?.content||[]).filter(x=>x.type==="text").map(x=>x.text||"").join("\n");
  if(!raw) return null;
  try{return JSON.parse(raw);}catch{return {raw};}
};
const call=async(args)=>client.callTool({name:"onshape_fabric_invoke",arguments:{capability_id:"onshape.documented.operation",arguments:args}});
const pool=parse(await client.callTool({name:"onshape_pool_status",arguments:{}}));
if(pool.pool_enabled!==true||pool.size!==3||pool.active_count!==0||pool.queued_count!==0||pool.document_lock_count!==0) throw new Error("pool not idle");
if(pool.material_mutator_session_id!=="session-1") throw new Error("wrong mutator");
for(const s of pool.sessions||[]) if(s?.auth?.state!=="PROVEN") throw new Error("session not proven");
console.log("CF_TARGET_EFFECTS_POOL=3-of-3-PROVEN-idle");

const read0=parse(await call({operationId:"getDocument",pathParams:{did:DID},query:{}}));
const r0=read0?.result,e0=r0?.observation?.evidence||{},b0=e0.body||{};
if(r0?.outcome?.state!=="ACHIEVED"||e0.effectSent!==false||b0.id!==DID||b0.name!=="Backup test"||b0?.defaultWorkspace?.id!==WID) throw new Error("baseline mismatch");
console.log("CF_TARGET_EFFECTS_BASELINE=Backup test");

const m1=parse(await call({
  operationId:"updateDocumentAttributes",pathParams:{did:DID},query:{},
  body:{name:NAME1},verification:{kind:"document_name_equals",value:NAME1}
}));
const a1=m1?.result,e1=a1?.observation?.evidence||{};
if(a1?.outcome?.state!=="ACHIEVED"||e1.effectSent!==true||e1.postconditionVerified!==true||e1.body?.name!==NAME1) throw new Error("mutation1 failed: "+JSON.stringify(m1));
console.log("CF_TARGET_EFFECTS_M1=ACHIEVED");
console.log("CF_TARGET_EFFECTS_M1_INVOCATION="+a1.invocationId);
console.log("CF_TARGET_EFFECTS_M1_OPERATION="+a1.operationId);
console.log("CF_TARGET_EFFECTS_M1_ATTEMPT="+a1.attemptId);
console.log("CF_TARGET_EFFECTS_M1_SESSION="+e1.mutationSessionId);

const m2=parse(await call({
  operationId:"updateDocumentAttributes",pathParams:{did:DID},query:{},
  body:{name:NAME2},verification:{kind:"document_name_equals",value:NAME2}
}));
const a2=m2?.result,e2=a2?.observation?.evidence||{};
if(a2?.outcome?.state!=="ACHIEVED"||e2.effectSent!==true||e2.postconditionVerified!==true||e2.body?.name!==NAME2) throw new Error("mutation2 failed: "+JSON.stringify(m2));
console.log("CF_TARGET_EFFECTS_M2=ACHIEVED");
console.log("CF_TARGET_EFFECTS_M2_INVOCATION="+a2.invocationId);
console.log("CF_TARGET_EFFECTS_M2_OPERATION="+a2.operationId);
console.log("CF_TARGET_EFFECTS_M2_ATTEMPT="+a2.attemptId);
console.log("CF_TARGET_EFFECTS_M2_SESSION="+e2.mutationSessionId);

let budgetRejected=false;
const m3raw=await call({
  operationId:"updateDocumentAttributes",pathParams:{did:DID},query:{},
  body:{name:NAME3},verification:{kind:"document_name_equals",value:NAME3}
});
const m3=parse(m3raw);
const m3text=JSON.stringify(m3||{});
if(m3?.status==="FAILED" && /budget|FABRIC_GUARD_BUDGET_EXHAUSTED/i.test(m3text)) budgetRejected=true;
if(m3?.result?.outcome?.state==="ACHIEVED"||m3?.result?.observation?.evidence?.effectSent===true) throw new Error("budget-exhausted mutation achieved");
if(!budgetRejected) throw new Error("budget exhaustion not conclusively rejected: "+m3text);
console.log("CF_TARGET_EFFECTS_M3=budget-exhausted-rejected");
console.log("CF_TARGET_EFFECTS_M3_ERROR="+JSON.stringify(m3.error||{}));

const final=parse(await call({operationId:"getDocument",pathParams:{did:DID},query:{}}));
const rf=final?.result,ef=rf?.observation?.evidence||{},bf=ef.body||{};
if(rf?.outcome?.state!=="ACHIEVED"||ef.effectSent!==false||bf.name!==NAME2) throw new Error("final document state wrong");
console.log("CF_TARGET_EFFECTS_FINAL_NAME="+bf.name);
console.log("CF_TARGET_EFFECTS_FINAL_READ_EFFECT_SENT=false");
await client.close();
NODE
)"
printf '%s\n' "$node_out"

m1_attempt="$(printf '%s\n' "$node_out" | awk -F= '$1=="CF_TARGET_EFFECTS_M1_ATTEMPT"{print $2}' | tail -n1)"
m2_attempt="$(printf '%s\n' "$node_out" | awk -F= '$1=="CF_TARGET_EFFECTS_M2_ATTEMPT"{print $2}' | tail -n1)"
[[ "$m1_attempt" == attempt:* && "$m2_attempt" == attempt:* && "$m1_attempt" != "$m2_attempt" ]]

tmp="$GATE.tmp.$$"
printf '%s\n' RELEASE_IN_PROGRESS >"$tmp"
chmod 0600 "$tmp"
chown root:root "$tmp"
mv -f "$tmp" "$GATE"
window_open=no
echo CF_TARGET_EFFECTS_LOCAL_WINDOW=closed

after_reservations="$(find "$budget_dir" -maxdepth 1 -type f -name '*.json' -print | wc -l | tr -d ' ')"
[[ "$after_reservations" == 2 ]]

python3 - "$budget_dir" "$m1_attempt" "$m2_attempt" "$expected_blob" <<'PY'
import json,pathlib,sys
root=pathlib.Path(sys.argv[1]); expected={sys.argv[2],sys.argv[3]}; blob=sys.argv[4]
rows=[json.loads(p.read_text()) for p in root.glob("*.json")]
assert len(rows)==2
for x in rows:
    assert x["schema"]=="capability-fabric.onshape-mutation-budget-reservation.v1"
    assert x["budgetId"]=="epoch6-test-881affea-budget2"
    assert x["guardGeneration"]==2 and x["maxMutations"]==2
    assert x["documentId"]=="881affea8ea63c33ae4e6c78"
    assert x["productionEpoch"]==6 and x["controlBlobSha"]==blob
assert {x["slot"] for x in rows}=={1,2}
assert {x["attemptId"] for x in rows}==expected
print("CF_TARGET_EFFECTS_BUDGET_RESERVATIONS=2")
print("CF_TARGET_EFFECTS_BUDGET_SLOTS=1,2")
print("CF_TARGET_EFFECTS_BUDGET_BINDING=pass")
PY

ponr="$("$ROLLBACK_GUARD" decide --db "$DB" --control "$CONTROL" --quarantine "$QUARANTINE")"
printf '%s\n' "$ponr"
printf '%s\n' "$ponr" | grep -Fxq 'CF_A4_UNRESOLVED_BLOCKING=0'
printf '%s\n' "$ponr" | grep -Fxq 'CF_A4_ZERO_UNRESOLVED=pass'
echo CF_TARGET_EFFECTS_SAFETY_POST=pass
[[ -f "$GATE" ]]
if systemctl is-active --quiet "$TIMER"; then exit 41; fi
[[ "$(docker inspect -f '{{.State.Running}}' "$GATEWAY")" == false ]]
echo CF_TARGET_EFFECTS_GATE=active
echo CF_TARGET_EFFECTS_TIMER=stopped
echo CF_TARGET_EFFECTS_GATEWAY=stopped
echo CF_TARGET_EFFECTS=pass
