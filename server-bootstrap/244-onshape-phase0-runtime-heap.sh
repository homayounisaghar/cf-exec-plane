#!/usr/bin/env bash
set -euo pipefail
umask 077
[[ "$(id -u)" -eq 0 ]] || exit 2
candidate="17ae77556fb2581bdeb72985c5e2645e7b697bc0"
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
print("CF_PHASE0_HEAP_PRODUCTION_BOUNDARY=pass")
print("CF_PHASE0_HEAP_CONTROL_REV="+str(d["controlRevision"]))
print("CF_PHASE0_HEAP_EPOCH="+str(a["productionEpoch"]))
PY
for c in "$research" "$sidecar"; do
 [[ "$(docker inspect -f '{{.State.Running}}' "$c" 2>/dev/null || echo false)" == true ]]
 [[ "$(docker inspect -f '{{.State.Health.Status}}' "$c")" == healthy ]]
done
env_dump="$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$research")"
grep -Fxq "CF_RESEARCH_SOURCE_COMMIT=$candidate" <<<"$env_dump"
grep -Fxq "CF_RESEARCH_FIXTURE_TARGET=$fixture" <<<"$env_dump"
echo CF_PHASE0_HEAP_BINDING=pass
PYTHONPATH="$release/server-deploy/current/fabric-src" python3 - <<'PY'
from capability_fabric.persistence import SqliteExecutionStateStore
p="/var/lib/capability-fabric/onshape-research-phase0/fabric-state/execution.sqlite3"
with SqliteExecutionStateStore(p) as s:
    pending=s.recoverable()
    assert not pending, [(x.operation.operation_id if x.operation else None,x.attempt.attempt_id if x.attempt else None) for x in pending]
print("CF_PHASE0_HEAP_RECOVERABLE=zero")
PY

