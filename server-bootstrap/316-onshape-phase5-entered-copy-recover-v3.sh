#!/usr/bin/env bash
set -euo pipefail
umask 077
[[ "$(id -u)" -eq 0 ]] || { echo CF_PHASE5_RECOVERY_ROOT=required >&2; exit 2; }

candidate="30586532eb81f91d63701088518d3ccb0e6e8688"
expected_manifest="5abb7ec2ba3525f3f1e3cf535323106436b42d264150fb20c911b221ef3af7a3"
root="/var/lib/capability-fabric/onshape-session-pool-phase5-lab"
marker="$root/agent-state/phase5-live-unresolved.json"
db="$root/fabric-state/execution.sqlite3"
lease_file="$root/agent-state/workflow-leases.json"
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
node_image="mcr.microsoft.com/playwright:v1.62.1-resolute@sha256:aebd85bce8056dcdc2269853fd94ea432b6a201da4f0ef125b509489ecd52ddb"
py_image="python:3.12-slim-bookworm@sha256:392307d22300de8b5986851a12d9176dfc0fc073e65bf6523ebd7dcbeb23564e"

maintenance=false
gateway_was_running=false
timer_was_active=false
restore_failed=false
retire_lab=false
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
  if [[ "$restore_failed" == false && "$retire_lab" == true ]]; then
    rm -rf "$root" >/dev/null 2>&1 || restore_failed=true
  fi
  if [[ "$restore_failed" == false ]]; then
    echo CF_PHASE5_RECOVERY_RESTORE=production-green
    [[ "$retire_lab" == true ]] && echo CF_PHASE5_RECOVERY_LAB=retired
  else
    echo CF_PHASE5_RECOVERY_RESTORE=failed >&2
    [[ -d "$root" ]] && echo "CF_PHASE5_RECOVERY_STATE_PRESERVED=$root" >&2
  fi
  set -e
}
cleanup(){ rc=$?; [[ "$maintenance" == true ]] && restore || true; [[ "$restore_failed" == true && "$rc" -eq 0 ]] && rc=90; exit "$rc"; }
trap cleanup EXIT

[[ -s "$control" && -d "$cache" && -s "$token" ]] || exit 20
[[ -s "$marker" && -s "$db" && -s "$lease_file" ]] || { echo CF_PHASE5_RECOVERY_PRESERVED_STATE=missing >&2; exit 21; }
[[ ! -e "$gate" ]] || { echo CF_PHASE5_RECOVERY_GATE=present >&2; exit 22; }

