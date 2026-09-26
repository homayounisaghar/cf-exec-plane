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
print("CF_PHASE0_NETOBS_PRODUCTION_BOUNDARY=pass")
print("CF_PHASE0_NETOBS_CONTROL_REV="+str(d["controlRevision"]))
print("CF_PHASE0_NETOBS_EPOCH="+str(a["productionEpoch"]))
PY

for c in "$research" "$sidecar"; do
 [[ "$(docker inspect -f '{{.State.Running}}' "$c" 2>/dev/null || echo false)" == true ]]
 [[ "$(docker inspect -f '{{.State.Health.Status}}' "$c")" == healthy ]]
done
env_dump="$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$research")"
grep -Fxq "CF_RESEARCH_SOURCE_COMMIT=$candidate" <<<"$env_dump"
grep -Fxq "CF_RESEARCH_FIXTURE_TARGET=$fixture" <<<"$env_dump"
echo CF_PHASE0_NETOBS_BINDING=pass

PYTHONPATH="$release/server-deploy/current/fabric-src" python3 - <<'PY'
from capability_fabric.persistence import SqliteExecutionStateStore
p="/var/lib/capability-fabric/onshape-research-phase0/fabric-state/execution.sqlite3"
with SqliteExecutionStateStore(p) as s:
    assert not s.recoverable()
print("CF_PHASE0_NETOBS_RECOVERABLE=zero")
PY

docker exec -e CF_FIXTURE="$fixture" -e CF_CANDIDATE="$candidate" -i "$research" sh -lc 'cd /tmp/app && node --input-type=module' <<'NODE'
import fs from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const [did,wid,eid]=process.env.CF_FIXTURE.split(":");
const candidate=process.env.CF_CANDIDATE;
const token=fs.readFileSync("/run/secrets/mcp-token","utf8").trim();
const c=new Client({name:"cf-phase0-netobs",version:"1.0"});
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

function key(x){
  return [x.at||"",x.method||"",x.status||"",x.resourceType||"",x.origin||"",x.pathname||"",x.search||""].join("|");
}
function diff(prev,next){
  const seen=new Set([...(prev.requests||[]),...(prev.responses||[])].map(key));
  const fresh=[...(next.requests||[]).map(x=>({kind:"request",...x})),...(next.responses||[]).map(x=>({kind:"response",...x}))].filter(x=>!seen.has(key(x)));
  return fresh;
}
function compact(xs){
  const groups=new Map();
  for(const x of xs){
    const k=[x.kind,x.method||"",x.status||"",x.resourceType||"",x.origin||"",x.pathname||"",x.search||""].join("|");
    const v=groups.get(k)||{kind:x.kind,method:x.method||null,status:x.status||null,resourceType:x.resourceType||null,origin:x.origin||null,pathname:x.pathname||null,search:x.search||null,count:0};
    v.count++; groups.set(k,v);
  }
  return [...groups.values()].slice(0,120);
}
function clues(xs){
  const re=/(query|select|pick|hit|entity|face|edge|vertex|view|camera|graphics|display|tessell|project|ray|hover|measure)/i;
  return compact(xs).filter(x=>re.test(String(x.pathname||"")+" "+String(x.search||"")));
}

