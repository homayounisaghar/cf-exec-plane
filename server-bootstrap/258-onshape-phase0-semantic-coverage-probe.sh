#!/usr/bin/env bash
set -euo pipefail
umask 077
[[ "$(id -u)" -eq 0 ]] || exit 2
candidate="a8662707e1dc32a68d6665d6ec98bbe113e3b750"
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
print("CF_PHASE0_COVER_PRODUCTION_BOUNDARY=pass")
print("CF_PHASE0_COVER_CONTROL_REV="+str(d["controlRevision"]))
print("CF_PHASE0_COVER_EPOCH="+str(a["productionEpoch"]))
PY

for c in "$research" "$sidecar"; do
  [[ "$(docker inspect -f '{{.State.Running}}' "$c" 2>/dev/null || echo false)" == true ]]
  [[ "$(docker inspect -f '{{.State.Health.Status}}' "$c")" == healthy ]]
done
env_dump="$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$research")"
grep -Fxq "CF_RESEARCH_SOURCE_COMMIT=$candidate" <<<"$env_dump"
grep -Fxq "CF_RESEARCH_FIXTURE_TARGET=$fixture" <<<"$env_dump"
echo CF_PHASE0_COVER_BINDING=pass

PYTHONPATH="$release/server-deploy/current/fabric-src" python3 - <<'PY'
from capability_fabric.persistence import SqliteExecutionStateStore
p="/var/lib/capability-fabric/onshape-research-phase0/fabric-state/execution.sqlite3"
with SqliteExecutionStateStore(p) as s:
    assert not s.recoverable()
print("CF_PHASE0_COVER_RECOVERABLE=zero")
PY

docker exec -e CF_FIXTURE="$fixture" -i "$research" sh -lc 'cd /tmp/app && node --input-type=module' <<'NODE'
import fs from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const [did,wid,eid]=process.env.CF_FIXTURE.split(":");
const token=fs.readFileSync("/run/secrets/mcp-token","utf8").trim();
const c=new Client({name:"cf-phase0-semantic-coverage-probe",version:"1.0"});
await c.connect(new StreamableHTTPClientTransport(new URL("http://127.0.0.1:8898/mcp/"+token)));
const parse=r=>JSON.parse((r.content||[]).filter(x=>x.type==="text").map(x=>x.text).join("\n"));
const call=async(name,args={})=>parse(await c.callTool({name,arguments:args},undefined,{timeout:180000}));
const viewer=async(params)=>{
  const w=await call("onshape_ui_native",{document_id:did,workspace_id:wid,element_id:eid,action:"runtime.viewer",params});
  const r=w.result;
  if(r?.outcome?.state!=="ACHIEVED"||r?.observation?.ackState!=="ACKNOWLEDGED") throw new Error(JSON.stringify(r));
  return r.observation.evidence.result;
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
  return {x_fraction:(vx-left)/(right-left),y_fraction:(top-vy)/(top-bottom),view:[vx,vy,q[2]/q[3]]};
};
try{
  const st=await call("onshape_session_status");
  if(st?.auth?.state!=="PROVEN"||st?.auth?.http_status!==200) throw new Error("auth");
  console.log("CF_PHASE0_COVER_AUTH=PROVEN");
  const scan=await viewer({op:"selection_scan"});
  const anchor=await viewer({op:"probe",x_fraction:.52,y_fraction:.50});
  const anchorPicks=anchor?.probe?.picks||[];
  const face=anchorPicks.find(x=>x?.deterministic_id==="JHK");
  if(!face) throw new Error("JHK read-only anchor probe absent");
  const flat=face?.entity_metadata?.meshIncrement?.points;
  if(!Array.isArray(flat)||flat.length<30) throw new Error("JHK mesh absent");
  console.log("CF_PHASE0_COVER_FACE_ANCHOR="+JSON.stringify({
    status:anchor?.probe?.status||null,deterministic_id:face.deterministic_id,id:face.id,
    body_id:face?.getters?.body_id??null,is_face:face?.getters?.is_face??null,
    model_selection_count:anchor?.model_selection?.count??null
  }));
  const pts=triples(flat);
  const candidates=[
    {name:"edge_left_0_1",world:mid(pts[0],pts[1])},
    {name:"edge_bottom_1_2",world:mid(pts[1],pts[2])},
    {name:"edge_top_8_9",world:mid(pts[8],pts[9])}
  ];
  const out=[];
  for(const q of candidates){
    const p=project(q.world,scan.view_data);
    const v=await viewer({op:"probe",x_fraction:p.x_fraction,y_fraction:p.y_fraction});
    out.push({
      name:q.name,world:q.world,projection:p,
      status:v?.probe?.status||null,
      picks:(v?.probe?.picks||[]).map(x=>({
        deterministic_id:x.deterministic_id,id:x.id,occurrence_id:x.occurrence_id,primitive_id:x.primitive_id,
        getters:x.getters,entity_metadata:x.entity_metadata
      }))
    });
  }
  console.log("CF_PHASE0_COVER_PROBES="+JSON.stringify(out));
  console.log("CF_PHASE0_COVER=pass");
} finally { await c.close().catch(()=>{}); }
NODE

PYTHONPATH="$release/server-deploy/current/fabric-src" python3 - <<'PY'
from capability_fabric.persistence import SqliteExecutionStateStore
p="/var/lib/capability-fabric/onshape-research-phase0/fabric-state/execution.sqlite3"
with SqliteExecutionStateStore(p) as s:
    assert not s.recoverable()
print("CF_PHASE0_COVER_POST_RECOVERABLE=zero")
PY
