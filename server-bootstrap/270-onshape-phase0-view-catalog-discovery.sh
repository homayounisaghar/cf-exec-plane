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
print("CF_PHASE0_VIEWCATDISC_PRODUCTION_BOUNDARY=pass")
print("CF_PHASE0_VIEWCATDISC_CONTROL_REV="+str(d["controlRevision"]))
print("CF_PHASE0_VIEWCATDISC_EPOCH="+str(a["productionEpoch"]))
PY

for c in "$research" "$sidecar"; do
  [[ "$(docker inspect -f '{{.State.Running}}' "$c" 2>/dev/null || echo false)" == true ]]
  [[ "$(docker inspect -f '{{.State.Health.Status}}' "$c")" == healthy ]]
done
env_dump="$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$research")"
grep -Fxq "CF_RESEARCH_SOURCE_COMMIT=$candidate" <<<"$env_dump"
grep -Fxq "CF_RESEARCH_FIXTURE_TARGET=$fixture" <<<"$env_dump"
echo CF_PHASE0_VIEWCATDISC_BINDING=pass

PYTHONPATH="$release/server-deploy/current/fabric-src" python3 - <<'PY'
from capability_fabric.persistence import SqliteExecutionStateStore
p="/var/lib/capability-fabric/onshape-research-phase0/fabric-state/execution.sqlite3"
with SqliteExecutionStateStore(p) as s: assert not s.recoverable()
print("CF_PHASE0_VIEWCATDISC_RECOVERABLE=zero")
PY

docker exec -e CF_FIXTURE="$fixture" -i "$research" sh -lc 'cd /tmp/app && node --input-type=module' <<'NODE'
import fs from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
const [did,wid,eid]=process.env.CF_FIXTURE.split(":");
const token=fs.readFileSync("/run/secrets/mcp-token","utf8").trim();
const c=new Client({name:"cf-phase0-view-catalog-discovery",version:"1.0"});
await c.connect(new StreamableHTTPClientTransport(new URL("http://127.0.0.1:8898/mcp/"+token)));
const parse=r=>JSON.parse((r.content||[]).filter(x=>x.type==="text").map(x=>x.text).join("\n"));
const call=async(name,args={})=>parse(await c.callTool({name,arguments:args},undefined,{timeout:180000}));
const native=async(action,params={})=>{
  const w=await call("onshape_ui_native",{document_id:did,workspace_id:wid,element_id:eid,action,params});
  const r=w.result;if(r?.outcome?.state!=="ACHIEVED"||r?.observation?.ackState!=="ACKNOWLEDGED")throw new Error(JSON.stringify(r));
  return r.observation.evidence.result;
};
try{
 const st=await call("onshape_session_status");
 if(st?.auth?.state!=="PROVEN"||st?.auth?.http_status!==200)throw new Error("auth");
 console.log("CF_PHASE0_VIEWCATDISC_AUTH=PROVEN");
 const before=await native("runtime.viewer",{op:"inspect"});
 const sig=JSON.stringify((before?.model_selection?.selections||[]).map(x=>x.deterministic_id||x.selection_id||null));
 const expr=String.raw`(() => {
   const vis=e=>{const r=e.getBoundingClientRect(),s=getComputedStyle(e);return r.width>1&&r.height>1&&s.display!=="none"&&s.visibility!=="hidden"};
   const interesting=e=>{
     const vals=[e.getAttribute("aria-label"),e.getAttribute("title"),e.getAttribute("data-tooltip"),e.getAttribute("data-id"),e.id,e.className,String(e.textContent||"").trim()].filter(Boolean).map(String);
     const joined=vals.join(" | ");
     return /view|cube|iso|front|back|left|right|top|bottom|camera|fit|orient/i.test(joined);
   };
   const out=[];
   for(const e of Array.from(document.querySelectorAll("button,[role=button],[aria-label],[title],[data-tooltip],[data-id],svg,g,div")).filter(vis).filter(interesting)){
     const r=e.getBoundingClientRect();
     out.push({tag:e.tagName,id:e.id||null,className:String(e.className||"").slice(0,180),aria:e.getAttribute("aria-label"),title:e.getAttribute("title"),tooltip:e.getAttribute("data-tooltip"),data_id:e.getAttribute("data-id"),text:String(e.textContent||"").trim().replace(/\s+/g," ").slice(0,180),rect:{x:r.x,y:r.y,w:r.width,h:r.height}});
     if(out.length>=200)break;
   }
   return out;
 })()`;
 const dom=await native("page.evaluate",{expression:expr});
 console.log("CF_PHASE0_VIEWCATDISC_DOM="+JSON.stringify(dom?.value||dom));
 const after=await native("runtime.viewer",{op:"inspect"});
 const sig2=JSON.stringify((after?.model_selection?.selections||[]).map(x=>x.deterministic_id||x.selection_id||null));
 if(sig!==sig2)throw new Error("read-only discovery changed selection");
 console.log("CF_PHASE0_VIEWCATDISC_SELECTION_UNCHANGED=pass");
 console.log("CF_PHASE0_VIEWCATDISC=pass");
} finally {await c.close().catch(()=>{});}
NODE

PYTHONPATH="$release/server-deploy/current/fabric-src" python3 - <<'PY'
from capability_fabric.persistence import SqliteExecutionStateStore
p="/var/lib/capability-fabric/onshape-research-phase0/fabric-state/execution.sqlite3"
with SqliteExecutionStateStore(p) as s: assert not s.recoverable()
print("CF_PHASE0_VIEWCATDISC_POST_RECOVERABLE=zero")
PY
