#!/usr/bin/env bash
set -euo pipefail
umask 077
[[ "$(id -u)" -eq 0 ]] || exit 2
candidate="d882fa763b3a55be5a18d6e196d028ff4f77ea07"
fixture="a19e0fa5152af9f7ce106b6e:e5e7d0173fd1f1d0307a2cb6:e0929361aadb6135b5cecffa"
research=capability-fabric-onshape-phase0-research
sidecar=capability-fabric-onshape-phase0-fabric
release="/var/lib/capability-fabric/onshape-research-phase0/releases/$candidate"
for c in "$research" "$sidecar"; do [[ "$(docker inspect -f '{{.State.Health.Status}}' "$c")" == healthy ]]; done
PYTHONPATH="$release/server-deploy/current/fabric-src" python3 - <<'PY'
from capability_fabric.persistence import SqliteExecutionStateStore
p="/var/lib/capability-fabric/onshape-research-phase0/fabric-state/execution.sqlite3"
with SqliteExecutionStateStore(p) as s: assert not s.recoverable()
print("CF_PHASE0_FORENSIC_RECOVERABLE=zero")
PY

docker exec -e CF_FIXTURE="$fixture" -i "$research" sh -lc 'cd /tmp/app && node --input-type=module' <<'NODE'
import fs from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
const [did,wid,eid]=process.env.CF_FIXTURE.split(":");
const token=fs.readFileSync("/run/secrets/mcp-token","utf8").trim();
const c=new Client({name:"cf-phase0-selection-forensics",version:"1.0"});
await c.connect(new StreamableHTTPClientTransport(new URL("http://127.0.0.1:8898/mcp/"+token)));
const parse=(r)=>JSON.parse((r.content||[]).filter(x=>x.type==="text").map(x=>x.text).join("\n"));
const call=async(name,args)=>parse(await c.callTool({name,arguments:args},undefined,{timeout:180000}));
const native=async(expression)=>{
 const r=(await call("onshape_ui_native",{document_id:did,workspace_id:wid,element_id:eid,action:"page.evaluate",params:{expression}})).result;
 if(r?.outcome?.state!=="ACHIEVED") throw new Error(JSON.stringify(r));
 return r.observation.evidence.result.value;
};
const input=async(steps)=>{
 const r=(await call("onshape_ui_input",{document_id:did,workspace_id:wid,element_id:eid,steps})).result;
 if(r?.outcome?.state!=="ACHIEVED") throw new Error(JSON.stringify(r));
 return r;
};
const expr=String.raw`(() => {
 const brief=(el)=>{ if(!el)return null; const r=el.getBoundingClientRect?.(); return {
   tag:el.tagName?.toLowerCase()||null,id:el.id||null,cls:String(el.className||"").slice(0,500),
   text:String(el.textContent||"").trim().replace(/\s+/g," ").slice(0,1200),
   attrs:Object.fromEntries(Array.from(el.attributes||[]).slice(0,80).map(a=>[a.name,a.value])),
   rect:r?{x:r.x,y:r.y,w:r.width,h:r.height}:null,
   html:String(el.outerHTML||"").slice(0,8000)
 };};
 const all=Array.from(document.querySelectorAll("body *"));
 const measure=all.filter(el=>/Area\s*:|Length\s*:|Volume\s*:|Radius\s*:|Mass\s*:/i.test(String(el.textContent||"")) && el.children.length<8).slice(0,20);
 const related=all.filter(el=>String(el.className||"").includes("related-highlight")).slice(0,30);
 const selected=all.filter(el=>el.getAttribute?.("aria-selected")==="true" || /(^|\s)(selected|selection)(\s|$)/i.test(String(el.className||""))).slice(0,50);
 const selish=all.filter(el=>/(selection|selected|highlight)/i.test(String(el.className||""))).slice(0,100);
 const ancestors=(el)=>{const a=[];let n=el;for(let i=0;i<6&&n;i++,n=n.parentElement)a.push(brief(n));return a;};
 return {
   canvas:brief(document.querySelector("#canvas")),
   measure:measure.map(e=>({node:brief(e),ancestors:ancestors(e)})),
   related:related.map(e=>({node:brief(e),ancestors:ancestors(e)})),
   selected:selected.map(brief),
   selish:selish.map(brief),
   storage:{local:Object.keys(localStorage),session:Object.keys(sessionStorage)},
   selectionText:String(window.getSelection?.()?.toString?.()||"").slice(0,1000)
 };
})()`;
try{
 const base=await native(expr);
 const canvas=base.canvas?.rect; if(!canvas) throw new Error("canvas");
 const x=Math.round(canvas.x+canvas.w*.52), y=Math.round(canvas.y+canvas.h*.50);
 console.log("CF_PHASE0_FORENSIC_BASE="+JSON.stringify({point:{x,y},measure:base.measure,related:base.related,selected:base.selected,selish:base.selish,canvas:{cls:base.canvas.cls,attrs:base.canvas.attrs}}));

 await input([{action:"mouse.move",x,y,steps:1,after_ms:180}]);
 const hover=await native(expr);
 console.log("CF_PHASE0_P2_HOVER="+JSON.stringify({point:{x,y},measure:hover.measure,related:hover.related,selected:hover.selected,selish:hover.selish}));

 await input([{action:"mouse.click",x,y,button:"left",click_count:1,after_ms:180}]);
 const clicked=await native(expr);
 console.log("CF_PHASE0_P4_CLICK_FORENSIC="+JSON.stringify({point:{x,y},measure:clicked.measure,related:clicked.related,selected:clicked.selected,selish:clicked.selish,storage:clicked.storage}));

 console.log("CF_PHASE0_FORENSIC=pass");
} finally { await c.close().catch(()=>{}); }
NODE
PYTHONPATH="$release/server-deploy/current/fabric-src" python3 - <<'PY'
from capability_fabric.persistence import SqliteExecutionStateStore
p="/var/lib/capability-fabric/onshape-research-phase0/fabric-state/execution.sqlite3"
with SqliteExecutionStateStore(p) as s: assert not s.recoverable()
print("CF_PHASE0_FORENSIC_POST_RECOVERABLE=zero")
PY
