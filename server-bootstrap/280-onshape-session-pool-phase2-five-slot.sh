#!/usr/bin/env bash
set -euo pipefail
umask 077
[[ "$(id -u)" -eq 0 ]] || { echo CF_POOL_PHASE2_ROOT=required >&2; exit 2; }

candidate="774434bd3f442c7d8ec570e66f6620c59add3813"
fixture="a19e0fa5152af9f7ce106b6e:e5e7d0173fd1f1d0307a2cb6:e0929361aadb6135b5cecffa"
control="/var/lib/capability-fabric/onshape/runtime-control/ONSHAPE_RUNTIME_CONTROL.json"
gate="/var/lib/capability-fabric/state/release-in-progress"
lock="/run/lock/capability-fabric-pull.lock"
cache="/var/lib/capability-fabric/repo.git"
token="/etc/capability-fabric/secrets/repo-read-token"
git_home="/var/lib/capability-fabric/agent-home"
prod_server="capability-fabric-onshape-server"
prod_fabric="capability-fabric-onshape-fabric"
prod_gateway="capability-fabric-onshape-gateway"
lab="capability-fabric-onshape-session-pool-lab"
lab_root="/var/lib/capability-fabric/onshape-session-pool-lab"
image="mcr.microsoft.com/playwright:v1.62.1-resolute@sha256:aebd85bce8056dcdc2269853fd94ea432b6a201da4f0ef125b509489ecd52ddb"
gateway_was_running=false
maintenance_started=false
lab_started=false
restore_failed=false

wait_healthy() {
  local c="$1" max="${2:-90}"
  for _ in $(seq 1 "$max"); do
    local r h
    r="$(docker inspect -f '{{.State.Running}}' "$c" 2>/dev/null || echo false)"
    h="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$c" 2>/dev/null || echo missing)"
    if [[ "$r" == true && ( "$h" == healthy || "$h" == none ) ]]; then return 0; fi
    [[ "$h" == unhealthy ]] && return 1
    sleep 2
  done
  return 1
}

prod_pool_json() {
  docker exec -i "$prod_server" sh -lc 'cd /tmp/app && node --input-type=module' <<'NODE'
import fs from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
const token=fs.readFileSync("/run/secrets/mcp-token","utf8").trim();
const c=new Client({name:"cf-session-pool-phase2-prod-check",version:"1.0"});
await c.connect(new StreamableHTTPClientTransport(new URL("http://127.0.0.1:8788/mcp/"+token)));
const r=await c.callTool({name:"onshape_pool_status",arguments:{}},undefined,{timeout:180000});
const raw=(r.content||[]).filter(x=>x.type==="text").map(x=>x.text||"").join("\n");
console.log(raw);
await c.close().catch(()=>{});
NODE
}

