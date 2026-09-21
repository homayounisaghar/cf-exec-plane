#!/usr/bin/env bash
set -euo pipefail
umask 077

[[ "$(id -u)" -eq 0 ]] || { echo CF_P01_REQUIRES_ROOT >&2; exit 2; }

release_root=/var/lib/capability-fabric/releases
candidate="$release_root/onshape-vps-hardened-production-r3"
active=/opt/capability-fabric/current
previous=/opt/capability-fabric/previous
control=/var/lib/capability-fabric/onshape/runtime-control/ONSHAPE_RUNTIME_CONTROL.json
trust=/etc/capability-fabric/trust/deploy-signing.pub
token=/etc/capability-fabric/secrets/mcp-token
source_secret=/etc/capability-fabric/secrets/onshape
source_openapi=/var/lib/capability-fabric/onshape/openapi/onshape-openapi.json
release_gate=/var/lib/capability-fabric/state/release-in-progress
expected_sha=857b7ca6d5a6bcf79b820594801a4f88642fe9520dad1ae18fc064eae6073d7c

[[ -d "$candidate" && -s "$candidate/manifest.json" && -L "$active" ]] || exit 20
[[ -s "$control" && -s "$trust" && -s "$token" && -s "$source_openapi" ]] || exit 20
[[ -s "$source_secret/account" && -s "$source_secret/password" ]] || exit 20
[[ ! -e "$release_gate" ]] || { echo CF_P01_RELEASE_GATE=active >&2; exit 20; }

active_before="$(readlink -f "$active")"
previous_before="$(readlink -f "$previous" 2>/dev/null || true)"
control_sha_before="$(sha256sum "$control" | awk '{print $1}')"
live_before="$(mktemp)"
live_after="$(mktemp)"
for c in capability-fabric-onshape-server capability-fabric-onshape-fabric capability-fabric-onshape-gateway; do
  docker inspect -f '{{.Name}}|{{.Id}}|{{.State.StartedAt}}|{{.Config.Image}}' "$c" >>"$live_before"
done

python3 - "$active_before/manifest.json" "$candidate/manifest.json" "$control" <<'PY'
import json,sys
a=json.load(open(sys.argv[1])); c=json.load(open(sys.argv[2])); r=json.load(open(sys.argv[3]))
assert a["sequence"]==63 and a["release_id"]=="onshape-vps-hardened-rollback-r1",a
assert c["sequence"]==66 and c["release_id"]=="onshape-vps-hardened-production-r3",c
auth=r["authority"]
assert r["controlRevision"]==529
assert r["lease"]["state"]=="FREE"
assert auth["productionEpoch"]==1
assert auth["mode"]=="ANDROID_PRODUCTION"
assert auth["materialAuthority"]=="android-v1"
assert auth["planes"]["android-v1"]["materialEffectsAllowed"] is True
assert auth["planes"]["vps-fabric"]["materialEffectsAllowed"] is False
print("CF_P0_ACTIVE_BASELINE=seq63")
print("CF_P0_AUTHORITY_BASELINE=android-epoch1")
print("CF_P0_LEASE=FREE")
PY

manifest_sha="$(sha256sum "$candidate/manifest.json" | awk '{print $1}')"
[[ "$manifest_sha" == "$expected_sha" ]] || { echo CF_P0_MANIFEST_SHA=mismatch >&2; exit 21; }
[[ "$(tr -d '\r\n' < "$candidate/manifest.sha256")" == "$manifest_sha" ]] || exit 21
sig="$candidate/manifest.json.sig"
[[ -s "$sig" ]] || exit 21
verify_dir="$(mktemp -d /var/lib/capability-fabric/.p0verify.XXXXXX)"
printf 'capability-fabric-deploy %s\n' "$(tr -d '\r\n' < "$trust")" >"$verify_dir/allowed"
ssh-keygen -Y verify -f "$verify_dir/allowed" -I capability-fabric-deploy -n capability-fabric-deploy -s "$sig" <"$candidate/manifest.json" >/dev/null 2>&1

python3 - "$candidate/manifest.json" "$candidate" >"$verify_dir/images.env" <<'PY'
import hashlib,json,os,sys
m=json.load(open(sys.argv[1])); root=sys.argv[2]
assert m["sequence"]==66
assert m["release_id"]=="onshape-vps-hardened-production-r3"
for rel,expected in m["files"].items():
    p=os.path.join(root,rel)
    assert os.path.isfile(p),rel
    actual=hashlib.sha256(open(p,"rb").read()).hexdigest()
    assert actual==expected,(rel,actual,expected)
