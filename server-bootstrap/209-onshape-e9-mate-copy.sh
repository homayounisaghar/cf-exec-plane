#!/usr/bin/env bash
set -euo pipefail
umask 077
[[ "$(id -u)" -eq 0 ]] || exit 2
ACTIVE=/opt/capability-fabric/current
STATE=/var/lib/capability-fabric/state
CONTROL=/var/lib/capability-fabric/onshape/runtime-control/ONSHAPE_RUNTIME_CONTROL.json
MIRROR_BLOB=/var/lib/capability-fabric/onshape/runtime-control/git-blob-sha
GATE="$STATE/release-in-progress"
LOCK=/run/lock/capability-fabric-pull.lock
TIMER=capability-fabric-pull.timer
SERVICE=capability-fabric-pull.service
PULL=/usr/local/libexec/capability-fabric-pull-agent
GATEWAY=capability-fabric-onshape-gateway
SERVER=capability-fabric-onshape-server
DB=/var/lib/capability-fabric/onshape/fabric-state/execution.sqlite3
QUARANTINE=/var/lib/capability-fabric/onshape/fabric-state/quarantine/D-018-attempt-f6d80f46.json
ROLLBACK_GUARD=/usr/local/libexec/capability-fabric-onshape-rollback-contract

PREV_CONTROL=ed50203283fc49d30af5b27c08607740edc6e696
TARGET_CONTROL=5d0e3a9fd9a9e369dab6ae81acdd90d57ea3f488
EXPECTED_MANIFEST=08873ac1a6830ed42f15ebe340604ed6ffea33b8e7cb12b3a192982f3dcd6e9c
SOURCE_DID=9c19201d51bb3d73a1833128
SOURCE_WID=0a7ff1a635d5448549080491
COPY_NAME="CF E9 Mate Semantic Lab 2026-09-26"

[[ "$(basename "$(readlink -f "$ACTIVE")")" == "onshape-vps-hardened-production-r8" ]] || exit 20
[[ "$(cat "$STATE/last-good-sequence")" == "73" ]] || exit 20
[[ "$(cat "$STATE/last-good-release")" == "onshape-vps-hardened-production-r8" ]] || exit 20
[[ ! -s "$STATE/last-failed-commit" ]] || exit 20
[[ "$(sha256sum "$(readlink -f "$ACTIVE")/manifest.json" | awk '{print $1}')" == "$EXPECTED_MANIFEST" ]] || exit 20
[[ "$(git hash-object "$CONTROL")" == "$PREV_CONTROL" ]] || exit 20
[[ "$(tr -d '\r\n' < "$MIRROR_BLOB")" == "$PREV_CONTROL" ]] || exit 20
[[ -f "$GATE" ]] && grep -Fxq RELEASE_IN_PROGRESS "$GATE"
if systemctl is-active --quiet "$TIMER"; then exit 20; fi
if systemctl is-active --quiet "$SERVICE"; then exit 20; fi
[[ "$(docker inspect -f '{{.State.Running}}' "$GATEWAY")" == false ]] || exit 20
[[ "$(docker inspect -f '{{.State.Running}}' "$SERVER")" == true ]] || exit 20

out="$("$PULL" pull)"
printf '%s\n' "$out"
printf '%s\n' "$out" | grep -Fxq 'CF_RUNTIME_CONTROL_MIRROR=updated'
printf '%s\n' "$out" | grep -Fxq 'CF_PULL_NO_CHANGE'
[[ "$(git hash-object "$CONTROL")" == "$TARGET_CONTROL" ]]
[[ "$(tr -d '\r\n' < "$MIRROR_BLOB")" == "$TARGET_CONTROL" ]]
python3 - "$CONTROL" <<'PY'
import json,sys
x=json.load(open(sys.argv[1])); a=x["authority"]; g=a["productionGuard"]; v=a["planes"]["vps-fabric"]
assert x["controlRevision"]==553 and a["productionEpoch"]==24
assert a["mode"]=="VPS_PRODUCTION" and a["materialAuthority"]=="vps-fabric"
assert v["releaseSequence"]==73 and v["releaseId"]=="onshape-vps-hardened-production-r8"
assert g["generation"]==8 and g["killSwitch"]=="OPEN"
assert g["allowedDocumentIds"]==["9c19201d51bb3d73a1833128"]
assert g["mutationBudget"]["budgetId"]=="e9-mate-reference-copy-r8-20260926"
assert g["mutationBudget"]["maxMutations"]==1
assert x["lease"]["state"]=="FREE" and a["reconciliationHold"]["active"] is False
print("CF_E9_MATE_COPY_GUARD=open-source-only-budget1")
PY
ponr="$("$ROLLBACK_GUARD" decide --db "$DB" --control "$CONTROL" --quarantine "$QUARANTINE")"
printf '%s\n' "$ponr" | grep -Fxq 'CF_A4_UNRESOLVED_BLOCKING=0'
printf '%s\n' "$ponr" | grep -Fxq 'CF_A4_ZERO_UNRESOLVED=pass'

