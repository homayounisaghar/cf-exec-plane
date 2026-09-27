#!/usr/bin/env bash
set -euo pipefail
umask 077

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
EXPECTED_OLD_CONTROL=798d9bf888e788d35ee1094136e8dc2ed587a534
EXPECTED_NEW_CONTROL=745ffcae77cca8f5b6fac0e0fd78324f33b08b36
EXPECTED_MANIFEST=5abb7ec2ba3525f3f1e3cf535323106436b42d264150fb20c911b221ef3af7a3
FIXTURE=a19e0fa5152af9f7ce106b6e:e5e7d0173fd1f1d0307a2cb6:e0929361aadb6135b5cecffa

ensure_closed() {
  local tmp="$GATE.tmp.r9-resume.$$"
  printf '%s
' RELEASE_IN_PROGRESS >"$tmp"
  chmod 0600 "$tmp"; chown root:root "$tmp"; mv -f "$tmp" "$GATE"
  docker stop "$GATEWAY" >/dev/null 2>&1 || true
  systemctl stop "$TIMER" >/dev/null 2>&1 || true
}
trap ensure_closed ERR

[[ "$(basename "$(readlink -f "$ACTIVE")")" == "onshape-vps-hardened-r9" ]]
[[ "$(basename "$(readlink -f "$PREVIOUS")")" == "onshape-vps-hardened-production-r8" ]]
[[ "$(cat "$STATE/last-good-sequence")" == "74" ]]
[[ "$(cat "$STATE/last-good-release")" == "onshape-vps-hardened-r9" ]]
[[ ! -s "$STATE/last-failed-commit" ]]
[[ "$(sha256sum "$(readlink -f "$ACTIVE")/manifest.json"|awk '{print $1}')" == "$EXPECTED_MANIFEST" ]]
[[ -f "$GATE" ]] && grep -Fxq RELEASE_IN_PROGRESS "$GATE"
! systemctl is-active --quiet "$TIMER"
! systemctl is-active --quiet "$SERVICE"
[[ "$(docker inspect -f '{{.State.Running}}' "$GATEWAY")" == false ]]
[[ "$(git hash-object "$CONTROL")" == "$EXPECTED_OLD_CONTROL" ]]

out="$("$PULL" pull 2>&1 || true)"
printf '%s
' "$out"
printf '%s
' "$out" | grep -Eq 'CF_PULL_NO_CHANGE|CF_PULL_APPLY=success'
[[ "$(git hash-object "$CONTROL")" == "$EXPECTED_NEW_CONTROL" ]]

# Pull-agent may touch ordinary service state; restore the critical section before proof.
ensure_closed
for _ in $(seq 1 30); do systemctl is-active --quiet "$SERVICE" || break; sleep 1; done
! systemctl is-active --quiet "$SERVICE"
[[ "$(docker inspect -f '{{.State.Running}}' "$SERVER")" == true ]]
[[ "$(docker inspect -f '{{.State.Health.Status}}' "$SERVER")" == healthy ]]
[[ "$(docker inspect -f '{{.State.Running}}' "$FABRIC")" == true ]]
[[ "$(docker inspect -f '{{.State.Health.Status}}' "$FABRIC")" == healthy ]]

python3 - "$CONTROL" <<'PY'
import json,sys
d=json.load(open(sys.argv[1])); a=d["authority"]; v=a["planes"]["vps-fabric"]; g=a["productionGuard"]
assert d["controlRevision"]==558 and a["productionEpoch"]==29
assert a["mode"]=="VPS_PRODUCTION" and a["materialAuthority"]=="vps-fabric"
assert v["ingress"]=="ADMITTED" and v["materialEffectsAllowed"] is True
assert v["releaseSequence"]==74 and v["releaseId"]=="onshape-vps-hardened-r9"
assert v["manifestSha256"]=="5abb7ec2ba3525f3f1e3cf535323106436b42d264150fb20c911b221ef3af7a3"
assert d["lease"]["state"]=="FREE" and a["reconciliationHold"]["active"] is False
assert g["generation"]==11 and g["killSwitch"]=="ENGAGED"
assert g["allowedDocumentIds"]==[] and g["mutationBudget"]["maxMutations"]==0
print("CF_R9_RESUME_AUTHORITY=epoch29-r9-guard-closed")
PY

