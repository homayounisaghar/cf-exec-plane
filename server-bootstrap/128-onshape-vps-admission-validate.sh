#!/usr/bin/env bash
set -euo pipefail
umask 077
[[ "$(id -u)" -eq 0 ]] || { echo CF_VPA_REQUIRES_ROOT >&2; exit 2; }

active=/opt/capability-fabric/current
previous=/opt/capability-fabric/previous
control=/var/lib/capability-fabric/onshape/runtime-control/ONSHAPE_RUNTIME_CONTROL.json
mirror_blob=/var/lib/capability-fabric/onshape/runtime-control/git-blob-sha
mirror_commit=/var/lib/capability-fabric/onshape/runtime-control/source-commit
state=/var/lib/capability-fabric/state
db=/var/lib/capability-fabric/onshape/fabric-state/execution.sqlite3
agent_dir=/var/lib/capability-fabric/onshape/fabric-agent
quarantine=/var/lib/capability-fabric/onshape/fabric-state/quarantine/D-018-attempt-f6d80f46.json
guard=/usr/local/libexec/capability-fabric-onshape-rollback-contract
expected_control_blob=81f73bb89c5517080a80ada3047c58c287874c50
expected_manifest=857b7ca6d5a6bcf79b820594801a4f88642fe9520dad1ae18fc064eae6073d7c

[[ -L "$active" && -L "$previous" && -s "$control" && -s "$mirror_blob" && -s "$mirror_commit" ]] || exit 20
[[ -s "$db" && -s "$quarantine" && -x "$guard" ]] || exit 20
[[ ! -e "$state/release-in-progress" ]] || { echo CF_VPA_RELEASE_GATE=active >&2; exit 21; }

