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
assert a["planes"]["android-v1"]["materialEffectsAllowed"] is False
assert a["reconciliationHold"]["active"] is False
assert g["killSwitch"]=="ENGAGED" and g["allowedDocumentIds"]==[] and g["mutationBudget"]["maxMutations"]==0
print("CF_PHASE0_WSOBS_PRODUCTION_BOUNDARY=pass")
print("CF_PHASE0_WSOBS_CONTROL_REV="+str(d["controlRevision"]))
print("CF_PHASE0_WSOBS_EPOCH="+str(a["productionEpoch"]))
PY

for c in "$research" "$sidecar"; do
 [[ "$(docker inspect -f '{{.State.Running}}' "$c" 2>/dev/null || echo false)" == true ]]
 [[ "$(docker inspect -f '{{.State.Health.Status}}' "$c")" == healthy ]]
done
env_dump="$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$research")"
grep -Fxq "CF_RESEARCH_SOURCE_COMMIT=$candidate" <<<"$env_dump"
grep -Fxq "CF_RESEARCH_FIXTURE_TARGET=$fixture" <<<"$env_dump"
echo CF_PHASE0_WSOBS_BINDING=pass

PYTHONPATH="$release/server-deploy/current/fabric-src" python3 - <<'PY'
from capability_fabric.persistence import SqliteExecutionStateStore
p="/var/lib/capability-fabric/onshape-research-phase0/fabric-state/execution.sqlite3"
with SqliteExecutionStateStore(p) as s:
    assert not s.recoverable()
print("CF_PHASE0_WSOBS_RECOVERABLE=zero")
PY

