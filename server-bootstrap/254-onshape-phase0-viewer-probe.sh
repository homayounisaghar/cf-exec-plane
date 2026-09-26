#!/usr/bin/env bash
set -euo pipefail
umask 077
[[ "$(id -u)" -eq 0 ]] || exit 2
candidate="01f0feb7ae97db4e34d00da0bc9734519ef74322"
fixture="a19e0fa5152af9f7ce106b6e:e5e7d0173fd1f1d0307a2cb6:e0929361aadb6135b5cecffa"
research=capability-fabric-onshape-phase0-research
sidecar=capability-fabric-onshape-phase0-fabric
release="/var/lib/capability-fabric/onshape-research-phase0/releases/$candidate"
control=/var/lib/capability-fabric/onshape/runtime-control/ONSHAPE_RUNTIME_CONTROL.json
python3 - "$control" <<'PY'
import json,sys
d=json.load(open(sys.argv[1]));a=d["authority"];g=a["productionGuard"]
assert a["mode"]=="VPS_PRODUCTION" and a["materialAuthority"]=="vps-fabric"
assert a["planes"]["android-v1"]["ingress"]=="CLOSED" and a["reconciliationHold"]["active"] is False
assert g["killSwitch"]=="ENGAGED" and g["allowedDocumentIds"]==[] and g["mutationBudget"]["maxMutations"]==0
print("CF_PHASE0_VIEWPROBE_PRODUCTION_BOUNDARY=pass")
print("CF_PHASE0_VIEWPROBE_CONTROL_REV="+str(d["controlRevision"]))
print("CF_PHASE0_VIEWPROBE_EPOCH="+str(a["productionEpoch"]))
PY
for c in "$research" "$sidecar"; do [[ "$(docker inspect -f '{{.State.Health.Status}}' "$c")" == healthy ]]; done
env_dump="$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$research")"
grep -Fxq "CF_RESEARCH_SOURCE_COMMIT=$candidate" <<<"$env_dump"
grep -Fxq "CF_RESEARCH_FIXTURE_TARGET=$fixture" <<<"$env_dump"
echo CF_PHASE0_VIEWPROBE_BINDING=pass
PYTHONPATH="$release/server-deploy/current/fabric-src" python3 - <<'PY'
from capability_fabric.persistence import SqliteExecutionStateStore
p="/var/lib/capability-fabric/onshape-research-phase0/fabric-state/execution.sqlite3"
with SqliteExecutionStateStore(p) as s: assert not s.recoverable()
print("CF_PHASE0_VIEWPROBE_RECOVERABLE=zero")
PY
docker exec -e CF_FIXTURE="$fixture" -i "$research" sh -lc 'cd /tmp/app && node --input-type=module' <<'NODE'
import fs from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
const [did,wid,eid]=process.env.CF_FIXTURE.split(":");const token=fs.readFileSync("/run/secrets/mcp-token","utf8").trim();
const c=new Client({name:"cf-phase0-viewprobe",version:"1.0"});await c.connect(new StreamableHTTPClientTransport(new URL("http://127.0.0.1:8898/mcp/"+token)));
const parse=r=>JSON.parse((r.content||[]).filter(x=>x.type==="text").map(x=>x.text).join("\n"));
const call=async(name,args={})=>parse(await c.callTool({name,arguments:args},undefined,{timeout:180000}));
const viewer=async(params)=>{const t0=performance.now();const w=await call("onshape_ui_native",{document_id:did,workspace_id:wid,element_id:eid,action:"runtime.viewer",params});const r=w.result;if(r?.outcome?.state!=="ACHIEVED"||r?.observation?.ackState!=="ACKNOWLEDGED")throw new Error(JSON.stringify(r));return{value:r.observation.evidence.result,ms:performance.now()-t0};};
const nativeEval=async(expression)=>{const w=await call("onshape_ui_native",{document_id:did,workspace_id:wid,element_id:eid,action:"page.evaluate",params:{expression}});const r=w.result;if(r?.outcome?.state!=="ACHIEVED"||r?.observation?.ackState!=="ACKNOWLEDGED")throw new Error(JSON.stringify(r));return r.observation.evidence.result.value;};
try{
 const tools=(await c.listTools()).tools;
 const native=tools.find((x)=>x.name==="onshape_ui_native");
 const actionEnum=native?.inputSchema?.properties?.action?.enum||[];
 if(!actionEnum.includes("runtime.viewer"))throw new Error("runtime.viewer missing from live MCP schema");
 console.log("CF_PHASE0_VIEWPROBE_SCHEMA=runtime.viewer");
 const st=await call("onshape_session_status");if(st?.auth?.state!=="PROVEN")throw new Error("auth");
 const source=await nativeEval(`(() => {
   const arr=window.webpackChunkNewton; let req=null; const before=arr.length;
   arr.push([[-Date.now()],{},r=>{req=r}]); if(arr.length>before)arr.splice(before);
   const V=req?.(74266)?.jM; if(typeof V!=="function") return null;
   const names=["setUISelection","setHoveredSelection","getActiveElementViewerState","getSelectionFitBounds","retrieveSelectionPosition","doPick","doPreHighlightPick","pick"];
   const methods=Object.fromEntries(names.map(n=>[n,typeof V.prototype[n]==="function"?String(V.prototype[n]).slice(0,12000):null]));
   let factory=null;
   for(const entry of arr){const map=entry?.[1];if(map&&typeof map==="object"&&typeof map[74266]==="function"){factory=map[74266];break;}}
   let factorySource=""; try{factorySource=factory?String(factory):""}catch{}
   const di=factorySource.indexOf("doPick(");
   return {
     methods,
     factory_prefix:factorySource.slice(0,9000),
     factory_around_do_pick:di>=0?factorySource.slice(Math.max(0,di-5000),Math.min(factorySource.length,di+3000)):""
   };
 })()`);
 console.log("CF_PHASE0_VIEWPROBE_METHOD_SOURCE="+JSON.stringify(source));
 const inspect=await viewer({op:"inspect"});
 console.log("CF_PHASE0_VIEWPROBE_INSPECT_MS="+inspect.ms.toFixed(2));
 console.log("CF_PHASE0_VIEWPROBE_INSPECT="+JSON.stringify(inspect.value));
 const points=[{x_fraction:.46,y_fraction:.48},{x_fraction:.52,y_fraction:.50},{x_fraction:.58,y_fraction:.52}];
 const out=[];
 for(const p of points){const q=await viewer({op:"probe",...p});out.push({point:p,ms:+q.ms.toFixed(2),value:q.value});}
 console.log("CF_PHASE0_VIEWPROBE_PROBES="+JSON.stringify(out));
 console.log("CF_PHASE0_VIEWPROBE=pass");
}finally{await c.close().catch(()=>{});}
NODE
PYTHONPATH="$release/server-deploy/current/fabric-src" python3 - <<'PY'
from capability_fabric.persistence import SqliteExecutionStateStore
p="/var/lib/capability-fabric/onshape-research-phase0/fabric-state/execution.sqlite3"
with SqliteExecutionStateStore(p) as s: assert not s.recoverable()
print("CF_PHASE0_VIEWPROBE_POST_RECOVERABLE=zero")
PY
