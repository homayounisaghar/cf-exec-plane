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
print("CF_PHASE0_PICKSRC_PRODUCTION_BOUNDARY=pass")
PY
for c in "$research" "$sidecar"; do
  [[ "$(docker inspect -f '{{.State.Health.Status}}' "$c")" == healthy ]]
done
PYTHONPATH="$release/server-deploy/current/fabric-src" python3 - <<'PY'
from capability_fabric.persistence import SqliteExecutionStateStore
p="/var/lib/capability-fabric/onshape-research-phase0/fabric-state/execution.sqlite3"
with SqliteExecutionStateStore(p) as s: assert not s.recoverable()
print("CF_PHASE0_PICKSRC_RECOVERABLE=zero")
PY

docker exec -e CF_FIXTURE="$fixture" -i "$research" sh -lc 'cd /tmp/app && node --input-type=module' <<'NODE'
import fs from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
const [did,wid,eid]=process.env.CF_FIXTURE.split(":");
const token=fs.readFileSync("/run/secrets/mcp-token","utf8").trim();
const c=new Client({name:"cf-phase0-picksrc",version:"1.0"});
await c.connect(new StreamableHTTPClientTransport(new URL("http://127.0.0.1:8898/mcp/"+token)));
const parse=r=>JSON.parse((r.content||[]).filter(x=>x.type==="text").map(x=>x.text).join("\n"));
const call=async(name,args={})=>parse(await c.callTool({name,arguments:args},undefined,{timeout:180000}));
try {
  const st=await call("onshape_session_status");
  if(st?.auth?.state!=="PROVEN") throw new Error("auth");
  const expression=String.raw`(() => {
    const arr=window.webpackChunkNewton;
    if(!Array.isArray(arr)) return {error:"chunk missing"};
    const modules=new Map();
    for(const entry of arr){
      const map=entry?.[1];
      if(map&&typeof map==="object") for(const [id,fn] of Object.entries(map)) if(typeof fn==="function") modules.set(id,String(fn));
    }
    const terms=["pickId","readPixels","FRAMEBUFFER_BINDING","groupId","ownerId","pickBuffer","picking","entityDIds","deterministicIdList"];
    const out=[];
    for(const [id,src] of modules){
      const low=src.toLowerCase(); const hits=[];
      for(const term of terms){
        let pos=0,count=0;
        while((pos=low.indexOf(term.toLowerCase(),pos))>=0 && count<4){
          hits.push({term,snippet:src.slice(Math.max(0,pos-1100),Math.min(src.length,pos+3200))});
          pos+=term.length; count++;
        }
      }
      if(hits.length) out.push({id,hits:hits.slice(0,18)});
    }
    return {moduleCount:modules.size,matches:out.slice(0,100)};
  })()`;
  const w=await call("onshape_ui_native",{document_id:did,workspace_id:wid,element_id:eid,action:"page.evaluate",params:{expression}});
  const r=w.result;
  if(r?.outcome?.state!=="ACHIEVED"||r?.observation?.ackState!=="ACKNOWLEDGED") throw new Error(JSON.stringify(r));
  console.log("CF_PHASE0_PICKSRC_RESULT="+JSON.stringify(r.observation.evidence.result.value));
  console.log("CF_PHASE0_PICKSRC=pass");
} finally { await c.close().catch(()=>{}); }
NODE

PYTHONPATH="$release/server-deploy/current/fabric-src" python3 - <<'PY'
from capability_fabric.persistence import SqliteExecutionStateStore
p="/var/lib/capability-fabric/onshape-research-phase0/fabric-state/execution.sqlite3"
with SqliteExecutionStateStore(p) as s: assert not s.recoverable()
print("CF_PHASE0_PICKSRC_POST_RECOVERABLE=zero")
PY
