#!/usr/bin/env bash
set -euo pipefail
container=capability-fabric-onshape-server
docker inspect "$container" >/dev/null 2>&1
[[ "$(docker inspect -f '{{.State.Running}}' "$container")" == true ]]

docker exec -i "$container" sh -lc 'cd /tmp/app && node --input-type=module' <<'NODE'
import fs from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const token = fs.readFileSync("/run/secrets/mcp-token", "utf8").trim();
const client = new Client({ name: "cf-ui-input-capability-proof", version: "1.0.0" });
const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:8787/mcp/${token}`));
function assert(condition, message) { if (!condition) throw new Error(message); }
function payload(result) {
  const item = result?.content?.find((x) => x?.type === "text");
  assert(item && typeof item.text === "string", "missing MCP text result");
  const value = JSON.parse(item.text);
  if (value?.status === "FAILED") throw new Error("tool failed: " + String(value?.error?.code || "unknown"));
  return value;
}
async function call(name, args={}) { return payload(await client.callTool({ name, arguments: args })); }
async function poll(operationId) {
  for (let i=0;i<180;i++) {
    const state=await call("onshape_operation_status",{operation_id:operationId});
    if (state.status==="SUCCEEDED") return state.result;
    if (state.status==="FAILED") throw new Error("operation failed");
    await new Promise(r=>setTimeout(r,500));
  }
  throw new Error("operation timeout");
}

await client.connect(transport);
try {
  const listed=await client.listTools();
  const names=new Set((listed?.tools||[]).map(x=>x.name));
  assert(names.has("onshape_ui_input"), "onshape_ui_input missing from MCP catalog");
  assert(names.has("onshape_ui_native"), "onshape_ui_native missing from MCP catalog");
  for (const retired of ["onshape_browser_open","onshape_browser_top_view","onshape_browser_mouse_probe","onshape_browser_pointer"]) {
    assert(!names.has(retired), "retired one-off tool still present: "+retired);
  }
  console.log("CF_UI_INPUT_TOOL_CATALOG=pass");
  console.log("CF_UI_INPUT_RETIRED_TOOLS_ABSENT=pass");

  let session=await call("onshape_session_status");
  if (session?.auth?.state!=="PROVEN") {
    const login=await call("onshape_login_start");
    await poll(login.operation_id);
    session=await call("onshape_session_status");
  }
  assert(session?.auth?.state==="PROVEN" && session?.auth?.http_status===200, "VPS session not PROVEN");
  console.log("CF_UI_INPUT_AUTH=pass");

  const caps=await call("onshape_fabric_capabilities");
  const ids=new Set((caps.capabilities||[]).map(x=>x.id));
  assert(ids.has("onshape.ui.input.sequence"), "semantic capability missing");
  console.log("CF_UI_INPUT_SEMANTIC_CAPABILITY=pass");

  const result=await call("onshape_ui_input", {
    document_id:"84d077d8370c21c4b3045263",
    workspace_id:"aa8c5ad631e1836645149d09",
    element_id:"7fde3930aaf98b87b30b63ed",
    steps:[{action:"mouse.move",x_fraction:0.5,y_fraction:0.5}]
  });
  assert(result?.capability_id==="onshape.ui.input.sequence", "typed adapter returned wrong capability");
  const r=result.result;
  assert(r?.outcome?.state==="ACHIEVED", "UI input outcome not ACHIEVED");
  assert(r?.observation?.ackState==="ACKNOWLEDGED", "UI input not acknowledged");
  assert(r?.observation?.evidence?.sequenceCompleted===true, "input sequence incomplete");
  assert(r?.observation?.evidence?.completedSteps===1, "wrong completed step count");
  assert(typeof r?.attemptId==="string" && r.attemptId.length>8, "Attempt id missing");
  console.log("CF_UI_INPUT_LIVE_SEQUENCE=pass");
  console.log("CF_UI_INPUT_ATTEMPT_BOUND=pass");

  const native=await call("onshape_ui_native", {
    document_id:"84d077d8370c21c4b3045263",
    workspace_id:"aa8c5ad631e1836645149d09",
    element_id:"7fde3930aaf98b87b30b63ed",
    action:"page.screenshot",
    params:{full_page:false}
  });
  assert(native?.capability_id==="onshape.ui.native", "typed native adapter returned wrong capability");
  const nr=native.result;
  assert(nr?.outcome?.state==="ACHIEVED", "native screenshot outcome not ACHIEVED");
  assert(nr?.observation?.ackState==="ACKNOWLEDGED", "native screenshot not acknowledged");
  assert(nr?.observation?.evidence?.nativeCompleted===true, "native action incomplete");
  assert(nr?.observation?.evidence?.nativeAction==="page.screenshot", "wrong native action evidence");
  const art=nr?.observation?.evidence?.result?.artifact;
  assert(art?.content_type==="image/png" && Number(art?.size)>0, "native screenshot artifact invalid");
  const artifact=await call("onshape_artifact",{action:"status",artifact_id:art.artifact_id});
  assert(artifact?.size===art.size && artifact?.sha256===art.sha256, "native screenshot artifact mismatch");
  await call("onshape_artifact",{action:"delete",artifact_id:art.artifact_id});
  console.log("CF_UI_NATIVE_TOOL_CATALOG=pass");
  console.log("CF_UI_NATIVE_SCREENSHOT=pass");
  console.log("CF_UI_NATIVE_ARTIFACT=pass");
  console.log("CF_UI_NATIVE_ATTEMPT_BOUND=pass");
} finally {
  await client.close().catch(()=>{});
}
NODE
