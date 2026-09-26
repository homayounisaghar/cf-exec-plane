#!/usr/bin/env bash
set -euo pipefail
umask 077
[[ "$(id -u)" -eq 0 ]] || exit 2
candidate="17ae77556fb2581bdeb72985c5e2645e7b697bc0"
fixture="a19e0fa5152af9f7ce106b6e:e5e7d0173fd1f1d0307a2cb6:e0929361aadb6135b5cecffa"
research=capability-fabric-onshape-phase0-research
release="/var/lib/capability-fabric/onshape-research-phase0/releases/$candidate"
PYTHONPATH="$release/server-deploy/current/fabric-src" python3 - <<'PY'
from capability_fabric.persistence import SqliteExecutionStateStore
p="/var/lib/capability-fabric/onshape-research-phase0/fabric-state/execution.sqlite3"
with SqliteExecutionStateStore(p) as s: assert not s.recoverable()
print("CF_PHASE0_GETTERS_RECOVERABLE=zero")
PY
docker exec -e CF_FIXTURE="$fixture" -i "$research" sh -lc 'cd /tmp/app && node --input-type=module' <<'NODE'
import fs from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
const [did,wid,eid]=process.env.CF_FIXTURE.split(":");
const token=fs.readFileSync("/run/secrets/mcp-token","utf8").trim();
const c=new Client({name:"cf-phase0-getters",version:"1.0"});
await c.connect(new StreamableHTTPClientTransport(new URL("http://127.0.0.1:8898/mcp/"+token)));
const parse=(r)=>JSON.parse((r.content||[]).filter(x=>x.type==="text").map(x=>x.text).join("\n"));
const call=async(name,args={})=>parse(await c.callTool({name,arguments:args},undefined,{timeout:180000}));
try{
 const exp=`(() => { const arr=window.webpackChunkNewton; let req=null; const before=arr.length; arr.push([[-Date.now()],{},r=>{req=r}]); if(arr.length>before)arr.splice(before); const out={}; const specs=[[45867,"Nqh",["getBodyId","getCompositeOrBodyId","getEntityType","getFirstFeatureId","getLastFeatureId","getFeatureIds","getName","getSurfaceType","getEdgeType","getBodyMetaData"]],[71316,"S",["sortAndGetEntityIds","setEntityDeterministicIds"]]]; for(const [mid,key,names] of specs){ const C=req(mid)[key]; for(const n of names){ try{out[mid+":"+key+":"+n]=String(C.prototype[n]).slice(0,6000)}catch(e){out[mid+":"+key+":"+n]="ERR "+String(e)} } } return out; })()`;
 const w=await call("onshape_ui_native",{document_id:did,workspace_id:wid,element_id:eid,action:"page.evaluate",params:{expression:exp}});
 const r=w.result; if(r?.outcome?.state!=="ACHIEVED")throw new Error(JSON.stringify(r));
 console.log("CF_PHASE0_GETTERS="+JSON.stringify(r.observation.evidence.result.value));
 console.log("CF_PHASE0_GETTERS=pass");
}finally{await c.close().catch(()=>{});}
NODE
PYTHONPATH="$release/server-deploy/current/fabric-src" python3 - <<'PY'
from capability_fabric.persistence import SqliteExecutionStateStore
p="/var/lib/capability-fabric/onshape-research-phase0/fabric-state/execution.sqlite3"
with SqliteExecutionStateStore(p) as s: assert not s.recoverable()
print("CF_PHASE0_GETTERS_POST_RECOVERABLE=zero")
PY
