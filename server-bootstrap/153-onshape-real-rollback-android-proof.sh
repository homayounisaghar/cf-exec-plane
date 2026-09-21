#!/usr/bin/env bash
set -euo pipefail
umask 077
[[ "$(id -u)" -eq 0 ]] || exit 2

CONTROL=/var/lib/capability-fabric/onshape/runtime-control/ONSHAPE_RUNTIME_CONTROL.json
GATE=/var/lib/capability-fabric/state/release-in-progress
LOCK=/run/lock/capability-fabric-pull.lock
TIMER=capability-fabric-pull.timer
GATEWAY=capability-fabric-onshape-gateway
SERVER=capability-fabric-onshape-server
DB=/var/lib/capability-fabric/onshape/fabric-state/execution.sqlite3
AGENT_DIR=/var/lib/capability-fabric/onshape/fabric-agent
expected_blob=1448da5a45013e254e3b954bb10a03d95456a846
did=881affea8ea63c33ae4e6c78
closed_budget_id=epoch7-post-test-closed
closed_budget_key="$(printf '%s' "3:$closed_budget_id" | sha256sum | awk '{print $1}')"
closed_budget_dir="$AGENT_DIR/mutation-budgets/$closed_budget_key"

[[ "$(git hash-object "$CONTROL")" == "$expected_blob" ]]
[[ -f "$GATE" ]]
if systemctl is-active --quiet "$TIMER"; then exit 20; fi
[[ "$(docker inspect -f '{{.State.Running}}' "$GATEWAY")" == false ]]
[[ "$(docker inspect -f '{{.State.Running}}' "$SERVER")" == true ]]

python3 - "$CONTROL" <<'PY'
import json,sys
x=json.load(open(sys.argv[1])); a=x["authority"]; g=a["productionGuard"]
assert x["controlRevision"]==538
assert a["productionEpoch"]==9 and a["mode"]=="ANDROID_PRODUCTION" and a["materialAuthority"]=="android-v1"
assert a["planes"]["android-v1"]["ingress"]=="ADMITTED" and a["planes"]["android-v1"]["materialEffectsAllowed"] is True
assert a["planes"]["android-v1"]["busGeneration"]==3
assert a["planes"]["vps-fabric"]["ingress"]=="CLOSED" and a["planes"]["vps-fabric"]["materialEffectsAllowed"] is False
assert x["routing"]["state"]=="ADMITTED" and x["routing"]["materialCommandsAllowed"] is True
assert x["routing"]["activeMailboxIssue"]==50 and x["routing"]["busGeneration"]==3
assert x["lease"]["state"]=="FREE"
assert g["generation"]==3 and g["killSwitch"]=="ENGAGED" and g["allowedDocumentIds"]==[]
assert g["mutationBudget"]=={"budgetId":"epoch7-post-test-closed","maxMutations":0}
print("CF_ROLLBACK_ANDROID_AUTHORITY=epoch9-bus3-mailbox50")
PY

before_dispatch="$(python3 - "$DB" <<'PY'
import json,sqlite3,sys
c=sqlite3.connect(f"file:{sys.argv[1]}?mode=ro",uri=True)
n=0
for (payload,) in c.execute("select dispatch_payload from invocations where dispatch_payload is not null"):
    try:d=json.loads(payload)
    except Exception:continue
    if (d.get("execution_payload") or {}).get("agentEffect")=="MUTATION": n+=1
print(n)
c.close()
PY
)"
if [[ -d "$closed_budget_dir" ]]; then before_res="$(find "$closed_budget_dir" -maxdepth 1 -type f -name '*.json' -print | wc -l | tr -d ' ')"; else before_res=0; fi

exec 9>"$LOCK"
flock -w 30 9 || exit 21
window=no
cleanup(){
 rc=$?
 set +e
 if [[ "$window" == yes ]]; then
   tmp="$GATE.tmp.$$"; printf '%s\n' RELEASE_IN_PROGRESS >"$tmp"; chmod 0600 "$tmp"; chown root:root "$tmp"; mv -f "$tmp" "$GATE"
 fi
 docker stop "$GATEWAY" >/dev/null 2>&1 || true
 systemctl stop "$TIMER" >/dev/null 2>&1 || true
 exit "$rc"
}
trap cleanup EXIT
rm -f "$GATE"; window=yes

