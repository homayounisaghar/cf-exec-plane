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
print("CF_PHASE0_CAMREST_PRODUCTION_BOUNDARY=pass")
print("CF_PHASE0_CAMREST_CONTROL_REV="+str(d["controlRevision"]))
print("CF_PHASE0_CAMREST_EPOCH="+str(a["productionEpoch"]))
PY

for c in "$research" "$sidecar"; do
  [[ "$(docker inspect -f '{{.State.Running}}' "$c" 2>/dev/null || echo false)" == true ]]
  [[ "$(docker inspect -f '{{.State.Health.Status}}' "$c")" == healthy ]]
done
env_dump="$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$research")"
grep -Fxq "CF_RESEARCH_SOURCE_COMMIT=$candidate" <<<"$env_dump"
grep -Fxq "CF_RESEARCH_FIXTURE_TARGET=$fixture" <<<"$env_dump"
echo CF_PHASE0_CAMREST_BINDING=pass

PYTHONPATH="$release/server-deploy/current/fabric-src" python3 - <<'PY'
from capability_fabric.persistence import SqliteExecutionStateStore
p="/var/lib/capability-fabric/onshape-research-phase0/fabric-state/execution.sqlite3"
with SqliteExecutionStateStore(p) as s:
    pending=s.recoverable()
    assert not pending, [(x.operation.operation_id if x.operation else None,x.attempt.attempt_id if x.attempt else None) for x in pending]
print("CF_PHASE0_CAMREST_RECOVERABLE=zero")
PY

docker exec -e CF_FIXTURE="$fixture" -i "$research" sh -lc 'cd /tmp/app && node --input-type=module' <<'NODE'
import fs from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const TARGET=[
  0.8660254057273916,0.49999999663470657,6.730586890502096e-9,0,
  -0.25,0.4330126941204071,0.8660253882408142,0,
  0.4330126941204071,-0.75,0.5,0,
  0.043269168078881634,-0.06094440028949133,0.049962932337082704,1
];
const TOL=5e-4;
const CAL=16;
const MAX_CORRECTION=100;
const MAX_ITERS=4;

const [did,wid,eid]=process.env.CF_FIXTURE.split(":");
const token=fs.readFileSync("/run/secrets/mcp-token","utf8").trim();
const c=new Client({name:"cf-phase0-camera-restore",version:"1.0"});
await c.connect(new StreamableHTTPClientTransport(new URL("http://127.0.0.1:8898/mcp/"+token)));

const parse=r=>JSON.parse((r.content||[]).filter(x=>x.type==="text").map(x=>x.text).join("\n"));
const call=async(name,args={})=>parse(await c.callTool({name,arguments:args},undefined,{timeout:180000}));
const viewer=async()=>{
  const w=await call("onshape_ui_native",{document_id:did,workspace_id:wid,element_id:eid,action:"runtime.viewer",params:{op:"selection_scan"}});
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
  console.log("CF_PHASE0_CAMREST_INPUT_"+label+"="+JSON.stringify({
    outcome:r?.outcome||null,observation:r?.observation||null
  }));
  if(r?.outcome?.state!=="ACHIEVED"||r?.observation?.ackState!=="ACKNOWLEDGED") throw new Error(label+" input not achieved");
  return r;
};
const matrix=v=>v?.view_data?.viewMatrix;
const maxErr=(a,b)=>Math.max(...a.map((x,i)=>Math.abs(Number(x)-Number(b[i]))));
const trans=a=>[Number(a[12]),Number(a[13]),Number(a[14])];
const sub=(a,b)=>a.map((x,i)=>x-b[i]);
const scale=(a,s)=>a.map(x=>x/s);
const dot=(a,b)=>a.reduce((s,x,i)=>s+x*b[i],0);
const clamp=(x,lo,hi)=>Math.max(lo,Math.min(hi,x));
const solve2=(bx,by,e)=>{
  const aa=dot(bx,bx), ab=dot(bx,by), bb=dot(by,by);
  const ae=dot(bx,e), be=dot(by,e);
  const det=aa*bb-ab*ab;
  if(Math.abs(det)<1e-16) throw new Error("pan calibration basis singular");
  return [(ae*bb-be*ab)/det,(be*aa-ae*ab)/det];
};

