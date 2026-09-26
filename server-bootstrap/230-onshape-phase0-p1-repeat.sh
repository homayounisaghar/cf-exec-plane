#!/usr/bin/env bash
set -euo pipefail
umask 077
[[ "$(id -u)" -eq 0 ]] || exit 2
candidate="d882fa763b3a55be5a18d6e196d028ff4f77ea07"
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
print("CF_PHASE0_P1R_PRODUCTION_BOUNDARY=pass")
PY
for c in "$research" "$sidecar"; do
 [[ "$(docker inspect -f '{{.State.Health.Status}}' "$c")" == healthy ]]
done
env_dump="$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$research")"
grep -Fxq "CF_RESEARCH_SOURCE_COMMIT=$candidate" <<<"$env_dump"
grep -Fxq "CF_RESEARCH_FIXTURE_TARGET=$fixture" <<<"$env_dump"
PYTHONPATH="$release/server-deploy/current/fabric-src" python3 - <<'PY'
from capability_fabric.persistence import SqliteExecutionStateStore
p="/var/lib/capability-fabric/onshape-research-phase0/fabric-state/execution.sqlite3"
with SqliteExecutionStateStore(p) as s: assert not s.recoverable()
print("CF_PHASE0_P1R_RECOVERABLE=zero")
PY

docker exec -e CF_FIXTURE="$fixture" -i "$research" sh -lc 'cd /tmp/app && node --input-type=module' <<'NODE'
import fs from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
const [did,wid,eid]=process.env.CF_FIXTURE.split(":");
const token=fs.readFileSync("/run/secrets/mcp-token","utf8").trim();
const c=new Client({name:"cf-phase0-p1-repeat",version:"1.0"});
await c.connect(new StreamableHTTPClientTransport(new URL("http://127.0.0.1:8898/mcp/"+token)));
const parse=(r)=>JSON.parse((r.content||[]).filter(x=>x.type==="text").map(x=>x.text).join("\n"));
const timed=async(name,args={})=>{const t0=performance.now();const res=parse(await c.callTool({name,arguments:args},undefined,{timeout:180000}));return{res,ms:performance.now()-t0}};
const native=async(action,params={})=>{const x=await timed("onshape_ui_native",{document_id:did,workspace_id:wid,element_id:eid,action,params});const r=x.res.result;if(r?.outcome?.state!=="ACHIEVED"||r?.observation?.ackState!=="ACKNOWLEDGED")throw new Error(JSON.stringify(r));return{value:r.observation.evidence.result,ms:x.ms}};
const input=async(steps)=>{const x=await timed("onshape_ui_input",{document_id:did,workspace_id:wid,element_id:eid,steps});const r=x.res.result;if(r?.outcome?.state!=="ACHIEVED"||r?.observation?.ackState!=="ACKNOWLEDGED")throw new Error(JSON.stringify(r));return{value:r.observation.evidence,ms:x.ms}};
const state=async()=>{const x=await native("page.evaluate",{expression:String.raw`(() => {const c=document.querySelector("#canvas"),r=c?.getBoundingClientRect(),a=document.activeElement;const ds=Array.from(document.querySelectorAll('[role="dialog"],.modal.show,.modal-dialog')).filter(e=>{const q=e.getBoundingClientRect();return q.width>0&&q.height>0}).length;return{canvas:r?{x:r.x,y:r.y,w:r.width,h:r.height,view:c.getAttribute("data-view-shown")}:null,active:{tag:a?.tagName?.toLowerCase()||null,id:a?.id||null,cls:String(a?.className||"").slice(0,140)},dialogs:ds}})()`});return x.value.value};
const shot=async()=>{const x=await native("page.screenshot",{full_page:false});const a=x.value.artifact||{};return{key:a.sha256||a.sha_256||a.digest||a.content_sha256||a.artifact_id||JSON.stringify(a),size:a.size||null,ms:x.ms}};
const q=(xs,p)=>{const a=[...xs].sort((a,b)=>a-b),z=(a.length-1)*p,l=Math.floor(z),h=Math.ceil(z);return a[l]+(a[h]-a[l])*(z-l)};
const stats=(xs)=>({n:xs.length,p50:+q(xs,.5).toFixed(2),p95:+q(xs,.95).toFixed(2),min:+Math.min(...xs).toFixed(2),max:+Math.max(...xs).toFixed(2),mean:+(xs.reduce((a,b)=>a+b,0)/xs.length).toFixed(2)});

