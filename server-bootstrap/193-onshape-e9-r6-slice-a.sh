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

EXPECTED_CONTROL=6cb53be6a1ee38372b942421f78722853a3bb032
DID=8ca702971e2419cfa45cc87c
WID=8bbf262de8f6c2015d72fd7d
EID=dc6eb5c8b694395c14024558
FID=FwHDp7GXelUCXDl_0

[[ "$(basename "$(readlink -f "$ACTIVE")")" == "onshape-vps-hardened-production-r6" ]] || exit 20
[[ "$(git hash-object "$CONTROL")" == "$EXPECTED_CONTROL" ]] || exit 20
[[ "$(tr -d '\r\n' < "$MIRROR_BLOB")" == "$EXPECTED_CONTROL" ]] || exit 20
[[ -f "$GATE" ]] && grep -Fxq RELEASE_IN_PROGRESS "$GATE"
if systemctl is-active --quiet "$TIMER"; then exit 20; fi
[[ "$(docker inspect -f '{{.State.Running}}' "$GATEWAY")" == false ]] || exit 20
[[ "$(docker inspect -f '{{.State.Running}}' "$SERVER")" == true ]] || exit 20

python3 - "$CONTROL" "$DID" <<'PY'
import json,sys
x=json.load(open(sys.argv[1])); did=sys.argv[2]; a=x["authority"]; g=a["productionGuard"]; v=a["planes"]["vps-fabric"]
assert x["controlRevision"]==547 and a["productionEpoch"]==18
assert a["mode"]=="VPS_PRODUCTION" and a["materialAuthority"]=="vps-fabric"
assert v["releaseSequence"]==70 and v["releaseId"]=="onshape-vps-hardened-production-r5"
assert a["reconciliationHold"]["active"] is False
assert x["lease"]["state"]=="FREE"
assert g["generation"]==6 and g["killSwitch"]=="OPEN"
assert g["allowedDocumentIds"]==[did]
assert g["mutationBudget"]=={"budgetId":"e9-selector-durability-r6-slice-a-20260925","maxMutations":2}
print("CF_E9_R6_SLICE_GUARD=semantic-lab-only-budget2")
PY

ponr_pre="$("$ROLLBACK_GUARD" decide --db "$DB" --control "$CONTROL" --quarantine "$QUARANTINE")"
printf '%s\n' "$ponr_pre"
printf '%s\n' "$ponr_pre" | grep -Fxq 'CF_A4_UNRESOLVED_BLOCKING=0'
printf '%s\n' "$ponr_pre" | grep -Fxq 'CF_A4_ZERO_UNRESOLVED=pass'

exec 9>"$LOCK"
flock -w 30 9 || exit 21

restore_gate=yes
cleanup(){
  rc=$?
  set +e
  if [[ "$restore_gate" == yes && ! -e "$GATE" ]]; then
    tmp="$GATE.tmp.e9.$$"; printf '%s\n' RELEASE_IN_PROGRESS >"$tmp"; chmod 0600 "$tmp"; chown root:root "$tmp"; mv -f "$tmp" "$GATE"
  fi
  systemctl stop "$TIMER" >/dev/null 2>&1 || true
  docker stop "$GATEWAY" >/dev/null 2>&1 || true
  exit "$rc"
}
trap cleanup EXIT

rm -f "$GATE"
[[ ! -e "$GATE" ]]
echo CF_E9_R6_SLICE_LOCAL_WINDOW=open

docker exec -e CF_DID="$DID" -e CF_WID="$WID" -e CF_EID="$EID" -e CF_FID="$FID" -i "$SERVER" sh -lc 'cd /tmp/app && node --input-type=module' <<'NODE'
import fs from "node:fs";
import {Client} from "@modelcontextprotocol/sdk/client/index.js";
import {StreamableHTTPClientTransport} from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const DID=process.env.CF_DID,WID=process.env.CF_WID,EID=process.env.CF_EID,FID=process.env.CF_FID;
const token=fs.readFileSync("/run/secrets/mcp-token","utf8").trim();
const client=new Client({name:"cf-e9-slice-a",version:"1.0.0"});
await client.connect(new StreamableHTTPClientTransport(new URL("http://127.0.0.1:8788/mcp/"+token)));

const parse=res=>{
  const raw=(res?.content||[]).filter(x=>x.type==="text").map(x=>x.text||"").join("\n");
  if(!raw) throw new Error("empty tool response");
  return JSON.parse(raw);
};
const invoke=async(operationId,args={})=>parse(await client.callTool({name:"onshape_fabric_invoke",arguments:{
  capability_id:"onshape.documented.operation",
  arguments:{operationId,...args}
}}));

