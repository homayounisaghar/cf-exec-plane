#!/usr/bin/env bash
set -euo pipefail
umask 077
[[ "$(id -u)" -eq 0 ]] || exit 2

candidate="689317bff9529e26b13a331cb6029267181238de"
gate="/var/lib/capability-fabric/state/release-in-progress"
lock="/run/lock/capability-fabric-pull.lock"
cache="/var/lib/capability-fabric/repo.git"
git_home="/var/lib/capability-fabric/agent-home"
control="/var/lib/capability-fabric/onshape/runtime-control/ONSHAPE_RUNTIME_CONTROL.json"
prod_server="capability-fabric-onshape-server"
prod_fabric="capability-fabric-onshape-fabric"
prod_gateway="capability-fabric-onshape-gateway"
lab_server="capability-fabric-onshape-session-pool-semantic-server"
lab_fabric="capability-fabric-onshape-session-pool-semantic-fabric"
root="/var/lib/capability-fabric/onshape-session-pool-semantic-lab"
node_image="mcr.microsoft.com/playwright:v1.62.1-resolute@sha256:aebd85bce8056dcdc2269853fd94ea432b6a201da4f0ef125b509489ecd52ddb"
py_image="python:3.12-slim-bookworm@sha256:392307d22300de8b5986851a12d9176dfc0fc073e65bf6523ebd7dcbeb23564e"
maintenance=false
restore_failed=false
gateway_was_running=false
tmp=""

wait_text(){ local u="$1" e="$2" n="${3:-120}"; for _ in $(seq 1 "$n"); do [[ "$(curl -fsS --max-time 2 "$u" 2>/dev/null || true)" == "$e" ]] && return 0; sleep 1; done; return 1; }
wait_json(){ local u="$1" n="${2:-90}"; for _ in $(seq 1 "$n"); do curl -fsS --max-time 2 "$u" 2>/dev/null | python3 -c 'import json,sys; assert json.load(sys.stdin).get("ok") is True' 2>/dev/null && return 0; sleep 1; done; return 1; }

stop_lab(){ docker rm -f "$lab_fabric" "$lab_server" >/dev/null 2>&1 || true; }

restore(){
  set +e
  stop_lab
  [[ -n "$tmp" ]] && rm -rf "$tmp" >/dev/null 2>&1 || true
  rm -rf "$root" >/dev/null 2>&1 || true
  docker start "$prod_server" >/dev/null 2>&1 || true
  wait_text http://127.0.0.1:8788/ "cf-onshape-single ok" 120 || restore_failed=true
  docker start "$prod_fabric" >/dev/null 2>&1 || true
  wait_json http://127.0.0.1:8791/ 90 || restore_failed=true
  rm -f "$gate"
  if [[ "$restore_failed" == false ]]; then
    bash server-bootstrap/281-onshape-production-cohort-recover.sh
    rc=$?
    (( rc == 0 )) || restore_failed=true
  fi
  if [[ "$gateway_was_running" == true ]]; then
    docker start "$prod_gateway" >/dev/null 2>&1 || true
    wait_text http://127.0.0.1:8787/ "cf-onshape-single ok" 90 || restore_failed=true
  fi
  set -e
}
cleanup(){ rc=$?; [[ "$maintenance" == true ]] && restore || true; [[ "$restore_failed" == true && "$rc" -eq 0 ]] && rc=90; exit "$rc"; }
trap cleanup EXIT

python3 - "$control" <<'PY'
import json,sys
d=json.load(open(sys.argv[1])); a=d["authority"]; g=a["productionGuard"]; v=a["planes"]["vps-fabric"]
assert d["controlRevision"]==558 and a["productionEpoch"]==29 and d["lease"]["state"]=="FREE"
assert a["mode"]=="VPS_PRODUCTION" and a["materialAuthority"]=="vps-fabric"
assert a["reconciliationHold"]["active"] is False
assert v["releaseSequence"]==74 and v["releaseId"]=="onshape-vps-hardened-r9"
assert v["manifestSha256"]=="5abb7ec2ba3525f3f1e3cf535323106436b42d264150fb20c911b221ef3af7a3"
assert g["schema"]=="capability-fabric.onshape-production-guard.v1"
assert g["killSwitch"]=="ENGAGED" and g["allowedDocumentIds"]==[] and g["mutationBudget"]["maxMutations"]==0
print("CF_PHASE5_PREFLIGHT_AUTHORITY=pass")
PY

