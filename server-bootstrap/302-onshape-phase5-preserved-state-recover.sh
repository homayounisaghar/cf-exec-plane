#!/usr/bin/env bash
set -euo pipefail
umask 077
[[ "$(id -u)" -eq 0 ]] || { echo CF_PHASE5_RECOVERY_ROOT=required >&2; exit 2; }

candidate="c9e8104cfa2bebfc42bf4adddb458d66e60f67fc"
expected_attempt="attempt:259ecb51-acdb-420b-a2fa-8f7ffc315750"
expected_context="ctx_636105927daa35594f44d1fb5700348c"
expected_name="CF Phase5 Disposable A 1790546380300"
root="/var/lib/capability-fabric/onshape-session-pool-phase5-lab"
marker="$root/agent-state/phase5-live-unresolved.json"
db="$root/fabric-state/execution.sqlite3"
control="/var/lib/capability-fabric/onshape/runtime-control/ONSHAPE_RUNTIME_CONTROL.json"
gate="/var/lib/capability-fabric/state/release-in-progress"
lock="/run/lock/capability-fabric-pull.lock"
timer="capability-fabric-pull.timer"
cache="/var/lib/capability-fabric/repo.git"
token="/etc/capability-fabric/secrets/repo-read-token"
git_home="/var/lib/capability-fabric/agent-home"
prod_server="capability-fabric-onshape-server"
prod_fabric="capability-fabric-onshape-fabric"
prod_gateway="capability-fabric-onshape-gateway"
lab_server="capability-fabric-onshape-phase5-recovery-server"
lab_fabric="capability-fabric-onshape-phase5-recovery-fabric"
node_image="mcr.microsoft.com/playwright:v1.62.1-resolute@sha256:aebd85bce8056dcdc2269853fd94ea432b6a201da4f0ef125b509489ecd52ddb"
py_image="python:3.12-slim-bookworm@sha256:392307d22300de8b5986851a12d9176dfc0fc073e65bf6523ebd7dcbeb23564e"
maintenance=false
gateway_was_running=false
timer_was_active=false
restore_failed=false
tmp=""

wait_text(){ local url="$1" want="$2" max="$3"; for _ in $(seq 1 "$max"); do curl -fsS "$url" 2>/dev/null | grep -Fq "$want" && return 0; sleep 1; done; return 1; }
wait_json(){ local url="$1" max="$2"; for _ in $(seq 1 "$max"); do curl -fsS "$url" 2>/dev/null | python3 -c 'import json,sys; assert json.load(sys.stdin).get("ok") is True' 2>/dev/null && return 0; sleep 1; done; return 1; }

restore(){
  set +e
  docker rm -f "$lab_fabric" "$lab_server" >/dev/null 2>&1 || true
  [[ -n "$tmp" ]] && rm -rf "$tmp" >/dev/null 2>&1 || true
  docker start "$prod_server" >/dev/null 2>&1 || true
  wait_text http://127.0.0.1:8788/ "cf-onshape-single ok" 180 || restore_failed=true
  docker start "$prod_fabric" >/dev/null 2>&1 || true
  wait_json http://127.0.0.1:8791/ 120 || restore_failed=true
  rm -f "$gate"
  if [[ "$restore_failed" == false ]]; then
    bash server-bootstrap/281-onshape-production-cohort-recover.sh || restore_failed=true
  fi
  if [[ "$gateway_was_running" == true && "$restore_failed" == false ]]; then
    docker start "$prod_gateway" >/dev/null 2>&1 || true
    wait_text http://127.0.0.1:8787/ "cf-onshape-single ok" 90 || restore_failed=true
  fi
  if [[ "$timer_was_active" == true && "$restore_failed" == false ]]; then
    systemctl start "$timer" >/dev/null 2>&1 || restore_failed=true
  fi
  if [[ "$restore_failed" == false ]]; then
    echo CF_PHASE5_RECOVERY_RESTORE=production-green
  else
    echo CF_PHASE5_RECOVERY_RESTORE=failed >&2
  fi
  set -e
}
cleanup(){ rc=$?; [[ "$maintenance" == true ]] && restore || true; [[ "$restore_failed" == true && "$rc" -eq 0 ]] && rc=90; exit "$rc"; }
trap cleanup EXIT

