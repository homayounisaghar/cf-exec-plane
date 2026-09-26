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
print("CF_PHASE0_EXP_PRODUCTION_BOUNDARY=pass")
PY
for c in "$research" "$sidecar"; do
 [[ "$(docker inspect -f '{{.State.Health.Status}}' "$c")" == healthy ]]
done
PYTHONPATH="$release/server-deploy/current/fabric-src" python3 - <<'PY'
from capability_fabric.persistence import SqliteExecutionStateStore
p="/var/lib/capability-fabric/onshape-research-phase0/fabric-state/execution.sqlite3"
with SqliteExecutionStateStore(p) as s: assert not s.recoverable()
print("CF_PHASE0_EXP_RECOVERABLE=zero")
PY

docker exec -e CF_FIXTURE="$fixture" -e CF_CANDIDATE="$candidate" -i "$research" sh -lc 'cd /tmp/app && node --input-type=module' <<'NODE'
import fs from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const [did,wid,eid]=process.env.CF_FIXTURE.split(":");
const token=fs.readFileSync("/run/secrets/mcp-token","utf8").trim();
const client=new Client({name:"cf-phase0-exp",version:"1.0"});
await client.connect(new StreamableHTTPClientTransport(new URL("http://127.0.0.1:8898/mcp/"+token)));
const parse=(r)=>JSON.parse((r.content||[]).filter(x=>x.type==="text").map(x=>x.text).join("\n"));
const rawCall=async(name,args={})=>{
  const t0=performance.now();
  const res=parse(await client.callTool({name,arguments:args},undefined,{timeout:180000}));
  return {res,ms:performance.now()-t0};
};
const native=async(action,params={})=>{
  const {res,ms}=await rawCall("onshape_ui_native",{document_id:did,workspace_id:wid,element_id:eid,action,params});
  const r=res.result;
  if(r?.outcome?.state!=="ACHIEVED" || r?.observation?.ackState!=="ACKNOWLEDGED") throw new Error("native "+action+" "+JSON.stringify(r));
  return {value:r.observation.evidence.result,ms};
};
const input=async(steps)=>{
  const {res,ms}=await rawCall("onshape_ui_input",{document_id:did,workspace_id:wid,element_id:eid,steps});
  const r=res.result;
  if(r?.outcome?.state!=="ACHIEVED" || r?.observation?.ackState!=="ACKNOWLEDGED") throw new Error("input "+JSON.stringify(r));
  return {value:r.observation.evidence,ms};
};
const q=(xs,p)=>{
  const a=[...xs].sort((x,y)=>x-y); if(!a.length)return null;
  const i=(a.length-1)*p,lo=Math.floor(i),hi=Math.ceil(i);
  return a[lo]+(a[hi]-a[lo])*(i-lo);
};
const stats=(xs)=>({n:xs.length,min:+Math.min(...xs).toFixed(2),p50:+q(xs,.5).toFixed(2),p95:+q(xs,.95).toFixed(2),max:+Math.max(...xs).toFixed(2),mean:+(xs.reduce((a,b)=>a+b,0)/xs.length).toFixed(2)});
const metaExpr=String.raw`(() => {
  const c=document.querySelector("canvas#canvas"); const r=c?.getBoundingClientRect();
  const brief=(el)=>({tag:el?.tagName?.toLowerCase()||null,id:el?.id||null,cls:String(el?.className||"").slice(0,250),aria:el?.getAttribute?.("aria-label")||null,title:el?.getAttribute?.("title")||null,text:String(el?.textContent||"").trim().replace(/\s+/g," ").slice(0,300)});
  const sel=Array.from(document.querySelectorAll('[aria-selected="true"],[class*="selected" i],[class*="selection" i]')).slice(0,80).map(brief);
  const contextual=Array.from(document.querySelectorAll('body *')).filter(el=>/(face|edge|vertex|part\s*[0-9]|selected|selection)/i.test(String(el.textContent||"")) && el.children.length<12).slice(0,80).map(brief);
  const bt={};
  for(const n of ["SelectItemOptions","SelectItemViewState"]){
    const C=window.BTSelectItem?.[n]; if(!C)continue;
    try{bt[n]={own:Object.getOwnPropertyNames(C),proto:Object.getOwnPropertyNames(C.prototype||{}),src:String(C).slice(0,1200)}}catch(e){bt[n]={error:String(e)}}
  }
  return {
    canvas:r?{x:r.x,y:r.y,w:r.width,h:r.height,view:c.getAttribute("data-view-shown")} : null,
    selected:sel, contextual,
    bt,
    active:brief(document.activeElement)
  };
})()`;
const meta=async()=> (await native("page.evaluate",{expression:metaExpr})).value.value;
const shot=async(label)=>{
  const x=await native("page.screenshot",{full_page:false});
  console.log("CF_PHASE0_EXP_SHOT_"+label+"="+JSON.stringify({ms:+x.ms.toFixed(2),artifact:x.value.artifact}));
  return x.value.artifact;
};
const hash=(a)=>a?.sha256||a?.sha_256||a?.digest||a?.content_sha256||a?.artifact_id||JSON.stringify(a);