node_out="$(docker exec -i "$SERVER" sh -lc 'cd /tmp/app && node --input-type=module' <<'NODE'
import fs from "node:fs";
import {Client} from "@modelcontextprotocol/sdk/client/index.js";
import {StreamableHTTPClientTransport} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
const DID="881affea8ea63c33ae4e6c78";
const EXPECTED="CF-R4-TARGET-TEST-B";
const FORBIDDEN="MUST NOT APPLY - ANDROID ROLLBACK AUTHORITY";
const token=fs.readFileSync("/run/secrets/mcp-token","utf8").trim();
const client=new Client({name:"cf-rollback-vps-negative",version:"1"});
const tr=new StreamableHTTPClientTransport(new URL("http://127.0.0.1:8788/mcp/"+token));
await client.connect(tr);
const parse=(res)=>{
 const raw=(res?.content||[]).filter(x=>x.type==="text").map(x=>x.text||"").join("\n");
 if(!raw)return null; try{return JSON.parse(raw)}catch{return {raw}};
};
const call=async(args)=>client.callTool({name:"onshape_fabric_invoke",arguments:{capability_id:"onshape.documented.operation",arguments:args}});
const pre=parse(await call({operationId:"getDocument",pathParams:{did:DID},query:{}}));
const pr=pre?.result,pe=pr?.observation?.evidence||{},pb=pe.body||{};
if(pr?.outcome?.state!=="ACHIEVED"||pe.effectSent!==false||pb.name!==EXPECTED) throw new Error("pre-read mismatch");
console.log("CF_ROLLBACK_VPS_PRE_READ=pass");

const raw=await call({operationId:"updateDocumentAttributes",pathParams:{did:DID},query:{},body:{name:FORBIDDEN},verification:{kind:"document_name_equals",value:FORBIDDEN}});
const neg=parse(raw);
const nr=neg?.result,ne=nr?.observation?.evidence||{};
if(nr?.outcome?.state==="ACHIEVED"||ne.effectSent===true) throw new Error("VPS mutation achieved while Android authoritative");
console.log("CF_ROLLBACK_VPS_NEGATIVE_RESPONSE="+JSON.stringify(neg));

const post=parse(await call({operationId:"getDocument",pathParams:{did:DID},query:{}}));
const rr=post?.result,re=rr?.observation?.evidence||{},rb=re.body||{};
if(rr?.outcome?.state!=="ACHIEVED"||re.effectSent!==false||rb.name!==EXPECTED) throw new Error("post-read changed");
console.log("CF_ROLLBACK_VPS_POST_READ=unchanged");
await client.close();
NODE
)"
printf '%s\n' "$node_out"

tmp="$GATE.tmp.$$"; printf '%s\n' RELEASE_IN_PROGRESS >"$tmp"; chmod 0600 "$tmp"; chown root:root "$tmp"; mv -f "$tmp" "$GATE"
window=no

after_dispatch="$(python3 - "$DB" <<'PY'
import json,sqlite3,sys
c=sqlite3.connect(f"file:{sys.argv[1]}?mode=ro",uri=True)
n=0
for (payload,) in c.execute("select dispatch_payload from invocations where dispatch_payload is not null"):
    try:d=json.loads(payload)
    except Exception:continue
    if (d.get("execution_payload") or {}).get("agentEffect")=="MUTATION": n+=1
print(n)
c.close()
PY
)"
if [[ -d "$closed_budget_dir" ]]; then after_res="$(find "$closed_budget_dir" -maxdepth 1 -type f -name '*.json' -print | wc -l | tr -d ' ')"; else after_res=0; fi
[[ "$after_dispatch" == "$before_dispatch" ]]
[[ "$after_res" == "$before_res" ]]
echo CF_ROLLBACK_VPS_NEGATIVE_NO_DISPATCH=pass
echo CF_ROLLBACK_VPS_NEGATIVE_NO_BUDGET=pass
echo CF_ROLLBACK_VPS_MATERIAL_DISABLED=pass
echo CF_ROLLBACK_ANDROID_HALF=pass
