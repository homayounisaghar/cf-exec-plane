#!/usr/bin/env bash
set -euo pipefail
umask 077
[[ "$(id -u)" -eq 0 ]] || { echo CF_PHASE5_LIVE_ROOT=required >&2; exit 2; }

candidate="45b1cedb5b0021fd4c396cf36f1327b742306e4c"
fixture="a19e0fa5152af9f7ce106b6e:e5e7d0173fd1f1d0307a2cb6:e0929361aadb6135b5cecffa"
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
lab_server="capability-fabric-onshape-phase5-lab-server"
lab_fabric="capability-fabric-onshape-phase5-lab-fabric"
root="/var/lib/capability-fabric/onshape-session-pool-phase5-lab"
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
  rm -rf "$root" >/dev/null 2>&1 || true
  [[ -n "$tmp" ]] && rm -rf "$tmp" >/dev/null 2>&1 || true

  docker start "$prod_server" >/dev/null 2>&1 || true
  wait_text http://127.0.0.1:8788/ "cf-onshape-single ok" 180 || restore_failed=true
  docker start "$prod_fabric" >/dev/null 2>&1 || true
  wait_json http://127.0.0.1:8791/ 120 || restore_failed=true

  rm -f "$gate"
  if [[ "$restore_failed" == false ]]; then
    bash server-bootstrap/281-onshape-production-cohort-recover.sh
    rc=$?
    (( rc == 0 )) || restore_failed=true
  fi

  if [[ "$gateway_was_running" == true && "$restore_failed" == false ]]; then
    docker start "$prod_gateway" >/dev/null 2>&1 || true
    wait_text http://127.0.0.1:8787/ "cf-onshape-single ok" 90 || restore_failed=true
  fi
  if [[ "$timer_was_active" == true && "$restore_failed" == false ]]; then
    systemctl start "$timer" >/dev/null 2>&1 || restore_failed=true
  fi
  if [[ "$restore_failed" == false ]]; then
    echo CF_PHASE5_LIVE_RESTORE=production-green
  else
    echo CF_PHASE5_LIVE_RESTORE=failed >&2
  fi
  set -e
}
cleanup(){ rc=$?; [[ "$maintenance" == true ]] && restore || true; [[ "$restore_failed" == true && "$rc" -eq 0 ]] && rc=90; exit "$rc"; }
trap cleanup EXIT

[[ -s "$control" && -d "$cache" && -s "$token" ]] || exit 20
[[ ! -e "$gate" ]] || { echo CF_PHASE5_LIVE_PREFLIGHT_GATE=present >&2; exit 21; }
python3 - "$control" <<'PY'
import json,sys
d=json.load(open(sys.argv[1])); a=d["authority"]; g=a["productionGuard"]; v=a["planes"]["vps-fabric"]
assert d["controlRevision"]==558
assert d["lease"]["state"]=="FREE"
assert a["productionEpoch"]==29
assert a["mode"]=="VPS_PRODUCTION" and a["materialAuthority"]=="vps-fabric"
assert a["reconciliationHold"]["active"] is False
assert v["ingress"]=="ADMITTED" and v["materialEffectsAllowed"] is True
assert v["releaseSequence"]==74 and v["releaseId"]=="onshape-vps-hardened-r9"
assert v["manifestSha256"]=="5abb7ec2ba3525f3f1e3cf535323106436b42d264150fb20c911b221ef3af7a3"
assert g["schema"]=="capability-fabric.onshape-production-guard.v1"
assert g["killSwitch"]=="ENGAGED" and g["allowedDocumentIds"]==[] and g["mutationBudget"]["maxMutations"]==0
print("CF_PHASE5_LIVE_PREFLIGHT_AUTHORITY=pass")
PY
for c in "$prod_server" "$prod_fabric" "$prod_gateway"; do
  [[ "$(docker inspect -f '{{.State.Running}}' "$c" 2>/dev/null || echo false)" == true ]] || exit 22
  [[ "$(docker inspect -f '{{.State.Health.Status}}' "$c" 2>/dev/null || echo unhealthy)" == healthy ]] || exit 22
