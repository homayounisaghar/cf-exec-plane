#!/usr/bin/env bash
set -euo pipefail
umask 077
[[ "$(id -u)" -eq 0 ]] || exit 2
candidate="16df8b8b56eac5fb109acb3716a2dbb12d789e1b"
fixture="a19e0fa5152af9f7ce106b6e:e5e7d0173fd1f1d0307a2cb6:e0929361aadb6135b5cecffa"
research=capability-fabric-onshape-phase0-research
sidecar=capability-fabric-onshape-phase0-fabric
release="/var/lib/capability-fabric/onshape-research-phase0/releases/$candidate"
control=/var/lib/capability-fabric/onshape/runtime-control/ONSHAPE_RUNTIME_CONTROL.json

python3 - "$control" <<'PY'
import json,sys
d=json.load(open(sys.argv[1])); a=d["authority"]; g=a["productionGuard"]
assert a["mode"]=="VPS_PRODUCTION" and a["materialAuthority"]=="vps-fabric"
assert a["planes"]["android-v1"]["ingress"]=="CLOSED"
assert a["reconciliationHold"]["active"] is False
assert g["killSwitch"]=="ENGAGED" and g["allowedDocumentIds"]==[] and g["mutationBudget"]["maxMutations"]==0
print("CF_PHASE0_BLIND_PRODUCTION_BOUNDARY=pass")
print("CF_PHASE0_BLIND_CONTROL_REV="+str(d["controlRevision"]))
print("CF_PHASE0_BLIND_EPOCH="+str(a["productionEpoch"]))
PY

for c in "$research" "$sidecar"; do
  [[ "$(docker inspect -f '{{.State.Running}}' "$c" 2>/dev/null || echo false)" == true ]]
  [[ "$(docker inspect -f '{{.State.Health.Status}}' "$c")" == healthy ]]
done
env_dump="$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$research")"
grep -Fxq "CF_RESEARCH_SOURCE_COMMIT=$candidate" <<<"$env_dump"
grep -Fxq "CF_RESEARCH_FIXTURE_TARGET=$fixture" <<<"$env_dump"
echo CF_PHASE0_BLIND_BINDING=pass

PYTHONPATH="$release/server-deploy/current/fabric-src" python3 - <<'PY'
from capability_fabric.persistence import SqliteExecutionStateStore
p="/var/lib/capability-fabric/onshape-research-phase0/fabric-state/execution.sqlite3"
with SqliteExecutionStateStore(p) as s:
    pending=s.recoverable()
    assert not pending, [(x.operation.operation_id if x.operation else None,x.attempt.attempt_id if x.attempt else None) for x in pending]
print("CF_PHASE0_BLIND_RECOVERABLE=zero")
PY

docker exec -e CF_FIXTURE="$fixture" -i "$research" sh -lc 'cd /tmp/app && node --input-type=module' <<'NODE'
import fs from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const [did,wid,eid]=process.env.CF_FIXTURE.split(":");
const token=fs.readFileSync("/run/secrets/mcp-token","utf8").trim();
const c=new Client({name:"cf-phase0-blind-reselect",version:"1.0"});
await c.connect(new StreamableHTTPClientTransport(new URL("http://127.0.0.1:8898/mcp/"+token)));

