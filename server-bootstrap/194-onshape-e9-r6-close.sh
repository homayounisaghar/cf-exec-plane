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
LOCK=/run/lock/capability-fabric-pull.lock
TIMER=capability-fabric-pull.timer
SERVICE=capability-fabric-pull.service
PULL=/usr/local/libexec/capability-fabric-pull-agent
GATEWAY=capability-fabric-onshape-gateway
SERVER=capability-fabric-onshape-server
DB=/var/lib/capability-fabric/onshape/fabric-state/execution.sqlite3
AGENT_DIR=/var/lib/capability-fabric/onshape/fabric-agent
QUARANTINE=/var/lib/capability-fabric/onshape/fabric-state/quarantine/D-018-attempt-f6d80f46.json
ROLLBACK_GUARD=/usr/local/libexec/capability-fabric-onshape-rollback-contract
PREV_CONTROL=6cb53be6a1ee38372b942421f78722853a3bb032
TARGET_CONTROL=b526a61c5af2c054cbde6411f49c51f96982acc7
EXPECTED_MANIFEST=e64a1053c02a5abf6becd09275b91768f8642a724c7f0db6d4106a8cbe19583f
DID=8ca702971e2419cfa45cc87c
WID=8bbf262de8f6c2015d72fd7d
EID=dc6eb5c8b694395c14024558
FID=FwHDp7GXelUCXDl_0

[[ "$(basename "$(readlink -f "$ACTIVE")")" == "onshape-vps-hardened-production-r6" ]] || exit 20
[[ "$(basename "$(readlink -f "$PREVIOUS")")" == "onshape-vps-hardened-production-r5" ]] || exit 20
[[ "$(cat "$STATE/last-good-sequence")" == "71" ]] || exit 20
[[ "$(cat "$STATE/last-good-release")" == "onshape-vps-hardened-production-r6" ]] || exit 20
[[ "$(sha256sum "$(readlink -f "$ACTIVE")/manifest.json" | awk '{print $1}')" == "$EXPECTED_MANIFEST" ]] || exit 20
[[ "$(git hash-object "$CONTROL")" == "$PREV_CONTROL" ]] || exit 20
[[ "$(tr -d '\r\n' < "$MIRROR_BLOB")" == "$PREV_CONTROL" ]] || exit 20
[[ -f "$GATE" ]] && grep -Fxq RELEASE_IN_PROGRESS "$GATE"
systemctl stop "$TIMER" || true
if systemctl is-active --quiet "$TIMER"; then exit 20; fi
if systemctl is-active --quiet "$SERVICE"; then exit 20; fi
[[ "$(docker inspect -f '{{.State.Running}}' "$GATEWAY")" == false ]] || exit 20

out="$("$PULL" pull)"
printf '%s\n' "$out"
printf '%s\n' "$out" | grep -Fxq 'CF_RUNTIME_CONTROL_MIRROR=updated'
printf '%s\n' "$out" | grep -Fxq 'CF_PULL_NO_CHANGE'
[[ "$(git hash-object "$CONTROL")" == "$TARGET_CONTROL" ]]
[[ "$(tr -d '\r\n' < "$MIRROR_BLOB")" == "$TARGET_CONTROL" ]]

python3 - "$CONTROL" <<'PY'
import json,sys
x=json.load(open(sys.argv[1])); a=x["authority"]; g=a["productionGuard"]; v=a["planes"]["vps-fabric"]
assert x["controlRevision"]==548 and a["productionEpoch"]==19
assert a["mode"]=="VPS_PRODUCTION" and a["materialAuthority"]=="vps-fabric"
assert v["releaseSequence"]==71 and v["releaseId"]=="onshape-vps-hardened-production-r6"
assert v["manifestSha256"]=="e64a1053c02a5abf6becd09275b91768f8642a724c7f0db6d4106a8cbe19583f"
assert g["generation"]==7 and g["killSwitch"]=="ENGAGED"
assert g["allowedDocumentIds"]==[] and g["mutationBudget"]=={"budgetId":"e9-r6-slice-a-complete-closed","maxMutations":0}
assert x["lease"]["state"]=="FREE" and a["reconciliationHold"]["active"] is False
print("CF_E9_CLOSE19_AUTHORITY=epoch19-seq71-r6")
print("CF_E9_CLOSE19_GUARD=engaged-empty-zero")
PY

python3 - "$AGENT_DIR" <<'PY'
import json,pathlib,sys
root=pathlib.Path(sys.argv[1])
rows=[]
for p in root.rglob("*.json"):
 try:v=json.loads(p.read_text())
 except Exception: continue
 if isinstance(v,dict) and v.get("budgetId")=="e9-selector-durability-r6-slice-a-20260925":
  rows.append(v)
assert len(rows)==2,rows
slots=sorted(int(x["slot"]) for x in rows)
assert slots==[1,2],slots
print("CF_E9_CLOSE19_OLD_BUDGET_RESERVATIONS=2")
PY

