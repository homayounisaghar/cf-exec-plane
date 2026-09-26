#!/usr/bin/env bash
set -euo pipefail
umask 077
[[ "$(id -u)" -eq 0 ]] || exit 2

candidate="c0cadee962c2059ba939c40c6bb9adf1bc99edfe"
fixture="a19e0fa5152af9f7ce106b6e:e5e7d0173fd1f1d0307a2cb6:e0929361aadb6135b5cecffa"
research=capability-fabric-onshape-phase0-research
sidecar=capability-fabric-onshape-phase0-fabric
release="/var/lib/capability-fabric/onshape-research-phase0/releases/$candidate"
control=/var/lib/capability-fabric/onshape/runtime-control/ONSHAPE_RUNTIME_CONTROL.json

python3 - "$control" <<'PY'
import json,sys
d=json.load(open(sys.argv[1])); a=d["authority"]; g=a["productionGuard"]
assert a["mode"]=="VPS_PRODUCTION" and a["materialAuthority"]=="vps-fabric"
assert a["planes"]["android-v1"]["ingress"]=="CLOSED"
assert a["reconciliationHold"]["active"] is False
assert g["killSwitch"]=="ENGAGED"
assert g["allowedDocumentIds"]==[]
assert g["mutationBudget"]["maxMutations"]==0
print("CF_PHASE0_BENCH_PRODUCTION_BOUNDARY=pass")
print("CF_PHASE0_BENCH_CONTROL_REV="+str(d["controlRevision"]))
print("CF_PHASE0_BENCH_EPOCH="+str(a["productionEpoch"]))
PY

for c in "$research" "$sidecar"; do
  [[ "$(docker inspect -f '{{.State.Running}}' "$c" 2>/dev/null || echo false)" == true ]]
  [[ "$(docker inspect -f '{{.State.Health.Status}}' "$c")" == healthy ]]
done
env_dump="$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$research")"
grep -Fxq "CF_RESEARCH_SOURCE_COMMIT=$candidate" <<<"$env_dump"
grep -Fxq "CF_RESEARCH_FIXTURE_TARGET=$fixture" <<<"$env_dump"
echo CF_PHASE0_BENCH_BINDING=pass

PYTHONPATH="$release/server-deploy/current/fabric-src" python3 - <<'PY'
from capability_fabric.persistence import SqliteExecutionStateStore
p="/var/lib/capability-fabric/onshape-research-phase0/fabric-state/execution.sqlite3"
with SqliteExecutionStateStore(p) as s:
    assert not s.recoverable()
print("CF_PHASE0_BENCH_RECOVERABLE=zero")
PY

docker exec -e CF_FIXTURE="$fixture" -i "$research" sh -lc 'cd /tmp/app && node --input-type=module' <<'NODE'
import fs from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const [did,wid,eid]=process.env.CF_FIXTURE.split(":");
const token=fs.readFileSync("/run/secrets/mcp-token","utf8").trim();
const c=new Client({name:"cf-phase0-benchmark-preflight",version:"1.0"});
await c.connect(new StreamableHTTPClientTransport(new URL("http://127.0.0.1:8898/mcp/"+token)));
const parse=r=>JSON.parse((r.content||[]).filter(x=>x.type==="text").map(x=>x.text).join("\n"));
const timedCall=async(name,args={})=>{
  const t0=performance.now();
  const res=parse(await c.callTool({name,arguments:args},undefined,{timeout:180000}));
  return {res,ms:performance.now()-t0};
};
const viewer=async(params)=>{
  const x=await timedCall("onshape_ui_native",{document_id:did,workspace_id:wid,element_id:eid,action:"runtime.viewer",params});
  const r=x.res.result;
  if(r?.outcome?.state!=="ACHIEVED"||r?.observation?.ackState!=="ACKNOWLEDGED") throw new Error(JSON.stringify(r));
  return {value:r.observation.evidence.result,ms:x.ms};
};
const q=(xs,p)=>{
  const a=[...xs].sort((x,y)=>x-y);
  const i=(a.length-1)*p,lo=Math.floor(i),hi=Math.ceil(i);
  return a[lo]+(a[hi]-a[lo])*(i-lo);
};
const stats=xs=>({
  n:xs.length,
  min:+Math.min(...xs).toFixed(2),
  p50:+q(xs,.5).toFixed(2),
  p95:+q(xs,.95).toFixed(2),
  max:+Math.max(...xs).toFixed(2),
  mean:+(xs.reduce((a,b)=>a+b,0)/xs.length).toFixed(2)
});
const selSig=m=>JSON.stringify((m?.model_selection?.selections||[]).map(s=>({
  deterministic_id:s?.deterministic_id??null,
  selection_id:s?.selection_id??null,
  is_face:s?.is_face??null,
  is_edge:s?.is_edge??null,
  is_body:s?.is_body??null,
  is_vertex:s?.is_vertex??null
})));

try{
  const statusTimes=[];
  for(let i=0;i<5;i++){
    const s=await timedCall("onshape_session_status");
    if(s.res?.auth?.state!=="PROVEN"||s.res?.auth?.http_status!==200) throw new Error("auth not proven");
    statusTimes.push(s.ms);
  }
  console.log("CF_PHASE0_BENCH_AUTH=PROVEN");
  console.log("CF_PHASE0_BENCH_STATUS_MS="+JSON.stringify(stats(statusTimes)));

  const before=await viewer({op:"inspect"});
  const beforeSig=selSig(before.value);
  const inspectTimes=[before.ms];
  for(let i=1;i<5;i++){
    const x=await viewer({op:"inspect"});
    if(selSig(x.value)!==beforeSig) throw new Error("read-only inspect changed authoritative selection");
    inspectTimes.push(x.ms);
  }
  console.log("CF_PHASE0_BENCH_VIEWER_INSPECT_MS="+JSON.stringify(stats(inspectTimes)));

  const probeTimes=[];
  for(let i=0;i<5;i++){
    const x=await viewer({op:"probe",x_fraction:.52,y_fraction:.50});
    const hit=(x.value?.probe?.picks||[]).find(p=>p?.deterministic_id==="JHK");
    if(!hit) throw new Error("qualified JHK benchmark anchor absent");
    if(selSig(x.value)!==beforeSig) throw new Error("read-only probe changed authoritative selection");
    probeTimes.push(x.ms);
  }
  console.log("CF_PHASE0_BENCH_VIEWER_PROBE_MS="+JSON.stringify(stats(probeTimes)));

  const after=await viewer({op:"inspect"});
  if(selSig(after.value)!==beforeSig) throw new Error("preflight mutated authoritative selection");
  console.log("CF_PHASE0_BENCH_READONLY=pass");
  console.log("CF_PHASE0_BENCH_GATE="+JSON.stringify({
    benchmark_id:"onshape-virtual-ui-phase0-v1",
    semantic_coverage:"PASS",
    human_baseline:"MISSING",
    ambiguous_policy_corpus:"MISSING",
    model_result_inspection_allowed:false,
    policy_benchmark:"BLOCKED"
  }));
  console.log("CF_PHASE0_BENCH_PREFLIGHT=pass");
} finally {
  await c.close().catch(()=>{});
}
NODE

PYTHONPATH="$release/server-deploy/current/fabric-src" python3 - <<'PY'
from capability_fabric.persistence import SqliteExecutionStateStore
p="/var/lib/capability-fabric/onshape-research-phase0/fabric-state/execution.sqlite3"
with SqliteExecutionStateStore(p) as s:
    assert not s.recoverable()
print("CF_PHASE0_BENCH_POST_RECOVERABLE=zero")
PY
