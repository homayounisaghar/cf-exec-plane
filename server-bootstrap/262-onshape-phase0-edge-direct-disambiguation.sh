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
print("CF_PHASE0_EDGEDIR_PRODUCTION_BOUNDARY=pass")
print("CF_PHASE0_EDGEDIR_CONTROL_REV="+str(d["controlRevision"]))
print("CF_PHASE0_EDGEDIR_EPOCH="+str(a["productionEpoch"]))
PY

for c in "$research" "$sidecar"; do
  [[ "$(docker inspect -f '{{.State.Running}}' "$c" 2>/dev/null || echo false)" == true ]]
  [[ "$(docker inspect -f '{{.State.Health.Status}}' "$c")" == healthy ]]
done
env_dump="$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$research")"
grep -Fxq "CF_RESEARCH_SOURCE_COMMIT=$candidate" <<<"$env_dump"
grep -Fxq "CF_RESEARCH_FIXTURE_TARGET=$fixture" <<<"$env_dump"
echo CF_PHASE0_EDGEDIR_BINDING=pass

PYTHONPATH="$release/server-deploy/current/fabric-src" python3 - <<'PY'
from capability_fabric.persistence import SqliteExecutionStateStore
p="/var/lib/capability-fabric/onshape-research-phase0/fabric-state/execution.sqlite3"
with SqliteExecutionStateStore(p) as s:
    assert not s.recoverable()
print("CF_PHASE0_EDGEDIR_RECOVERABLE=zero")
PY

