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
print("CF_PHASE0_ANGULAR_PRODUCTION_BOUNDARY=pass")
print("CF_PHASE0_ANGULAR_CONTROL_REV="+str(d["controlRevision"]))
print("CF_PHASE0_ANGULAR_EPOCH="+str(a["productionEpoch"]))
PY

for c in "$research" "$sidecar"; do
 [[ "$(docker inspect -f '{{.State.Running}}' "$c" 2>/dev/null || echo false)" == true ]]
 [[ "$(docker inspect -f '{{.State.Health.Status}}' "$c")" == healthy ]]
done
env_dump="$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$research")"
grep -Fxq "CF_RESEARCH_SOURCE_COMMIT=$candidate" <<<"$env_dump"
grep -Fxq "CF_RESEARCH_FIXTURE_TARGET=$fixture" <<<"$env_dump"
echo CF_PHASE0_ANGULAR_BINDING=pass

PYTHONPATH="$release/server-deploy/current/fabric-src" python3 - <<'PY'
from capability_fabric.persistence import SqliteExecutionStateStore
p="/var/lib/capability-fabric/onshape-research-phase0/fabric-state/execution.sqlite3"
with SqliteExecutionStateStore(p) as s:
    pending=s.recoverable()
    assert not pending, [(x.operation.operation_id if x.operation else None,x.attempt.attempt_id if x.attempt else None) for x in pending]
print("CF_PHASE0_ANGULAR_RECOVERABLE=zero")
PY

