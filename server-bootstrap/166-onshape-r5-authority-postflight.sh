#!/usr/bin/env bash
set -euo pipefail
umask 077
[[ "$(id -u)" -eq 0 ]] || exit 2

ACTIVE=/opt/capability-fabric/current
PREVIOUS=/opt/capability-fabric/previous
STATE=/var/lib/capability-fabric/state
CONTROL=/var/lib/capability-fabric/onshape/runtime-control/ONSHAPE_RUNTIME_CONTROL.json
MIRROR_BLOB=/var/lib/capability-fabric/onshape/runtime-control/git-blob-sha
GATE="$STATE/release-in-progress"
TIMER=capability-fabric-pull.timer
GATEWAY=capability-fabric-onshape-gateway
SERVER=capability-fabric-onshape-server
DB=/var/lib/capability-fabric/onshape/fabric-state/execution.sqlite3
QUARANTINE=/var/lib/capability-fabric/onshape/fabric-state/quarantine/D-018-attempt-f6d80f46.json
ROLLBACK_GUARD=/usr/local/libexec/capability-fabric-onshape-rollback-contract

TARGET_CONTROL=79ea04caa91462d85021ae46392b636b217a6cc8
EXPECTED_MANIFEST=01f31143e3574c02d430a6b4f67a9be3ef24590a39f4e27459131da4beece057
TEST_DID=881affea8ea63c33ae4e6c78
MARKER='MUST NOT APPLY - R5 AUTHORITY REBIND'

active="$(readlink -f "$ACTIVE")"
previous="$(readlink -f "$PREVIOUS")"
[[ "$(basename "$active")" == "onshape-vps-hardened-production-r5" ]] || exit 20
[[ "$(basename "$previous")" == "capability-fabric-isolated-telegram-ingress-r69" ]] || exit 20
[[ "$(cat "$STATE/last-good-sequence")" == "70" ]] || exit 20
[[ "$(cat "$STATE/last-good-release")" == "onshape-vps-hardened-production-r5" ]] || exit 20
[[ ! -s "$STATE/last-failed-commit" ]] || exit 20
[[ "$(sha256sum "$active/manifest.json" | awk '{print $1}')" == "$EXPECTED_MANIFEST" ]] || exit 20
[[ "$(git hash-object "$CONTROL")" == "$TARGET_CONTROL" ]] || exit 20
[[ "$(tr -d '\r\n' < "$MIRROR_BLOB")" == "$TARGET_CONTROL" ]] || exit 20
[[ ! -e "$GATE" ]] || exit 20
systemctl is-active --quiet "$TIMER"
[[ "$(docker inspect -f '{{.State.Running}}' "$GATEWAY")" == true ]]
[[ "$(docker inspect -f '{{.State.Running}}' "$SERVER")" == true ]]
[[ "$(curl -fsS --max-time 3 http://127.0.0.1:8787/)" == "cf-onshape-single ok" ]]

python3 - "$CONTROL" <<'PY'
import json,sys
x=json.load(open(sys.argv[1])); a=x["authority"]; g=a["productionGuard"]; v=a["planes"]["vps-fabric"]; d=a["planes"]["android-v1"]
assert x["controlRevision"]==542
assert a["productionEpoch"]==13 and a["mode"]=="VPS_PRODUCTION" and a["materialAuthority"]=="vps-fabric"
assert d["ingress"]=="CLOSED" and d["materialEffectsAllowed"] is False
assert v["ingress"]=="ADMITTED" and v["materialEffectsAllowed"] is True
assert v["releaseSequence"]==70 and v["releaseId"]=="onshape-vps-hardened-production-r5"
assert v["manifestSha256"]=="01f31143e3574c02d430a6b4f67a9be3ef24590a39f4e27459131da4beece057"
assert a["reconciliationHold"]["active"] is False
assert x["lease"]["state"]=="FREE"
assert g["generation"]==3 and g["killSwitch"]=="ENGAGED"
assert g["allowedDocumentIds"]==[] and g["mutationBudget"]["maxMutations"]==0
print("CF_R5_AUTH_POST_AUTHORITY=epoch13-seq70-r5")
print("CF_R5_AUTH_POST_GUARD=engaged-empty-zero")
print("CF_R5_AUTH_POST_LEASE=FREE")
PY

