#!/usr/bin/env bash
set -euo pipefail
umask 077

[[ "$(id -u)" -eq 0 ]] || { echo CF_CANARY_REQUIRES_ROOT >&2; exit 2; }

gateway=capability-fabric-onshape-gateway
server=capability-fabric-onshape-server
active=/opt/capability-fabric/current
control=/var/lib/capability-fabric/onshape/runtime-control/ONSHAPE_RUNTIME_CONTROL.json
db=/var/lib/capability-fabric/onshape/fabric-state/execution.sqlite3
quarantine=/var/lib/capability-fabric/onshape/fabric-state/quarantine/D-018-attempt-f6d80f46.json
guard=/usr/local/libexec/capability-fabric-onshape-rollback-contract

expected_control_blob=81f73bb89c5517080a80ada3047c58c287874c50
expected_manifest=857b7ca6d5a6bcf79b820594801a4f88642fe9520dad1ae18fc064eae6073d7c
canary_document=84d077d8370c21c4b3045263
canary_workspace=aa8c5ad631e1836645149d09
original_name='Speedtest 2'
canary_name='Speedtest 2 - VPS CANARY'

[[ -L "$active" && -s "$control" && -s "$db" && -s "$quarantine" && -x "$guard" ]] || exit 20
[[ ! -e /var/lib/capability-fabric/state/release-in-progress ]] || { echo CF_CANARY_RELEASE_GATE=active >&2; exit 21; }
[[ "$(sha256sum "$(readlink -f "$active")/manifest.json" | awk '{print $1}')" == "$expected_manifest" ]] || exit 22
[[ "$(git hash-object "$control")" == "$expected_control_blob" ]] || exit 23
[[ "$(docker inspect -f '{{.State.Running}}' "$server")" == true ]] || exit 24
gateway_initial="$(docker inspect -f '{{.State.Running}}' "$gateway")"
[[ "$gateway_initial" == true || "$gateway_initial" == false ]] || exit 25

python3 - "$control" "$expected_control_blob" "$expected_manifest" <<'PY'
import json,sys
p,blob,manifest=sys.argv[1:]
r=json.load(open(p))
a=r["authority"]; v=a["planes"]["vps-fabric"]; android=a["planes"]["android-v1"]
assert r["controlRevision"]==531
assert a["productionEpoch"]==3
assert a["mode"]=="VPS_PRODUCTION"
assert a["materialAuthority"]=="vps-fabric"
assert android["ingress"]=="CLOSED" and android["materialEffectsAllowed"] is False
assert v["ingress"]=="ADMITTED" and v["materialEffectsAllowed"] is True
assert v["releaseSequence"]==66
assert v["releaseId"]=="onshape-vps-hardened-production-r3"
assert v["manifestSha256"]==manifest
assert a["reconciliationHold"]["active"] is False
assert r["lease"]["state"]=="FREE"
print("CF_CANARY_AUTHORITY_PRE=epoch3-vps-production")
print("CF_CANARY_ANDROID_PRE=CLOSED")
print("CF_CANARY_LEASE_PRE=FREE")
PY

python3 - "$db" "$quarantine" <<'PY'
import json,sqlite3,sys
db,qpath=sys.argv[1:]
q=json.load(open(qpath)); qa=q["attemptId"]; qo=q["operationId"]
c=sqlite3.connect(f"file:{db}?mode=ro",uri=True); c.row_factory=sqlite3.Row
try:
    assert str(c.execute("PRAGMA integrity_check").fetchone()[0]).lower()=="ok"
    rows=c.execute("""SELECT i.phase,o.operation_id,o.state operation_state,a.attempt_id,a.state attempt_state
      FROM invocations i LEFT JOIN operations o ON o.invocation_id=i.invocation_id
      LEFT JOIN attempts a ON a.operation_id=o.operation_id
      WHERE i.phase IN ('DISPATCH_FINALIZED','DISPATCH_INTENT','OBSERVED')
         OR o.state IN ('IN_FLIGHT','IN_DOUBT')
         OR a.state IN ('DISPATCH_INTENT','IN_DOUBT')""").fetchall()
    blocking=[]
    for r in rows:
        if r["operation_id"]==qo and r["attempt_id"]==qa:
            continue
        blocking.append(dict(r))
    assert not blocking,blocking
    print("CF_CANARY_SQLITE_PRE=clean")
    print("CF_CANARY_EFFECTIVE_UNRESOLVED_PRE=0")
