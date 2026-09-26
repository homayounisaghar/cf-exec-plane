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
print("CF_PHASE0_CORPUSINV_PRODUCTION_BOUNDARY=pass")
print("CF_PHASE0_CORPUSINV_CONTROL_REV="+str(d["controlRevision"]))
print("CF_PHASE0_CORPUSINV_EPOCH="+str(a["productionEpoch"]))
PY

for c in "$research" "$sidecar"; do
  [[ "$(docker inspect -f '{{.State.Running}}' "$c" 2>/dev/null || echo false)" == true ]]
  [[ "$(docker inspect -f '{{.State.Health.Status}}' "$c")" == healthy ]]
done
env_dump="$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$research")"
grep -Fxq "CF_RESEARCH_SOURCE_COMMIT=$candidate" <<<"$env_dump"
grep -Fxq "CF_RESEARCH_FIXTURE_TARGET=$fixture" <<<"$env_dump"
echo CF_PHASE0_CORPUSINV_BINDING=pass

PYTHONPATH="$release/server-deploy/current/fabric-src" python3 - <<'PY'
from capability_fabric.persistence import SqliteExecutionStateStore
p="/var/lib/capability-fabric/onshape-research-phase0/fabric-state/execution.sqlite3"
with SqliteExecutionStateStore(p) as s:
    assert not s.recoverable()
print("CF_PHASE0_CORPUSINV_RECOVERABLE=zero")
PY

docker exec -e CF_FIXTURE="$fixture" -i "$research" sh -lc 'cd /tmp/app && node --input-type=module' <<'NODE'
import fs from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const [did,wid,eid]=process.env.CF_FIXTURE.split(":");
const token=fs.readFileSync("/run/secrets/mcp-token","utf8").trim();
const c=new Client({name:"cf-phase0-policy-corpus-inventory",version:"1.0"});
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
const clean=(x,kind)=>({
  kind,
  raw_id:x?.id??null,
  entity_type:x?.entity_type??null,
  is_face:x?.is_face??null,
  is_edge:x?.is_edge??null,
  body_id:x?.body_id??null,
  composite_or_body_id:x?.composite_or_body_id??null,
  edge_type:x?.edge_type??null,
  surface_type:x?.surface_type??null,
  first_feature_id:x?.first_feature_id??null,
  last_feature_id:x?.last_feature_id??null,
  feature_ids:x?.feature_ids??null,
  setting_index:x?.setting_index??null,
  own_keys:x?.own && typeof x.own==="object" ? Object.keys(x.own).slice(0,40) : [],
  points_type:Array.isArray(x?.own?.points)?"array":typeof x?.own?.points,
  points_len:Array.isArray(x?.own?.points)?x.own.points.length:null,
  points_head:Array.isArray(x?.own?.points)?x.own.points.slice(0,18):x?.own?.points??null,
  compressed_points_type:Array.isArray(x?.own?.compressedPoints)?"array":typeof x?.own?.compressedPoints,
  compressed_points_len:Array.isArray(x?.own?.compressedPoints)?x.own.compressedPoints.length:null,
  compressed_points_head:Array.isArray(x?.own?.compressedPoints)?x.own.compressedPoints.slice(0,18):x?.own?.compressedPoints??null,
  indices_type:Array.isArray(x?.own?.indices)?"array":typeof x?.own?.indices,
  indices_len:Array.isArray(x?.own?.indices)?x.own.indices.length:null,
  indices_head:Array.isArray(x?.own?.indices)?x.own.indices.slice(0,18):x?.own?.indices??null,
  deterministic_id:x?.own?.deterministicId??x?.own?.entityMetaData?.meshIncrement?.id??x?.own?.selectionId??null,
  metadata_body_id:x?.own?.entityMetaData?.bodyId??null,
  metadata_name:x?.own?.entityMetaData?.bodyMetaData?.name??null,
  metadata_feature_ids:x?.own?.entityMetaData?.featureIds??null
});
try{
  const st=await call("onshape_session_status");
  if(st?.auth?.state!=="PROVEN"||st?.auth?.http_status!==200) throw new Error("auth");
  console.log("CF_PHASE0_CORPUSINV_AUTH=PROVEN");

  const scan=await viewer({op:"selection_scan"});
  const faces=(scan?.selection_scan?.faces?.active||[]).slice(0,32).map(x=>clean(x,"FACE"));
  const edges=(scan?.selection_scan?.edges?.active||[]).slice(0,32).map(x=>clean(x,"EDGE"));
  console.log("CF_PHASE0_CORPUSINV_FACE_COUNT="+JSON.stringify({heap:scan?.selection_scan?.faces?.count??null,active:faces.length}));
  console.log("CF_PHASE0_CORPUSINV_EDGE_COUNT="+JSON.stringify({heap:scan?.selection_scan?.edges?.count??null,active:edges.length}));
  console.log("CF_PHASE0_CORPUSINV_FACES="+JSON.stringify(faces));
  console.log("CF_PHASE0_CORPUSINV_EDGES="+JSON.stringify(edges));

  const domExpr='(() => { const vis=el=>{const r=el.getBoundingClientRect(),s=getComputedStyle(el);return r.width>1&&r.height>1&&s.display!=="none"&&s.visibility!=="hidden"}; const row=el=>{const r=el.getBoundingClientRect();return {tag:el.tagName,className:String(el.className||""),data_id:el.getAttribute("data-id"),text:String(el.textContent||"").trim().replace(/\\s+/g," ").slice(0,240),rect:{x:r.x,y:r.y,w:r.width,h:r.height}}}; const parts=Array.from(document.querySelectorAll("#part-list [data-id]")).filter(vis).map(row).slice(0,40); const left=Array.from(document.querySelectorAll(".panel-content-pane [data-id], #model-body [data-id]")).filter(vis).map(row); const seen=new Set(),semantic=[]; for(const x of left){const k=[x.data_id,x.text,x.rect.x,x.rect.y,x.rect.w,x.rect.h].join("|");if(!seen.has(k)){seen.add(k);semantic.push(x)}if(semantic.length>=80)break} return {parts,semantic}; })()';
  const dom=await evalp(domExpr);
  console.log("CF_PHASE0_CORPUSINV_DOM="+JSON.stringify(dom));
  console.log("CF_PHASE0_CORPUSINV=pass");
} finally { await c.close().catch(()=>{}); }
NODE

PYTHONPATH="$release/server-deploy/current/fabric-src" python3 - <<'PY'
from capability_fabric.persistence import SqliteExecutionStateStore
p="/var/lib/capability-fabric/onshape-research-phase0/fabric-state/execution.sqlite3"
with SqliteExecutionStateStore(p) as s:
    assert not s.recoverable()
print("CF_PHASE0_CORPUSINV_POST_RECOVERABLE=zero")
PY
