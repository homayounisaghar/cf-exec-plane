#!/usr/bin/env bash
set -euo pipefail
umask 077
[[ "$(id -u)" -eq 0 ]] || exit 2

ACTIVE=/opt/capability-fabric/current
STATE=/var/lib/capability-fabric/state
CONTROL=/var/lib/capability-fabric/onshape/runtime-control/ONSHAPE_RUNTIME_CONTROL.json
MIRROR_BLOB=/var/lib/capability-fabric/onshape/runtime-control/git-blob-sha
GATE="$STATE/release-in-progress"
LOCK=/run/lock/capability-fabric-pull.lock
TIMER=capability-fabric-pull.timer
GATEWAY=capability-fabric-onshape-gateway
SERVER=capability-fabric-onshape-server
DB=/var/lib/capability-fabric/onshape/fabric-state/execution.sqlite3
AGENT_DIR=/var/lib/capability-fabric/onshape/fabric-agent

EXPECTED_CONTROL=d803ce77c7aa9aed513e26609aa268e96df61454
DID=8ca702971e2419cfa45cc87c
WID=8bbf262de8f6c2015d72fd7d
EID=dc6eb5c8b694395c14024558
FID=FwHDp7GXelUCXDl_0

[[ "$(basename "$(readlink -f "$ACTIVE")")" == "onshape-vps-hardened-production-r5" ]] || exit 20
[[ "$(git hash-object "$CONTROL")" == "$EXPECTED_CONTROL" ]] || exit 20
[[ "$(tr -d '\r\n' < "$MIRROR_BLOB")" == "$EXPECTED_CONTROL" ]] || exit 20
[[ -f "$GATE" ]] && grep -Fxq RELEASE_IN_PROGRESS "$GATE"
if systemctl is-active --quiet "$TIMER"; then exit 20; fi
[[ "$(docker inspect -f '{{.State.Running}}' "$GATEWAY")" == false ]] || exit 20
[[ "$(docker inspect -f '{{.State.Running}}' "$SERVER")" == true ]] || exit 20

python3 - "$CONTROL" "$DID" <<'PY'
import json,sys
x=json.load(open(sys.argv[1])); did=sys.argv[2]; a=x["authority"]; g=a["productionGuard"]
assert x["controlRevision"]==543 and a["productionEpoch"]==14
assert g["generation"]==4 and g["killSwitch"]=="OPEN"
assert g["allowedDocumentIds"]==[did]
assert g["mutationBudget"]=={"budgetId":"e9-selector-durability-slice-a-20260925","maxMutations":4}
print("CF_E9_RECON_GUARD=semantic-lab-only-budget4")
PY

python3 - "$DB" "$DID" <<'PY'
import json,sqlite3,sys
db,did=sys.argv[1:]
c=sqlite3.connect(f"file:{db}?mode=ro",uri=True); c.row_factory=sqlite3.Row
rows=c.execute("""
SELECT i.rowid,i.invocation_id,i.phase,i.payload AS invocation_payload,i.dispatch_payload,
       o.operation_id,o.state AS operation_state,o.outcome_payload,
       a.attempt_id,a.state AS attempt_state,a.observation_payload
FROM invocations i
LEFT JOIN operations o ON o.invocation_id=i.invocation_id
LEFT JOIN attempts a ON a.operation_id=o.operation_id
WHERE i.payload LIKE ?
ORDER BY i.rowid DESC LIMIT 40
""", ("%"+did+"%",)).fetchall()
print("CF_E9_RECON_DB_ROWS="+str(len(rows)))
for r in rows:
 d=dict(r)
 for k in ["invocation_payload","dispatch_payload","outcome_payload","observation_payload"]:
  if d.get(k):
   try:d[k]=json.loads(d[k])
   except Exception:pass
 print("CF_E9_RECON_DB_ROW="+json.dumps(d,separators=(',',':'),sort_keys=True))
c.close()
PY

python3 - "$AGENT_DIR" <<'PY'
import json,pathlib,sys
root=pathlib.Path(sys.argv[1])
items=[]
for p in root.rglob("*.json"):
 try:v=json.loads(p.read_text())
 except Exception:continue
 if isinstance(v,dict) and (
   v.get("budgetId")=="e9-selector-durability-slice-a-20260925"
   or str(v.get("documentId") or "")=="8ca702971e2419cfa45cc87c"
 ):
  items.append((str(p.relative_to(root)),v))