finally:
    c.close()
PY

# One-shot blast-radius fence: make external semantic ingress unavailable while
# the only local caller below is hard-bound to the exact canary document.
if [[ "$gateway_initial" == true ]]; then
  docker stop "$gateway" >/dev/null
  echo CF_CANARY_PUBLIC_GATEWAY=stopped
else
  echo CF_CANARY_PUBLIC_GATEWAY=already-stopped
fi
[[ "$(docker inspect -f '{{.State.Running}}' "$gateway")" == false ]]
safe_to_reopen=no
gateway_reopened=no
cleanup() {
  rc=$?
  set +e
  if [[ "$gateway_reopened" != yes ]]; then
    if [[ "$safe_to_reopen" == yes ]]; then
      docker start "$gateway" >/dev/null 2>&1 || true
      echo CF_CANARY_GATEWAY_TRAP_REOPEN=attempted
    else
      echo CF_CANARY_FAIL_CLOSED_GATEWAY=left-stopped
    fi
  fi
  exit "$rc"
}
trap cleanup EXIT

node_output="$(docker exec -i "$server" sh -lc 'cd /tmp/app && node --input-type=module' <<'NODE'
import fs from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const DID="84d077d8370c21c4b3045263";
const WID="aa8c5ad631e1836645149d09";
const ORIGINAL="Speedtest 2";
const CANARY="Speedtest 2 - VPS CANARY";
const token=fs.readFileSync("/run/secrets/mcp-token","utf8").trim();
const client=new Client({name:"cf-first-material-canary",version:"1.0.0"});
const transport=new StreamableHTTPClientTransport(new URL("http://127.0.0.1:8788/mcp/"+token));
await client.connect(transport);

function parseTool(res){
  if(res?.isError===true) throw new Error("MCP tool returned isError");
  const raw=(res?.content||[]).filter(x=>x.type==="text").map(x=>x.text||"").join("\n");
  if(!raw) throw new Error("empty MCP tool response");
  return JSON.parse(raw);
}
async function fabric(capability_id, argsInput){
  const res=await client.callTool({name:"onshape_fabric_invoke",arguments:{capability_id,arguments:argsInput}});
  const value=parseTool(res);
  if(value.build_id!=="onshape-vps-hardened-r3") throw new Error("wrong build "+String(value.build_id));
  if(value.public_surface!=="semantic-only"||value.qualification_only!==false) throw new Error("wrong production surface");
  return value.result;
}
async function readDoc(){
  const r=await fabric("onshape.documented.operation",{
    operationId:"getDocument",pathParams:{did:DID},query:{}
  });
  if(r?.outcome?.state!=="ACHIEVED") throw new Error("document read outcome "+JSON.stringify(r?.outcome));
  const ev=r?.observation?.evidence||{};
  if(ev.httpStatus!==200||ev.effectSent!==false) throw new Error("document read evidence invalid");
  const b=ev.body||{};
  if(b.id!==DID) throw new Error("wrong document id");
  if(b?.defaultWorkspace?.id!==WID) throw new Error("wrong workspace id");
  return {
    result:r,
    name:b.name,
    microversion:b?.defaultWorkspace?.microversion,
  };
}
function checkMutation(r, expectedName, expectedPreMicro){
  if(r?.targetId!=="onshape:document:"+DID) throw new Error("wrong mutation target");
  if(r?.capability?.effect!=="onshape.documented.operation.mutation") throw new Error("wrong mutation effect");
  if(r?.outcome?.state!=="ACHIEVED") throw new Error("mutation outcome "+JSON.stringify(r?.outcome));
  if(r?.observation?.ackState!=="ACKNOWLEDGED") throw new Error("mutation not acknowledged");
  const ev=r?.observation?.evidence||{};
  if(ev.effectSent!==true) throw new Error("mutation effectSent not true");
  if(ev.postconditionVerified!==true) throw new Error("mutation postcondition not verified");
  if(ev.mutationSessionId!=="session-1") throw new Error("mutation not on session-1");
  if(ev.preMicroversion!==expectedPreMicro) throw new Error("mutation preMicroversion mismatch");
  if(ev?.verification?.kind!=="document_name_equals") throw new Error("wrong verification kind");
  if(ev?.verification?.expectedName!==expectedName||ev?.verification?.observedName!==expectedName) {
    throw new Error("document name postcondition mismatch");
  }
  return ev;
}

