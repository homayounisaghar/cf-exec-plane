#!/usr/bin/env bash
set -euo pipefail
umask 077
[[ "$(id -u)" -eq 0 ]] || exit 2

RELEASES=/var/lib/capability-fabric/releases
STATE=/var/lib/capability-fabric/state
SIGS=/var/lib/capability-fabric/signatures
TRUST=/etc/capability-fabric/trust/deploy-signing.pub
ACTIVE=/opt/capability-fabric/current
PREVIOUS=/opt/capability-fabric/previous
CONTROL=/var/lib/capability-fabric/onshape/runtime-control/ONSHAPE_RUNTIME_CONTROL.json
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

expected_manifest=f2631a7f94ec5f6e5af5e9d3b3211cf440354eef0b55ff6fee7ab65cec50bfb9
expected_control=177ddde1070c6a75f7cf94a15db1a0c93fa45159
did=84d077d8370c21c4b3045263
wid=aa8c5ad631e1836645149d09

active="$(readlink -f "$ACTIVE")"
previous="$(readlink -f "$PREVIOUS")"
[[ "$active" == "$RELEASES/onshape-vps-hardened-production-r4" ]] || exit 20
python3 - "$active/manifest.json" "$previous/manifest.json" "$CONTROL" <<'PY'
import json,sys
m=json.load(open(sys.argv[1])); p=json.load(open(sys.argv[2])); x=json.load(open(sys.argv[3]))
a=x["authority"]; g=a["productionGuard"]
assert m["sequence"]==67 and m["release_id"]=="onshape-vps-hardened-production-r4"
assert p["sequence"]==66 and p["release_id"]=="onshape-vps-hardened-production-r3"
assert x["controlRevision"]==532 and a["productionEpoch"]==4
assert a["mode"]=="QUIESCED_RECONCILING" and a["materialAuthority"] is None
assert a["planes"]["android-v1"]["ingress"]=="CLOSED" and a["planes"]["android-v1"]["materialEffectsAllowed"] is False
assert a["planes"]["vps-fabric"]["ingress"]=="CLOSED" and a["planes"]["vps-fabric"]["materialEffectsAllowed"] is False
assert x["routing"]["state"]=="CLOSED" and x["routing"]["materialCommandsAllowed"] is False
assert x["lease"]["state"]=="FREE"
assert g["schema"]=="capability-fabric.onshape-production-guard.v1"
assert g["generation"]==1 and g["killSwitch"]=="ENGAGED"
assert g["allowedDocumentIds"]==[]
assert g["mutationBudget"]=={"budgetId":"epoch4-seq67-stabilization-closed","maxMutations":0}
print("CF_R4_Q_AUTHORITY=epoch4-quiesced-guard-closed")
print("CF_R4_Q_ACTIVE=seq67")
print("CF_R4_Q_PREVIOUS=seq66")
PY
[[ "$(git hash-object "$CONTROL")" == "$expected_control" ]]
[[ "$(sha256sum "$active/manifest.json" | awk '{print $1}')" == "$expected_manifest" ]]
[[ -f "$GATE" ]]
grep -Fxq RELEASE_IN_PROGRESS "$GATE"
if systemctl is-active --quiet "$TIMER"; then exit 21; fi
[[ "$(docker inspect -f '{{.State.Running}}' "$GATEWAY")" == false ]]
[[ "$(docker inspect -f '{{.State.Running}}' "$SERVER")" == true ]]
[[ "$(docker inspect -f '{{.State.Running}}' "$FABRIC")" == true ]]
echo CF_R4_Q_RELEASE_GATE=active
echo CF_R4_Q_PULL_TIMER=stopped
echo CF_R4_Q_GATEWAY=stopped

sig="$SIGS/$expected_manifest.sig"
[[ -s "$sig" ]]
work="$(mktemp -d /var/lib/capability-fabric/.qual67.XXXXXX)"
trap 'rm -rf "$work"' EXIT
printf 'capability-fabric-deploy %s
' "$(tr -d '\r\n' < "$TRUST")" >"$work/allowed"
ssh-keygen -Y verify -f "$work/allowed" -I capability-fabric-deploy -n capability-fabric-deploy -s "$sig" <"$active/manifest.json" >/dev/null 2>&1
python3 - "$active/manifest.json" "$active" <<'PY'
import hashlib,json,os,sys
m=json.load(open(sys.argv[1])); root=sys.argv[2]
for rel,expected in m["files"].items():
    p=os.path.join(root,rel)
    assert os.path.isfile(p),rel
    assert hashlib.sha256(open(p,"rb").read()).hexdigest()==expected,rel
