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
print("CF_PHASE0_CALLSITE_PRODUCTION_BOUNDARY=pass")
print("CF_PHASE0_CALLSITE_CONTROL_REV="+str(d["controlRevision"]))
print("CF_PHASE0_CALLSITE_EPOCH="+str(a["productionEpoch"]))
PY
for c in "$research" "$sidecar"; do
 [[ "$(docker inspect -f '{{.State.Running}}' "$c" 2>/dev/null || echo false)" == true ]]
 [[ "$(docker inspect -f '{{.State.Health.Status}}' "$c")" == healthy ]]
done
env_dump="$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$research")"
grep -Fxq "CF_RESEARCH_SOURCE_COMMIT=$candidate" <<<"$env_dump"
grep -Fxq "CF_RESEARCH_FIXTURE_TARGET=$fixture" <<<"$env_dump"
echo CF_PHASE0_CALLSITE_BINDING=pass

PYTHONPATH="$release/server-deploy/current/fabric-src" python3 - <<'PY'
from capability_fabric.persistence import SqliteExecutionStateStore
p="/var/lib/capability-fabric/onshape-research-phase0/fabric-state/execution.sqlite3"
with SqliteExecutionStateStore(p) as s:
    assert not s.recoverable()
print("CF_PHASE0_CALLSITE_RECOVERABLE=zero")
PY

docker exec -e CF_FIXTURE="$fixture" -i "$research" sh -lc 'cd /tmp/app && node --input-type=module' <<'NODE'
import fs from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const [did,wid,eid]=process.env.CF_FIXTURE.split(":");
const token=fs.readFileSync("/run/secrets/mcp-token","utf8").trim();
const c=new Client({name:"cf-phase0-callsite",version:"1.0"});
await c.connect(new StreamableHTTPClientTransport(new URL("http://127.0.0.1:8898/mcp/"+token)));
const parse=(r)=>JSON.parse((r.content||[]).filter(x=>x.type==="text").map(x=>x.text).join("\n"));
const call=async(name,args)=>parse(await c.callTool({name,arguments:args},undefined,{timeout:180000}));
try{
 const expression=String.raw`(() => {
   const out={viewport:[],moduleRefs:[],symbolRefs:[]};
   let p=window.viewport, depth=0;
   while(p && depth<8){
     let names=[]; try{names=Object.getOwnPropertyNames(p)}catch{}
     const layer={depth,ctor:null,props:[]};
     try{layer.ctor=p?.constructor?.name||null}catch{}
     for(const name of names){
       if(!/(select|pick|hit|entity|camera|view|screen|world|ray|project|unproject|matrix|render|mouse|pointer|zoom|pan|rotate)/i.test(name)) continue;
       try{
         const d=Object.getOwnPropertyDescriptor(p,name);
         const rec={name,kind:d?.get?"getter":d?.set?"setter":typeof d?.value};
         if(typeof d?.value==="function") rec.source=String(d.value).slice(0,1800);
         if(typeof d?.get==="function") rec.getSource=String(d.get).slice(0,1000);
         layer.props.push(rec);
       }catch(e){layer.props.push({name,error:String(e)})}
     }
     if(layer.props.length) out.viewport.push(layer);
     try{p=Object.getPrototypeOf(p)}catch{break}
     depth++;
   }

   const chunkGlobals=Object.keys(window).filter(k=>/webpack.*chunk|chunk.*webpack/i.test(k));
   const wantedIds=["46045","49607","71316","78243","80123","81634"];
   const symbols=["temporarySelectionName","getDeterministicIds","setDeterministicIds","deterministicIds","related-highlight","selectOther","select other","hitTest","hit test","rayPoint","rayDirection","GBTQueryData","GBTUiGetProjectedUvOnEntityCall"];
   for(const cg of chunkGlobals){
     const arr=window[cg]; if(!Array.isArray(arr)) continue;
     const modules=new Map();
     for(const entry of arr){
       const map=entry?.[1];
       if(map&&typeof map==="object"){
         for(const [id,fn] of Object.entries(map)) if(typeof fn==="function") modules.set(id,String(fn));
       }
     }
     for(const [id,src] of modules){
       for(const wid of wantedIds){
         const pats=["("+wid+")","("+wid+",","="+wid," "+wid];
         let idx=-1;
         for(const pat of pats){ idx=src.indexOf(pat); if(idx>=0) break; }
         if(idx>=0) out.moduleRefs.push({chunk:cg,module:id,targetModule:wid,snippet:src.slice(Math.max(0,idx-900),Math.min(src.length,idx+2400))});
       }
       const lower=src.toLowerCase();
       for(const sym of symbols){
         const idx=lower.indexOf(sym.toLowerCase());
         if(idx>=0) out.symbolRefs.push({chunk:cg,module:id,symbol:sym,snippet:src.slice(Math.max(0,idx-900),Math.min(src.length,idx+2400))});
       }
     }
   }
   out.moduleRefs=out.moduleRefs.slice(0,120);
   out.symbolRefs=out.symbolRefs.slice(0,160);
   return out;
 })()`;
 const wrap=await call("onshape_ui_native",{document_id:did,workspace_id:wid,element_id:eid,action:"page.evaluate",params:{expression}});
 const r=wrap.result;
 if(r?.outcome?.state!=="ACHIEVED" || r?.observation?.ackState!=="ACKNOWLEDGED") throw new Error(JSON.stringify(r));
 const v=r.observation.evidence.result.value;
 console.log("CF_PHASE0_CALLSITE_VIEWPORT="+JSON.stringify(v.viewport));
 console.log("CF_PHASE0_CALLSITE_MODULE_REFS="+JSON.stringify(v.moduleRefs));
 console.log("CF_PHASE0_CALLSITE_SYMBOL_REFS="+JSON.stringify(v.symbolRefs));
 console.log("CF_PHASE0_CALLSITE=pass");
} finally { await c.close().catch(()=>{}); }
NODE

PYTHONPATH="$release/server-deploy/current/fabric-src" python3 - <<'PY'
from capability_fabric.persistence import SqliteExecutionStateStore
p="/var/lib/capability-fabric/onshape-research-phase0/fabric-state/execution.sqlite3"
with SqliteExecutionStateStore(p) as s:
    assert not s.recoverable()
print("CF_PHASE0_CALLSITE_POST_RECOVERABLE=zero")
PY