read -r expected_attempt expected_context < <(python3 - "$marker" "$lease_file" "$db" "$root/agent-state" <<'PY'
import hashlib,json,os,re,sqlite3,sys
marker_path,lease_path,db,agent_dir=sys.argv[1:]
m=json.load(open(marker_path))
assert m.get("phase")=="create-copyWorkspace",m
attempt=str(m.get("attemptId") or "")
context=str(m.get("executionContextId") or "")
assert attempt.startswith("attempt:"),m
assert re.fullmatch(r"ctx_[0-9a-f]{32}",context),m
assert str(m.get("expectedName") or "").startswith("CF Phase5 Disposable A "),m
assert m.get("workItem")=="phase5-copy",m
leases=json.load(open(lease_path)).get("leases") or []
assert len(leases)==1,leases
lease=leases[0]
assert lease.get("lease_id")==context,lease
assert lease.get("effect")=="MATERIAL" and lease.get("state")=="UNCERTAIN",lease
acq=str(lease.get("acquired_by_attempt_id") or lease.get("attempt_id") or "")
last=str(lease.get("last_attempt_id") or lease.get("attempt_id") or lease.get("acquired_by_attempt_id") or "")
assert last==attempt and last!=acq,lease
con=sqlite3.connect("file:"+db+"?mode=ro",uri=True)
con.row_factory=sqlite3.Row
assert con.execute("PRAGMA integrity_check").fetchone()[0]=="ok"
rows=con.execute("""
SELECT i.phase,o.state AS operation_state,o.outcome_payload,
       a.attempt_id,a.state AS attempt_state,a.observation_payload
FROM invocations i
JOIN operations o ON o.invocation_id=i.invocation_id
JOIN attempts a ON a.operation_id=o.operation_id
WHERE a.attempt_id=?
""",(attempt,)).fetchall()
assert len(rows)==1,rows
r=rows[0]
assert r["operation_state"]=="IN_FLIGHT",dict(r)
assert r["outcome_payload"] is None,dict(r)
assert r["attempt_state"] in ("DISPATCH_INTENT","OBSERVED"),dict(r)
h=hashlib.sha256(attempt.encode()).hexdigest()
p=os.path.join(agent_dir,h+".json")
assert os.path.isfile(p),p
agent=json.load(open(p))
assert agent.get("state")=="SUCCEEDED",agent
obs=agent.get("observation") or {}
ev=obs.get("evidence") or {}
assert obs.get("state")=="SUCCEEDED",agent
assert ev.get("effectSent") is True,agent
assert ev.get("postconditionVerified") is not True,agent
assert (ev.get("verification") or {}).get("kind")=="workspace_copy_created",agent
assert bool(agent.get("budgetReservation")) is True,agent
print(attempt,context)
con.close()
PY
)
[[ "$expected_attempt" == attempt:* && "$expected_context" == ctx_* ]]
echo CF_PHASE5_RECOVERY_PREFLIGHT_PRESERVED=unique-exact
echo CF_PHASE5_ENTERED_RECOVERY_PREFLIGHT_LEASE_ORDER=entered-effect
python3 - "$control" <<'PY'
import json,sys
d=json.load(open(sys.argv[1])); a=d["authority"]; g=a["productionGuard"]; v=a["planes"]["vps-fabric"]
assert d["controlRevision"]==558
assert d["lease"]["state"]=="FREE"
assert a["productionEpoch"]==29 and a["mode"]=="VPS_PRODUCTION" and a["materialAuthority"]=="vps-fabric"
assert a["reconciliationHold"]["active"] is False
assert v["ingress"]=="ADMITTED" and v["materialEffectsAllowed"] is True
assert v["releaseSequence"]==74 and v["releaseId"]=="onshape-vps-hardened-r9"
assert v["manifestSha256"]=="5abb7ec2ba3525f3f1e3cf535323106436b42d264150fb20c911b221ef3af7a3"
assert g["schema"]=="capability-fabric.onshape-production-guard.v1"
assert g["killSwitch"]=="ENGAGED" and g["allowedDocumentIds"]==[] and g["mutationBudget"]["maxMutations"]==0
print("CF_PHASE5_RECOVERY_PREFLIGHT_AUTHORITY=pass")
PY

for c in "$prod_server" "$prod_fabric" "$prod_gateway"; do
  [[ "$(docker inspect -f '{{.State.Running}}' "$c" 2>/dev/null || echo false)" == true ]] || exit 23
  [[ "$(docker inspect -f '{{.State.Health.Status}}' "$c" 2>/dev/null || echo unhealthy)" == healthy ]] || exit 23
done
gateway_was_running=true
systemctl is-active --quiet "$timer" && timer_was_active=true || true

prod_pool="$(docker exec -i "$prod_server" sh -lc 'cd /tmp/app && node --input-type=module' <<'NODE'
import fs from "node:fs";
import {Client} from "@modelcontextprotocol/sdk/client/index.js";
import {StreamableHTTPClientTransport} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
const token=fs.readFileSync("/run/secrets/mcp-token","utf8").trim();
const c=new Client({name:"phase5-recovery-preflight",version:"1"});
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
assert p["navigation_limit"]==2
assert p["active_count"]==0 and p["queued_count"]==0 and p["document_lock_count"]==0 and p["workflow_lease_count"]==0
assert p["session_fingerprints_distinct"] is True
assert len(p["sessions"])==5 and all(s["auth"]["state"]=="PROVEN" and s["auth"]["http_status"]==200 for s in p["sessions"])
assert len({s["auth"]["account_id"] for s in p["sessions"]})==1
print("CF_PHASE5_RECOVERY_PREFLIGHT_POOL=5of5-PROVEN-idle")
PY
docker exec -i "$prod_fabric" python - <<'PY'
from capability_fabric.persistence import SqliteExecutionStateStore
with SqliteExecutionStateStore("/fabric-state/execution.sqlite3") as state:
    rows=state.recoverable()
    assert not rows, rows
print("CF_PHASE5_RECOVERY_PREFLIGHT_PROD_RECOVERABLE=zero")
PY

