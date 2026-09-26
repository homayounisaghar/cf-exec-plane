#!/usr/bin/env bash
set -euo pipefail
umask 077
[[ "$(id -u)" -eq 0 ]] || exit 2

candidate="d9354b6bb26b10dd198aab2a7417c746ae90de66"
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
print("CF_PHASE0_EDGEVIEW_PRODUCTION_BOUNDARY=pass")
print("CF_PHASE0_EDGEVIEW_CONTROL_REV="+str(d["controlRevision"]))
print("CF_PHASE0_EDGEVIEW_EPOCH="+str(a["productionEpoch"]))
PY

for c in "$research" "$sidecar"; do
  [[ "$(docker inspect -f '{{.State.Running}}' "$c" 2>/dev/null || echo false)" == true ]]
  [[ "$(docker inspect -f '{{.State.Health.Status}}' "$c")" == healthy ]]
done
env_dump="$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$research")"
grep -Fxq "CF_RESEARCH_SOURCE_COMMIT=$candidate" <<<"$env_dump"
grep -Fxq "CF_RESEARCH_FIXTURE_TARGET=$fixture" <<<"$env_dump"
echo CF_PHASE0_EDGEVIEW_BINDING=pass

PYTHONPATH="$release/server-deploy/current/fabric-src" python3 - <<'PY'
from capability_fabric.persistence import SqliteExecutionStateStore
p="/var/lib/capability-fabric/onshape-research-phase0/fabric-state/execution.sqlite3"
with SqliteExecutionStateStore(p) as s:
    pending=s.recoverable()
    assert not pending, [(x.operation.operation_id if x.operation else None,x.attempt.attempt_id if x.attempt else None) for x in pending]
print("CF_PHASE0_EDGEVIEW_RECOVERABLE=zero")
PY

docker exec -e CF_FIXTURE="$fixture" -i "$research" sh -lc 'cd /tmp/app && node --input-type=module' <<'NODE'
import fs from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
const [did,wid,eid]=process.env.CF_FIXTURE.split(":");
const token=fs.readFileSync("/run/secrets/mcp-token","utf8").trim();
const c=new Client({name:"cf-phase0-edge-view-stack-diagnostic",version:"1.0"});
await c.connect(new StreamableHTTPClientTransport(new URL("http://127.0.0.1:8898/mcp/"+token)));
const parse=r=>JSON.parse((r.content||[]).filter(x=>x.type==="text").map(x=>x.text).join("\n"));
const call=async(name,args={})=>parse(await c.callTool({name,arguments:args},undefined,{timeout:180000}));
const viewer=async(params)=>{
  const w=await call("onshape_ui_native",{document_id:did,workspace_id:wid,element_id:eid,action:"runtime.viewer",params});
  const r=w.result;
  if(r?.outcome?.state!=="ACHIEVED"||r?.observation?.ackState!=="ACKNOWLEDGED")throw new Error("viewer "+JSON.stringify(r));
  return r.observation.evidence.result;
};
const input=async(steps)=>{
  const w=await call("onshape_ui_input",{document_id:did,workspace_id:wid,element_id:eid,steps});
  if(w?.status==="FAILED")throw new Error("input "+JSON.stringify(w));
  const r=w?.result??w;
  if(r?.outcome?.state!=="ACHIEVED"||r?.observation?.ackState!=="ACKNOWLEDGED"||r?.observation?.evidence?.sequenceCompleted!==true)
    throw new Error("input not achieved "+JSON.stringify(w));
  return r;
};
const triples=flat=>{const o=[];for(let i=0;i+2<flat.length;i+=3)o.push([+flat[i],+flat[i+1],+flat[i+2]]);return o;};
const lerp=(a,b,t)=>a.map((v,i)=>v+(b[i]-v)*t);
const invert4=a=>{
  const m=Array.from({length:4},(_,r)=>Array.from({length:4},(_,col)=>Number(a[col*4+r])));
  const aug=m.map((row,r)=>[...row,...Array.from({length:4},(_,cc)=>r===cc?1:0)]);
  for(let col=0;col<4;col++){let p=col;for(let r=col+1;r<4;r++)if(Math.abs(aug[r][col])>Math.abs(aug[p][col]))p=r;
    if(Math.abs(aug[p][col])<1e-12)throw new Error("singular");[aug[col],aug[p]]=[aug[p],aug[col]];
    const d=aug[col][col];for(let j=0;j<8;j++)aug[col][j]/=d;
    for(let r=0;r<4;r++)if(r!==col){const f=aug[r][col];for(let j=0;j<8;j++)aug[r][j]-=f*aug[col][j];}}
  return aug.map(r=>r.slice(4));
};
const mul=(m,p)=>m.map(row=>row.reduce((s,x,i)=>s+x*p[i],0));
const project=(w,vd)=>{
  const q=mul(invert4(vd.viewMatrix),[...w,1]); const vx=q[0]/q[3],vy=q[1]/q[3];
  const [top,bottom,right,left]=vd.cameraViewport.map(Number);
  return {x:(vx-left)/(right-left),y:(top-vy)/(top-bottom)};
};
const compact=p=>({
  deterministic_id:p?.deterministic_id??null,id:p?.id??null,
  entity_type:p?.getters?.entity_type??null,
  is_edge:p?.getters?.is_edge??null,is_face:p?.getters?.is_face??null,is_vertex:p?.getters?.is_vertex??null,
  body_id:p?.getters?.body_id??p?.entity_metadata?.bodyId??null,
  primitive_type:p?.entity_metadata?.meshIncrement?.primitiveType??null
});
const selSig=v=>JSON.stringify((v?.model_selection?.selections||[]).map(s=>({id:s?.deterministic_id??s?.selection_id??null,e:s?.is_edge??null,f:s?.is_face??null,v:s?.is_vertex??null,b:s?.is_body??null})));