a="$(readlink -f "$active")"
p="$(readlink -f "$previous")"
[[ "$a" == /var/lib/capability-fabric/releases/* && "$p" == /var/lib/capability-fabric/releases/* ]] || exit 22
[[ "$(sha256sum "$a/manifest.json" | awk '{print $1}')" == "$expected_manifest" ]] || exit 23
[[ "$(git hash-object "$control")" == "$expected_control_blob" ]] || exit 24
[[ "$(tr -d '\r\n' < "$mirror_blob")" == "$expected_control_blob" ]] || exit 25
[[ "$(tr -d '\r\n' < "$mirror_commit")" =~ ^[0-9a-f]{40}$ ]] || exit 26
[[ "$(stat -c '%U:%G:%a' "$control")" == "root:root:640" ]] || exit 27

python3 - "$a" "$p/manifest.json" "$control" "$expected_control_blob" "$expected_manifest" <<'PY'
import json,sys
from pathlib import Path

active,previous_manifest,control_path,expected_blob,expected_manifest=sys.argv[1:]
sys.path.insert(0, str(Path(active)/"fabric-src"))
from capability_fabric.onshape_authority import OnshapeProductionAuthority

am=json.load(open(Path(active)/"manifest.json"))
pm=json.load(open(previous_manifest))
assert am["sequence"]==66 and am["release_id"]=="onshape-vps-hardened-production-r3",am
assert pm["sequence"]==63 and pm["release_id"]=="onshape-vps-hardened-rollback-r1",pm

raw=Path(control_path).read_bytes()
auth=OnshapeProductionAuthority.from_bytes(raw)
assert auth.control_blob_sha==expected_blob,(auth.control_blob_sha,expected_blob)
assert auth.control_revision==531,auth.control_revision
assert auth.production_epoch==3,auth.production_epoch
assert auth.mode=="VPS_PRODUCTION",auth.mode
assert auth.material_authority=="vps-fabric",auth.material_authority
assert auth.android_ingress=="CLOSED" and auth.android_material_allowed is False
assert auth.vps_ingress=="ADMITTED" and auth.vps_material_allowed is True
assert auth.vps_release_sequence==66
assert auth.vps_release_id=="onshape-vps-hardened-production-r3"
assert auth.vps_manifest_sha256==expected_manifest
assert auth.reconciliation_hold_active is False
auth.require_vps_material_authority()
binding=auth.material_binding()
assert binding=={
    "schema":"capability-fabric.onshape-production-authority.v1",
    "productionEpoch":3,
    "controlBlobSha":expected_blob,
    "controlRevision":531,
    "mode":"VPS_PRODUCTION",
    "materialAuthority":"vps-fabric",
    "releaseSequence":66,
    "releaseId":"onshape-vps-hardened-production-r3",
    "manifestSha256":expected_manifest,
},binding
stale=dict(binding); stale["productionEpoch"]=2
try:
    auth.require_binding(stale)
except PermissionError:
    pass
else:
    raise AssertionError("stale epoch binding was not rejected")
print("CF_VPA_ACTIVE_RELEASE=seq66")
print("CF_VPA_PREVIOUS_RELEASE=seq63")
print("CF_VPA_AUTHORITY=VPS_PRODUCTION")
print("CF_VPA_PRODUCTION_EPOCH=3")
print("CF_VPA_CONTROL_REVISION=531")
print("CF_VPA_CONTROL_BLOB="+expected_blob)
print("CF_VPA_EXACT_RELEASE_BINDING=pass")
print("CF_VPA_STALE_BINDING_REJECT=pass")
print("CF_VPA_ANDROID_CLOSED=pass")
PY

[[ "$(cat "$state/last-good-sequence")" == 66 ]]
[[ "$(cat "$state/last-good-release")" == onshape-vps-hardened-production-r3 ]]
systemctl is-active --quiet capability-fabric-pull.timer
for c in capability-fabric-onshape-server capability-fabric-onshape-fabric capability-fabric-onshape-gateway; do
  [[ "$(docker inspect -f '{{.State.Running}}' "$c")" == true ]]
done

backend_env="$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' capability-fabric-onshape-server)"
fabric_env="$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' capability-fabric-onshape-fabric)"
printf '%s\n' "$backend_env" | grep -Fxq 'CF_PUBLIC_SURFACE=semantic-only'
printf '%s\n' "$backend_env" | grep -Fxq 'CF_FABRIC_REQUIRE_PRODUCTION_AUTHORITY=1'
printf '%s\n' "$backend_env" | grep -Fxq 'CF_PRIVILEGED_NATIVE_ENABLED=0'
printf '%s\n' "$fabric_env" | grep -Fxq 'CF_FABRIC_REQUIRE_PRODUCTION_AUTHORITY=1'
printf '%s\n' "$fabric_env" | grep -Fxq 'CF_FABRIC_QUALIFICATION_MODE=0'
echo CF_VPA_PRODUCTION_CONFIG=pass
echo CF_VPA_RELEASE_GATE=clear
echo CF_VPA_PULL_TIMER=active
echo CF_VPA_CONTAINERS=running

python3 - "$db" "$agent_dir" "$quarantine" <<'PY'
import json,pathlib,sqlite3,sys
db,agent_dir,qpath=sys.argv[1:]
q=json.load(open(qpath)); qa=q["attemptId"]; qo=q["operationId"]
c=sqlite3.connect(f"file:{db}?mode=ro",uri=True)
try:
    assert str(c.execute("PRAGMA integrity_check").fetchone()[0]).lower()=="ok"
    assert c.execute("SELECT count(*) FROM operations WHERE state='IN_FLIGHT'").fetchone()[0]==0
    assert c.execute("SELECT count(*) FROM attempts WHERE state='DISPATCH_INTENT'").fetchone()[0]==0
    assert c.execute("SELECT count(*) FROM operations WHERE state='IN_DOUBT' AND operation_id<>?",(qo,)).fetchone()[0]==0
    assert c.execute("SELECT count(*) FROM attempts WHERE state='IN_DOUBT' AND attempt_id<>?",(qa,)).fetchone()[0]==0
finally:
    c.close()
executing=[]; other_uncertain=[]
for p in pathlib.Path(agent_dir).glob("*.json"):
    try: v=json.loads(p.read_text())
    except Exception: continue
    state=str(v.get("state","")); aid=str(v.get("attemptId") or "")
    if state=="EXECUTING": executing.append((p.name,aid))
    if state=="UNCERTAIN" and aid!=qa: other_uncertain.append((p.name,aid))
assert not executing,executing
assert not other_uncertain,other_uncertain
print("CF_VPA_SQLITE_INTEGRITY=pass")
print("CF_VPA_EFFECTIVE_UNRESOLVED=0")
print("CF_VPA_AGENT_EXECUTING=0")
print("CF_VPA_AGENT_UNCERTAIN_EFFECTIVE=0")
PY

out="$(python3 "$guard" decide --db "$db" --control "$control" --quarantine "$quarantine")"
printf '%s\n' "$out"
printf '%s\n' "$out" | grep -Fxq 'CF_A4_PONR=false'
printf '%s\n' "$out" | grep -Fxq 'CF_A4_PONR_COUNT=0'
printf '%s\n' "$out" | grep -Fxq 'CF_A4_UNRESOLVED_BLOCKING=0'
printf '%s\n' "$out" | grep -Fxq 'CF_A4_ZERO_UNRESOLVED=pass'
echo CF_VPA_PONR=false

docker exec -i capability-fabric-onshape-server sh -lc 'cd /tmp/app && node --input-type=module' <<'NODE'
import fs from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
const token=fs.readFileSync("/run/secrets/mcp-token","utf8").trim();
const client=new Client({name:"cf-vps-admission-validator",version:"1.0.0"});
const transport=new StreamableHTTPClientTransport(new URL("http://127.0.0.1:8788/mcp/"+token));
await client.connect(transport);
const tools=(await client.listTools()).tools.map(x=>x.name).sort();
for(const required of ["onshape_pool_status","onshape_fabric_capabilities","onshape_fabric_invoke"]){
  if(!tools.includes(required)) throw new Error("missing "+required+" in "+JSON.stringify(tools));
}
if(tools.includes("onshape_ui_input_sequence")||tools.includes("onshape_ui_native")) throw new Error("effectful UI exposed");
const capsRes=await client.callTool({name:"onshape_fabric_capabilities",arguments:{}});
if(capsRes.isError===true) throw new Error("capability catalog failed");
const capsRaw=(capsRes.content||[]).filter(x=>x.type==="text").map(x=>x.text||"").join("\n");
const caps=JSON.parse(capsRaw);
const ids=(caps.capabilities||[]).map(x=>x.id);
if(ids.includes("onshape.ui.input.sequence")||ids.includes("onshape.ui.native")) throw new Error("effectful UI capability exposed");
const ps=await client.callTool({name:"onshape_pool_status",arguments:{}});
const raw=(ps.content||[]).filter(x=>x.type==="text").map(x=>x.text||"").join("\n");
const pool=JSON.parse(raw);
if(pool.pool_enabled!==true||pool.size!==3||pool.active_count!==0||pool.queued_count!==0||pool.document_lock_count!==0) throw new Error(raw);
if(pool.material_mutator_session_id!=="session-1") throw new Error(raw);
for(const s of pool.sessions){if(s?.auth?.state!=="PROVEN") throw new Error(raw);}
const rd=await client.callTool({name:"onshape_fabric_invoke",arguments:{capability_id:"onshape.openapi.lookup",arguments:{keyword:"getDocument"}}});
if(rd.isError===true) throw new Error("semantic lookup failed");
console.log("CF_VPA_TOOL_CATALOG=pass");
console.log("CF_VPA_UI_EFFECTFUL_CLOSED=pass");
console.log("CF_VPA_POOL_AUTH=3-of-3-PROVEN");
console.log("CF_VPA_POOL_IDLE=pass");
console.log("CF_VPA_SEMANTIC_READ=pass");
await client.close();
NODE

echo CF_VPA=pass
