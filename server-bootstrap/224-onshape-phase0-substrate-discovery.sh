#!/usr/bin/env bash
set -euo pipefail
umask 077
[[ "$(id -u)" -eq 0 ]] || exit 2

candidate="d882fa763b3a55be5a18d6e196d028ff4f77ea07"
fixture="a19e0fa5152af9f7ce106b6e:e5e7d0173fd1f1d0307a2cb6:e0929361aadb6135b5cecffa"
control=/var/lib/capability-fabric/onshape/runtime-control/ONSHAPE_RUNTIME_CONTROL.json
research=capability-fabric-onshape-phase0-research
sidecar=capability-fabric-onshape-phase0-fabric

# Fresh production boundary: research continues only while production remains fail-closed.
python3 - "$control" <<'PY'
import json,sys
d=json.load(open(sys.argv[1])); a=d["authority"]; g=a["productionGuard"]
assert a["mode"]=="VPS_PRODUCTION" and a["materialAuthority"]=="vps-fabric"
assert a["planes"]["android-v1"]["ingress"]=="CLOSED"
assert a["reconciliationHold"]["active"] is False
assert g["killSwitch"]=="ENGAGED" and g["allowedDocumentIds"]==[] and g["mutationBudget"]["maxMutations"]==0
print("CF_PHASE0_DISCOVERY_PRODUCTION_BOUNDARY=pass")
print("CF_PHASE0_DISCOVERY_CONTROL_REV="+str(d["controlRevision"]))
print("CF_PHASE0_DISCOVERY_EPOCH="+str(a["productionEpoch"]))
PY

for c in "$research" "$sidecar"; do
  [[ "$(docker inspect -f '{{.State.Running}}' "$c" 2>/dev/null || echo false)" == true ]]
  [[ "$(docker inspect -f '{{.State.Health.Status}}' "$c")" == healthy ]]
done
env_dump="$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$research")"
grep -Fxq "CF_RESEARCH_SOURCE_COMMIT=$candidate" <<<"$env_dump"
grep -Fxq "CF_RESEARCH_FIXTURE_TARGET=$fixture" <<<"$env_dump"
side_env="$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$sidecar")"
grep -Fxq 'CF_FABRIC_AGENT_PORT=8899' <<<"$side_env"
echo CF_PHASE0_DISCOVERY_BINDING=pass

release="/var/lib/capability-fabric/onshape-research-phase0/releases/$candidate"
PYTHONPATH="$release/server-deploy/current/fabric-src" python3 - <<'PY'
from capability_fabric.persistence import SqliteExecutionStateStore
p="/var/lib/capability-fabric/onshape-research-phase0/fabric-state/execution.sqlite3"
with SqliteExecutionStateStore(p) as state:
    pending=state.recoverable()
    assert len(pending)==0, [(x.operation.operation_id if x.operation else None, x.attempt.attempt_id if x.attempt else None) for x in pending]
print("CF_PHASE0_DISCOVERY_RECOVERABLE=zero")
PY

docker exec -e CF_FIXTURE="$fixture" -e CF_CANDIDATE="$candidate" -i "$research" sh -lc 'cd /tmp/app && node --input-type=module' <<'NODE'
import fs from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const [did,wid,eid]=process.env.CF_FIXTURE.split(":");
const candidate=process.env.CF_CANDIDATE;
const token=fs.readFileSync("/run/secrets/mcp-token","utf8").trim();
const client=new Client({name:"cf-phase0-discovery",version:"1.0.0"});
await client.connect(new StreamableHTTPClientTransport(new URL("http://127.0.0.1:8898/mcp/"+token)));

const parse=(res)=>{
  const raw=(res?.content||[]).filter(x=>x.type==="text").map(x=>x.text||"").join("\n");
  if(!raw) throw new Error("empty MCP result");
  return JSON.parse(raw);
};
const call=async(name,args={})=>parse(await client.callTool({name,arguments:args},undefined,{timeout:180000}));
const assert=(v,m)=>{if(!v) throw new Error(m)};
const native=async(action,params={})=>{
  const wrap=await call("onshape_ui_native",{document_id:did,workspace_id:wid,element_id:eid,action,params});
  const r=wrap.result;
  if(r?.outcome?.state!=="ACHIEVED" || r?.observation?.ackState!=="ACKNOWLEDGED") {
    throw new Error("native not achieved "+action+" "+JSON.stringify(r));
  }
  return r.observation.evidence.result;
};
const input=async(steps)=>{
  const wrap=await call("onshape_ui_input",{document_id:did,workspace_id:wid,element_id:eid,steps});
  const r=wrap.result;
  if(r?.outcome?.state!=="ACHIEVED" || r?.observation?.ackState!=="ACKNOWLEDGED") {
    throw new Error("input not achieved "+JSON.stringify(r));
  }
  return r.observation.evidence;
};