docker exec -e CF_FIXTURE="$fixture" -e CF_CANDIDATE="$candidate" -i "$research" sh -lc 'cd /tmp/app && node --input-type=module' <<'NODE'
import fs from "node:fs";
import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const [did,wid,eid]=process.env.CF_FIXTURE.split(":");
const candidate=process.env.CF_CANDIDATE;
const token=fs.readFileSync("/run/secrets/mcp-token","utf8").trim();
const c=new Client({name:"cf-phase0-wsobs",version:"1.0"});
await c.connect(new StreamableHTTPClientTransport(new URL("http://127.0.0.1:8898/mcp/"+token)));
const parse=(r)=>JSON.parse((r.content||[]).filter(x=>x.type==="text").map(x=>x.text).join("\n"));
const call=async(name,args={})=>parse(await c.callTool({name,arguments:args},undefined,{timeout:180000}));
const native=async(action,params={})=>{
  const wrap=await call("onshape_ui_native",{document_id:did,workspace_id:wid,element_id:eid,action,params});
  const r=wrap.result;
  if(r?.outcome?.state!=="ACHIEVED" || r?.observation?.ackState!=="ACKNOWLEDGED") throw new Error("native "+action+" "+JSON.stringify(r));
  return r.observation.evidence.result;
};
const input=async(steps)=>{
  const wrap=await call("onshape_ui_input",{document_id:did,workspace_id:wid,element_id:eid,steps});
  const r=wrap.result;
  if(r?.outcome?.state!=="ACHIEVED" || r?.observation?.ackState!=="ACKNOWLEDGED") throw new Error("input "+JSON.stringify(r));
  return r.observation.evidence;
};
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
const terms=["select","pick","entity","face","edge","vertex","camera","view","matrix","query","deterministic","ray","hover","project","measure","graphics"];
const hash=(s)=>createHash("sha256").update(String(s)).digest("hex").slice(0,16);
function summarize(root){
  const out={arrays:[],objects:[],strings:[],booleans:[],numbers:[]};
  const walk=(v,path,depth)=>{
    if(depth>8) return;
    if(Array.isArray(v)){ out.arrays.push({path,length:v.length}); for(let i=0;i<Math.min(v.length,240);i++) walk(v[i],path+"["+i+"]",depth+1); return; }
    if(v && typeof v==="object"){ const keys=Object.keys(v).sort(); out.objects.push({path,keys:keys.slice(0,60)}); for(const k of keys.slice(0,80)) walk(v[k],path+"."+k,depth+1); return; }
    if(typeof v==="string"){ const low=v.toLowerCase(); const hits=terms.filter(t=>low.includes(t)); out.strings.push({path,length:v.length,hash:hash(v),hits}); return; }
    if(typeof v==="boolean"){ out.booleans.push({path,value:v}); return; }
    if(typeof v==="number"){ out.numbers.push({path,value:Number.isFinite(v)?v:null}); }
  };
  walk(root,"$",0);
  return {
    arrays:out.arrays.slice(0,120),
    objects:out.objects.slice(0,120),
    strings:out.strings.slice(0,300),
    semanticStrings:out.strings.filter(x=>x.hits.length).slice(0,120),
    booleans:out.booleans.slice(0,80),
    numbers:out.numbers.slice(0,120)
  };
}
function delta(a,b){
  const seen=new Set((a.strings||[]).map(x=>x.path+"|"+x.hash));
  const fresh=(b.strings||[]).filter(x=>!seen.has(x.path+"|"+x.hash));
  return {newStrings:fresh.length,semantic:fresh.filter(x=>x.hits.length).slice(0,120),sample:fresh.slice(0,80)};
}
try{
  const status=await call("onshape_session_status");
  if(status?.auth?.state!=="PROVEN") throw new Error("auth not proven");
  if(status.build_id!=="onshape-phase0-"+candidate.slice(0,12)) throw new Error("build mismatch");
  console.log("CF_PHASE0_WSOBS_AUTH=pass");
  await native("wait.selector",{selector:"canvas#canvas",state:"visible",timeout_ms:30000});
  const meta=await native("page.evaluate",{expression:"(() => {const c=document.querySelector(\"canvas#canvas\"),r=c?.getBoundingClientRect();return r?{x:r.x,y:r.y,w:r.width,h:r.height,view:c.getAttribute(\"data-view-shown\")}:null})()"});
  const cv=meta.value; if(!cv) throw new Error("canvas missing");
  const points=[{x:Math.round(cv.x+cv.w*.46),y:Math.round(cv.y+cv.h*.48)},{x:Math.round(cv.x+cv.w*.52),y:Math.round(cv.y+cv.h*.50)},{x:Math.round(cv.x+cv.w*.58),y:Math.round(cv.y+cv.h*.52)}];
  const blank={x:Math.round(cv.x+cv.w*.94),y:Math.round(cv.y+cv.h*.08)};
  await input([{action:"mouse.move",x:blank.x,y:blank.y,steps:1,after_ms:120}]); await sleep(250);
  let raw=await native("websocket.snapshot",{limit:120});
  let prev=summarize(raw);
  console.log("CF_PHASE0_WSOBS_BASE="+JSON.stringify({view:cv.view,summary:prev}));
  const moves=[];
  for(const p of points){
    await input([{action:"mouse.move",x:p.x,y:p.y,steps:1,after_ms:180}]); await sleep(350);
    raw=await native("websocket.snapshot",{limit:120}); const cur=summarize(raw); moves.push({point:p,delta:delta(prev,cur),summary:{arrays:cur.arrays,semanticStrings:cur.semanticStrings}}); prev=cur;
    await input([{action:"mouse.move",x:blank.x,y:blank.y,steps:1,after_ms:120}]); await sleep(180);
  }
  console.log("CF_PHASE0_WSOBS_MOVES="+JSON.stringify(moves));
  const target=points[1];
  await input([{action:"mouse.click",x:target.x,y:target.y,button:"left",click_count:1,after_ms:180},{action:"mouse.move",x:blank.x,y:blank.y,steps:1,after_ms:100}]); await sleep(500);
  raw=await native("websocket.snapshot",{limit:120}); let cur=summarize(raw);
  console.log("CF_PHASE0_WSOBS_CLICK="+JSON.stringify({point:target,delta:delta(prev,cur),semanticStrings:cur.semanticStrings,arrays:cur.arrays})); prev=cur;
  await input([{action:"mouse.move",x:target.x,y:target.y,steps:1},{action:"mouse.down",button:"right"},{action:"mouse.move",x:target.x+70,y:target.y+40,steps:6},{action:"mouse.up",button:"right",after_ms:180},{action:"mouse.move",x:blank.x,y:blank.y,steps:1,after_ms:80}]); await sleep(500);
  raw=await native("websocket.snapshot",{limit:120}); cur=summarize(raw);
  const afterView=await native("page.evaluate",{expression:"document.querySelector(\"#canvas\")?.getAttribute(\"data-view-shown\")||null"});
  console.log("CF_PHASE0_WSOBS_ROTATE="+JSON.stringify({viewAfter:afterView.value,delta:delta(prev,cur),semanticStrings:cur.semanticStrings,arrays:cur.arrays}));
  await input([{action:"mouse.click",x:blank.x,y:blank.y,button:"left",click_count:1,after_ms:100}]);
  console.log("CF_PHASE0_WSOBS=pass");
} finally { await c.close().catch(()=>{}); }
NODE

PYTHONPATH="$release/server-deploy/current/fabric-src" python3 - <<'PY'
from capability_fabric.persistence import SqliteExecutionStateStore
p="/var/lib/capability-fabric/onshape-research-phase0/fabric-state/execution.sqlite3"
with SqliteExecutionStateStore(p) as s:
    assert not s.recoverable()
print("CF_PHASE0_WSOBS_POST_RECOVERABLE=zero")
PY
