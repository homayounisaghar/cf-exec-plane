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
print("CF_PHASE0_EDGESEL_PRODUCTION_BOUNDARY=pass")
print("CF_PHASE0_EDGESEL_CONTROL_REV="+str(d["controlRevision"]))
print("CF_PHASE0_EDGESEL_EPOCH="+str(a["productionEpoch"]))
PY
for c in "$research" "$sidecar"; do
 [[ "$(docker inspect -f '{{.State.Health.Status}}' "$c")" == healthy ]]
done
env_dump="$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$research")"
grep -Fxq "CF_RESEARCH_SOURCE_COMMIT=$candidate" <<<"$env_dump"
grep -Fxq "CF_RESEARCH_FIXTURE_TARGET=$fixture" <<<"$env_dump"
echo CF_PHASE0_EDGESEL_BINDING=pass
PYTHONPATH="$release/server-deploy/current/fabric-src" python3 - <<'PY'
from capability_fabric.persistence import SqliteExecutionStateStore
p="/var/lib/capability-fabric/onshape-research-phase0/fabric-state/execution.sqlite3"
with SqliteExecutionStateStore(p) as s: assert not s.recoverable()
print("CF_PHASE0_EDGESEL_RECOVERABLE=zero")
PY
docker exec -e CF_FIXTURE="$fixture" -i "$research" sh -lc 'cd /tmp/app && node --input-type=module' <<'NODE'
import fs from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
const [did,wid,eid]=process.env.CF_FIXTURE.split(":");
const token=fs.readFileSync("/run/secrets/mcp-token","utf8").trim();
const c=new Client({name:"cf-phase0-edge-select",version:"1.0"});
await c.connect(new StreamableHTTPClientTransport(new URL("http://127.0.0.1:8898/mcp/"+token)));
const parse=r=>JSON.parse((r.content||[]).filter(x=>x.type==="text").map(x=>x.text).join("\n"));
const call=async(name,args={})=>parse(await c.callTool({name,arguments:args},undefined,{timeout:180000}));
const viewer=async(params)=>{const w=await call("onshape_ui_native",{document_id:did,workspace_id:wid,element_id:eid,action:"runtime.viewer",params});const r=w.result;if(r?.outcome?.state!=="ACHIEVED"||r?.observation?.ackState!=="ACKNOWLEDGED")throw new Error(JSON.stringify(r));return r.observation.evidence.result};
const evalp=async(expression)=>{const w=await call("onshape_ui_native",{document_id:did,workspace_id:wid,element_id:eid,action:"page.evaluate",params:{expression}});const r=w.result;if(r?.outcome?.state!=="ACHIEVED"||r?.observation?.ackState!=="ACKNOWLEDGED")throw new Error(JSON.stringify(r));return r.observation.evidence.result.value};
const input=async(label,steps)=>{const w=await call("onshape_ui_input",{document_id:did,workspace_id:wid,element_id:eid,steps});const r=w.result;console.log("CF_PHASE0_EDGESEL_INPUT_"+label+"="+JSON.stringify({outcome:r?.outcome,observation:r?.observation}));if(r?.outcome?.state!=="ACHIEVED"||r?.observation?.ackState!=="ACKNOWLEDGED")throw new Error("input");return r};
const triples=f=>{const a=[];for(let i=0;i+2<f.length;i+=3)a.push([+f[i],+f[i+1],+f[i+2]]);return a};
const mid=(a,b)=>[(a[0]+b[0])/2,(a[1]+b[1])/2,(a[2]+b[2])/2];
const inv=a=>{const m=Array.from({length:4},(_,r)=>Array.from({length:4},(_,col)=>Number(a[col*4+r]))),u=m.map((row,r)=>[...row,...Array.from({length:4},(_,cc)=>r===cc?1:0)]);for(let col=0;col<4;col++){let p=col;for(let r=col+1;r<4;r++)if(Math.abs(u[r][col])>Math.abs(u[p][col]))p=r;[u[col],u[p]]=[u[p],u[col]];const d=u[col][col];if(Math.abs(d)<1e-12)throw new Error("singular");for(let j=0;j<8;j++)u[col][j]/=d;for(let r=0;r<4;r++)if(r!==col){const f=u[r][col];for(let j=0;j<8;j++)u[r][j]-=f*u[col][j]}}return u.map(row=>row.slice(4))};
const mul=(m,p)=>m.map(row=>row.reduce((s,x,i)=>s+x*p[i],0));
const project=(w,vd)=>{const q=mul(inv(vd.viewMatrix),[...w,1]),vx=q[0]/q[3],vy=q[1]/q[3],[top,bottom,right,left]=vd.cameraViewport.map(Number);return{x_fraction:(vx-left)/(right-left),y_fraction:(top-vy)/(top-bottom)}};
try{
 const st=await call("onshape_session_status"); if(st?.auth?.state!=="PROVEN"||st?.auth?.http_status!==200)throw new Error("auth");
 console.log("CF_PHASE0_EDGESEL_AUTH=PROVEN");
 const base=await viewer({op:"selection_scan"}); const s=base?.model_selection?.selections||[];
 if(s.length!==1||s[0]?.deterministic_id!=="JHK"||s[0]?.is_face!==true)throw new Error("JHK baseline absent");
 const flat=s[0]?.entity_metadata?.meshIncrement?.points||s[0]?.source_pick?.entity_metadata?.meshIncrement?.points;
 const pts=triples(flat); const p=project(mid(pts[1],pts[2]),base.view_data);
 const probe=await viewer({op:"probe",x_fraction:p.x_fraction,y_fraction:p.y_fraction});
 const target=probe?.probe?.picks?.[0];
 console.log("CF_PHASE0_EDGESEL_PRE="+JSON.stringify({projection:p,probe:probe.probe}));
 if(probe?.probe?.status!=="HIT"||target?.deterministic_id!=="JHt"||target?.entity_metadata?.meshIncrement?.primitiveType!==1)throw new Error("JHt edge precondition absent");
 const canvas=await evalp('(() => {const e=document.querySelector("#canvas"),r=e?.getBoundingClientRect();return r?{x:r.x,y:r.y,w:r.width,h:r.height}:null})()');
 const xy={x:Math.round(canvas.x+canvas.w*p.x_fraction),y:Math.round(canvas.y+canvas.h*p.y_fraction)};
 await input("COMMIT",[{action:"mouse.click",x:xy.x,y:xy.y,button:"left",click_count:1,after_ms:180}]);
 const away={x:Math.round(canvas.x+canvas.w*.90),y:Math.round(canvas.y+canvas.h*.88)};
 await input("AWAY",[{action:"mouse.move",x:away.x,y:away.y,steps:1,after_ms:120}]);
 const post=await viewer({op:"selection_scan"}); const ps=post?.model_selection?.selections||[];
 console.log("CF_PHASE0_EDGESEL_POST="+JSON.stringify({model_selection:post.model_selection,selection_scan:post.selection_scan}));
 if(ps.length!==1||ps[0]?.deterministic_id!=="JHt"||ps[0]?.is_edge!==true)throw new Error("authoritative edge mismatch");
 console.log("CF_PHASE0_EDGESEL=pass");
} finally {await c.close().catch(()=>{})}
NODE
PYTHONPATH="$release/server-deploy/current/fabric-src" python3 - <<'PY'
from capability_fabric.persistence import SqliteExecutionStateStore
p="/var/lib/capability-fabric/onshape-research-phase0/fabric-state/execution.sqlite3"
with SqliteExecutionStateStore(p) as s: assert not s.recoverable()
print("CF_PHASE0_EDGESEL_POST_RECOVERABLE=zero")
PY
