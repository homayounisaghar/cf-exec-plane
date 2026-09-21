#!/usr/bin/env bash
set -euo pipefail
umask 077

[[ "$(id -u)" -eq 0 ]] || { echo CF_CANARY_CLEANUP_REQUIRES_ROOT >&2; exit 2; }

gateway=capability-fabric-onshape-gateway
server=capability-fabric-onshape-server
active=/opt/capability-fabric/current
control=/var/lib/capability-fabric/onshape/runtime-control/ONSHAPE_RUNTIME_CONTROL.json
db=/var/lib/capability-fabric/onshape/fabric-state/execution.sqlite3
quarantine=/var/lib/capability-fabric/onshape/fabric-state/quarantine/D-018-attempt-f6d80f46.json
guard=/usr/local/libexec/capability-fabric-onshape-rollback-contract

blob=81f73bb89c5517080a80ada3047c58c287874c50
manifest=857b7ca6d5a6bcf79b820594801a4f88642fe9520dad1ae18fc064eae6073d7c
did=84d077d8370c21c4b3045263
wid=aa8c5ad631e1836645149d09
canary_name='Speedtest 2 - VPS CANARY'
original_name='Speedtest 2'
first_inv=invocation:3136dbe0-ded7-475d-979b-ee7c9bf6dc95
first_op=operation:3a454a8a-9d5e-491a-b13e-739c01d32d49
first_att=attempt:d425487d-17e0-4b4b-a811-439f76e5b796

[[ -L "$active" && -s "$control" && -s "$db" && -s "$quarantine" && -x "$guard" ]] || exit 20
[[ "$(sha256sum "$(readlink -f "$active")/manifest.json" | awk '{print $1}')" == "$manifest" ]] || exit 21
[[ "$(git hash-object "$control")" == "$blob" ]] || exit 22
[[ "$(docker inspect -f '{{.State.Running}}' "$server")" == true ]] || exit 23
[[ "$(docker inspect -f '{{.State.Running}}' "$gateway")" == false ]] || { echo CF_CANARY_CLEANUP_GATEWAY_NOT_CLOSED >&2; exit 24; }
echo CF_CANARY_CLEANUP_GATEWAY_PRE=stopped

python3 - "$control" "$manifest" <<'PY'
import json,sys
p,manifest=sys.argv[1:]
r=json.load(open(p)); a=r["authority"]; v=a["planes"]["vps-fabric"]; android=a["planes"]["android-v1"]
assert r["controlRevision"]==531
assert a["productionEpoch"]==3 and a["mode"]=="VPS_PRODUCTION" and a["materialAuthority"]=="vps-fabric"
assert android["ingress"]=="CLOSED" and android["materialEffectsAllowed"] is False
assert v["ingress"]=="ADMITTED" and v["materialEffectsAllowed"] is True
assert v["releaseSequence"]==66 and v["releaseId"]=="onshape-vps-hardened-production-r3"
assert v["manifestSha256"]==manifest
assert a["reconciliationHold"]["active"] is False
assert r["lease"]["state"]=="FREE"
print("CF_CANARY_CLEANUP_AUTHORITY=epoch3-exact")
print("CF_CANARY_CLEANUP_ANDROID=CLOSED")
print("CF_CANARY_CLEANUP_LEASE=FREE")
PY

python3 - "$db" "$quarantine" "$blob" "$did" "$wid" "$first_inv" "$first_op" "$first_att" <<'PY'
import json,sqlite3,sys
db,qpath,blob,did,wid,fi,fo,fa=sys.argv[1:]
q=json.load(open(qpath)); qa=q["attemptId"]; qo=q["operationId"]
c=sqlite3.connect(f"file:{db}?mode=ro",uri=True); c.row_factory=sqlite3.Row
rows=c.execute("""SELECT i.rowid,i.invocation_id,i.phase,i.dispatch_payload,
                         o.operation_id,o.state operation_state,o.outcome_payload,
                         a.attempt_id,a.state attempt_state,a.observation_payload
                  FROM invocations i JOIN operations o ON o.invocation_id=i.invocation_id
                  JOIN attempts a ON a.operation_id=o.operation_id
                  WHERE i.dispatch_payload IS NOT NULL ORDER BY i.rowid""").fetchall()
