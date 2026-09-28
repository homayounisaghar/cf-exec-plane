#!/usr/bin/env bash
set -euo pipefail
umask 077
[[ "$(id -u)" -eq 0 ]] || exit 2
ACTIVE=/opt/capability-fabric/current
PREVIOUS=/opt/capability-fabric/previous
STATE=/var/lib/capability-fabric/state
CONTROL=/var/lib/capability-fabric/onshape/runtime-control/ONSHAPE_RUNTIME_CONTROL.json
SERVER=capability-fabric-onshape-server
GATEWAY=capability-fabric-onshape-gateway
echo "ACTIVE=$(basename "$(readlink -f "$ACTIVE")")"
echo "PREVIOUS=$(basename "$(readlink -f "$PREVIOUS")")"
echo "LAST_GOOD_SEQUENCE=$(cat "$STATE/last-good-sequence" 2>/dev/null || true)"
echo "LAST_GOOD_RELEASE=$(cat "$STATE/last-good-release" 2>/dev/null || true)"
echo "FAILED_COMMIT=$(cat "$STATE/last-failed-commit" 2>/dev/null || true)"
echo "GATE=$(cat "$STATE/release-in-progress" 2>/dev/null || echo absent)"
echo "TIMER=$(systemctl is-active capability-fabric-pull.timer 2>/dev/null || true)"
echo "SERVICE=$(systemctl is-active capability-fabric-pull.service 2>/dev/null || true)"
for c in "$SERVER" capability-fabric-onshape-fabric "$GATEWAY"; do
  echo "$c=$(docker inspect -f '{{.State.Status}}/{{.State.Running}}{{if .State.Health}}/{{.State.Health.Status}}{{end}}' "$c" 2>/dev/null || echo absent)"
done
server_log="$(docker logs --tail 160 "$SERVER" 2>&1 || true)"
for signature in \
  POOL_LEASE_STATE_INVALID \
  ERR_MODULE_NOT_FOUND \
  FABRIC_AUTHORITY_RELEASE_MISMATCH \
  FABRIC_AUTHORITY_RELEASE_MISSING \
  STANDBY_PROFILE_DIR; do
  if grep -Fq "$signature" <<<"$server_log"; then
    echo "SERVER_ERROR_SIGNATURE_$signature=present"
  else
    echo "SERVER_ERROR_SIGNATURE_$signature=absent"
  fi
done
python3 - "$CONTROL" <<'PY'
import json,sys
d=json.load(open(sys.argv[1])); a=d["authority"]; v=a["planes"]["vps-fabric"]
print("CONTROL_REV="+str(d["controlRevision"]))
print("EPOCH="+str(a["productionEpoch"]))
print("MODE="+str(a["mode"]))
print("MATERIAL_AUTHORITY="+str(a["materialAuthority"]))
print("VPS_INGRESS="+str(v["ingress"]))
print("VPS_EFFECTS="+str(v["materialEffectsAllowed"]))
print("VPS_SEQ="+str(v["releaseSequence"]))
print("VPS_RELEASE="+str(v["releaseId"]))
print("LEASE="+str(d["lease"]["state"]))
print("HOLD="+str(a["reconciliationHold"]["active"]))
PY
if [[ "$(docker inspect -f '{{.State.Status}}' "$SERVER" 2>/dev/null || echo absent)" == running ]]; then
docker exec -i "$SERVER" sh -lc 'cd /tmp/app && node --input-type=module' <<'NODE'
import fs from "node:fs";
import {Client} from "@modelcontextprotocol/sdk/client/index.js";
import {StreamableHTTPClientTransport} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
const token=fs.readFileSync("/run/secrets/mcp-token","utf8").trim();
const c=new Client({name:"cf-r9-state-diag",version:"1"});
await c.connect(new StreamableHTTPClientTransport(new URL("http://127.0.0.1:8788/mcp/"+token)));
const r=await c.callTool({name:"onshape_pool_status",arguments:{}},undefined,{timeout:180000});
console.log("POOL="+(r.content||[]).filter(x=>x.type==="text").map(x=>x.text||"").join("\n"));
await c.close().catch(()=>{});
NODE
fi
