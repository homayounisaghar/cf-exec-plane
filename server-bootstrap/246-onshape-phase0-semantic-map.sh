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
d=json.load(open(sys.argv[1])); a=d["authority"]; g=a["productionGuard"]
assert a["mode"]=="VPS_PRODUCTION" and a["materialAuthority"]=="vps-fabric"
assert a["planes"]["android-v1"]["ingress"]=="CLOSED"
assert a["reconciliationHold"]["active"] is False
assert g["killSwitch"]=="ENGAGED" and g["allowedDocumentIds"]==[] and g["mutationBudget"]["maxMutations"]==0
print("CF_PHASE0_MAP_PRODUCTION_BOUNDARY=pass")
print("CF_PHASE0_MAP_CONTROL_REV="+str(d["controlRevision"]))
print("CF_PHASE0_MAP_EPOCH="+str(a["productionEpoch"]))
PY
for c in "$research" "$sidecar"; do
 [[ "$(docker inspect -f '{{.State.Running}}' "$c" 2>/dev/null || echo false)" == true ]]
 [[ "$(docker inspect -f '{{.State.Health.Status}}' "$c")" == healthy ]]
done
env_dump="$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$research")"
grep -Fxq "CF_RESEARCH_SOURCE_COMMIT=$candidate" <<<"$env_dump"
grep -Fxq "CF_RESEARCH_FIXTURE_TARGET=$fixture" <<<"$env_dump"
echo CF_PHASE0_MAP_BINDING=pass
PYTHONPATH="$release/server-deploy/current/fabric-src" python3 - <<'PY'
from capability_fabric.persistence import SqliteExecutionStateStore
p="/var/lib/capability-fabric/onshape-research-phase0/fabric-state/execution.sqlite3"
with SqliteExecutionStateStore(p) as s: assert not s.recoverable()
print("CF_PHASE0_MAP_RECOVERABLE=zero")
PY

docker exec -e CF_FIXTURE="$fixture" -i "$research" sh -lc 'cd /tmp/app && node --input-type=module' <<'NODE'
import fs from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
const [did,wid,eid]=process.env.CF_FIXTURE.split(":");
const token=fs.readFileSync("/run/secrets/mcp-token","utf8").trim();
const c=new Client({name:"cf-phase0-map",version:"1.0"});
await c.connect(new StreamableHTTPClientTransport(new URL("http://127.0.0.1:8898/mcp/"+token)));
const parse=(r)=>JSON.parse((r.content||[]).filter(x=>x.type==="text").map(x=>x.text).join("\n"));
const call=async(name,args={})=>parse(await c.callTool({name,arguments:args},undefined,{timeout:180000}));
const native=async(action,params={})=>{const w=await call("onshape_ui_native",{document_id:did,workspace_id:wid,element_id:eid,action,params});const r=w.result;if(r?.outcome?.state!=="ACHIEVED"||r?.observation?.ackState!=="ACKNOWLEDGED")throw new Error(action+" "+JSON.stringify(r));return r.observation.evidence.result;};
try {
 const status=await call("onshape_session_status"); if(status?.auth?.state!=="PROVEN") throw new Error("auth");
 console.log("CF_PHASE0_MAP_AUTH=pass");
 const expr = `(() => {
   const arr=window.webpackChunkNewton; let req=null; const before=arr.length;
   arr.push([[-Date.now()],{},r=>{req=r}]); if(arr.length>before) arr.splice(before);
   const targets=[["45867","e8f"],["45867","bjR"],["45867","ZiX"],["45867","Nqh"],["45867","$z3"],["71316","S"],["80123","b"]];
   const out={};
   for(const [mid,key] of targets){
     try{ const C=req(Number(mid))[key]; const x=new C();
       const own=Object.getOwnPropertyNames(x);
       const proto=[]; let p=C.prototype,depth=0;
       while(p&&depth<4){ for(const n of Object.getOwnPropertyNames(p)){ if(!proto.includes(n)) proto.push(n); } p=Object.getPrototypeOf(p); depth++; }
       out[mid+":"+key]={name:C.name||null,messageName:x.getMessageName?.()||null,own,proto};
     }catch(e){out[mid+":"+key]={error:String(e)}}
   }
   return out;
 })()`;
 const meta=(await native("page.evaluate",{expression:expr})).value;
 console.log("CF_PHASE0_MAP_CLASS_META="+JSON.stringify(meta));
 const pick=(mid,key)=>{
   const m=meta[mid+":"+key]||{}; const names=(m.own||[]).filter(n=>/(id|name|entity|determin|feature|body|part|node|query|selection|setting|type|index|point|normal|surface|edge|mesh|preview|occurrence|view|camera|matrix)/i.test(n));
   return [...new Set(names)].slice(0,48);
 };
 const query=async(mid,key,max=80)=>{const props=pick(String(mid),key); if(!props.length) props.push("_serializedByteLength"); return native("runtime.query_objects",{module_id:mid,export_path:[key],properties:props,max_instances:max});};
 const targets=[[71316,"S"],[45867,"e8f"],[45867,"bjR"],[45867,"ZiX"],[45867,"Nqh"],[45867,"$z3"],[80123,"b"]];
 const base={}; for(const [mid,key] of targets){try{base[mid+":"+key]=await query(mid,key,80)}catch(e){base[mid+":"+key]={error:String(e)}}}
 console.log("CF_PHASE0_MAP_OBJECTS="+JSON.stringify(base));
 console.log("CF_PHASE0_MAP=pass");
} finally { await c.close().catch(()=>{}); }
NODE

PYTHONPATH="$release/server-deploy/current/fabric-src" python3 - <<'PY'
from capability_fabric.persistence import SqliteExecutionStateStore
p="/var/lib/capability-fabric/onshape-research-phase0/fabric-state/execution.sqlite3"
with SqliteExecutionStateStore(p) as s: assert not s.recoverable()
print("CF_PHASE0_MAP_POST_RECOVERABLE=zero")
PY