[[ -s "$marker" && -s "$db" && -s "$control" && -d "$cache" && -s "$token" ]] || exit 20
python3 - "$marker" "$db" "$expected_attempt" "$expected_context" "$expected_name" <<'PY'
import json,sqlite3,sys
marker,db,attempt,context,name=sys.argv[1:]
m=json.load(open(marker))
assert m.get("executionContextId")==context
assert m.get("expectedName")==name
assert m.get("workItem")=="phase5-copy"
con=sqlite3.connect("file:"+db+"?mode=ro",uri=True)
con.row_factory=sqlite3.Row
rows=con.execute("""
SELECT a.attempt_id,a.state AS attempt_state,a.observation_payload,
       o.state AS operation_state,i.phase
FROM invocations i
JOIN operations o ON o.invocation_id=i.invocation_id
JOIN attempts a ON a.operation_id=o.operation_id
WHERE a.attempt_id=?
""",(attempt,)).fetchall()
assert len(rows)==1
r=rows[0]
assert r["attempt_state"]=="DISPATCH_INTENT"
assert r["observation_payload"] is None
assert r["operation_state"]=="IN_FLIGHT"
assert r["phase"]=="DISPATCH_INTENT"
con.close()
print("CF_PHASE5_RECOVERY_PRESERVED_IDENTITY=pass")
PY

python3 - "$control" <<'PY'
import json,sys
d=json.load(open(sys.argv[1])); a=d["authority"]; v=a["planes"]["vps-fabric"]; g=a["productionGuard"]
assert d["controlRevision"]==558 and d["lease"]["state"]=="FREE"
assert a["productionEpoch"]==29 and a["mode"]=="VPS_PRODUCTION"
assert a["reconciliationHold"]["active"] is False
assert v["ingress"]=="ADMITTED" and v["materialEffectsAllowed"] is True
assert v["releaseSequence"]==74 and v["releaseId"]=="onshape-vps-hardened-r9"
assert g["schema"]=="capability-fabric.onshape-production-guard.v1"
assert g["killSwitch"]=="ENGAGED" and g["allowedDocumentIds"]==[] and g["mutationBudget"]["maxMutations"]==0
print("CF_PHASE5_RECOVERY_AUTHORITY=pass")
PY

for c in "$prod_server" "$prod_fabric" "$prod_gateway"; do
  [[ "$(docker inspect -f '{{.State.Running}}' "$c" 2>/dev/null || echo false)" == true ]] || exit 21
  [[ "$(docker inspect -f '{{.State.Health.Status}}' "$c" 2>/dev/null || echo unhealthy)" == healthy ]] || exit 21
done
gateway_was_running=true
systemctl is-active --quiet "$timer" && timer_was_active=true || true

exec 9>"$lock"
flock -w 30 9 || { echo CF_PHASE5_RECOVERY_SHARED_LOCK=busy >&2; exit 22; }
[[ ! -e "$gate" ]] || { echo CF_PHASE5_RECOVERY_GATE=present >&2; exit 23; }
printf '%s
' RELEASE_IN_PROGRESS > "$gate"
chmod 0600 "$gate"
systemctl stop "$timer" >/dev/null 2>&1 || true
docker stop "$prod_gateway" "$prod_fabric" "$prod_server" >/dev/null
maintenance=true
echo CF_PHASE5_RECOVERY_MAINTENANCE=fail-closed

tmp="$(mktemp -d /var/lib/capability-fabric/.phase5-recovery.XXXXXX)"
mkdir -p "$tmp/release"
ask="$tmp/askpass"
cat > "$ask" <<'ASK'
#!/usr/bin/env bash
case "${1:-}" in
  *Username*) printf '%s
' x-access-token ;;
  *Password*) cat /etc/capability-fabric/secrets/repo-read-token ;;
  *) exit 1 ;;
esac
ASK
chmod 0700 "$ask"
GIT_ASKPASS="$ask" GIT_TERMINAL_PROMPT=0 HOME="$git_home" git --git-dir="$cache" fetch --quiet --force --depth=1 origin "$candidate"
[[ "$(git --git-dir="$cache" rev-parse FETCH_HEAD)" == "$candidate" ]] || exit 24
git --git-dir="$cache" archive "$candidate" | tar -x -C "$tmp/release"
release="$tmp/release/server-deploy/current"
[[ -s "$release/server.js" && -s "$release/fabric-agent.js" && -s "$release/manifest.json" ]] || exit 25
manifest_sha="$(sha256sum "$release/manifest.json" | awk '{print $1}')"
[[ "$manifest_sha" == "5abb7ec2ba3525f3f1e3cf535323106436b42d264150fb20c911b221ef3af7a3" ]] || exit 26
printf '%s
' "$manifest_sha" > "$release/manifest.sha256"
echo CF_PHASE5_RECOVERY_CANDIDATE_FETCH=pass