docker exec -e CF_FIXTURE="$fixture" -i "$research" sh -lc 'cd /tmp/app && node --input-type=module' <<'NODE'
import fs from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
const [did,wid,eid]=process.env.CF_FIXTURE.split(":");
const token=fs.readFileSync("/run/secrets/mcp-token","utf8").trim();
const c=new Client({name:"cf-phase0-heap",version:"1.0"});
await c.connect(new StreamableHTTPClientTransport(new URL("http://127.0.0.1:8898/mcp/"+token)));
const parse=(r)=>JSON.parse((r.content||[]).filter(x=>x.type==="text").map(x=>x.text).join("\n"));
const call=async(name,args={})=>parse(await c.callTool({name,arguments:args},undefined,{timeout:180000}));
const native=async(action,params={})=>{const w=await call("onshape_ui_native",{document_id:did,workspace_id:wid,element_id:eid,action,params});const r=w.result;if(r?.outcome?.state!=="ACHIEVED"||r?.observation?.ackState!=="ACKNOWLEDGED")throw new Error("native "+action+" "+JSON.stringify(r));return r.observation.evidence.result;};
const input=async(steps)=>{const w=await call("onshape_ui_input",{document_id:did,workspace_id:wid,element_id:eid,steps});const r=w.result;if(r?.outcome?.state!=="ACHIEVED"||r?.observation?.ackState!=="ACKNOWLEDGED")throw new Error("input "+JSON.stringify(r));return r.observation.evidence;};
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
const keyOf=(x)=>JSON.stringify(x);
const diff=(a,b)=>{const seen=new Set((a.instances||[]).map(keyOf));return (b.instances||[]).filter(x=>!seen.has(keyOf(x)));};
const brief=(q)=>({count:q.count,returned:q.returned,instances:(q.instances||[]).slice(-20)});
try{
 const status=await call("onshape_session_status"); if(status?.auth?.state!=="PROVEN") throw new Error("auth not proven"); console.log("CF_PHASE0_HEAP_AUTH=pass");
 await native("wait.selector",{selector:"canvas#canvas",state:"visible",timeout_ms:30000});
 const metaExpr=String.raw`(() => {
   const arr=window.webpackChunkNewton; let req=null; const before=arr.length; arr.push([[-Date.now()],{},r=>{req=r}]); if(arr.length>before)arr.splice(before);
   const m=req(45867); const keys=["mXJ","$z3","bd8","bjR","ZiX","Nqh","h$b"]; const out={};
   for(const key of keys){ const C=m[key]; const rec={key,type:typeof C,name:C?.name||null,messageName:null,own:[]}; try{const o=new C();rec.messageName=o.getMessageName?.()||null;rec.own=Object.getOwnPropertyNames(o).slice(0,120);}catch(e){rec.error=String(e).slice(0,300)} out[key]=rec; }
   const canvas=document.querySelector("canvas#canvas"),r=canvas?.getBoundingClientRect();
   return {classes:out,canvas:r?{x:r.x,y:r.y,w:r.width,h:r.height,view:canvas.getAttribute("data-view-shown")}:null};
 })()`;
 const meta=(await native("page.evaluate",{expression:metaExpr})).value; if(!meta?.canvas) throw new Error("canvas missing");
 console.log("CF_PHASE0_HEAP_CLASS_META="+JSON.stringify(meta.classes));
 const selectProps=(key)=>{const own=meta.classes[key]?.own||[];let re=/(determin|selection|feature|node|query|entity|body|name|namespace|index|type|viewMatrix|cameraViewport|isPerspective|angle|isCreatedBySystem)/i;if(key==="mXJ")return ["viewMatrix","isPerspective","cameraViewport","angle","isCreatedBySystem","sectionPlaneParameters"];return [...new Set(own.filter(x=>re.test(x)))].slice(0,48);};
 const query=async(key,max=30)=>{const props=selectProps(key);if(!props.length)props.push("deterministicIds");return native("runtime.query_objects",{module_id:45867,export_path:[key],properties:props,max_instances:max});};
 const keys=["mXJ","$z3","bd8","bjR","ZiX","Nqh","h$b"];
 const baseQ={}; for(const k of keys){try{baseQ[k]=await query(k,k==="mXJ"?40:20)}catch(e){baseQ[k]={error:String(e)}}}
 console.log("CF_PHASE0_HEAP_BASE="+JSON.stringify(Object.fromEntries(keys.map(k=>[k,baseQ[k]?.error?baseQ[k]:brief(baseQ[k])]))));
 const cv=meta.canvas,target={x:Math.round(cv.x+cv.w*.52),y:Math.round(cv.y+cv.h*.50)},blank={x:Math.round(cv.x+cv.w*.94),y:Math.round(cv.y+cv.h*.08)};
 await input([{action:"mouse.move",x:blank.x,y:blank.y,steps:1,after_ms:120}]); await sleep(180);
 const preSel={}; for(const k of ["$z3","bd8","h$b"]){try{preSel[k]=await query(k,30)}catch(e){preSel[k]={error:String(e)}}}
 await input([{action:"mouse.move",x:target.x,y:target.y,steps:1,after_ms:180}]); await sleep(350);
 const hover={}; for(const k of ["$z3","bd8","h$b"]){try{hover[k]=await query(k,30)}catch(e){hover[k]={error:String(e)}}}
 console.log("CF_PHASE0_HEAP_P2="+JSON.stringify({target,classes:Object.fromEntries(["$z3","bd8","h$b"].map(k=>[k,{before:preSel[k]?.error?preSel[k]:brief(preSel[k]),after:hover[k]?.error?hover[k]:brief(hover[k]),fresh:(!preSel[k]?.error&&!hover[k]?.error)?diff(preSel[k],hover[k]):[]}]))}));
 await input([{action:"mouse.click",x:target.x,y:target.y,button:"left",click_count:1,after_ms:180},{action:"mouse.move",x:blank.x,y:blank.y,steps:1,after_ms:120}]); await sleep(450);
 const post={}; for(const k of ["$z3","bd8","h$b","bjR","ZiX"]){try{post[k]=await query(k,40)}catch(e){post[k]={error:String(e)}}}
 console.log("CF_PHASE0_HEAP_P4="+JSON.stringify({target,classes:Object.fromEntries(["$z3","bd8","h$b","bjR","ZiX"].map(k=>[k,{after:post[k]?.error?post[k]:brief(post[k]),freshFromBase:(!baseQ[k]?.error&&!post[k]?.error)?diff(baseQ[k],post[k]):[]}]))}));
 const viewBefore=await query("mXJ",50);
 await input([{action:"mouse.move",x:target.x,y:target.y,steps:1},{action:"mouse.down",button:"right"},{action:"mouse.move",x:target.x+75,y:target.y+45,steps:6},{action:"mouse.up",button:"right",after_ms:200}]); await sleep(450);
 const viewAfter=await query("mXJ",50);
 const viewLabel=(await native("page.evaluate",{expression:"document.querySelector(\"#canvas\")?.getAttribute(\"data-view-shown\")||null"})).value;
 console.log("CF_PHASE0_HEAP_P3="+JSON.stringify({viewLabel,before:brief(viewBefore),after:brief(viewAfter),fresh:diff(viewBefore,viewAfter)}));
 console.log("CF_PHASE0_HEAP=pass");
} finally {await c.close().catch(()=>{});}
NODE

PYTHONPATH="$release/server-deploy/current/fabric-src" python3 - <<'PY'
from capability_fabric.persistence import SqliteExecutionStateStore
p="/var/lib/capability-fabric/onshape-research-phase0/fabric-state/execution.sqlite3"
with SqliteExecutionStateStore(p) as s:
    pending=s.recoverable()
    assert not pending, [(x.operation.operation_id if x.operation else None,x.attempt.attempt_id if x.attempt else None) for x in pending]
print("CF_PHASE0_HEAP_POST_RECOVERABLE=zero")
PY
