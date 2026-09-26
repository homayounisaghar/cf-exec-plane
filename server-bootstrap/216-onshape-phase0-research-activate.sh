#!/usr/bin/env bash
set -euo pipefail
umask 077

[[ "$(id -u)" -eq 0 ]] || { echo CF_PHASE0_ACTIVATE_ROOT=required >&2; exit 2; }

candidate_commit="ae9bc114d84cfd7991cbdd38489b18d33a2d34bf"
fixture="a19e0fa5152af9f7ce106b6e:e5e7d0173fd1f1d0307a2cb6:e0929361aadb6135b5cecffa"
expected_control_blob="7c03d59b613a7c91249f4c56efd045e1ed13a8dc"

control=/var/lib/capability-fabric/onshape/runtime-control/ONSHAPE_RUNTIME_CONTROL.json
prod_gate=/var/lib/capability-fabric/state/release-in-progress
shared_lock=/run/lock/capability-fabric-pull.lock
repo_cache=/var/lib/capability-fabric/repo.git
repo_token=/etc/capability-fabric/secrets/repo-read-token
git_home=/var/lib/capability-fabric/agent-home
root=/var/lib/capability-fabric/onshape-research-phase0
release_root="$root/releases"
release="$release_root/$candidate_commit"
secret_dir=/etc/capability-fabric/secrets/onshape-research-phase0
research_token=/etc/capability-fabric/secrets/mcp-token-research-phase0
prod_secret_dir=/etc/capability-fabric/secrets/onshape
compose="$release/server-deploy/research-phase0/compose.yaml"
project=capability-fabric-onshape-phase0

[[ -s "$control" && -s "$repo_token" && -d "$repo_cache" ]] || exit 20
[[ "$(git hash-object "$control")" == "$expected_control_blob" ]] || { echo CF_PHASE0_ACTIVATE_CONTROL=freshness-mismatch; exit 21; }
[[ -f "$prod_gate" ]] && grep -Fxq RELEASE_IN_PROGRESS "$prod_gate" || { echo CF_PHASE0_ACTIVATE_PROD_GATE=unexpected; exit 22; }

python3 - "$control" <<'PY'
import json,sys
x=json.load(open(sys.argv[1])); a=x["authority"]; v=a["planes"]["vps-fabric"]
assert x["controlRevision"]==555
assert x["routing"]["state"]=="CLOSED"
assert x["routing"]["materialCommandsAllowed"] is False
assert x["lease"]["state"]=="FREE"
assert a["productionEpoch"]==26
assert a["mode"]=="VPS_PRODUCTION" and a["materialAuthority"]=="vps-fabric"
assert a["planes"]["android-v1"]["ingress"]=="CLOSED"
assert a["planes"]["android-v1"]["materialEffectsAllowed"] is False
assert v["ingress"]=="ADMITTED" and v["materialEffectsAllowed"] is True
assert v["releaseSequence"]==73
assert v["releaseId"]=="onshape-vps-hardened-production-r8"
assert v["manifestSha256"]=="08873ac1a6830ed42f15ebe340604ed6ffea33b8e7cb12b3a192982f3dcd6e9c"
assert a["reconciliationHold"]["active"] is False
print("CF_PHASE0_ACTIVATE_AUTHORITY=pass")
PY

for c in capability-fabric-onshape-server capability-fabric-onshape-fabric; do
  [[ "$(docker inspect -f '{{.State.Running}}' "$c" 2>/dev/null || echo false)" == true ]] || { echo "CF_PHASE0_ACTIVATE_PROD_$c=not-running"; exit 23; }
done
[[ "$(docker inspect -f '{{.State.Running}}' capability-fabric-onshape-gateway 2>/dev/null || echo false)" == false ]] || exit 23

exec 9>"$shared_lock"
flock -w 30 9 || { echo CF_PHASE0_ACTIVATE_SHARED_LOCK=busy; exit 24; }
echo CF_PHASE0_ACTIVATE_SHARED_LOCK=acquired

for p in 8898 8899 8901; do
  if ss -lnt | awk -v x="127.0.0.1:$p" '$4==x{f=1} END{exit f?0:1}'; then
    echo "CF_PHASE0_ACTIVATE_PORT_$p=busy"
    exit 25
  fi
done

for c in capability-fabric-onshape-phase0-research capability-fabric-onshape-phase0-fabric; do
  if docker inspect "$c" >/dev/null 2>&1; then
    [[ "$(docker inspect -f '{{.State.Running}}' "$c")" == false ]] || { echo "CF_PHASE0_ACTIVATE_EXISTING_$c=running"; exit 26; }
    docker rm "$c" >/dev/null
  fi
done

mkdir -p "$root"
chmod 0700 "$root"
tmp="$(mktemp -d "$root/.activate.XXXXXX")"
askpass="$tmp/askpass"
cleanup(){ rm -rf "$tmp"; }
trap cleanup EXIT
cat >"$askpass" <<'ASKPASS'
#!/usr/bin/env bash
case "${1:-}" in
  *Username*) printf '%s\n' 'x-access-token' ;;
  *Password*) cat /etc/capability-fabric/secrets/repo-read-token ;;
  *) exit 1 ;;
