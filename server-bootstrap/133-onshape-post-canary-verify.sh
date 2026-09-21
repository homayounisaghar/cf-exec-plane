#!/usr/bin/env bash
set -euo pipefail
umask 077
[[ "$(id -u)" -eq 0 ]] || exit 2

active=/opt/capability-fabric/current
previous=/opt/capability-fabric/previous
control=/var/lib/capability-fabric/onshape/runtime-control/ONSHAPE_RUNTIME_CONTROL.json
db=/var/lib/capability-fabric/onshape/fabric-state/execution.sqlite3
agent_dir=/var/lib/capability-fabric/onshape/fabric-agent
quarantine=/var/lib/capability-fabric/onshape/fabric-state/quarantine/D-018-attempt-f6d80f46.json
guard=/usr/local/libexec/capability-fabric-onshape-rollback-contract
state=/var/lib/capability-fabric/state
gateway=capability-fabric-onshape-gateway
server=capability-fabric-onshape-server
fabric=capability-fabric-onshape-fabric

blob=81f73bb89c5517080a80ada3047c58c287874c50
manifest=857b7ca6d5a6bcf79b820594801a4f88642fe9520dad1ae18fc064eae6073d7c
did=84d077d8370c21c4b3045263
wid=aa8c5ad631e1836645149d09
first_op=operation:3a454a8a-9d5e-491a-b13e-739c01d32d49
first_att=attempt:d425487d-17e0-4b4b-a811-439f76e5b796
cleanup_op=operation:0446c787-18bf-457b-bcaf-cce49b6a196f
cleanup_att=attempt:77ffd01f-cd7e-4ddc-954a-06a3b12a2df2

[[ -L "$active" && -L "$previous" && -s "$control" && -s "$db" && -s "$quarantine" && -x "$guard" ]] || exit 20
a="$(readlink -f "$active")"; p="$(readlink -f "$previous")"
[[ "$(sha256sum "$a/manifest.json" | awk '{print $1}')" == "$manifest" ]] || exit 21
[[ "$(git hash-object "$control")" == "$blob" ]] || exit 22
[[ ! -e "$state/release-in-progress" ]] || exit 23
[[ "$(cat "$state/last-good-sequence")" == 66 ]]
[[ "$(cat "$state/last-good-release")" == onshape-vps-hardened-production-r3 ]]
for c in "$server" "$fabric" "$gateway"; do [[ "$(docker inspect -f '{{.State.Running}}' "$c")" == true ]]; done
echo CF_POSTCANARY_ACTIVE_RELEASE=seq66
echo CF_POSTCANARY_GATEWAY=running
echo CF_POSTCANARY_RELEASE_GATE=clear

python3 - "$a/manifest.json" "$p/manifest.json" "$control" "$manifest" "$blob" <<'PY'
import json,sys
am,pm,cp,manifest,blob=sys.argv[1:]
a=json.load(open(am)); p=json.load(open(pm)); r=json.load(open(cp)); x=r["authority"]; v=x["planes"]["vps-fabric"]; android=x["planes"]["android-v1"]
assert a["sequence"]==66 and a["release_id"]=="onshape-vps-hardened-production-r3"
assert p["sequence"]==63 and p["release_id"]=="onshape-vps-hardened-rollback-r1"
assert r["controlRevision"]==531
assert x["productionEpoch"]==3 and x["mode"]=="VPS_PRODUCTION" and x["materialAuthority"]=="vps-fabric"
assert android["ingress"]=="CLOSED" and android["materialEffectsAllowed"] is False
assert v["ingress"]=="ADMITTED" and v["materialEffectsAllowed"] is True
assert v["releaseSequence"]==66 and v["releaseId"]=="onshape-vps-hardened-production-r3" and v["manifestSha256"]==manifest
assert x["reconciliationHold"]["active"] is False
assert r["lease"]["state"]=="FREE"
print("CF_POSTCANARY_AUTHORITY=epoch3-vps-production")
print("CF_POSTCANARY_ANDROID=CLOSED")
print("CF_POSTCANARY_LEASE=FREE")
print("CF_POSTCANARY_CONTROL_BLOB="+blob)
PY

python3 - "$db" "$agent_dir" "$quarantine" "$blob" "$did" "$wid" "$first_op" "$first_att" "$cleanup_op" "$cleanup_att" <<'PY'
import json,pathlib,sqlite3,sys
db,agent_dir,qpath,blob,did,wid,fo,fa,co,ca=sys.argv[1:]
q=json.load(open(qpath)); qa=q["attemptId"]; qo=q["operationId"]
c=sqlite3.connect(f"file:{db}?mode=ro",uri=True); c.row_factory=sqlite3.Row
assert str(c.execute("PRAGMA integrity_check").fetchone()[0]).lower()=="ok"
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
assert (prod[1][0]["operation_id"],prod[1][0]["attempt_id"])==(co,ca)
for index,(r,d) in enumerate(prod):
    assert r["phase"]=="RECONCILED" and r["operation_state"]=="ACHIEVED" and r["attempt_state"]=="OBSERVED"
    ep=d["execution_payload"]; pre=ep["preconditions"]; pa=pre["productionAuthority"]; mc=pre["mutationContract"]
    obs=json.loads(r["observation_payload"]); ev=obs["evidence"]; out=json.loads(r["outcome_payload"])
    assert d["target_id"]==f"onshape:document:{did}"
    assert ep["args"]["operationId"]=="updateDocumentAttributes" and ep["args"]["pathParams"]["did"]==did
    expected="Speedtest 2 - VPS CANARY" if index==0 else "Speedtest 2"
    assert ep["args"]["body"]["name"]==expected
    assert pa["controlBlobSha"]==blob and pa["controlRevision"]==531 and pa["releaseSequence"]==66
    assert mc["target"]["documentId"]==did and mc["target"]["workspaceId"]==wid
    assert mc["postcondition"]=={"kind":"document_name_equals","value":expected}
    assert mc["observation"]["sameSessionRequired"] is True
    assert mc["recovery"]["blindReplayAllowed"] is False
    assert obs["ack_state"]=="ACKNOWLEDGED" and out["state"]=="ACHIEVED"
    assert ev["effectSent"] is True and ev["postconditionVerified"] is True and ev["mutationSessionId"]=="session-1"
    assert ev["verification"]["expectedName"]==expected and ev["verification"]["observedName"]==expected
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
c.close()
executing=[]; uncertain=[]
for p in pathlib.Path(agent_dir).glob("*.json"):
    try: v=json.loads(p.read_text())
    except Exception: continue
    st=str(v.get("state","")); aid=str(v.get("attemptId") or "")
    if st=="EXECUTING": executing.append((p.name,aid))
    if st=="UNCERTAIN" and aid!=qa: uncertain.append((p.name,aid))
