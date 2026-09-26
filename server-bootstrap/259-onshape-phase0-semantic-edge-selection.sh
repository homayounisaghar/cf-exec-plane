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
print("CF_PHASE0_EDGE_PRODUCTION_BOUNDARY=pass")
print("CF_PHASE0_EDGE_CONTROL_REV="+str(d["controlRevision"]))
print("CF_PHASE0_EDGE_EPOCH="+str(a["productionEpoch"]))
PY

for c in "$research" "$sidecar"; do
  [[ "$(docker inspect -f '{{.State.Running}}' "$c" 2>/dev/null || echo false)" == true ]]
  [[ "$(docker inspect -f '{{.State.Health.Status}}' "$c")" == healthy ]]
done
env_dump="$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$research")"
grep -Fxq "CF_RESEARCH_SOURCE_COMMIT=$candidate" <<<"$env_dump"
grep -Fxq "CF_RESEARCH_FIXTURE_TARGET=$fixture" <<<"$env_dump"
echo CF_PHASE0_EDGE_BINDING=pass

PYTHONPATH="$release/server-deploy/current/fabric-src" python3 - <<'PY'
from capability_fabric.persistence import SqliteExecutionStateStore
p="/var/lib/capability-fabric/onshape-research-phase0/fabric-state/execution.sqlite3"
with SqliteExecutionStateStore(p) as s:
    assert not s.recoverable()
print("CF_PHASE0_EDGE_RECOVERABLE=zero")
PY

docker exec -e CF_FIXTURE="$fixture" -i "$research" sh -lc 'cd /tmp/app && node --input-type=module' <<'NODE'
import fs from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const [did,wid,eid]=process.env.CF_FIXTURE.split(":");
const token=fs.readFileSync("/run/secrets/mcp-token","utf8").trim();
const c=new Client({name:"cf-phase0-edge-selection",version:"1.0"});
await c.connect(new StreamableHTTPClientTransport(new URL("http://127.0.0.1:8898/mcp/"+token)));
const parse=r=>JSON.parse((r.content||[]).filter(x=>x.type==="text").map(x=>x.text).join("\n"));
const call=async(name,args={})=>parse(await c.callTool({name,arguments:args},undefined,{timeout:180000}));
const viewer=async(params)=>{
  const w=await call("onshape_ui_native",{document_id:did,workspace_id:wid,element_id:eid,action:"runtime.viewer",params});
  const r=w.result;
  if(r?.outcome?.state!=="ACHIEVED"||r?.observation?.ackState!=="ACKNOWLEDGED") throw new Error(JSON.stringify(r));
  return r.observation.evidence.result;
};
const nativeEval=async(expression)=>{
  const w=await call("onshape_ui_native",{document_id:did,workspace_id:wid,element_id:eid,action:"page.evaluate",params:{expression}});
  const r=w.result;
  if(r?.outcome?.state!=="ACHIEVED"||r?.observation?.ackState!=="ACKNOWLEDGED") throw new Error(JSON.stringify(r));
  return r.observation.evidence.result.value;
};
const input=async(label,steps)=>{
  const w=await call("onshape_ui_input",{document_id:did,workspace_id:wid,element_id:eid,steps});
  const r=w.result;
  console.log("CF_PHASE0_EDGE_INPUT_"+label+"="+JSON.stringify({outcome:r?.outcome||null,observation:r?.observation||null}));
  if(r?.outcome?.state!=="ACHIEVED"||r?.observation?.ackState!=="ACKNOWLEDGED") throw new Error(label+" input not achieved");
  return r;
};
const triples=flat=>{const a=[];for(let i=0;i+2<flat.length;i+=3)a.push([+flat[i],+flat[i+1],+flat[i+2]]);return a};
const mid=(a,b)=>[(a[0]+b[0])/2,(a[1]+b[1])/2,(a[2]+b[2])/2];
const invert4ColumnMajor=a=>{
  const m=Array.from({length:4},(_,r)=>Array.from({length:4},(_,col)=>Number(a[col*4+r])));
  const aug=m.map((row,r)=>[...row,...Array.from({length:4},(_,cc)=>r===cc?1:0)]);
  for(let col=0;col<4;col++){
    let p=col; for(let r=col+1;r<4;r++) if(Math.abs(aug[r][col])>Math.abs(aug[p][col])) p=r;
    if(Math.abs(aug[p][col])<1e-12) throw new Error("singular");
    [aug[col],aug[p]]=[aug[p],aug[col]];
    const d=aug[col][col]; for(let j=0;j<8;j++) aug[col][j]/=d;
    for(let r=0;r<4;r++) if(r!==col){const f=aug[r][col];for(let j=0;j<8;j++)aug[r][j]-=f*aug[col][j];}
  }
  return aug.map(row=>row.slice(4));
};
const mul=(m,p)=>m.map(row=>row.reduce((s,x,i)=>s+x*p[i],0));
const project=(world,vd)=>{
  const inv=invert4ColumnMajor(vd.viewMatrix);
  const q=mul(inv,[...world,1]); const vx=q[0]/q[3],vy=q[1]/q[3];
  const [top,bottom,right,left]=vd.cameraViewport.map(Number);
  return {x_fraction:(vx-left)/(right-left),y_fraction:(top-vy)/(top-bottom)};
};