esac
ASKPASS
chmod 0700 "$askpass"

GIT_ASKPASS="$askpass" GIT_TERMINAL_PROMPT=0 HOME="$git_home" \
  git --git-dir="$repo_cache" fetch --quiet --force --depth=1 origin "$candidate_commit"
[[ "$(git --git-dir="$repo_cache" rev-parse FETCH_HEAD)" == "$candidate_commit" ]] || exit 27

mkdir -p "$release_root"
if [[ ! -d "$release" ]]; then
  mkdir "$tmp/release"
  git --git-dir="$repo_cache" archive "$candidate_commit" | tar -x -C "$tmp/release"
  test -s "$tmp/release/server-deploy/current/server.js"
  test -s "$tmp/release/server-deploy/research-phase0/compose.yaml"
  mv "$tmp/release" "$release"
fi
[[ -s "$release/server-deploy/current/server.js" && -s "$compose" ]] || exit 28

mkdir -p "$root"/{browser-profile,openapi,fabric-agent,fabric-state,release-state}
chmod 0700 "$root" "$release_root" "$root/browser-profile" "$root/openapi" "$root/fabric-agent" "$root/fabric-state" "$root/release-state"
rm -f "$root/release-state/release-in-progress"
find "$root/fabric-agent" -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +
find "$root/fabric-state" -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +

install -d -m 0700 -o root -g root "$secret_dir"
install -m 0600 -o root -g root "$prod_secret_dir/account" "$secret_dir/account"
install -m 0600 -o root -g root "$prod_secret_dir/password" "$secret_dir/password"
[[ -s "$secret_dir/account" && -s "$secret_dir/password" ]] || exit 29

if [[ ! -s "$research_token" ]]; then
  python3 - <<'PY' >"$research_token"
import secrets
print(secrets.token_urlsafe(36))
PY
  chown root:root "$research_token"
  chmod 0600 "$research_token"
fi
[[ "$(stat -c %a "$research_token")" == 600 ]] || chmod 0600 "$research_token"

if [[ -s /var/lib/capability-fabric/onshape/openapi/onshape-openapi.json ]]; then
  install -m 0600 -o root -g root /var/lib/capability-fabric/onshape/openapi/onshape-openapi.json "$root/openapi/onshape-openapi.json"
fi
[[ -s "$root/openapi/onshape-openapi.json" ]] || { echo CF_PHASE0_ACTIVATE_OPENAPI=missing; exit 30; }

export CF_PHASE0_FIXTURE_TARGET="$fixture"
export CF_PHASE0_PROJECT_STATE_REVISION="$candidate_commit"
export CF_PHASE0_SOURCE_COMMIT="$candidate_commit"

docker compose -p "$project" -f "$compose" config >/dev/null
echo CF_PHASE0_ACTIVATE_COMPOSE=pass

# We have proven no production critical section and touch no production mutable state below.
flock -u 9
echo CF_PHASE0_ACTIVATE_SHARED_LOCK=released

docker compose -p "$project" -f "$compose" up -d

for i in $(seq 1 90); do
  a="$(docker inspect -f '{{.State.Health.Status}}' capability-fabric-onshape-phase0-research 2>/dev/null || true)"
  b="$(docker inspect -f '{{.State.Health.Status}}' capability-fabric-onshape-phase0-fabric 2>/dev/null || true)"
  if [[ "$a" == healthy && "$b" == healthy ]]; then break; fi
  if [[ "$a" == unhealthy || "$b" == unhealthy ]]; then
    docker logs --tail 80 capability-fabric-onshape-phase0-research 2>&1 | sed -E 's#https?://[^[:space:]"]+#<url>#g' || true
    docker logs --tail 80 capability-fabric-onshape-phase0-fabric 2>&1 | sed -E 's#https?://[^[:space:]"]+#<url>#g' || true
    exit 31
  fi
  sleep 2
done
[[ "$(docker inspect -f '{{.State.Health.Status}}' capability-fabric-onshape-phase0-research)" == healthy ]]
[[ "$(docker inspect -f '{{.State.Health.Status}}' capability-fabric-onshape-phase0-fabric)" == healthy ]]
echo CF_PHASE0_ACTIVATE_HEALTH=pass

for p in 8898 8899 8901; do
  ss -lnt | awk -v x="127.0.0.1:$p" '$4==x{f=1} END{exit f?0:1}' || { echo "CF_PHASE0_ACTIVATE_PORT_$p=missing"; exit 32; }
done
echo CF_PHASE0_ACTIVATE_RESEARCH_PORTS=pass

# Production invariants must remain exactly unchanged.
[[ "$(git hash-object "$control")" == "$expected_control_blob" ]] || exit 33
[[ -f "$prod_gate" ]] && grep -Fxq RELEASE_IN_PROGRESS "$prod_gate" || exit 33
for c in capability-fabric-onshape-server capability-fabric-onshape-fabric; do
  [[ "$(docker inspect -f '{{.State.Running}}' "$c")" == true ]] || exit 33