print("CF_E9_RECON_AGENT_ROWS="+str(len(items)))
for name,v in items:
 print("CF_E9_RECON_AGENT_ROW="+json.dumps({"file":name,**v},separators=(',',':'),sort_keys=True))
PY

exec 9>"$LOCK"
flock -w 30 9 || exit 21
restore=yes
cleanup(){
 rc=$?
 set +e
 if [[ "$restore" == yes && ! -e "$GATE" ]]; then
   tmp="$GATE.tmp.e9recon.$$"; printf '%s\n' RELEASE_IN_PROGRESS >"$tmp"; chmod 0600 "$tmp"; chown root:root "$tmp"; mv -f "$tmp" "$GATE"
 fi
 exit "$rc"
}
trap cleanup EXIT
rm -f "$GATE"

docker exec -e CF_DID="$DID" -e CF_WID="$WID" -e CF_EID="$EID" -e CF_FID="$FID" -i "$SERVER" sh -lc 'cd /tmp/app && node --input-type=module' <<'NODE'
import fs from "node:fs";
import {Client} from "@modelcontextprotocol/sdk/client/index.js";
import {StreamableHTTPClientTransport} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
const DID=process.env.CF_DID,WID=process.env.CF_WID,EID=process.env.CF_EID,FID=process.env.CF_FID;
const token=fs.readFileSync("/run/secrets/mcp-token","utf8").trim();
const client=new Client({name:"cf-e9-forward-reconcile",version:"1.0.0"});
await client.connect(new StreamableHTTPClientTransport(new URL("http://127.0.0.1:8788/mcp/"+token)));
const parse=res=>{
 const raw=(res?.content||[]).filter(x=>x.type==="text").map(x=>x.text||"").join("\n");
 if(!raw) throw new Error("empty tool response");
 return JSON.parse(raw);
};
const invoke=async(operationId,args={})=>parse(await client.callTool({name:"onshape_fabric_invoke",arguments:{
 capability_id:"onshape.documented.operation",arguments:{operationId,...args}
}}));
const fwrap=await invoke("getPartStudioFeatures",{pathParams:{did:DID,wvm:"w",wvmid:WID,eid:EID},query:{}});
const fr=fwrap?.result,fe=fr?.observation?.evidence||{},fb=fe.body||{};
if(fr?.outcome?.state!=="ACHIEVED"||fe.httpStatus!==200||fe.effectSent!==false) throw new Error("feature read failed");
if(fe.apiVersion!=="v17"||fe.observedApiVersion!=="v17"||fe.apiVersionMatched!==true) throw new Error("feature read version");
const feat=(fb.features||[]).find(x=>x.featureId===FID);
if(!feat) throw new Error("feature missing");
const depth=String((feat.parameters||[]).find(p=>p.parameterId==="depth")?.expression||"");
console.log("CF_E9_RECON_FEATURE_DEPTH="+depth);
console.log("CF_E9_RECON_FEATURE_STATUS="+String(feat.featureStatus||""));
console.log("CF_E9_RECON_FEATURE_MICROVERSION="+String(fb.sourceMicroversion||""));

const dwrap=await invoke("getPartStudioBodyDetails",{pathParams:{did:DID,wvm:"w",wvmid:WID,eid:EID},query:{}});
const dr=dwrap?.result,de=dr?.observation?.evidence||{},db=de.body||{};
if(dr?.outcome?.state!=="ACHIEVED"||de.httpStatus!==200||de.effectSent!==false) throw new Error("body read failed");
const target=[0.021753765216512438,0.01565687540839336];
let best=null;
for(const body of db.bodies||[]) for(const edge of body.edges||[]){
 const q=edge?.curve;
 if(q?.type!=="CIRCLE"||!q.origin) continue;
 const dist=Math.hypot(Number(q.origin.x)-target[0],Number(q.origin.y)-target[1]);
 if(best==null||dist<best.d||(Math.abs(dist-best.d)<1e-12&&Number(q.origin.z)>best.z)) best={d:dist,z:Number(q.origin.z)};
}
if(!best||best.d>1e-5) throw new Error("reference circular edge missing");
console.log("CF_E9_RECON_TOP_Z="+String(best.z));
console.log("CF_E9_RECON_READBACK=pass");
await client.close();
NODE

tmp="$GATE.tmp.e9recon.$$"
printf '%s\n' RELEASE_IN_PROGRESS >"$tmp"
chmod 0600 "$tmp"; chown root:root "$tmp"; mv -f "$tmp" "$GATE"
restore=no
trap - EXIT
echo CF_E9_RECON_RELEASE_GATE=active
echo CF_E9_RECON=pass
