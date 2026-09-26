#!/usr/bin/env bash
set -euo pipefail
umask 077
[[ "$(id -u)" -eq 0 ]] || exit 2

candidate="dbb08f8257b4e72e31e203497fa135acdeda5e5b"
fixture="a19e0fa5152af9f7ce106b6e:e5e7d0173fd1f1d0307a2cb6:e0929361aadb6135b5cecffa"
research="capability-fabric-onshape-phase0-research"
sidecar="capability-fabric-onshape-phase0-fabric"
release="/var/lib/capability-fabric/onshape-research-phase0/releases/$candidate"
db="/var/lib/capability-fabric/onshape-research-phase0/fabric-state/execution.sqlite3"
control="/var/lib/capability-fabric/onshape/runtime-control/ONSHAPE_RUNTIME_CONTROL.json"

python3 - "$control" <<'PY'
import json,sys
d=json.load(open(sys.argv[1])); a=d["authority"]; g=a["productionGuard"]
assert a["mode"]=="VPS_PRODUCTION" and a["materialAuthority"]=="vps-fabric"
assert a["planes"]["android-v1"]["ingress"]=="CLOSED"
assert a["planes"]["android-v1"]["materialEffectsAllowed"] is False
assert a["reconciliationHold"]["active"] is False
assert g["killSwitch"]=="ENGAGED" and g["allowedDocumentIds"]==[] and g["mutationBudget"]["maxMutations"]==0
print("CF_PHASE0_AUTH_REPAIR_PRODUCTION_FAILCLOSED=pass")
print("CF_PHASE0_AUTH_REPAIR_CONTROL_REV="+str(d["controlRevision"]))
print("CF_PHASE0_AUTH_REPAIR_EPOCH="+str(a["productionEpoch"]))
PY

for c in "$research" "$sidecar"; do
 [[ "$(docker inspect -f '{{.State.Running}}' "$c" 2>/dev/null || echo false)" == true ]]
 [[ "$(docker inspect -f '{{.State.Health.Status}}' "$c")" == healthy ]]
done
env_dump="$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$research")"
grep -Fxq "CF_RESEARCH_SOURCE_COMMIT=$candidate" <<<"$env_dump"
grep -Fxq "CF_RESEARCH_FIXTURE_TARGET=$fixture" <<<"$env_dump"
echo CF_PHASE0_AUTH_REPAIR_BINDING=pass

PYTHONPATH="$release/server-deploy/current/fabric-src" python3 - "$db" <<'PY'
import sys
from capability_fabric.persistence import SqliteExecutionStateStore
with SqliteExecutionStateStore(sys.argv[1]) as state:
    assert not state.recoverable()
print("CF_PHASE0_AUTH_REPAIR_RECOVERABLE=zero")
PY

set +e
docker exec -e CF_CANDIDATE="$candidate" -i "$research" sh -lc 'cd /tmp/app && node --input-type=module' <<'NODE'
import fs from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
const candidate=process.env.CF_CANDIDATE;
const token=fs.readFileSync("/run/secrets/mcp-token","utf8").trim();
const c=new Client({name:"cf-phase0-auth-repair",version:"1.0"});
await c.connect(new StreamableHTTPClientTransport(new URL("http://127.0.0.1:8898/mcp/"+token)));
const parse=(r)=>{
  const raw=(r?.content||[]).filter(x=>x.type==="text").map(x=>x.text||"").join("\n");
  if(!raw) throw new Error("empty MCP response");
  return JSON.parse(raw);
};
const call=async(name,args={})=>parse(await c.callTool({name,arguments:args},undefined,{timeout:180000}));
try {
  let s=await call("onshape_session_status");
  const expected="onshape-phase0-"+candidate.slice(0,12);
  if(s.build_id!==expected) throw new Error("research build mismatch");
  console.log("CF_PHASE0_AUTH_REPAIR_INITIAL="+String(s?.auth?.state||"UNKNOWN"));
  if(s?.auth?.state==="PROVEN" && s?.auth?.http_status===200){
    console.log("CF_PHASE0_AUTH_REPAIR_AUTH=PROVEN");
    process.exitCode=0;
    return;
  }
  const login=await call("onshape_login_start");
  const opId=login.operation_id;
  if(typeof opId!=="string"||!opId) throw new Error("login operation id missing");
  console.log("CF_PHASE0_AUTH_REPAIR_LOGIN_STARTED=pass");
  for(let i=0;i<180;i++){
    const op=await call("onshape_operation_status",{operation_id:opId});
    if(op.status==="SUCCEEDED"){
      s=await call("onshape_session_status");
      if(s?.auth?.state!=="PROVEN"||s?.auth?.http_status!==200) throw new Error("login succeeded but auth not proven");
      console.log("CF_PHASE0_AUTH_REPAIR_AUTH=PROVEN");
      process.exitCode=0;
      return;
    }
    if(op.status==="AWAITING_INPUT"){
      if(op.input_required!=="EMAIL_VERIFICATION_CODE") throw new Error("unexpected input "+String(op.input_required));
      console.log("CF_PHASE0_AUTH_REPAIR_AUTH=AWAITING_EMAIL_VERIFICATION");
      process.exitCode=42;
      return;
    }
    if(op.status==="FAILED") throw new Error("login failed "+String(op?.error?.code||"unknown"));
    await new Promise(r=>setTimeout(r,1000));
  }
  throw new Error("login operation timed out");
} finally {
  await c.close().catch(()=>{});
}
NODE
rc=$?
set -e
if (( rc == 42 )); then
  echo CF_PHASE0_AUTH_REPAIR=awaiting-email-verification
  exit 42
fi
(( rc == 0 )) || exit "$rc"

PYTHONPATH="$release/server-deploy/current/fabric-src" python3 - "$db" <<'PY'
import sys
from capability_fabric.persistence import SqliteExecutionStateStore
with SqliteExecutionStateStore(sys.argv[1]) as state: assert not state.recoverable()
print("CF_PHASE0_AUTH_REPAIR_POST_RECOVERABLE=zero")
PY
echo CF_PHASE0_AUTH_REPAIR=pass