function evidence(wrap,label){
  const r=wrap?.result,e=r?.observation?.evidence||{};
  if(r?.outcome?.state!=="ACHIEVED") throw new Error(label+" outcome "+String(r?.outcome?.state));
  if(e.apiVersion!=="v17"||e.observedApiVersion!=="v17"||e.apiVersionMatched!==true) throw new Error(label+" version");
  return e;
}
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
  const e=evidence(w,"featureList");
  if(e.httpStatus!==200||e.effectSent!==false) throw new Error("featureList transport");
  const b=e.body||{}, features=b.features||[];
  const f=features.find(x=>x.featureId===FID);
  if(!f) throw new Error("Extrude 1 missing");
  return {body:b,feature:f,micro:String(b.sourceMicroversion||"")};
}
async function bodyDetails(){
  const w=await invoke("getPartStudioBodyDetails",{pathParams:{did:DID,wvm:"w",wvmid:WID,eid:EID},query:{}});
  const e=evidence(w,"bodyDetails");
  if(e.httpStatus!==200||e.effectSent!==false) throw new Error("bodyDetails transport");
  return e.body||{};
}
function partATopZ(details){
  const target=[0.021753765216512438,0.01565687540839336];
  let best=null;
  for(const body of details.bodies||[]){
    for(const edge of body.edges||[]){
      const c=edge?.curve;
      if(c?.type!=="CIRCLE"||!c.origin) continue;
      const d=Math.hypot(Number(c.origin.x)-target[0],Number(c.origin.y)-target[1]);
      if(best==null||d<best.d||(Math.abs(d-best.d)<1e-12&&Number(c.origin.z)>best.z)) best={d,z:Number(c.origin.z)};
    }
  }
  if(!best||best.d>1e-5) throw new Error("Part A circular edge not found");
  return best.z;
}
async function selectorCounts(label){
  const F=FID;
  const point='vector(0.021753765216512438 * meter, 0.01565687540839336 * meter, 0.01 * meter)';
  const bodies='qCreatedBy(makeId("'+F+'"), EntityType.BODY)';
  const part='qContainsPoint('+bodies+', '+point+')';
  const cap='qCapEntity(makeId("'+F+'"), CapType.END, EntityType.FACE)';
  const face='qIntersection(['+cap+', qOwnedByBody('+part+', EntityType.FACE)])';
  const edge='qAdjacent('+face+', AdjacencyType.EDGE, EntityType.EDGE)';
  const exprs={
    right:'qCreatedBy(makeId("Right"), EntityType.FACE)',
    createdByBody:bodies,
    part,face,edge
  };
  const out={};
  let micro=null;
  for(const [k,expr] of Object.entries(exprs)){
    const script='function(context is Context, queries) { return size(evaluateQuery(context, '+expr+')); }';
    const w=await invoke("evalFeatureScript",{pathParams:{did:DID,wvm:"w",wvmid:WID,eid:EID},query:{},body:{script}});
    const e=evidence(w,"selector "+k);
    if(e.httpStatus!==200||e.effectSent!==false) throw new Error("selector "+k+" transport");
    const b=e.body||{};
    const n=Number(b?.result?.value);
    if(!Number.isFinite(n)) throw new Error("selector "+k+" nonnumeric");
    out[k]=n;
    micro=String(b.sourceMicroversion||micro||"");
  }
  if(out.right!==1||out.createdByBody!==2||out.part!==1||out.face!==1||out.edge!==1){
    throw new Error(label+" selector cardinality "+JSON.stringify(out));
  }
  console.log("CF_E9_"+label+"_SELECTORS="+JSON.stringify(out));
  console.log("CF_E9_"+label+"_FS_MICROVERSION="+micro);
  return out;
}
async function mutateDepth(expression,label){
  const pre=await featureList();
  if(!/^[0-9a-f]{24}$/i.test(pre.micro)) throw new Error(label+" bad source microversion");
  const feature=sanitize(pre.feature);
  const depth=(feature.parameters||[]).find(p=>p.parameterId==="depth");
  if(!depth) throw new Error("depth parameter missing");
  const old=String(depth.expression||"");
  depth.expression=expression;
  const w=await invoke("updatePartStudioFeature",{
    pathParams:{did:DID,wid:WID,eid:EID,fid:FID},
    query:{sourceMicroversion:pre.micro,rejectMicroversionSkew:true},
    body:{feature}
  });
  const r=w?.result,e=r?.observation?.evidence||{};
  if(r?.outcome?.state!=="ACHIEVED"){
    console.log("CF_E9_"+label+"_MUTATION_RESULT="+JSON.stringify({outcome:r?.outcome,evidence:e}));
    throw new Error(label+" mutation not achieved");
  }
  if(e.httpStatus!==200||e.effectSent!==true||e.postconditionVerified!==true) throw new Error(label+" mutation verification");
  if(e.apiVersion!=="v17"||e.observedApiVersion!=="v17"||e.apiVersionMatched!==true) throw new Error(label+" mutation version");
  console.log("CF_E9_"+label+"_MUTATION=ACHIEVED");
  console.log("CF_E9_"+label+"_OLD_DEPTH="+old);
  console.log("CF_E9_"+label+"_NEW_DEPTH="+expression);
  console.log("CF_E9_"+label+"_PRE_MICROVERSION="+String(e.preMicroversion||""));
  console.log("CF_E9_"+label+"_POST_MICROVERSION="+String(e.postMicroversion||""));
}