try{
  const status=await call("onshape_session_status");
  if(status?.auth?.state!=="PROVEN") throw new Error("auth not proven");
  if(status.build_id!=="onshape-phase0-"+candidate.slice(0,12)) throw new Error("build mismatch");
  console.log("CF_PHASE0_NETOBS_AUTH=pass");

  await native("wait.selector",{selector:"canvas#canvas",state:"visible",timeout_ms:30000});\n  const meta=await native("page.evaluate",{expression:String.raw`(() => {const c=document.querySelector("canvas#canvas"),r=c?.getBoundingClientRect();return r?{x:r.x,y:r.y,w:r.width,h:r.height,view:c.getAttribute("data-view-shown")}:null})()`});
  const cv=meta.value;
  if(!cv) throw new Error("canvas missing");
  const points=[
    {x:Math.round(cv.x+cv.w*.46),y:Math.round(cv.y+cv.h*.48)},
    {x:Math.round(cv.x+cv.w*.52),y:Math.round(cv.y+cv.h*.50)},
    {x:Math.round(cv.x+cv.w*.58),y:Math.round(cv.y+cv.h*.52)}
  ];
  const blank={x:Math.round(cv.x+cv.w*.94),y:Math.round(cv.y+cv.h*.08)};

  await input([{action:"mouse.move",x:blank.x,y:blank.y,steps:1,after_ms:120}]);
  await sleep(250);
  let snap=await native("network.snapshot",{limit:250});
  console.log("CF_PHASE0_NETOBS_BASE_COUNTS="+JSON.stringify({requests:snap.requests.length,responses:snap.responses.length,view:cv.view}));

  const moveResults=[];
  for(const p of points){
    const before=snap;
    await input([{action:"mouse.move",x:p.x,y:p.y,steps:1,after_ms:160}]);
    await sleep(350);
    snap=await native("network.snapshot",{limit:250});
    const d=diff(before,snap);
    moveResults.push({point:p,newCount:d.length,events:compact(d),clues:clues(d)});
    await input([{action:"mouse.move",x:blank.x,y:blank.y,steps:1,after_ms:120}]);
    await sleep(200);
    snap=await native("network.snapshot",{limit:250});
  }
  console.log("CF_PHASE0_NETOBS_MOVES="+JSON.stringify(moveResults));

  const beforeClick=snap;
  const target=points[1];
  await input([{action:"mouse.click",x:target.x,y:target.y,button:"left",click_count:1,after_ms:180}]);
  await input([{action:"mouse.move",x:blank.x,y:blank.y,steps:1,after_ms:100}]);
  await sleep(500);
  snap=await native("network.snapshot",{limit:250});
  const clickDiff=diff(beforeClick,snap);
  console.log("CF_PHASE0_NETOBS_CLICK="+JSON.stringify({point:target,newCount:clickDiff.length,events:compact(clickDiff),clues:clues(clickDiff)}));

  const beforeRotate=snap;
  await input([
    {action:"mouse.move",x:target.x,y:target.y,steps:1},
    {action:"mouse.down",button:"right"},
    {action:"mouse.move",x:target.x+70,y:target.y+40,steps:6},
    {action:"mouse.up",button:"right",after_ms:180},
    {action:"mouse.move",x:blank.x,y:blank.y,steps:1,after_ms:80}
  ]);
  await sleep(500);
  snap=await native("network.snapshot",{limit:250});
  const rotateDiff=diff(beforeRotate,snap);
  const afterView=await native("page.evaluate",{expression:'document.querySelector("#canvas")?.getAttribute("data-view-shown")||null'});
  console.log("CF_PHASE0_NETOBS_ROTATE="+JSON.stringify({newCount:rotateDiff.length,events:compact(rotateDiff),clues:clues(rotateDiff),viewAfter:afterView.value}));

  // Clear selection; no attempt to restore free rotation via inverse drag.
  await input([{action:"mouse.click",x:blank.x,y:blank.y,button:"left",click_count:1,after_ms:100}]);

  const summary={
    moveAny:moveResults.some(x=>x.newCount>0),
    moveSemanticClue:moveResults.some(x=>x.clues.length>0),
    clickAny:clickDiff.length>0,
    clickSemanticClue:clues(clickDiff).length>0,
    rotateAny:rotateDiff.length>0,
    rotateCameraClue:clues(rotateDiff).some(x=>/(view|camera|graphics|display|project)/i.test(String(x.pathname||"")+" "+String(x.search||"")))
  };
  console.log("CF_PHASE0_NETOBS_VERDICT="+JSON.stringify(summary));
  console.log("CF_PHASE0_NETOBS=pass");
} finally { await c.close().catch(()=>{}); }
NODE

PYTHONPATH="$release/server-deploy/current/fabric-src" python3 - <<'PY'
from capability_fabric.persistence import SqliteExecutionStateStore
p="/var/lib/capability-fabric/onshape-research-phase0/fabric-state/execution.sqlite3"
with SqliteExecutionStateStore(p) as s:
    assert not s.recoverable()
print("CF_PHASE0_NETOBS_POST_RECOVERABLE=zero")
PY
