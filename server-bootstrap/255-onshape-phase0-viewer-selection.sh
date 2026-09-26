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
d=json.load(open(sys.argv[1])); a=d["authority"]; g=a["productionGuard"]
assert a["mode"]=="VPS_PRODUCTION" and a["materialAuthority"]=="vps-fabric"
assert a["planes"]["android-v1"]["ingress"]=="CLOSED"
assert a["reconciliationHold"]["active"] is False
assert g["killSwitch"]=="ENGAGED" and g["allowedDocumentIds"]==[] and g["mutationBudget"]["maxMutations"]==0
print("CF_PHASE0_VIEWSEL_PRODUCTION_BOUNDARY=pass")
print("CF_PHASE0_VIEWSEL_CONTROL_REV="+str(d["controlRevision"]))
print("CF_PHASE0_VIEWSEL_EPOCH="+str(a["productionEpoch"]))
PY

for c in "$research" "$sidecar"; do
  [[ "$(docker inspect -f '{{.State.Running}}' "$c" 2>/dev/null || echo false)" == true ]]
  [[ "$(docker inspect -f '{{.State.Health.Status}}' "$c")" == healthy ]]
done
env_dump="$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$research")"
grep -Fxq "CF_RESEARCH_SOURCE_COMMIT=$candidate" <<<"$env_dump"
grep -Fxq "CF_RESEARCH_FIXTURE_TARGET=$fixture" <<<"$env_dump"
echo CF_PHASE0_VIEWSEL_BINDING=pass

PYTHONPATH="$release/server-deploy/current/fabric-src" python3 - <<'PY'
from capability_fabric.persistence import SqliteExecutionStateStore
p="/var/lib/capability-fabric/onshape-research-phase0/fabric-state/execution.sqlite3"
with SqliteExecutionStateStore(p) as s:
    pending=s.recoverable()
    assert not pending, [(x.operation.operation_id if x.operation else None,x.attempt.attempt_id if x.attempt else None) for x in pending]
print("CF_PHASE0_VIEWSEL_RECOVERABLE=zero")
PY

docker exec -e CF_FIXTURE="$fixture" -i "$research" sh -lc 'cd /tmp/app && node --input-type=module' <<'NODE'
import fs from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const [did,wid,eid]=process.env.CF_FIXTURE.split(":");
const token=fs.readFileSync("/run/secrets/mcp-token","utf8").trim();
const c=new Client({name:"cf-phase0-viewsel",version:"1.0"});
await c.connect(new StreamableHTTPClientTransport(new URL("http://127.0.0.1:8898/mcp/"+token)));
const parse=r=>JSON.parse((r.content||[]).filter(x=>x.type==="text").map(x=>x.text).join("\n"));
const call=async(name,args={})=>parse(await c.callTool({name,arguments:args},undefined,{timeout:180000}));
const viewer=async(params)=>{
  const w=await call("onshape_ui_native",{document_id:did,workspace_id:wid,element_id:eid,action:"runtime.viewer",params});
  const r=w.result;
  if(r?.outcome?.state!=="ACHIEVED"||r?.observation?.ackState!=="ACKNOWLEDGED") throw new Error("viewer "+JSON.stringify(r));
  return {value:r.observation.evidence.result, operation_id:r.operation_id||null};
};
const nativeEval=async(expression)=>{
  const w=await call("onshape_ui_native",{document_id:did,workspace_id:wid,element_id:eid,action:"page.evaluate",params:{expression}});
  const r=w.result;
  if(r?.outcome?.state!=="ACHIEVED"||r?.observation?.ackState!=="ACKNOWLEDGED") throw new Error("eval "+JSON.stringify(r));
  return r.observation.evidence.result.value;
};
const input=async(steps)=>{
  const w=await call("onshape_ui_input",{document_id:did,workspace_id:wid,element_id:eid,steps});
  const r=w.result;
  if(r?.outcome?.state!=="ACHIEVED"||r?.observation?.ackState!=="ACKNOWLEDGED") {
    console.log("CF_PHASE0_VIEWSEL_INPUT_NONTERMINAL="+JSON.stringify(r));
    throw new Error("input not achieved");
  }
  return r;
};
const compactSel=v=>({
  viewer:v?.viewer||null,
  probe:v?.probe||null,
  selection_manager:v?.selection_manager||null,
  camera:v?.camera||null,
  view_data:v?.view_data||null
});