try{
  const st=await call("onshape_session_status");
  if(st?.auth?.state!=="PROVEN"||st?.auth?.http_status!==200)throw new Error("auth");
  console.log("CF_PHASE0_EDGEVIEW_AUTH=PROVEN");
  const before=await viewer({op:"inspect"}), sig=selSig(before);
  await input([{action:"keyboard.press",key:"Shift+7",after_ms:220},{action:"keyboard.press",key:"f",after_ms:300}]);
  let anchor=null;
  for(const q of [
    {x_fraction:.48003471323534147,y_fraction:.40177663488528204},
    {x_fraction:.4726713018737533,y_fraction:.4073717835320432},
    {x_fraction:.52,y_fraction:.50}
  ]){
    const v=await viewer({op:"probe",...q});
    if(selSig(v)!==sig)throw new Error("selection changed");
    const h=(v?.probe?.picks||[]).find(p=>p?.deterministic_id==="JHK");
    if(h){anchor={v,h,q};break;}
  }
  if(!anchor)throw new Error("JHK bootstrap absent");
  const pts=triples(anchor.h.entity_metadata.meshIncrement.points);
  const out=[];
  for(const [name,t] of [["q25",.25],["q35",.35],["mid",.50]]){
    const p=project(lerp(pts[1],pts[2],t),anchor.v.view_data);
    const v=await viewer({op:"probe",x_fraction:p.x,y_fraction:p.y});
    if(selSig(v)!==sig)throw new Error("selection changed during diagnostic");
    out.push({name,t,projection:p,status:v?.probe?.status||null,picks:(v?.probe?.picks||[]).map(compact)});
  }
  console.log("CF_PHASE0_EDGEVIEW_STACKS="+JSON.stringify(out));
  const any=out.some(x=>x.picks.some(p=>p.deterministic_id==="JHt"));
  const first=out.some(x=>x.picks[0]?.deterministic_id==="JHt");
  console.log("CF_PHASE0_EDGEVIEW_CLASSIFICATION="+JSON.stringify({target:"JHt",present_any_hit_stack:any,first_hit_any_probe:first}));
  console.log("CF_PHASE0_EDGEVIEW=pass");
} finally {await c.close().catch(()=>{});}
NODE

PYTHONPATH="$release/server-deploy/current/fabric-src" python3 - <<'PY'
from capability_fabric.persistence import SqliteExecutionStateStore
p="/var/lib/capability-fabric/onshape-research-phase0/fabric-state/execution.sqlite3"
with SqliteExecutionStateStore(p) as s: assert not s.recoverable()
print("CF_PHASE0_EDGEVIEW_POST_RECOVERABLE=zero")
PY