const pool=parse(await client.callTool({name:"onshape_pool_status",arguments:{}}));
if(pool?.build_id!=="onshape-vps-hardened-r6"||pool?.pool_enabled!==true||pool?.size!==3||pool?.active_count!==0||pool?.queued_count!==0||pool?.document_lock_count!==0) throw new Error("r6 pool not ready");
for(const s of pool.sessions||[]) if(s?.auth?.state!=="PROVEN") throw new Error("session not proven "+String(s?.session_id));
console.log("CF_E9_R6_POOL=3-of-3-PROVEN-idle");

const initial=await featureList();
const initialDepth=String((initial.feature.parameters||[]).find(p=>p.parameterId==="depth")?.expression||"");
if(initialDepth!=="25 mm") throw new Error("unexpected baseline depth "+initialDepth);
if(initial.body?.featureStates?.[FID]?.featureStatus!=="OK") throw new Error("baseline feature status not OK");
const initialZ=partATopZ(await bodyDetails());
if(Math.abs(initialZ-0.025)>1e-9) throw new Error("unexpected baseline top z "+initialZ);
await selectorCounts("PRE");
console.log("CF_E9_R6_PRE_TOP_Z="+initialZ);

await mutateDepth("27 mm","FORWARD");
const mid=await featureList();
const midDepth=String((mid.feature.parameters||[]).find(p=>p.parameterId==="depth")?.expression||"");
if(midDepth!=="27 mm") throw new Error("forward readback depth "+midDepth);
if(mid.body?.featureStates?.[FID]?.featureStatus!=="OK") throw new Error("forward feature status not OK");
const midZ=partATopZ(await bodyDetails());
if(Math.abs(midZ-0.027)>1e-9) throw new Error("forward top z "+midZ);
await selectorCounts("MID");
console.log("CF_E9_R6_MID_TOP_Z="+midZ);

await mutateDepth("25 mm","RESTORE");
const fin=await featureList();
const finDepth=String((fin.feature.parameters||[]).find(p=>p.parameterId==="depth")?.expression||"");
if(finDepth!=="25 mm") throw new Error("restore readback depth "+finDepth);
if(fin.body?.featureStates?.[FID]?.featureStatus!=="OK") throw new Error("restore feature status not OK");
const finalZ=partATopZ(await bodyDetails());
if(Math.abs(finalZ-0.025)>1e-9) throw new Error("restore top z "+finalZ);
await selectorCounts("POST");
console.log("CF_E9_R6_POST_TOP_Z="+finalZ);
console.log("CF_E9_R6_GEOMETRY_FORWARD_DELTA="+String(midZ-initialZ));
console.log("CF_E9_R6_GEOMETRY_RESTORED="+String(Math.abs(finalZ-initialZ)<1e-9));
console.log("CF_E9_R6_SLICE_A=pass");

await client.close();
NODE

# Keep the external release gate closed until the canonical guard is re-closed.
if [[ -e "$GATE" ]]; then exit 40; fi
tmp="$GATE.tmp.e9done.$$"; printf '%s\n' RELEASE_IN_PROGRESS >"$tmp"; chmod 0600 "$tmp"; chown root:root "$tmp"; mv -f "$tmp" "$GATE"
restore_gate=no
trap - EXIT

ponr_post="$("$ROLLBACK_GUARD" decide --db "$DB" --control "$CONTROL" --quarantine "$QUARANTINE")"
printf '%s\n' "$ponr_post"
printf '%s\n' "$ponr_post" | grep -Fxq 'CF_A4_UNRESOLVED_BLOCKING=0'
printf '%s\n' "$ponr_post" | grep -Fxq 'CF_A4_ZERO_UNRESOLVED=pass'

echo CF_E9_R6_SLICE_RELEASE_GATE=active
echo CF_E9_R6_SLICE_GATEWAY=stopped
echo CF_E9_R6_SLICE=pass