docker exec -e CF_FIXTURE="$fixture" -i "$research" sh -lc 'cd /tmp/app && node --input-type=module' <<'NODE'
import fs from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const [did,wid,eid]=process.env.CF_FIXTURE.split(":");
const token=fs.readFileSync("/run/secrets/mcp-token","utf8").trim();
const c=new Client({name:"cf-phase0-edge-direct-disambiguation",version:"1.0"});
await c.connect(new StreamableHTTPClientTransport(new URL("http://127.0.0.1:8898/mcp/"+token)));
const parse=r=>JSON.parse((r.content||[]).filter(x=>x.type==="text").map(x=>x.text).join("\n"));
const call=async(name,args={})=>parse(await c.callTool({name,arguments:args},undefined,{timeout:180000}));
const viewer=async(params)=>{
  const w=await call("onshape_ui_native",{document_id:did,workspace_id:wid,element_id:eid,action:"runtime.viewer",params});
  const r=w.result;
  if(r?.outcome?.state!=="ACHIEVED"||r?.observation?.ackState!=="ACKNOWLEDGED") throw new Error(JSON.stringify(r));
  return r.observation.evidence.result;
};
const triples=f=>{const a=[];for(let i=0;i+2<f.length;i+=3)a.push([+f[i],+f[i+1],+f[i+2]]);return a};
const lerp=(a,b,t)=>a.map((x,i)=>x+(b[i]-x)*t);
const inv=a=>{
  const m=Array.from({length:4},(_,r)=>Array.from({length:4},(_,col)=>Number(a[col*4+r])));
  const u=m.map((row,r)=>[...row,...Array.from({length:4},(_,cc)=>r===cc?1:0)]);
  for(let col=0;col<4;col++){
    let p=col;for(let r=col+1;r<4;r++)if(Math.abs(u[r][col])>Math.abs(u[p][col]))p=r;
    [u[col],u[p]]=[u[p],u[col]];const d=u[col][col];if(Math.abs(d)<1e-12)throw new Error("singular");
    for(let j=0;j<8;j++)u[col][j]/=d;
    for(let r=0;r<4;r++)if(r!==col){const f=u[r][col];for(let j=0;j<8;j++)u[r][j]-=f*u[col][j]}
  }
  return u.map(row=>row.slice(4));
};
const mul=(m,p)=>m.map(row=>row.reduce((s,x,i)=>s+x*p[i],0));
const project=(w,vd)=>{
  const q=mul(inv(vd.viewMatrix),[...w,1]),vx=q[0]/q[3],vy=q[1]/q[3];
  const [top,bottom,right,left]=vd.cameraViewport.map(Number);
  return{x_fraction:(vx-left)/(right-left),y_fraction:(top-vy)/(top-bottom)};
};
const slim=p=>({
  id:p?.id??null,deterministic_id:p?.deterministic_id??null,occurrence_id:p?.occurrence_id??null,
  primitive_id:p?.primitive_id??null,getters:p?.getters??null,
  ui_selection_bridge:p?.ui_selection_bridge??null,
  ui_selection:p?.ui_selection?{
    selectionId:p.ui_selection.selectionId??null,
    meshIncrementId:p.ui_selection.meshIncrementId??null,
    uiElement:p.ui_selection.uiElement?{
      selectionId:p.ui_selection.uiElement.selectionId??null,
      collectionId:p.ui_selection.uiElement.collectionId??null,
      meshOwnerId:p.ui_selection.uiElement.meshOwnerId??null,
      parameter:p.ui_selection.uiElement.parameter??null,
      position:p.ui_selection.uiElement.position??null,
      bodyId:p.ui_selection.uiElement.entityMetaData?.bodyId??null,
      geometries:p.ui_selection.uiElement.entityMetaData?.geometries??null
    }:null
  }:null,
  entity_metadata:p?.entity_metadata?{
    bodyId:p.entity_metadata.bodyId??null,
    featureIds:p.entity_metadata.featureIds??null,
    meshIncrement:p.entity_metadata.meshIncrement?{
      id:p.entity_metadata.meshIncrement.id??null,
      primitiveType:p.entity_metadata.meshIncrement.primitiveType??null,
      properties:p.entity_metadata.meshIncrement.properties??null
    }:null,
    geometries:p.entity_metadata.geometries??null
  }:null
});
try{
  const st=await call("onshape_session_status");
  if(st?.auth?.state!=="PROVEN"||st?.auth?.http_status!==200) throw new Error("auth");
  console.log("CF_PHASE0_EDGEDIR_AUTH=PROVEN");

  const base=await viewer({op:"inspect"});
  console.log("CF_PHASE0_EDGEDIR_SELECTION_BEFORE="+JSON.stringify(base?.model_selection||null));

  const anchor=await viewer({op:"probe",x_fraction:.52,y_fraction:.50});
  const face=(anchor?.probe?.picks||[]).find(x=>x?.deterministic_id==="JHK");
  const flat=face?.entity_metadata?.meshIncrement?.points;
  if(!face||!Array.isArray(flat)||flat.length<9) throw new Error("JHK anchor unavailable");
  const pts=triples(flat);
  const edgeA=pts[1], edgeB=pts[2];
  const out=[];
  for(const [name,t] of [["quarter",.25],["mid",.50],["three_quarter",.75]]){
    const world=lerp(edgeA,edgeB,t), p=project(world,anchor.view_data);
    if(!(p.x_fraction>.02&&p.x_fraction<.98&&p.y_fraction>.02&&p.y_fraction<.98)) throw new Error(name+" outside viewport");
    const v=await viewer({op:"probe",x_fraction:p.x_fraction,y_fraction:p.y_fraction});
    out.push({name,t,world,projection:p,status:v?.probe?.status||null,picks:(v?.probe?.picks||[]).map(slim)});
  }
  console.log("CF_PHASE0_EDGEDIR_PROBES="+JSON.stringify(out));
  console.log("CF_PHASE0_EDGEDIR=pass");
} finally { await c.close().catch(()=>{}); }
NODE

PYTHONPATH="$release/server-deploy/current/fabric-src" python3 - <<'PY'
from capability_fabric.persistence import SqliteExecutionStateStore
p="/var/lib/capability-fabric/onshape-research-phase0/fabric-state/execution.sqlite3"
with SqliteExecutionStateStore(p) as s:
    assert not s.recoverable()
print("CF_PHASE0_EDGEDIR_POST_RECOVERABLE=zero")
PY
