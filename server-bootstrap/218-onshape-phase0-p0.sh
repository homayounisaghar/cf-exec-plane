#!/usr/bin/env bash
set -euo pipefail
umask 077

candidate="d882fa763b3a55be5a18d6e196d028ff4f77ea07"
fixture="a19e0fa5152af9f7ce106b6e:e5e7d0173fd1f1d0307a2cb6:e0929361aadb6135b5cecffa"
control=/var/lib/capability-fabric/onshape/runtime-control/ONSHAPE_RUNTIME_CONTROL.json
expected_control="1b9c248d8b57385a86c5c157bf99ef4f1f6928ce"
prod_gate=/var/lib/capability-fabric/state/release-in-progress
research=capability-fabric-onshape-phase0-research
sidecar=capability-fabric-onshape-phase0-fabric

[[ "$(id -u)" -eq 0 ]] || exit 2
[[ "$(git hash-object "$control")" == "$expected_control" ]] || exit 20
[[ -f "$prod_gate" ]] && grep -Fxq RELEASE_IN_PROGRESS "$prod_gate" || exit 21
for c in "$research" "$sidecar"; do
  [[ "$(docker inspect -f '{{.State.Running}}' "$c" 2>/dev/null || echo false)" == true ]] || exit 22
  [[ "$(docker inspect -f '{{.State.Health.Status}}' "$c")" == healthy ]] || exit 22
done
side_env="$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$sidecar")"
grep -Fxq 'CF_FABRIC_AGENT_PORT=8899' <<<"$side_env"
grep -Fxq 'CF_FABRIC_REQUIRE_PRODUCTION_AUTHORITY=0' <<<"$side_env"
echo CF_PHASE0_P0_AGENT_ROUTING=pass

release="/var/lib/capability-fabric/onshape-research-phase0/releases/$candidate"
PYTHONPATH="$release/server-deploy/current/fabric-src" python3 - <<'PY'
from capability_fabric.persistence import SqliteExecutionStateStore
p="/var/lib/capability-fabric/onshape-research-phase0/fabric-state/execution.sqlite3"
with SqliteExecutionStateStore(p) as state:
    pending=state.recoverable()
    assert len(pending)==0, [(x.operation.operation_id if x.operation else None, x.attempt.attempt_id if x.attempt else None) for x in pending]
print("CF_PHASE0_P0_RECOVERABLE=zero")
PY