try {
  const tools=(await c.listTools()).tools;
  const native=tools.find(x=>x.name==="onshape_ui_native");
  const actionEnum=native?.inputSchema?.properties?.action?.enum||[];
  if(!actionEnum.includes("runtime.viewer")) throw new Error("runtime.viewer absent");
  console.log("CF_PHASE0_VIEWSEL_SCHEMA=runtime.viewer");

  const st=await call("onshape_session_status");
  if(st?.auth?.state!=="PROVEN"||st?.auth?.http_status!==200) throw new Error("auth");
  console.log("CF_PHASE0_VIEWSEL_AUTH=PROVEN");

  const pre=await viewer({op:"probe",x_fraction:.52,y_fraction:.50});
  const picks=pre.value?.probe?.picks||[];
  if(pre.value?.probe?.status!=="HIT"||picks.length<1) throw new Error("precommit probe did not hit");
  const target=picks[0];
  if(typeof target.deterministic_id!=="string"||!target.deterministic_id) throw new Error("precommit deterministic identity absent");
  console.log("CF_PHASE0_VIEWSEL_PRE="+JSON.stringify(compactSel(pre.value)));
  console.log("CF_PHASE0_VIEWSEL_TARGET="+JSON.stringify({
    deterministic_id:target.deterministic_id,
    id:target.id,
    occurrence_id:target.occurrence_id,
    primitive_id:target.primitive_id,
    entity_metadata:target.entity_metadata,
    body_metadata:target.body_metadata,
    feature_ids:target.feature_ids
  }));

  const canvas=await nativeEval(`(() => {
    const el=document.querySelector("#canvas"); const r=el?.getBoundingClientRect();
    return r?{x:r.x,y:r.y,w:r.width,h:r.height}:null;
  })()`);
  if(!canvas||canvas.w<=1||canvas.h<=1) throw new Error("canvas");
  const click={x:Math.round(canvas.x+canvas.w*.52),y:Math.round(canvas.y+canvas.h*.50)};
  const away={x:Math.round(canvas.x+canvas.w*.90),y:Math.round(canvas.y+canvas.h*.88)};
  console.log("CF_PHASE0_VIEWSEL_COORDS="+JSON.stringify({canvas,click,away}));

  const committed=await input([{action:"mouse.click",x:click.x,y:click.y,button:"left",click_count:1,after_ms:180}]);
  console.log("CF_PHASE0_VIEWSEL_COMMIT="+JSON.stringify({
    operation_id:committed.operation_id||null,
    outcome:committed.result?.outcome||committed.outcome||null,
    observation:committed.result?.observation||committed.observation||null
  }));

  await input([{action:"mouse.move",x:away.x,y:away.y,steps:1,after_ms:140}]);
  const post=await viewer({op:"inspect"});
  console.log("CF_PHASE0_VIEWSEL_POST="+JSON.stringify(compactSel(post.value)));

  const postProbe=await viewer({op:"probe",x_fraction:.52,y_fraction:.50});
  console.log("CF_PHASE0_VIEWSEL_POST_PROBE="+JSON.stringify(compactSel(postProbe.value)));

  console.log("CF_PHASE0_VIEWSEL=pass");
} finally {
  await c.close().catch(()=>{});
}
NODE

PYTHONPATH="$release/server-deploy/current/fabric-src" python3 - <<'PY'
from capability_fabric.persistence import SqliteExecutionStateStore
p="/var/lib/capability-fabric/onshape-research-phase0/fabric-state/execution.sqlite3"
with SqliteExecutionStateStore(p) as s:
    pending=s.recoverable()
    assert not pending, [(x.operation.operation_id if x.operation else None,x.attempt.attempt_id if x.attempt else None) for x in pending]
print("CF_PHASE0_VIEWSEL_POST_RECOVERABLE=zero")
PY
