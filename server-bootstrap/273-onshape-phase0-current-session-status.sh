#!/usr/bin/env bash
set -euo pipefail
umask 077
[[ "$(id -u)" -eq 0 ]] || exit 2
candidate="c0cadee962c2059ba939c40c6bb9adf1bc99edfe"
fixture="a19e0fa5152af9f7ce106b6e:e5e7d0173fd1f1d0307a2cb6:e0929361aadb6135b5cecffa"
research=capability-fabric-onshape-phase0-research
control=/var/lib/capability-fabric/onshape/runtime-control/ONSHAPE_RUNTIME_CONTROL.json

python3 - "$control" <<'PY'
import json,sys
d=json.load(open(sys.argv[1])); a=d["authority"]; g=a["productionGuard"]
assert a["mode"]=="VPS_PRODUCTION" and a["materialAuthority"]=="vps-fabric"
assert a["planes"]["android-v1"]["ingress"]=="CLOSED"
assert a["reconciliationHold"]["active"] is False
assert g["killSwitch"]=="ENGAGED" and g["allowedDocumentIds"]==[] and g["mutationBudget"]["maxMutations"]==0
print("CF_PHASE0_SESSIONNOW_BOUNDARY=pass")
print("CF_PHASE0_SESSIONNOW_CONTROL_REV="+str(d["controlRevision"]))
print("CF_PHASE0_SESSIONNOW_EPOCH="+str(a["productionEpoch"]))
PY

[[ "$(docker inspect -f '{{.State.Running}}' "$research" 2>/dev/null || echo false)" == true ]]
[[ "$(docker inspect -f '{{.State.Health.Status}}' "$research")" == healthy ]]
env_dump="$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$research")"
grep -Fxq "CF_RESEARCH_SOURCE_COMMIT=$candidate" <<<"$env_dump"
grep -Fxq "CF_RESEARCH_FIXTURE_TARGET=$fixture" <<<"$env_dump"
echo CF_PHASE0_SESSIONNOW_BINDING=pass

docker exec -i "$research" sh -lc 'cd /tmp/app && node --input-type=module' <<'NODE'
import fs from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
const token=fs.readFileSync("/run/secrets/mcp-token","utf8").trim();
const c=new Client({name:"cf-phase0-session-now",version:"1.0"});
await c.connect(new StreamableHTTPClientTransport(new URL("http://127.0.0.1:8898/mcp/"+token)));
const parse=r=>JSON.parse((r.content||[]).filter(x=>x.type==="text").map(x=>x.text).join("\n"));
try{
  const status=parse(await c.callTool({name:"onshape_session_status",arguments:{}},undefined,{timeout:180000}));
  console.log("CF_PHASE0_SESSIONNOW_STATUS="+JSON.stringify({
    build_id:status?.build_id??null,
    auth:status?.auth??null,
    url:status?.url??status?.session?.url??null
  }));
  if(status?.auth?.state==="PROVEN"&&status?.auth?.http_status===200) console.log("CF_PHASE0_SESSIONNOW_AUTH=PROVEN");
  else console.log("CF_PHASE0_SESSIONNOW_AUTH=NOT_PROVEN");
} finally {await c.close().catch(()=>{});}
NODE
echo CF_PHASE0_SESSIONNOW=pass