const poolRaw=parseTool(await client.callTool({name:"onshape_pool_status",arguments:{}}));
if(poolRaw.pool_enabled!==true||poolRaw.size!==3||poolRaw.active_count!==0||poolRaw.queued_count!==0||poolRaw.document_lock_count!==0){
  throw new Error("pool not idle");
}
if(poolRaw.material_mutator_session_id!=="session-1") throw new Error("wrong mutator session");
for(const s of poolRaw.sessions||[]) if(s?.auth?.state!=="PROVEN") throw new Error("pool auth not proven");

const pre=await readDoc();
if(pre.name!==ORIGINAL) throw new Error("unexpected original document name: "+String(pre.name));
if(!/^[0-9a-f]{24}$/i.test(String(pre.microversion||""))) throw new Error("invalid pre microversion");
console.log("CF_CANARY_TARGET_DOCUMENT="+DID);
console.log("CF_CANARY_TARGET_WORKSPACE="+WID);
console.log("CF_CANARY_PRE_NAME="+pre.name);
console.log("CF_CANARY_PRE_MICROVERSION="+pre.microversion);

const canary=await fabric("onshape.documented.operation",{
  operationId:"updateDocumentAttributes",
  pathParams:{did:DID},
  query:{},
  body:{name:CANARY},
  verification:{kind:"document_name_equals",value:CANARY}
});
const canaryEv=checkMutation(canary,CANARY,pre.microversion);
console.log("CF_CANARY_INVOCATION="+canary.invocationId);
console.log("CF_CANARY_OPERATION="+canary.operationId);
console.log("CF_CANARY_ATTEMPT="+canary.attemptId);
console.log("CF_CANARY_POST_MICROVERSION="+String(canaryEv.postMicroversion||""));
console.log("CF_CANARY_POSTCONDITION=verified");

const mid=await readDoc();
if(mid.name!==CANARY) throw new Error("independent mid-read did not observe canary name");
if(String(mid.microversion||"")!==String(canaryEv.postMicroversion||"")) throw new Error("mid-read microversion mismatch");
console.log("CF_CANARY_INDEPENDENT_READBACK=pass");

const restore=await fabric("onshape.documented.operation",{
  operationId:"updateDocumentAttributes",
  pathParams:{did:DID},
  query:{},
  body:{name:ORIGINAL},
  verification:{kind:"document_name_equals",value:ORIGINAL}
});
const restoreEv=checkMutation(restore,ORIGINAL,mid.microversion);
console.log("CF_CANARY_CLEANUP_INVOCATION="+restore.invocationId);
console.log("CF_CANARY_CLEANUP_OPERATION="+restore.operationId);
console.log("CF_CANARY_CLEANUP_ATTEMPT="+restore.attemptId);
console.log("CF_CANARY_CLEANUP_POST_MICROVERSION="+String(restoreEv.postMicroversion||""));
console.log("CF_CANARY_CLEANUP_POSTCONDITION=verified");

