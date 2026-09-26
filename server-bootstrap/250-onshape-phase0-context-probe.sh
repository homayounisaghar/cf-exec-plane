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
print("CF_PHASE0_CTX_PRODUCTION_BOUNDARY=pass")
PY
for c in "$research" "$sidecar"; do [[ "$(docker inspect -f '{{.State.Health.Status}}' "$c")" == healthy ]]; done
PYTHONPATH="$release/server-deploy/current/fabric-src" python3 - <<'PY'
from capability_fabric.persistence import SqliteExecutionStateStore
p="/var/lib/capability-fabric/onshape-research-phase0/fabric-state/execution.sqlite3"
with SqliteExecutionStateStore(p) as s: assert not s.recoverable()
print("CF_PHASE0_CTX_RECOVERABLE=zero")
PY
docker exec -e CF_FIXTURE="$fixture" -i "$research" sh -lc 'cd /tmp/app && node --input-type=module' <<'NODE'
import fs from "node:fs"; import { Client } from "@modelcontextprotocol/sdk/client/index.js"; import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
const [did,wid,eid]=process.env.CF_FIXTURE.split(":"); const token=fs.readFileSync("/run/secrets/mcp-token","utf8").trim(); const c=new Client({name:"cf-phase0-context-probe",version:"1.0"}); await c.connect(new StreamableHTTPClientTransport(new URL("http://127.0.0.1:8898/mcp/"+token)));
const parse=r=>JSON.parse((r.content||[]).filter(x=>x.type==="text").map(x=>x.text).join("\n")); const call=async(name,args={})=>parse(await c.callTool({name,arguments:args},undefined,{timeout:180000}));
const native=async(action,params={})=>{const w=await call("onshape_ui_native",{document_id:did,workspace_id:wid,element_id:eid,action,params});const r=w.result;if(r?.outcome?.state!=="ACHIEVED"||r?.observation?.ackState!=="ACKNOWLEDGED")throw new Error(action+" "+JSON.stringify(r));return r.observation.evidence.result;};
const input=async steps=>{const w=await call("onshape_ui_input",{document_id:did,workspace_id:wid,element_id:eid,steps});const r=w.result;if(r?.outcome?.state!=="ACHIEVED")throw new Error(JSON.stringify(r));return r.observation.evidence;}; const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const stateExpr=`(() => { const clean=s=>String(s||"").replace(/\\s+/g," ").trim().slice(0,500); const vis=e=>{const r=e.getBoundingClientRect();return r.width>0&&r.height>0}; const menus=Array.from(document.querySelectorAll('[role="menu"],[role="menuitem"],.dropdown-menu,.context-menu,[class*="context" i],[class*="menu" i]')).filter(vis).slice(0,120).map(e=>({tag:e.tagName.toLowerCase(),role:e.getAttribute("role"),cls:clean(e.className),text:clean(e.textContent),title:e.getAttribute("title"),aria:e.getAttribute("aria-label")})); const rel=Array.from(document.querySelectorAll(".related-highlight")).slice(0,30).map(e=>({text:clean(e.textContent),dataId:e.getAttribute("data-id"),featureId:e.getAttribute("feature-id"),featureType:e.getAttribute("feature-type")})); const measure=Array.from(document.querySelectorAll("body *")).filter(e=>vis(e)&&e.children.length<8&&/(Area\\s*:|Length\\s*:|Volume\\s*:|Radius\\s*:|Face of|Edge of)/i.test(clean(e.textContent))).slice(0,30).map(e=>clean(e.textContent)); const canvas=document.querySelector("#canvas"),r=canvas?.getBoundingClientRect(); return {menus,related:rel,measure,canvas:r?{x:r.x,y:r.y,w:r.width,h:r.height}:null}; })()`;
try{ const status=await call("onshape_session_status");if(status?.auth?.state!=="PROVEN")throw new Error("auth"); const base=(await native("page.evaluate",{expression:stateExpr})).value;if(!base.canvas)throw new Error("canvas"); const p={x:Math.round(base.canvas.x+base.canvas.w*.52),y:Math.round(base.canvas.y+base.canvas.h*.50)}; console.log("CF_PHASE0_CTX_BASE="+JSON.stringify({point:p,related:base.related,measure:base.measure,menus:base.menus}));
 await input([{action:"mouse.move",x:p.x,y:p.y,steps:1},{action:"mouse.click",x:p.x,y:p.y,button:"right",click_count:1,after_ms:220}]); await sleep(450); const ctx=(await native("page.evaluate",{expression:stateExpr})).value; console.log("CF_PHASE0_CTX_OPEN="+JSON.stringify({point:p,related:ctx.related,measure:ctx.measure,menus:ctx.menus}));
 const esc=`(() => {const ev1=new KeyboardEvent("keydown",{key:"Escape",code:"Escape",keyCode:27,which:27,bubbles:true,cancelable:true});const ev2=new KeyboardEvent("keyup",{key:"Escape",code:"Escape",keyCode:27,which:27,bubbles:true,cancelable:true});(document.activeElement||document.body).dispatchEvent(ev1);document.dispatchEvent(ev1);(document.activeElement||document.body).dispatchEvent(ev2);document.dispatchEvent(ev2);return true;})()`; await native("page.evaluate",{expression:esc}); await sleep(350); const after=(await native("page.evaluate",{expression:stateExpr})).value; console.log("CF_PHASE0_CTX_AFTER="+JSON.stringify({related:after.related,measure:after.measure,menus:after.menus})); console.log("CF_PHASE0_CTX=pass"); } finally {await c.close().catch(()=>{});}
NODE
PYTHONPATH="$release/server-deploy/current/fabric-src" python3 - <<'PY'
from capability_fabric.persistence import SqliteExecutionStateStore
p="/var/lib/capability-fabric/onshape-research-phase0/fabric-state/execution.sqlite3"
with SqliteExecutionStateStore(p) as s: assert not s.recoverable()
print("CF_PHASE0_CTX_POST_RECOVERABLE=zero")
PY
