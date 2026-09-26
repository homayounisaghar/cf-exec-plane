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
print("CF_PHASE0_SEM_PRODUCTION_BOUNDARY=pass")
print("CF_PHASE0_SEM_CONTROL_REV="+str(d["controlRevision"]))
print("CF_PHASE0_SEM_EPOCH="+str(a["productionEpoch"]))
PY
for c in "$research" "$sidecar"; do
 [[ "$(docker inspect -f '{{.State.Running}}' "$c" 2>/dev/null || echo false)" == true ]]
 [[ "$(docker inspect -f '{{.State.Health.Status}}' "$c")" == healthy ]]
done
env_dump="$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$research")"
grep -Fxq "CF_RESEARCH_SOURCE_COMMIT=$candidate" <<<"$env_dump"
grep -Fxq "CF_RESEARCH_FIXTURE_TARGET=$fixture" <<<"$env_dump"
echo CF_PHASE0_SEM_BINDING=pass
PYTHONPATH="$release/server-deploy/current/fabric-src" python3 - <<'PY'
from capability_fabric.persistence import SqliteExecutionStateStore
p="/var/lib/capability-fabric/onshape-research-phase0/fabric-state/execution.sqlite3"
with SqliteExecutionStateStore(p) as s:
    pending=s.recoverable()
    assert not pending, [(x.operation.operation_id if x.operation else None,x.attempt.attempt_id if x.attempt else None) for x in pending]
print("CF_PHASE0_SEM_RECOVERABLE=zero")
PY

docker exec -e CF_FIXTURE="$fixture" -i "$research" sh -lc 'cd /tmp/app && node --input-type=module' <<'NODE'
import fs from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const [did,wid,eid]=process.env.CF_FIXTURE.split(":");
const token=fs.readFileSync("/run/secrets/mcp-token","utf8").trim();
const client=new Client({name:"cf-phase0-semantic-probe",version:"1.0"});
await client.connect(new StreamableHTTPClientTransport(new URL("http://127.0.0.1:8898/mcp/"+token)));
const parse=(r)=>JSON.parse((r.content||[]).filter(x=>x.type==="text").map(x=>x.text).join("\n"));
const timed=async(name,args={})=>{const t0=performance.now(); const res=parse(await client.callTool({name,arguments:args},undefined,{timeout:180000})); return {res,ms:performance.now()-t0};};
const native=async(expression)=>{
 const x=await timed("onshape_ui_native",{document_id:did,workspace_id:wid,element_id:eid,action:"page.evaluate",params:{expression}});
 const r=x.res.result;
 if(r?.outcome?.state!=="ACHIEVED"||r?.observation?.ackState!=="ACKNOWLEDGED") throw new Error("native "+JSON.stringify(r));
 return {value:r.observation.evidence.result.value,ms:x.ms};
};
const input=async(steps)=>{
 const x=await timed("onshape_ui_input",{document_id:did,workspace_id:wid,element_id:eid,steps});
 const r=x.res.result;
 if(r?.outcome?.state!=="ACHIEVED"||r?.observation?.ackState!=="ACKNOWLEDGED") throw new Error("input "+JSON.stringify(r));
 return {value:r.observation.evidence,ms:x.ms};
};
const q=(xs,p)=>{const a=[...xs].sort((a,b)=>a-b);const z=(a.length-1)*p,l=Math.floor(z),h=Math.ceil(z);return a[l]+(a[h]-a[l])*(z-l)};
const stats=(xs)=>({n:xs.length,min:+Math.min(...xs).toFixed(2),p50:+q(xs,.5).toFixed(2),p95:+q(xs,.95).toFixed(2),max:+Math.max(...xs).toFixed(2),mean:+(xs.reduce((a,b)=>a+b,0)/xs.length).toFixed(2)});

