#!/usr/bin/env bash
set -euo pipefail
umask 077
[[ "$(id -u)" -eq 0 ]] || exit 2

ACTIVE=/opt/capability-fabric/current
STATE=/var/lib/capability-fabric/state
CONTROL=/var/lib/capability-fabric/onshape/runtime-control/ONSHAPE_RUNTIME_CONTROL.json
MIRROR_BLOB=/var/lib/capability-fabric/onshape/runtime-control/git-blob-sha
GATE="$STATE/release-in-progress"
LOCK=/run/lock/capability-fabric-pull.lock
TIMER=capability-fabric-pull.timer
GATEWAY=capability-fabric-onshape-gateway
SERVER=capability-fabric-onshape-server
DB=/var/lib/capability-fabric/onshape/fabric-state/execution.sqlite3
QUARANTINE=/var/lib/capability-fabric/onshape/fabric-state/quarantine/D-018-attempt-f6d80f46.json
ROLLBACK_GUARD=/usr/local/libexec/capability-fabric-onshape-rollback-contract
EXPECTED_CONTROL=7c03d59b613a7c91249f4c56efd045e1ed13a8dc
DID=6efc214ada1e9b6924774296
WID=016101547d28c3b18e0156d2
EID=47bda9eeb9d5fbaeffe5df73
MATE_FID=FHTzF0N7ggWpsS6_5
TEMPLATE_FID=F3SXsDSwe9zdg32_132

[[ "$(basename "$(readlink -f "$ACTIVE")")" == "onshape-vps-hardened-production-r8" ]] || exit 20
[[ "$(git hash-object "$CONTROL")" == "$EXPECTED_CONTROL" ]] || exit 20
[[ "$(tr -d '\r\n' < "$MIRROR_BLOB")" == "$EXPECTED_CONTROL" ]] || exit 20
[[ -f "$GATE" ]] && grep -Fxq RELEASE_IN_PROGRESS "$GATE"
if systemctl is-active --quiet "$TIMER"; then exit 20; fi
[[ "$(docker inspect -f '{{.State.Running}}' "$GATEWAY")" == false ]] || exit 20
[[ "$(docker inspect -f '{{.State.Running}}' "$SERVER")" == true ]] || exit 20

python3 - "$CONTROL" "$DID" <<'PY'
import json,sys
x=json.load(open(sys.argv[1])); did=sys.argv[2]; a=x["authority"]; g=a["productionGuard"]; v=a["planes"]["vps-fabric"]
assert x["controlRevision"]==555 and a["productionEpoch"]==26
assert a["mode"]=="VPS_PRODUCTION" and a["materialAuthority"]=="vps-fabric"
assert v["releaseSequence"]==73 and v["releaseId"]=="onshape-vps-hardened-production-r8"
assert a["reconciliationHold"]["active"] is False and x["lease"]["state"]=="FREE"
assert g["generation"]==10 and g["killSwitch"]=="OPEN"
assert g["allowedDocumentIds"]==[did]
assert g["mutationBudget"]=={"budgetId":"e9-mate-durability-r8-20260926","maxMutations":4}
print("CF_E9_MATE_SLICE_GUARD=copy-only-budget4")
PY

ponr="$("$ROLLBACK_GUARD" decide --db "$DB" --control "$CONTROL" --quarantine "$QUARANTINE")"
printf '%s\n' "$ponr" | grep -Fxq 'CF_A4_UNRESOLVED_BLOCKING=0'
printf '%s\n' "$ponr" | grep -Fxq 'CF_A4_ZERO_UNRESOLVED=pass'

exec 9>"$LOCK"
flock -w 30 9 || exit 21
restore_gate=yes
cleanup(){
 rc=$?
 set +e
 if [[ "$restore_gate" == yes && ! -e "$GATE" ]]; then
   tmp="$GATE.tmp.e9mateslice.$$"; printf '%s\n' RELEASE_IN_PROGRESS >"$tmp"; chmod 600 "$tmp"; chown root:root "$tmp"; mv "$tmp" "$GATE"
 fi
 systemctl stop "$TIMER" >/dev/null 2>&1 || true
 docker stop "$GATEWAY" >/dev/null 2>&1 || true
 exit "$rc"
}
trap cleanup EXIT

rm -f "$GATE"
echo CF_E9_MATE_SLICE_LOCAL_WINDOW=open

