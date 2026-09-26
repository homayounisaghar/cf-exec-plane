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
assert g["killSwitch"]=="ENGAGED" and g["allowedDocumentIds"]==[] and g["mutationBudget"]["maxMutations"]==0
print("CF_PHASE0_BODYSEL_PRODUCTION_BOUNDARY=pass")
print("CF_PHASE0_BODYSEL_CONTROL_REV="+str(d["controlRevision"]))
print("CF_PHASE0_BODYSEL_EPOCH="+str(a["productionEpoch"]))
PY

for c in "$research" "$sidecar"; do
  [[ "$(docker inspect -f '{{.State.Running}}' "$c" 2>/dev/null || echo false)" == true ]]
  [[ "$(docker inspect -f '{{.State.Health.Status}}' "$c")" == healthy ]]
done
env_dump="$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$research")"
grep -Fxq "CF_RESEARCH_SOURCE_COMMIT=$candidate" <<<"$env_dump"
grep -Fxq "CF_RESEARCH_FIXTURE_TARGET=$fixture" <<<"$env_dump"
echo CF_PHASE0_BODYSEL_BINDING=pass

PYTHONPATH="$release/server-deploy/current/fabric-src" python3 - <<'PY'
from capability_fabric.persistence import SqliteExecutionStateStore
p="/var/lib/capability-fabric/onshape-research-phase0/fabric-state/execution.sqlite3"
with SqliteExecutionStateStore(p) as s:
    assert not s.recoverable()
print("CF_PHASE0_BODYSEL_RECOVERABLE=zero")
PY

docker exec -e CF_FIXTURE="$fixture" -i "$research" sh -lc 'cd /tmp/app && node --input-type=module' <<'NODE'
import fs from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const [did,wid,eid]=process.env.CF_FIXTURE.split(":");
const token=fs.readFileSync("/run/secrets/mcp-token","utf8").trim();
const c=new Client({name:"cf-phase0-body-selection",version:"1.0"});
await c.connect(new StreamableHTTPClientTransport(new URL("http://127.0.0.1:8898/mcp/"+token)));
const parse=r=>JSON.parse((r.content||[]).filter(x=>x.type==="text").map(x=>x.text).join("\n"));
const call=async(name,args={})=>parse(await c.callTool({name,arguments:args},undefined,{timeout:180000}));
const viewer=async(params)=>{
  const w=await call("onshape_ui_native",{document_id:did,workspace_id:wid,element_id:eid,action:"runtime.viewer",params});
  const r=w.result;
  if(r?.outcome?.state!=="ACHIEVED"||r?.observation?.ackState!=="ACKNOWLEDGED") throw new Error(JSON.stringify(r));
  return r.observation.evidence.result;
};
const evalp=async(expression)=>{
  const w=await call("onshape_ui_native",{document_id:did,workspace_id:wid,element_id:eid,action:"page.evaluate",params:{expression}});
  const r=w.result;
  if(r?.outcome?.state!=="ACHIEVED"||r?.observation?.ackState!=="ACKNOWLEDGED") throw new Error(JSON.stringify(r));
  return r.observation.evidence.result.value;
};
const input=async(label,steps)=>{
  const w=await call("onshape_ui_input",{document_id:did,workspace_id:wid,element_id:eid,steps});
  const r=w.result;
  console.log("CF_PHASE0_BODYSEL_INPUT_"+label+"="+JSON.stringify({outcome:r?.outcome||null,observation:r?.observation||null}));
  if(r?.outcome?.state!=="ACHIEVED"||r?.observation?.ackState!=="ACKNOWLEDGED") throw new Error(label+" input not achieved");
  return r;
};

