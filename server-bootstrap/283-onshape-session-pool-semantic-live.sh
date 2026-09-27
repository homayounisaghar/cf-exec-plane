#!/usr/bin/env bash
set -euo pipefail
umask 077
[[ "$(id -u)" -eq 0 ]] || exit 2

candidate="9d4dea9aeebb8baab5fe12fa7478126ad3d397c9"
fixture="a19e0fa5152af9f7ce106b6e:e5e7d0173fd1f1d0307a2cb6:e0929361aadb6135b5cecffa"
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

wait_text(){ local u="$1" e="$2" n="${3:-120}"; for _ in $(seq 1 "$n"); do [[ "$(curl -fsS --max-time 2 "$u" 2>/dev/null || true)" == "$e" ]] && return 0; sleep 1; done; return 1; }
wait_json(){ local u="$1" n="${2:-90}"; for _ in $(seq 1 "$n"); do curl -fsS --max-time 2 "$u" 2>/dev/null | python3 -c 'import json,sys; assert json.load(sys.stdin).get("ok") is True' 2>/dev/null && return 0; sleep 1; done; return 1; }

restore(){
  set +e
  docker rm -f "$lab_fabric" "$lab_server" >/dev/null 2>&1 || true
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
d=json.load(open(sys.argv[1])); a=d["authority"]; g=a["productionGuard"]
assert d["controlRevision"]==556 and a["productionEpoch"]==27 and d["lease"]["state"]=="FREE"
assert a["mode"]=="VPS_PRODUCTION" and a["materialAuthority"]=="vps-fabric"
assert a["reconciliationHold"]["active"] is False
assert g["killSwitch"]=="ENGAGED" and g["allowedDocumentIds"]==[] and g["mutationBudget"]["maxMutations"]==0
print("CF_POOL_SEMANTIC_PREFLIGHT_AUTHORITY=pass")
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
echo CF_POOL_SEMANTIC_MAINTENANCE=fail-closed

tmp="$(mktemp -d /var/lib/capability-fabric/.pool-semantic.XXXXXX)"
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

rm -rf "$root"
mkdir -p "$root"/{profile,agent-state,fabric-state,lab-state}
chmod 0700 "$root" "$root"/*

docker rm -f "$lab_fabric" "$lab_server" >/dev/null 2>&1 || true
docker run -d --name "$lab_server" --network host --ipc host --memory 5g --cpus 4   --cap-drop ALL --security-opt no-new-privileges --read-only --tmpfs /tmp:rw,exec,nosuid,nodev,size=5g   -e HOST=127.0.0.1 -e PORT=8788 -e CF_DIAGNOSTIC_PORT=8789 -e CF_FABRIC_SIDECAR_URL=http://127.0.0.1:8791   -e CF_FABRIC_AGENT_STATE_DIR=/agent-state -e CF_FABRIC_REQUIRE_PRODUCTION_AUTHORITY=0 -e CF_PRIVILEGED_NATIVE_ENABLED=0   -e CF_PUBLIC_SURFACE=shadow -e MCP_TOKEN_FILE=/run/secrets/mcp-token -e ONSHAPE_PROFILE_DIR=/profile   -e ONSHAPE_ACCOUNT_FILE=/run/onshape-secrets/account -e ONSHAPE_PASSWORD_FILE=/run/onshape-secrets/password   -e ONSHAPE_COMPANY_OWNER_ID=64a4114074132e1ea68137a8 -e ONSHAPE_ANTI_FORGERY_HEADER_NAME=x-xsrf-token   -e ONSHAPE_UI_API_VERSION=v14 -e ONSHAPE_OPENAPI_FILE=/openapi/onshape-openapi.json -e ONSHAPE_POOL_SIZE=5   -e ONSHAPE_POOL_TMP_ROOT=/tmp/onshape-session-pool-semantic -e ONSHAPE_POOL_LEASE_STATE_FILE=/agent-state/workflow-leases.json   -e ONSHAPE_POOL_MAX_CONCURRENT_NAVIGATIONS=2 -e CF_RELEASE_GATE_FILE=/run/lab-state/release-in-progress   -e PCG_WEB_SOCKET=/run/pcg/web.sock -e HOME=/tmp -e NPM_CONFIG_CACHE=/tmp/npm-cache -e PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1   -v "$tmp/release/server-deploy/current:/release:ro" -v /etc/capability-fabric/secrets/mcp-token:/run/secrets/mcp-token:ro   -v /etc/capability-fabric/secrets/onshape:/run/onshape-secrets:ro -v "$root/profile:/profile:rw"   -v /var/lib/capability-fabric/onshape/openapi:/openapi:ro -v "$root/agent-state:/agent-state:rw" -v "$root/lab-state:/run/lab-state:ro"   "$node_image" sh -lc 'mkdir -p /tmp/app && cp /release/package.json /release/server.js /release/core.js /release/browser.js /release/session-pool.js /release/onshape-request.cjs /release/fabric-agent.js /release/telegram-ingress.mjs /tmp/app/ && cd /tmp/app && npm install --omit=dev --ignore-scripts --no-audit --no-fund --package-lock=false && exec node server.js' >/dev/null

wait_text http://127.0.0.1:8788/ "cf-onshape-single ok" 180 || { docker logs --tail 120 "$lab_server" >&2; exit 30; }

docker run -d --name "$lab_fabric" --network host --cap-drop ALL --security-opt no-new-privileges --read-only --tmpfs /tmp:rw,nosuid,nodev,size=512m   -e HOST=127.0.0.1 -e PORT=8791 -e PYTHONPATH=/release/fabric-src -e PYTHONDONTWRITEBYTECODE=1 -e PYTHONUNBUFFERED=1 -e HOME=/tmp   -e MCP_TOKEN_FILE=/run/secrets/mcp-token -e CF_FABRIC_POLICY_FILE=/release/fabric-policy/semantic-enforcement.v1.json   -e CF_FABRIC_STATE_DB=/fabric-state/execution.sqlite3 -e CF_FABRIC_PROJECT_STATE_REVISION=session-pool-semantic-live   -e CF_FABRIC_QUALIFICATION_MODE=1 -e CF_FABRIC_REQUIRE_PRODUCTION_AUTHORITY=0   -v "$tmp/release/server-deploy/current/fabric-src:/release/fabric-src:ro" -v "$tmp/release/server-deploy/current/fabric-policy:/release/fabric-policy:ro"   -v /etc/capability-fabric/secrets/mcp-token:/run/secrets/mcp-token:ro -v "$root/fabric-state:/fabric-state:rw"   "$py_image" python -m capability_fabric.onshape_vps_sidecar >/dev/null

wait_json http://127.0.0.1:8791/ 90 || { docker logs --tail 120 "$lab_fabric" >&2; exit 31; }

docker exec -e CF_FIXTURE="$fixture" -i "$lab_server" sh -lc 'cd /tmp/app && node --input-type=module'   < server-bootstrap/helpers/283-onshape-session-pool-semantic-client.mjs | tee "$root/result.log"

result="$(tail -n 1 "$root/result.log")"
python3 - "$result" <<'PY'
import json,sys
r=json.loads(sys.argv[1])
assert r["ok"] is True and r["semantic_contexts"]==5 and r["physical_slots_distinct"]==5
assert r["documented_reads"]==100 and r["post_auth_proven"]==5 and r["fingerprints_distinct"] is True
assert r["final_workflow_lease_count"]==0 and r["final_active_count"]==0 and r["physical_slot_redaction"] is True
print("CF_POOL_SEMANTIC_RESULT="+json.dumps(r,separators=(",",":"),sort_keys=True))
PY

docker exec -i "$lab_fabric" python - <<'PY'
from capability_fabric.persistence import SqliteExecutionStateStore
with SqliteExecutionStateStore("/fabric-state/execution.sqlite3") as state:
    assert not state.recoverable()
print("CF_POOL_SEMANTIC_RECOVERABLE=zero")
PY

echo "CF_POOL_SEMANTIC_SERVER_STATS=$(docker stats --no-stream --format '{{.CPUPerc}}|{{.MemUsage}}|{{.PIDs}}' "$lab_server")"
echo "CF_POOL_SEMANTIC_FABRIC_STATS=$(docker stats --no-stream --format '{{.CPUPerc}}|{{.MemUsage}}|{{.PIDs}}' "$lab_fabric")"
docker rm -f "$lab_fabric" "$lab_server" >/dev/null
flock -u 9
echo CF_POOL_SEMANTIC_TEST=pass
