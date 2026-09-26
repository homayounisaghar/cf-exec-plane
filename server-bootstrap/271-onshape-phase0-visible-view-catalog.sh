#!/usr/bin/env bash
set -euo pipefail
umask 077
[[ "$(id -u)" -eq 0 ]] || exit 2

candidate="c0cadee962c2059ba939c40c6bb9adf1bc99edfe"
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
print("CF_PHASE0_VIEWCAT_PRODUCTION_BOUNDARY=pass")
print("CF_PHASE0_VIEWCAT_CONTROL_REV="+str(d["controlRevision"]))
print("CF_PHASE0_VIEWCAT_EPOCH="+str(a["productionEpoch"]))
PY

for c in "$research" "$sidecar"; do
  [[ "$(docker inspect -f '{{.State.Running}}' "$c" 2>/dev/null || echo false)" == true ]]
  [[ "$(docker inspect -f '{{.State.Health.Status}}' "$c")" == healthy ]]
done
env_dump="$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$research")"
grep -Fxq "CF_RESEARCH_SOURCE_COMMIT=$candidate" <<<"$env_dump"
grep -Fxq "CF_RESEARCH_FIXTURE_TARGET=$fixture" <<<"$env_dump"
echo CF_PHASE0_VIEWCAT_BINDING=pass

PYTHONPATH="$release/server-deploy/current/fabric-src" python3 - <<'PY'
from capability_fabric.persistence import SqliteExecutionStateStore
p="/var/lib/capability-fabric/onshape-research-phase0/fabric-state/execution.sqlite3"
with SqliteExecutionStateStore(p) as s: assert not s.recoverable()
print("CF_PHASE0_VIEWCAT_RECOVERABLE=zero")
PY

docker exec -e CF_FIXTURE="$fixture" -i "$research" sh -lc 'cd /tmp/app && node --input-type=module' <<'NODE'
import fs from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const [did,wid,eid]=process.env.CF_FIXTURE.split(":");
const token=fs.readFileSync("/run/secrets/mcp-token","utf8").trim();
const c=new Client({name:"cf-phase0-visible-view-catalog",version:"2.0"});
await c.connect(new StreamableHTTPClientTransport(new URL("http://127.0.0.1:8898/mcp/"+token)));

