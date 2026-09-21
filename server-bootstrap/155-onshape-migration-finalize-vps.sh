#!/usr/bin/env bash
set -euo pipefail
umask 077
[[ "$(id -u)" -eq 0 ]] || exit 2

ACTIVE=/opt/capability-fabric/current
PREVIOUS=/opt/capability-fabric/previous
STATE=/var/lib/capability-fabric/state
CONTROL=/var/lib/capability-fabric/onshape/runtime-control/ONSHAPE_RUNTIME_CONTROL.json
MIRROR_BLOB=/var/lib/capability-fabric/onshape/runtime-control/git-blob-sha
MIRROR_COMMIT=/var/lib/capability-fabric/onshape/runtime-control/source-commit
GATE="$STATE/release-in-progress"
LOCK=/run/lock/capability-fabric-pull.lock
TIMER=capability-fabric-pull.timer
GATEWAY=capability-fabric-onshape-gateway
SERVER=capability-fabric-onshape-server
FABRIC=capability-fabric-onshape-fabric
DB=/var/lib/capability-fabric/onshape/fabric-state/execution.sqlite3
AGENT_DIR=/var/lib/capability-fabric/onshape/fabric-agent
QUARANTINE=/var/lib/capability-fabric/onshape/fabric-state/quarantine/D-018-attempt-f6d80f46.json
ROLLBACK_GUARD=/usr/local/libexec/capability-fabric-onshape-rollback-contract

expected_control=6ac33244f7968c142e30b2f815d090f74dac49f3
expected_manifest=f2631a7f94ec5f6e5af5e9d3b3211cf440354eef0b55ff6fee7ab65cec50bfb9
expected_source_commit=19c03e0b1a3e972801c6e95b87de9d0cc050449a
did=881affea8ea63c33ae4e6c78
wid=7b1e64a5ce7f95e660a9a5f2

a="$(readlink -f "$ACTIVE")"
p="$(readlink -f "$PREVIOUS")"
[[ "$a" == /var/lib/capability-fabric/releases/onshape-vps-hardened-production-r4 ]]
[[ "$p" == /var/lib/capability-fabric/releases/onshape-vps-hardened-production-r3 ]]
[[ "$(sha256sum "$a/manifest.json" | awk '{print $1}')" == "$expected_manifest" ]]
[[ "$(git hash-object "$CONTROL")" == "$expected_control" ]]
[[ "$(tr -d '\r\n' < "$MIRROR_BLOB")" == "$expected_control" ]]
[[ "$(tr -d '\r\n' < "$MIRROR_COMMIT")" == "$expected_source_commit" ]]
[[ -f "$GATE" ]]
grep -Fxq RELEASE_IN_PROGRESS "$GATE"
if systemctl is-active --quiet "$TIMER"; then exit 20; fi
[[ "$(docker inspect -f '{{.State.Running}}' "$GATEWAY")" == false ]]
[[ "$(docker inspect -f '{{.State.Running}}' "$SERVER")" == true ]]
[[ "$(docker inspect -f '{{.State.Running}}' "$FABRIC")" == true ]]

python3 - "$a/manifest.json" "$p/manifest.json" "$CONTROL" <<'PY'
import json,sys
am=json.load(open(sys.argv[1])); pm=json.load(open(sys.argv[2])); x=json.load(open(sys.argv[3]))
a=x["authority"]; g=a["productionGuard"]; android=a["planes"]["android-v1"]; vps=a["planes"]["vps-fabric"]; r=x["routing"]
assert am["sequence"]==67 and am["release_id"]=="onshape-vps-hardened-production-r4"
assert pm["sequence"]==66 and pm["release_id"]=="onshape-vps-hardened-production-r3"
assert x["controlRevision"]==540 and a["productionEpoch"]==11
assert a["mode"]=="VPS_PRODUCTION" and a["materialAuthority"]=="vps-fabric"
assert android["ingress"]=="CLOSED" and android["materialEffectsAllowed"] is False and android["busGeneration"]==3
assert vps["ingress"]=="ADMITTED" and vps["materialEffectsAllowed"] is True
assert vps["releaseSequence"]==67 and vps["releaseId"]=="onshape-vps-hardened-production-r4"
assert vps["manifestSha256"]=="f2631a7f94ec5f6e5af5e9d3b3211cf440354eef0b55ff6fee7ab65cec50bfb9"
assert r["state"]=="CLOSED" and r["materialCommandsAllowed"] is False
assert r["busGeneration"]==3 and r["activeMailboxIssue"]==50
assert x["lease"]["state"]=="FREE" and x["lease"]["busGeneration"]==3
assert a["reconciliationHold"]["active"] is False
assert g["generation"]==3 and g["killSwitch"]=="ENGAGED"
assert g["allowedDocumentIds"]==[]
assert g["mutationBudget"]=={"budgetId":"epoch7-post-test-closed","maxMutations":0}
print("CF_MIGRATION_FINAL_AUTHORITY=epoch11-vps-production")
print("CF_MIGRATION_FINAL_RELEASE=seq67-r4")
print("CF_MIGRATION_FINAL_ANDROID=CLOSED-bus3-mailbox50")
print("CF_MIGRATION_FINAL_GUARD=engaged-empty-zero")
print("CF_MIGRATION_FINAL_LEASE=FREE")
PY