prod=[]
for r in rows:
    d=json.loads(r["dispatch_payload"]); ep=d.get("execution_payload") or {}; pa=(ep.get("preconditions") or {}).get("productionAuthority") or {}
    if ep.get("agentEffect")=="MUTATION" and pa.get("productionEpoch")==3 and pa.get("mode")=="VPS_PRODUCTION" and pa.get("materialAuthority")=="vps-fabric":
        prod.append((r,d))
assert len(prod)==1,[(r["operation_id"],r["attempt_id"]) for r,d in prod]
r,d=prod[0]
assert (r["invocation_id"],r["operation_id"],r["attempt_id"])==(fi,fo,fa)
assert r["phase"]=="RECONCILED" and r["operation_state"]=="ACHIEVED" and r["attempt_state"]=="OBSERVED"
ep=d["execution_payload"]; pre=ep["preconditions"]; mc=pre["mutationContract"]; obs=json.loads(r["observation_payload"]); ev=obs["evidence"]
assert d["target_id"]==f"onshape:document:{did}"
assert ep["args"]["operationId"]=="updateDocumentAttributes" and ep["args"]["pathParams"]["did"]==did
assert ep["args"]["body"]["name"]=="Speedtest 2 - VPS CANARY"
assert pre["productionAuthority"]["controlBlobSha"]==blob
assert mc["target"]["documentId"]==did and mc["target"]["workspaceId"]==wid
assert mc["postcondition"]=={"kind":"document_name_equals","value":"Speedtest 2 - VPS CANARY"}
assert ev["effectSent"] is True and ev["postconditionVerified"] is True and ev["mutationSessionId"]=="session-1"
assert ev["verification"]["observedName"]=="Speedtest 2 - VPS CANARY"
unresolved=c.execute("""SELECT i.phase,o.operation_id,o.state operation_state,a.attempt_id,a.state attempt_state
  FROM invocations i LEFT JOIN operations o ON o.invocation_id=i.invocation_id
  LEFT JOIN attempts a ON a.operation_id=o.operation_id
  WHERE i.phase IN ('DISPATCH_FINALIZED','DISPATCH_INTENT','OBSERVED')
     OR o.state IN ('IN_FLIGHT','IN_DOUBT') OR a.state IN ('DISPATCH_INTENT','IN_DOUBT')""").fetchall()
blocking=[]
for x in unresolved:
    if x["operation_id"]==qo and x["attempt_id"]==qa: continue
    blocking.append(dict(x))
assert not blocking,blocking
print("CF_CANARY_CLEANUP_FIRST_MUTATION=terminal-achieved")
print("CF_CANARY_CLEANUP_BLOCKING_UNRESOLVED_PRE=0")
c.close()
PY

ponr_pre="$(python3 "$guard" decide --db "$db" --control "$control" --quarantine "$quarantine")"
printf '%s\n' "$ponr_pre"
printf '%s\n' "$ponr_pre" | grep -Fxq 'CF_A4_PONR=true'
printf '%s\n' "$ponr_pre" | grep -Fxq 'CF_A4_PONR_COUNT=1'
printf '%s\n' "$ponr_pre" | grep -Fxq "CF_A4_FIRST_PRODUCTION_MUTATION_OPERATION=$first_op"
printf '%s\n' "$ponr_pre" | grep -Fxq "CF_A4_FIRST_PRODUCTION_MUTATION_ATTEMPT=$first_att"
printf '%s\n' "$ponr_pre" | grep -Fxq 'CF_A4_UNRESOLVED_BLOCKING=0'
echo CF_CANARY_CLEANUP_PONR_PRE=count1