docker exec -e CF_FIXTURE="$fixture" -i "$research" sh -lc 'cd /tmp/app && node --input-type=module' <<'NODE'
import fs from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
const [did,wid,eid]=process.env.CF_FIXTURE.split(":");
const token=fs.readFileSync("/run/secrets/mcp-token","utf8").trim();
const c=new Client({name:"cf-phase0-angular",version:"1.0"});
await c.connect(new StreamableHTTPClientTransport(new URL("http://127.0.0.1:8898/mcp/"+token)));
const parse=(r)=>JSON.parse((r.content||[]).filter(x=>x.type==="text").map(x=>x.text).join("\n"));
const call=async(name,args)=>parse(await c.callTool({name,arguments:args},undefined,{timeout:180000}));
try{
 const expression=String.raw`(() => {
   const clean=(v,n=300)=>String(v??"").replace(/\s+/g," ").slice(0,n);
   const keyRe=/(select|selection|selected|hover|highlight|camera|view|viewport|graphics|render|pick|hit|entity|part|face|edge|mouse|pointer|transform|matrix|world|screen)/i;
   const valueDesc=(v)=>{
     const t=typeof v, out={type:t};
     if(v==null || ["string","number","boolean"].includes(t)){out.value=v;return out;}
     try{out.ctor=v?.constructor?.name||null}catch{}
     if(t==="function"){try{out.source=String(v).slice(0,500)}catch{};return out;}
     try{out.keys=Object.keys(v).filter(k=>keyRe.test(k)).slice(0,80)}catch{}
     return out;
   };
   const scopeDesc=(scope)=>{
     if(!scope)return null;
     const levels=[]; let s=scope;
     for(let depth=0;depth<5&&s;depth++,s=Object.getPrototypeOf(s)){
       let keys=[]; try{keys=Reflect.ownKeys(s).filter(k=>typeof k==="string"&&keyRe.test(k)).slice(0,120)}catch{}
       const vals={};
       for(const k of keys.slice(0,60)){try{vals[k]=valueDesc(s[k])}catch(e){vals[k]={error:clean(e,100)}}}
       levels.push({depth,keys,vals});
     }
     return {id:scope.$id??null,levels};
   };
   const elDesc=(el)=>{
     if(!el)return null;
     const out={
       tag:el.tagName?.toLowerCase()||null,id:el.id||null,cls:clean(el.className,220),
       attrs:Object.fromEntries(Array.from(el.attributes||[]).filter(a=>/(data-|feature-|part-|entity-|select|view|camera|ng-)/i.test(a.name)).slice(0,50).map(a=>[a.name,clean(a.value,220)])),
       own:Reflect.ownKeys(el).filter(k=>typeof k==="string"&&(/^(ng|__|\$)/.test(k)||keyRe.test(k))).slice(0,100)
     };
     if(window.angular){
       try{
         const ae=window.angular.element(el);
         const data=ae.data?.()||{};
         out.dataKeys=Object.keys(data).slice(0,100);
         out.dataInteresting=Object.fromEntries(Object.keys(data).filter(k=>keyRe.test(k)||/controller|scope/i.test(k)).slice(0,50).map(k=>[k,valueDesc(data[k])]));
         out.scope=scopeDesc(ae.scope?.());
         out.isolateScope=scopeDesc(ae.isolateScope?.());
       }catch(e){out.angularError=clean(e,180)}
     }
     return out;
   };
   const targets={
     body:document.body,
     modelBody:document.querySelector("#model-body"),
     viewer:document.querySelector("#viewerdiv"),
     canvas:document.querySelector("#canvas"),
     partList:document.querySelector("#part-list"),
     related:document.querySelector(".related-highlight"),
   };
   const controllerElements=[];
   if(window.angular){
     for(const el of Array.from(document.querySelectorAll("body *")).slice(0,3500)){
       try{
         const data=window.angular.element(el).data?.()||{};
         const keys=Object.keys(data).filter(k=>/controller|scope/i.test(k));
         const interesting=Object.keys(data).filter(k=>keyRe.test(k));
         if(keys.length||interesting.length){
           controllerElements.push({
             tag:el.tagName?.toLowerCase()||null,id:el.id||null,cls:clean(el.className,180),
             keys:[...new Set([...keys,...interesting])].slice(0,40)
           });
           if(controllerElements.length>=100)break;
         }
       }catch{}
     }
   }
   const globals={};
   for(const k of ["angular","jQuery","$","viewport","BTSelectItem"]){
     const v=window[k]; globals[k]=valueDesc(v);
     if(k==="angular"&&v?.version) globals[k].version=v.version.full;
   }
   return {
     globals,
     targets:Object.fromEntries(Object.entries(targets).map(([k,v])=>[k,elDesc(v)])),
     controllerElements,
     related:Array.from(document.querySelectorAll(".related-highlight")).slice(0,30).map(el=>({
       tag:el.tagName?.toLowerCase()||null,cls:clean(el.className,160),text:clean(el.textContent,180),
       dataId:el.getAttribute("data-id"),featureId:el.getAttribute("feature-id"),featureType:el.getAttribute("feature-type")
     })),
     canvasView:document.querySelector("#canvas")?.getAttribute("data-view-shown")||null
   };
 })()`;
 const wrap=await call("onshape_ui_native",{document_id:did,workspace_id:wid,element_id:eid,action:"page.evaluate",params:{expression}});
 const r=wrap.result;
 if(r?.outcome?.state!=="ACHIEVED"||r?.observation?.ackState!=="ACKNOWLEDGED") throw new Error(JSON.stringify(r));
 console.log("CF_PHASE0_ANGULAR_RESULT="+JSON.stringify(r.observation.evidence.result.value));
 console.log("CF_PHASE0_ANGULAR=pass");
} finally {await c.close().catch(()=>{});}
NODE

PYTHONPATH="$release/server-deploy/current/fabric-src" python3 - <<'PY'
from capability_fabric.persistence import SqliteExecutionStateStore
p="/var/lib/capability-fabric/onshape-research-phase0/fabric-state/execution.sqlite3"
with SqliteExecutionStateStore(p) as s: assert not s.recoverable()
print("CF_PHASE0_ANGULAR_POST_RECOVERABLE=zero")
PY