exec 9>"$lock"
flock -w 30 9 || { echo CF_PHASE5_RECOVERY_SHARED_LOCK=busy >&2; exit 24; }
printf '%s\n' RELEASE_IN_PROGRESS > "$gate"
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
  *Username*) printf '%s\n' x-access-token ;;
  *Password*) cat /etc/capability-fabric/secrets/repo-read-token ;;
  *) exit 1 ;;
esac
ASK
chmod 0700 "$ask"
GIT_ASKPASS="$ask" GIT_TERMINAL_PROMPT=0 HOME="$git_home" git --git-dir="$cache" fetch --quiet --force --depth=1 origin "$candidate"
[[ "$(git --git-dir="$cache" rev-parse FETCH_HEAD)" == "$candidate" ]] || exit 25
git --git-dir="$cache" archive "$candidate" | tar -x -C "$tmp/release"
release="$tmp/release/server-deploy/current"
[[ -s "$release/manifest.json" && -s "$release/server.js" && -s "$release/fabric-agent.js" ]] || exit 26
manifest_sha="$(sha256sum "$release/manifest.json" | awk '{print $1}')"
[[ "$manifest_sha" == "$expected_manifest" ]] || { echo CF_PHASE5_RECOVERY_MANIFEST_IDENTITY=unexpected >&2; exit 27; }
printf '%s\n' "$manifest_sha" > "$release/manifest.sha256"
echo CF_PHASE5_RECOVERY_CANDIDATE_FETCH=pass

docker rm -f "$lab_server" "$lab_fabric" >/dev/null 2>&1 || true
docker run -d --name "$lab_server" --network host --ipc host --memory 5g --cpus 4 \
  --cap-drop ALL --security-opt no-new-privileges --read-only --tmpfs /tmp:rw,exec,nosuid,nodev,size=5g \
  -e HOST=127.0.0.1 -e PORT=8788 -e CF_DIAGNOSTIC_PORT=8789 -e CF_FABRIC_SIDECAR_URL=http://127.0.0.1:8791 \
  -e CF_FABRIC_AGENT_STATE_DIR=/agent-state -e CF_ONSHAPE_RUNTIME_CONTROL_FILE=/run/cf-authority/ONSHAPE_RUNTIME_CONTROL.json \
  -e CF_FABRIC_REQUIRE_PRODUCTION_AUTHORITY=1 -e CF_FABRIC_QUALIFICATION_MODE=1 -e CF_PRIVILEGED_NATIVE_ENABLED=0 -e CF_PUBLIC_SURFACE=semantic-only \
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

reserved_session="$(python3 - "$lease_file" "$expected_context" <<'PY'
import json,re,sys
p,context=sys.argv[1:]
leases=json.load(open(p)).get("leases") or []
x=next((x for x in leases if x.get("lease_id")==context),None)
assert x is not None,x
sid=str(x.get("session_id") or "")
assert re.fullmatch(r"session-[1-5]",sid),x
print(sid)
PY
)"
docker exec -e CF_RESERVED_SESSION="$reserved_session" -i "$lab_server" sh -lc 'cd /tmp/app && node --input-type=module' <<'NODE'
import fs from "node:fs";
import {Client} from "@modelcontextprotocol/sdk/client/index.js";
import {StreamableHTTPClientTransport} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
const token=fs.readFileSync("/run/secrets/mcp-token","utf8").trim();
const reserved=String(process.env.CF_RESERVED_SESSION||"");
const c=new Client({name:"phase5-entered-recovery-auth",version:"1"});
await c.connect(new StreamableHTTPClientTransport(new URL("http://127.0.0.1:8788/mcp/"+token)));
const parse=r=>JSON.parse((r.content||[]).filter(x=>x.type==="text").map(x=>x.text||"").join("\n"));
const call=async(name,args={})=>parse(await c.callTool({name,arguments:args},undefined,{timeout:180000}));
const proven=s=>s?.auth?.state==="PROVEN" && s?.auth?.http_status===200;
const status=()=>call("onshape_pool_status");
try {
  let p=await status();
  let s=(p.sessions||[]).find(x=>x.session_id===reserved);
  if(!s) throw new Error("reserved session missing");
  if(!proven(s)){
    const started=await call("onshape_pool_session_reauth",{session_id:reserved});
    const op=String(started.operation_id||"");
    if(!op) throw new Error("missing recovery reauth operation");
    let terminal=null;
    for(let i=0;i<180;i++){
      const state=await call("onshape_operation_status",{operation_id:op});
      if(["SUCCEEDED","FAILED","AWAITING_INPUT"].includes(state.status)){terminal=state;break;}
      await new Promise(r=>setTimeout(r,1000));
    }
    if(!terminal) throw new Error("recovery reauth timeout");
    if(terminal.status==="AWAITING_INPUT") throw new Error("verification input required for reserved recovery session");
    if(terminal.status!=="SUCCEEDED") throw new Error("recovery reauth failed "+JSON.stringify(terminal.error||terminal));
    p=await status();
    s=(p.sessions||[]).find(x=>x.session_id===reserved);
  }
  if(!proven(s)) throw new Error("reserved recovery session is not PROVEN");
  const lease=(p.workflow_leases||[]).find(x=>x.session_id===reserved && x.state==="UNCERTAIN" && x.effect==="MATERIAL");
  if(!lease) throw new Error("uncertain recovery fence missing after auth repair");
  console.log("CF_PHASE5_ENTERED_RECOVERY_AUTH=reserved-PROVEN-fence-preserved");
} finally {
  await c.close().catch(()=>{});
}
NODE