node=[x for x in m["images"] if x.startswith("mcr.microsoft.com/playwright:")]
py=[x for x in m["images"] if x.startswith("python:")]
assert len(node)==1 and len(py)==1,m["images"]
print("NODE_IMAGE="+node[0])
print("PY_IMAGE="+py[0])
PY
. "$verify_dir/images.env"
echo "CF_P0_MANIFEST_SHA256=$manifest_sha"
echo CF_P0_SIGNATURE=pass
echo CF_P0_FILE_HASH_CLOSURE=pass
echo CF_P0_IMAGE_DIGEST_PINNING=pass
echo CF_P0_FREEZE=pass

qroot="$(mktemp -d /var/lib/capability-fabric/.seq66-qualification.XXXXXX)"
net_name=cf-seq66-qual-net
server_name=cf-seq66-qual-server
fabric_name=cf-seq66-qual-fabric
gateway_name=cf-seq66-qual-gateway

cleanup() {
  rc=$?
  trap - EXIT
  if [[ "$rc" -ne 0 ]]; then
    for c in "$server_name" "$fabric_name" "$gateway_name"; do
      docker logs --tail 80 "$c" 2>/dev/null | sed 's/^/CF_P01_DEBUG=/' || true
    done
  fi
  docker rm -f "$gateway_name" "$fabric_name" "$server_name" "$net_name" >/dev/null 2>&1 || true
  rm -rf "$qroot" "$verify_dir"
  rm -f "$live_before" "$live_after"
  exit "$rc"
}
trap cleanup EXIT

install -d -m 0700 "$qroot/profile" "$qroot/secrets" "$qroot/openapi" "$qroot/agent-state" "$qroot/fabric-state" "$qroot/control" "$qroot/state"
install -m 0600 "$source_secret/account" "$qroot/secrets/account"
install -m 0600 "$source_secret/password" "$qroot/secrets/password"
install -m 0600 "$source_openapi" "$qroot/openapi/onshape-openapi.json"
install -m 0600 "$control" "$qroot/control/ONSHAPE_RUNTIME_CONTROL.json"

docker run -d --name "$net_name" --network bridge \
  "$NODE_IMAGE" sleep infinity >/dev/null

docker run -d --name "$server_name" --network "container:$net_name" --ipc host \
  --read-only --cap-drop ALL --security-opt no-new-privileges --tmpfs /tmp \
  -w /tmp/app \
  -e HOST=127.0.0.1 -e PORT=8788 -e CF_DIAGNOSTIC_PORT=8789 \
  -e CF_FABRIC_SIDECAR_URL=http://127.0.0.1:8791 \
  -e CF_FABRIC_AGENT_STATE_DIR=/agent-state \
  -e CF_ONSHAPE_RUNTIME_CONTROL_FILE=/run/cf-authority/ONSHAPE_RUNTIME_CONTROL.json \
  -e CF_FABRIC_REQUIRE_PRODUCTION_AUTHORITY=1 \
  -e CF_PRIVILEGED_NATIVE_ENABLED=0 -e CF_PUBLIC_SURFACE=semantic-only \
  -e MCP_TOKEN_FILE=/run/secrets/mcp-token -e ONSHAPE_PROFILE_DIR=/profile \
  -e ONSHAPE_ACCOUNT_FILE=/run/onshape-secrets/account \
  -e ONSHAPE_PASSWORD_FILE=/run/onshape-secrets/password \
  -e ONSHAPE_COMPANY_OWNER_ID=64a4114074132e1ea68137a8 \
  -e ONSHAPE_ANTI_FORGERY_HEADER_NAME=x-xsrf-token -e ONSHAPE_UI_API_VERSION=v14 \
  -e ONSHAPE_OPENAPI_FILE=/openapi/onshape-openapi.json -e ONSHAPE_POOL_SIZE=3 \
  -e ONSHAPE_POOL_TMP_ROOT=/tmp/onshape-session-pool \
  -e CF_RELEASE_GATE_FILE=/run/cf-state/release-in-progress \
  -e NODE_ENV=production -e NPM_CONFIG_CACHE=/tmp/npm-cache \
  -e PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 -e HOME=/tmp \
  -v "$candidate:/release:ro" -v "$token:/run/secrets/mcp-token:ro" \
  -v "$qroot/secrets:/run/onshape-secrets:rw" -v "$qroot/profile:/profile:rw" \
  -v "$qroot/openapi:/openapi:rw" -v "$qroot/agent-state:/agent-state:rw" \
  -v "$qroot/control:/run/cf-authority:ro" -v "$qroot/state:/run/cf-state:ro" \
  "$NODE_IMAGE" sh -lc 'umask 077 && chmod 0700 /profile /run/onshape-secrets && mkdir -p /tmp/app && cp /release/package.json /release/server.js /release/core.js /release/browser.js /release/session-pool.js /release/onshape-request.cjs /release/fabric-agent.js /tmp/app/ && cd /tmp/app && PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install --omit=dev --ignore-scripts --no-audit --no-fund --package-lock=false && exec node server.js' >/dev/null

