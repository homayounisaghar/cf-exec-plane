#!/usr/bin/env bash
set -euo pipefail
umask 077
[[ "$(id -u)" -eq 0 ]] || exit 2

gateway=capability-fabric-onshape-gateway
server=capability-fabric-onshape-server
control=/var/lib/capability-fabric/onshape/runtime-control/ONSHAPE_RUNTIME_CONTROL.json
db=/var/lib/capability-fabric/onshape/fabric-state/execution.sqlite3
quarantine=/var/lib/capability-fabric/onshape/fabric-state/quarantine/D-018-attempt-f6d80f46.json
guard=/usr/local/libexec/capability-fabric-onshape-rollback-contract
blob=81f73bb89c5517080a80ada3047c58c287874c50
did=84d077d8370c21c4b3045263
wid=aa8c5ad631e1836645149d09

[[ "$(docker inspect -f '{{.State.Running}}' "$gateway")" == false ]]
[[ "$(docker inspect -f '{{.State.Running}}' "$server")" == true ]]
[[ "$(git hash-object "$control")" == "$blob" ]]
echo CF_CANARY_INCIDENT_GATEWAY=stopped
echo CF_CANARY_INCIDENT_CONTROL=exact

python3 - "$db" "$quarantine" "$blob" "$did" "$wid" <<'PY'
import json,sqlite3,sys
db,qpath,blob,did,wid=sys.argv[1:]
q=json.load(open(qpath)); qa=q["attemptId"]; qo=q["operationId"]
c=sqlite3.connect(f"file:{db}?mode=ro",uri=True); c.row_factory=sqlite3.Row
rows=c.execute("""SELECT i.rowid,i.invocation_id,i.phase,i.dispatch_payload,
                         o.operation_id,o.state operation_state,o.outcome_payload,
                         a.attempt_id,a.state attempt_state,a.observation_payload
                  FROM invocations i
                  JOIN operations o ON o.invocation_id=i.invocation_id
                  JOIN attempts a ON a.operation_id=o.operation_id
                  WHERE i.dispatch_payload IS NOT NULL
                  ORDER BY i.rowid""").fetchall()
prod=[]
for r in rows:
    d=json.loads(r["dispatch_payload"])
    ep=d.get("execution_payload") or {}
    pre=ep.get("preconditions") or {}
    pa=pre.get("productionAuthority") or {}
    if ep.get("agentEffect")=="MUTATION" and pa.get("productionEpoch")==3 and pa.get("mode")=="VPS_PRODUCTION" and pa.get("materialAuthority")=="vps-fabric":
        prod.append((r,d))
assert len(prod)==1,[(x[0]["rowid"],x[0]["operation_id"]) for x in prod]
r,d=prod[0]
ep=d["execution_payload"]; pre=ep["preconditions"]; pa=pre["productionAuthority"]; mc=pre["mutationContract"]
obs=json.loads(r["observation_payload"]); out=json.loads(r["outcome_payload"])
ev=obs["evidence"]
assert r["phase"]=="RECONCILED"
assert r["operation_state"]=="ACHIEVED"
assert r["attempt_state"]=="OBSERVED"
assert d["target_id"]==f"onshape:document:{did}"
assert ep["args"]["operationId"]=="updateDocumentAttributes"
assert ep["args"]["pathParams"]["did"]==did
assert ep["args"]["body"]["name"]=="Speedtest 2 - VPS CANARY"
assert pa["controlBlobSha"]==blob and pa["controlRevision"]==531 and pa["releaseSequence"]==66
assert mc["target"]["documentId"]==did and mc["target"]["workspaceId"]==wid
assert mc["postcondition"]=={"kind":"document_name_equals","value":"Speedtest 2 - VPS CANARY"}
assert mc["observation"]["sameSessionRequired"] is True
assert mc["recovery"]["kind"]=="restore_document_name" and mc["recovery"]["blindReplayAllowed"] is False
assert obs["ack_state"]=="ACKNOWLEDGED"
assert ev["effectSent"] is True and ev["postconditionVerified"] is True
assert ev["mutationSessionId"]=="session-1"
assert ev["verification"]["expectedName"]=="Speedtest 2 - VPS CANARY"
assert ev["verification"]["observedName"]=="Speedtest 2 - VPS CANARY"
assert ev["preMicroversion"]==mc["preMicroversion"]
assert out["state"]=="ACHIEVED"
print("CF_CANARY_INCIDENT_INVOCATION="+r["invocation_id"])
print("CF_CANARY_INCIDENT_OPERATION="+r["operation_id"])
print("CF_CANARY_INCIDENT_ATTEMPT="+r["attempt_id"])
print("CF_CANARY_INCIDENT_PRE_MICROVERSION="+str(ev["preMicroversion"]))
print("CF_CANARY_INCIDENT_POST_MICROVERSION="+str(ev.get("postMicroversion") or ""))
print("CF_CANARY_INCIDENT_POSTCONDITION=verified")
print("CF_CANARY_INCIDENT_PROVENANCE=terminal-achieved")
print("CF_CANARY_INCIDENT_RECOVERY=restore_document_name")