print("CF_R4_Q_FILE_CLOSURE=pass")
PY
echo CF_R4_Q_SIGNATURE=pass

ponr="$("$ROLLBACK_GUARD" decide --db "$DB" --control "$CONTROL" --quarantine "$QUARANTINE")"
printf '%s\n' "$ponr"
printf '%s\n' "$ponr" | grep -Fxq 'CF_A4_PONR=true'
printf '%s\n' "$ponr" | grep -Fxq 'CF_A4_PONR_COUNT=2'
printf '%s\n' "$ponr" | grep -Fxq 'CF_A4_UNRESOLVED_BLOCKING=0'
printf '%s\n' "$ponr" | grep -Fxq 'CF_A4_ZERO_UNRESOLVED=pass'
echo CF_R4_Q_SAFETY=pass

before_mutations="$(python3 - "$DB" <<'PY'
import json,sqlite3,sys
c=sqlite3.connect(f"file:{sys.argv[1]}?mode=ro",uri=True)
n=0
for (payload,) in c.execute("select dispatch_payload from invocations where dispatch_payload is not null"):
    try: d=json.loads(payload)
    except Exception: continue
    if (d.get("execution_payload") or {}).get("agentEffect")=="MUTATION": n+=1
print(n)
c.close()
PY
)"
before_reservations="$(find "$AGENT_DIR/mutation-budgets" -type f -name '*.json' 2>/dev/null | wc -l | tr -d ' ')"

node_out="$(docker exec -i "$SERVER" sh -lc 'cd /tmp/app && node --input-type=module' <<'NODE'
import fs from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
const DID="84d077d8370c21c4b3045263";
const WID="aa8c5ad631e1836645149d09";
const token=fs.readFileSync("/run/secrets/mcp-token","utf8").trim();
const client=new Client({name:"cf-r4-quiesced-qualifier",version:"1.0.0"});
const transport=new StreamableHTTPClientTransport(new URL("http://127.0.0.1:8788/mcp/"+token));
await client.connect(transport);
const parse=(res)=>{
  const raw=(res?.content||[]).filter(x=>x.type==="text").map(x=>x.text||"").join("\n");
  if(!raw) return null;
  try{return JSON.parse(raw);}catch{return {raw};}
};
const tools=(await client.listTools()).tools.map(x=>x.name);
for(const name of ["onshape_pool_status","onshape_fabric_capabilities","onshape_fabric_invoke"]) if(!tools.includes(name)) throw new Error("missing "+name);
if(tools.includes("onshape_ui_input_sequence")||tools.includes("onshape_ui_native")) throw new Error("effectful UI exposed");
const caps=parse(await client.callTool({name:"onshape_fabric_capabilities",arguments:{}}));
if(caps.build_id!=="onshape-vps-hardened-r4"||caps.public_surface!=="semantic-only"||caps.qualification_only!==false) throw new Error("wrong r4 surface");
const pool=parse(await client.callTool({name:"onshape_pool_status",arguments:{}}));
if(pool.pool_enabled!==true||pool.size!==3||pool.active_count!==0||pool.queued_count!==0||pool.document_lock_count!==0) throw new Error("pool not idle");
if(pool.material_mutator_session_id!=="session-1") throw new Error("wrong mutator");
for(const s of pool.sessions||[]) if(s?.auth?.state!=="PROVEN") throw new Error("session not proven");