restore_production() {
  set +e
  if [[ "$lab_started" == true ]]; then docker rm -f "$lab" >/dev/null 2>&1 || true; fi
  rm -rf "$lab_root" >/dev/null 2>&1 || true

  docker start "$prod_server" >/dev/null 2>&1 || true
  if ! wait_healthy "$prod_server" 90; then
    echo CF_POOL_PHASE2_RESTORE_SERVER=failed >&2
    restore_failed=true
  else
    echo CF_POOL_PHASE2_RESTORE_SERVER=healthy
  fi

  docker start "$prod_fabric" >/dev/null 2>&1 || true
  if ! wait_healthy "$prod_fabric" 90; then
    echo CF_POOL_PHASE2_RESTORE_FABRIC=failed >&2
    restore_failed=true
  else
    echo CF_POOL_PHASE2_RESTORE_FABRIC=healthy
  fi

  rm -f "$gate"
  echo CF_POOL_PHASE2_RESTORE_GATE=clear

  if [[ "$restore_failed" == false ]]; then
    for sid in session-1 session-2 session-3; do
      echo "CF_POOL_PHASE2_RESTORE_REAUTH_START=$sid"
      CF_REAUTH_SESSION_ID="$sid" bash server-bootstrap/101-onshape-production-session-reauth.sh
      rc=$?
      if (( rc == 42 )); then
        echo "CF_POOL_PHASE2_RESTORE_REAUTH_INPUT_REQUIRED=$sid"
        restore_failed=true
        break
      elif (( rc != 0 )); then
        echo "CF_POOL_PHASE2_RESTORE_REAUTH_FAILED=$sid:$rc"
        restore_failed=true
        break
      fi
      echo "CF_POOL_PHASE2_RESTORE_REAUTH_PASS=$sid"
    done
  fi

  if [[ "$gateway_was_running" == true ]]; then
    docker start "$prod_gateway" >/dev/null 2>&1 || true
    if wait_healthy "$prod_gateway" 60; then
      echo CF_POOL_PHASE2_RESTORE_GATEWAY=healthy
    else
      echo CF_POOL_PHASE2_RESTORE_GATEWAY=failed >&2
      restore_failed=true
    fi
  fi

  if [[ "$restore_failed" == false ]]; then
    local pj
    pj="$(prod_pool_json 2>/dev/null)"
    python3 - "$pj" <<'PY'
import json,sys
p=json.loads(sys.argv[1])
assert p.get("pool_enabled") is True
assert p.get("size")==3
assert p.get("active_count")==0
assert p.get("queued_count")==0
assert p.get("document_lock_count")==0
assert p.get("session_fingerprints_distinct") is True
ss=p.get("sessions") or []
assert len(ss)==3
assert all(x.get("auth",{}).get("state")=="PROVEN" and x.get("auth",{}).get("http_status")==200 for x in ss)
print("CF_POOL_PHASE2_RESTORE_POOL=3of3-PROVEN-idle")
PY
  fi
  set -e
}

cleanup() {
  local rc=$?
  if [[ "$maintenance_started" == true ]]; then restore_production || true; fi
  if [[ "$restore_failed" == true && "$rc" -eq 0 ]]; then rc=90; fi
  exit "$rc"
}
trap cleanup EXIT

[[ -s "$control" && -d "$cache" && -s "$token" ]] || exit 20
[[ ! -e "$gate" ]] || { echo CF_POOL_PHASE2_PREFLIGHT_GATE=present; exit 21; }

python3 - "$control" <<'PY'
import json,sys
d=json.load(open(sys.argv[1])); a=d["authority"]; g=a["productionGuard"]
assert d["controlRevision"]==556
assert d["lease"]["state"]=="FREE"
assert a["productionEpoch"]==27
assert a["mode"]=="VPS_PRODUCTION" and a["materialAuthority"]=="vps-fabric"
assert a["reconciliationHold"]["active"] is False
assert g["killSwitch"]=="ENGAGED"
assert g["allowedDocumentIds"]==[]
assert g["mutationBudget"]["maxMutations"]==0
print("CF_POOL_PHASE2_PREFLIGHT_AUTHORITY=pass")
PY

for c in "$prod_server" "$prod_fabric" "$prod_gateway"; do
  [[ "$(docker inspect -f '{{.State.Running}}' "$c" 2>/dev/null || echo false)" == true ]] || { echo "CF_POOL_PHASE2_PREFLIGHT_$c=not-running"; exit 22; }
  [[ "$(docker inspect -f '{{.State.Health.Status}}' "$c" 2>/dev/null || echo unhealthy)" == healthy ]] || exit 22
done
gateway_was_running=true

prod_before="$(prod_pool_json)"
python3 - "$prod_before" <<'PY'
import json,sys
p=json.loads(sys.argv[1])
assert p.get("pool_enabled") is True and p.get("size")==3
assert p.get("active_count")==0 and p.get("queued_count")==0 and p.get("document_lock_count")==0
assert p.get("session_fingerprints_distinct") is True
s=p.get("sessions") or []
assert len(s)==3
assert all(x.get("auth",{}).get("state")=="PROVEN" and x.get("auth",{}).get("http_status")==200 for x in s)
print("CF_POOL_PHASE2_PREFLIGHT_PROD_POOL=3of3-PROVEN-idle")
PY

exec 9>"$lock"
flock -w 30 9 || { echo CF_POOL_PHASE2_SHARED_LOCK=busy; exit 23; }
echo CF_POOL_PHASE2_SHARED_LOCK=acquired