safe_to_reopen=no
gateway_reopened=no
cleanup_trap() {
  rc=$?
  set +e
  if [[ "$gateway_reopened" != yes ]]; then
    if [[ "$safe_to_reopen" == yes ]]; then
      docker start "$gateway" >/dev/null 2>&1 || true
      echo CF_CANARY_CLEANUP_GATEWAY_TRAP_REOPEN=attempted
    else
      echo CF_CANARY_CLEANUP_FAIL_CLOSED_GATEWAY=left-stopped
    fi
  fi
  exit "$rc"
}
trap cleanup_trap EXIT

node_output="$(docker exec -i "$server" sh -lc 'cd /tmp/app && node --input-type=module' <<'NODE'
import fs from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const DID="84d077d8370c21c4b3045263";
const WID="aa8c5ad631e1836645149d09";
const CANARY="Speedtest 2 - VPS CANARY";
const ORIGINAL="Speedtest 2";
const token=fs.readFileSync("/run/secrets/mcp-token","utf8").trim();
const client=new Client({name:"cf-first-material-canary-cleanup",version:"1.0.0"});
const transport=new StreamableHTTPClientTransport(new URL("http://127.0.0.1:8788/mcp/"+token));
await client.connect(transport);

function parseTool(res){
  if(res?.isError===true) throw new Error("MCP tool returned isError");
  const raw=(res?.content||[]).filter(x=>x.type==="text").map(x=>x.text||"").join("\n");
  if(!raw) throw new Error("empty response");
  return JSON.parse(raw);
}
async function fabric(capabilityId,argsInput){
  const value=parseTool(await client.callTool({name:"onshape_fabric_invoke",arguments:{capability_id:capabilityId,arguments:argsInput}}));
  if(value.build_id!=="onshape-vps-hardened-r3"||value.public_surface!=="semantic-only"||value.qualification_only!==false) throw new Error("wrong live surface");
  return value.result;
}
async function readDoc(){
  const r=await fabric("onshape.documented.operation",{operationId:"getDocument",pathParams:{did:DID},query:{}});
  const ev=r?.observation?.evidence||{}, b=ev.body||{};
  if(r?.outcome?.state!=="ACHIEVED"||ev.httpStatus!==200||ev.effectSent!==false) throw new Error("read failed");
  if(b.id!==DID||b?.defaultWorkspace?.id!==WID) throw new Error("wrong target");
  return {name:b.name,microversion:b.defaultWorkspace.microversion};
}
const pool=parseTool(await client.callTool({name:"onshape_pool_status",arguments:{}}));
if(pool.pool_enabled!==true||pool.size!==3||pool.active_count!==0||pool.queued_count!==0||pool.document_lock_count!==0) throw new Error("pool not idle");
for(const s of pool.sessions||[]) if(s?.auth?.state!=="PROVEN") throw new Error("session not proven");
if(pool.material_mutator_session_id!=="session-1") throw new Error("wrong mutator");

const before=await readDoc();
if(before.name!==CANARY) throw new Error("cleanup prestate name mismatch");
console.log("CF_CANARY_CLEANUP_PRE_NAME="+before.name);
console.log("CF_CANARY_CLEANUP_OBSERVER_MICROVERSION="+before.microversion);

const r=await fabric("onshape.documented.operation",{
  operationId:"updateDocumentAttributes",
  pathParams:{did:DID},
  query:{},
  body:{name:ORIGINAL},
  verification:{kind:"document_name_equals",value:ORIGINAL}
});
if(r?.targetId!=="onshape:document:"+DID) throw new Error("wrong mutation target");
if(r?.capability?.effect!=="onshape.documented.operation.mutation") throw new Error("wrong effect");
if(r?.outcome?.state!=="ACHIEVED"||r?.observation?.ackState!=="ACKNOWLEDGED") throw new Error("cleanup not terminal achieved");
const ev=r?.observation?.evidence||{};
if(ev.effectSent!==true||ev.postconditionVerified!==true||ev.mutationSessionId!=="session-1") throw new Error("cleanup evidence invalid");
if(ev?.verification?.kind!=="document_name_equals"||ev.verification.expectedName!==ORIGINAL||ev.verification.observedName!==ORIGINAL) throw new Error("cleanup postcondition invalid");
if(!/^[0-9a-f]{24}$/i.test(String(ev.preMicroversion||""))) throw new Error("invalid same-session preMicroversion");
if(!/^[0-9a-f]{24}$/i.test(String(ev.postMicroversion||""))) throw new Error("invalid same-session postMicroversion");
console.log("CF_CANARY_CLEANUP_INVOCATION="+r.invocationId);
console.log("CF_CANARY_CLEANUP_OPERATION="+r.operationId);
console.log("CF_CANARY_CLEANUP_ATTEMPT="+r.attemptId);
console.log("CF_CANARY_CLEANUP_PRE_MICROVERSION="+ev.preMicroversion);
console.log("CF_CANARY_CLEANUP_POST_MICROVERSION="+ev.postMicroversion);
console.log("CF_CANARY_CLEANUP_POSTCONDITION=verified");

