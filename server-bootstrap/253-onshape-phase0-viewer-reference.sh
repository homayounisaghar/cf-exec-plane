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
assert a["mode"]=="VPS_PRODUCTION" and a["planes"]["android-v1"]["ingress"]=="CLOSED" and a["reconciliationHold"]["active"] is False
assert g["killSwitch"]=="ENGAGED" and g["allowedDocumentIds"]==[] and g["mutationBudget"]["maxMutations"]==0
print("CF_PHASE0_VIEWREF_PRODUCTION_BOUNDARY=pass")
PY
for c in "$research" "$sidecar"; do [[ "$(docker inspect -f '{{.State.Health.Status}}' "$c")" == healthy ]]; done
PYTHONPATH="$release/server-deploy/current/fabric-src" python3 - <<'PY'
from capability_fabric.persistence import SqliteExecutionStateStore
p="/var/lib/capability-fabric/onshape-research-phase0/fabric-state/execution.sqlite3"
with SqliteExecutionStateStore(p) as s: assert not s.recoverable()
print("CF_PHASE0_VIEWREF_RECOVERABLE=zero")
PY
docker exec -e CF_FIXTURE="$fixture" -i "$research" sh -lc 'cd /tmp/app && node --input-type=module' <<'NODE'
import fs from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
const [did,wid,eid]=process.env.CF_FIXTURE.split(":");const token=fs.readFileSync("/run/secrets/mcp-token","utf8").trim();
const c=new Client({name:"cf-phase0-viewref",version:"1.0"});await c.connect(new StreamableHTTPClientTransport(new URL("http://127.0.0.1:8898/mcp/"+token)));
const parse=r=>JSON.parse((r.content||[]).filter(x=>x.type==="text").map(x=>x.text).join("\n"));const call=async(name,args={})=>parse(await c.callTool({name,arguments:args},undefined,{timeout:180000}));
try{
 const st=await call("onshape_session_status");if(st?.auth?.state!=="PROVEN")throw new Error("auth");
 const expression=String.raw`(() => {
   const roots=[];
   const add=(name,v)=>{if(v&&(typeof v==="object"||typeof v==="function"))roots.push({name,v})};
   for(const sel of ["body","#model-body","#viewerdiv","#left-content-pane",".document-view",".element-container"]){
     const el=document.querySelector(sel); if(!el)continue;
     add("dom:"+sel,el);
     try{const d=window.angular?.element?.(el)?.data?.();if(d)for(const [k,v] of Object.entries(d))add("ng:"+sel+":"+k,v)}catch{}
     try{const d=window.jQuery?.(el)?.data?.();if(d)for(const [k,v] of Object.entries(d))add("jq:"+sel+":"+k,v)}catch{}
   }
   for(const k of Object.getOwnPropertyNames(window)){
     if(!/(view|render|graphic|canvas|model|document|studio)/i.test(k))continue;
     let d;try{d=Object.getOwnPropertyDescriptor(window,k)}catch{}; if(d&&"value"in d)add("window:"+k,d.value);
   }
   const seen=new WeakSet(),q=roots.map(x=>({path:x.name,v:x.v,depth:0})),hits=[];let visited=0;
   const methodNames=o=>{const out=new Set;let p=o,n=0;while(p&&n<5){try{for(const k of Object.getOwnPropertyNames(p))out.add(k)}catch{};try{p=Object.getPrototypeOf(p)}catch{break};n++;}return out};
   while(q.length&&visited<18000&&hits.length<20){
     const cur=q.shift(),v=cur.v;if(!v||(typeof v!=="object"&&typeof v!=="function"))continue;if(seen.has(v))continue;seen.add(v);visited++;
     let names;try{names=methodNames(v)}catch{names=new Set}
     if(names.has("pickInRect")&&names.has("getViewData")&&names.has("getCamera")){
       let ctor=null,own=[];try{ctor=v.constructor?.name||null;own=Object.getOwnPropertyNames(v).slice(0,120)}catch{}
       hits.push({path:cur.path,depth:cur.depth,ctor,own,methods:[...names].filter(n=>/(pick|view|camera|mouse|selection)/i.test(n)).slice(0,100)});
       continue;
     }
     if(cur.depth>=6)continue;
     let props=[];try{props=Object.getOwnPropertyNames(v).slice(0,180)}catch{}
     for(const k of props){
       if(["window","self","top","parent","frames","document","ownerDocument"].includes(k))continue;
       let d;try{d=Object.getOwnPropertyDescriptor(v,k)}catch{};if(!d||!("value"in d))continue;
       const x=d.value;if(!x||(typeof x!=="object"&&typeof x!=="function"))continue;
       q.push({path:cur.path+"."+k,v:x,depth:cur.depth+1});
     }
   }
   return {rootCount:roots.length,visited,hits};
 })()`;
 const w=await call("onshape_ui_native",{document_id:did,workspace_id:wid,element_id:eid,action:"page.evaluate",params:{expression}});
 const r=w.result;if(r?.outcome?.state!=="ACHIEVED"||r?.observation?.ackState!=="ACKNOWLEDGED")throw new Error(JSON.stringify(r));
 console.log("CF_PHASE0_VIEWREF_RESULT="+JSON.stringify(r.observation.evidence.result.value));
 console.log("CF_PHASE0_VIEWREF=pass");
}finally{await c.close().catch(()=>{});}
NODE
PYTHONPATH="$release/server-deploy/current/fabric-src" python3 - <<'PY'
from capability_fabric.persistence import SqliteExecutionStateStore
p="/var/lib/capability-fabric/onshape-research-phase0/fabric-state/execution.sqlite3"
with SqliteExecutionStateStore(p) as s: assert not s.recoverable()
print("CF_PHASE0_VIEWREF_POST_RECOVERABLE=zero")
PY
