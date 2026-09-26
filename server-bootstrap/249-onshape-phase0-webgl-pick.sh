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
d=json.load(open(sys.argv[1]));a=d["authority"];g=a["productionGuard"]
assert a["mode"]=="VPS_PRODUCTION" and a["materialAuthority"]=="vps-fabric"
assert a["planes"]["android-v1"]["ingress"]=="CLOSED" and a["reconciliationHold"]["active"] is False
assert g["killSwitch"]=="ENGAGED" and g["allowedDocumentIds"]==[] and g["mutationBudget"]["maxMutations"]==0
print("CF_PHASE0_GL_PRODUCTION_BOUNDARY=pass")
PY
for c in "$research" "$sidecar"; do [[ "$(docker inspect -f '{{.State.Health.Status}}' "$c")" == healthy ]]; done
PYTHONPATH="$release/server-deploy/current/fabric-src" python3 - <<'PY'
from capability_fabric.persistence import SqliteExecutionStateStore
p="/var/lib/capability-fabric/onshape-research-phase0/fabric-state/execution.sqlite3"
with SqliteExecutionStateStore(p) as s: assert not s.recoverable()
print("CF_PHASE0_GL_RECOVERABLE=zero")
PY
docker exec -e CF_FIXTURE="$fixture" -i "$research" sh -lc 'cd /tmp/app && node --input-type=module' <<'NODE'
import fs from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
const [did,wid,eid]=process.env.CF_FIXTURE.split(":");const token=fs.readFileSync("/run/secrets/mcp-token","utf8").trim();
const c=new Client({name:"cf-phase0-gl-pick",version:"1.0"});await c.connect(new StreamableHTTPClientTransport(new URL("http://127.0.0.1:8898/mcp/"+token)));
const parse=(r)=>JSON.parse((r.content||[]).filter(x=>x.type==="text").map(x=>x.text).join("\n"));
const call=async(name,args={})=>parse(await c.callTool({name,arguments:args},undefined,{timeout:180000}));
const native=async(action,params={})=>{const w=await call("onshape_ui_native",{document_id:did,workspace_id:wid,element_id:eid,action,params});const r=w.result;if(r?.outcome?.state!=="ACHIEVED"||r?.observation?.ackState!=="ACKNOWLEDGED")throw new Error(action+" "+JSON.stringify(r));return r.observation.evidence.result;};
const input=async(steps)=>{const w=await call("onshape_ui_input",{document_id:did,workspace_id:wid,element_id:eid,steps});const r=w.result;if(r?.outcome?.state!=="ACHIEVED")throw new Error(JSON.stringify(r));return r.observation.evidence;};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
try{
 const status=await call("onshape_session_status");if(status?.auth?.state!=="PROVEN")throw new Error("auth");
 const install=`(() => {
   if(window.__cfPickTap?.installed)return {already:true};
   const tap={installed:true,captures:[],originals:[]};
   const hook=(C,label)=>{if(!C?.prototype?.readPixels)return;const p=C.prototype,orig=p.readPixels;tap.originals.push([p,orig]);p.readPixels=function(...args){const ret=orig.apply(this,args);try{const [x,y,w,h,format,type,pixels]=args;let sample=[];if(pixels&&typeof pixels.length==="number")sample=Array.from(pixels).slice(0,64);tap.captures.push({at:performance.now(),label,x,y,w,h,format,type,length:pixels?.length??null,sample,framebufferBound:!!this.getParameter?.(this.FRAMEBUFFER_BINDING)});if(tap.captures.length>200)tap.captures.splice(0,tap.captures.length-200);}catch(e){}return ret;};};
   hook(window.WebGLRenderingContext,"webgl1");hook(window.WebGL2RenderingContext,"webgl2");
   window.__cfPickTap=tap;return {installed:true,hookCount:tap.originals.length};
 })()`;
 const inst=(await native("page.evaluate",{expression:install})).value;console.log("CF_PHASE0_GL_INSTALL="+JSON.stringify(inst));
 const meta=(await native("page.evaluate",{expression:`(() => {const c=document.querySelector("#canvas"),r=c?.getBoundingClientRect();return r?{x:r.x,y:r.y,w:r.width,h:r.height}:null})()`})).value;if(!meta)throw new Error("canvas");
 const blank={x:Math.round(meta.x+meta.w*.90),y:Math.round(meta.y+meta.h*.88)};
 const points=[{x:Math.round(meta.x+meta.w*.46),y:Math.round(meta.y+meta.h*.48)},{x:Math.round(meta.x+meta.w*.52),y:Math.round(meta.y+meta.h*.50)},{x:Math.round(meta.x+meta.w*.58),y:Math.round(meta.y+meta.h*.52)}];
 const take=async()=> (await native("page.evaluate",{expression:`(() => {const t=window.__cfPickTap;const a=(t?.captures||[]).slice();if(t)t.captures.length=0;return a;})()`})).value;
 await input([{action:"mouse.move",x:blank.x,y:blank.y,steps:1,after_ms:140}]);await sleep(300);const base=await take();
 console.log("CF_PHASE0_GL_BASE="+JSON.stringify({point:blank,captures:base}));
 const probes=[];for(const p of points){await input([{action:"mouse.move",x:p.x,y:p.y,steps:1,after_ms:180}]);await sleep(400);const hit=await take();await input([{action:"mouse.move",x:blank.x,y:blank.y,steps:1,after_ms:140}]);await sleep(300);const away=await take();probes.push({point:p,hit,away});}
 console.log("CF_PHASE0_GL_PROBES="+JSON.stringify(probes));
 const restore=`(() => {const t=window.__cfPickTap;if(!t)return {restored:false};for(const [p,o] of t.originals||[])p.readPixels=o;delete window.__cfPickTap;return {restored:true,count:(t.originals||[]).length};})()`;
 console.log("CF_PHASE0_GL_RESTORE="+JSON.stringify((await native("page.evaluate",{expression:restore})).value));
 console.log("CF_PHASE0_GL=pass");
}finally{try{await native("page.evaluate",{expression:`(() => {const t=window.__cfPickTap;if(t){for(const [p,o] of t.originals||[])p.readPixels=o;delete window.__cfPickTap;}return true;})()`});}catch{} await c.close().catch(()=>{});}
NODE
PYTHONPATH="$release/server-deploy/current/fabric-src" python3 - <<'PY'
from capability_fabric.persistence import SqliteExecutionStateStore
p="/var/lib/capability-fabric/onshape-research-phase0/fabric-state/execution.sqlite3"
with SqliteExecutionStateStore(p) as s: assert not s.recoverable()
print("CF_PHASE0_GL_POST_RECOVERABLE=zero")
PY