const stateExpr=String.raw`(() => {
 const clean=(v,n=220)=>String(v??"").replace(/\s+/g," ").trim().slice(0,n);
 const rel=Array.from(document.querySelectorAll(".related-highlight")).slice(0,30).map(el=>({
   tag:el.tagName?.toLowerCase()||null,cls:clean(el.className,140),text:clean(el.textContent,160),
   dataId:el.getAttribute("data-id"),featureId:el.getAttribute("feature-id"),featureType:el.getAttribute("feature-type")
 }));
 const sel=Array.from(document.querySelectorAll('[aria-selected="true"],[class~="selected"],[class~="selection"]')).slice(0,30).map(el=>({
   tag:el.tagName?.toLowerCase()||null,cls:clean(el.className,140),text:clean(el.textContent,160),
   dataId:el.getAttribute("data-id"),featureId:el.getAttribute("feature-id")
 }));
 const c=document.querySelector("#canvas"), r=c?.getBoundingClientRect();
 const active=document.activeElement;
 const dialogs=Array.from(document.querySelectorAll('[role="dialog"],.modal.show,.modal-dialog')).filter(el=>{const x=el.getBoundingClientRect();return x.width>0&&x.height>0}).slice(0,20).map(el=>clean(el.textContent,180));
 const controls=Array.from(document.querySelectorAll('[data-bs-original-title],[title],[aria-label]')).map(el=>{
   const title=el.getAttribute("data-bs-original-title")||el.getAttribute("title")||el.getAttribute("aria-label")||"";
   const rr=el.getBoundingClientRect();
   return {title:clean(title,160),tag:el.tagName?.toLowerCase()||null,cls:clean(el.className,120),x:rr.x,y:rr.y,w:rr.width,h:rr.height};
 }).filter(x=>x.w>0&&x.h>0&&/(fit|trimetric|isometric|top|front|right|left|bottom|view|zoom|perspective)/i.test(x.title)).slice(0,80);
 const measure=Array.from(document.querySelectorAll("body *")).filter(el=>{
   const t=clean(el.textContent,400);
   const rr=el.getBoundingClientRect();
   return rr.width>0&&rr.height>0&&el.children.length<10&&/(Area\s*:|Length\s*:|Volume\s*:|Radius\s*:|Mass\s*:|Face of|Edge of|Vertex of)/i.test(t);
 }).slice(0,20).map(el=>clean(el.textContent,400));
 return {
   related:rel,selected:sel,
   canvas:r?{x:r.x,y:r.y,w:r.width,h:r.height,view:c.getAttribute("data-view-shown")}:null,
   active:{tag:active?.tagName?.toLowerCase()||null,id:active?.id||null,cls:clean(active?.className,160)},
   dialogs,controls,measure
 };
})()`;
const readState=()=>native(stateExpr);
const ids=(st)=>[...new Set((st.related||[]).map(x=>x.dataId||x.featureId||x.text).filter(Boolean))].sort();