python3 - "$DB" "$AGENT_DIR" "$QUARANTINE" <<'PY'
import json,pathlib,sqlite3,sys
db,agent_dir,qpath=sys.argv[1:]
q=json.load(open(qpath)); qa=q["attemptId"]; qo=q["operationId"]
c=sqlite3.connect(f"file:{db}?mode=ro",uri=True); c.row_factory=sqlite3.Row
assert str(c.execute("pragma integrity_check").fetchone()[0]).lower()=="ok"
rows=c.execute("""SELECT i.phase,o.operation_id,o.state operation_state,a.attempt_id,a.state attempt_state
FROM invocations i LEFT JOIN operations o ON o.invocation_id=i.invocation_id
LEFT JOIN attempts a ON a.operation_id=o.operation_id
WHERE i.phase IN ('DISPATCH_FINALIZED','DISPATCH_INTENT','OBSERVED')
OR o.state IN ('IN_FLIGHT','IN_DOUBT') OR a.state IN ('DISPATCH_INTENT','IN_DOUBT')""").fetchall()
blocking=[]
for r in rows:
    if r["operation_id"]==qo and r["attempt_id"]==qa: continue
    blocking.append(dict(r))
assert not blocking,blocking
c.close()
executing=[]; uncertain=[]
for p in pathlib.Path(agent_dir).glob("*.json"):
    try:v=json.loads(p.read_text())
    except Exception:continue
    st=str(v.get("state","")); aid=str(v.get("attemptId") or "")
    if st=="EXECUTING": executing.append((p.name,aid))
    if st=="UNCERTAIN" and aid!=qa: uncertain.append((p.name,aid))
assert not executing,executing
assert not uncertain,uncertain
print("CF_MIGRATION_FINAL_SQLITE=pass")
print("CF_MIGRATION_FINAL_EFFECTIVE_UNRESOLVED=0")
print("CF_MIGRATION_FINAL_AGENT_EXECUTING=0")
print("CF_MIGRATION_FINAL_AGENT_UNCERTAIN=0")
PY

ponr="$("$ROLLBACK_GUARD" decide --db "$DB" --control "$CONTROL" --quarantine "$QUARANTINE")"
printf '%s\n' "$ponr"
printf '%s\n' "$ponr" | grep -Fxq 'CF_A4_PONR=true'
printf '%s\n' "$ponr" | grep -Fxq 'CF_A4_PONR_COUNT=4'
printf '%s\n' "$ponr" | grep -Fxq 'CF_A4_UNRESOLVED_BLOCKING=0'
printf '%s\n' "$ponr" | grep -Fxq 'CF_A4_ZERO_UNRESOLVED=pass'
echo CF_MIGRATION_FINAL_PONR=count4

exec 9>"$LOCK"
flock -w 30 9 || exit 21
echo CF_MIGRATION_FINAL_PULL_LOCK=held

finalized=no
window=no
cleanup(){
  rc=$?
  set +e
  if [[ "$finalized" != yes ]]; then
    if [[ "$window" == yes || ! -f "$GATE" ]]; then
      tmp="$GATE.tmp.$$"; printf '%s\n' RELEASE_IN_PROGRESS >"$tmp"; chmod 0600 "$tmp"; chown root:root "$tmp"; mv -f "$tmp" "$GATE"
    fi
    systemctl stop "$TIMER" >/dev/null 2>&1 || true
    docker stop "$GATEWAY" >/dev/null 2>&1 || true
    echo CF_MIGRATION_FINAL_FAIL_CLOSED=retained
  fi
  exit "$rc"
}
trap cleanup EXIT