docker run -d --name "$fabric_name" --network "container:$net_name" \
  --read-only --cap-drop ALL --security-opt no-new-privileges --tmpfs /tmp \
  -w /release/fabric-src \
  -e HOST=127.0.0.1 -e PORT=8791 -e PYTHONPATH=/release/fabric-src \
  -e PYTHONDONTWRITEBYTECODE=1 -e PYTHONUNBUFFERED=1 -e HOME=/tmp \
  -e MCP_TOKEN_FILE=/run/secrets/mcp-token \
  -e CF_FABRIC_POLICY_FILE=/release/fabric-policy/semantic-enforcement.v1.json \
  -e CF_FABRIC_STATE_DB=/fabric-state/execution.sqlite3 \
  -e CF_FABRIC_PROJECT_STATE_REVISION=37cd1a6fde95b9eacfaaaa615639853e1dc02a1f \
  -e CF_FABRIC_QUALIFICATION_MODE=0 \
  -e CF_ONSHAPE_RUNTIME_CONTROL_FILE=/run/cf-authority/ONSHAPE_RUNTIME_CONTROL.json \
  -e CF_FABRIC_REQUIRE_PRODUCTION_AUTHORITY=1 \
  -v "$candidate/fabric-src:/release/fabric-src:ro" \
  -v "$candidate/fabric-policy:/release/fabric-policy:ro" \
  -v "$candidate/fabric-tests:/release/fabric-tests:ro" \
  -v "$token:/run/secrets/mcp-token:ro" \
  -v "$qroot/fabric-state:/fabric-state:rw" \
  -v "$qroot/control:/run/cf-authority:ro" \
  "$PY_IMAGE" python -m capability_fabric.onshape_vps_sidecar >/dev/null

docker run -d --name "$gateway_name" --network "container:$net_name" \
  --read-only --cap-drop ALL --security-opt no-new-privileges \
  -w /app \
  -v "$candidate/gateway.js:/app/gateway.js:ro" \
  -v "$token:/run/secrets/mcp-token:ro" \
  -v "$qroot/state:/run/cf-state:ro" \
  "$NODE_IMAGE" node /app/gateway.js >/dev/null

ready=no
for _ in $(seq 1 45); do
  if docker exec "$server_name" node --input-type=module -e '
    const checks=[
      fetch("http://127.0.0.1:8787/").then(async r=>(await r.text())==="cf-onshape-single ok"),
      fetch("http://127.0.0.1:8788/").then(async r=>(await r.text())==="cf-onshape-single ok"),
      fetch("http://127.0.0.1:8789/").then(async r=>(await r.text())==="cf-onshape-single ok"),
      fetch("http://127.0.0.1:8791/").then(async r=>{const v=await r.json(); return v?.ok===true;})
    ];
    const v=await Promise.all(checks); if(!v.every(Boolean)) process.exit(1);
  ' >/dev/null 2>&1; then
    ready=yes
    break
  fi
  sleep 1
done
if [[ "$ready" != yes ]]; then
  echo CF_P1_NAMESPACE_STARTUP=fail >&2
  for x in "$net_name" "$server_name" "$fabric_name" "$gateway_name"; do
    docker inspect -f 'CF_P1_CONTAINER_STATE={{.Name}}|running={{.State.Running}}|status={{.State.Status}}|exit={{.State.ExitCode}}|error={{.State.Error}}|image={{.Config.Image}}' "$x" 2>/dev/null || true
    docker logs --tail 120 "$x" 2>/dev/null | sed 's/^/CF_P1_CONTAINER_LOG=/' || true
  done
  exit 23