for c in "$prod_server" "$prod_fabric" "$prod_gateway"; do
  [[ "$(docker inspect -f '{{.State.Running}}' "$c" 2>/dev/null || echo false)" == true ]]
  [[ "$(docker inspect -f '{{.State.Health.Status}}' "$c" 2>/dev/null || echo bad)" == healthy ]]
done
gateway_was_running=true

exec 9>"$lock"
flock -w 30 9 || exit 23
printf '%s\n' RELEASE_IN_PROGRESS > "$gate"
chmod 0600 "$gate"
docker stop "$prod_gateway" "$prod_fabric" "$prod_server" >/dev/null
maintenance=true
echo CF_PHASE5_MAINTENANCE=fail-closed

tmp="$(mktemp -d /var/lib/capability-fabric/.pool-phase5.XXXXXX)"
mkdir "$tmp/release"
ask="$tmp/askpass"
cat > "$ask" <<'ASK'
#!/usr/bin/env bash
case "${1:-}" in
  *Username*) printf '%s\n' x-access-token ;;
  *Password*) cat /etc/capability-fabric/secrets/repo-read-token ;;
  *) exit 1 ;;
esac
ASK
chmod 0700 "$ask"
GIT_ASKPASS="$ask" GIT_TERMINAL_PROMPT=0 HOME="$git_home" git --git-dir="$cache" fetch --quiet --force --depth=1 origin "$candidate"
[[ "$(git --git-dir="$cache" rev-parse FETCH_HEAD)" == "$candidate" ]]
git --git-dir="$cache" archive "$candidate" | tar -x -C "$tmp/release"
sha256sum "$tmp/release/server-deploy/current/manifest.json" | awk '{print $1}' > "$tmp/release/server-deploy/current/manifest.sha256"