python3 - "$lease_file" "$expected_attempt" "$expected_context" <<'PY'
import json,sys
p,attempt,context=sys.argv[1:]
leases=json.load(open(p)).get("leases") or []
assert len(leases)==1,leases
x=leases[0]
assert x.get("lease_id")==context and x.get("effect")=="MATERIAL" and x.get("state")=="UNCERTAIN",x
acq=str(x.get("acquired_by_attempt_id") or x.get("attempt_id") or "")
last=str(x.get("last_attempt_id") or x.get("attempt_id") or x.get("acquired_by_attempt_id") or "")
assert last==attempt and last!=acq,x
print("CF_PHASE5_ENTERED_RECOVERY_RESTART_FENCE=UNCERTAIN-exact-attempt")
PY

docker run -d --name "$lab_fabric" --network host --cap-drop ALL --security-opt no-new-privileges --read-only --tmpfs /tmp:rw,nosuid,nodev,size=512m \
  -e HOST=127.0.0.1 -e PORT=8791 -e PYTHONPATH=/release/fabric-src -e PYTHONDONTWRITEBYTECODE=1 -e PYTHONUNBUFFERED=1 -e HOME=/tmp \
  -e MCP_TOKEN_FILE=/run/secrets/mcp-token -e CF_FABRIC_POLICY_FILE=/release/fabric-policy/semantic-enforcement.v1.json \
  -e CF_FABRIC_STATE_DB=/fabric-state/execution.sqlite3 -e CF_FABRIC_PROJECT_STATE_REVISION=phase5-entered-recovery-30586532eb81 \
  -e CF_FABRIC_QUALIFICATION_MODE=1 -e CF_FABRIC_REQUIRE_PRODUCTION_AUTHORITY=1 \
  -e CF_ONSHAPE_RUNTIME_CONTROL_FILE=/run/cf-authority/ONSHAPE_RUNTIME_CONTROL.json \
  -v "$release/fabric-src:/release/fabric-src:ro" -v "$release/fabric-policy:/release/fabric-policy:ro" \
  -v /etc/capability-fabric/secrets/mcp-token:/run/secrets/mcp-token:ro -v "$root/fabric-state:/fabric-state:rw" \
  -v "$root/control:/run/cf-authority:ro" "$py_image" python -m capability_fabric.onshape_vps_sidecar >/dev/null
wait_json http://127.0.0.1:8791/ 90 || { docker logs --tail 150 "$lab_fabric" >&2; exit 31; }
echo CF_PHASE5_RECOVERY_LAB=started-preserved-state

