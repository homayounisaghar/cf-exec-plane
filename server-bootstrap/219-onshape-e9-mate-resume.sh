#!/usr/bin/env bash
set -euo pipefail
umask 077
[[ "$(id -u)" -eq 0 ]] || exit 2
CONTROL=/var/lib/capability-fabric/onshape/runtime-control/ONSHAPE_RUNTIME_CONTROL.json
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
EXPECTED_CONTROL=7c03d59b613a7c91249f4c56efd045e1ed13a8dc
DID=6efc214ada1e9b6924774296
WID=016101547d28c3b18e0156d2
EID=47bda9eeb9d5fbaeffe5df73
MATE=FHTzF0N7ggWpsS6_5
DEP=FIiS3MVLezAoddv_348
BUDGET=e9-mate-durability-r8-20260926

[[ "$(git hash-object "$CONTROL")" == "$EXPECTED_CONTROL" ]] || exit 20
[[ -f "$GATE" ]] && grep -Fxq RELEASE_IN_PROGRESS "$GATE"
if systemctl is-active --quiet "$TIMER"; then exit 20; fi
[[ "$(docker inspect -f '{{.State.Running}}' "$GATEWAY")" == false ]]
[[ "$(docker inspect -f '{{.State.Running}}' "$SERVER")" == true ]]
python3 - "$CONTROL" "$DID" <<'PY'
import json,sys
x=json.load(open(sys.argv[1])); did=sys.argv[2]; a=x["authority"]; g=a["productionGuard"]
assert x["controlRevision"]==555 and a["productionEpoch"]==26
assert g["generation"]==10 and g["killSwitch"]=="OPEN"
assert g["allowedDocumentIds"]==[did]
assert g["mutationBudget"]=={"budgetId":"e9-mate-durability-r8-20260926","maxMutations":4}
assert x["lease"]["state"]=="FREE" and a["reconciliationHold"]["active"] is False
PY
python3 - "$AGENT_DIR" "$BUDGET" <<'PY'
import json,pathlib,sys
root=pathlib.Path(sys.argv[1]); budget=sys.argv[2]; rows=[]
for p in root.rglob("*.json"):
 try:v=json.loads(p.read_text())
 except:continue
 if isinstance(v,dict) and v.get("budgetId")==budget: rows.append(v)
assert len(rows)==1 and int(rows[0]["slot"])==1,rows
print("CF_E9_MATE_RESUME_PRE_BUDGET=slot1-create-achieved")
PY
ponr="$("$ROLLBACK_GUARD" decide --db "$DB" --control "$CONTROL" --quarantine "$QUARANTINE")"
printf '%s\n' "$ponr" | grep -Fxq 'CF_A4_UNRESOLVED_BLOCKING=0'
printf '%s\n' "$ponr" | grep -Fxq 'CF_A4_ZERO_UNRESOLVED=pass'

exec 9>"$LOCK"
flock -w 30 9 || exit 21
restore=yes
cleanup(){ rc=$?; set +e; if [[ "$restore" == yes && ! -e "$GATE" ]]; then
 tmp="$GATE.tmp.e9materesume.$$"; printf '%s\n' RELEASE_IN_PROGRESS >"$tmp"; chmod 600 "$tmp"; chown root:root "$tmp"; mv "$tmp" "$GATE"; fi
 systemctl stop "$TIMER" >/dev/null 2>&1 || true
 docker stop "$GATEWAY" >/dev/null 2>&1 || true
 exit "$rc"; }
trap cleanup EXIT
rm -f "$GATE"