const parse=r=>JSON.parse((r.content||[]).filter(x=>x.type==="text").map(x=>x.text).join("\n"));
const call=async(name,args={})=>parse(await c.callTool({name,arguments:args},undefined,{timeout:180000}));
const viewer=async(params)=>{
  const w=await call("onshape_ui_native",{document_id:did,workspace_id:wid,element_id:eid,action:"runtime.viewer",params});
  const r=w.result;
  if(r?.outcome?.state!=="ACHIEVED"||r?.observation?.ackState!=="ACKNOWLEDGED") throw new Error("viewer "+JSON.stringify(r));
  return r.observation.evidence.result;
};
const nativeEval=async(expression)=>{
  const w=await call("onshape_ui_native",{document_id:did,workspace_id:wid,element_id:eid,action:"page.evaluate",params:{expression}});
  const r=w.result;
  if(r?.outcome?.state!=="ACHIEVED"||r?.observation?.ackState!=="ACKNOWLEDGED") throw new Error("eval "+JSON.stringify(r));
  return r.observation.evidence.result.value;
};
const input=async(label,steps)=>{
  const w=await call("onshape_ui_input",{document_id:did,workspace_id:wid,element_id:eid,steps});
  const r=w.result;
  console.log("CF_PHASE0_BLIND_INPUT_"+label+"="+JSON.stringify({
    operation_id:r?.operation_id||null,
    outcome:r?.outcome||null,
    observation:r?.observation||null
  }));
  if(r?.outcome?.state!=="ACHIEVED"||r?.observation?.ackState!=="ACKNOWLEDGED") throw new Error(label+" input not achieved");
  return r;
};
const matrixDelta=(a,b)=>{
  if(!Array.isArray(a)||!Array.isArray(b)||a.length!==16||b.length!==16) return null;
  return Math.max(...a.map((x,i)=>Math.abs(Number(x)-Number(b[i]))));
};
const mean=(pts)=>{
  const out=[0,0,0];
  for(const p of pts){out[0]+=p[0];out[1]+=p[1];out[2]+=p[2];}
  return out.map(x=>x/pts.length);
};
const triples=(flat)=>{
  const out=[];
  for(let i=0;i+2<flat.length;i+=3) out.push([Number(flat[i]),Number(flat[i+1]),Number(flat[i+2])]);
  return out;
};
const invert4ColumnMajor=(a)=>{
  if(!Array.isArray(a)||a.length!==16) throw new Error("view matrix");
  const m=Array.from({length:4},(_,r)=>Array.from({length:4},(_,col)=>Number(a[col*4+r])));
  const aug=m.map((row,r)=>[...row,...Array.from({length:4},(_,c2)=>r===c2?1:0)]);
  for(let col=0;col<4;col++){
    let pivot=col;
    for(let r=col+1;r<4;r++) if(Math.abs(aug[r][col])>Math.abs(aug[pivot][col])) pivot=r;
    if(Math.abs(aug[pivot][col])<1e-12) throw new Error("singular view matrix");
    [aug[col],aug[pivot]]=[aug[pivot],aug[col]];
    const d=aug[col][col];
    for(let j=0;j<8;j++) aug[col][j]/=d;
    for(let r=0;r<4;r++) if(r!==col){
      const f=aug[r][col];
      for(let j=0;j<8;j++) aug[r][j]-=f*aug[col][j];
    }
  }
  return aug.map(row=>row.slice(4));
};
const mul4=(m,p)=>m.map(row=>row.reduce((s,x,i)=>s+x*p[i],0));
const project=(world,viewData)=>{
  const vm=viewData?.viewMatrix, vp=viewData?.cameraViewport;
  if(!Array.isArray(vm)||vm.length!==16||!Array.isArray(vp)||vp.length<4) throw new Error("projection state missing");
  const inv=invert4ColumnMajor(vm);
  const q=mul4(inv,[world[0],world[1],world[2],1]);
  if(Math.abs(q[3])<1e-12) throw new Error("projection w");
  const vx=q[0]/q[3], vy=q[1]/q[3];
  const top=Number(vp[0]), bottom=Number(vp[1]), right=Number(vp[2]), left=Number(vp[3]);
  return {x_fraction:(vx-left)/(right-left),y_fraction:(top-vy)/(top-bottom),view:[vx,vy,q[2]/q[3]]};
};
const compactModel=v=>({count:v?.model_selection?.count??null,selections:(v?.model_selection?.selections||[]).map(s=>({
  deterministic_id:s.deterministic_id,selection_id:s.selection_id,id_for_collection:s.id_for_collection,
  is_entity:s.is_entity,is_face:s.is_face,is_edge:s.is_edge,is_vertex:s.is_vertex,is_body:s.is_body,
  source_pick:s.source_pick?{deterministic_id:s.source_pick.deterministic_id,id:s.source_pick.id,occurrence_id:s.source_pick.occurrence_id,primitive_id:s.source_pick.primitive_id}:null
}))});

