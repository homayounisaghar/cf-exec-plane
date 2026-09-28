#!/usr/bin/env bash
set -euo pipefail
umask 077
[[ "$(id -u)" -eq 0 ]] || exit 2

ACTIVE=/opt/capability-fabric/current
PREVIOUS=/opt/capability-fabric/previous
STATE=/var/lib/capability-fabric/state
CONTROL=/var/lib/capability-fabric/onshape/runtime-control/ONSHAPE_RUNTIME_CONTROL.json
GATE="$STATE/release-in-progress"
TIMER=capability-fabric-pull.timer
SERVICE=capability-fabric-pull.service
PULL=/usr/local/libexec/capability-fabric-pull-agent
GATEWAY=capability-fabric-onshape-gateway
SERVER=capability-fabric-onshape-server
FABRIC=capability-fabric-onshape-fabric
EXPECTED_MANIFEST=50c7a75af1c575ad31c7b2d0054cf1ecf7fabd494c42c98e5eb32ab6e9ec603e
EXPECTED_CONTROL_BLOB=f719c1565114b4d9c0a7fad6eeeb2ea114494b89

ensure_closed() {
  local tmp="$GATE.tmp.r10-resume.$$"
  printf '%s\n' RELEASE_IN_PROGRESS >"$tmp"
  chmod 0600 "$tmp"; chown root:root "$tmp"; mv -f "$tmp" "$GATE"
  docker stop "$GATEWAY" >/dev/null 2>&1 || true
  systemctl stop "$TIMER" >/dev/null 2>&1 || true
}
trap ensure_closed ERR

[[ "$(basename "$(readlink -f "$ACTIVE")")" == "onshape-vps-hardened-r10" ]]
[[ "$(basename "$(readlink -f "$PREVIOUS")")" == "onshape-vps-hardened-r9" ]]
[[ "$(cat "$STATE/last-good-sequence")" == "75" ]]
[[ "$(cat "$STATE/last-good-release")" == "onshape-vps-hardened-r10" ]]
[[ "$(sha256sum "$(readlink -f "$ACTIVE")/manifest.json"|awk '{print $1}')" == "$EXPECTED_MANIFEST" ]]
[[ -f "$GATE" ]] && grep -Fxq RELEASE_IN_PROGRESS "$GATE"
! systemctl is-active --quiet "$TIMER"
! systemctl is-active --quiet "$SERVICE"
[[ "$(docker inspect -f '{{.State.Running}}' "$GATEWAY")" == false ]]

out="$("$PULL" pull 2>&1 || true)"
printf '%s\n' "$out"
printf '%s\n' "$out"|grep -Eq 'CF_PULL_NO_CHANGE|CF_PULL_APPLY=success'
ensure_closed
for _ in $(seq 1 30); do systemctl is-active --quiet "$SERVICE" || break; sleep 1; done
! systemctl is-active --quiet "$SERVICE"
[[ "$(git hash-object "$CONTROL")" == "$EXPECTED_CONTROL_BLOB" ]]

python3 - "$CONTROL" <<'PY'
import json,sys
d=json.load(open(sys.argv[1])); a=d["authority"]; v=a["planes"]["vps-fabric"]; g=a["productionGuard"]
assert d["controlRevision"]==560 and a["productionEpoch"]==31
assert a["mode"]=="VPS_PRODUCTION" and a["materialAuthority"]=="vps-fabric"
assert v["ingress"]=="ADMITTED" and v["materialEffectsAllowed"] is True
assert v["releaseSequence"]==75 and v["releaseId"]=="onshape-vps-hardened-r10"
assert v["manifestSha256"]=="50c7a75af1c575ad31c7b2d0054cf1ecf7fabd494c42c98e5eb32ab6e9ec603e"
assert d["lease"]["state"]=="FREE" and a["reconciliationHold"]["active"] is False
assert g["killSwitch"]=="ENGAGED" and g["allowedDocumentIds"]==[]
assert g["mutationBudget"]["maxMutations"]==0
print("CF_R10_RESUME_AUTHORITY=epoch31-r10-guard-closed")
PY

[[ "$(docker inspect -f '{{.State.Running}}' "$SERVER")" == true ]]
[[ "$(docker inspect -f '{{.State.Health.Status}}' "$SERVER")" == healthy ]]
[[ "$(docker inspect -f '{{.State.Running}}' "$FABRIC")" == true ]]
[[ "$(docker inspect -f '{{.State.Health.Status}}' "$FABRIC")" == healthy ]]

PYTHONPATH="$(readlink -f "$ACTIVE")/fabric-src" python3 - <<'PY'
from capability_fabric.persistence import SqliteExecutionStateStore
with SqliteExecutionStateStore("/var/lib/capability-fabric/onshape/fabric-state/execution.sqlite3") as state:
    assert not state.recoverable()
print("CF_R10_RESUME_RECOVERABLE=zero")
PY

rm -f "$GATE"
pool="$(docker exec -i "$SERVER" sh -lc 'cd /tmp/app && node --input-type=module' <<'NODE'
import fs from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
const token=fs.readFileSync("/run/secrets/mcp-token","utf8").trim();
const c=new Client({name:"cf-r10-resume",version:"1.0"});
await c.connect(new StreamableHTTPClientTransport(new URL("http://127.0.0.1:8788/mcp/"+token)));
const r=await c.callTool({name:"onshape_pool_status",arguments:{}},undefined,{timeout:180000});
console.log((r.content||[]).filter(x=>x.type==="text").map(x=>x.text||"").join("\n"));
await c.close().catch(()=>{});
NODE
)"
python3 - "$pool" <<'PY'
import json,sys
p=json.loads(sys.argv[1])
assert p["build_id"]=="onshape-vps-hardened-r10"
assert p["pool_enabled"] is True and p["topology"]=="ACTIVE_HOT_STANDBY" and p["size"]==2
assert p["session_fingerprints_distinct"] is True
assert p["active_count"]==0 and p["workflow_lease_count"]==0 and p["ui_lease_count"]==0
s=p["api_scheduler"]
assert s["minimum_interval_ms"]==1000 and s["maximum_concurrency"]==1
assert s["maximum_observed_concurrency"]==1 and s["dispatch_count"]>=200
assert s["active"]==0 and s["queued"]==0
ss=p["sessions"]; assert len(ss)==2
assert all(x["auth"]["state"]=="PROVEN" and x["auth"]["http_status"]==200 for x in ss)
assert len({x["auth"]["account_id"] for x in ss})==1
print("CF_R10_RESUME_POOL=2of2-PROVEN-idle-paced")
PY

docker start "$GATEWAY" >/dev/null
for _ in $(seq 1 90); do
  [[ "$(curl -fsS --max-time 2 http://127.0.0.1:8787/ 2>/dev/null || true)" == "cf-onshape-single ok" ]] && break
  sleep 1
done
[[ "$(curl -fsS --max-time 2 http://127.0.0.1:8787/)" == "cf-onshape-single ok" ]]
systemctl start "$TIMER"
systemctl is-active --quiet "$TIMER"
[[ ! -e "$GATE" ]]
trap - ERR
echo CF_R10_RESUME_GATEWAY=healthy
echo CF_R10_RESUME_TIMER=active
echo CF_R10_RESUME=pass