docker exec -e CF_DID="$DID" -e CF_WID="$WID" -e CF_EID="$EID" -e CF_MATE="$MATE" -e CF_DEP="$DEP" -i "$SERVER" sh -lc 'cd /tmp/app && node --input-type=module' <<'NODE'
import fs from "node:fs";
import {Client} from "@modelcontextprotocol/sdk/client/index.js";
import {StreamableHTTPClientTransport} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
const DID=process.env.CF_DID,WID=process.env.CF_WID,EID=process.env.CF_EID,MATE=process.env.CF_MATE,DEP=process.env.CF_DEP;
const token=fs.readFileSync("/run/secrets/mcp-token","utf8").trim();
const c=new Client({name:"cf-e9-mate-resume",version:"1.0.0"});
await c.connect(new StreamableHTTPClientTransport(new URL("http://127.0.0.1:8788/mcp/"+token)));
const parse=res=>JSON.parse((res?.content||[]).filter(x=>x.type==="text").map(x=>x.text||"").join("\n"));
const invoke=async(operationId,args={})=>parse(await c.callTool({name:"onshape_fabric_invoke",arguments:{capability_id:"onshape.documented.operation",arguments:{operationId,...args}}},undefined,{timeout:180000}));
const check=(w,label,effect)=>{
 const r=w?.result,e=r?.observation?.evidence||{};
 if(r?.outcome?.state!=="ACHIEVED") throw new Error(label+" outcome "+String(r?.outcome?.state)+" "+JSON.stringify(w));
 if(e.httpStatus!==200||e.effectSent!==effect) throw new Error(label+" transport");
 if(e.apiVersion!=="v17"||e.observedApiVersion!=="v17"||e.apiVersionMatched!==true) throw new Error(label+" version");
 if(effect&&e.postconditionVerified!==true) throw new Error(label+" postcondition");
 return e;
};
function sanitize(v){
 if(Array.isArray(v)) return v.map(sanitize);
 if(v&&typeof v==="object"){
  const o={},hq=typeof v.queryString==="string"&&v.queryString.trim();
  for(const [k,x] of Object.entries(v)){
   if(k==="nodeId"||(k==="suppressionState"&&x==null)||(k==="queryStatement"&&x==null)) continue;
   if(hq&&(k==="deterministicIds"||k==="geometryIds")) continue;
   o[k]=sanitize(x);
  }
  return o;
 }
 return v;
}
async function fl(){
 const w=await invoke("getPartStudioFeatures",{pathParams:{did:DID,wvm:"w",wvmid:WID,eid:EID},query:{}});
 const e=check(w,"feature list",false),b=e.body||{};
 return {b,features:b.features||[],micro:String(b.sourceMicroversion||"")};
}
function fstatus(b,id){
 const f=(b.features||[]).find(x=>x.featureId===id);
 return {f,s:b?.featureStates?.[id]?.featureStatus||f?.featureStatus||null};
}
function depCheck(b,label){
 const {f,s}=fstatus(b,DEP);
 if(!f||s!=="OK") throw new Error(label+" dep "+s);
 const q=(f.parameters||[]).find(p=>p.parameterId==="baseConnector")?.queries?.[0];
 if(q?.btType!=="BTMIndividualCreatedByQuery-137"||q?.featureId!==MATE||q?.entityType!=="BODY"||q?.bodyType!=="MATE_CONNECTOR") throw new Error(label+" selector");
}
async function frame(label){
 const q='qBodyType(qCreatedBy(makeId("'+MATE+'"), EntityType.BODY), BodyType.MATE_CONNECTOR)';
 const cw=await invoke("evalFeatureScript",{pathParams:{did:DID,wvm:"w",wvmid:WID,eid:EID},query:{},body:{script:'function(context is Context, queries) { return size(evaluateQuery(context, '+q+')); }'}});
 const ce=check(cw,label+" count",false),count=Number(ce.body?.result?.value);
 if(count!==1) throw new Error(label+" count "+count);
 const fw=await invoke("evalFeatureScript",{pathParams:{did:DID,wvm:"w",wvmid:WID,eid:EID},query:{},body:{script:"function(context is Context, queries) { return evMateConnector(context, {'mateConnector' : "+q+"}); }"}});
 const fe=check(fw,label+" frame",false),res=fe.body?.result,map={};
 for(const ent of res?.value||[]) map[ent?.key?.value]=ent?.value;
 const origin=(map.origin?.value||[]).map(x=>Number(x?.value));
 const xAxis=(map.xAxis?.value||[]).map(x=>Number(x?.value));
 const zAxis=(map.zAxis?.value||[]).map(x=>Number(x?.value));
 if(origin.length!==3||origin.some(x=>!Number.isFinite(x))) throw new Error(label+" frame");
 console.log("CF_E9_MATE_RESUME_"+label+"_COUNT=1");
 console.log("CF_E9_MATE_RESUME_"+label+"_ORIGIN="+JSON.stringify(origin));
 return {origin,xAxis,zAxis};
}
const dist=(a,b)=>Math.hypot(...a.map((x,i)=>x-b[i]));
const pool=parse(await c.callTool({name:"onshape_pool_status",arguments:{}}));
if(pool?.build_id!=="onshape-vps-hardened-r8"||pool?.pool_enabled!==true||pool?.size!==3||pool?.active_count!==0||pool?.queued_count!==0||pool?.document_lock_count!==0) throw new Error("pool");
for(const s of pool.sessions||[]) if(s?.auth?.state!=="PROVEN") throw new Error("auth");
console.log("CF_E9_MATE_RESUME_POOL=3-of-3-PROVEN-idle");

const pre=await fl();
depCheck(pre.b,"pre");
const {f:mf,s:ms}=fstatus(pre.b,MATE);
if(!mf||ms!=="OK") throw new Error("mate baseline");
const tx0=(mf.parameters||[]).find(p=>p.parameterId==="translationX");
if(String(tx0?.expression)!=="20 mm") throw new Error("baseline tx");
const baseFrame=await frame("PRE");
console.log("CF_E9_MATE_RESUME_DEPENDENT=OK");