try{
  const tools=(await c.listTools()).tools;
  const native=tools.find(x=>x.name==="onshape_ui_native");
  const actionEnum=native?.inputSchema?.properties?.action?.enum||[];
  if(!actionEnum.includes("runtime.viewer")) throw new Error("runtime.viewer absent");
  console.log("CF_PHASE0_BLIND_SCHEMA=runtime.viewer");

  const st=await call("onshape_session_status");
  if(st?.auth?.state!=="PROVEN"||st?.auth?.http_status!==200) throw new Error("auth");
  console.log("CF_PHASE0_BLIND_AUTH=PROVEN");

  const initial=await viewer({op:"selection_scan"});
  const sels=initial?.model_selection?.selections||[];
  if(sels.length!==1) throw new Error("expected exactly one established semantic target");
  const established=sels[0];
  if(established.deterministic_id!=="JHK"||established.is_face!==true) throw new Error("established target is not JHK Face");
  const source=established.source_pick||{};
  const meta=established.entity_metadata||source.entity_metadata||null;
  const flat=meta?.meshIncrement?.points;
  if(!Array.isArray(flat)||flat.length<18) throw new Error("target world mesh unavailable");
  const world=triples(flat);
  const targetId=established.deterministic_id;
  const preView=initial?.view_data?.viewMatrix;
  console.log("CF_PHASE0_BLIND_TARGET="+JSON.stringify({
    deterministic_id:targetId,is_face:established.is_face,selection_id:established.selection_id,
    source_pick:{deterministic_id:source.deterministic_id,id:source.id,occurrence_id:source.occurrence_id,primitive_id:source.primitive_id},
    world_point_count:world.length
  }));

  const canvas=await nativeEval('(() => {const e=document.querySelector("#canvas"),r=e?.getBoundingClientRect();return r?{x:r.x,y:r.y,w:r.width,h:r.height}:null})()');
  if(!canvas||canvas.w<=1||canvas.h<=1) throw new Error("canvas");

  const clearCandidates=[
    {x_fraction:.58,y_fraction:.52},
    {x_fraction:.90,y_fraction:.88},
    {x_fraction:.10,y_fraction:.10}
  ];
  let clearChoice=null;
  const clearProbes=[];
  for(const q of clearCandidates){
    const v=await viewer({op:"probe",x_fraction:q.x_fraction,y_fraction:q.y_fraction});
    clearProbes.push({point:q,status:v?.probe?.status||null,hit_ids:(v?.probe?.picks||[]).map(x=>x.deterministic_id||null)});
    if(v?.probe?.status==="MISS"){clearChoice=q;break;}
  }
  console.log("CF_PHASE0_BLIND_CLEAR_PROBES="+JSON.stringify(clearProbes));
  if(!clearChoice) throw new Error("no bounded clear-selection MISS");
  const blank={x:Math.round(canvas.x+canvas.w*clearChoice.x_fraction),y:Math.round(canvas.y+canvas.h*clearChoice.y_fraction)};
  await input("CLEAR",[{action:"mouse.click",x:blank.x,y:blank.y,button:"left",click_count:1,after_ms:180}]);
  const cleared=await viewer({op:"selection_scan"});
  if((cleared?.model_selection?.count??-1)!==0) throw new Error("selection did not clear");
  console.log("CF_PHASE0_BLIND_CLEARED="+JSON.stringify(compactModel(cleared)));

  const p1={x:Math.round(canvas.x+canvas.w*.30),y:Math.round(canvas.y+canvas.h*.30)};
  const p2={x:Math.round(canvas.x+canvas.w*.65),y:Math.round(canvas.y+canvas.h*.65)};
  await input("VIEW_CHANGE",[
    {action:"mouse.move",x:p1.x,y:p1.y,steps:1},
    {action:"mouse.down",button:"middle"},
    {action:"mouse.move",x:p1.x+45,y:p1.y+25,steps:6},
    {action:"mouse.up",button:"middle",after_ms:140},
    {action:"mouse.move",x:p2.x,y:p2.y,steps:1},
    {action:"mouse.down",button:"middle"},
    {action:"mouse.move",x:p2.x-20,y:p2.y+30,steps:6},
    {action:"mouse.up",button:"middle",after_ms:180}
  ]);

  const moved=await viewer({op:"selection_scan"});
  if((moved?.model_selection?.count??-1)!==0) throw new Error("view change unexpectedly selected an entity");
  const postView=moved?.view_data?.viewMatrix;
  const delta=matrixDelta(preView,postView);
  if(!(delta>1e-9)) throw new Error("viewMatrix did not change");
  console.log("CF_PHASE0_BLIND_VIEW_CHANGE="+JSON.stringify({
    view_matrix_max_abs_delta:delta,
    before:preView,
    after:postView,
    camera:moved.camera,
    camera_viewport:moved?.view_data?.cameraViewport
  }));

  const anchors=[
    {name:"mean_first_6",world:mean(world.slice(0,Math.min(6,world.length)))},
    {name:"mean_first_4",world:mean(world.slice(0,Math.min(4,world.length)))},
    {name:"mean_all",world:mean(world)}
  ];
  const probes=[];
  let chosen=null;
  for(const a of anchors){
    const pr=project(a.world,moved.view_data);
    const rec={name:a.name,world:a.world,projection:pr,status:"OUTSIDE",first_id:null};
    if(pr.x_fraction>=.02&&pr.x_fraction<=.98&&pr.y_fraction>=.02&&pr.y_fraction<=.98){
      const v=await viewer({op:"probe",x_fraction:pr.x_fraction,y_fraction:pr.y_fraction});
      rec.status=v?.probe?.status||null;
      rec.first_id=v?.probe?.picks?.[0]?.deterministic_id||null;
      rec.hit_ids=(v?.probe?.picks||[]).map(x=>x.deterministic_id||null);
      probes.push(rec);
      if(rec.status==="HIT"&&rec.first_id===targetId){chosen={anchor:a,projection:pr,probe:v.probe};break;}
    } else {
      probes.push(rec);
    }
  }
  console.log("CF_PHASE0_BLIND_PROBES="+JSON.stringify(probes));
  if(!chosen) throw new Error("semantic target not resolved inside three geometry-derived probes");

  const click={
    x:Math.round(canvas.x+canvas.w*chosen.projection.x_fraction),
    y:Math.round(canvas.y+canvas.h*chosen.projection.y_fraction)
  };
  console.log("CF_PHASE0_BLIND_REALIZATION="+JSON.stringify({
    source:"world_geometry_plus_live_view",
    anchor:chosen.anchor.name,
    x_fraction:chosen.projection.x_fraction,
    y_fraction:chosen.projection.y_fraction,
    click
  }));

  const commit=await input("RESELECT",[{action:"mouse.click",x:click.x,y:click.y,button:"left",click_count:1,after_ms:180}]);
  const away={x:Math.round(canvas.x+canvas.w*.90),y:Math.round(canvas.y+canvas.h*.88)};
  await input("POINTER_AWAY",[{action:"mouse.move",x:away.x,y:away.y,steps:1,after_ms:120}]);

  const post=await viewer({op:"selection_scan"});
  const postSels=post?.model_selection?.selections||[];
  const selected=postSels.length===1?postSels[0]:null;
  const authoritativeMatch=!!selected&&selected.deterministic_id===targetId&&selected.is_face===true;
  const wrongTargetAfterCommit=!authoritativeMatch;
  console.log("CF_PHASE0_BLIND_POST="+JSON.stringify(compactModel(post)));
  console.log("CF_PHASE0_BLIND_METRICS="+JSON.stringify({
    seed_hit:probes.length>=1&&probes[0].status==="HIT"&&probes[0].first_id===targetId,
    final_success_at_probe_budget:authoritativeMatch,
    probe_count:probes.length,
    probe_budget:3,
    wrong_target_after_commit:wrongTargetAfterCommit,
    target:targetId,
    selected:selected?.deterministic_id||null,
    selected_is_face:selected?.is_face??null
  }));
  if(!authoritativeMatch) throw new Error("authoritative post-selection mismatch");
  console.log("CF_PHASE0_BLIND=pass");
} finally {
  await c.close().catch(()=>{});
}
NODE

PYTHONPATH="$release/server-deploy/current/fabric-src" python3 - <<'PY'
from capability_fabric.persistence import SqliteExecutionStateStore
p="/var/lib/capability-fabric/onshape-research-phase0/fabric-state/execution.sqlite3"
with SqliteExecutionStateStore(p) as s:
    pending=s.recoverable()
    assert not pending, [(x.operation.operation_id if x.operation else None,x.attempt.attempt_id if x.attempt else None) for x in pending]
print("CF_PHASE0_BLIND_POST_RECOVERABLE=zero")
PY
