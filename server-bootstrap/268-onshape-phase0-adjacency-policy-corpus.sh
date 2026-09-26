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
print("CF_PHASE0_ADJCORPUS_PRODUCTION_BOUNDARY=pass")
print("CF_PHASE0_ADJCORPUS_CONTROL_REV="+str(d["controlRevision"]))
print("CF_PHASE0_ADJCORPUS_EPOCH="+str(a["productionEpoch"]))
PY

for c in "$research" "$sidecar"; do
  [[ "$(docker inspect -f '{{.State.Running}}' "$c" 2>/dev/null || echo false)" == true ]]
  [[ "$(docker inspect -f '{{.State.Health.Status}}' "$c")" == healthy ]]
done
env_dump="$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$research")"
grep -Fxq "CF_RESEARCH_SOURCE_COMMIT=$candidate" <<<"$env_dump"
grep -Fxq "CF_RESEARCH_FIXTURE_TARGET=$fixture" <<<"$env_dump"
echo CF_PHASE0_ADJCORPUS_BINDING=pass

PYTHONPATH="$release/server-deploy/current/fabric-src" python3 - <<'PY'
from capability_fabric.persistence import SqliteExecutionStateStore
p="/var/lib/capability-fabric/onshape-research-phase0/fabric-state/execution.sqlite3"
with SqliteExecutionStateStore(p) as s:
    assert not s.recoverable()
print("CF_PHASE0_ADJCORPUS_RECOVERABLE=zero")
PY