assert not executing,executing
assert not uncertain,uncertain
print("CF_POSTCANARY_PROVENANCE_BOTH=pass")
print("CF_POSTCANARY_SQLITE_INTEGRITY=pass")
print("CF_POSTCANARY_EFFECTIVE_UNRESOLVED=0")
print("CF_POSTCANARY_AGENT_EXECUTING=0")
print("CF_POSTCANARY_AGENT_UNCERTAIN=0")
PY

ponr="$(python3 "$guard" decide --db "$db" --control "$control" --quarantine "$quarantine")"
printf '%s\n' "$ponr"
printf '%s\n' "$ponr" | grep -Fxq 'CF_A4_PONR=true'
printf '%s\n' "$ponr" | grep -Fxq 'CF_A4_PONR_COUNT=2'
printf '%s\n' "$ponr" | grep -Fxq "CF_A4_FIRST_PRODUCTION_MUTATION_OPERATION=$first_op"
printf '%s\n' "$ponr" | grep -Fxq "CF_A4_FIRST_PRODUCTION_MUTATION_ATTEMPT=$first_att"
printf '%s\n' "$ponr" | grep -Fxq 'CF_A4_UNRESOLVED_BLOCKING=0'
printf '%s\n' "$ponr" | grep -Fxq 'CF_A4_ZERO_UNRESOLVED=pass'
printf '%s\n' "$ponr" | grep -Fxq 'CF_A4_ROLLBACK_DIRECTIVE=ROLLBACK_ALLOWED'
echo CF_POSTCANARY_PONR=true-count2

docker exec -i "$server" sh -lc 'cd /tmp/app && node --input-type=module' <<'NODE'
import fs from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
const DID="84d077d8370c21c4b3045263", WID="aa8c5ad631e1836645149d09";
const token=fs.readFileSync("/run/secrets/mcp-token","utf8").trim();
const client=new Client({name:"cf-postcanary-verifier",version:"1.0.0"});
const transport=new StreamableHTTPClientTransport(new URL("http://127.0.0.1:8788/mcp/"+token));
await client.connect(transport);
const parse=(res)=>{
  if(res?.isError===true) throw new Error("tool error");
  return JSON.parse((res.content||[]).filter(x=>x.type==="text").map(x=>x.text||"").join("\n"));
};
const tools=(await client.listTools()).tools.map(x=>x.name);
for(const x of ["onshape_pool_status","onshape_fabric_capabilities","onshape_fabric_invoke"]) if(!tools.includes(x)) throw new Error("missing "+x);
if(tools.includes("onshape_ui_input_sequence")||tools.includes("onshape_ui_native")) throw new Error("effectful UI exposed");
const caps=parse(await client.callTool({name:"onshape_fabric_capabilities",arguments:{}}));
const ids=(caps.capabilities||[]).map(x=>x.id);
if(ids.includes("onshape.ui.input.sequence")||ids.includes("onshape.ui.native")) throw new Error("effectful UI capability exposed");
const pool=parse(await client.callTool({name:"onshape_pool_status",arguments:{}}));
if(pool.pool_enabled!==true||pool.size!==3||pool.active_count!==0||pool.queued_count!==0||pool.document_lock_count!==0) throw new Error("pool not idle");
for(const s of pool.sessions||[]) if(s?.auth?.state!=="PROVEN") throw new Error("session not proven");
const wrap=parse(await client.callTool({name:"onshape_fabric_invoke",arguments:{capability_id:"onshape.documented.operation",arguments:{operationId:"getDocument",pathParams:{did:DID},query:{}}}}));
const r=wrap.result, ev=r?.observation?.evidence||{}, b=ev.body||{};
if(r?.outcome?.state!=="ACHIEVED"||ev.httpStatus!==200||ev.effectSent!==false) throw new Error("read failed");
if(b.id!==DID||b.name!=="Speedtest 2"||b?.defaultWorkspace?.id!==WID) throw new Error("final target state mismatch");
console.log("CF_POSTCANARY_TOOL_CATALOG=pass");
console.log("CF_POSTCANARY_UI_EFFECTFUL_CLOSED=pass");
console.log("CF_POSTCANARY_POOL=3-of-3-PROVEN-idle");
console.log("CF_POSTCANARY_FINAL_NAME="+b.name);
console.log("CF_POSTCANARY_FINAL_READ_EFFECT_SENT=false");
await client.close();
NODE

echo CF_POSTCANARY=pass
