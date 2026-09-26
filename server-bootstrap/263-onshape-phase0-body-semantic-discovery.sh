#!/usr/bin/env bash
set -euo pipefail
umask 077
[[ "$(id -u)" -eq 0 ]] || exit 2
candidate="c0cadee962c2059ba939c40c6bb9adf1bc99edfe"
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
print("CF_PHASE0_BODYDISC_PRODUCTION_BOUNDARY=pass")
print("CF_PHASE0_BODYDISC_CONTROL_REV="+str(d["controlRevision"]))
print("CF_PHASE0_BODYDISC_EPOCH="+str(a["productionEpoch"]))
PY

for c in "$research" "$sidecar"; do
  [[ "$(docker inspect -f '{{.State.Running}}' "$c" 2>/dev/null || echo false)" == true ]]
  [[ "$(docker inspect -f '{{.State.Health.Status}}' "$c")" == healthy ]]
done
env_dump="$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$research")"
grep -Fxq "CF_RESEARCH_SOURCE_COMMIT=$candidate" <<<"$env_dump"
grep -Fxq "CF_RESEARCH_FIXTURE_TARGET=$fixture" <<<"$env_dump"
echo CF_PHASE0_BODYDISC_BINDING=pass

PYTHONPATH="$release/server-deploy/current/fabric-src" python3 - <<'PY'
from capability_fabric.persistence import SqliteExecutionStateStore
p="/var/lib/capability-fabric/onshape-research-phase0/fabric-state/execution.sqlite3"
with SqliteExecutionStateStore(p) as s:
    assert not s.recoverable()
print("CF_PHASE0_BODYDISC_RECOVERABLE=zero")
PY

docker exec -e CF_FIXTURE="$fixture" -i "$research" sh -lc 'cd /tmp/app && node --input-type=module' <<'NODE'
import fs from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const [did,wid,eid]=process.env.CF_FIXTURE.split(":");
const token=fs.readFileSync("/run/secrets/mcp-token","utf8").trim();
const c=new Client({name:"cf-phase0-body-semantic-discovery",version:"1.0"});
await c.connect(new StreamableHTTPClientTransport(new URL("http://127.0.0.1:8898/mcp/"+token)));
const parse=r=>JSON.parse((r.content||[]).filter(x=>x.type==="text").map(x=>x.text).join("\n"));
const call=async(name,args={})=>parse(await c.callTool({name,arguments:args},undefined,{timeout:180000}));
const viewer=async(params)=>{
  const w=await call("onshape_ui_native",{document_id:did,workspace_id:wid,element_id:eid,action:"runtime.viewer",params});
  const r=w.result;
  if(r?.outcome?.state!=="ACHIEVED"||r?.observation?.ackState!=="ACKNOWLEDGED") throw new Error(JSON.stringify(r));
  return r.observation.evidence.result;
};
const evalp=async(expression)=>{
  const w=await call("onshape_ui_native",{document_id:did,workspace_id:wid,element_id:eid,action:"page.evaluate",params:{expression}});
  const r=w.result;
  if(r?.outcome?.state!=="ACHIEVED"||r?.observation?.ackState!=="ACKNOWLEDGED") throw new Error(JSON.stringify(r));
  return r.observation.evidence.result.value;
};

try{
  const st=await call("onshape_session_status");
  if(st?.auth?.state!=="PROVEN"||st?.auth?.http_status!==200) throw new Error("auth");
  console.log("CF_PHASE0_BODYDISC_AUTH=PROVEN");

  const base=await viewer({op:"inspect"});
  console.log("CF_PHASE0_BODYDISC_MODEL_SELECTION="+JSON.stringify(base?.model_selection||null));

  const dom=await evalp(`(() => {
    const target="Part 1";
    const attrs=(el)=>{
      const out={};
      for(const a of Array.from(el.attributes||[]).slice(0,32)){
        if(a.name==="id"||a.name==="class"||a.name==="role"||a.name==="title"||a.name==="aria-label"||a.name.startsWith("data-")) out[a.name]=String(a.value).slice(0,300);
      }
      return out;
    };
    const rect=(el)=>{const r=el.getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height,right:r.right,bottom:r.bottom};};
    const visible=(el)=>{const r=el.getBoundingClientRect();const s=getComputedStyle(el);return r.width>1&&r.height>1&&s.display!=="none"&&s.visibility!=="hidden"&&Number(s.opacity||1)>0;};
    const matched=[];
    for(const el of Array.from(document.querySelectorAll("*"))){
      if(!visible(el)) continue;
      const text=(el.textContent||"").trim();
      const exactText=text===target;
      const title=(el.getAttribute("title")||"").trim();
      const aria=(el.getAttribute("aria-label")||"").trim();
      if(!(exactText||title===target||aria===target)) continue;
      const chain=[];
      let p=el;
      for(let i=0;i<6&&p;i++,p=p.parentElement){
        chain.push({tag:p.tagName,id:p.id||null,className:typeof p.className==="string"?p.className.slice(0,500):null,attrs:attrs(p),rect:rect(p),text:(p.textContent||"").trim().slice(0,300)});
      }
      matched.push({tag:el.tagName,id:el.id||null,className:typeof el.className==="string"?el.className.slice(0,500):null,attrs:attrs(el),rect:rect(el),text:text.slice(0,300),children:el.children.length,chain});
      if(matched.length>=20) break;
    }
    return {title:document.title,url:location.href,matches:matched};
  })()`);
  console.log("CF_PHASE0_BODYDISC_DOM="+JSON.stringify(dom));
  console.log("CF_PHASE0_BODYDISC=pass");
} finally { await c.close().catch(()=>{}); }
NODE

PYTHONPATH="$release/server-deploy/current/fabric-src" python3 - <<'PY'
from capability_fabric.persistence import SqliteExecutionStateStore
p="/var/lib/capability-fabric/onshape-research-phase0/fabric-state/execution.sqlite3"
with SqliteExecutionStateStore(p) as s:
    assert not s.recoverable()
print("CF_PHASE0_BODYDISC_POST_RECOVERABLE=zero")
PY