docker exec -e CF_FIXTURE="$fixture" -i "$research" sh -lc 'cd /tmp/app && node --input-type=module' <<'NODE'
import fs from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const [did,wid,eid]=process.env.CF_FIXTURE.split(":");
const token=fs.readFileSync("/run/secrets/mcp-token","utf8").trim();
const c=new Client({name:"cf-phase0-policy-corpus-adjacency",version:"1.0"});
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
const triples=flat=>{const a=[];for(let i=0;i+2<flat.length;i+=3)a.push([+flat[i],+flat[i+1],+flat[i+2]]);return a.filter(p=>p.every(Number.isFinite));};
const lerp=(a,b,t)=>a.map((v,i)=>v+(b[i]-v)*t);
const invert4ColumnMajor=a=>{
  const m=Array.from({length:4},(_,r)=>Array.from({length:4},(_,col)=>Number(a[col*4+r])));
  const aug=m.map((row,r)=>[...row,...Array.from({length:4},(_,cc)=>r===cc?1:0)]);
  for(let col=0;col<4;col++){
    let p=col;for(let r=col+1;r<4;r++)if(Math.abs(aug[r][col])>Math.abs(aug[p][col]))p=r;
    if(Math.abs(aug[p][col])<1e-12)throw new Error("singular view matrix");
    [aug[col],aug[p]]=[aug[p],aug[col]];
    const d=aug[col][col];for(let j=0;j<8;j++)aug[col][j]/=d;
    for(let r=0;r<4;r++)if(r!==col){const f=aug[r][col];for(let j=0;j<8;j++)aug[r][j]-=f*aug[col][j];}
  }
  return aug.map(row=>row.slice(4));
};
const mul=(m,p)=>m.map(row=>row.reduce((s,x,i)=>s+x*p[i],0));
const project=(world,vd)=>{
  const inv=invert4ColumnMajor(vd.viewMatrix);
  const q=mul(inv,[...world,1]); const vx=q[0]/q[3],vy=q[1]/q[3];
  const [top,bottom,right,left]=vd.cameraViewport.map(Number);
  return {x:(vx-left)/(right-left),y:(top-vy)/(top-bottom)};
};
const inside=p=>Number.isFinite(p?.x)&&Number.isFinite(p?.y)&&p.x>.02&&p.x<.98&&p.y>.02&&p.y<.98;
const selSig=m=>JSON.stringify((m?.model_selection?.selections||[]).map(s=>({
  id:s?.deterministic_id??s?.selection_id??s?.id_string??null,
  f:s?.is_face??null,e:s?.is_edge??null,b:s?.is_body??null,v:s?.is_vertex??null
})));
const pickType=p=>{
  const t=p?.getters?.entity_type;
  if(t===2)return "Face";
  if(t===1||p?.entity_metadata?.meshIncrement?.primitiveType===1)return "Edge";
  if(t===0)return "Vertex";
  if(p?.getters?.surface_type!=null)return "Face";
  return null;
};
const addObs=(map,pick,seed,segment,t)=>{
  const type=pickType(pick),id=pick?.deterministic_id;
  if(!type||!id||(type!=="Face"&&type!=="Edge"))return;
  const key=type+":"+id;
  let x=map.get(key);
  if(!x){x={semantic_type:type,deterministic_id:id,body_id:pick?.getters?.body_id??pick?.entity_metadata?.bodyId??null,body_name:pick?.entity_metadata?.bodyMetaData?.name??null,observations:[]};map.set(key,x);}
  x.observations.push({x:seed.x,y:seed.y,segment,t});
};
const finalizeCandidates=(map,type)=>{
  return [...map.values()].filter(x=>x.semantic_type===type).map(x=>{
    const obs=x.observations;
    const sx=obs.reduce((s,o)=>s+o.x,0)/obs.length,sy=obs.reduce((s,o)=>s+o.y,0)/obs.length;
    return {...x,representative_seed:{x:sx,y:sy},observation_count:obs.length,center_dist:Math.hypot(sx-.5,sy-.5)};
  }).sort((a,b)=>a.representative_seed.x-b.representative_seed.x||a.representative_seed.y-b.representative_seed.y||a.deterministic_id.localeCompare(b.deterministic_id));
};
const metricSpecs=[
  {key:"leftmost",mode:"min",field:"x",texts:["Select the leftmost visible {K} candidate on Part 1.","Choose the {K} candidate farthest to the left on Part 1."]},
  {key:"rightmost",mode:"max",field:"x",texts:["Select the rightmost visible {K} candidate on Part 1.","Choose the {K} candidate farthest to the right on Part 1."]},
  {key:"topmost",mode:"min",field:"y",texts:["Select the highest visible {K} candidate on Part 1.","Choose the topmost {K} candidate on Part 1."]},
  {key:"bottommost",mode:"max",field:"y",texts:["Select the lowest visible {K} candidate on Part 1.","Choose the bottommost {K} candidate on Part 1."]},
  {key:"center_nearest",mode:"min",field:"center_dist",texts:["Select the {K} candidate nearest the viewport center.","Choose the most central {K} candidate."]},
  {key:"center_farthest",mode:"max",field:"center_dist",texts:["Select the {K} candidate farthest from the viewport center.","Choose the least central {K} candidate."]}
];
const metricValue=(x,field)=>field==="x"?x.representative_seed.x:field==="y"?x.representative_seed.y:x.center_dist;
const winner=(arr,spec)=>{
  const vals=arr.map((x,i)=>({i,v:metricValue(x,spec.field)})).sort((a,b)=>spec.mode==="min"?a.v-b.v:b.v-a.v);
  if(vals.length<2||Math.abs(vals[0].v-vals[1].v)<1e-9)return null;
  return vals[0].i;
};
const policyGeom=(arr,prefix)=>arr.map((x,i)=>({
  handle:prefix+(i+1),semantic_type:x.semantic_type,body_name:x.body_name,
  representative_seed:x.representative_seed,observation_count:x.observation_count,center_dist:x.center_dist
}));
const buildCases=(family,arr,prefix)=>{
  const out=[];
  for(const spec of metricSpecs){
    const wi=winner(arr,spec);if(wi==null)continue;
    for(const txt of spec.texts){
      out.push({
        case_id:family+"_"+String(out.length+1).padStart(2,"0"),
        family,intent_text:txt.replaceAll("{K}",family),start_state_fingerprint:"live-qualified-view-v1",
        policy_facing:{candidates:policyGeom(arr,prefix)},
        hidden_authoritative_label:{candidate_handle:prefix+(wi+1),deterministic_id:arr[wi].deterministic_id,semantic_type:family},
        label_evidence:{source:"JHK world-mesh topology-derived read-only semantic probes"},
        eligibility:"ELIGIBLE"
      });
      if(out.length===10)return out;
    }
  }
  throw new Error(family+" adjacency corpus produced fewer than 10 cases");
};
const uiPolicy=(rows,prefix)=>rows.map((x,i)=>({handle:prefix+(i+1),role:x.role,text:x.text,order:i+1}));
const uiCase=(id,intent,rows,prefix,wi)=>({
  case_id:id,family:"BodyOrUiSemantic",intent_text:intent,start_state_fingerprint:"live-qualified-ui-v1",
  policy_facing:{candidates:uiPolicy(rows,prefix)},
  hidden_authoritative_label:{candidate_handle:prefix+(wi+1),data_id:rows[wi].data_id,text:rows[wi].text,role:rows[wi].role},
  label_evidence:{source:"live semantic DOM data-id + visible row/tool order"},eligibility:"ELIGIBLE"
});