printf '%s\n' RELEASE_IN_PROGRESS > "$gate"
chmod 0600 "$gate"
docker stop "$prod_gateway" >/dev/null
docker stop "$prod_fabric" >/dev/null
docker stop "$prod_server" >/dev/null
maintenance_started=true
echo CF_POOL_PHASE2_MAINTENANCE=fail-closed

tmp="$(mktemp -d /var/lib/capability-fabric/.pool-phase2.XXXXXX)"
ask="$tmp/askpass"
mkdir "$tmp/release"
cat > "$ask" <<'ASK'
#!/usr/bin/env bash
case "${1:-}" in
  *Username*) printf '%s\n' x-access-token ;;
  *Password*) cat /etc/capability-fabric/secrets/repo-read-token ;;
  *) exit 1 ;;
esac
ASK
chmod 0700 "$ask"
GIT_ASKPASS="$ask" GIT_TERMINAL_PROMPT=0 HOME="$git_home" \
  git --git-dir="$cache" fetch --quiet --force --depth=1 origin "$candidate"
[[ "$(git --git-dir="$cache" rev-parse FETCH_HEAD)" == "$candidate" ]] || exit 24
git --git-dir="$cache" archive "$candidate" | tar -x -C "$tmp/release"
for p in package.json browser.js session-pool.js onshape-request.cjs; do
  [[ -s "$tmp/release/server-deploy/current/$p" ]] || { echo "CF_POOL_PHASE2_CANDIDATE_MISSING=$p"; exit 25; }
done
echo CF_POOL_PHASE2_CANDIDATE_FETCH=pass

mkdir -p "$lab_root"/{profile,control}
chmod 0700 "$lab_root" "$lab_root/profile" "$lab_root/control"
cat > "$lab_root/control/harness.mjs" <<'NODE'
import fs from "node:fs";
import { performance } from "node:perf_hooks";
import { OnshapeSessionPool } from "/tmp/app/session-pool.js";

const fixture=process.env.CF_POOL_FIXTURE.split(":");
const [did,wid,eid]=fixture;
const control="/control";
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
const q=(xs,p)=>{const a=[...xs].sort((x,y)=>x-y);const i=(a.length-1)*p,lo=Math.floor(i),hi=Math.ceil(i);return a[lo]+(a[hi]-a[lo])*(i-lo)};
const stats=xs=>({n:xs.length,min:+Math.min(...xs).toFixed(2),p50:+q(xs,.5).toFixed(2),p95:+q(xs,.95).toFixed(2),max:+Math.max(...xs).toFixed(2),mean:+(xs.reduce((a,b)=>a+b,0)/xs.length).toFixed(2)});

const pool=new OnshapeSessionPool({
  profileDir:"/profile",
  accountFile:"/run/onshape-secrets/account",
  passwordFile:"/run/onshape-secrets/password",
  buildId:"onshape-session-pool-phase2-"+process.env.CF_POOL_CANDIDATE.slice(0,12),
  companyOwnerId:"64a4114074132e1ea68137a8",
  antiForgeryHeaderName:"x-xsrf-token",
  uiApiVersion:"v14",
  openApiFile:"/openapi/onshape-openapi.json",
},{size:5,tmpRoot:"/tmp/onshape-session-pool-lab",requireQualifiedMutator:false});

