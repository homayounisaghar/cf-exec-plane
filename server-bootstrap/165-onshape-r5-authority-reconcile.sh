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
[[ -f "$GATE" ]] && grep -Fxq RELEASE_IN_PROGRESS "$GATE"
if systemctl is-active --quiet "$TIMER"; then exit 20; fi
[[ "$(docker inspect -f '{{.State.Running}}' "$GATEWAY")" == false ]] || exit 20
[[ "$(docker inspect -f '{{.State.Running}}' "$SERVER")" == true ]] || exit 20

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
print("CF_R5_RECON_AUTHORITY=epoch13-seq70-r5")
print("CF_R5_RECON_GUARD=engaged-empty-zero")
print("CF_R5_RECON_LEASE=FREE")
PY

python3 - "$DB" "$MARKER" <<'PY'
import sqlite3,sys
db,marker=sys.argv[1:]
c=sqlite3.connect(f"file:{db}?mode=ro",uri=True)
c.row_factory=sqlite3.Row
rows=c.execute("""
SELECT i.invocation_id,i.phase,i.dispatch_payload,
       o.operation_id,o.state AS operation_state,
       a.attempt_id,a.state AS attempt_state
FROM invocations i
LEFT JOIN operations o ON o.invocation_id=i.invocation_id
LEFT JOIN attempts a ON a.operation_id=o.operation_id
WHERE i.payload LIKE ?
""", ("%"+marker+"%",)).fetchall()
assert len(rows)==1, [dict(r) for r in rows]
r=rows[0]
assert r["dispatch_payload"] is None, dict(r)
assert r["operation_id"] is None, dict(r)
assert r["attempt_id"] is None, dict(r)
print("CF_R5_RECON_NEGATIVE_INVOCATION="+str(r["invocation_id"]))
print("CF_R5_RECON_NEGATIVE_PHASE="+str(r["phase"]))
print("CF_R5_RECON_NEGATIVE_DISPATCH=absent")
print("CF_R5_RECON_NEGATIVE_OPERATION=absent")
print("CF_R5_RECON_NEGATIVE_ATTEMPT=absent")
c.close()
PY

ponr="$("$ROLLBACK_GUARD" decide --db "$DB" --control "$CONTROL" --quarantine "$QUARANTINE")"
printf '%s\n' "$ponr"
printf '%s\n' "$ponr" | grep -Fxq 'CF_A4_PONR_COUNT=4'
printf '%s\n' "$ponr" | grep -Fxq 'CF_A4_UNRESOLVED_BLOCKING=0'
printf '%s\n' "$ponr" | grep -Fxq 'CF_A4_ZERO_UNRESOLVED=pass'
echo CF_R5_RECON_SAFETY_PRE=pass

exec 9>"$LOCK"
flock -w 30 9 || exit 21

finished=no
window=no
cleanup(){
  rc=$?
  set +e
  if [[ "$finished" != yes ]]; then
    if [[ "$window" == yes || ! -f "$GATE" ]]; then
      tmp="$GATE.tmp.reconcile.$$"
      printf '%s\n' RELEASE_IN_PROGRESS >"$tmp"
      chmod 0600 "$tmp"
      chown root:root "$tmp"
      mv -f "$tmp" "$GATE"
    fi
    systemctl stop "$TIMER" >/dev/null 2>&1 || true
    docker stop "$GATEWAY" >/dev/null 2>&1 || true
    echo CF_R5_RECON_FAIL_CLOSED=retained
  fi
  exit "$rc"
}
trap cleanup EXIT

rm -f "$GATE"
window=yes
echo CF_R5_RECON_LOCAL_WINDOW=open

node_out="$(docker exec -e CF_TEST_DID="$TEST_DID" -e CF_FORBIDDEN_NAME="$MARKER" -i "$SERVER" sh -lc 'cd /tmp/app && node --input-type=module' <<'NODE'
import fs from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
const DID=process.env.CF_TEST_DID;
const FORBIDDEN=process.env.CF_FORBIDDEN_NAME;
const token=fs.readFileSync("/run/secrets/mcp-token","utf8").trim();
const client=new Client({name:"cf-r5-authority-reconciler",version:"1.0.0"});
const transport=new StreamableHTTPClientTransport(new URL("http://127.0.0.1:8788/mcp/"+token));
await client.connect(transport);
const parse=res=>{
  const raw=(res?.content||[]).filter(x=>x.type==="text").map(x=>x.text||"").join("\n");
  if(!raw) throw new Error("empty tool response");
  return JSON.parse(raw);
};

