#!/usr/bin/env bash
set -euo pipefail
umask 077
[[ "$(id -u)" -eq 0 ]] || exit 2
candidate="dbb08f8257b4e72e31e203497fa135acdeda5e5b"
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
print("CF_PHASE0_WMOD_PRODUCTION_BOUNDARY=pass")
print("CF_PHASE0_WMOD_CONTROL_REV="+str(d["controlRevision"]))
print("CF_PHASE0_WMOD_EPOCH="+str(a["productionEpoch"]))
PY
for c in "$research" "$sidecar"; do
 [[ "$(docker inspect -f '{{.State.Running}}' "$c" 2>/dev/null || echo false)" == true ]]
 [[ "$(docker inspect -f '{{.State.Health.Status}}' "$c")" == healthy ]]
done
env_dump="$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$research")"
grep -Fxq "CF_RESEARCH_SOURCE_COMMIT=$candidate" <<<"$env_dump"
grep -Fxq "CF_RESEARCH_FIXTURE_TARGET=$fixture" <<<"$env_dump"
echo CF_PHASE0_WMOD_BINDING=pass

PYTHONPATH="$release/server-deploy/current/fabric-src" python3 - <<'PY'
from capability_fabric.persistence import SqliteExecutionStateStore
p="/var/lib/capability-fabric/onshape-research-phase0/fabric-state/execution.sqlite3"
with SqliteExecutionStateStore(p) as s:
    assert not s.recoverable()
print("CF_PHASE0_WMOD_RECOVERABLE=zero")
PY

docker exec -e CF_FIXTURE="$fixture" -i "$research" sh -lc 'cd /tmp/app && node --input-type=module' <<'NODE'
import fs from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
const [did,wid,eid]=process.env.CF_FIXTURE.split(":");
const token=fs.readFileSync("/run/secrets/mcp-token","utf8").trim();
const c=new Client({name:"cf-phase0-wmod",version:"1.0"});
await c.connect(new StreamableHTTPClientTransport(new URL("http://127.0.0.1:8898/mcp/"+token)));
const parse=(r)=>JSON.parse((r.content||[]).filter(x=>x.type==="text").map(x=>x.text).join("\n"));
const call=async(name,args)=>parse(await c.callTool({name,arguments:args},undefined,{timeout:180000}));
try{
 const expression=String.raw`(() => {
   const arr=window.webpackChunkNewton;
   if(!Array.isArray(arr)) return {error:"webpackChunkNewton missing"};
   let req=null; const before=arr.length; const chunkId=Math.floor(900000000+Math.random()*90000000);
   arr.push([[chunkId],{},r=>{req=r}]);
   if(arr.length>before) arr.splice(before);
   if(typeof req!=="function") return {error:"webpack require capture failed"};
   const safeCtor=(v)=>{
     const o={type:typeof v};
     if(typeof v==="function"){
       o.name=v.name||null;
       try{o.proto=Object.getOwnPropertyNames(v.prototype||{}).slice(0,80)}catch{}
       try{if(v.prototype&&typeof v.prototype.getMessageName==="function"){const x=new v();o.messageName=x.getMessageName()}}catch(e){o.messageError=String(e).slice(0,300)}
     } else if(v&&typeof v==="object"){
       try{o.keys=Object.keys(v).slice(0,120)}catch{}
     }
     return o;
   };
   const ids=[45867,80123,46045,39550,71316,49607,27369,81634,88659,90893];
   const modules=[];
   for(const id of ids){
     try{
       const m=req(id); const exports=[];
       for(const [k,v] of Object.entries(m||{}).slice(0,120)){
         const rec={key:k,...safeCtor(v)};
         if(v&&typeof v==="object"){
           const nested=[];
           for(const [nk,nv] of Object.entries(v).slice(0,80)){ const s=safeCtor(nv); if(s.type==="function"||s.messageName) nested.push({key:nk,...s}); }
           if(nested.length) rec.nested=nested.slice(0,80);
         }
         exports.push(rec);
       }
       modules.push({id,exports});
     }catch(e){modules.push({id,error:String(e).slice(0,500)})}
   }
   return {requireKeys:Object.keys(req).slice(0,100),modules};
 })()`;
 const wrap=await call("onshape_ui_native",{document_id:did,workspace_id:wid,element_id:eid,action:"page.evaluate",params:{expression}});
 const r=wrap.result;
 if(r?.outcome?.state!=="ACHIEVED"||r?.observation?.ackState!=="ACKNOWLEDGED") throw new Error(JSON.stringify(r));
 console.log("CF_PHASE0_WMOD_RESULT="+JSON.stringify(r.observation.evidence.result.value));
 console.log("CF_PHASE0_WMOD=pass");
} finally {await c.close().catch(()=>{});}
NODE

PYTHONPATH="$release/server-deploy/current/fabric-src" python3 - <<'PY'
from capability_fabric.persistence import SqliteExecutionStateStore
p="/var/lib/capability-fabric/onshape-research-phase0/fabric-state/execution.sqlite3"
with SqliteExecutionStateStore(p) as s:
    assert not s.recoverable()
print("CF_PHASE0_WMOD_POST_RECOVERABLE=zero")
PY
