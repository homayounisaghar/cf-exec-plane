#!/usr/bin/env bash
set -euo pipefail
umask 077
[[ "$(id -u)" -eq 0 ]] || exit 2
fixture="a19e0fa5152af9f7ce106b6e:e5e7d0173fd1f1d0307a2cb6:e0929361aadb6135b5cecffa"
candidate="d882fa763b3a55be5a18d6e196d028ff4f77ea07"
research=capability-fabric-onshape-phase0-research
sidecar=capability-fabric-onshape-phase0-fabric
release="/var/lib/capability-fabric/onshape-research-phase0/releases/$candidate"

for c in "$research" "$sidecar"; do
 [[ "$(docker inspect -f '{{.State.Health.Status}}' "$c")" == healthy ]]
done
PYTHONPATH="$release/server-deploy/current/fabric-src" python3 - <<'PY'
from capability_fabric.persistence import SqliteExecutionStateStore
p="/var/lib/capability-fabric/onshape-research-phase0/fabric-state/execution.sqlite3"
with SqliteExecutionStateStore(p) as s: assert not s.recoverable()
print("CF_PHASE0_GLOBALS_RECOVERABLE=zero")
PY

docker exec -e CF_FIXTURE="$fixture" -e CF_CANDIDATE="$candidate" -i "$research" sh -lc 'cd /tmp/app && node --input-type=module' <<'NODE'
import fs from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
const [did,wid,eid]=process.env.CF_FIXTURE.split(":");
const token=fs.readFileSync("/run/secrets/mcp-token","utf8").trim();
const c=new Client({name:"cf-phase0-globals",version:"1.0"});
await c.connect(new StreamableHTTPClientTransport(new URL("http://127.0.0.1:8898/mcp/"+token)));
const parse=(r)=>JSON.parse((r.content||[]).filter(x=>x.type==="text").map(x=>x.text).join("\n"));
const call=async(name,args)=>parse(await c.callTool({name,arguments:args},undefined,{timeout:180000}));
try{
 const expr=String.raw`(() => {
   const names=["viewport","Viewport","getRendererInfo","createGraphicsUtilsModule","BTSelectItem"];
   const safeDesc=(v)=>{
     const out={type:typeof v};
     if(v==null) return out;
     try{out.own=Object.getOwnPropertyNames(v).slice(0,250).map(k=>({k,t:typeof v[k]}));}catch(e){out.ownError=String(e)}
     try{
       const p=Object.getPrototypeOf(v);
       out.proto=p?Object.getOwnPropertyNames(p).slice(0,250).map(k=>({k,t:typeof p[k]})):[];
     }catch(e){out.protoError=String(e)}
     if(typeof v==="function"){
       try{out.source=String(v).slice(0,1800)}catch{}
     }
     return out;
   };
   const values=Object.fromEntries(names.map(n=>[n,safeDesc(window[n])]));
   const vp=window.viewport;
   const selected={};
   if(vp && typeof vp==="object"){
     const keys=[...new Set([...(values.viewport.own||[]).map(x=>x.k),...(values.viewport.proto||[]).map(x=>x.k)])]
       .filter(k=>/(camera|view|select|pick|hit|entity|transform|matrix|screen|world|ray|render|zoom|pan|rotate|mouse|pointer)/i.test(k));
     for(const k of keys.slice(0,120)){
       try{
         const v=vp[k];
         selected[k]={type:typeof v};
         if(typeof v==="function") selected[k].source=String(v).slice(0,1000);
         else if(v==null || ["string","number","boolean"].includes(typeof v)) selected[k].value=v;
         else if(Array.isArray(v)) selected[k].value=v.slice(0,20);
         else if(typeof v==="object") selected[k].keys=Object.keys(v).slice(0,60);
       }catch(e){selected[k]={error:String(e)}}
     }
   }
   return {values,viewportInteresting:selected};
 })()`;
 const wrap=await call("onshape_ui_native",{document_id:did,workspace_id:wid,element_id:eid,action:"page.evaluate",params:{expression:expr}});
 const r=wrap.result;
 if(r?.outcome?.state!=="ACHIEVED") throw new Error(JSON.stringify(r));
 console.log("CF_PHASE0_GLOBALS="+JSON.stringify(r.observation.evidence.result.value));
 console.log("CF_PHASE0_GLOBALS=pass");
} finally { await c.close().catch(()=>{}); }
NODE
PYTHONPATH="$release/server-deploy/current/fabric-src" python3 - <<'PY'
from capability_fabric.persistence import SqliteExecutionStateStore
p="/var/lib/capability-fabric/onshape-research-phase0/fabric-state/execution.sqlite3"
with SqliteExecutionStateStore(p) as s: assert not s.recoverable()
print("CF_PHASE0_GLOBALS_POST_RECOVERABLE=zero")
PY