try{
 const status=await timed("onshape_session_status",{});
 if(status.res?.auth?.state!=="PROVEN") throw new Error("auth not proven");
 console.log("CF_PHASE0_SEM_AUTH=pass");

 // A0 no-effect control round trip.
 const echo=[];
 for(let i=0;i<15;i++){const x=await timed("cf_echo",{text:"phase0-a0"}); if(x.res?.echo!=="phase0-a0") throw new Error("echo"); echo.push(x.ms);}
 console.log("CF_PHASE0_A0_CONTROL_MS="+JSON.stringify(stats(echo)));

 // A0 observation round trip.
 const obs=[];
 for(let i=0;i<9;i++){const x=await native("({href:location.href,ready:document.readyState})"); obs.push(x.ms);}
 console.log("CF_PHASE0_A0_OBSERVATION2_MS="+JSON.stringify(stats(obs)));

 let s=await readState(); if(!s.value.canvas) throw new Error("canvas missing");
 const c=s.value.canvas;
 const points=[
   {x:Math.round(c.x+c.w*.46),y:Math.round(c.y+c.h*.48)},
   {x:Math.round(c.x+c.w*.52),y:Math.round(c.y+c.h*.50)},
   {x:Math.round(c.x+c.w*.58),y:Math.round(c.y+c.h*.52)}
 ];
 const blank={x:Math.round(c.x+c.w*.94),y:Math.round(c.y+c.h*.08)};
 console.log("CF_PHASE0_P3_INITIAL="+JSON.stringify({view:c.view,controls:s.value.controls}));

 // Clear persistent selection then leave pointer on blank.
 await input([{action:"mouse.click",x:blank.x,y:blank.y,button:"left",click_count:1,after_ms:160},{action:"mouse.move",x:blank.x,y:blank.y,steps:1,after_ms:120}]);
 let clear=(await readState()).value;
 console.log("CF_PHASE0_P2_CLEAR_BASE="+JSON.stringify({ids:ids(clear),dialogs:clear.dialogs,active:clear.active,view:clear.canvas?.view}));

 // P2: exactly three exploratory probes; each probe is move + independent semantic-state read.
 const probes=[]; const probeTimes=[];
 for(const p of points){
   const t0=performance.now();
   const mv=await input([{action:"mouse.move",x:p.x,y:p.y,steps:1,after_ms:140}]);
   const hit=(await readState()).value;
   const total=performance.now()-t0; probeTimes.push(total);
   await input([{action:"mouse.move",x:blank.x,y:blank.y,steps:1,after_ms:140}]);
   const after=(await readState()).value;
   probes.push({point:p,moveMs:+mv.ms.toFixed(2),probeMs:+total.toFixed(2),hitIds:ids(hit),hitRelated:hit.related,afterIds:ids(after),dialogsBefore:clear.dialogs.length,dialogsHit:hit.dialogs.length,dialogsAfter:after.dialogs.length,activeHit:hit.active,activeAfter:after.active});
 }
 console.log("CF_PHASE0_P2_PROBES="+JSON.stringify(probes));
 console.log("CF_PHASE0_A0_IDENTITY_PROBE_MS="+JSON.stringify(stats(probeTimes)));

 const hitProbe=probes.find(x=>x.hitIds.length>0&&x.afterIds.length===0);
 console.log("CF_PHASE0_P2_TEMPORAL_VERDICT="+JSON.stringify({
   semanticHoverAvailable:!!hitProbe,
   selectedPoint:hitProbe?.point||null,
   selectedIds:hitProbe?.hitIds||[],
   noPersistentHighlight:!!hitProbe,
   dialogStable:probes.every(x=>x.dialogsBefore===x.dialogsHit&&x.dialogsHit===x.dialogsAfter)
 }));

 // Current sequence API can batch moves but exposes only action completion, not per-step semantic identities.
 const bt=await input(points.map(p=>({action:"mouse.move",x:p.x,y:p.y,steps:1,after_ms:30})));
 console.log("CF_PHASE0_P2_BATCH_TRANSPORT="+JSON.stringify({ms:+bt.ms.toFixed(2),requested:bt.value.requestedSteps,completed:bt.value.completedSteps,actions:bt.value.actions,perPointIdentity:false}));
 await input([{action:"mouse.move",x:blank.x,y:blank.y,steps:1,after_ms:100}]);

 // P4: choose a point that produced a semantic hover, then commit and read back after pointer leaves.
 const target=hitProbe?.point||points[1];
 const commitTimes=[],readTimes=[],cycles=[];
 for(let i=0;i<3;i++){
   // start clear
   await input([{action:"mouse.click",x:blank.x,y:blank.y,button:"left",click_count:1,after_ms:120},{action:"mouse.move",x:blank.x,y:blank.y,steps:1,after_ms:80}]);
   const pre=(await readState()).value;
   const cm=await input([{action:"mouse.click",x:target.x,y:target.y,button:"left",click_count:1,after_ms:160}]); commitTimes.push(cm.ms);
   await input([{action:"mouse.move",x:blank.x,y:blank.y,steps:1,after_ms:120}]);
   const t0=performance.now(); const rb=(await readState()); readTimes.push(performance.now()-t0);
   cycles.push({preIds:ids(pre),postIds:ids(rb.value),related:rb.value.related,measure:rb.value.measure,dialogs:rb.value.dialogs,active:rb.value.active});
 }
 console.log("CF_PHASE0_P4_CYCLES="+JSON.stringify({target,cycles}));
 console.log("CF_PHASE0_A0_SELECTION_COMMIT2_MS="+JSON.stringify(stats(commitTimes)));
 console.log("CF_PHASE0_A0_SELECTION_READBACK_MS="+JSON.stringify(stats(readTimes)));

 const nonempty=cycles.map(x=>x.postIds).filter(x=>x.length);
 const stableBody=nonempty.length===cycles.length && nonempty.every(x=>JSON.stringify(x)===JSON.stringify(nonempty[0]));
 console.log("CF_PHASE0_P4_TEMPORAL_VERDICT="+JSON.stringify({persistentSemanticIds:stableBody?nonempty[0]:[],stableAcrossCycles:stableBody,cycles:cycles.length,scope:"UI-semantic related-highlight body/feature relationship; face/edge identity not yet established"}));

 // Leave selection clear and pointer blank.
 await input([{action:"mouse.click",x:blank.x,y:blank.y,button:"left",click_count:1,after_ms:120},{action:"mouse.move",x:blank.x,y:blank.y,steps:1,after_ms:100}]);
 console.log("CF_PHASE0_SEM=pass");
} finally {await client.close().catch(()=>{});}
NODE

PYTHONPATH="$release/server-deploy/current/fabric-src" python3 - <<'PY'
from capability_fabric.persistence import SqliteExecutionStateStore
p="/var/lib/capability-fabric/onshape-research-phase0/fabric-state/execution.sqlite3"
with SqliteExecutionStateStore(p) as s:
    pending=s.recoverable()
    assert not pending, [(x.operation.operation_id if x.operation else None,x.attempt.attempt_id if x.attempt else None) for x in pending]
print("CF_PHASE0_SEM_POST_RECOVERABLE=zero")
PY