rm -rf "$root"
mkdir -p "$root"/{profile,agent-state,fabric-state,lab-state,authority}
chmod 0700 "$root" "$root"/*

start_server(){
  local require_auth="$1" public_surface="$2"
  docker run -d --name "$lab_server" --network host --ipc host --memory 5g --cpus 4 \
    --cap-drop ALL --security-opt no-new-privileges --read-only --tmpfs /tmp:rw,exec,nosuid,nodev,size=5g \
    -e HOST=127.0.0.1 -e PORT=8788 -e CF_DIAGNOSTIC_PORT=8789 -e CF_FABRIC_SIDECAR_URL=http://127.0.0.1:8791 \
    -e CF_FABRIC_AGENT_STATE_DIR=/agent-state -e CF_FABRIC_REQUIRE_PRODUCTION_AUTHORITY="$require_auth" -e CF_PRIVILEGED_NATIVE_ENABLED=0 \
    -e CF_PUBLIC_SURFACE="$public_surface" -e MCP_TOKEN_FILE=/run/secrets/mcp-token -e ONSHAPE_PROFILE_DIR=/profile \
    -e ONSHAPE_ACCOUNT_FILE=/run/onshape-secrets/account -e ONSHAPE_PASSWORD_FILE=/run/onshape-secrets/password \
    -e ONSHAPE_COMPANY_OWNER_ID=64a4114074132e1ea68137a8 -e ONSHAPE_ANTI_FORGERY_HEADER_NAME=x-xsrf-token \
    -e ONSHAPE_UI_API_VERSION=v14 -e ONSHAPE_OPENAPI_FILE=/openapi/onshape-openapi.json -e ONSHAPE_POOL_SIZE=5 \
    -e ONSHAPE_POOL_MULTI_MUTATOR_ENABLED=1 -e ONSHAPE_POOL_TMP_ROOT=/tmp/onshape-session-pool-phase5 \
    -e ONSHAPE_POOL_LEASE_STATE_FILE=/agent-state/workflow-leases.json -e ONSHAPE_POOL_MAX_CONCURRENT_NAVIGATIONS=2 \
    -e CF_ONSHAPE_RUNTIME_CONTROL_FILE=/run/cf-authority/ONSHAPE_RUNTIME_CONTROL.json -e CF_RELEASE_GATE_FILE=/run/lab-state/release-in-progress \
    -e PCG_WEB_SOCKET=/run/pcg/web.sock -e HOME=/tmp -e NPM_CONFIG_CACHE=/tmp/npm-cache -e PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    -v "$tmp/release/server-deploy/current:/release:ro" -v /etc/capability-fabric/secrets/mcp-token:/run/secrets/mcp-token:ro \
    -v /etc/capability-fabric/secrets/onshape:/run/onshape-secrets:rw -v "$root/profile:/profile:rw" \
    -v /var/lib/capability-fabric/onshape/openapi:/openapi:ro -v "$root/agent-state:/agent-state:rw" \
    -v "$root/authority:/run/cf-authority:ro" -v "$root/lab-state:/run/lab-state:ro" \
    "$node_image" sh -lc 'mkdir -p /tmp/app && cp /release/package.json /release/server.js /release/core.js /release/browser.js /release/session-pool.js /release/onshape-request.cjs /release/fabric-agent.js /release/telegram-ingress.mjs /tmp/app/ && cd /tmp/app && npm install --omit=dev --ignore-scripts --no-audit --no-fund --package-lock=false && exec node server.js' >/dev/null
  wait_text http://127.0.0.1:8788/ "cf-onshape-single ok" 180 || { docker logs --tail 160 "$lab_server" >&2; exit 30; }
}

start_fabric(){
  local require_auth="$1"
  docker run -d --name "$lab_fabric" --network host --cap-drop ALL --security-opt no-new-privileges --read-only --tmpfs /tmp:rw,nosuid,nodev,size=512m \
    -e HOST=127.0.0.1 -e PORT=8791 -e PYTHONPATH=/release/fabric-src -e PYTHONDONTWRITEBYTECODE=1 -e PYTHONUNBUFFERED=1 -e HOME=/tmp \
    -e MCP_TOKEN_FILE=/run/secrets/mcp-token -e CF_FABRIC_POLICY_FILE=/release/fabric-policy/semantic-enforcement.v1.json \
    -e CF_FABRIC_STATE_DB=/fabric-state/execution.sqlite3 -e CF_FABRIC_PROJECT_STATE_REVISION=session-pool-phase5-live \
    -e CF_FABRIC_QUALIFICATION_MODE=1 -e CF_FABRIC_REQUIRE_PRODUCTION_AUTHORITY="$require_auth" \
    -e CF_ONSHAPE_RUNTIME_CONTROL_FILE=/run/cf-authority/ONSHAPE_RUNTIME_CONTROL.json \
    -v "$tmp/release/server-deploy/current/fabric-src:/release/fabric-src:ro" -v "$tmp/release/server-deploy/current/fabric-policy:/release/fabric-policy:ro" \
    -v /etc/capability-fabric/secrets/mcp-token:/run/secrets/mcp-token:ro -v "$root/fabric-state:/fabric-state:rw" \
    -v "$root/authority:/run/cf-authority:ro" "$py_image" python -m capability_fabric.onshape_vps_sidecar >/dev/null
  wait_json http://127.0.0.1:8791/ 90 || { docker logs --tail 160 "$lab_fabric" >&2; exit 31; }
}

stop_lab
start_server 0 shadow
start_fabric 0
docker exec -e CF_MODE=setup -i "$lab_server" sh -lc 'cd /tmp/app && node --input-type=module' \
  < server-bootstrap/helpers/283-onshape-session-pool-semantic-client.mjs | tee "$root/setup.log"
docs="$(tail -n 1 "$root/setup.log")"
python3 - "$docs" <<'PY'
import json,sys
r=json.loads(sys.argv[1])
assert r["ok"] is True and r["mode"]=="setup"
for key in ("a","b"):
    assert len(r[key]["did"])==24 and len(r[key]["wid"])==24
assert r["a"]["did"] != r["b"]["did"]
print("CF_PHASE5_DISPOSABLE_DOCS=pass")
PY

manifest_sha="$(cat "$tmp/release/server-deploy/current/manifest.sha256")"
python3 - "$docs" "$manifest_sha" "$root/authority/ONSHAPE_RUNTIME_CONTROL.json" <<'PY'
import json,sys
r=json.loads(sys.argv[1]); manifest=sys.argv[2]; out=sys.argv[3]
A=r["a"]["did"]; B=r["b"]["did"]
def grant(g,w,d,state,n,b):
    return {"grantId":g,"workItem":w,"documentId":d,"state":state,"mutationBudget":{"budgetId":b,"maxMutations":n}}
control={
 "schema":"capability-fabric.onshape-runtime-control.v1","controlRevision":900001,
 "authority":{
  "schema":"capability-fabric.onshape-production-authority.v1","productionEpoch":900001,
  "mode":"VPS_PRODUCTION","materialAuthority":"vps-fabric",
  "planes":{
   "android-v1":{"ingress":"CLOSED","materialEffectsAllowed":False,"busGeneration":3},
   "vps-fabric":{"ingress":"ADMITTED","materialEffectsAllowed":True,"releaseSequence":74,"releaseId":"onshape-vps-hardened-r9","manifestSha256":manifest}
  },
  "reconciliationHold":{"active":False},
  "productionGuard":{"schema":"capability-fabric.onshape-production-guard.v2","generation":900001,"killSwitch":"OPEN","grants":[
   grant("phase5-grant-A","phase5-live-A",A,"ACTIVE",2,"phase5-budget-A"),
   grant("phase5-grant-B","phase5-live-B",B,"ACTIVE",2,"phase5-budget-B"),
   grant("phase5-grant-C","phase5-live-C",A,"ACTIVE",1,"phase5-budget-C"),
   grant("phase5-grant-revoked","phase5-live-REVOKED",B,"REVOKED",1,"phase5-budget-revoked"),
   grant("phase5-grant-exhausted","phase5-live-EXHAUSTED",B,"ACTIVE",0,"phase5-budget-exhausted"),
   grant("phase5-grant-budget","phase5-live-BUDGET",B,"ACTIVE",2,"phase5-budget-race")
  ]}
 }
}
with open(out,"w") as f: json.dump(control,f,separators=(",",":"))
PY
chmod 0600 "$root/authority/ONSHAPE_RUNTIME_CONTROL.json"

stop_lab
rm -rf "$root/fabric-state" "$root/agent-state"
mkdir -p "$root/fabric-state" "$root/agent-state"
chmod 0700 "$root/fabric-state" "$root/agent-state"
start_server 1 semantic-only
start_fabric 1

docker exec -e CF_MODE=qualify -e CF_DOCS="$docs" -i "$lab_server" sh -lc 'cd /tmp/app && node --input-type=module' \
  < server-bootstrap/helpers/283-onshape-session-pool-semantic-client.mjs | tee "$root/result.log"
result="$(tail -n 1 "$root/result.log")"
python3 - "$result" <<'PY'
import json,sys
r=json.loads(sys.argv[1])
assert r["ok"] is True and r["mode"]=="qualify"
assert r["different_document_slots_distinct"] is True and r["authoritative_readback"] is True
assert r["navigation_limit"]==2 and r["post_auth_proven"]==5 and r["fingerprints_distinct"] is True
assert r["final_workflow_lease_count"]==0
assert 1 <= r["budget_atomic"]["achieved"] <= 2 and r["budget_atomic"]["attempts"]==4
print("CF_PHASE5_LIVE_RESULT="+json.dumps(r,separators=(",",":"),sort_keys=True))
PY

docker exec -i "$lab_fabric" python - <<'PY'
from capability_fabric.persistence import SqliteExecutionStateStore
with SqliteExecutionStateStore("/fabric-state/execution.sqlite3") as state:
    assert not state.recoverable()
print("CF_PHASE5_RECOVERABLE=zero")
PY

echo "CF_PHASE5_SERVER_STATS=$(docker stats --no-stream --format '{{.CPUPerc}}|{{.MemUsage}}|{{.PIDs}}' "$lab_server")"
echo "CF_PHASE5_FABRIC_STATS=$(docker stats --no-stream --format '{{.CPUPerc}}|{{.MemUsage}}|{{.PIDs}}' "$lab_fabric")"
docker exec "$lab_server" sh -lc 'test "$(find /agent-state/mutation-budgets -type f -name "*.json" 2>/dev/null | wc -l)" -le 6'
stop_lab
flock -u 9
echo CF_PHASE5_LIVE_TEST=pass