ponr="$("$ROLLBACK_GUARD" decide --db "$DB" --control "$CONTROL" --quarantine "$QUARANTINE")"
printf '%s\n' "$ponr"
printf '%s\n' "$ponr" | grep -Fxq 'CF_A4_PONR_COUNT=6'
printf '%s\n' "$ponr" | grep -Fxq 'CF_A4_UNRESOLVED_BLOCKING=0'
printf '%s\n' "$ponr" | grep -Fxq 'CF_A4_ZERO_UNRESOLVED=pass'
echo CF_E9_CLOSE19_SAFETY_PRE=pass

exec 9>"$LOCK"
flock -w 30 9 || exit 21
finished=no
cleanup(){
 rc=$?
 set +e
 if [[ "$finished" != yes ]]; then
   if [[ ! -e "$GATE" ]]; then
     tmp="$GATE.tmp.e9close.$$"; printf '%s\n' RELEASE_IN_PROGRESS >"$tmp"; chmod 0600 "$tmp"; chown root:root "$tmp"; mv -f "$tmp" "$GATE"
   fi
   systemctl stop "$TIMER" >/dev/null 2>&1 || true
   docker stop "$GATEWAY" >/dev/null 2>&1 || true
 fi
 exit "$rc"
}
trap cleanup EXIT

rm -f "$GATE"
docker exec -e CF_DID="$DID" -e CF_WID="$WID" -e CF_EID="$EID" -e CF_FID="$FID" -i "$SERVER" sh -lc 'cd /tmp/app && node --input-type=module' <<'NODE'
import fs from "node:fs";
import {Client} from "@modelcontextprotocol/sdk/client/index.js";
import {StreamableHTTPClientTransport} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
const DID=process.env.CF_DID,WID=process.env.CF_WID,EID=process.env.CF_EID,FID=process.env.CF_FID;
const token=fs.readFileSync("/run/secrets/mcp-token","utf8").trim();
const c=new Client({name:"cf-e9-close19",version:"1.0.0"});
await c.connect(new StreamableHTTPClientTransport(new URL("http://127.0.0.1:8788/mcp/"+token)));
const parse=r=>JSON.parse((r?.content||[]).filter(x=>x.type==="text").map(x=>x.text||"").join("\n"));
const pool=parse(await c.callTool({name:"onshape_pool_status",arguments:{}}));
if(pool?.build_id!=="onshape-vps-hardened-r6"||pool?.pool_enabled!==true||pool?.size!==3||pool?.active_count!==0||pool?.queued_count!==0||pool?.document_lock_count!==0) throw new Error("pool");
for(const s of pool.sessions||[]) if(s?.auth?.state!=="PROVEN") throw new Error("auth");
console.log("CF_E9_CLOSE19_POOL=3-of-3-PROVEN-idle");
const wrap=parse(await c.callTool({name:"onshape_fabric_invoke",arguments:{capability_id:"onshape.documented.operation",arguments:{
 operationId:"getPartStudioFeatures",pathParams:{did:DID,wvm:"w",wvmid:WID,eid:EID},query:{}
}}}));
const r=wrap?.result,e=r?.observation?.evidence||{},b=e.body||{};
if(r?.outcome?.state!=="ACHIEVED"||e.httpStatus!==200||e.effectSent!==false) throw new Error("read");
if(e.apiVersion!=="v17"||e.observedApiVersion!=="v17"||e.apiVersionMatched!==true) throw new Error("version");
const f=(b.features||[]).find(x=>x.featureId===FID);
if(!f) throw new Error("feature");
const depth=String((f.parameters||[]).find(p=>p.parameterId==="depth")?.expression||"");
if(depth!=="25 mm") throw new Error("depth "+depth);
if(b?.featureStates?.[FID]?.featureStatus!=="OK") throw new Error("feature status");
console.log("CF_E9_CLOSE19_DEPTH=25-mm");
console.log("CF_E9_CLOSE19_FEATURE_STATUS=OK");
console.log("CF_E9_CLOSE19_READ=pass");
await c.close();
NODE

ponr2="$("$ROLLBACK_GUARD" decide --db "$DB" --control "$CONTROL" --quarantine "$QUARANTINE")"
printf '%s\n' "$ponr2" | grep -Fxq 'CF_A4_PONR_COUNT=6'
printf '%s\n' "$ponr2" | grep -Fxq 'CF_A4_UNRESOLVED_BLOCKING=0'

systemctl start "$TIMER"
systemctl is-active --quiet "$TIMER"
docker start "$GATEWAY" >/dev/null
[[ "$(docker inspect -f '{{.State.Running}}' "$GATEWAY")" == true ]]
[[ ! -e "$GATE" ]]
finished=yes
trap - EXIT
echo CF_E9_CLOSE19_RELEASE_GATE=clear
echo CF_E9_CLOSE19_PULL_TIMER=active
echo CF_E9_CLOSE19_GATEWAY=running
echo CF_E9_CLOSE19=pass
