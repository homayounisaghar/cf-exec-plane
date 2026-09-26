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
print("CF_PHASE0_CORR_PRODUCTION_BOUNDARY=pass")
PY
for c in "$research" "$sidecar"; do [[ "$(docker inspect -f '{{.State.Health.Status}}' "$c")" == healthy ]]; done
PYTHONPATH="$release/server-deploy/current/fabric-src" python3 - <<'PY'
from capability_fabric.persistence import SqliteExecutionStateStore
p="/var/lib/capability-fabric/onshape-research-phase0/fabric-state/execution.sqlite3"
with SqliteExecutionStateStore(p) as s: assert not s.recoverable()
print("CF_PHASE0_CORR_RECOVERABLE=zero")
PY
docker exec -e CF_FIXTURE="$fixture" -i "$research" sh -lc 'cd /tmp/app && node --input-type=module' <<'NODE'
import fs from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
const [did,wid,eid]=process.env.CF_FIXTURE.split(":"); const token=fs.readFileSync("/run/secrets/mcp-token","utf8").trim();
const c=new Client({name:"cf-phase0-corr",version:"1.0"}); await c.connect(new StreamableHTTPClientTransport(new URL("http://127.0.0.1:8898/mcp/"+token)));
const parse=(r)=>JSON.parse((r.content||[]).filter(x=>x.type==="text").map(x=>x.text).join("\n"));
const call=async(name,args={})=>parse(await c.callTool({name,arguments:args},undefined,{timeout:180000}));
const native=async(action,params={})=>{const w=await call("onshape_ui_native",{document_id:did,workspace_id:wid,element_id:eid,action,params});const r=w.result;if(r?.outcome?.state!=="ACHIEVED"||r?.observation?.ackState!=="ACKNOWLEDGED")throw new Error(action+" "+JSON.stringify(r));return r.observation.evidence.result;};
const input=async(steps)=>{const w=await call("onshape_ui_input",{document_id:did,workspace_id:wid,element_id:eid,steps});const r=w.result;if(r?.outcome?.state!=="ACHIEVED")throw new Error(JSON.stringify(r));return r.observation.evidence;};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const snap=async()=>{const q=await native("runtime.query_objects",{module_id:45867,export_path:["e8f"],properties:["bodyId","featureIds","meshIncrement","geometries"],max_instances:80}); return (q.instances||[]).map((x,i)=>({i,bodyId:x.bodyId,featureIds:x.featureIds,incId:x.meshIncrement?.id||null,pickId:x.meshIncrement?.properties?.pickId||null,primitiveType:x.meshIncrement?.primitiveType??null,geometries:(x.geometries||[]).map(g=>({ctor:g?.__constructor||null,settingIndex:g?.settingIndex??null,errorCode:g?.errorCode??null,surfaceType:g?.surfaceType??null,edgeType:g?.edgeType??null,isInternalEdge:g?.isInternalEdge??null,isClosed:g?.isClosed??null,isPlanar:g?.isPlanar??null}))}));};
const key=x=>JSON.stringify({bodyId:x.bodyId,incId:x.incId,pickId:x.pickId,primitiveType:x.primitiveType,geometries:x.geometries});
const changed=(a,b)=>{const A=new Map(a.map(x=>[x.bodyId+"|"+x.incId+"|"+JSON.stringify(x.pickId),x]));const out=[];for(const y of b){const k=y.bodyId+"|"+y.incId+"|"+JSON.stringify(y.pickId),x=A.get(k);if(!x||key(x)!==key(y))out.push({before:x||null,after:y});}return out;};
try{
 const status=await call("onshape_session_status");if(status?.auth?.state!=="PROVEN")throw new Error("auth");
 const meta=(await native("page.evaluate",{expression:`(() => {const c=document.querySelector("#canvas"),r=c?.getBoundingClientRect();return r?{x:r.x,y:r.y,w:r.width,h:r.height}:null})()`})).value;if(!meta)throw new Error("canvas");
 const blank={x:Math.round(meta.x+meta.w*.90),y:Math.round(meta.y+meta.h*.88)};
 const points=[{x:Math.round(meta.x+meta.w*.46),y:Math.round(meta.y+meta.h*.48)},{x:Math.round(meta.x+meta.w*.52),y:Math.round(meta.y+meta.h*.50)},{x:Math.round(meta.x+meta.w*.58),y:Math.round(meta.y+meta.h*.52)}];
 await input([{action:"mouse.move",x:blank.x,y:blank.y,steps:1,after_ms:120}]);await sleep(250);const base=await snap();
 console.log("CF_PHASE0_CORR_BASE="+JSON.stringify({count:base.length,active:base.filter(x=>x.geometries.some(g=>g.settingIndex!=null&&g.settingIndex!==2)).slice(0,30)}));
 const probes=[];for(const p of points){await input([{action:"mouse.move",x:p.x,y:p.y,steps:1,after_ms:160}]);await sleep(300);const h=await snap();await input([{action:"mouse.move",x:blank.x,y:blank.y,steps:1,after_ms:120}]);await sleep(250);const away=await snap();probes.push({point:p,hoverChanged:changed(base,h).slice(0,30),awayChanged:changed(base,away).slice(0,30),hoverActive:h.filter(x=>x.geometries.some(g=>g.settingIndex!=null&&g.settingIndex!==2)).slice(0,30)});}
 console.log("CF_PHASE0_CORR_PROBES="+JSON.stringify(probes));
 console.log("CF_PHASE0_CORR=pass");
}finally{await c.close().catch(()=>{});}
NODE
PYTHONPATH="$release/server-deploy/current/fabric-src" python3 - <<'PY'
from capability_fabric.persistence import SqliteExecutionStateStore
p="/var/lib/capability-fabric/onshape-research-phase0/fabric-state/execution.sqlite3"
with SqliteExecutionStateStore(p) as s: assert not s.recoverable()
print("CF_PHASE0_CORR_POST_RECOVERABLE=zero")
PY