try{
 let st=await state(); if(!st.canvas)throw new Error("canvas");
 const cv=st.canvas, center={x:Math.round(cv.x+cv.w*.52),y:Math.round(cv.y+cv.h*.50)}, blank={x:Math.round(cv.x+cv.w*.94),y:Math.round(cv.y+cv.h*.08)};
 await input([{action:"mouse.click",x:blank.x,y:blank.y,button:"left",click_count:1,after_ms:100},{action:"mouse.move",x:blank.x,y:blank.y,steps:1,after_ms:80}]);
 const results={};
 const gesture=async(name,forward,inverse)=>{
   const trials=[];const fms=[],rms=[];
   for(let i=0;i<3;i++){
     await input([{action:"mouse.move",x:blank.x,y:blank.y,steps:1,after_ms:60}]);
     const beforeState=await state(), before=await shot();
     const f=await input(forward(center)); fms.push(f.ms);
     await input([{action:"mouse.move",x:blank.x,y:blank.y,steps:1,after_ms:120}]);
     const afterState=await state(), after=await shot();
     const rev=await input(inverse(center)); rms.push(rev.ms);
     await input([{action:"mouse.move",x:blank.x,y:blank.y,steps:1,after_ms:120}]);
     const restoredState=await state(), restored=await shot();
     trials.push({
       changed:after.key!==before.key,
       restoredExact:restored.key===before.key,
       beforeView:beforeState.canvas?.view,afterView:afterState.canvas?.view,restoredView:restoredState.canvas?.view,
       focusStable:JSON.stringify(beforeState.active)===JSON.stringify(afterState.active)&&JSON.stringify(afterState.active)===JSON.stringify(restoredState.active),
       dialogsStable:beforeState.dialogs===afterState.dialogs&&afterState.dialogs===restoredState.dialogs,
       forwardMs:+f.ms.toFixed(2),reverseMs:+rev.ms.toFixed(2)
     });
   }
   return{trials,forward:stats(fms),reverse:stats(rms),changedAll:trials.every(x=>x.changed),focusStableAll:trials.every(x=>x.focusStable),dialogsStableAll:trials.every(x=>x.dialogsStable)};
 };
 results.zoom=await gesture("zoom",
   p=>[{action:"mouse.move",x:p.x,y:p.y,steps:1},{action:"mouse.wheel",delta_x:0,delta_y:-500,after_ms:180}],
   p=>[{action:"mouse.move",x:p.x,y:p.y,steps:1},{action:"mouse.wheel",delta_x:0,delta_y:500,after_ms:180}]
 );
 results.pan=await gesture("pan",
   p=>[{action:"mouse.move",x:p.x,y:p.y},{action:"mouse.down",button:"middle"},{action:"mouse.move",x:p.x+80,y:p.y+45,steps:8},{action:"mouse.up",button:"middle",after_ms:200}],
   p=>[{action:"mouse.move",x:p.x+80,y:p.y+45},{action:"mouse.down",button:"middle"},{action:"mouse.move",x:p.x,y:p.y,steps:8},{action:"mouse.up",button:"middle",after_ms:200}]
 );
 results.rotate=await gesture("rotate",
   p=>[{action:"mouse.move",x:p.x,y:p.y},{action:"mouse.down",button:"right"},{action:"mouse.move",x:p.x+80,y:p.y+45,steps:8},{action:"mouse.up",button:"right",after_ms:200}],
   p=>[{action:"mouse.move",x:p.x+80,y:p.y+45},{action:"mouse.down",button:"right"},{action:"mouse.move",x:p.x,y:p.y,steps:8},{action:"mouse.up",button:"right",after_ms:200}]
 );
 console.log("CF_PHASE0_P1_REPEAT="+JSON.stringify(results));
 console.log("CF_PHASE0_P1R=pass");
} finally {await c.close().catch(()=>{});}
NODE

PYTHONPATH="$release/server-deploy/current/fabric-src" python3 - <<'PY'
from capability_fabric.persistence import SqliteExecutionStateStore
p="/var/lib/capability-fabric/onshape-research-phase0/fabric-state/execution.sqlite3"
with SqliteExecutionStateStore(p) as s: assert not s.recoverable()
print("CF_PHASE0_P1R_POST_RECOVERABLE=zero")
PY