unresolved=c.execute("""SELECT i.phase,o.operation_id,o.state operation_state,a.attempt_id,a.state attempt_state
                        FROM invocations i LEFT JOIN operations o ON o.invocation_id=i.invocation_id
                        LEFT JOIN attempts a ON a.operation_id=o.operation_id
                        WHERE i.phase IN ('DISPATCH_FINALIZED','DISPATCH_INTENT','OBSERVED')
                           OR o.state IN ('IN_FLIGHT','IN_DOUBT')
                           OR a.state IN ('DISPATCH_INTENT','IN_DOUBT')""").fetchall()
blocking=[]
for x in unresolved:
    if x["operation_id"]==qo and x["attempt_id"]==qa:
        continue
    blocking.append(dict(x))
assert not blocking,blocking
print("CF_CANARY_INCIDENT_BLOCKING_UNRESOLVED=0")
c.close()
PY

ponr="$(python3 "$guard" decide --db "$db" --control "$control" --quarantine "$quarantine")"
printf '%s\n' "$ponr"
printf '%s\n' "$ponr" | grep -Fxq 'CF_A4_PONR=true'
printf '%s\n' "$ponr" | grep -Fxq 'CF_A4_PONR_COUNT=1'
printf '%s\n' "$ponr" | grep -Fxq 'CF_A4_UNRESOLVED_BLOCKING=0'
echo CF_CANARY_INCIDENT_PONR_COUNT=1

docker exec -i "$server" sh -lc 'cd /tmp/app && node --input-type=module' <<'NODE'
import fs from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
const DID="84d077d8370c21c4b3045263";
const WID="aa8c5ad631e1836645149d09";
const token=fs.readFileSync("/run/secrets/mcp-token","utf8").trim();
const client=new Client({name:"cf-canary-achieved-inspector",version:"1.0.0"});
const transport=new StreamableHTTPClientTransport(new URL("http://127.0.0.1:8788/mcp/"+token));
await client.connect(transport);
const parse=(res)=>{
  if(res?.isError===true) throw new Error("tool error");
  return JSON.parse((res.content||[]).filter(x=>x.type==="text").map(x=>x.text||"").join("\n"));
};
const pool=parse(await client.callTool({name:"onshape_pool_status",arguments:{}}));
if(pool.pool_enabled!==true||pool.size!==3||pool.active_count!==0||pool.queued_count!==0||pool.document_lock_count!==0) throw new Error("pool not idle");
for(const s of pool.sessions||[]) if(s?.auth?.state!=="PROVEN") throw new Error("session not proven");
const wrap=parse(await client.callTool({name:"onshape_fabric_invoke",arguments:{
  capability_id:"onshape.documented.operation",
  arguments:{operationId:"getDocument",pathParams:{did:DID},query:{}}
}}));
const r=wrap.result, ev=r?.observation?.evidence||{}, body=ev.body||{};
if(r?.outcome?.state!=="ACHIEVED"||ev.httpStatus!==200||ev.effectSent!==false) throw new Error("read failed");
if(body.id!==DID||body?.defaultWorkspace?.id!==WID) throw new Error("wrong target");
if(body.name!=="Speedtest 2 - VPS CANARY") throw new Error("current name does not match achieved canary");
console.log("CF_CANARY_INCIDENT_CURRENT_NAME="+body.name);
console.log("CF_CANARY_INCIDENT_CURRENT_MICROVERSION="+body.defaultWorkspace.microversion);
console.log("CF_CANARY_INCIDENT_READBACK=pass");
console.log("CF_CANARY_INCIDENT_POOL=3-of-3-PROVEN-idle");
await client.close();
NODE

[[ "$(docker inspect -f '{{.State.Running}}' "$gateway")" == false ]]
echo CF_CANARY_INCIDENT_GATEWAY_FINAL=stopped
echo CF_CANARY_INCIDENT=proven-achieved-awaiting-cleanup