const read=parse(await client.callTool({name:"onshape_fabric_invoke",arguments:{
  capability_id:"onshape.documented.operation",
  arguments:{operationId:"getDocument",pathParams:{did:DID},query:{}}
}}));
const rr=read?.result;
const ev=rr?.observation?.evidence||{};
const body=ev.body||{};
if(read?.build_id!=="onshape-vps-hardened-r4"||rr?.outcome?.state!=="ACHIEVED"||ev.httpStatus!==200||ev.effectSent!==false) throw new Error("r4 read failed");
if(body.id!==DID||body.name!=="Speedtest 2"||body?.defaultWorkspace?.id!==WID) throw new Error("wrong document state");
console.log("CF_R4_Q_READ=pass");
console.log("CF_R4_Q_READ_EFFECT_SENT=false");
console.log("CF_R4_Q_POOL=3-of-3-PROVEN-idle");

let rejected=false;
try {
  const mut=await client.callTool({name:"onshape_fabric_invoke",arguments:{
    capability_id:"onshape.documented.operation",
    arguments:{
      operationId:"updateDocumentAttributes",
      pathParams:{did:DID},
      query:{},
      body:{name:"MUST NOT APPLY - R4 QUALIFICATION"},
      verification:{kind:"document_name_equals",value:"MUST NOT APPLY - R4 QUALIFICATION"}
    }
  }});
  const parsed=parse(mut);
  const joined=JSON.stringify(parsed||{});
  if(mut?.isError===true || /quiesced|material authority|permission|not admitted|closed/i.test(joined)) rejected=true;
  if(parsed?.result?.outcome?.state==="ACHIEVED" || parsed?.result?.observation?.evidence?.effectSent===true) throw new Error("negative mutation unexpectedly achieved");
} catch (e) {
  if(/quiesced|material authority|permission|not admitted|closed|tool returned|MCP/i.test(String(e))) rejected=true;
  else throw e;
}
if(!rejected) throw new Error("negative mutation was not conclusively rejected");
console.log("CF_R4_Q_NEGATIVE_MUTATION=rejected-pre-effect");

const read2=parse(await client.callTool({name:"onshape_fabric_invoke",arguments:{
  capability_id:"onshape.documented.operation",
  arguments:{operationId:"getDocument",pathParams:{did:DID},query:{}}
}}));
const r2=read2?.result, e2=r2?.observation?.evidence||{}, b2=e2.body||{};
if(r2?.outcome?.state!=="ACHIEVED"||e2.effectSent!==false||b2.name!=="Speedtest 2") throw new Error("post-negative target changed");
console.log("CF_R4_Q_POST_NEGATIVE_READ=unchanged");
await client.close();
NODE
)"
printf '%s\n' "$node_out"

after_mutations="$(python3 - "$DB" <<'PY'
import json,sqlite3,sys
c=sqlite3.connect(f"file:{sys.argv[1]}?mode=ro",uri=True)
n=0
for (payload,) in c.execute("select dispatch_payload from invocations where dispatch_payload is not null"):
    try: d=json.loads(payload)
    except Exception: continue
    if (d.get("execution_payload") or {}).get("agentEffect")=="MUTATION": n+=1
print(n)
c.close()
PY
)"
after_reservations="$(find "$AGENT_DIR/mutation-budgets" -type f -name '*.json' 2>/dev/null | wc -l | tr -d ' ')"
[[ "$after_mutations" == "$before_mutations" ]] || { echo CF_R4_Q_NEGATIVE_DISPATCH_COUNT_CHANGED >&2; exit 40; }
[[ "$after_reservations" == "$before_reservations" ]] || { echo CF_R4_Q_NEGATIVE_BUDGET_RESERVED >&2; exit 41; }
echo "CF_R4_Q_MUTATION_ROWS=$after_mutations"
echo "CF_R4_Q_BUDGET_RESERVATIONS=$after_reservations"
echo CF_R4_Q_NEGATIVE_NO_DISPATCH=pass
echo CF_R4_Q_NEGATIVE_NO_BUDGET_RESERVATION=pass

ponr2="$("$ROLLBACK_GUARD" decide --db "$DB" --control "$CONTROL" --quarantine "$QUARANTINE")"
printf '%s\n' "$ponr2" | grep -Fxq 'CF_A4_PONR_COUNT=2'
printf '%s\n' "$ponr2" | grep -Fxq 'CF_A4_UNRESOLVED_BLOCKING=0'
echo CF_R4_Q_POST_SAFETY=pass
echo CF_R4_Q=pass