const caps=parse(await client.callTool({name:"onshape_fabric_capabilities",arguments:{}}));
if(caps?.build_id!=="onshape-vps-hardened-r5"||caps?.public_surface!=="semantic-only") throw new Error("wrong surface");
const pool=parse(await client.callTool({name:"onshape_pool_status",arguments:{}}));
if(pool?.pool_enabled!==true||pool?.warming!==false||pool?.size!==3) throw new Error("pool disabled");
if(pool?.active_count!==0||pool?.queued_count!==0||pool?.document_lock_count!==0) throw new Error("pool busy");
if(pool?.material_mutator_session_id!=="session-1"||pool?.session_fingerprints_distinct!==true) throw new Error("pool identity");
for(const s of pool?.sessions||[]) if(s?.auth?.state!=="PROVEN") throw new Error("session not proven "+String(s?.session_id));
console.log("CF_R5_RECON_POOL=3-of-3-PROVEN-idle");

const read=parse(await client.callTool({name:"onshape_fabric_invoke",arguments:{
  capability_id:"onshape.documented.operation",
  arguments:{operationId:"getDocument",pathParams:{did:DID},query:{}}
}}));
const r=read?.result,e=r?.observation?.evidence||{},b=e.body||{};
if(read?.build_id!=="onshape-vps-hardened-r5"||r?.outcome?.state!=="ACHIEVED"||e.httpStatus!==200||e.effectSent!==false) throw new Error("reconcile read failed");
if(b.id!==DID) throw new Error("wrong document");
if(String(b.name||"")===FORBIDDEN) throw new Error("forbidden mutation observed");
if(e.apiVersion!=="v17"||e.observedApiVersion!=="v17"||e.apiVersionMatched!==true) throw new Error("version mismatch");
console.log("CF_R5_RECON_READ=unchanged");
console.log("CF_R5_RECON_API_VERSION=v17");
console.log("CF_R5_RECON_OBSERVED_API_VERSION=v17");
console.log("CF_R5_RECON_API_VERSION_MATCHED=true");
await client.close();
NODE
)"
printf '%s\n' "$node_out"
printf '%s\n' "$node_out" | grep -Fxq 'CF_R5_RECON_READ=unchanged'
printf '%s\n' "$node_out" | grep -Fxq 'CF_R5_RECON_API_VERSION_MATCHED=true'

[[ "$(git hash-object "$CONTROL")" == "$TARGET_CONTROL" ]]
ponr2="$("$ROLLBACK_GUARD" decide --db "$DB" --control "$CONTROL" --quarantine "$QUARANTINE")"
printf '%s\n' "$ponr2" | grep -Fxq 'CF_A4_PONR_COUNT=4'
printf '%s\n' "$ponr2" | grep -Fxq 'CF_A4_UNRESOLVED_BLOCKING=0'
printf '%s\n' "$ponr2" | grep -Fxq 'CF_A4_ZERO_UNRESOLVED=pass'
echo CF_R5_RECON_SAFETY_POST=pass

systemctl start "$TIMER"
systemctl is-active --quiet "$TIMER"
docker start "$GATEWAY" >/dev/null
[[ "$(docker inspect -f '{{.State.Running}}' "$GATEWAY")" == true ]]
[[ ! -e "$GATE" ]]

finished=yes
window=no
trap - EXIT

echo CF_R5_RECON_CLASSIFICATION=REJECTED_PRE_DISPATCH
echo CF_R5_RECON_ACTIVE_RELEASE=seq70-r5
echo CF_R5_RECON_AUTHORITY_RELEASE=seq70-r5
echo CF_R5_RECON_EPOCH=13
echo CF_R5_RECON_RELEASE_GATE=clear
echo CF_R5_RECON_PULL_TIMER=active
echo CF_R5_RECON_GATEWAY=running
echo CF_R5_RECON=pass