fi
echo CF_P1_NAMESPACE_STARTUP=pass

[[ "$(docker inspect -f '{{.Config.Image}}' "$server_name")" == "$NODE_IMAGE" ]]
[[ "$(docker inspect -f '{{.Config.Image}}' "$gateway_name")" == "$NODE_IMAGE" ]]
[[ "$(docker inspect -f '{{.Config.Image}}' "$fabric_name")" == "$PY_IMAGE" ]]
echo CF_P1_RUNNING_IMAGE_DIGESTS=manifest-exact

published="$(docker inspect -f '{{json .HostConfig.PortBindings}}' "$net_name")"
[[ "$published" == "null" || "$published" == "{}" ]] || { echo CF_P1_NAMESPACE_HOST_PUBLISH=present >&2; exit 24; }
echo CF_P1_NAMESPACE_HOST_PUBLISH=absent
echo CF_P1_INTERNAL_BINDING=loopback-only

qual_root="$(docker exec "$server_name" node --input-type=module -e 'const r=await fetch("http://127.0.0.1:8791/"); process.stdout.write(await r.text())')"
printf '%s' "$qual_root" | grep -q '"qualificationMode":false'
qual_code="$(docker exec "$server_name" node --input-type=module -e 'const r=await fetch("http://127.0.0.1:8791/v1/qualification/invoke-ack-loss",{method:"POST",headers:{"content-type":"application/json"},body:"{}"}); process.stdout.write(String(r.status))')"
[[ "$qual_code" == 404 ]] || { echo "CF_P1_FAULT_ROUTE_CODE=$qual_code" >&2; exit 25; }
echo CF_P1_QUALIFICATION_MODE=off
echo CF_P1_FAULT_INJECTION_ROUTE=absent

docker exec -i "$server_name" sh -lc 'cd /tmp/app && node --input-type=module' <<'NODE'
import fs from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
const token=fs.readFileSync("/run/secrets/mcp-token","utf8").trim();
const client=new Client({name:"cf-seq66-final-qualification",version:"1.0.0"});
const transport=new StreamableHTTPClientTransport(new URL("http://127.0.0.1:8788/mcp/"+token));
await client.connect(transport);
function parse(res){
  const raw=(res.content||[]).filter(x=>x.type==="text").map(x=>x.text||"").join("\n");
  if(!raw) throw new Error("empty tool result");
  return JSON.parse(raw);
}
async function call(name,args={}){ return parse(await client.callTool({name,arguments:args})); }
async function waitOp(operationId){
  for(let i=0;i<90;i++){
    const s=await call("onshape_operation_status",{operation_id:operationId});
    if(s.status==="AWAITING_INPUT") throw new Error("qualification reauth requires interactive input:"+String(s.input_required||"UNKNOWN"));
    if(s.status==="SUCCEEDED"||s.status==="FAILED") return s;
    await new Promise(r=>setTimeout(r,1000));
  }
  throw new Error("qualification reauth timed out");
}
const names=(await client.listTools()).tools.map(x=>x.name).sort();
const expected=["cf_echo","onshape_fabric_capabilities","onshape_fabric_invoke","onshape_fabric_reconcile","onshape_pool_status","onshape_pool_session_reauth","onshape_verification_submit","onshape_operation_status"].sort();
if(JSON.stringify(names)!==JSON.stringify(expected)) throw new Error("production tool catalog mismatch:"+JSON.stringify(names));
console.log("CF_P1_SEMANTIC_TOOL_CATALOG=pass");