docker rm -f "$lab_server" "$lab_fabric" >/dev/null 2>&1 || true
docker run -d --name "$lab_server" --network host --ipc host --memory 5g --cpus 4   --cap-drop ALL --security-opt no-new-privileges --read-only --tmpfs /tmp:rw,exec,nosuid,nodev,size=5g   -e HOST=127.0.0.1 -e PORT=8788 -e CF_DIAGNOSTIC_PORT=8789 -e CF_FABRIC_SIDECAR_URL=http://127.0.0.1:8791   -e CF_FABRIC_AGENT_STATE_DIR=/agent-state -e CF_ONSHAPE_RUNTIME_CONTROL_FILE=/run/cf-authority/ONSHAPE_RUNTIME_CONTROL.json   -e CF_FABRIC_REQUIRE_PRODUCTION_AUTHORITY=1 -e CF_PRIVILEGED_NATIVE_ENABLED=0 -e CF_PUBLIC_SURFACE=semantic-only   -e MCP_TOKEN_FILE=/run/secrets/mcp-token -e ONSHAPE_PROFILE_DIR=/profile   -e ONSHAPE_ACCOUNT_FILE=/run/onshape-secrets/account -e ONSHAPE_PASSWORD_FILE=/run/onshape-secrets/password   -e ONSHAPE_COMPANY_OWNER_ID=64a4114074132e1ea68137a8 -e ONSHAPE_ANTI_FORGERY_HEADER_NAME=x-xsrf-token   -e ONSHAPE_UI_API_VERSION=v14 -e ONSHAPE_OPENAPI_FILE=/openapi/onshape-openapi.json -e ONSHAPE_POOL_SIZE=5   -e ONSHAPE_POOL_MULTI_MUTATOR_ENABLED=1 -e ONSHAPE_POOL_TMP_ROOT=/tmp/onshape-session-pool-phase5   -e ONSHAPE_POOL_LEASE_STATE_FILE=/agent-state/workflow-leases.json -e ONSHAPE_POOL_MAX_CONCURRENT_NAVIGATIONS=2   -e CF_RELEASE_GATE_FILE=/run/lab-state/release-in-progress -e HOME=/tmp -e NPM_CONFIG_CACHE=/tmp/npm-cache -e PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1   -v "$release:/release:ro" -v /etc/capability-fabric/secrets/mcp-token:/run/secrets/mcp-token:ro   -v /etc/capability-fabric/secrets/onshape:/run/onshape-secrets:rw -v "$root/profile:/profile:rw"   -v /var/lib/capability-fabric/onshape/openapi:/openapi:ro -v "$root/agent-state:/agent-state:rw"   -v "$root/control:/run/cf-authority:ro" -v "$root/lab-state:/run/lab-state:ro"   "$node_image" sh -lc 'mkdir -p /tmp/app && cp /release/package.json /release/server.js /release/core.js /release/browser.js /release/session-pool.js /release/onshape-request.cjs /release/fabric-agent.js /release/telegram-ingress.mjs /tmp/app/ && cd /tmp/app && npm install --omit=dev --ignore-scripts --no-audit --no-fund --package-lock=false && exec node server.js' >/dev/null
wait_text http://127.0.0.1:8788/ "cf-onshape-single ok" 180 || { docker logs --tail 150 "$lab_server" >&2; exit 30; }