docker exec -e CF_FIXTURE="$fixture" -e CF_CANDIDATE="$candidate" -i "$research" sh -lc 'cd /tmp/app && node --input-type=module' <<'NODE'
import fs from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const [did,wid,eid]=process.env.CF_FIXTURE.split(":");
const candidate=process.env.CF_CANDIDATE;
const token=fs.readFileSync("/run/secrets/mcp-token","utf8").trim();
const client=new Client({name:"cf-phase0-p0",version:"1.0.0"});
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
  assert(wrap.capability_id==="onshape.ui.native","native capability mismatch");
  const r=wrap.result;
  assert(r?.outcome?.state==="ACHIEVED","native outcome "+action);
  assert(r?.observation?.ackState==="ACKNOWLEDGED","native ack "+action);
  assert(r?.observation?.evidence?.nativeCompleted===true,"native incomplete "+action);
  return r.observation.evidence.result;
};
try {
  const status=await call("onshape_session_status");
  assert(status?.auth?.state==="PROVEN" && status?.auth?.http_status===200,"research auth not PROVEN");
  assert(status.build_id==="onshape-phase0-"+candidate.slice(0,12),"research build id mismatch");
  console.log("CF_PHASE0_P0_AUTH=pass");

  const caps=await call("onshape_fabric_capabilities");
  assert(caps.public_surface==="shadow" && caps.qualification_only===true,"research surface flags");
  const ids=(caps.capabilities||[]).map(x=>x.id).sort();
  assert(JSON.stringify(ids)===JSON.stringify(["onshape.session.status","onshape.ui.input.sequence","onshape.ui.native"].sort()),"capability catalog mismatch");
  console.log("CF_PHASE0_P0_CATALOG=pass");

  const shot=await native("page.screenshot",{full_page:false});
  assert(shot?.artifact?.content_type==="image/png" && Number(shot?.artifact?.size)>0,"screenshot artifact invalid");
  console.log("CF_PHASE0_P0_SCREENSHOT=pass");
  console.log("CF_PHASE0_P0_SCREENSHOT_SIZE="+Number(shot.artifact.size));

  const dom=await native("dom.inspect",{selector:"body"});
  assert(Number(dom?.count)>=1 && dom?.item?.tag==="body","DOM body unavailable");
  console.log("CF_PHASE0_P0_DOM=pass");

  const aria=await native("aria.snapshot",{selector:"body",timeout_ms:15000});
  assert(typeof aria?.snapshot==="string" && aria.snapshot.length>0,"ARIA snapshot unavailable");
  console.log("CF_PHASE0_P0_ARIA=pass");
  console.log("CF_PHASE0_P0_ARIA_CHARS="+aria.snapshot.length);

  const ev=await native("page.evaluate",{expression:"({href:location.href,title:document.title,readyState:document.readyState,canvasCount:document.querySelectorAll('canvas').length})"});
  assert(ev?.value?.readyState==="complete" || ev?.value?.readyState==="interactive","page not ready");
  assert(String(ev?.value?.href||"").includes("/documents/"+did+"/w/"+wid+"/e/"+eid),"page target mismatch");
  console.log("CF_PHASE0_P0_EVALUATE=pass");
  console.log("CF_PHASE0_P0_CANVAS_COUNT="+Number(ev.value.canvasCount||0));

  const input=await call("onshape_ui_input",{
    document_id:did,workspace_id:wid,element_id:eid,
    steps:[{action:"mouse.move",x_fraction:0.5,y_fraction:0.5}]
  });
  assert(input.capability_id==="onshape.ui.input.sequence","input capability mismatch");
  const ir=input.result;
  assert(ir?.outcome?.state==="ACHIEVED","input outcome");
  assert(ir?.observation?.ackState==="ACKNOWLEDGED","input ack");
  assert(ir?.observation?.evidence?.sequenceCompleted===true && ir?.observation?.evidence?.completedSteps===1,"input incomplete");
  console.log("CF_PHASE0_P0_INPUT=pass");
} finally {
  await client.close().catch(()=>{});
}
NODE

[[ "$(git hash-object "$control")" == "$expected_control" ]] || exit 23
[[ -f "$prod_gate" ]] && grep -Fxq RELEASE_IN_PROGRESS "$prod_gate" || exit 23
for c in capability-fabric-onshape-server capability-fabric-onshape-fabric; do
  [[ "$(docker inspect -f '{{.State.Running}}' "$c")" == true ]] || exit 23
done
[[ "$(docker inspect -f '{{.State.Running}}' capability-fabric-onshape-gateway 2>/dev/null || echo false)" == false ]] || exit 23

docker exec -i capability-fabric-onshape-server sh -lc 'cd /tmp/app && node --input-type=module' <<'NODE'
import fs from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
const token=fs.readFileSync("/run/secrets/mcp-token","utf8").trim();
const c=new Client({name:"cf-phase0-prod-check",version:"1.0.0"});
await c.connect(new StreamableHTTPClientTransport(new URL("http://127.0.0.1:8788/mcp/"+token)));
try{
  const names=(await c.listTools()).tools.map(x=>x.name);
  for(const bad of ["onshape_ui_native","onshape_ui_input","onshape_request","onshape_artifact"]) if(names.includes(bad)) throw new Error("production raw/UI tool exposed: "+bad);
  console.log("CF_PHASE0_P0_PRODUCTION_CATALOG=pass");
} finally { await c.close().catch(()=>{}); }
NODE

echo CF_PHASE0_P0_PRODUCTION_UNCHANGED=pass
echo CF_PHASE0_P0=pass