docker exec -e CF_DID="$DID" -e CF_WID="$WID" -e CF_EID="$EID" -e CF_MATE_FID="$MATE_FID" -e CF_TEMPLATE_FID="$TEMPLATE_FID" -i "$SERVER" sh -lc 'cd /tmp/app && node --input-type=module' <<'NODE'
import fs from "node:fs";
import {Client} from "@modelcontextprotocol/sdk/client/index.js";
import {StreamableHTTPClientTransport} from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const DID=process.env.CF_DID,WID=process.env.CF_WID,EID=process.env.CF_EID;
const MATE=process.env.CF_MATE_FID,TEMPLATE=process.env.CF_TEMPLATE_FID;
const NAME="CF E9 Mate Dependent";
const token=fs.readFileSync("/run/secrets/mcp-token","utf8").trim();
const c=new Client({name:"cf-e9-mate-durability",version:"1.0.0"});
await c.connect(new StreamableHTTPClientTransport(new URL("http://127.0.0.1:8788/mcp/"+token)));
const parse=res=>{
 const raw=(res?.content||[]).filter(x=>x.type==="text").map(x=>x.text||"").join("\n");
 if(!raw) throw new Error("empty tool response");
 return JSON.parse(raw);
};
const invoke=async(operationId,args={})=>parse(await c.callTool({name:"onshape_fabric_invoke",arguments:{
 capability_id:"onshape.documented.operation",arguments:{operationId,...args}
}}));
const ev=(w,label,effect=false)=>{
 const r=w?.result,e=r?.observation?.evidence||{};
 if(r?.outcome?.state!=="ACHIEVED") throw new Error(label+" outcome "+String(r?.outcome?.state)+" "+JSON.stringify(w));
 if(e.httpStatus!==200 || e.effectSent!==effect) throw new Error(label+" transport/effect");
 if(e.apiVersion!=="v17"||e.observedApiVersion!=="v17"||e.apiVersionMatched!==true) throw new Error(label+" version");
 if(effect && e.postconditionVerified!==true) throw new Error(label+" postcondition");
 return e;
};
function sanitize(v){
 if(Array.isArray(v)) return v.map(sanitize);
 if(v && typeof v==="object"){
  const out={};
  const hasQuery=typeof v.queryString==="string" && v.queryString.trim().length>0;
  for(const [k,val] of Object.entries(v)){
   if(k==="nodeId") continue;
   if(k==="suppressionState" && val==null) continue;
   if(k==="queryStatement" && val==null) continue;
   if(hasQuery && (k==="deterministicIds"||k==="geometryIds")) continue;
   out[k]=sanitize(val);
  }
  return out;
 }
 return v;
}
async function featureList(){
 const w=await invoke("getPartStudioFeatures",{pathParams:{did:DID,wvm:"w",wvmid:WID,eid:EID},query:{}});
 const e=ev(w,"featureList",false),b=e.body||{};
 return {body:b,features:b.features||[],micro:String(b.sourceMicroversion||"")};
}
function statusMap(b){
 const out={};
 for(const f of b.features||[]) out[f.featureId]=b?.featureStates?.[f.featureId]?.featureStatus||f.featureStatus||null;
 return out;
}
function requireNoNewError(base,now,label){
 for(const [fid,s] of Object.entries(base)){
  if(s==="OK" && now[fid] && now[fid]!=="OK") throw new Error(label+" regression "+fid+" "+s+"->"+now[fid]);
 }
}
function checkDependent(b,fid,label){
 const f=(b.features||[]).find(x=>x.featureId===fid);
 if(!f) throw new Error(label+" dependent missing");
 const s=b?.featureStates?.[fid]?.featureStatus||f.featureStatus;
 if(s!=="OK") throw new Error(label+" dependent status "+s);
 const p=(f.parameters||[]).find(x=>x.parameterId==="baseConnector");
 const q=p?.queries?.[0];
 if(q?.btType!=="BTMIndividualCreatedByQuery-137"||q?.featureId!==MATE||q?.entityType!=="BODY"||q?.bodyType!=="MATE_CONNECTOR") throw new Error(label+" dependent selector drift");
 return f;
}
async function mateState(label){
 const q='qBodyType(qCreatedBy(makeId("'+MATE+'"), EntityType.BODY), BodyType.MATE_CONNECTOR)';
 const countW=await invoke("evalFeatureScript",{pathParams:{did:DID,wvm:"w",wvmid:WID,eid:EID},query:{},body:{script:'function(context is Context, queries) { return size(evaluateQuery(context, '+q+')); }'}});
 const ce=ev(countW,label+" count",false),cr=ce.body?.result;
 const count=Number(cr?.value);
 if(count!==1) throw new Error(label+" mate cardinality "+count);
 const frameW=await invoke("evalFeatureScript",{pathParams:{did:DID,wvm:"w",wvmid:WID,eid:EID},query:{},body:{script:"function(context is Context, queries) { return evMateConnector(context, {'mateConnector' : "+q+"}); }"}});
 const fe=ev(frameW,label+" frame",false),res=fe.body?.result;
 if(res?.btType!=="com.belmonttech.serialize.fsvalue.BTFSValueMap"||res?.typeTag!=="CoordSystem") throw new Error(label+" frame shape");
 const map={};
 for(const entry of res.value||[]) map[entry?.key?.value]=entry?.value;
 const origin=(map.origin?.value||[]).map(x=>Number(x?.value));
 const xAxis=(map.xAxis?.value||[]).map(x=>Number(x?.value));
 const zAxis=(map.zAxis?.value||[]).map(x=>Number(x?.value));
 if(origin.length!==3||origin.some(x=>!Number.isFinite(x))) throw new Error(label+" origin");
 console.log("CF_E9_MATE_"+label+"_COUNT=1");
 console.log("CF_E9_MATE_"+label+"_ORIGIN="+JSON.stringify(origin));
 return {origin,xAxis,zAxis,sourceMicroversion:String(fe.body?.sourceMicroversion||"")};
}
const dist=(a,b)=>Math.hypot(...a.map((x,i)=>x-b[i]));
const vdist=(a,b)=>Math.hypot(...a.map((x,i)=>x-b[i]));