done
gateway_was_running=true
systemctl is-active --quiet "$timer" && timer_was_active=true || true

prod_pool="$(docker exec -i "$prod_server" sh -lc 'cd /tmp/app && node --input-type=module' <<'NODE'
import fs from "node:fs";
import {Client} from "@modelcontextprotocol/sdk/client/index.js";
import {StreamableHTTPClientTransport} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
const token=fs.readFileSync("/run/secrets/mcp-token","utf8").trim();
const c=new Client({name:"phase5-live-preflight",version:"1"});
await c.connect(new StreamableHTTPClientTransport(new URL("http://127.0.0.1:8788/mcp/"+token)));
const r=await c.callTool({name:"onshape_pool_status",arguments:{}},undefined,{timeout:180000});
console.log((r.content||[]).filter(x=>x.type==="text").map(x=>x.text||"").join("\n"));
await c.close();
NODE
)"
python3 - "$prod_pool" <<'PY'
import json,sys
p=json.loads(sys.argv[1])
assert p["pool_enabled"] is True and p["size"]==5 and p["warming"] is False
assert p["navigation_concurrency_limit"]==2
assert p["active_count"]==0 and p["queued_count"]==0 and p["document_lock_count"]==0 and p["workflow_lease_count"]==0
assert p["session_fingerprints_distinct"] is True
assert len(p["sessions"])==5 and all(s["auth"]["state"]=="PROVEN" and s["auth"]["http_status"]==200 for s in p["sessions"])
assert len({s["auth"]["account_id"] for s in p["sessions"]})==1
print("CF_PHASE5_LIVE_PREFLIGHT_POOL=5of5-PROVEN-idle")
PY

docker exec -i "$prod_fabric" python - <<'PY'
from capability_fabric.persistence import SqliteExecutionStateStore
with SqliteExecutionStateStore("/fabric-state/execution.sqlite3") as state:
    rows=state.recoverable()
    assert not rows, rows
print("CF_PHASE5_LIVE_PREFLIGHT_RECOVERABLE=zero")
PY

exec 9>"$lock"
flock -w 30 9 || { echo CF_PHASE5_LIVE_SHARED_LOCK=busy >&2; exit 23; }
printf '%s\n' RELEASE_IN_PROGRESS > "$gate"
chmod 0600 "$gate"
systemctl stop "$timer" >/dev/null 2>&1 || true
docker stop "$prod_gateway" "$prod_fabric" "$prod_server" >/dev/null
maintenance=true
echo CF_PHASE5_LIVE_MAINTENANCE=fail-closed

tmp="$(mktemp -d /var/lib/capability-fabric/.phase5-live.XXXXXX)"
mkdir -p "$tmp/release"
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
[[ "$(git --git-dir="$cache" rev-parse FETCH_HEAD)" == "$candidate" ]] || exit 24
git --git-dir="$cache" archive "$candidate" | tar -x -C "$tmp/release"
release="$tmp/release/server-deploy/current"
[[ -s "$release/manifest.json" && -s "$release/server.js" && -s "$release/fabric-agent.js" ]] || exit 25
manifest_sha="$(sha256sum "$release/manifest.json" | awk '{print $1}')"
[[ "$manifest_sha" == "5abb7ec2ba3525f3f1e3cf535323106436b42d264150fb20c911b221ef3af7a3" ]] || { echo CF_PHASE5_LIVE_MANIFEST_IDENTITY=unexpected >&2; exit 26; }
printf '%s\n' "$manifest_sha" > "$release/manifest.sha256"
echo CF_PHASE5_LIVE_CANDIDATE_FETCH=pass