try{
  const status=await rawCall("onshape_session_status");
  if(status.res?.auth?.state!=="PROVEN") throw new Error("auth");
  console.log("CF_PHASE0_EXP_STATUS_MS="+status.ms.toFixed(2));

  // A0 initial no-effect / observation samples.
  const evalTimes=[];
  for(let i=0;i<7;i++){
    const x=await native("page.evaluate",{expression:"({t:performance.now(),href:location.href})"});
    evalTimes.push(x.ms);
  }
  console.log("CF_PHASE0_A0_OBSERVATION_MS="+JSON.stringify(stats(evalTimes)));

  const m0=await meta();
  console.log("CF_PHASE0_EXP_META_BASE="+JSON.stringify(m0));
  const c=m0.canvas;
  if(!c) throw new Error("canvas missing");
  const cx=Math.round(c.x+c.w*0.52), cy=Math.round(c.y+c.h*0.50);
  const blankX=Math.round(c.x+c.w*0.93), blankY=Math.round(c.y+c.h*0.08);

  const s0=await shot("BASE");

  // P4 exploratory selection: one center click, then independent DOM/ARIA/native readback.
  const click=await input([{action:"mouse.click",x:cx,y:cy,button:"left",click_count:1,after_ms:150}]);
  console.log("CF_PHASE0_A0_SELECTION_COMMIT_MS="+click.ms.toFixed(2));
  const mSel=await meta();
  const aSel=await native("aria.snapshot",{selector:"body",timeout_ms:15000});
  const sSel=await shot("SELECTED");
  console.log("CF_PHASE0_P4_AFTER_CLICK="+JSON.stringify({point:{x:cx,y:cy},meta:mSel,ariaSample:String(aSel.value.snapshot||"").slice(0,4500),shotChanged:hash(sSel)!==hash(s0)}));

  // Attempt to clear selection by clicking a likely blank viewport corner; read back.
  const clear=await input([{action:"mouse.click",x:blankX,y:blankY,button:"left",click_count:1,after_ms:120}]);
  const mClear=await meta();
  console.log("CF_PHASE0_P4_CLEAR="+JSON.stringify({ms:+clear.ms.toFixed(2),point:{x:blankX,y:blankY},meta:mClear}));

  // P1 zoom: wheel and inverse wheel, compare screenshots + view-state label.
  const z0=await shot("ZOOM0");
  const zBefore=await meta();
  const z=await input([{action:"mouse.move",x:cx,y:cy},{action:"mouse.wheel",delta_x:0,delta_y:-700,after_ms:180}]);
  const z1=await shot("ZOOM1");
  const zAfter=await meta();
  const zr=await input([{action:"mouse.wheel",delta_x:0,delta_y:700,after_ms:180}]);
  const z2=await shot("ZOOM2");
  const zRestored=await meta();
  console.log("CF_PHASE0_P1_ZOOM="+JSON.stringify({forwardMs:+z.ms.toFixed(2),reverseMs:+zr.ms.toFixed(2),changed:hash(z1)!==hash(z0),restoredHash:hash(z2)===hash(z0),viewBefore:zBefore.canvas?.view,viewAfter:zAfter.canvas?.view,viewRestored:zRestored.canvas?.view}));

  // P1 rotate candidate: right-button drag then inverse.
  const r0=await shot("ROT0");
  const rBefore=await meta();
  const rot=await input([
    {action:"mouse.move",x:cx,y:cy},
    {action:"mouse.down",button:"right"},
    {action:"mouse.move",x:cx+120,y:cy+70,steps:8},
    {action:"mouse.up",button:"right",after_ms:220}
  ]);
  const r1=await shot("ROT1");
  const rAfter=await meta();
  const rotr=await input([
    {action:"mouse.move",x:cx+120,y:cy+70},
    {action:"mouse.down",button:"right"},
    {action:"mouse.move",x:cx,y:cy,steps:8},
    {action:"mouse.up",button:"right",after_ms:220}
  ]);
  const r2=await shot("ROT2");
  const rRestored=await meta();
  console.log("CF_PHASE0_P1_ROTATE="+JSON.stringify({forwardMs:+rot.ms.toFixed(2),reverseMs:+rotr.ms.toFixed(2),changed:hash(r1)!==hash(r0),restoredHash:hash(r2)===hash(r0),viewBefore:rBefore.canvas?.view,viewAfter:rAfter.canvas?.view,viewRestored:rRestored.canvas?.view}));

  // P1 pan candidate: middle-button drag then inverse.
  const p0=await shot("PAN0");
  const pBefore=await meta();
  const pan=await input([
    {action:"mouse.move",x:cx,y:cy},
    {action:"mouse.down",button:"middle"},
    {action:"mouse.move",x:cx+100,y:cy+60,steps:8},
    {action:"mouse.up",button:"middle",after_ms:220}
  ]);
  const p1=await shot("PAN1");
  const pAfter=await meta();
  const panr=await input([
    {action:"mouse.move",x:cx+100,y:cy+60},
    {action:"mouse.down",button:"middle"},
    {action:"mouse.move",x:cx,y:cy,steps:8},
    {action:"mouse.up",button:"middle",after_ms:220}
  ]);
  const p2=await shot("PAN2");
  const pRestored=await meta();
  console.log("CF_PHASE0_P1_PAN="+JSON.stringify({forwardMs:+pan.ms.toFixed(2),reverseMs:+panr.ms.toFixed(2),changed:hash(p1)!==hash(p0),restoredHash:hash(p2)===hash(p0),viewBefore:pBefore.canvas?.view,viewAfter:pAfter.canvas?.view,viewRestored:pRestored.canvas?.view}));

  console.log("CF_PHASE0_EXP=pass");
} finally { await client.close().catch(()=>{}); }
NODE

PYTHONPATH="$release/server-deploy/current/fabric-src" python3 - <<'PY'
from capability_fabric.persistence import SqliteExecutionStateStore
p="/var/lib/capability-fabric/onshape-research-phase0/fabric-state/execution.sqlite3"
with SqliteExecutionStateStore(p) as s:
    pending=s.recoverable()
    assert not pending, [(x.operation.operation_id if x.operation else None,x.attempt.attempt_id if x.attempt else None) for x in pending]
print("CF_PHASE0_EXP_POST_RECOVERABLE=zero")
PY