const after=await readDoc();
if(after.name!==ORIGINAL) throw new Error("independent final read did not restore name");
console.log("CF_CANARY_CLEANUP_FINAL_NAME="+after.name);
console.log("CF_CANARY_CLEANUP_FINAL_OBSERVER_MICROVERSION="+after.microversion);
console.log("CF_CANARY_CLEANUP_INDEPENDENT_READBACK=pass");
await client.close();
NODE
)"
printf '%s\n' "$node_output"

cleanup_inv="$(printf '%s\n' "$node_output" | awk -F= '$1=="CF_CANARY_CLEANUP_INVOCATION"{print $2}' | tail -n1)"
cleanup_op="$(printf '%s\n' "$node_output" | awk -F= '$1=="CF_CANARY_CLEANUP_OPERATION"{print $2}' | tail -n1)"
cleanup_att="$(printf '%s\n' "$node_output" | awk -F= '$1=="CF_CANARY_CLEANUP_ATTEMPT"{print $2}' | tail -n1)"
for x in "$cleanup_inv" "$cleanup_op" "$cleanup_att"; do [[ -n "$x" ]] || exit 40; done

python3 - "$db" "$quarantine" "$blob" "$did" "$wid" "$first_op" "$first_att" "$cleanup_inv" "$cleanup_op" "$cleanup_att" <<'PY'
import json,sqlite3,sys
db,qpath,blob,did,wid,fo,fa,ci,co,ca=sys.argv[1:]
q=json.load(open(qpath)); qa=q["attemptId"]; qo=q["operationId"]
c=sqlite3.connect(f"file:{db}?mode=ro",uri=True); c.row_factory=sqlite3.Row
rows=c.execute("""SELECT i.rowid,i.invocation_id,i.phase,i.dispatch_payload,
                         o.operation_id,o.state operation_state,o.outcome_payload,
                         a.attempt_id,a.state attempt_state,a.observation_payload
                  FROM invocations i JOIN operations o ON o.invocation_id=i.invocation_id
                  JOIN attempts a ON a.operation_id=o.operation_id
                  WHERE i.dispatch_payload IS NOT NULL ORDER BY i.rowid""").fetchall()
prod=[]
for r in rows:
    d=json.loads(r["dispatch_payload"]); ep=d.get("execution_payload") or {}; pa=(ep.get("preconditions") or {}).get("productionAuthority") or {}
    if ep.get("agentEffect")=="MUTATION" and pa.get("productionEpoch")==3 and pa.get("mode")=="VPS_PRODUCTION" and pa.get("materialAuthority")=="vps-fabric":
        prod.append((r,d))