try {
  const st=await call("onshape_session_status");
  if(st?.auth?.state!=="PROVEN"||st?.auth?.http_status!==200) throw new Error("auth");
  console.log("CF_PHASE0_EDGE_AUTH=PROVEN");

  const anchor=await viewer({op:"probe",x_fraction:.52,y_fraction:.50});
  const face=(anchor?.probe?.picks||[]).find(x=>x?.deterministic_id==="JHK");
  const flat=face?.entity_metadata?.meshIncrement?.points;
  if(!face||!Array.isArray(flat)||flat.length<9) throw new Error("JHK anchor unavailable");
  if((anchor?.model_selection?.count??0)>1) throw new Error("unexpected preexisting selection multiplicity");

  const pts=triples(flat);
  const world=pts[1].map((x,i)=>x+(pts[2][i]-x)*.25);
  const p=project(world,anchor.view_data);
  if(!(p.x_fraction>.02&&p.x_fraction<.98&&p.y_fraction>.02&&p.y_fraction<.98)) throw new Error("edge seed outside viewport");
  const canvas=await nativeEval('(() => {const e=document.querySelector("#canvas"),r=e?.getBoundingClientRect();return r?{x:r.x,y:r.y,w:r.width,h:r.height}:null})()');
  if(!canvas||canvas.w<=1||canvas.h<=1) throw new Error("canvas");
  const xy={x:Math.round(canvas.x+canvas.w*p.x_fraction),y:Math.round(canvas.y+canvas.h*p.y_fraction)};

  const pre=await viewer({op:"probe",x_fraction:p.x_fraction,y_fraction:p.y_fraction});
  const pick=(pre?.probe?.picks||[]).find(x=>x?.deterministic_id==="JHt");
  const preSelectionId=pick?.deterministic_id??null;
  const preBodyId=pick?.getters?.body_id??pick?.entity_metadata?.bodyId??null;
  const prePrimitiveType=pick?.entity_metadata?.meshIncrement?.primitiveType??null;
  if(pre?.probe?.status!=="HIT" || preSelectionId!=="JHt" || preBodyId!=="JHD" || prePrimitiveType!==1) {
    throw new Error("qualified direct Edge pre-pick absent");
  }
  console.log("CF_PHASE0_EDGE_PRE="+JSON.stringify({
    x_fraction:p.x_fraction,y_fraction:p.y_fraction,
    deterministic_id:preSelectionId,body_id:preBodyId,primitive_type:prePrimitiveType,
    raw_id:pick?.id??null,occurrence_id:pick?.occurrence_id??null,primitive_id:pick?.primitive_id??null,
    model_selection_count:pre?.model_selection?.count??null
  }));

  if((pre?.model_selection?.count??0)!==0){
    const clear=await viewer({op:"probe",x_fraction:.58,y_fraction:.52});
    if(clear?.probe?.status!=="MISS") throw new Error("clear point not empty");
    const cx=Math.round(canvas.x+canvas.w*.58), cy=Math.round(canvas.y+canvas.h*.52);
    await input("CLEAR",[{action:"mouse.click",x:cx,y:cy,button:"left",click_count:1,after_ms:180}]);
    const cleared=await viewer({op:"inspect"});
    if((cleared?.model_selection?.count??-1)!==0) throw new Error("selection clear not authoritative");
    console.log("CF_PHASE0_EDGE_CLEAR=pass");
  }

  const confirm=await viewer({op:"probe",x_fraction:p.x_fraction,y_fraction:p.y_fraction});
  const confirmPick=(confirm?.probe?.picks||[]).find(x=>x?.deterministic_id===preSelectionId);
  if(confirm?.probe?.status!=="HIT" || !confirmPick || confirmPick?.entity_metadata?.meshIncrement?.primitiveType!==1) {
    throw new Error("direct Edge precommit identity changed");
  }
  await input("SELECT",[{action:"mouse.click",x:xy.x,y:xy.y,button:"left",click_count:1,after_ms:220}]);

  const post=await viewer({op:"inspect"});
  const sels=post?.model_selection?.selections||[];
  console.log("CF_PHASE0_EDGE_POST_RAW="+JSON.stringify(post?.model_selection||null));
  if(post?.model_selection?.count!==1 || sels.length!==1) throw new Error("authoritative edge selection count mismatch");
  const selected=sels[0];
  if(selected?.is_edge!==true || selected?.is_face!==false || selected?.is_body!==false || selected?.is_vertex!==false) {
    throw new Error("post selection is not Edge");
  }
  if(selected?.deterministic_id!==preSelectionId) throw new Error("post Edge identity does not match pre-pick Edge");
  console.log("CF_PHASE0_EDGE_POST="+JSON.stringify({
    pre_deterministic_id:preSelectionId,
    post_selection_id:selected?.selection_id??null,
    post_id_string:selected?.id_string??null,
    post_deterministic_id:selected?.deterministic_id??null,
    post_id_for_collection:selected?.id_for_collection??null,
    is_edge:selected?.is_edge??null,is_face:selected?.is_face??null,is_body:selected?.is_body??null,is_vertex:selected?.is_vertex??null,
    source_pick:selected?.source_pick??null
  }));
  console.log("CF_PHASE0_EDGE=pass");
} finally { await c.close().catch(()=>{}); }
NODE

PYTHONPATH="$release/server-deploy/current/fabric-src" python3 - <<'PY'
from capability_fabric.persistence import SqliteExecutionStateStore
p="/var/lib/capability-fabric/onshape-research-phase0/fabric-state/execution.sqlite3"
with SqliteExecutionStateStore(p) as s:
    assert not s.recoverable()
print("CF_PHASE0_EDGE_POST_RECOVERABLE=zero")
PY