done
[[ "$(docker inspect -f '{{.State.Running}}' capability-fabric-onshape-gateway 2>/dev/null || echo false)" == false ]] || exit 33
echo CF_PHASE0_ACTIVATE_PRODUCTION_UNCHANGED=pass

docker exec -e CF_FIXTURE="$fixture" -i capability-fabric-onshape-phase0-research sh -lc 'cd /tmp/app && node --input-type=module' <<'NODE'
import fs from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const fixture=process.env.CF_FIXTURE.split(":");
const [did,wid,eid]=fixture;
const token=fs.readFileSync("/run/secrets/mcp-token","utf8").trim();
const c=new Client({name:"cf-phase0-activate",version:"1.0.0"});
await c.connect(new StreamableHTTPClientTransport(new URL("http://127.0.0.1:8898/mcp/"+token)));
const parse=(res)=>{
  const raw=(res?.content||[]).filter(x=>x.type==="text").map(x=>x.text||"").join("\n");
  if(!raw) throw new Error("empty MCP result");
  return JSON.parse(raw);
};
const call=async(name,args={})=>parse(await c.callTool({name,arguments:args},undefined,{timeout:180000}));
try {
  const listed=(await c.listTools()).tools.map(x=>x.name).sort();
  for(const required of [
    "onshape_fabric_capabilities","onshape_fabric_invoke","onshape_ui_native","onshape_ui_input",
    "onshape_session_status","onshape_login_start","onshape_operation_status","onshape_verification_submit"
  ]) if(!listed.includes(required)) throw new Error("missing research tool "+required);
  for(const forbidden of [
    "onshape_request","onshape_artifact","onshape_documents_create","onshape_pool_warmup","onshape_pool_session_reauth"
  ]) if(listed.includes(forbidden)) throw new Error("forbidden research tool "+forbidden);
  console.log("CF_PHASE0_ACTIVATE_TOOL_CATALOG=pass");

  const caps=await call("onshape_fabric_capabilities");
  if(caps.public_surface!=="shadow" || caps.qualification_only!==true) throw new Error("research surface flags");
  const ids=(caps.capabilities||[]).map(x=>x.id).sort();
  for(const id of ["onshape.session.status","onshape.ui.input.sequence","onshape.ui.native"]) if(!ids.includes(id)) throw new Error("missing capability "+id);
  for(const id of ids) if(!["onshape.session.status","onshape.ui.input.sequence","onshape.ui.native"].includes(id)) throw new Error("unexpected Phase0 capability "+id);
  console.log("CF_PHASE0_ACTIVATE_CAPABILITIES="+ids.join(","));

  const mismatch=await call("onshape_ui_input",{
    document_id:"000000000000000000000001",workspace_id:wid,element_id:eid,
    steps:[{action:"mouse.move",x_fraction:0.5,y_fraction:0.5}]
  });
  if(mismatch.status!=="FAILED" || mismatch?.error?.code!=="RESEARCH_FIXTURE_MISMATCH") throw new Error("fixture guard did not fail closed");
  console.log("CF_PHASE0_ACTIVATE_FIXTURE_GUARD=pass");

  let status=await call("onshape_session_status");
  if(status?.auth?.state!=="PROVEN"){
    const login=await call("onshape_login_start");
    const opId=login.operation_id;
    if(typeof opId!=="string") throw new Error("login operation id missing");
    for(let i=0;i<150;i++){
      const op=await call("onshape_operation_status",{operation_id:opId});
      if(op.status==="SUCCEEDED") break;
      if(op.status==="AWAITING_INPUT"){
        if(op.input_required!=="EMAIL_VERIFICATION_CODE") throw new Error("unexpected input "+op.input_required);
        console.log("CF_PHASE0_ACTIVATE_LOGIN=AWAITING_EMAIL_VERIFICATION");
        process.exitCode=42;
        return;
      }
      if(op.status==="FAILED") throw new Error("research login failed: "+String(op?.error?.code||"unknown"));
      await new Promise(r=>setTimeout(r,1000));
    }
    status=await call("onshape_session_status");
  }
  if(status?.auth?.state!=="PROVEN" || status?.auth?.http_status!==200) throw new Error("research authentication not PROVEN");
  console.log("CF_PHASE0_ACTIVATE_AUTH=PROVEN");
  console.log("CF_PHASE0_ACTIVATE_BUILD_ID="+String(status.build_id||""));
} finally {
  await c.close().catch(()=>{});
}
NODE
node_rc=$?
if (( node_rc == 42 )); then
  echo CF_PHASE0_ACTIVATE=awaiting-email-verification
  exit 42
fi
(( node_rc == 0 )) || exit "$node_rc"

echo CF_PHASE0_ACTIVATE_FIXTURE="$fixture"
echo CF_PHASE0_ACTIVATE_CANDIDATE="$candidate_commit"
echo CF_PHASE0_ACTIVATE=pass
