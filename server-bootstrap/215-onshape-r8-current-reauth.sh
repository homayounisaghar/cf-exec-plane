#!/usr/bin/env bash
set -euo pipefail
umask 077
[[ "$(id -u)" -eq 0 ]] || exit 2
ACTIVE=/opt/capability-fabric/current
CONTROL=/var/lib/capability-fabric/onshape/runtime-control/ONSHAPE_RUNTIME_CONTROL.json
STATE=/var/lib/capability-fabric/state
GATE="$STATE/release-in-progress"
LOCK=/run/lock/capability-fabric-pull.lock
TIMER=capability-fabric-pull.timer
SERVICE=capability-fabric-pull.service
GATEWAY=capability-fabric-onshape-gateway
SERVER=capability-fabric-onshape-server
EXPECTED_CONTROL=d8378b345474a9aaca1a9e605d7578e47b23772d
EXPECTED_MANIFEST=08873ac1a6830ed42f15ebe340604ed6ffea33b8e7cb12b3a192982f3dcd6e9c

[[ "$(basename "$(readlink -f "$ACTIVE")")" == "onshape-vps-hardened-production-r8" ]] || exit 20
[[ "$(sha256sum "$(readlink -f "$ACTIVE")/manifest.json" | awk '{print $1}')" == "$EXPECTED_MANIFEST" ]] || exit 20
[[ "$(git hash-object "$CONTROL")" == "$EXPECTED_CONTROL" ]] || exit 20
[[ ! -e "$GATE" ]] || exit 20
systemctl is-active --quiet "$TIMER"
[[ "$(docker inspect -f '{{.State.Running}}' "$GATEWAY")" == true ]]
[[ "$(docker inspect -f '{{.State.Running}}' "$SERVER")" == true ]]
if systemctl is-active --quiet "$SERVICE"; then exit 20; fi
python3 - "$CONTROL" <<'PY'
import json,sys
x=json.load(open(sys.argv[1])); a=x["authority"]; g=a["productionGuard"]
assert x["controlRevision"]==554 and a["productionEpoch"]==25
assert a["mode"]=="VPS_PRODUCTION" and a["materialAuthority"]=="vps-fabric"
assert a["planes"]["vps-fabric"]["releaseSequence"]==73
assert a["planes"]["vps-fabric"]["releaseId"]=="onshape-vps-hardened-production-r8"
assert x["lease"]["state"]=="FREE" and a["reconciliationHold"]["active"] is False
assert g["killSwitch"]=="ENGAGED" and g["allowedDocumentIds"]==[] and g["mutationBudget"]["maxMutations"]==0
PY

exec 9>"$LOCK"
flock -w 30 9 || exit 21
finished=no
cleanup(){ rc=$?; set +e; if [[ "$finished" != yes ]]; then
  if [[ ! -e "$GATE" ]]; then tmp="$GATE.tmp.r8recover.$$"; printf '%s\n' RELEASE_IN_PROGRESS >"$tmp"; chmod 600 "$tmp"; chown root:root "$tmp"; mv "$tmp" "$GATE"; fi
  systemctl stop "$TIMER" >/dev/null 2>&1 || true
  docker stop "$GATEWAY" >/dev/null 2>&1 || true
fi; exit "$rc"; }
trap cleanup EXIT

systemctl stop "$TIMER"
docker stop "$GATEWAY" >/dev/null
tmp="$GATE.tmp.r8recover.$$"; printf '%s\n' RELEASE_IN_PROGRESS >"$tmp"; chmod 600 "$tmp"; chown root:root "$tmp"; mv "$tmp" "$GATE"
rm -f "$GATE"

set +e
docker exec -i "$SERVER" sh -lc 'cd /tmp/app && node --input-type=module' <<'NODE'
import fs from "node:fs";
import {Client} from "@modelcontextprotocol/sdk/client/index.js";
import {StreamableHTTPClientTransport} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
const token=fs.readFileSync("/run/secrets/mcp-token","utf8").trim();
const c=new Client({name:"cf-r8-current-reauth",version:"1.0.0"});
await c.connect(new StreamableHTTPClientTransport(new URL("http://127.0.0.1:8788/mcp/"+token)));
const parse=res=>JSON.parse((res?.content||[]).filter(x=>x.type==="text").map(x=>x.text||"").join("\n"));
const tool=async(name,args={})=>parse(await c.callTool({name,arguments:args}));
const wait=async(id,sid)=>{
 for(let i=0;i<120;i++){
  const v=await tool("onshape_operation_status",{operation_id:id});
  const op=v.result||v,s=String(op.status||v.status||"");
  if(s==="AWAITING_INPUT"){console.log("CF_R8_CURRENT_REAUTH_AWAITING="+sid);return 42;}
  if(s==="FAILED") throw new Error("reauth failed "+sid+" "+JSON.stringify(v));
  if(s==="SUCCEEDED") return 0;
  await new Promise(r=>setTimeout(r,1000));
 }
 throw new Error("reauth timeout "+sid);
};
let p=await tool("onshape_pool_status",{});
console.log("CF_R8_CURRENT_REAUTH_PRE="+JSON.stringify(p));
if(p.build_id!=="onshape-vps-hardened-r8"||p.active_count!==0||p.queued_count!==0||p.document_lock_count!==0) throw new Error("pool busy/wrong build");
for(const sid of ["session-1","session-2","session-3"]){
 const start=await tool("onshape_pool_session_reauth",{session_id:sid});
 const id=start.operation_id||start?.result?.operation_id;
 if(!id) throw new Error("no op "+sid);
 const rc=await wait(id,sid);
 if(rc===42){await c.close();process.exit(42);}
 p=await tool("onshape_pool_status",{});
 const s=(p.sessions||[]).find(x=>x.session_id===sid);
 if(s?.auth?.state!=="PROVEN") throw new Error(sid+" not proven");
 console.log("CF_R8_CURRENT_REAUTH_SESSION="+sid+"=PROVEN");
}
p=await tool("onshape_pool_status",{});
if(p.pool_enabled!==true||p.warming!==false||p.size!==3||p.active_count!==0||p.queued_count!==0||p.document_lock_count!==0) throw new Error("final pool");
if(p.material_mutator_session_id!=="session-1"||p.session_fingerprints_distinct!==true) throw new Error("identity");
for(const s of p.sessions||[]) if(s?.auth?.state!=="PROVEN") throw new Error("auth "+s.session_id);
console.log("CF_R8_CURRENT_REAUTH_FINAL=3-of-3-PROVEN-idle");
await c.close();
NODE
rc=$?
set -e
if [[ "$rc" -eq 42 ]]; then tmp="$GATE.tmp.r8recover.$$"; printf '%s\n' RELEASE_IN_PROGRESS >"$tmp"; chmod 600 "$tmp"; chown root:root "$tmp"; mv "$tmp" "$GATE"; exit 42; fi
[[ "$rc" -eq 0 ]]

systemctl start "$TIMER"
docker start "$GATEWAY" >/dev/null
[[ ! -e "$GATE" ]]
systemctl is-active --quiet "$TIMER"
[[ "$(docker inspect -f '{{.State.Running}}' "$GATEWAY")" == true ]]
finished=yes
trap - EXIT
echo CF_R8_CURRENT_REAUTH=pass
