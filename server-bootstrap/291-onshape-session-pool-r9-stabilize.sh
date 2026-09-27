#!/usr/bin/env bash
set -euo pipefail
umask 077
STATE=/var/lib/capability-fabric/state
CONTROL=/var/lib/capability-fabric/onshape/runtime-control/ONSHAPE_RUNTIME_CONTROL.json
GATE="$STATE/release-in-progress"
TIMER=capability-fabric-pull.timer
SERVICE=capability-fabric-pull.service
GATEWAY=capability-fabric-onshape-gateway
SERVER=capability-fabric-onshape-server

# Re-establish maintenance boundary before touching authentication state.
systemctl stop "$TIMER" >/dev/null 2>&1 || true
for _ in $(seq 1 30); do systemctl is-active --quiet "$SERVICE" || break; sleep 1; done
! systemctl is-active --quiet "$SERVICE"
docker stop "$GATEWAY" >/dev/null 2>&1 || true
tmp="$GATE.tmp.r9-stabilize.$$"; printf "%s\n" RELEASE_IN_PROGRESS >"$tmp"; chmod 0600 "$tmp"; chown root:root "$tmp"; mv -f "$tmp" "$GATE"

python3 - "$CONTROL" <<'PY'
import json,sys
d=json.load(open(sys.argv[1])); a=d["authority"]; v=a["planes"]["vps-fabric"]; g=a["productionGuard"]
assert d["controlRevision"]==557 and a["productionEpoch"]==28
assert a["mode"]=="QUIESCED_RECONCILING" and a["materialAuthority"] is None
assert v["ingress"]=="CLOSED" and v["materialEffectsAllowed"] is False
assert v["releaseSequence"]==74 and v["releaseId"]=="onshape-vps-hardened-r9"
assert d["lease"]["state"]=="FREE" and a["reconciliationHold"]["active"] is False
assert g["killSwitch"]=="ENGAGED" and g["allowedDocumentIds"]==[] and g["mutationBudget"]["maxMutations"]==0
print("CF_R9_STABILIZE_AUTHORITY=quiesced")
PY

[[ "$(docker inspect -f '{{.State.Running}}' "$SERVER")" == true ]]
[[ "$(docker inspect -f '{{.State.Health.Status}}' "$SERVER")" == healthy ]]
[[ "$(docker inspect -f '{{.State.Running}}' "$GATEWAY")" == false ]]

docker exec -i "$SERVER" sh -lc 'cd /tmp/app && node --input-type=module' <<'NODE'
import fs from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
const token=fs.readFileSync("/run/secrets/mcp-token","utf8").trim();
const c=new Client({name:"cf-r9-stabilize",version:"1.0"});
await c.connect(new StreamableHTTPClientTransport(new URL("http://127.0.0.1:8788/mcp/"+token)));
const parse=r=>JSON.parse((r.content||[]).filter(x=>x.type==="text").map(x=>x.text||"").join("\n"));
const call=async(name,args={})=>parse(await c.callTool({name,arguments:args},undefined,{timeout:180000}));
try{
  let p=await call("onshape_pool_status");
  if(p.build_id!=="onshape-vps-hardened-r9"||p.size!==5) throw new Error("wrong r9 pool identity");
  if(!(p.pool_enabled===true && p.session_fingerprints_distinct===true && (p.sessions||[]).length===5 && p.sessions.every(x=>x?.auth?.state==="PROVEN"&&x?.auth?.http_status===200))){
    const started=await call("onshape_pool_warmup");
    const op=String(started.operation_id||"");
    if(!op) throw new Error("missing warmup operation");
    let terminal=null;
    for(let i=0;i<300;i++){
      const st=await call("onshape_operation_status",{operation_id:op});
      if(["SUCCEEDED","FAILED","AWAITING_INPUT"].includes(st.status)){terminal=st;break;}
      await new Promise(r=>setTimeout(r,1000));
    }
    if(!terminal) throw new Error("warmup timeout");
    if(terminal.status==="AWAITING_INPUT"){
      console.log("CF_R9_STABILIZE_INPUT_REQUIRED="+String(terminal.input_required||"UNKNOWN"));
      await c.close().catch(()=>{});
      process.exit(42);
    }
    if(terminal.status!=="SUCCEEDED") throw new Error("warmup failed "+JSON.stringify(terminal.error||terminal));
  }
  p=await call("onshape_pool_status");
  if(p.pool_enabled!==true||p.size!==5||p.session_fingerprints_distinct!==true) throw new Error("pool not enabled/distinct");
  if(p.active_count!==0||p.queued_count!==0||p.document_lock_count!==0) throw new Error("pool not idle");
  if((p.sessions||[]).length!==5||p.sessions.some(x=>x?.auth?.state!=="PROVEN"||x?.auth?.http_status!==200)) throw new Error("not 5/5 PROVEN");
  if(new Set(p.sessions.map(x=>x?.auth?.account_id).filter(Boolean)).size!==1) throw new Error("account mismatch");
  console.log("CF_R9_STABILIZE_POOL=5of5-PROVEN-idle");
  console.log("CF_R9_STABILIZE_NAV_LIMIT="+String(p.navigation_limit));
} finally { await c.close().catch(()=>{}); }
NODE
rc=$?
if (( rc == 42 )); then exit 42; fi
(( rc == 0 ))
[[ -f "$GATE" ]] && grep -Fxq RELEASE_IN_PROGRESS "$GATE"
[[ "$(docker inspect -f '{{.State.Running}}' "$GATEWAY")" == false ]]
! systemctl is-active --quiet "$TIMER"
echo CF_R9_STABILIZE=pass
