#!/usr/bin/env bash
set -euo pipefail
umask 077

candidate_commit="dbb08f8257b4e72e31e203497fa135acdeda5e5b"
fixture="a19e0fa5152af9f7ce106b6e:e5e7d0173fd1f1d0307a2cb6:e0929361aadb6135b5cecffa"
expected_control_blob="1b9c248d8b57385a86c5c157bf99ef4f1f6928ce"
control=/var/lib/capability-fabric/onshape/runtime-control/ONSHAPE_RUNTIME_CONTROL.json
prod_gate=/var/lib/capability-fabric/state/release-in-progress
research=capability-fabric-onshape-phase0-research
sidecar=capability-fabric-onshape-phase0-fabric

[[ "$(id -u)" -eq 0 ]] || exit 2
[[ "$(git hash-object "$control")" == "$expected_control_blob" ]] || { echo CF_PHASE0_PASSIVE_AUTH_CONTROL=freshness-mismatch; exit 20; }
[[ -f "$prod_gate" ]] && grep -Fxq RELEASE_IN_PROGRESS "$prod_gate" || exit 21
for c in capability-fabric-onshape-server capability-fabric-onshape-fabric; do
  [[ "$(docker inspect -f '{{.State.Running}}' "$c")" == true ]] || exit 22
done
[[ "$(docker inspect -f '{{.State.Running}}' capability-fabric-onshape-gateway 2>/dev/null || echo false)" == false ]] || exit 22

for c in "$research" "$sidecar"; do
  [[ "$(docker inspect -f '{{.State.Running}}' "$c" 2>/dev/null || echo false)" == true ]] || exit 23
  [[ "$(docker inspect -f '{{.State.Health.Status}}' "$c")" == healthy ]] || exit 23
done

env_dump="$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$research")"
grep -Fxq "CF_RESEARCH_SOURCE_COMMIT=$candidate_commit" <<<"$env_dump"
grep -Fxq "CF_RESEARCH_FIXTURE_TARGET=$fixture" <<<"$env_dump"
grep -Fxq 'CF_PUBLIC_SURFACE=shadow' <<<"$env_dump"
grep -Fxq 'CF_FABRIC_REQUIRE_PRODUCTION_AUTHORITY=0' <<<"$env_dump"
grep -Fxq 'CF_PRIVILEGED_NATIVE_ENABLED=1' <<<"$env_dump"
side_env="$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$sidecar")"
grep -Fxq 'CF_FABRIC_AGENT_PORT=8899' <<<"$side_env"
grep -Fxq 'CF_FABRIC_REQUIRE_PRODUCTION_AUTHORITY=0' <<<"$side_env"
echo CF_PHASE0_PASSIVE_AUTH_RUNTIME_BINDING=pass

for p in 8898 8899 8901; do
  ss -lnt | awk -v x="127.0.0.1:$p" '$4==x{f=1} END{exit f?0:1}' || exit 24
done
echo CF_PHASE0_PASSIVE_AUTH_PORTS=pass

set +e
docker exec -e CF_FIXTURE="$fixture" -e CF_CANDIDATE="$candidate_commit" -i "$research" sh -lc 'cd /tmp/app && node --input-type=module' <<'NODE'
import fs from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const [did,wid,eid]=process.env.CF_FIXTURE.split(":");
const candidate=process.env.CF_CANDIDATE;
const token=fs.readFileSync("/run/secrets/mcp-token","utf8").trim();
const client=new Client({name:"cf-phase0-verify-login",version:"1.0.0"});
await client.connect(new StreamableHTTPClientTransport(new URL("http://127.0.0.1:8898/mcp/"+token)));

const parse=(res)=>{
  const raw=(res?.content||[]).filter(x=>x.type==="text").map(x=>x.text||"").join("\n");
  if(!raw) throw new Error("empty MCP result");
  return JSON.parse(raw);
};
const call=async(name,args={})=>parse(await client.callTool({name,arguments:args},undefined,{timeout:180000}));
let awaiting=false;