async function mutate(expr,label){
 const cur=await fl(), {f}=fstatus(cur.b,MATE);
 const next=sanitize(f),p=(next.parameters||[]).find(x=>x.parameterId==="translationX");
 p.expression=expr;
 const w=await invoke("updatePartStudioFeature",{pathParams:{did:DID,wid:WID,eid:EID,fid:MATE},query:{sourceMicroversion:cur.micro,rejectMicroversionSkew:true},body:{feature:next}});
 const e=check(w,label,true);
 console.log("CF_E9_MATE_RESUME_"+label+"=ACHIEVED");
 console.log("CF_E9_MATE_RESUME_"+label+"_ATTEMPT="+String(w?.result?.attemptId||""));
 return e;
}

await mutate("21 mm","FORWARD");
const mid=await fl();
depCheck(mid.b,"mid");
const {f:midMate,s:midStatus}=fstatus(mid.b,MATE);
if(midStatus!=="OK"||String((midMate.parameters||[]).find(p=>p.parameterId==="translationX")?.expression)!=="21 mm") throw new Error("mid readback");
const midFrame=await frame("MID");
const delta=dist(baseFrame.origin,midFrame.origin);
if(Math.abs(delta-0.001)>1e-7) throw new Error("frame delta "+delta);
if(dist(baseFrame.xAxis,midFrame.xAxis)>1e-9||dist(baseFrame.zAxis,midFrame.zAxis)>1e-9) throw new Error("axes changed");
console.log("CF_E9_MATE_RESUME_FRAME_DELTA_M="+delta);

await mutate("20 mm","RESTORE");
const restored=await fl();
depCheck(restored.b,"restored");
const {f:rm,s:rs}=fstatus(restored.b,MATE);
if(rs!=="OK"||String((rm.parameters||[]).find(p=>p.parameterId==="translationX")?.expression)!=="20 mm") throw new Error("restore readback");
const restoredFrame=await frame("RESTORED");
if(dist(baseFrame.origin,restoredFrame.origin)>1e-9) throw new Error("origin not restored");
if(dist(baseFrame.xAxis,restoredFrame.xAxis)>1e-9||dist(baseFrame.zAxis,restoredFrame.zAxis)>1e-9) throw new Error("axes not restored");
console.log("CF_E9_MATE_RESUME_FRAME_RESTORED=true");

const dw=await invoke("deletePartStudioFeature",{pathParams:{did:DID,wid:WID,eid:EID,fid:DEP},query:{}});
check(dw,"delete",true);
console.log("CF_E9_MATE_RESUME_DELETE=ACHIEVED");
const fin=await fl();
if(fin.features.some(f=>f.featureId===DEP)) throw new Error("dep remains");
const {f:fm,s:fs}=fstatus(fin.b,MATE);
if(fs!=="OK"||String((fm.parameters||[]).find(p=>p.parameterId==="translationX")?.expression)!=="20 mm") throw new Error("final mate baseline");
const finalFrame=await frame("FINAL");
if(dist(baseFrame.origin,finalFrame.origin)>1e-9) throw new Error("final frame");
console.log("CF_E9_MATE_RESUME_DEPENDENT_CLEANED=true");
console.log("CF_E9_MATE_DURABILITY=pass");
await c.close();
NODE

tmp="$GATE.tmp.e9materesume.$$"; printf '%s\n' RELEASE_IN_PROGRESS >"$tmp"; chmod 600 "$tmp"; chown root:root "$tmp"; mv "$tmp" "$GATE"
restore=no
trap - EXIT
python3 - "$AGENT_DIR" "$BUDGET" <<'PY'
import json,pathlib,sys
root=pathlib.Path(sys.argv[1]); budget=sys.argv[2]; rows=[]
for p in root.rglob("*.json"):
 try:v=json.loads(p.read_text())
 except:continue
 if isinstance(v,dict) and v.get("budgetId")==budget: rows.append(v)
slots=sorted(int(x["slot"]) for x in rows)
assert slots==[1,2,3,4],slots
print("CF_E9_MATE_RESUME_BUDGET_SLOTS=1,2,3,4")
PY
ponr2="$("$ROLLBACK_GUARD" decide --db "$DB" --control "$CONTROL" --quarantine "$QUARANTINE")"
printf '%s\n' "$ponr2" | grep -Fxq 'CF_A4_UNRESOLVED_BLOCKING=0'
printf '%s\n' "$ponr2" | grep -Fxq 'CF_A4_ZERO_UNRESOLVED=pass'
echo CF_E9_MATE_RESUME_GATE=active
echo CF_E9_MATE_RESUME=pass