assert len(prod)==2,[(r["operation_id"],r["attempt_id"]) for r,d in prod]
assert (prod[0][0]["operation_id"],prod[0][0]["attempt_id"])==(fo,fa)
r,d=prod[1]
assert (r["invocation_id"],r["operation_id"],r["attempt_id"])==(ci,co,ca)
assert r["phase"]=="RECONCILED" and r["operation_state"]=="ACHIEVED" and r["attempt_state"]=="OBSERVED"
ep=d["execution_payload"]; pre=ep["preconditions"]; pa=pre["productionAuthority"]; mc=pre["mutationContract"]
obs=json.loads(r["observation_payload"]); ev=obs["evidence"]; out=json.loads(r["outcome_payload"])
assert d["target_id"]==f"onshape:document:{did}"
assert ep["args"]["operationId"]=="updateDocumentAttributes" and ep["args"]["pathParams"]["did"]==did
assert ep["args"]["body"]["name"]=="Speedtest 2"
assert pa["productionEpoch"]==3 and pa["controlBlobSha"]==blob and pa["controlRevision"]==531 and pa["releaseSequence"]==66
assert mc["target"]["documentId"]==did and mc["target"]["workspaceId"]==wid
assert mc["postcondition"]=={"kind":"document_name_equals","value":"Speedtest 2"}
assert mc["observation"]["sameSessionRequired"] is True
assert mc["recovery"]["blindReplayAllowed"] is False
assert obs["ack_state"]=="ACKNOWLEDGED" and out["state"]=="ACHIEVED"
assert ev["effectSent"] is True and ev["postconditionVerified"] is True and ev["mutationSessionId"]=="session-1"
assert ev["verification"]["observedName"]=="Speedtest 2"
kinds={x[0] for x in c.execute("SELECT kind FROM events WHERE entity_id IN (?,?,?)",(ci,co,ca)).fetchall()}
for k in ("state.dispatch.persisted","operation.begun","attempt.observed","operation.reconciled"): assert k in kinds,k
unresolved=c.execute("""SELECT i.phase,o.operation_id,o.state operation_state,a.attempt_id,a.state attempt_state
  FROM invocations i LEFT JOIN operations o ON o.invocation_id=i.invocation_id
  LEFT JOIN attempts a ON a.operation_id=o.operation_id
  WHERE i.phase IN ('DISPATCH_FINALIZED','DISPATCH_INTENT','OBSERVED')
     OR o.state IN ('IN_FLIGHT','IN_DOUBT') OR a.state IN ('DISPATCH_INTENT','IN_DOUBT')""").fetchall()
blocking=[]
for x in unresolved:
    if x["operation_id"]==qo and x["attempt_id"]==qa: continue
    blocking.append(dict(x))
assert not blocking,blocking
assert str(c.execute("PRAGMA integrity_check").fetchone()[0]).lower()=="ok"
print("CF_CANARY_CLEANUP_PROVENANCE=pass")
print("CF_CANARY_CLEANUP_EFFECTIVE_UNRESOLVED_POST=0")
print("CF_CANARY_CLEANUP_SQLITE=clean")
c.close()
PY

ponr_post="$(python3 "$guard" decide --db "$db" --control "$control" --quarantine "$quarantine")"
printf '%s\n' "$ponr_post"
printf '%s\n' "$ponr_post" | grep -Fxq 'CF_A4_PONR=true'
printf '%s\n' "$ponr_post" | grep -Fxq 'CF_A4_PONR_COUNT=2'
printf '%s\n' "$ponr_post" | grep -Fxq "CF_A4_FIRST_PRODUCTION_MUTATION_OPERATION=$first_op"
printf '%s\n' "$ponr_post" | grep -Fxq "CF_A4_FIRST_PRODUCTION_MUTATION_ATTEMPT=$first_att"
printf '%s\n' "$ponr_post" | grep -Fxq 'CF_A4_UNRESOLVED_BLOCKING=0'
printf '%s\n' "$ponr_post" | grep -Fxq 'CF_A4_ZERO_UNRESOLVED=pass'
printf '%s\n' "$ponr_post" | grep -Fxq 'CF_A4_ROLLBACK_DIRECTIVE=ROLLBACK_ALLOWED'
echo CF_CANARY_CLEANUP_PONR_POST=count2
echo CF_CANARY_CLEANUP_ZERO_UNRESOLVED=pass

safe_to_reopen=yes
docker start "$gateway" >/dev/null
gateway_reopened=yes
[[ "$(docker inspect -f '{{.State.Running}}' "$gateway")" == true ]]
echo CF_CANARY_CLEANUP_GATEWAY_POST=reopened
trap - EXIT
echo CF_CANARY_CLEANUP=pass