const pool=parse(await c.callTool({name:"onshape_pool_status",arguments:{}}));
if(pool?.build_id!=="onshape-vps-hardened-r8"||pool?.pool_enabled!==true||pool?.size!==3||pool?.active_count!==0||pool?.queued_count!==0||pool?.document_lock_count!==0) throw new Error("pool");
for(const s of pool.sessions||[]) if(s?.auth?.state!=="PROVEN") throw new Error("auth "+s?.session_id);
console.log("CF_E9_MATE_POOL=3-of-3-PROVEN-idle");

const pre=await featureList();
if(!/^[0-9a-f]{24}$/i.test(pre.micro)) throw new Error("bad pre micro");
const baseStatuses=statusMap(pre.body);
const mate=pre.features.find(f=>f.featureId===MATE);
const template=pre.features.find(f=>f.featureId===TEMPLATE);
if(!mate||mate.featureType!=="mateConnector"||(pre.body?.featureStates?.[MATE]?.featureStatus||mate.featureStatus)!=="OK") throw new Error("mate baseline");
if(!template||template.featureType!=="transform"||(pre.body?.featureStates?.[TEMPLATE]?.featureStatus||template.featureStatus)!=="OK") throw new Error("transform template");
const tx=(mate.parameters||[]).find(p=>p.parameterId==="translationX");
if(String(tx?.expression||"")!=="20 mm") throw new Error("mate baseline translationX "+String(tx?.expression));
const preMate=await mateState("PRE");

const dep=sanitize(template);
delete dep.featureId;
dep.name=NAME;
const baseParam=(dep.parameters||[]).find(p=>p.parameterId==="baseConnector");
const sourceQuery=baseParam?.queries?.[0];
if(!sourceQuery||sourceQuery.btType!=="BTMIndividualCreatedByQuery-137") throw new Error("template base query");
const newQuery=structuredClone(sourceQuery);
newQuery.featureId=MATE;
newQuery.entityType="BODY";
newQuery.bodyType="MATE_CONNECTOR";
newQuery.queryString='query = qBodyType(qCreatedBy(id + "'+MATE+'", EntityType.BODY), BodyType.MATE_CONNECTOR);';
baseParam.queries=[newQuery];

const add=await invoke("addPartStudioFeature",{
 pathParams:{did:DID,wvm:"w",wvmid:WID,eid:EID},query:{},
 body:{feature:dep}
});
const ae=ev(add,"add dependent",true);
const depId=String(ae?.verification?.featureId||"");
if(!depId) throw new Error("added dependent id missing "+JSON.stringify(ae?.verification));
console.log("CF_E9_MATE_DEPENDENT_ID="+depId);
console.log("CF_E9_MATE_CREATE=ACHIEVED");

const afterAdd=await featureList();
checkDependent(afterAdd.body,depId,"after-add");
requireNoNewError(baseStatuses,statusMap(afterAdd.body),"after-add");
await mateState("AFTER_CREATE");