const discoveryExpr=String.raw`(() => {
  const clean=(v,n=180)=>String(v??"").slice(0,n);
  const brief=(el)=>({
    tag:el?.tagName?.toLowerCase()||null,
    id:clean(el?.id),
    cls:clean(el?.className),
    role:clean(el?.getAttribute?.("role")),
    aria:clean(el?.getAttribute?.("aria-label")),
    title:clean(el?.getAttribute?.("title")),
    data:Object.fromEntries(Array.from(el?.attributes||[]).filter(a=>/^data-/.test(a.name)).slice(0,12).map(a=>[a.name,clean(a.value,120)])),
  });
  const canvases=Array.from(document.querySelectorAll("canvas")).map(c=>{
    const r=c.getBoundingClientRect();
    return {...brief(c), width:c.width,height:c.height, rect:{x:r.x,y:r.y,width:r.width,height:r.height}};
  });
  const candidates=Array.from(document.querySelectorAll('[class*="select" i],[class*="hover" i],[data-testid],[data-entity],[data-node-id],[aria-selected="true"]'))
    .slice(0,80).map(brief);
  const keys=Object.getOwnPropertyNames(window).filter(k=>/(camera|view|select|pick|hit|render|scene|entity|graphics|viewport)/i.test(k)).slice(0,120)
    .map(k=>({k,t:typeof window[k]}));
  return {
    href:location.href,title:document.title,ready:document.readyState,
    inner:{w:innerWidth,h:innerHeight,dpr:devicePixelRatio},
    active:brief(document.activeElement),
    canvases,candidates,windowKeys:keys,
    bodyClasses:clean(document.body?.className,500)
  };
})()`;

const pointExpr=(x,y)=>`(() => {
  const x=${x},y=${y};
  const clean=(v,n=200)=>String(v??"").slice(0,n);
  const brief=(el)=>({tag:el?.tagName?.toLowerCase()||null,id:clean(el?.id),cls:clean(el?.className),role:clean(el?.getAttribute?.("role")),aria:clean(el?.getAttribute?.("aria-label")),title:clean(el?.getAttribute?.("title")),text:clean(el?.textContent,140)});
  return {
    x,y,
    stack:document.elementsFromPoint(x,y).slice(0,10).map(brief),
    active:brief(document.activeElement),
    selected:Array.from(document.querySelectorAll('[aria-selected="true"],[class*="selected" i],[class*="selection" i]')).slice(0,30).map(brief),
    hovered:Array.from(document.querySelectorAll(':hover')).slice(-12).map(brief)
  };
})()`;

try{
  const status=await call("onshape_session_status");
  assert(status?.auth?.state==="PROVEN" && status.build_id==="onshape-phase0-"+candidate.slice(0,12),"auth/build");
  console.log("CF_PHASE0_DISCOVERY_AUTH=pass");

  const base=await native("page.evaluate",{expression:discoveryExpr});
  console.log("CF_PHASE0_DISCOVERY_BASE="+JSON.stringify(base.value));

  const w=Number(base.value?.inner?.w||1440), h=Number(base.value?.inner?.h||1000);
  const pts=[
    [Math.round(w*0.35),Math.round(h*0.35)],
    [Math.round(w*0.50),Math.round(h*0.50)],
    [Math.round(w*0.65),Math.round(h*0.50)],
    [Math.round(w*0.50),Math.round(h*0.65)],
    [Math.round(w*0.72),Math.round(h*0.35)]
  ];
  for(let i=0;i<pts.length;i++){
    const [x,y]=pts[i];
    const t0=performance.now();
    await input([{action:"mouse.move",x,y,steps:1,after_ms:80}]);
    const moveMs=performance.now()-t0;
    const snap=await native("page.evaluate",{expression:pointExpr(x,y)});
    console.log("CF_PHASE0_DISCOVERY_POINT_"+i+"="+JSON.stringify({moveMs:Number(moveMs.toFixed(2)),...snap.value}));
  }

  const aria=await native("aria.snapshot",{selector:"body",timeout_ms:15000});
  console.log("CF_PHASE0_DISCOVERY_ARIA="+JSON.stringify({chars:String(aria.snapshot||"").length,sample:String(aria.snapshot||"").slice(0,3500)}));
  console.log("CF_PHASE0_DISCOVERY=pass");
} finally {
  await client.close().catch(()=>{});
}
NODE

# No uncertain work may remain after a discovery run.
PYTHONPATH="$release/server-deploy/current/fabric-src" python3 - <<'PY'
from capability_fabric.persistence import SqliteExecutionStateStore
p="/var/lib/capability-fabric/onshape-research-phase0/fabric-state/execution.sqlite3"
with SqliteExecutionStateStore(p) as state:
    pending=state.recoverable()
    assert len(pending)==0, [(x.operation.operation_id if x.operation else None, x.attempt.attempt_id if x.attempt else None) for x in pending]
print("CF_PHASE0_DISCOVERY_POST_RECOVERABLE=zero")
PY