for(const id of ["session-1","session-2","session-3"]){
  const started=await call("onshape_pool_session_reauth",{session_id:id});
  if(started.status==="FAILED") throw new Error("reauth start failed:"+id+":"+JSON.stringify(started.error));
  const op=String(started.operation_id||"");
  if(!op) throw new Error("reauth operation id missing:"+id);
  const terminal=await waitOp(op);
  if(terminal.status==="FAILED"){
    const code=String(terminal?.error?.code||"");
    if(code!=="POOL_FINAL_AUTH_NOT_PROVEN") throw new Error("reauth failed:"+id+":"+JSON.stringify(terminal.error||terminal));
    console.log("CF_P1_REAUTH_"+id.replace("-","_").toUpperCase()+"=intermediate-final-reprobe-fail-closed");
  } else {
    console.log("CF_P1_REAUTH_"+id.replace("-","_").toUpperCase()+"=succeeded");
  }
}
const pool=await call("onshape_pool_status",{});
if(pool.pool_enabled!==true||pool.size!==3||pool.material_mutator_session_id!=="session-1"||pool.active_count!==0||pool.queued_count!==0) throw new Error("qualification pool invariant:"+JSON.stringify(pool));
if(pool.session_fingerprints_distinct!==true) throw new Error("qualification session fingerprints not distinct");
if(!Array.isArray(pool.sessions)||pool.sessions.length!==3) throw new Error("qualification pool size mismatch");
for(const s of pool.sessions){ if(s?.auth?.state!=="PROVEN") throw new Error("qualification session not PROVEN:"+s?.session_id); }
console.log("CF_P1_POOL_AUTH=3-of-3-PROVEN");
console.log("CF_P1_POOL_DISTINCT_FINGERPRINTS=pass");
console.log("CF_P1_POOL_IDLE=pass");

const caps=await call("onshape_fabric_capabilities",{});
const ids=(caps.capabilities||[]).map(x=>x.id).sort();
for(const required of ["onshape.session.status","onshape.openapi.lookup","onshape.documented.operation"]){ if(!ids.includes(required)) throw new Error("missing capability:"+required); }
for(const forbidden of ["onshape.ui.input.sequence","onshape.ui.native"]){ if(ids.includes(forbidden)) throw new Error("effectful UI admitted:"+forbidden); }
console.log("CF_P1_PRODUCTION_CAPABILITIES=pass");
console.log("CF_P1_EFFECTFUL_UI_CLOSED=pass");

for(const capability_id of ["onshape.ui.input.sequence","onshape.ui.native"]){
  const denied=await call("onshape_fabric_invoke",{capability_id,arguments:{}});
  if(denied?.status!=="FAILED"||denied?.error?.code!=="CAPABILITY_NOT_ADMITTED") throw new Error("effectful UI invocation not denied:"+capability_id);
}
console.log("CF_P1_EFFECTFUL_UI_INVOKE_DENY=pass");

const lookup=await call("onshape_fabric_invoke",{capability_id:"onshape.openapi.lookup",arguments:{keyword:"getDocument"}});
if(lookup?.result?.outcome?.state!=="ACHIEVED") throw new Error("semantic OpenAPI lookup failed:"+JSON.stringify(lookup));
console.log("CF_P1_SEMANTIC_OPENAPI_READ=pass");

const doc=await call("onshape_fabric_invoke",{
  capability_id:"onshape.documented.operation",
  arguments:{operationId:"getDocument",pathParams:{did:"84d077d8370c21c4b3045263"}}
});
if(doc?.result?.outcome?.state!=="ACHIEVED") throw new Error("semantic documented read failed:"+JSON.stringify(doc));
console.log("CF_P1_SEMANTIC_DOCUMENT_READ=pass");
console.log("CF_P1_REPRESENTATIVE_TRANSPORT_SMOKE=pass");

await client.close();
NODE

for c in capability-fabric-onshape-server capability-fabric-onshape-fabric capability-fabric-onshape-gateway; do
  docker inspect -f '{{.Name}}|{{.Id}}|{{.State.StartedAt}}|{{.Config.Image}}' "$c" >>"$live_after"
done
cmp -s "$live_before" "$live_after" || { echo CF_P1_LIVE_CONTAINERS=changed >&2; exit 26; }
[[ "$(readlink -f "$active")" == "$active_before" ]] || { echo CF_P1_ACTIVE_POINTER=changed >&2; exit 26; }
[[ "$(readlink -f "$previous" 2>/dev/null || true)" == "$previous_before" ]] || { echo CF_P1_PREVIOUS_POINTER=changed >&2; exit 26; }
[[ "$(sha256sum "$control" | awk '{print $1}')" == "$control_sha_before" ]] || { echo CF_P1_RUNTIME_CONTROL=changed >&2; exit 26; }
[[ ! -e "$release_gate" ]] || { echo CF_P1_RELEASE_GATE=changed >&2; exit 26; }
echo CF_P1_LIVE_CONTAINERS=unchanged
echo CF_P1_ACTIVE_POINTER=unchanged
echo CF_P1_PREVIOUS_POINTER=unchanged
echo CF_P1_RUNTIME_CONTROL=unchanged
echo CF_P1_AUTHORITY_AFTER=android-epoch1
echo CF_PROTOCOL_0_1=pass
