#!/usr/bin/env bash
set -euo pipefail
umask 077
[[ "$(id -u)" -eq 0 ]] || exit 2

candidate="d9354b6bb26b10dd198aab2a7417c746ae90de66"
fixture="a19e0fa5152af9f7ce106b6e:e5e7d0173fd1f1d0307a2cb6:e0929361aadb6135b5cecffa"
research="capability-fabric-onshape-phase0-research"
sidecar="capability-fabric-onshape-phase0-fabric"
root="/var/lib/capability-fabric/onshape-research-phase0"
release="$root/releases/$candidate"
db="$root/fabric-state/execution.sqlite3"
control="/var/lib/capability-fabric/onshape/runtime-control/ONSHAPE_RUNTIME_CONTROL.json"

python3 - "$control" <<'PY'
import json,sys
d=json.load(open(sys.argv[1])); a=d["authority"]; g=a["productionGuard"]
assert d["controlRevision"]==556 and a["productionEpoch"]==27
assert a["mode"]=="VPS_PRODUCTION" and a["materialAuthority"]=="vps-fabric"
assert a["planes"]["android-v1"]["ingress"]=="CLOSED"
assert a["planes"]["android-v1"]["materialEffectsAllowed"] is False
assert a["reconciliationHold"]["active"] is False
assert d["lease"]["state"]=="FREE"
assert g["generation"]==11
assert g["killSwitch"]=="ENGAGED"
assert g["allowedDocumentIds"]==[]
assert g["mutationBudget"]["maxMutations"]==0
print("CF_PHASE0_PAUSE_PRODUCTION_BOUNDARY=pass")
print("CF_PHASE0_PAUSE_LEASE=FREE")
print("CF_PHASE0_PAUSE_RECONCILIATION_HOLD=inactive")
PY

for c in "$research" "$sidecar"; do
  [[ "$(docker inspect -f '{{.State.Running}}' "$c" 2>/dev/null || echo false)" == true ]]
  [[ "$(docker inspect -f '{{.State.Health.Status}}' "$c")" == healthy ]]
done
env_dump="$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$research")"
grep -Fxq "CF_RESEARCH_SOURCE_COMMIT=$candidate" <<<"$env_dump"
grep -Fxq "CF_RESEARCH_FIXTURE_TARGET=$fixture" <<<"$env_dump"
echo CF_PHASE0_PAUSE_BINDING=pass

PYTHONPATH="$release/server-deploy/current/fabric-src" python3 - "$db" <<'PY'
import sys
from capability_fabric.persistence import SqliteExecutionStateStore
with SqliteExecutionStateStore(sys.argv[1]) as state:
    pending=state.recoverable()
    assert not pending, [(x.operation.operation_id if x.operation else None,x.attempt.attempt_id if x.attempt else None) for x in pending]
print("CF_PHASE0_PAUSE_RECOVERABLE=zero")
PY

docker exec -e CF_CANDIDATE="$candidate" -i "$research" sh -lc 'cd /tmp/app && node --input-type=module' <<'NODE'
import fs from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
const candidate=process.env.CF_CANDIDATE;
const token=fs.readFileSync("/run/secrets/mcp-token","utf8").trim();
const c=new Client({name:"cf-phase0-safe-pause",version:"1.0"});
await c.connect(new StreamableHTTPClientTransport(new URL("http://127.0.0.1:8898/mcp/"+token)));
const parse=r=>JSON.parse((r.content||[]).filter(x=>x.type==="text").map(x=>x.text||"").join("\n"));
try {
  const status=parse(await c.callTool({name:"onshape_session_status",arguments:{}},undefined,{timeout:180000}));
  const expected="onshape-phase0-"+candidate.slice(0,12);
  if(status?.build_id!==expected) throw new Error("research build mismatch");
  if(status?.auth?.state!=="PROVEN" || status?.auth?.http_status!==200) throw new Error("research auth not proven");
  console.log("CF_PHASE0_PAUSE_RESEARCH_AUTH=PROVEN");
  console.log("CF_PHASE0_PAUSE_RESEARCH_BUILD="+status.build_id);
} finally {
  await c.close().catch(()=>{});
}
NODE

PYTHONPATH="$release/server-deploy/current/fabric-src" python3 - "$db" <<'PY'
import sys
from capability_fabric.persistence import SqliteExecutionStateStore
with SqliteExecutionStateStore(sys.argv[1]) as state:
    pending=state.recoverable()
    assert not pending
print("CF_PHASE0_PAUSE_POST_RECOVERABLE=zero")
PY

echo CF_PHASE0_SAFE_PAUSE=pass