function write(name,value){fs.writeFileSync(control+"/"+name,JSON.stringify(value,null,2));}
try {
  const t0=performance.now();
  const warm=await pool.warmup();
  const warmMs=performance.now()-t0;
  if(warm.proven_sessions!==5 || warm.session_fingerprints_distinct!==true) throw new Error("five-slot warmup invariant failed");

  const finalAuth=[];
  const fps=[];
  for(const slot of pool.slots){
    const auth=await slot.session.proveAuthentication();
    const fp=await slot.session.sessionFingerprint();
    finalAuth.push({session_id:slot.id,state:auth.state,http_status:auth.http_status,account_id:auth.account_id});
    fps.push(fp);
  }
  if(new Set(finalAuth.map(x=>x.account_id)).size!==1) throw new Error("account mismatch");
  if(new Set(fps).size!==5) throw new Error("fingerprints not distinct");

  const target="https://cad.onshape.com/documents/"+did+"/w/"+wid+"/e/"+eid;
  const navTimes=[];
  await Promise.all(pool.slots.map(async slot=>{
    const n0=performance.now();
    await slot.session.page.goto(target,{waitUntil:"domcontentloaded",timeout:45000});
    navTimes.push(performance.now()-n0);
  }));
  await sleep(2500);

  for(const slot of pool.slots){
    await slot.session.page.evaluate((id)=>{window.name="cf-pool-"+id},slot.id);
  }
  const names=await Promise.all(pool.slots.map(slot=>slot.session.page.evaluate(()=>window.name)));
  if(new Set(names).size!==5) throw new Error("browser context contamination");

  write("ready.json",{
    warmup_ms:+warmMs.toFixed(2),
    navigation_ms:stats(navTimes),
    final_auth:finalAuth,
    fingerprints_distinct:new Set(fps).size===5,
    page_context_markers:names
  });

  for(let i=0;i<120 && !fs.existsSync(control+"/start-load");i++) await sleep(500);
  if(!fs.existsSync(control+"/start-load")) throw new Error("load start signal timeout");

  const allLat=[];
  const rounds=[];
  for(let round=0;round<20;round++){
    let entered=0, releaseBarrier;
    const barrier=new Promise(r=>{releaseBarrier=r});
    const tasks=Array.from({length:5},()=>pool.run({method:"GET",path:"/api/users/current"},async(session,slot)=>{
      entered+=1;
      if(entered===5) releaseBarrier();
      await barrier;
      const x0=performance.now();
      const res=await session.request("GET","/api/users/current");
      const ms=performance.now()-x0;
      return {ok:res.ok,http:res.http,session_id:slot.id,request_ms:ms};
    }));
    const rr=await Promise.all(tasks);
    const ids=rr.map(x=>x.pool_execution.session_id);
    if(new Set(ids).size!==5) throw new Error("round "+round+" did not occupy five distinct slots");
    if(rr.some(x=>x.ok!==true || x.http!==200)) throw new Error("round "+round+" read failed");
    const lat=rr.map(x=>x.request_ms);
    allLat.push(...lat);
    rounds.push({round,session_ids:ids,request_ms:lat.map(x=>+x.toFixed(2))});
    await sleep(100);
  }

  const postAuth=[];
  const postFps=[];
  for(const slot of pool.slots){
    const auth=await slot.session.proveAuthentication();
    postAuth.push({session_id:slot.id,state:auth.state,http_status:auth.http_status,account_id:auth.account_id});
    postFps.push(await slot.session.sessionFingerprint());
  }
  if(postAuth.some(x=>x.state!=="PROVEN" || x.http_status!==200)) throw new Error("post-load auth not PROVEN");
  if(new Set(postAuth.map(x=>x.account_id)).size!==1) throw new Error("post-load account mismatch");
  if(new Set(postFps).size!==5) throw new Error("post-load fingerprints not distinct");

  write("result.json",{
    ok:true,
    candidate:process.env.CF_POOL_CANDIDATE,
    pool_size:5,
    warmup_ms:+warmMs.toFixed(2),
    navigation_ms:stats(navTimes),
    api_request_ms:stats(allLat),
    rounds,
    post_auth:postAuth,
    fingerprints_distinct:true,
    context_isolation:true
  });
} catch(error) {
  write("error.json",{ok:false,code:error?.code||error?.name||"ERROR",message:String(error?.message||error)});
  throw error;
} finally {
  await pool.close().catch(()=>{});
}
NODE
chmod 0600 "$lab_root/control/harness.mjs"

docker rm -f "$lab" >/dev/null 2>&1 || true
docker run -d --name "$lab" \
  --ipc host \
  --memory 5g \
  --cpus 4 \
  --cap-drop ALL \
  --security-opt no-new-privileges \
  --read-only \
  --tmpfs /tmp:rw,exec,nosuid,nodev,size=5g \
  -e HOME=/tmp \
  -e NPM_CONFIG_CACHE=/tmp/npm-cache \
  -e PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
  -e CF_POOL_CANDIDATE="$candidate" \
  -e CF_POOL_FIXTURE="$fixture" \
  -v "$tmp/release/server-deploy/current:/release:ro" \
  -v "$lab_root/profile:/profile:rw" \
  -v "$lab_root/control:/control:rw" \
  -v /etc/capability-fabric/secrets/onshape:/run/onshape-secrets:ro \
  -v /var/lib/capability-fabric/onshape/openapi:/openapi:ro \
  "$image" sh -lc '
    set -e
    mkdir -p /tmp/app
    cp /release/package.json /release/browser.js /release/session-pool.js /release/onshape-request.cjs /tmp/app/
    cd /tmp/app
    npm install --omit=dev --ignore-scripts --no-audit --no-fund --package-lock=false
    exec node /control/harness.mjs
  ' >/dev/null