try {
  const listed=(await client.listTools()).tools.map(x=>x.name).sort();
  for(const required of [
    "onshape_fabric_capabilities","onshape_fabric_invoke","onshape_ui_native","onshape_ui_input",
    "onshape_session_status","onshape_login_start","onshape_operation_status","onshape_verification_submit"
  ]) if(!listed.includes(required)) throw new Error("missing research tool "+required);
  for(const forbidden of [
    "onshape_request","onshape_artifact","onshape_documents_create","onshape_pool_warmup","onshape_pool_session_reauth"
  ]) if(listed.includes(forbidden)) throw new Error("forbidden research tool "+forbidden);
  console.log("CF_PHASE0_PASSIVE_AUTH_TOOL_CATALOG=pass");

  const caps=await call("onshape_fabric_capabilities");
  if(caps.public_surface!=="shadow" || caps.qualification_only!==true) throw new Error("research surface flags invalid");
  const ids=(caps.capabilities||[]).map(x=>x.id).sort();
  const expected=["onshape.session.status","onshape.ui.input.sequence","onshape.ui.native"].sort();
  if(JSON.stringify(ids)!==JSON.stringify(expected)) throw new Error("unexpected research capability catalog "+ids.join(","));
  console.log("CF_PHASE0_PASSIVE_AUTH_CAPABILITIES="+ids.join(","));

  const mismatch=await call("onshape_ui_input",{
    document_id:"000000000000000000000001",
    workspace_id:wid,
    element_id:eid,
    steps:[{action:"mouse.move",x_fraction:0.5,y_fraction:0.5}]
  });
  if(mismatch.status!=="FAILED" || mismatch?.error?.code!=="RESEARCH_FIXTURE_MISMATCH") throw new Error("fixture guard did not fail closed");
  console.log("CF_PHASE0_PASSIVE_AUTH_FIXTURE_GUARD=pass");

  let status=await call("onshape_session_status");
  const expectedBuild="onshape-phase0-"+candidate.slice(0,12);
  if(status.build_id!==expectedBuild) throw new Error("research build identity mismatch");
  console.log("CF_PHASE0_PASSIVE_AUTH_BUILD_ID="+status.build_id);

  if(status?.auth?.state!=="PROVEN"){
    const login=await call("onshape_login_start");
    const opId=login.operation_id;
    if(typeof opId!=="string" || !opId) throw new Error("login operation id missing");
    let terminal=false;
    for(let i=0;i<150;i++){
      const op=await call("onshape_operation_status",{operation_id:opId});
      if(op.status==="SUCCEEDED"){ terminal=true; break; }
      if(op.status==="AWAITING_INPUT"){
        if(op.input_required!=="EMAIL_VERIFICATION_CODE") throw new Error("unexpected input "+op.input_required);
        console.log("CF_PHASE0_PASSIVE_AUTH_LOGIN=AWAITING_EMAIL_VERIFICATION");
        awaiting=true;
        terminal=true;
        break;
      }
      if(op.status==="FAILED") throw new Error("research login failed: "+String(op?.error?.code||"unknown"));
      await new Promise(r=>setTimeout(r,1000));
    }
    if(!terminal) throw new Error("research login timed out");
    if(!awaiting) status=await call("onshape_session_status");
  }
  if(!awaiting){
    if(status?.auth?.state!=="PROVEN" || status?.auth?.http_status!==200) throw new Error("research authentication not PROVEN");
    console.log("CF_PHASE0_PASSIVE_AUTH_AUTH=PROVEN");
  }
} finally {
  await client.close().catch(()=>{});
}
if(awaiting) process.exitCode=42;
NODE
node_rc=$?
set -e

if (( node_rc == 42 )); then
  echo CF_PHASE0_PASSIVE_AUTH_LOGIN=awaiting-email-verification
  exit 42
fi
(( node_rc == 0 )) || exit "$node_rc"

[[ "$(git hash-object "$control")" == "$expected_control_blob" ]] || exit 25
[[ -f "$prod_gate" ]] && grep -Fxq RELEASE_IN_PROGRESS "$prod_gate" || exit 25
echo CF_PHASE0_PASSIVE_AUTH_PRODUCTION_UNCHANGED=pass
echo CF_PHASE0_PASSIVE_AUTH_LOGIN=pass