const parse=r=>JSON.parse((r.content||[]).filter(x=>x.type==="text").map(x=>x.text).join("\n"));
const call=async(name,args={})=>parse(await c.callTool({name,arguments:args},undefined,{timeout:180000}));
const viewer=async(params)=>{
  const w=await call("onshape_ui_native",{document_id:did,workspace_id:wid,element_id:eid,action:"runtime.viewer",params});
  const r=w.result;
  if(r?.outcome?.state!=="ACHIEVED"||r?.observation?.ackState!=="ACKNOWLEDGED") throw new Error("viewer "+JSON.stringify(r));
  return r.observation.evidence.result;
};
const input=async(label,steps)=>{
  const w=await call("onshape_ui_input",{document_id:did,workspace_id:wid,element_id:eid,steps});
  console.log("CF_PHASE0_VIEWCAT_INPUT_RAW_"+label+"="+JSON.stringify(w));
  const r=w?.result??w;
  console.log("CF_PHASE0_VIEWCAT_INPUT_"+label+"="+JSON.stringify({
    status:w?.status??null,error:w?.error??null,
    attemptId:r?.attemptId||null,operationId:r?.operationId||null,
    outcome:r?.outcome||null,ackState:r?.observation?.ackState||null,
    sequenceCompleted:r?.observation?.evidence?.sequenceCompleted??null
  }));
  if(r?.outcome?.state!=="ACHIEVED"||r?.observation?.ackState!=="ACKNOWLEDGED"||r?.observation?.evidence?.sequenceCompleted!==true)
    throw new Error(label+" input not achieved");
  return r;
};
const triples=flat=>{const out=[];for(let i=0;i+2<flat.length;i+=3)out.push([+flat[i],+flat[i+1],+flat[i+2]]);return out.filter(p=>p.every(Number.isFinite));};
const mean=pts=>[0,1,2].map(j=>pts.reduce((s,p)=>s+p[j],0)/pts.length);
const lerp=(a,b,t)=>a.map((v,i)=>v+(b[i]-v)*t);
const invert4ColumnMajor=a=>{
  const m=Array.from({length:4},(_,r)=>Array.from({length:4},(_,col)=>Number(a[col*4+r])));
  const aug=m.map((row,r)=>[...row,...Array.from({length:4},(_,cc)=>r===cc?1:0)]);
  for(let col=0;col<4;col++){
    let p=col;for(let r=col+1;r<4;r++)if(Math.abs(aug[r][col])>Math.abs(aug[p][col]))p=r;
    if(Math.abs(aug[p][col])<1e-12)throw new Error("singular view matrix");
    [aug[col],aug[p]]=[aug[p],aug[col]];
    const d=aug[col][col];for(let j=0;j<8;j++)aug[col][j]/=d;
    for(let r=0;r<4;r++)if(r!==col){const f=aug[r][col];for(let j=0;j<8;j++)aug[r][j]-=f*aug[col][j];}
  }
  return aug.map(row=>row.slice(4));
};
const mul=(m,p)=>m.map(row=>row.reduce((s,x,i)=>s+x*p[i],0));
const project=(world,vd)=>{
  const inv=invert4ColumnMajor(vd.viewMatrix);
  const q=mul(inv,[...world,1]);
  const vx=q[0]/q[3],vy=q[1]/q[3];
  const [top,bottom,right,left]=vd.cameraViewport.map(Number);
  return {x:(vx-left)/(right-left),y:(top-vy)/(top-bottom)};
};
const inside=p=>Number.isFinite(p?.x)&&Number.isFinite(p?.y)&&p.x>.025&&p.x<.975&&p.y>.025&&p.y<.975;
const matrixDelta=(a,b)=>Math.max(...a.map((x,i)=>Math.abs(Number(x)-Number(b[i]))));
const dist=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y);
const selSig=v=>JSON.stringify((v?.model_selection?.selections||[]).map(s=>({
  id:s?.deterministic_id??s?.selection_id??s?.id_string??null,
  f:s?.is_face??null,e:s?.is_edge??null,b:s?.is_body??null,v:s?.is_vertex??null
})));
const keySteps=keys=>keys.map(k=>({action:"keyboard.press",key:k,after_ms:220}));
const candidates=[
  {id:"ISO",keys:["Shift+7","f"]},
  {id:"ISO_L15",keys:["Shift+7","f","Control+ArrowLeft","Control+ArrowLeft","Control+ArrowLeft"]},
  {id:"ISO_R15",keys:["Shift+7","f","Control+ArrowRight","Control+ArrowRight","Control+ArrowRight"]},
  {id:"ISO_U15",keys:["Shift+7","f","Control+ArrowUp","Control+ArrowUp","Control+ArrowUp"]},
  {id:"ISO_D15",keys:["Shift+7","f","Control+ArrowDown","Control+ArrowDown","Control+ArrowDown"]},
  {id:"ISO_L30",keys:["Shift+7","f","Control+ArrowLeft","Control+ArrowLeft","Control+ArrowLeft","Control+ArrowLeft","Control+ArrowLeft","Control+ArrowLeft"]},
  {id:"ISO_R30",keys:["Shift+7","f","Control+ArrowRight","Control+ArrowRight","Control+ArrowRight","Control+ArrowRight","Control+ArrowRight","Control+ArrowRight"]},
  {id:"ISO_U30",keys:["Shift+7","f","Control+ArrowUp","Control+ArrowUp","Control+ArrowUp","Control+ArrowUp","Control+ArrowUp","Control+ArrowUp"]},
  {id:"ISO_D30",keys:["Shift+7","f","Control+ArrowDown","Control+ArrowDown","Control+ArrowDown","Control+ArrowDown","Control+ArrowDown","Control+ArrowDown"]},
  {id:"FRONT",keys:["Shift+1","f"]},
  {id:"BACK",keys:["Shift+2","f"]},
  {id:"LEFT",keys:["Shift+3","f"]},
  {id:"RIGHT",keys:["Shift+4","f"]},
  {id:"TOP",keys:["Shift+5","f"]},
  {id:"BOTTOM",keys:["Shift+6","f"]}
];
const MIN_SCREEN_SEPARATION=.03;
const REPLAY_MATRIX_TOL=1e-8;