lab_started=true
echo CF_POOL_PHASE2_LAB_STARTED=pass

ready=false
for _ in $(seq 1 240); do
  if [[ -s "$lab_root/control/ready.json" ]]; then ready=true; break; fi
  if [[ -s "$lab_root/control/error.json" ]]; then
    echo CF_POOL_PHASE2_LAB_ERROR="$(tr '\n' ' ' < "$lab_root/control/error.json")"
    docker logs --tail 80 "$lab" 2>&1 | sed -E 's#https?://[^[:space:]"]+#<url>#g' || true
    exit 40
  fi
  running="$(docker inspect -f '{{.State.Running}}' "$lab" 2>/dev/null || echo false)"
  if [[ "$running" != true ]]; then
    echo CF_POOL_PHASE2_LAB_EXITED_BEFORE_READY
    docker logs --tail 120 "$lab" 2>&1 | sed -E 's#https?://[^[:space:]"]+#<url>#g' || true
    exit 41
  fi
  sleep 1
done
[[ "$ready" == true ]] || { echo CF_POOL_PHASE2_READY_TIMEOUT; exit 42; }

echo CF_POOL_PHASE2_READY="$(tr '\n' ' ' < "$lab_root/control/ready.json")"
echo "CF_POOL_PHASE2_IDLE_STATS=$(docker stats --no-stream --format '{{.CPUPerc}}|{{.MemUsage}}|{{.MemPerc}}|{{.PIDs}}' "$lab")"
awk '/^(MemAvailable|SwapFree):/ {gsub(/:/,"",$1); print "CF_POOL_PHASE2_IDLE_HOST_"$1"_KIB="$2}' /proc/meminfo

touch "$lab_root/control/start-load"
for i in $(seq 1 40); do
  if [[ -s "$lab_root/control/result.json" || -s "$lab_root/control/error.json" ]]; then break; fi
  echo "CF_POOL_PHASE2_LOAD_SAMPLE_$i=$(docker stats --no-stream --format '{{.CPUPerc}}|{{.MemUsage}}|{{.MemPerc}}|{{.PIDs}}' "$lab" 2>/dev/null || true)"
  awk -v i="$i" '/^(MemAvailable|SwapFree):/ {gsub(/:/,"",$1); print "CF_POOL_PHASE2_LOAD_HOST_"i"_"$1"_KIB="$2}' /proc/meminfo
  sleep 1
done

if [[ -s "$lab_root/control/error.json" ]]; then
  echo CF_POOL_PHASE2_LAB_ERROR="$(tr '\n' ' ' < "$lab_root/control/error.json")"
  docker logs --tail 120 "$lab" 2>&1 | sed -E 's#https?://[^[:space:]"]+#<url>#g' || true
  exit 43
fi
[[ -s "$lab_root/control/result.json" ]] || { echo CF_POOL_PHASE2_RESULT_TIMEOUT; exit 44; }
echo CF_POOL_PHASE2_RESULT="$(tr '\n' ' ' < "$lab_root/control/result.json")"

for _ in $(seq 1 30); do
  [[ "$(docker inspect -f '{{.State.Running}}' "$lab" 2>/dev/null || echo false)" == false ]] && break
  sleep 1
done
lab_rc="$(docker inspect -f '{{.State.ExitCode}}' "$lab" 2>/dev/null || echo 99)"
echo CF_POOL_PHASE2_LAB_EXIT_CODE="$lab_rc"
[[ "$lab_rc" == 0 ]] || exit 45

flock -u 9
echo CF_POOL_PHASE2_SHARED_LOCK=released
echo CF_POOL_PHASE2_TEST=pass