reconcile_out="$(docker exec -e CF_EXPECTED_ATTEMPT="$expected_attempt" -i "$lab_server" sh -lc 'cd /tmp/app && node --input-type=module' <<'NODE'
import fs from "node:fs";
import {Client} from "@modelcontextprotocol/sdk/client/index.js";
import {StreamableHTTPClientTransport} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
const token=fs.readFileSync("/run/secrets/mcp-token","utf8").trim();
const attempt=String(process.env.CF_EXPECTED_ATTEMPT||"");
const c=new Client({name:"phase5-preserved-attempt-recovery",version:"1"});
await c.connect(new StreamableHTTPClientTransport(new URL("http://127.0.0.1:8788/mcp/"+token)));
const r=await c.callTool({name:"onshape_fabric_reconcile",arguments:{attempt_id:attempt}},undefined,{timeout:240000});
const raw=(r.content||[]).filter(x=>x.type==="text").map(x=>x.text||"").join("\n");
console.log(raw);
await c.close();
NODE
)"
printf '%s\n' "$reconcile_out"
python3 - "$reconcile_out" "$expected_attempt" "$expected_context" <<'PY'
import json,sys
raw,attempt,context=sys.argv[1:]
outer=json.loads(raw)
r=outer.get("result") or {}
assert r.get("attemptId")==attempt,r
outcome=r.get("outcome",{}).get("state")
assert outcome in ("ACHIEVED","ABSENT"),r
assert r.get("sameAttempt") is True and r.get("reexecuted") is False,r
obs=r.get("observation") or {}
ev=obs.get("evidence") or {}
assert ev.get("effectSent") is True,r
assert ev.get("recoveryReadOnly") is True,r
if outcome=="ACHIEVED":
    assert obs.get("ackState")=="ACKNOWLEDGED",r
    assert ev.get("postconditionVerified") is True,r
    assert ev.get("postconditionAbsentVerified") is not True,r
else:
    assert obs.get("ackState")=="REJECTED",r
    assert ev.get("postconditionAbsentVerified") is True,r
resolution=r.get("contextResolution") or {}
assert resolution.get("contextId")==context and resolution.get("reconciled") is True,r
print("CF_PHASE5_ENTERED_RECOVERY_ATTEMPT="+outcome+"-same-attempt-no-replay")
print("CF_PHASE5_ENTERED_RECOVERY_READ_ONLY_PROOF=pass")
print("CF_PHASE5_ENTERED_RECOVERY_CONTEXT_RESOLUTION=pass")
PY

docker exec -i "$lab_fabric" python - "$expected_attempt" <<'PY'
import sys
from capability_fabric.persistence import SqliteExecutionStateStore
attempt=sys.argv[1]
with SqliteExecutionStateStore("/fabric-state/execution.sqlite3") as state:
    rows=state.recoverable()
    assert not rows, rows
print("CF_PHASE5_RECOVERY_RECOVERABLE=zero")
PY

python3 - "$db" "$root/agent-state" "$expected_attempt" "$expected_context" <<'PY'
import hashlib,json,os,sqlite3,sys
db,agent_dir,attempt,context=sys.argv[1:]
con=sqlite3.connect("file:"+db+"?mode=ro",uri=True)
con.row_factory=sqlite3.Row
r=con.execute("""
SELECT o.state AS operation_state,o.outcome_payload,a.state AS attempt_state
FROM operations o JOIN attempts a ON a.operation_id=o.operation_id
WHERE a.attempt_id=?
""",(attempt,)).fetchone()
assert r is not None
out=json.loads(r["outcome_payload"])
terminal=out.get("state")
assert terminal in ("ACHIEVED","ABSENT"),out
h=hashlib.sha256(attempt.encode()).hexdigest()
agent=json.load(open(os.path.join(agent_dir,h+".json")))
obs=agent.get("observation") or {}
e=obs.get("evidence") or {}
assert e.get("effectSent") is True,agent
assert e.get("recoveryReadOnly") is True,agent
if terminal=="ACHIEVED":
    assert agent.get("state")=="SUCCEEDED",agent
    assert e.get("postconditionVerified") is True,agent
else:
    assert agent.get("state")=="REJECTED",agent
    assert e.get("postconditionAbsentVerified") is True,agent
leases=json.load(open(os.path.join(agent_dir,"workflow-leases.json"))).get("leases") or []
assert all(x.get("lease_id")!=context for x in leases),leases
print("CF_PHASE5_ENTERED_RECOVERY_DURABLE_TERMINAL="+terminal)
print("CF_PHASE5_ENTERED_RECOVERY_FENCE_RELEASED=pass")
con.close()
PY

rm -f "$marker"
[[ ! -e "$marker" ]] || exit 40
retire_lab=true
echo CF_PHASE5_ENTERED_RECOVERY_MARKER=cleared-after-terminal-proof
echo CF_PHASE5_ENTERED_RECOVERY=pass
flock -u 9