const fin=await readDoc();
if(fin.name!==ORIGINAL) throw new Error("final independent read did not restore original name");
if(String(fin.microversion||"")!==String(restoreEv.postMicroversion||"")) throw new Error("final microversion mismatch");
console.log("CF_CANARY_FINAL_NAME="+fin.name);
console.log("CF_CANARY_FINAL_MICROVERSION="+fin.microversion);
console.log("CF_CANARY_CLEANUP_INDEPENDENT_READBACK=pass");
console.log("CF_CANARY_MATERIAL_WINDOW=pass");

await client.close();
NODE
)"
printf '%s\n' "$node_output"

canary_inv="$(printf '%s\n' "$node_output" | awk -F= '$1=="CF_CANARY_INVOCATION"{print $2}' | tail -n1)"
canary_op="$(printf '%s\n' "$node_output" | awk -F= '$1=="CF_CANARY_OPERATION"{print $2}' | tail -n1)"
canary_att="$(printf '%s\n' "$node_output" | awk -F= '$1=="CF_CANARY_ATTEMPT"{print $2}' | tail -n1)"
cleanup_inv="$(printf '%s\n' "$node_output" | awk -F= '$1=="CF_CANARY_CLEANUP_INVOCATION"{print $2}' | tail -n1)"
cleanup_op="$(printf '%s\n' "$node_output" | awk -F= '$1=="CF_CANARY_CLEANUP_OPERATION"{print $2}' | tail -n1)"
cleanup_att="$(printf '%s\n' "$node_output" | awk -F= '$1=="CF_CANARY_CLEANUP_ATTEMPT"{print $2}' | tail -n1)"
for x in "$canary_inv" "$canary_op" "$canary_att" "$cleanup_inv" "$cleanup_op" "$cleanup_att"; do
  [[ -n "$x" ]] || { echo CF_CANARY_ID_PARSE_FAILED >&2; exit 40; }
done

python3 - "$db" "$quarantine" "$canary_inv" "$canary_op" "$canary_att" "$cleanup_inv" "$cleanup_op" "$cleanup_att" "$canary_document" "$canary_workspace" "$canary_name" "$original_name" "$expected_control_blob" <<'PY'
import json,sqlite3,sys
(db,qpath,ci,co,ca,ri,ro,ra,did,wid,canary_name,original_name,blob)=sys.argv[1:]
q=json.load(open(qpath)); qa=q["attemptId"]; qo=q["operationId"]
c=sqlite3.connect(f"file:{db}?mode=ro",uri=True); c.row_factory=sqlite3.Row

