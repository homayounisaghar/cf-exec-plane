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
print("CF_PHASE0_EXECREF_PRODUCTION_BOUNDARY=pass")
PY
for c in "$research" "$sidecar"; do [[ "$(docker inspect -f '{{.State.Health.Status}}' "$c")" == healthy ]]; done
PYTHONPATH="$release/server-deploy/current/fabric-src" python3 - <<'PY'
from capability_fabric.persistence import SqliteExecutionStateStore
p="/var/lib/capability-fabric/onshape-research-phase0/fabric-state/execution.sqlite3"
with SqliteExecutionStateStore(p) as s: assert not s.recoverable()
print("CF_PHASE0_EXECREF_RECOVERABLE=zero")
PY

docker exec -e CF_FIXTURE="$fixture" -i "$research" sh -lc 'cd /tmp/app && node --input-type=module' <<'NODE'
import fs from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
const [did,wid,eid]=process.env.CF_FIXTURE.split(":");
const token=fs.readFileSync("/run/secrets/mcp-token","utf8").trim();
const c=new Client({name:"cf-phase0-execref",version:"1.0"});
await c.connect(new StreamableHTTPClientTransport(new URL("http://127.0.0.1:8898/mcp/"+token)));
const parse=(r)=>JSON.parse((r.content||[]).filter(x=>x.type==="text").map(x=>x.text).join("\n"));
const call=async(name,args)=>parse(await c.callTool({name,arguments:args},undefined,{timeout:180000}));
try{
 const expression=String.raw`(() => {
   const result=[];
   const chunkGlobals=Object.keys(window).filter(k=>/webpack.*chunk|chunk.*webpack/i.test(k));
   const needles=[
     "i(45867)","(45867)","GBTUiGetQueryDataCall","GBTUiGetProjectedUvOnEntityCall",
     "getQueryData","getProjectedUvOnEntity","projectedUv","projectedUV",
     "GBTViewData","viewMatrix","cameraViewport","isPerspective",
     "getCurrentView","currentView","setCurrentView","cameraMatrix","projectionMatrix"
   ];
   for(const cg of chunkGlobals){
     const arr=window[cg]; if(!Array.isArray(arr)) continue;
     const modules=new Map();
     for(const entry of arr){
       const map=entry?.[1]; if(map&&typeof map==="object"){
         for(const [id,fn] of Object.entries(map)) if(typeof fn==="function") modules.set(id,String(fn));
       }
     }
     for(const [id,src] of modules){
       const low=src.toLowerCase();
       for(const needle of needles){
         const idx=low.indexOf(needle.toLowerCase());
         if(idx>=0){
           result.push({chunk:cg,module:id,needle,snippet:src.slice(Math.max(0,idx-1400),Math.min(src.length,idx+3600))});
         }
       }
     }
   }
   return result.slice(0,180);
 })()`;
 const wrap=await call("onshape_ui_native",{document_id:did,workspace_id:wid,element_id:eid,action:"page.evaluate",params:{expression}});
 const r=wrap.result;
 if(r?.outcome?.state!=="ACHIEVED") throw new Error(JSON.stringify(r));
 console.log("CF_PHASE0_EXECREF_RESULT="+JSON.stringify(r.observation.evidence.result.value));
 console.log("CF_PHASE0_EXECREF=pass");
} finally { await c.close().catch(()=>{}); }
NODE
PYTHONPATH="$release/server-deploy/current/fabric-src" python3 - <<'PY'
from capability_fabric.persistence import SqliteExecutionStateStore
p="/var/lib/capability-fabric/onshape-research-phase0/fabric-state/execution.sqlite3"
with SqliteExecutionStateStore(p) as s: assert not s.recoverable()
print("CF_PHASE0_EXECREF_POST_RECOVERABLE=zero")
PY