try{
  const tools=(await c.listTools()).tools;
  const native=tools.find(x=>x.name==="onshape_ui_native");
  const actionEnum=native?.inputSchema?.properties?.action?.enum||[];
  if(!actionEnum.includes("runtime.viewer")) throw new Error("runtime.viewer absent");
  console.log("CF_PHASE0_CAMREST_SCHEMA=runtime.viewer");

  const st=await call("onshape_session_status");
  if(st?.auth?.state!=="PROVEN"||st?.auth?.http_status!==200) throw new Error("auth");
  console.log("CF_PHASE0_CAMREST_AUTH=PROVEN");

  const canvas=await nativeEval('(() => {const e=document.querySelector("#canvas"),r=e?.getBoundingClientRect();return r?{x:r.x,y:r.y,w:r.width,h:r.height}:null})()');
  if(!canvas||canvas.w<=1||canvas.h<=1) throw new Error("canvas");
  const origin={x:Math.round(canvas.x+canvas.w*.30),y:Math.round(canvas.y+canvas.h*.30)};
  const pan=async(label,dx,dy)=>{
    const x2=origin.x+Math.round(dx), y2=origin.y+Math.round(dy);
    return input(label,[
      {action:"mouse.move",x:origin.x,y:origin.y,steps:1},
      {action:"mouse.down",button:"middle"},
      {action:"mouse.move",x:x2,y:y2,steps:6},
      {action:"mouse.up",button:"middle",after_ms:160}
    ]);
  };

  const initial=await viewer();
  const m0=matrix(initial);
  if(!Array.isArray(m0)||m0.length!==16) throw new Error("initial view matrix");
  const initialErr=maxErr(m0,TARGET);
  console.log("CF_PHASE0_CAMREST_INITIAL="+JSON.stringify({
    error_max_abs:initialErr,tolerance:TOL,current:m0,target:TARGET,
    camera:initial.camera,selection_count:initial?.model_selection?.count??null
  }));
  if(!(initialErr>TOL)) throw new Error("camera already inside restore tolerance; controller qualification needs displaced start");

  await pan("CAL_X",CAL,0);
  const sx=await viewer(), mx=matrix(sx);
  const dxm=maxErr(mx,m0);
  if(!(dxm>1e-9)) throw new Error("x calibration produced no measured camera response");

  await pan("CAL_Y",0,CAL);
  const sy=await viewer(), my=matrix(sy);
  const dym=maxErr(my,mx);
  if(!(dym>1e-9)) throw new Error("y calibration produced no measured camera response");

  const bx=scale(sub(trans(mx),trans(m0)),CAL);
  const by=scale(sub(trans(my),trans(mx)),CAL);
  console.log("CF_PHASE0_CAMREST_CALIBRATION="+JSON.stringify({
    cal_pixels:CAL,basis_x:bx,basis_y:by,x_matrix_delta:dxm,y_matrix_delta:dym
  }));

  let cur=my;
  let err=maxErr(cur,TARGET);
  const iterations=[];
  for(let i=0;i<MAX_ITERS && err>TOL;i++){
    const e=sub(trans(TARGET),trans(cur));
    const sol=solve2(bx,by,e);
    const px=clamp(Math.round(sol[0]),-MAX_CORRECTION,MAX_CORRECTION);
    const py=clamp(Math.round(sol[1]),-MAX_CORRECTION,MAX_CORRECTION);
    if(px===0&&py===0) throw new Error("controller quantized to zero outside tolerance");
    const before=err;
    await pan("CORR_"+(i+1),px,py);
    const v=await viewer();
    const next=matrix(v);
    const after=maxErr(next,TARGET);
    const rec={iteration:i+1,command_px:[px,py],raw_solution_px:sol,error_before:before,error_after:after,matrix:next};
    iterations.push(rec);
    console.log("CF_PHASE0_CAMREST_ITER="+JSON.stringify(rec));
    if(after>TOL && !(after<before-1e-9)) throw new Error("camera restore error did not decrease");
    cur=next; err=after;
  }

  const final=await viewer();
  const fm=matrix(final);
  const finalErr=maxErr(fm,TARGET);
  const selected=final?.model_selection?.selections||[];
  console.log("CF_PHASE0_CAMREST_FINAL="+JSON.stringify({
    error_max_abs:finalErr,tolerance:TOL,iterations,
    final_matrix:fm,target:TARGET,
    selection_count:selected.length,
    selected:selected.map(x=>({deterministic_id:x.deterministic_id,is_face:x.is_face}))
  }));
  if(!(finalErr<=TOL)) throw new Error("camera restore tolerance not achieved");
  console.log("CF_PHASE0_CAMREST=pass");
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
print("CF_PHASE0_CAMREST_POST_RECOVERABLE=zero")
PY