def check(inv,op,att,expected_name):
    row=c.execute("""SELECT i.phase,i.dispatch_payload,o.operation_id,o.state operation_state,o.outcome_payload,
                            a.attempt_id,a.state attempt_state,a.observation_payload
                     FROM invocations i
                     JOIN operations o ON o.invocation_id=i.invocation_id
                     JOIN attempts a ON a.operation_id=o.operation_id
                     WHERE i.invocation_id=?""",(inv,)).fetchone()
    assert row is not None,inv
    assert row["operation_id"]==op and row["attempt_id"]==att
    assert row["phase"]=="RECONCILED",dict(row)
    assert row["operation_state"]=="ACHIEVED",dict(row)
    assert row["attempt_state"]=="OBSERVED",dict(row)
    d=json.loads(row["dispatch_payload"]); out=json.loads(row["outcome_payload"]); obs=json.loads(row["observation_payload"])
    assert d["target_id"]==f"onshape:document:{did}"
    assert d["effect"]=="onshape.documented.operation.mutation"
    ep=d["execution_payload"]; pre=ep["preconditions"]; pa=pre["productionAuthority"]; mc=pre["mutationContract"]
    assert ep["agentEffect"]=="MUTATION"
    assert ep["args"]["operationId"]=="updateDocumentAttributes"
    assert ep["args"]["pathParams"]["did"]==did
    assert ep["args"]["body"]["name"]==expected_name
    assert pa["productionEpoch"]==3 and pa["controlBlobSha"]==blob and pa["controlRevision"]==531
    assert pa["mode"]=="VPS_PRODUCTION" and pa["materialAuthority"]=="vps-fabric"
    assert pa["releaseSequence"]==66 and pa["releaseId"]=="onshape-vps-hardened-production-r3"
    assert mc["target"]["documentId"]==did and mc["target"]["workspaceId"]==wid
    assert mc["postcondition"]=={"kind":"document_name_equals","value":expected_name}
    assert mc["observation"]["kind"]=="server-side-readback" and mc["observation"]["sameSessionRequired"] is True
    assert mc["recovery"]["kind"]=="restore_document_name" and mc["recovery"]["blindReplayAllowed"] is False
    assert out["state"]=="ACHIEVED"
    ev=obs["evidence"]
    assert obs["ack_state"]=="ACKNOWLEDGED"
    assert ev["effectSent"] is True and ev["postconditionVerified"] is True
    assert ev["mutationSessionId"]=="session-1"
    assert ev["verification"]["kind"]=="document_name_equals"
    assert ev["verification"]["expectedName"]==expected_name and ev["verification"]["observedName"]==expected_name
    kinds={r[0] for r in c.execute("SELECT kind FROM events WHERE entity_id IN (?,?,?)",(inv,op,att)).fetchall()}
    assert "state.dispatch.persisted" in kinds
    assert "operation.begun" in kinds
    assert "attempt.observed" in kinds
    assert "operation.reconciled" in kinds
    return d,obs

check(ci,co,ca,canary_name)
check(ri,ro,ra,original_name)

rows=c.execute("""SELECT i.phase,o.operation_id,o.state operation_state,a.attempt_id,a.state attempt_state
                  FROM invocations i LEFT JOIN operations o ON o.invocation_id=i.invocation_id
                  LEFT JOIN attempts a ON a.operation_id=o.operation_id
                  WHERE i.phase IN ('DISPATCH_FINALIZED','DISPATCH_INTENT','OBSERVED')
                     OR o.state IN ('IN_FLIGHT','IN_DOUBT')
                     OR a.state IN ('DISPATCH_INTENT','IN_DOUBT')""").fetchall()
blocking=[]
for r in rows:
    if r["operation_id"]==qo and r["attempt_id"]==qa:
        continue
    blocking.append(dict(r))
assert not blocking,blocking
assert str(c.execute("PRAGMA integrity_check").fetchone()[0]).lower()=="ok"
print("CF_CANARY_PROVENANCE_CANARY=pass")
print("CF_CANARY_PROVENANCE_CLEANUP=pass")
print("CF_CANARY_EFFECTIVE_UNRESOLVED_POST=0")
print("CF_CANARY_SQLITE_POST=clean")
c.close()
PY

ponr="$(python3 "$guard" decide --db "$db" --control "$control" --quarantine "$quarantine")"
printf '%s\n' "$ponr"
printf '%s\n' "$ponr" | grep -Fxq 'CF_A4_PONR=true'
printf '%s\n' "$ponr" | grep -Fxq 'CF_A4_PONR_COUNT=2'
printf '%s\n' "$ponr" | grep -Fxq 'CF_A4_UNRESOLVED_BLOCKING=0'
printf '%s\n' "$ponr" | grep -Fxq 'CF_A4_ZERO_UNRESOLVED=pass'
printf '%s\n' "$ponr" | grep -Fxq 'CF_A4_ROLLBACK_DIRECTIVE=ROLLBACK_ALLOWED'
echo CF_CANARY_PONR=expected-crossed
echo CF_CANARY_ZERO_UNRESOLVED=pass

safe_to_reopen=yes
docker start "$gateway" >/dev/null
gateway_reopened=yes
[[ "$(docker inspect -f '{{.State.Running}}' "$gateway")" == true ]]
echo CF_CANARY_PUBLIC_GATEWAY=reopened

trap - EXIT
echo CF_CANARY=pass