try{
  const st=await call("onshape_session_status");
  if(st?.auth?.state!=="PROVEN"||st?.auth?.http_status!==200)throw new Error("auth");
  console.log("CF_PHASE0_VIEWCAT_AUTH=PROVEN");

  const pre=await viewer({op:"inspect"});
  const baselineSig=selSig(pre);
  await input("BOOTSTRAP_ISO",keySteps(["Shift+7","f"]));
  const bootstrapPoints=[
    {x_fraction:.50,y_fraction:.50},
    {x_fraction:.52,y_fraction:.50},
    {x_fraction:.48,y_fraction:.50}
  ];
  let anchor=null,anchorFace=null;
  const bootstrapProbes=[];
  for(const p of bootstrapPoints){
    const v=await viewer({op:"probe",...p});
    if(selSig(v)!==baselineSig)throw new Error("bootstrap probe changed selection");
    const hit=(v?.probe?.picks||[]).find(x=>x?.deterministic_id==="JHK")||null;
    bootstrapProbes.push({point:p,status:v?.probe?.status||null,hit_ids:(v?.probe?.picks||[]).map(x=>x?.deterministic_id||null)});
    if(hit){anchor=v;anchorFace=hit;break;}
  }
  console.log("CF_PHASE0_VIEWCAT_BOOTSTRAP="+JSON.stringify(bootstrapProbes));
  const flat=anchorFace?.entity_metadata?.meshIncrement?.points;
  if(!anchorFace||!Array.isArray(flat)||flat.length<18)throw new Error("qualified JHK anchor/world mesh absent after bounded isometric bootstrap");
  const world=triples(flat);
  if(world.length<6)throw new Error("JHK world mesh insufficient");
  const faceAnchors=[
    {name:"mean_first_6",world:mean(world.slice(0,6))},
    {name:"mean_first_4",world:mean(world.slice(0,4))},
    {name:"mean_all",world:mean(world)}
  ];
  const edgeAnchors=[
    {name:"edge_q25",world:lerp(world[1],world[2],.25)},
    {name:"edge_mid",world:lerp(world[1],world[2],.50)},
    {name:"edge_q35",world:lerp(world[1],world[2],.35)}
  ];
  console.log("CF_PHASE0_VIEWCAT_PREFLIGHT="+JSON.stringify({target_face:"JHK",target_edge:"JHt",world_points:world.length,selection_signature:baselineSig}));

  const probeTarget=async(targetId,anchors,vd)=>{
    const attempts=[];
    for(const a of anchors){
      const p=project(a.world,vd);
      const rec={anchor:a.name,projection:p,status:"OUTSIDE",hit_ids:[]};
      if(inside(p)){
        const v=await viewer({op:"probe",x_fraction:p.x,y_fraction:p.y});
        if(selSig(v)!==baselineSig)throw new Error("read-only probe changed selection");
        rec.status=v?.probe?.status||null;
        rec.hit_ids=(v?.probe?.picks||[]).map(x=>x?.deterministic_id||null);
        rec.first_id=rec.hit_ids[0]??null;
        attempts.push(rec);
        if(rec.status==="HIT"&&rec.first_id===targetId)return {ok:true,seed:p,anchor:a.name,attempts};
      } else attempts.push(rec);
    }
    return {ok:false,seed:null,anchor:null,attempts};
  };

  const records=[];
  for(const spec of candidates){
    await input("SET_"+spec.id,keySteps(spec.keys));
    const v=await viewer({op:"inspect"});
    if(selSig(v)!==baselineSig)throw new Error("view change altered selection");
    const vd=v?.view_data;
    if(!Array.isArray(vd?.viewMatrix)||vd.viewMatrix.length!==16)throw new Error("view matrix missing");
    const face=await probeTarget("JHK",faceAnchors,vd);
    const edge=await probeTarget("JHt",edgeAnchors,vd);
    const rec={
      id:spec.id,keys:spec.keys,view_matrix:vd.viewMatrix,camera_viewport:vd.cameraViewport,
      orthographic:v?.camera?.orthographic??null,
      face,edge
    };
    records.push(rec);
    console.log("CF_PHASE0_VIEWCAT_CANDIDATE="+JSON.stringify({id:rec.id,face_ok:face.ok,face_seed:face.seed,edge_ok:edge.ok,edge_seed:edge.seed}));
  }

  const choose=(kind)=>{
    const accepted=[];
    for(const r of records){
      const q=r[kind];
      if(!q.ok)continue;
      if(accepted.some(a=>matrixDelta(r.view_matrix,a.view_matrix)<1e-4))continue;
      if(accepted.some(a=>dist(q.seed,a[kind].seed)<MIN_SCREEN_SEPARATION))continue;
      accepted.push(r);
      if(accepted.length===5)break;
    }
    return accepted;
  };
  const faceAccepted=choose("face"), edgeAccepted=choose("edge");
  if(faceAccepted.length<5||edgeAccepted.length<5){
    console.log("CF_PHASE0_VIEWCAT_SHORTFALL="+JSON.stringify({face:faceAccepted.map(x=>x.id),edge:edgeAccepted.map(x=>x.id),min_screen_separation:MIN_SCREEN_SEPARATION}));
    throw new Error("fewer than five materially distinct visible views for Face or Edge");
  }

  const uniqueReplay=[...new Map([...faceAccepted,...edgeAccepted].map(x=>[x.id,x])).values()];
  const replay=[];
  for(const spec of uniqueReplay){
    await input("REPLAY_"+spec.id,keySteps(spec.keys));
    const v=await viewer({op:"inspect"});
    if(selSig(v)!==baselineSig)throw new Error("replay altered selection");
    const d=matrixDelta(v.view_data.viewMatrix,spec.view_matrix);
    const face=await probeTarget("JHK",faceAnchors,v.view_data);
    const edge=await probeTarget("JHt",edgeAnchors,v.view_data);
    replay.push({id:spec.id,matrix_delta:d,face_ok:face.ok,edge_ok:edge.ok,face_seed:face.seed,edge_seed:edge.seed});
    if(d>REPLAY_MATRIX_TOL)throw new Error("view replay matrix mismatch "+spec.id+" "+d);
    if(faceAccepted.some(x=>x.id===spec.id)&&!face.ok)throw new Error("Face lost on replay "+spec.id);
    if(edgeAccepted.some(x=>x.id===spec.id)&&!edge.ok)throw new Error("Edge lost on replay "+spec.id);
  }

  const out={
    schema:"capability-fabric.onshape-virtual-ui-visible-view-catalog.v2",
    benchmark_id:"onshape-virtual-ui-delegability-v2",
    fixture:{document_id:did,workspace_id:wid,element_id:eid},
    research_candidate:"c0cadee962c2059ba939c40c6bb9adf1bc99edfe",
    source:"standard Onshape keyboard views + documented 5-degree rotation shortcuts; semantic visibility probe",
    model_outputs_inspected:false,
    thresholds:{min_screen_seed_separation:MIN_SCREEN_SEPARATION,replay_matrix_tolerance:REPLAY_MATRIX_TOL,max_semantic_probes_per_target_view:3},
    face_views:faceAccepted.map(x=>({id:x.id,keys:x.keys,view_matrix:x.view_matrix,camera_viewport:x.camera_viewport,seed:x.face.seed,anchor:x.face.anchor})),
    edge_views:edgeAccepted.map(x=>({id:x.id,keys:x.keys,view_matrix:x.view_matrix,camera_viewport:x.camera_viewport,seed:x.edge.seed,anchor:x.edge.anchor})),
    replay,
    all_candidates:records.map(x=>({id:x.id,keys:x.keys,view_matrix:x.view_matrix,face_ok:x.face.ok,face_seed:x.face.seed,edge_ok:x.edge.ok,edge_seed:x.edge.seed}))
  };
  const final=await viewer({op:"inspect"});
  if(selSig(final)!==baselineSig)throw new Error("catalog qualification changed selection");
  console.log("CF_PHASE0_VIEWCAT_SELECTION_UNCHANGED=pass");
  console.log("CF_PHASE0_VIEWCAT_JSON="+JSON.stringify(out));
  console.log("CF_PHASE0_VIEWCAT_B64="+Buffer.from(JSON.stringify(out),"utf8").toString("base64"));
  console.log("CF_PHASE0_VIEWCAT=pass");
} finally {await c.close().catch(()=>{});}
NODE

PYTHONPATH="$release/server-deploy/current/fabric-src" python3 - <<'PY'
from capability_fabric.persistence import SqliteExecutionStateStore
p="/var/lib/capability-fabric/onshape-research-phase0/fabric-state/execution.sqlite3"
with SqliteExecutionStateStore(p) as s: assert not s.recoverable()
print("CF_PHASE0_VIEWCAT_POST_RECOVERABLE=zero")
PY
