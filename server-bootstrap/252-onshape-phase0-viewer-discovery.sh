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
print("CF_PHASE0_VIEWERDISC_PRODUCTION_BOUNDARY=pass")
PY
for c in "$research" "$sidecar"; do [[ "$(docker inspect -f '{{.State.Health.Status}}' "$c")" == healthy ]]; done
PYTHONPATH="$release/server-deploy/current/fabric-src" python3 - <<'PY'
from capability_fabric.persistence import SqliteExecutionStateStore
p="/var/lib/capability-fabric/onshape-research-phase0/fabric-state/execution.sqlite3"
with SqliteExecutionStateStore(p) as s: assert not s.recoverable()
print("CF_PHASE0_VIEWERDISC_RECOVERABLE=zero")
PY
docker exec -e CF_FIXTURE="$fixture" -i "$research" sh -lc 'cd /tmp/app && node --input-type=module' <<'NODE'
import fs from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
const [did,wid,eid]=process.env.CF_FIXTURE.split(":"); const token=fs.readFileSync("/run/secrets/mcp-token","utf8").trim();
const c=new Client({name:"cf-phase0-viewerdisc",version:"1.0"}); await c.connect(new StreamableHTTPClientTransport(new URL("http://127.0.0.1:8898/mcp/"+token)));
const parse=r=>JSON.parse((r.content||[]).filter(x=>x.type==="text").map(x=>x.text).join("\n"));
const call=async(name,args={})=>parse(await c.callTool({name,arguments:args},undefined,{timeout:180000}));
try{
 const st=await call("onshape_session_status"); if(st?.auth?.state!=="PROVEN")throw new Error("auth");
 const expression=String.raw`(() => {
   const arr=window.webpackChunkNewton; let req=null; const before=arr.length;
   arr.push([[-Date.now()],{},r=>{req=r}]); if(arr.length>before)arr.splice(before);
   const modules=[];
   for(const entry of arr){
     const map=entry?.[1]; if(!map||typeof map!=="object")continue;
     for(const [id,fn] of Object.entries(map)){
       if(typeof fn!=="function")continue;
       let src="";try{src=String(fn)}catch{}
       if(!src.includes("pickManyInRectInternal") || !src.includes("getViewData"))continue;
       const rec={id,exports:[],sourceAround:null};
       const idx=src.indexOf("pickManyInRectInternal");
       rec.sourceAround=src.slice(Math.max(0,idx-1200),Math.min(src.length,idx+2200));
       try{
         const ex=req(Number(id));
         for(const [k,v] of Object.entries(ex||{})){
           const p=v?.prototype;
           let names=[];try{names=p?Object.getOwnPropertyNames(p):[]}catch{}
           rec.exports.push({key:k,type:typeof v,name:v?.name||null,proto:names.filter(n=>/(pick|view|camera|entity|mouse|draw|selection)/i.test(n)).slice(0,120)});
         }
       }catch(e){rec.requireError=String(e)}
       modules.push(rec);
     }
   }
   return modules;
 })()`;
 const w=await call("onshape_ui_native",{document_id:did,workspace_id:wid,element_id:eid,action:"page.evaluate",params:{expression}});
 const r=w.result;if(r?.outcome?.state!=="ACHIEVED"||r?.observation?.ackState!=="ACKNOWLEDGED")throw new Error(JSON.stringify(r));
 console.log("CF_PHASE0_VIEWERDISC_RESULT="+JSON.stringify(r.observation.evidence.result.value));
 console.log("CF_PHASE0_VIEWERDISC=pass");
}finally{await c.close().catch(()=>{});}
NODE
PYTHONPATH="$release/server-deploy/current/fabric-src" python3 - <<'PY'
from capability_fabric.persistence import SqliteExecutionStateStore
p="/var/lib/capability-fabric/onshape-research-phase0/fabric-state/execution.sqlite3"
with SqliteExecutionStateStore(p) as s: assert not s.recoverable()
print("CF_PHASE0_VIEWERDISC_POST_RECOVERABLE=zero")
PY