PYTHONPATH="$(readlink -f "$ACTIVE")/fabric-src" python3 - <<'PY'
from capability_fabric.persistence import SqliteExecutionStateStore
with SqliteExecutionStateStore("/var/lib/capability-fabric/onshape/fabric-state/execution.sqlite3") as state:
    pending=state.recoverable()
    assert not pending, [(x.operation.operation_id if x.operation else None,x.attempt.attempt_id if x.attempt else None) for x in pending]
print("CF_R9_RESUME_RECOVERABLE=zero")
PY

# Gate blocks backend tools; remove it only while gateway stays down.
rm -f "$GATE"

pool="$(docker exec -i "$SERVER" sh -lc 'cd /tmp/app && node --input-type=module' <<'NODE'
import fs from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
const token=fs.readFileSync("/run/secrets/mcp-token","utf8").trim();
const c=new Client({name:"cf-r9-resume-pool",version:"1.0"});
await c.connect(new StreamableHTTPClientTransport(new URL("http://127.0.0.1:8788/mcp/"+token)));
const r=await c.callTool({name:"onshape_pool_status",arguments:{}},undefined,{timeout:180000});
console.log((r.content||[]).filter(x=>x.type==="text").map(x=>x.text||"").join("\n"));
await c.close().catch(()=>{});
NODE
)"
python3 - "$pool" <<'PY'
import json,sys
p=json.loads(sys.argv[1])
assert p["build_id"]=="onshape-vps-hardened-r9"
assert p["pool_enabled"] is True and p["size"]==5 and p["session_fingerprints_distinct"] is True
assert p["navigation_limit"]==2
assert p["active_count"]==0 and p["queued_count"]==0 and p["document_lock_count"]==0 and p["workflow_lease_count"]==0
ss=p["sessions"]; assert len(ss)==5
assert all(x["auth"]["state"]=="PROVEN" and x["auth"]["http_status"]==200 for x in ss)
assert len({x["auth"]["account_id"] for x in ss})==1
print("CF_R9_RESUME_POOL=5of5-PROVEN-idle")
PY

result="$(docker exec -e CF_FIXTURE="$FIXTURE" -i "$SERVER" sh -lc 'cd /tmp/app && node --input-type=module' < server-bootstrap/helpers/292-onshape-session-pool-production-semantic-client.mjs | tail -n 1)"
python3 - "$result" <<'PY'
import json,sys
r=json.loads(sys.argv[1])
assert r["ok"] is True and r["build_id"]=="onshape-vps-hardened-r9"
assert r["semantic_contexts"]==5 and r["physical_slots_distinct"]==5
assert r["documented_reads"]==25 and r["post_auth_proven"]==5
assert r["fingerprints_distinct"] is True and r["final_workflow_lease_count"]==0 and r["final_active_count"]==0
assert r["navigation_limit"]==2 and r["physical_slot_redaction"] is True
print("CF_R9_RESUME_SEMANTIC="+json.dumps(r,separators=(",",":"),sort_keys=True))
PY

PYTHONPATH="$(readlink -f "$ACTIVE")/fabric-src" python3 - <<'PY'
from capability_fabric.persistence import SqliteExecutionStateStore
with SqliteExecutionStateStore("/var/lib/capability-fabric/onshape/fabric-state/execution.sqlite3") as state:
    assert not state.recoverable()
print("CF_R9_RESUME_POST_RECOVERABLE=zero")
PY

# Reopen ordinary semantic ingress only after all postconditions pass.
rm -f "$GATE"
docker start "$GATEWAY" >/dev/null
for _ in $(seq 1 90); do
  if [[ "$(curl -fsS --max-time 2 http://127.0.0.1:8787/ 2>/dev/null || true)" == "cf-onshape-single ok" ]]; then break; fi
  sleep 1
done
[[ "$(curl -fsS --max-time 2 http://127.0.0.1:8787/)" == "cf-onshape-single ok" ]]
systemctl start "$TIMER"
systemctl is-active --quiet "$TIMER"
[[ ! -e "$GATE" ]]
trap - ERR

echo CF_R9_RESUME_GATEWAY=healthy
echo CF_R9_RESUME_TIMER=active
echo CF_R9_RESUME=pass