try{
  const st=await call("onshape_session_status");
  if(st?.auth?.state!=="PROVEN"||st?.auth?.http_status!==200)throw new Error("auth");
  console.log("CF_PHASE0_ADJCORPUS_AUTH=PROVEN");

  const anchor=await viewer({op:"probe",x_fraction:.52,y_fraction:.50});
  const baselineSig=selSig(anchor);
  const face=(anchor?.probe?.picks||[]).find(x=>x?.deterministic_id==="JHK");
  const flat=face?.entity_metadata?.meshIncrement?.points;
  if(!face||!Array.isArray(flat)||flat.length<18)throw new Error("qualified JHK mesh anchor absent");
  const pts=triples(flat),vd=anchor.view_data;
  if(pts.length<4)throw new Error("JHK topology insufficient");
  const found=new Map();
  addObs(found,face,{x:.52,y:.50},"anchor",0);

  const segments=[];
  for(let i=0;i<pts.length-1;i++)segments.push([i,i+1]);
  if(pts.length>2)segments.push([pts.length-1,0]);
  let probeCount=0;
  for(const [a,b] of segments.slice(0,12)){
    for(const t of [.25,.5,.75]){
      const seed=project(lerp(pts[a],pts[b],t),vd);
      if(!inside(seed))continue;
      const v=await viewer({op:"probe",x_fraction:seed.x,y_fraction:seed.y});
      probeCount++;
      if(selSig(v)!==baselineSig)throw new Error("read-only adjacency probe changed authoritative selection");
      for(const pick of (v?.probe?.picks||[]).slice(0,6))addObs(found,pick,seed,a+"-"+b,t);
    }
  }
  const faces=finalizeCandidates(found,"Face").slice(0,5);
  const edges=finalizeCandidates(found,"Edge").slice(0,5);
  console.log("CF_PHASE0_ADJCORPUS_DISCOVERY="+JSON.stringify({probe_count:probeCount,faces,edges}));
  if(faces.length<2)throw new Error("adjacency discovery found fewer than 2 Face identities");
  if(edges.length<2)throw new Error("adjacency discovery found fewer than 2 Edge identities");

  const domExpr='(() => { const vis=el=>{const r=el.getBoundingClientRect(),s=getComputedStyle(el);return r.width>1&&r.height>1&&s.display!=="none"&&s.visibility!=="hidden"}; const row=(el,role)=>{const r=el.getBoundingClientRect();return {role,data_id:el.getAttribute("data-id"),text:String(el.textContent||"").trim().replace(/\\s+/g," ").slice(0,160),x:r.x,y:r.y}}; const dedupe=a=>{const m=new Map();for(const x of a)if(x.data_id&&!m.has(x.data_id))m.set(x.data_id,x);return [...m.values()]}; const parts=dedupe(Array.from(document.querySelectorAll("#part-list .os-list-item[data-id]")).filter(vis).filter(el=>/Part \\d+/.test(String(el.textContent||"").trim())).map(el=>row(el,"BodyRow"))).sort((a,b)=>a.y-b.y); const features=dedupe(Array.from(document.querySelectorAll(".os-list-item.ns-user-feature[data-id]")).filter(vis).filter(el=>String(el.textContent||"").trim()).map(el=>row(el,"FeatureRow"))).sort((a,b)=>a.y-b.y); const planes=dedupe(Array.from(document.querySelectorAll(".os-list-item.ns-default-feature[data-id]")).filter(vis).filter(el=>["Top","Front","Right"].includes(String(el.textContent||"").trim())).map(el=>row(el,"DefaultPlaneRow"))).sort((a,b)=>a.y-b.y); const tools=dedupe(Array.from(document.querySelectorAll(".tool.is-activatable.is-button[data-id]")).filter(vis).filter(el=>["Extrude","Revolve","Sweep","Loft"].includes(String(el.textContent||"").trim())).map(el=>row(el,"ToolbarTool"))).sort((a,b)=>a.x-b.x); return {parts,features,planes,tools}; })()';
  const dom=await evalp(domExpr);
  if(dom.parts.length<2||dom.features.length<2||dom.planes.length<3||dom.tools.length<4)throw new Error("UI semantic candidate groups incomplete");

  const uiCases=[
    uiCase("BodyOrUiSemantic_01","Choose the upper of the two visible Part rows.",dom.parts,"B",0),
    uiCase("BodyOrUiSemantic_02","Choose the lower of the two visible Part rows.",dom.parts,"B",1),
    uiCase("BodyOrUiSemantic_03","Select the first visible user-created feature row.",dom.features,"UF",0),
    uiCase("BodyOrUiSemantic_04","Select the second visible user-created feature row.",dom.features,"UF",1),
    uiCase("BodyOrUiSemantic_05","Choose the highest of the three default plane rows.",dom.planes,"P",0),
    uiCase("BodyOrUiSemantic_06","Choose the middle of the three default plane rows.",dom.planes,"P",1),
    uiCase("BodyOrUiSemantic_07","Choose the lowest of the three default plane rows.",dom.planes,"P",2),
    uiCase("BodyOrUiSemantic_08","Choose the leftmost tool among Extrude, Revolve, Sweep, and Loft.",dom.tools,"T",0),
    uiCase("BodyOrUiSemantic_09","Choose the rightmost tool among Extrude, Revolve, Sweep, and Loft.",dom.tools,"T",dom.tools.length-1),
    uiCase("BodyOrUiSemantic_10","Choose the second tool from the left among Extrude, Revolve, Sweep, and Loft.",dom.tools,"T",1)
  ];
  const faceCases=buildCases("Face",faces,"F");
  const edgeCases=buildCases("Edge",edges,"E");
  const cases=[...faceCases,...edgeCases,...uiCases];
  const after=await viewer({op:"inspect"});
  if(selSig(after)!==baselineSig)throw new Error("adjacency corpus collection mutated authoritative selection");

  const corpus={
    schema:"capability-fabric.onshape-virtual-ui-policy-corpus.v1",
    benchmark_id:"onshape-virtual-ui-phase0-v1",
    fixture:{document_id:did,workspace_id:wid,element_id:eid},
    research_candidate:"c0cadee962c2059ba939c40c6bb9adf1bc99edfe",
    collection_method:"model-free JHK world-mesh topology-derived read-only semantic probes + semantic DOM; no coordinate sweep",
    model_outputs_inspected:false,
    probe_count:probeCount,
    counts:{Face:faceCases.length,Edge:edgeCases.length,BodyOrUiSemantic:uiCases.length,total:cases.length},
    cases
  };
  console.log("CF_PHASE0_ADJCORPUS_JSON="+JSON.stringify(corpus));
  console.log("CF_PHASE0_ADJCORPUS_SELECTION_UNCHANGED=pass");
  console.log("CF_PHASE0_ADJCORPUS=pass");
} finally { await c.close().catch(()=>{}); }
NODE

PYTHONPATH="$release/server-deploy/current/fabric-src" python3 - <<'PY'
from capability_fabric.persistence import SqliteExecutionStateStore
p="/var/lib/capability-fabric/onshape-research-phase0/fabric-state/execution.sqlite3"
with SqliteExecutionStateStore(p) as s:
    assert not s.recoverable()
print("CF_PHASE0_ADJCORPUS_POST_RECOVERABLE=zero")
PY