docker run -d --name "$lab_fabric" --network host --cap-drop ALL --security-opt no-new-privileges --read-only --tmpfs /tmp:rw,nosuid,nodev,size=512m   -e HOST=127.0.0.1 -e PORT=8791 -e PYTHONPATH=/release/fabric-src -e PYTHONDONTWRITEBYTECODE=1 -e PYTHONUNBUFFERED=1 -e HOME=/tmp   -e MCP_TOKEN_FILE=/run/secrets/mcp-token -e CF_FABRIC_POLICY_FILE=/release/fabric-policy/semantic-enforcement.v1.json   -e CF_FABRIC_STATE_DB=/fabric-state/execution.sqlite3 -e CF_FABRIC_PROJECT_STATE_REVISION=phase5-preserved-recovery-c9e8104c   -e CF_FABRIC_QUALIFICATION_MODE=1 -e CF_FABRIC_REQUIRE_PRODUCTION_AUTHORITY=1   -e CF_ONSHAPE_RUNTIME_CONTROL_FILE=/run/cf-authority/ONSHAPE_RUNTIME_CONTROL.json   -v "$release/fabric-src:/release/fabric-src:ro" -v "$release/fabric-policy:/release/fabric-policy:ro"   -v /etc/capability-fabric/secrets/mcp-token:/run/secrets/mcp-token:ro -v "$root/fabric-state:/fabric-state:rw"   -v "$root/control:/run/cf-authority:ro" "$py_image" python -m capability_fabric.onshape_vps_sidecar >/dev/null
wait_json http://127.0.0.1:8791/ 90 || { docker logs --tail 150 "$lab_fabric" >&2; exit 31; }
echo CF_PHASE5_RECOVERY_LAB=started

reconcile_out="$(docker exec -e CF_ATTEMPT="$expected_attempt" -i "$lab_server" sh -lc 'cd /tmp/app && node --input-type=module' <<'NODE'
import fs from "node:fs";
import {Client} from "@modelcontextprotocol/sdk/client/index.js";
import {StreamableHTTPClientTransport} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
const token=fs.readFileSync("/run/secrets/mcp-token","utf8").trim();
const attempt=process.env.CF_ATTEMPT;
const c=new Client({name:"phase5-preserved-recovery",version:"1"});
await c.connect(new StreamableHTTPClientTransport(new URL("http://127.0.0.1:8788/mcp/"+token)));
const r=await c.callTool({name:"onshape_fabric_reconcile",arguments:{attempt_id:attempt}},undefined,{timeout:240000});
console.log((r.content||[]).filter(x=>x.type==="text").map(x=>x.text||"").join("\n"));
await c.close();
NODE
)"
printf '%s
' "$reconcile_out"
python3 - "$reconcile_out" "$expected_attempt" <<'PY'
import json,sys
x=json.loads(sys.argv[1]); attempt=sys.argv[2]
r=x.get("result") or {}
assert r.get("attemptId")==attempt
assert (r.get("outcome") or {}).get("state")=="ABSENT", r
obs=r.get("observation") or {}
ev=obs.get("evidence") or {}
assert obs.get("ackState")=="REJECTED", obs
assert ev.get("effectSent") is False
assert ev.get("preEffectLeaseUseNotEntered") is True
assert ev.get("postconditionAbsentVerified") is True
print("CF_PHASE5_RECOVERY_ATTEMPT=ABSENT")
print("CF_PHASE5_RECOVERY_NO_REPLAY=pass")
PY

docker exec -i "$lab_fabric" python - "$expected_attempt" <<'PY'
import sys
from capability_fabric.persistence import SqliteExecutionStateStore
attempt=sys.argv[1]
with SqliteExecutionStateStore("/fabric-state/execution.sqlite3") as state:
    rows=state.recoverable()
    assert not rows, rows
print("CF_PHASE5_RECOVERY_FABRIC_RECOVERABLE=zero")
PY

pool_out="$(docker exec -i "$lab_server" sh -lc 'cd /tmp/app && node --input-type=module' <<'NODE'
import fs from "node:fs";
import {Client} from "@modelcontextprotocol/sdk/client/index.js";
import {StreamableHTTPClientTransport} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
const token=fs.readFileSync("/run/secrets/mcp-token","utf8").trim();
const c=new Client({name:"phase5-preserved-recovery-pool",version:"1"});
await c.connect(new StreamableHTTPClientTransport(new URL("http://127.0.0.1:8788/mcp/"+token)));
const r=await c.callTool({name:"onshape_pool_status",arguments:{}},undefined,{timeout:180000});
console.log((r.content||[]).filter(x=>x.type==="text").map(x=>x.text||"").join("\n"));
await c.close();
NODE
)"
python3 - "$pool_out" "$expected_context" <<'PY'
import json,sys
p=json.loads(sys.argv[1]); ctx=sys.argv[2]
assert not any(x.get("lease_id")==ctx for x in p.get("workflow_leases") or []), p
assert p.get("document_lock_count")==0
print("CF_PHASE5_RECOVERY_FENCE_CLEARED=pass")
PY

rm -f "$marker"
sync
echo CF_PHASE5_RECOVERY_MARKER_CLEARED=terminal-ABSENT
echo CF_PHASE5_PRESERVED_RECOVERY=pass