try{
  const st=await call("onshape_session_status");
  if(st?.auth?.state!=="PROVEN"||st?.auth?.http_status!==200) throw new Error("auth");
  console.log("CF_PHASE0_BODYSEL_AUTH=PROVEN");

  const anchor=await viewer({op:"probe",x_fraction:.52,y_fraction:.50});
  const face=(anchor?.probe?.picks||[]).find(x=>x?.deterministic_id==="JHK");
  const bodyId=face?.getters?.body_id??face?.entity_metadata?.bodyId??null;
  const bodyName=face?.entity_metadata?.bodyMetaData?.name??null;
  const featureIds=face?.entity_metadata?.featureIds??null;
  if(bodyId!=="JHD"||bodyName!=="Part 1") throw new Error("semantic body anchor absent");
  console.log("CF_PHASE0_BODYSEL_BODY_ANCHOR="+JSON.stringify({body_id:bodyId,body_name:bodyName,feature_ids:featureIds,source_face:face?.deterministic_id??null}));

  if((anchor?.model_selection?.count??0)!==0){
    const clearProbe=await viewer({op:"probe",x_fraction:.58,y_fraction:.52});
    if(clearProbe?.probe?.status!=="MISS") throw new Error("clear point not empty");
    const canvas=await evalp('(() => {const e=document.querySelector("#canvas"),r=e?.getBoundingClientRect();return r?{x:r.x,y:r.y,w:r.width,h:r.height}:null})()');
    if(!canvas||canvas.w<=1||canvas.h<=1) throw new Error("canvas");
    const clearX=Math.round(canvas.x+canvas.w*.58), clearY=Math.round(canvas.y+canvas.h*.52);
    await input("CLEAR",[{action:"mouse.click",x:clearX,y:clearY,button:"left",click_count:1,after_ms:180}]);
    const cleared=await viewer({op:"inspect"});
    if((cleared?.model_selection?.count??-1)!==0) throw new Error("selection clear not authoritative");
    console.log("CF_PHASE0_BODYSEL_CLEAR=pass");
  }

  const target=await evalp(`(() => {
    const rows=Array.from(document.querySelectorAll('#part-list .os-list-item[data-id="JHD"]')).filter(el=>{
      const r=el.getBoundingClientRect(),s=getComputedStyle(el);
      return r.width>1&&r.height>1&&s.display!=="none"&&s.visibility!=="hidden"&&(el.textContent||"").trim()==="Part 1";
    });
    if(rows.length!==1) return {count:rows.length,target:null};
    const el=rows[0],r=el.getBoundingClientRect();
    return {count:1,target:{data_id:el.getAttribute("data-id"),text:(el.textContent||"").trim(),className:el.className,rect:{x:r.x,y:r.y,w:r.width,h:r.height}}};
  })()`);
  if(target?.count!==1||target?.target?.data_id!==bodyId||target?.target?.text!==bodyName) throw new Error("unique semantic Part row absent");
  const r=target.target.rect;
  if(!(r?.w>1&&r?.h>1)) throw new Error("invalid semantic Part row rect");
  const xy={x:Math.round(r.x+r.w/2),y:Math.round(r.y+r.h/2)};
  console.log("CF_PHASE0_BODYSEL_PRE="+JSON.stringify({body_id:bodyId,body_name:bodyName,target:target.target,click:xy}));

  const confirm=await evalp(`(() => {
    const rows=Array.from(document.querySelectorAll('#part-list .os-list-item[data-id="JHD"]')).filter(el=>{
      const r=el.getBoundingClientRect(),s=getComputedStyle(el);
      return r.width>1&&r.height>1&&s.display!=="none"&&s.visibility!=="hidden"&&(el.textContent||"").trim()==="Part 1";
    });
    if(rows.length!==1) return {count:rows.length,target:null};
    const el=rows[0],r=el.getBoundingClientRect();
    return {count:1,target:{data_id:el.getAttribute("data-id"),text:(el.textContent||"").trim(),rect:{x:r.x,y:r.y,w:r.width,h:r.height}}};
  })()`);
  if(confirm?.count!==1||confirm?.target?.data_id!==bodyId||confirm?.target?.text!==bodyName) throw new Error("Body precommit identity changed");
  const cr=confirm.target.rect;
  const click={x:Math.round(cr.x+cr.w/2),y:Math.round(cr.y+cr.h/2)};

  await input("SELECT",[{action:"mouse.click",x:click.x,y:click.y,button:"left",click_count:1,after_ms:220}]);

  const post=await viewer({op:"inspect"});
  const sels=post?.model_selection?.selections||[];
  console.log("CF_PHASE0_BODYSEL_POST_RAW="+JSON.stringify(post?.model_selection||null));
  if(post?.model_selection?.count!==1||sels.length!==1) throw new Error("authoritative Body selection count mismatch");
  const selected=sels[0];
  if(selected?.is_body!==true||selected?.is_edge!==false||selected?.is_face!==false||selected?.is_vertex!==false) {
    throw new Error("post selection is not Body");
  }
  const candidateIds=[
    selected?.deterministic_id,selected?.selection_id,selected?.id_string,
    selected?.body_metadata?.id,selected?.entity_metadata?.bodyId,
    selected?.source_pick?.body_metadata?.id,selected?.source_pick?.entity_metadata?.bodyId
  ].filter(x=>typeof x==="string"&&x);
  if(!candidateIds.includes(bodyId)) throw new Error("post Body identity does not bridge to JHD");
  console.log("CF_PHASE0_BODYSEL_POST="+JSON.stringify({
    pre_body_id:bodyId,post_deterministic_id:selected?.deterministic_id??null,
    post_selection_id:selected?.selection_id??null,post_id_string:selected?.id_string??null,
    post_id_for_collection:selected?.id_for_collection??null,
    post_name:selected?.name??null,
    is_body:selected?.is_body??null,is_edge:selected?.is_edge??null,is_face:selected?.is_face??null,is_vertex:selected?.is_vertex??null,
    body_metadata:selected?.body_metadata??null,entity_metadata:selected?.entity_metadata??null,source_pick:selected?.source_pick??null
  }));
  console.log("CF_PHASE0_BODYSEL=pass");
} finally { await c.close().catch(()=>{}); }
NODE

PYTHONPATH="$release/server-deploy/current/fabric-src" python3 - <<'PY'
from capability_fabric.persistence import SqliteExecutionStateStore
p="/var/lib/capability-fabric/onshape-research-phase0/fabric-state/execution.sqlite3"
with SqliteExecutionStateStore(p) as s:
    assert not s.recoverable()
print("CF_PHASE0_BODYSEL_POST_RECOVERABLE=zero")
PY