rm -f "$GATE"
window=yes
[[ ! -e "$GATE" ]]
if systemctl is-active --quiet "$TIMER"; then exit 22; fi
[[ "$(docker inspect -f '{{.State.Running}}' "$GATEWAY")" == false ]]
echo CF_MIGRATION_FINAL_LOCAL_WINDOW=open

node_out="$(docker exec -i "$SERVER" sh -lc 'cd /tmp/app && node --input-type=module' <<'NODE'
import fs from "node:fs";
import {Client} from "@modelcontextprotocol/sdk/client/index.js";
import {StreamableHTTPClientTransport} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
const DID="881affea8ea63c33ae4e6c78", WID="7b1e64a5ce7f95e660a9a5f2";
const token=fs.readFileSync("/run/secrets/mcp-token","utf8").trim();
const client=new Client({name:"cf-migration-finalizer",version:"1.0.0"});
const tr=new StreamableHTTPClientTransport(new URL("http://127.0.0.1:8788/mcp/"+token));
await client.connect(tr);
const parse=res=>JSON.parse((res.content||[]).filter(x=>x.type==="text").map(x=>x.text||"").join("\n"));
const tools=(await client.listTools()).tools.map(x=>x.name);
for(const n of ["onshape_pool_status","onshape_fabric_capabilities","onshape_fabric_invoke"]) if(!tools.includes(n)) throw new Error("missing "+n);
if(tools.includes("onshape_ui_input_sequence")||tools.includes("onshape_ui_native")) throw new Error("effectful UI exposed");
const caps=parse(await client.callTool({name:"onshape_fabric_capabilities",arguments:{}}));
if(caps.build_id!=="onshape-vps-hardened-r4"||caps.public_surface!=="semantic-only"||caps.qualification_only!==false) throw new Error("wrong live surface");
const pool=parse(await client.callTool({name:"onshape_pool_status",arguments:{}}));
if(pool.pool_enabled!==true||pool.size!==3||pool.active_count!==0||pool.queued_count!==0||pool.document_lock_count!==0) throw new Error("pool not idle");
if(pool.material_mutator_session_id!=="session-1") throw new Error("wrong mutator role");
for(const s of pool.sessions||[]) if(s?.auth?.state!=="PROVEN") throw new Error("session auth not proven");
console.log("CF_MIGRATION_FINAL_POOL=3-of-3-PROVEN-idle");
const wrap=parse(await client.callTool({name:"onshape_fabric_invoke",arguments:{
  capability_id:"onshape.documented.operation",
  arguments:{operationId:"getDocument",pathParams:{did:DID},query:{}}
}}));
const r=wrap.result,e=r?.observation?.evidence||{},b=e.body||{};
if(wrap.build_id!=="onshape-vps-hardened-r4"||r?.outcome?.state!=="ACHIEVED"||e.httpStatus!==200||e.effectSent!==false) throw new Error("final semantic read failed");
if(b.id!==DID||b.name!=="CF-R4-TARGET-TEST-B"||b?.defaultWorkspace?.id!==WID) throw new Error("final target state mismatch");
console.log("CF_MIGRATION_FINAL_READ=pass");
console.log("CF_MIGRATION_FINAL_READ_EFFECT_SENT=false");
console.log("CF_MIGRATION_FINAL_TARGET_NAME="+b.name);
await client.close();
NODE
)"
printf '%s\n' "$node_out"

ponr2="$("$ROLLBACK_GUARD" decide --db "$DB" --control "$CONTROL" --quarantine "$QUARANTINE")"
printf '%s\n' "$ponr2" | grep -Fxq 'CF_A4_PONR_COUNT=4'
printf '%s\n' "$ponr2" | grep -Fxq 'CF_A4_UNRESOLVED_BLOCKING=0'
printf '%s\n' "$ponr2" | grep -Fxq 'CF_A4_ZERO_UNRESOLVED=pass'
echo CF_MIGRATION_FINAL_SAFETY_POST=pass

systemctl start "$TIMER"
systemctl is-active --quiet "$TIMER"
docker start "$GATEWAY" >/dev/null
[[ "$(docker inspect -f '{{.State.Running}}' "$GATEWAY")" == true ]]
[[ ! -e "$GATE" ]]
finalized=yes
window=no
trap - EXIT
echo CF_MIGRATION_FINAL_RELEASE_GATE=clear
echo CF_MIGRATION_FINAL_PULL_TIMER=active
echo CF_MIGRATION_FINAL_GATEWAY=running
echo CF_MIGRATION_FINAL=pass