python3 - "$DB" "$MARKER" <<'PY'
import sqlite3,sys
db,marker=sys.argv[1:]
c=sqlite3.connect(f"file:{db}?mode=ro",uri=True); c.row_factory=sqlite3.Row
rows=c.execute("""
SELECT i.phase,i.dispatch_payload,o.operation_id,a.attempt_id
FROM invocations i
LEFT JOIN operations o ON o.invocation_id=i.invocation_id
LEFT JOIN attempts a ON a.operation_id=o.operation_id
WHERE i.payload LIKE ?
""", ("%"+marker+"%",)).fetchall()
assert len(rows)==1,[dict(r) for r in rows]
r=rows[0]
assert r["dispatch_payload"] is None and r["operation_id"] is None and r["attempt_id"] is None,dict(r)
print("CF_R5_AUTH_POST_NEGATIVE=REJECTED_PRE_DISPATCH")
c.close()
PY

docker exec -e CF_TEST_DID="$TEST_DID" -i "$SERVER" sh -lc 'cd /tmp/app && node --input-type=module' <<'NODE'
import fs from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
const DID=process.env.CF_TEST_DID;
const token=fs.readFileSync("/run/secrets/mcp-token","utf8").trim();
const client=new Client({name:"cf-r5-authority-postflight",version:"1.0.0"});
const transport=new StreamableHTTPClientTransport(new URL("http://127.0.0.1:8788/mcp/"+token));
await client.connect(transport);
const parse=res=>JSON.parse((res?.content||[]).filter(x=>x.type==="text").map(x=>x.text||"").join("\n"));
const caps=parse(await client.callTool({name:"onshape_fabric_capabilities",arguments:{}}));
const pool=parse(await client.callTool({name:"onshape_pool_status",arguments:{}}));
if(caps?.build_id!=="onshape-vps-hardened-r5"||caps?.public_surface!=="semantic-only") throw new Error("surface");
if(pool?.pool_enabled!==true||pool?.warming!==false||pool?.size!==3||pool?.active_count!==0||pool?.queued_count!==0||pool?.document_lock_count!==0) throw new Error("pool");
if(pool?.material_mutator_session_id!=="session-1"||pool?.session_fingerprints_distinct!==true) throw new Error("pool identity");
for(const s of pool?.sessions||[]) if(s?.auth?.state!=="PROVEN") throw new Error("auth");
console.log("CF_R5_AUTH_POST_BUILD=onshape-vps-hardened-r5");
console.log("CF_R5_AUTH_POST_SURFACE=semantic-only");
console.log("CF_R5_AUTH_POST_POOL=3-of-3-PROVEN-idle");
const read=parse(await client.callTool({name:"onshape_fabric_invoke",arguments:{
  capability_id:"onshape.documented.operation",
  arguments:{operationId:"getDocument",pathParams:{did:DID},query:{}}
}}));
const r=read?.result,e=r?.observation?.evidence||{},b=e.body||{};
if(r?.outcome?.state!=="ACHIEVED"||e.httpStatus!==200||e.effectSent!==false||b.id!==DID) throw new Error("read");
if(e.apiVersion!=="v17"||e.observedApiVersion!=="v17"||e.apiVersionMatched!==true) throw new Error("version");
console.log("CF_R5_AUTH_POST_READ=pass");
console.log("CF_R5_AUTH_POST_API_VERSION_MATCHED=true");
await client.close();
NODE

ponr="$("$ROLLBACK_GUARD" decide --db "$DB" --control "$CONTROL" --quarantine "$QUARANTINE")"
printf '%s\n' "$ponr" | grep -Fxq 'CF_A4_PONR_COUNT=4'
printf '%s\n' "$ponr" | grep -Fxq 'CF_A4_UNRESOLVED_BLOCKING=0'
printf '%s\n' "$ponr" | grep -Fxq 'CF_A4_ZERO_UNRESOLVED=pass'

echo CF_R5_AUTH_POST_ACTIVE_RELEASE=seq70-r5
echo CF_R5_AUTH_POST_PREVIOUS_RELEASE=seq69
echo CF_R5_AUTH_POST_LAST_GOOD_SEQUENCE=70
echo CF_R5_AUTH_POST_LAST_FAILED=none
echo CF_R5_AUTH_POST_RELEASE_GATE=clear
echo CF_R5_AUTH_POST_PULL_TIMER=active
echo CF_R5_AUTH_POST_GATEWAY=running
echo CF_R5_AUTH_POST_MCP_ROOT=pass
echo CF_R5_AUTH_POST=pass