exec 9>"$LOCK"
flock -w 30 9 || exit 21
restore=yes
cleanup(){
  rc=$?
  set +e
  if [[ "$restore" == yes && ! -e "$GATE" ]]; then
    tmp="$GATE.tmp.e9matecopy.$$"; printf '%s\n' RELEASE_IN_PROGRESS >"$tmp"; chmod 0600 "$tmp"; chown root:root "$tmp"; mv -f "$tmp" "$GATE"
  fi
  systemctl stop "$TIMER" >/dev/null 2>&1 || true
  docker stop "$GATEWAY" >/dev/null 2>&1 || true
  exit "$rc"
}
trap cleanup EXIT
rm -f "$GATE"
echo CF_E9_MATE_COPY_LOCAL_WINDOW=open

docker exec -e CF_SOURCE_DID="$SOURCE_DID" -e CF_SOURCE_WID="$SOURCE_WID" -e CF_COPY_NAME="$COPY_NAME" -i "$SERVER" sh -lc 'cd /tmp/app && node --input-type=module' <<'NODE'
import fs from "node:fs";
import {Client} from "@modelcontextprotocol/sdk/client/index.js";
import {StreamableHTTPClientTransport} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
const DID=process.env.CF_SOURCE_DID,WID=process.env.CF_SOURCE_WID,NAME=process.env.CF_COPY_NAME;
const token=fs.readFileSync("/run/secrets/mcp-token","utf8").trim();
const c=new Client({name:"cf-e9-mate-copy",version:"1.0.0"});
await c.connect(new StreamableHTTPClientTransport(new URL("http://127.0.0.1:8788/mcp/"+token)));
const parse=res=>{
 const raw=(res?.content||[]).filter(x=>x.type==="text").map(x=>x.text||"").join("\n");
 if(!raw) throw new Error("empty tool response");
 return JSON.parse(raw);
};
const pool=parse(await c.callTool({name:"onshape_pool_status",arguments:{}}));
if(pool?.build_id!=="onshape-vps-hardened-r8"||pool?.pool_enabled!==true||pool?.size!==3||pool?.active_count!==0||pool?.queued_count!==0||pool?.document_lock_count!==0) throw new Error("r8 pool not ready");
for(const s of pool.sessions||[]) if(s?.auth?.state!=="PROVEN") throw new Error("session not PROVEN "+s?.session_id);
console.log("CF_E9_MATE_COPY_POOL=3-of-3-PROVEN-idle");
const wrap=parse(await c.callTool({name:"onshape_fabric_invoke",arguments:{
 capability_id:"onshape.documented.operation",
 arguments:{operationId:"copyWorkspace",pathParams:{did:DID,wid:WID},query:{},body:{newName:NAME,isPublic:false}}
}}));
const r=wrap?.result,e=r?.observation?.evidence||{},v=e.verification||{};
console.log("CF_E9_MATE_COPY_RESULT="+JSON.stringify({outcome:r?.outcome,evidence:e}));
if(r?.outcome?.state!=="ACHIEVED") throw new Error("copy outcome "+String(r?.outcome?.state));
if(e.httpStatus!==200||e.effectSent!==true||e.postconditionVerified!==true) throw new Error("copy verification");
if(e.apiVersion!=="v17"||e.observedApiVersion!=="v17"||e.apiVersionMatched!==true) throw new Error("copy version");
if(!/^[0-9a-f]{24}$/i.test(String(v.newDocumentId||""))||!/^[0-9a-f]{24}$/i.test(String(v.newWorkspaceId||""))) throw new Error("copy ids");
if(v.observedDocumentId!==v.newDocumentId||v.observedWorkspaceId!==v.newWorkspaceId||v.observedName!==NAME||v.expectedName!==NAME||v.readbackHttpStatus!==200) throw new Error("copy readback");
console.log("CF_E9_MATE_COPY_DID="+v.newDocumentId);
console.log("CF_E9_MATE_COPY_WID="+v.newWorkspaceId);
console.log("CF_E9_MATE_COPY_NAME="+NAME);
console.log("CF_E9_MATE_COPY_API_VERSION_MATCHED=true");
console.log("CF_E9_MATE_COPY=pass");
await c.close();
NODE

tmp="$GATE.tmp.e9matecopy.$$"; printf '%s\n' RELEASE_IN_PROGRESS >"$tmp"; chmod 0600 "$tmp"; chown root:root "$tmp"; mv -f "$tmp" "$GATE"
restore=no
trap - EXIT
ponr2="$("$ROLLBACK_GUARD" decide --db "$DB" --control "$CONTROL" --quarantine "$QUARANTINE")"
printf '%s\n' "$ponr2" | grep -Fxq 'CF_A4_UNRESOLVED_BLOCKING=0'
printf '%s\n' "$ponr2" | grep -Fxq 'CF_A4_ZERO_UNRESOLVED=pass'
echo CF_E9_MATE_COPY_GATE=active
echo CF_E9_MATE_COPY_GATEWAY=stopped
echo CF_E9_MATE_COPY_WORKFLOW=pass