async function mutateMate(expr,label){
 const before=await featureList();
 const f0=before.features.find(f=>f.featureId===MATE);
 if(!f0) throw new Error(label+" mate missing");
 const f=sanitize(f0);
 const p=(f.parameters||[]).find(x=>x.parameterId==="translationX");
 if(!p) throw new Error(label+" translationX missing");
 p.expression=expr;
 const w=await invoke("updatePartStudioFeature",{
  pathParams:{did:DID,wid:WID,eid:EID,fid:MATE},
  query:{sourceMicroversion:before.micro,rejectMicroversionSkew:true},
  body:{feature:f}
 });
 const e=ev(w,label,true);
 console.log("CF_E9_MATE_"+label+"_MUTATION=ACHIEVED");
 console.log("CF_E9_MATE_"+label+"_PRE_MICROVERSION="+String(e.preMicroversion||""));
 console.log("CF_E9_MATE_"+label+"_POST_MICROVERSION="+String(e.postMicroversion||""));
}

await mutateMate("21 mm","FORWARD");
const mid=await featureList();
const midMateFeature=mid.features.find(f=>f.featureId===MATE);
if(String((midMateFeature?.parameters||[]).find(p=>p.parameterId==="translationX")?.expression||"")!=="21 mm") throw new Error("forward translation readback");
if((mid.body?.featureStates?.[MATE]?.featureStatus||midMateFeature?.featureStatus)!=="OK") throw new Error("forward mate status");
checkDependent(mid.body,depId,"mid");
requireNoNewError(baseStatuses,statusMap(mid.body),"mid");
const midMate=await mateState("MID");
const moved=dist(preMate.origin,midMate.origin);
if(Math.abs(moved-0.001)>1e-7) throw new Error("mate frame did not move 1mm: "+moved);
if(vdist(preMate.xAxis,midMate.xAxis)>1e-9||vdist(preMate.zAxis,midMate.zAxis)>1e-9) throw new Error("mate axes unexpectedly changed");
console.log("CF_E9_MATE_FRAME_DELTA_M="+moved);

await mutateMate("20 mm","RESTORE");
const post=await featureList();
const postMateFeature=post.features.find(f=>f.featureId===MATE);
if(String((postMateFeature?.parameters||[]).find(p=>p.parameterId==="translationX")?.expression||"")!=="20 mm") throw new Error("restore translation readback");
if((post.body?.featureStates?.[MATE]?.featureStatus||postMateFeature?.featureStatus)!=="OK") throw new Error("restore mate status");
checkDependent(post.body,depId,"post");
requireNoNewError(baseStatuses,statusMap(post.body),"post");
const postMate=await mateState("POST");
if(dist(preMate.origin,postMate.origin)>1e-9) throw new Error("mate origin not restored");
if(vdist(preMate.xAxis,postMate.xAxis)>1e-9||vdist(preMate.zAxis,postMate.zAxis)>1e-9) throw new Error("mate axes not restored");
console.log("CF_E9_MATE_FRAME_RESTORED=true");

const del=await invoke("deletePartStudioFeature",{
 pathParams:{did:DID,wid:WID,eid:EID,fid:depId},query:{}
});
ev(del,"delete dependent",true);
console.log("CF_E9_MATE_DELETE=ACHIEVED");
const fin=await featureList();
if(fin.features.some(f=>f.featureId===depId)) throw new Error("dependent cleanup failed");
const finMate=fin.features.find(f=>f.featureId===MATE);
if(String((finMate?.parameters||[]).find(p=>p.parameterId==="translationX")?.expression||"")!=="20 mm") throw new Error("final mate not baseline");
if((fin.body?.featureStates?.[MATE]?.featureStatus||finMate?.featureStatus)!=="OK") throw new Error("final mate status");
requireNoNewError(baseStatuses,statusMap(fin.body),"final");
const finalFrame=await mateState("FINAL");
if(dist(preMate.origin,finalFrame.origin)>1e-9) throw new Error("final frame not baseline");
console.log("CF_E9_MATE_DEPENDENT_CLEANED=true");
console.log("CF_E9_MATE_DURABILITY=pass");
await c.close();
NODE

tmp="$GATE.tmp.e9mateslice.$$"; printf '%s\n' RELEASE_IN_PROGRESS >"$tmp"; chmod 600 "$tmp"; chown root:root "$tmp"; mv "$tmp" "$GATE"
restore_gate=no
trap - EXIT
ponr2="$("$ROLLBACK_GUARD" decide --db "$DB" --control "$CONTROL" --quarantine "$QUARANTINE")"
printf '%s\n' "$ponr2" | grep -Fxq 'CF_A4_UNRESOLVED_BLOCKING=0'
printf '%s\n' "$ponr2" | grep -Fxq 'CF_A4_ZERO_UNRESOLVED=pass'
echo CF_E9_MATE_SLICE_RELEASE_GATE=active
echo CF_E9_MATE_SLICE_GATEWAY=stopped
echo CF_E9_MATE_SLICE=pass