rm -rf "$root"
mkdir -p "$root"/{profile,agent-state,fabric-state,control,lab-state}
chmod 0700 "$root" "$root"/*
python3 - "$control" "$root/control/ONSHAPE_RUNTIME_CONTROL.json" "$fixture" <<'PY'
import copy,json,sys
src,dst,fixture=sys.argv[1:]
did,wid,eid=fixture.split(":")
d=json.load(open(src)); d=copy.deepcopy(d)
d["controlRevision"]=d["controlRevision"]+1000000
d["updatedAt"]="2026-09-28T00:00:00.000Z"
d["authority"]["productionGuard"]={
  "schema":"capability-fabric.onshape-production-guard.v2",
  "generation":1000012,
  "killSwitch":"OPEN",
  "grants":[{
    "grantId":"phase5-copy-source",
    "workItem":"phase5-copy",
    "documentId":did,
    "state":"ACTIVE",
    "mutationBudget":{"budgetId":"phase5-copy-budget2","maxMutations":2},
  }],
}
with open(dst,"w") as f: json.dump(d,f,indent=2,sort_keys=False); f.write("\n")
PY
chmod 0600 "$root/control/ONSHAPE_RUNTIME_CONTROL.json"

docker rm -f "$lab_server" "$lab_fabric" >/dev/null 2>&1 || true
docker run -d --name "$lab_server" --network host --ipc host --memory 5g --cpus 4 \
  --cap-drop ALL --security-opt no-new-privileges --read-only --tmpfs /tmp:rw,exec,nosuid,nodev,size=5g \
  -e HOST=127.0.0.1 -e PORT=8788 -e CF_DIAGNOSTIC_PORT=8789 -e CF_FABRIC_SIDECAR_URL=http://127.0.0.1:8791 \
  -e CF_FABRIC_AGENT_STATE_DIR=/agent-state -e CF_ONSHAPE_RUNTIME_CONTROL_FILE=/run/cf-authority/ONSHAPE_RUNTIME_CONTROL.json \
  -e CF_FABRIC_REQUIRE_PRODUCTION_AUTHORITY=1 -e CF_PRIVILEGED_NATIVE_ENABLED=0 -e CF_PUBLIC_SURFACE=semantic-only \
  -e MCP_TOKEN_FILE=/run/secrets/mcp-token -e ONSHAPE_PROFILE_DIR=/profile \
  -e ONSHAPE_ACCOUNT_FILE=/run/onshape-secrets/account -e ONSHAPE_PASSWORD_FILE=/run/onshape-secrets/password \
  -e ONSHAPE_COMPANY_OWNER_ID=64a4114074132e1ea68137a8 -e ONSHAPE_ANTI_FORGERY_HEADER_NAME=x-xsrf-token \
  -e ONSHAPE_UI_API_VERSION=v14 -e ONSHAPE_OPENAPI_FILE=/openapi/onshape-openapi.json -e ONSHAPE_POOL_SIZE=5 \
  -e ONSHAPE_POOL_MULTI_MUTATOR_ENABLED=1 -e ONSHAPE_POOL_TMP_ROOT=/tmp/onshape-session-pool-phase5 \
  -e ONSHAPE_POOL_LEASE_STATE_FILE=/agent-state/workflow-leases.json -e ONSHAPE_POOL_MAX_CONCURRENT_NAVIGATIONS=2 \
  -e CF_RELEASE_GATE_FILE=/run/lab-state/release-in-progress -e HOME=/tmp -e NPM_CONFIG_CACHE=/tmp/npm-cache -e PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
  -v "$release:/release:ro" -v /etc/capability-fabric/secrets/mcp-token:/run/secrets/mcp-token:ro \
  -v /etc/capability-fabric/secrets/onshape:/run/onshape-secrets:rw -v "$root/profile:/profile:rw" \
  -v /var/lib/capability-fabric/onshape/openapi:/openapi:ro -v "$root/agent-state:/agent-state:rw" \
  -v "$root/control:/run/cf-authority:ro" -v "$root/lab-state:/run/lab-state:ro" \
  "$node_image" sh -lc 'mkdir -p /tmp/app && cp /release/package.json /release/server.js /release/core.js /release/browser.js /release/session-pool.js /release/onshape-request.cjs /release/fabric-agent.js /release/telegram-ingress.mjs /tmp/app/ && cd /tmp/app && npm install --omit=dev --ignore-scripts --no-audit --no-fund --package-lock=false && exec node server.js' >/dev/null
wait_text http://127.0.0.1:8788/ "cf-onshape-single ok" 180 || { docker logs --tail 150 "$lab_server" >&2; exit 30; }

docker run -d --name "$lab_fabric" --network host --cap-drop ALL --security-opt no-new-privileges --read-only --tmpfs /tmp:rw,nosuid,nodev,size=512m \
  -e HOST=127.0.0.1 -e PORT=8791 -e PYTHONPATH=/release/fabric-src -e PYTHONDONTWRITEBYTECODE=1 -e PYTHONUNBUFFERED=1 -e HOME=/tmp \
  -e MCP_TOKEN_FILE=/run/secrets/mcp-token -e CF_FABRIC_POLICY_FILE=/release/fabric-policy/semantic-enforcement.v1.json \
  -e CF_FABRIC_STATE_DB=/fabric-state/execution.sqlite3 -e CF_FABRIC_PROJECT_STATE_REVISION=phase5-live-45b1cedb5b00 \
  -e CF_FABRIC_QUALIFICATION_MODE=1 -e CF_FABRIC_REQUIRE_PRODUCTION_AUTHORITY=1 \
  -e CF_ONSHAPE_RUNTIME_CONTROL_FILE=/run/cf-authority/ONSHAPE_RUNTIME_CONTROL.json \
  -v "$release/fabric-src:/release/fabric-src:ro" -v "$release/fabric-policy:/release/fabric-policy:ro" \
  -v /etc/capability-fabric/secrets/mcp-token:/run/secrets/mcp-token:ro -v "$root/fabric-state:/fabric-state:rw" \
  -v "$root/control:/run/cf-authority:ro" "$py_image" python -m capability_fabric.onshape_vps_sidecar >/dev/null
wait_json http://127.0.0.1:8791/ 90 || { docker logs --tail 150 "$lab_fabric" >&2; exit 31; }
echo CF_PHASE5_LIVE_LAB=started

client="server-bootstrap/helpers/300-onshape-session-pool-phase5-live-client.mjs"
create_out="$(docker exec -e CF_PHASE=create -e CF_FIXTURE="$fixture" -i "$lab_server" sh -lc 'cd /tmp/app && node --input-type=module' < "$client")"
printf '%s\n' "$create_out"
create_json="$(printf '%s\n' "$create_out" | tail -n1)"
read -r doc_a wid_a doc_b wid_b < <(python3 - "$create_json" <<'PY'
import json,sys
x=json.loads(sys.argv[1]); assert x["ok"] and x["phase"]=="create" and len(x["copies"])==2
a,b=x["copies"]
for row in (a,b):
  assert len(row["documentId"])==24 and len(row["workspaceId"])==24
print(a["documentId"],a["workspaceId"],b["documentId"],b["workspaceId"])
PY
)
[[ "$doc_a" != "$doc_b" ]]
echo "CF_PHASE5_LIVE_DISPOSABLE_DOCS=$doc_a,$doc_b"

python3 - "$root/control/ONSHAPE_RUNTIME_CONTROL.json" "$doc_a" "$doc_b" <<'PY'
import json,os,sys,tempfile
p,a,b=sys.argv[1:]
d=json.load(open(p)); g=d["authority"]["productionGuard"]; g["generation"]+=1
g["grants"]=[
 {"grantId":"phase5-A","workItem":"phase5-A","documentId":a,"state":"ACTIVE","mutationBudget":{"budgetId":"phase5-A-budget3","maxMutations":3}},
 {"grantId":"phase5-B","workItem":"phase5-B","documentId":b,"state":"ACTIVE","mutationBudget":{"budgetId":"phase5-B-budget3","maxMutations":3}},
 {"grantId":"phase5-C","workItem":"phase5-C","documentId":a,"state":"ACTIVE","mutationBudget":{"budgetId":"phase5-C-budget1","maxMutations":1}},
 {"grantId":"phase5-ack","workItem":"phase5-ack","documentId":a,"state":"ACTIVE","mutationBudget":{"budgetId":"phase5-ack-budget1","maxMutations":1}},
 {"grantId":"phase5-restart","workItem":"phase5-restart","documentId":b,"state":"ACTIVE","mutationBudget":{"budgetId":"phase5-restart-budget1","maxMutations":1}},
]
fd,tmp=tempfile.mkstemp(dir=os.path.dirname(p)); os.close(fd)
with open(tmp,"w") as f: json.dump(d,f,indent=2); f.write("\n")
os.chmod(tmp,0o600); os.replace(tmp,p)
PY

exercise_log="$root/exercise.log"
docker exec -e CF_PHASE=exercise -e CF_FIXTURE="$fixture" -e CF_DOC_A="$doc_a" -e CF_WID_A="$wid_a" -e CF_DOC_B="$doc_b" -e CF_WID_B="$wid_b" -i "$lab_server" sh -lc 'cd /tmp/app && node --input-type=module' < "$client" >"$exercise_log" 2>&1 &
exercise_pid=$!
sample=0
while kill -0 "$exercise_pid" 2>/dev/null; do
  sample=$((sample+1))
  echo "CF_PHASE5_LIVE_RESOURCE_SAMPLE_$sample=$(docker stats --no-stream --format '{{.CPUPerc}}|{{.MemUsage}}|{{.MemPerc}}|{{.PIDs}}' "$lab_server" 2>/dev/null || true)"
  awk -v i="$sample" '/^(MemAvailable|SwapFree):/ {gsub(/:/,"",$1); print "CF_PHASE5_LIVE_HOST_"i"_"$1"_KIB="$2}' /proc/meminfo
  sleep 1
done
wait "$exercise_pid"
cat "$exercise_log"
exercise_json="$(tail -n1 "$exercise_log")"
python3 - "$exercise_json" <<'PY'
import json,sys
x=json.loads(sys.argv[1])
assert x["ok"] and x["phase"]=="exercise"
assert len(x["slots"])==2 and len({r["session_id"] for r in x["slots"]})==2
assert x["same_document_competitor_blocked"] is True
assert len(x["different_document_mutations"])==2
assert x["nav_limit"]==2 and x["auth_proven"]==5
print("CF_PHASE5_LIVE_DIFFERENT_DOCS=pass")
print("CF_PHASE5_LIVE_SAME_DOC_FENCE=pass")
print("CF_PHASE5_LIVE_NAV_LIMIT=2")
PY

ack_out="$(docker exec -e CF_PHASE=ackloss -e CF_FIXTURE="$fixture" -e CF_DOC_A="$doc_a" -e CF_WID_A="$wid_a" -e CF_DOC_B="$doc_b" -e CF_WID_B="$wid_b" -i "$lab_server" sh -lc 'cd /tmp/app && node --input-type=module' < "$client")"
printf '%s\n' "$ack_out"
ack_json="$(printf '%s\n' "$ack_out" | tail -n1)"
python3 - "$ack_json" <<'PY'
import json,sys
x=json.loads(sys.argv[1]); assert x["ok"] and x["outcome"]=="IN_DOUBT" and x["reconciled"]=="ACHIEVED" and x["no_blind_retry"] is True
print("CF_PHASE5_LIVE_ACK_LOSS=pass")
PY

restart_out="$(docker exec -e CF_PHASE=restart-acquire -e CF_FIXTURE="$fixture" -e CF_DOC_A="$doc_a" -e CF_WID_A="$wid_a" -e CF_DOC_B="$doc_b" -e CF_WID_B="$wid_b" -i "$lab_server" sh -lc 'cd /tmp/app && node --input-type=module' < "$client")"
printf '%s\n' "$restart_out"
restart_json="$(printf '%s\n' "$restart_out" | tail -n1)"
read -r restart_ctx restart_attempt < <(python3 - "$restart_json" <<'PY'
import json,sys
x=json.loads(sys.argv[1]); assert x["ok"] and x["phase"]=="restart-acquire"
print(x["contextId"],x["attemptId"])
PY
)
docker restart "$lab_server" >/dev/null
wait_text http://127.0.0.1:8788/ "cf-onshape-single ok" 180 || { docker logs --tail 150 "$lab_server" >&2; exit 40; }
restart_rec_out="$(docker exec -e CF_PHASE=restart-reconcile -e CF_FIXTURE="$fixture" -e CF_DOC_A="$doc_a" -e CF_WID_A="$wid_a" -e CF_DOC_B="$doc_b" -e CF_WID_B="$wid_b" -e CF_RESTART_CONTEXT="$restart_ctx" -e CF_RESTART_ATTEMPT="$restart_attempt" -i "$lab_server" sh -lc 'cd /tmp/app && node --input-type=module' < "$client")"
printf '%s\n' "$restart_rec_out"
restart_rec_json="$(printf '%s\n' "$restart_rec_out" | tail -n1)"
python3 - "$restart_rec_json" <<'PY'
import json,sys
x=json.loads(sys.argv[1]); assert x["ok"] and x["restart_uncertain"] and x["competing_context_blocked"] and x["same_attempt_reconciled"]
print("CF_PHASE5_LIVE_RESTART_FENCE=pass")
PY

docker exec -i "$lab_fabric" python - <<'PY'
from capability_fabric.persistence import SqliteExecutionStateStore
with SqliteExecutionStateStore("/fabric-state/execution.sqlite3") as state:
    rows=state.recoverable()
    assert not rows, rows
print("CF_PHASE5_LIVE_RECOVERABLE=zero")
PY

final_pool="$(docker exec -i "$lab_server" sh -lc 'cd /tmp/app && node --input-type=module' <<'NODE'
import fs from "node:fs";
import {Client} from "@modelcontextprotocol/sdk/client/index.js";
import {StreamableHTTPClientTransport} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
const token=fs.readFileSync("/run/secrets/mcp-token","utf8").trim();
const c=new Client({name:"phase5-final-pool",version:"1"});
await c.connect(new StreamableHTTPClientTransport(new URL("http://127.0.0.1:8788/mcp/"+token)));
const r=await c.callTool({name:"onshape_pool_status",arguments:{}},undefined,{timeout:180000});
console.log((r.content||[]).filter(x=>x.type==="text").map(x=>x.text||"").join("\n"));
await c.close();
NODE
)"
python3 - "$final_pool" <<'PY'
import json,sys
p=json.loads(sys.argv[1])
assert p["pool_enabled"] is True and p["size"]==5 and p["multi_mutator_enabled"] is True
assert p["navigation_concurrency_limit"]==2 and p["workflow_lease_count"]==0
assert p["active_count"]==0 and p["queued_count"]==0 and p["document_lock_count"]==0
assert p["session_fingerprints_distinct"] is True
assert len(p["sessions"])==5 and all(s["auth"]["state"]=="PROVEN" and s["auth"]["http_status"]==200 for s in p["sessions"])
assert len({s["auth"]["account_id"] for s in p["sessions"]})==1
print("CF_PHASE5_LIVE_FINAL_POOL=5of5-PROVEN-idle")
PY

flock -u 9
echo CF_PHASE5_LIVE_TEST=pass
