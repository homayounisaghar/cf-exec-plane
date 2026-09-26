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
print("CF_PHASE0_CORPUS_PRODUCTION_BOUNDARY=pass")
print("CF_PHASE0_CORPUS_CONTROL_REV="+str(d["controlRevision"]))
print("CF_PHASE0_CORPUS_EPOCH="+str(a["productionEpoch"]))
PY

for c in "$research" "$sidecar"; do
  [[ "$(docker inspect -f '{{.State.Running}}' "$c" 2>/dev/null || echo false)" == true ]]
  [[ "$(docker inspect -f '{{.State.Health.Status}}' "$c")" == healthy ]]
done
env_dump="$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$research")"
grep -Fxq "CF_RESEARCH_SOURCE_COMMIT=$candidate" <<<"$env_dump"
grep -Fxq "CF_RESEARCH_FIXTURE_TARGET=$fixture" <<<"$env_dump"
echo CF_PHASE0_CORPUS_BINDING=pass

PYTHONPATH="$release/server-deploy/current/fabric-src" python3 - <<'PY'
from capability_fabric.persistence import SqliteExecutionStateStore
p="/var/lib/capability-fabric/onshape-research-phase0/fabric-state/execution.sqlite3"
with SqliteExecutionStateStore(p) as s:
    assert not s.recoverable()
print("CF_PHASE0_CORPUS_RECOVERABLE=zero")
PY

docker exec -e CF_FIXTURE="$fixture" -i "$research" sh -lc 'cd /tmp/app && node --input-type=module' <<'NODE'
import fs from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const [did,wid,eid]=process.env.CF_FIXTURE.split(":");
const token=fs.readFileSync("/run/secrets/mcp-token","utf8").trim();
const c=new Client({name:"cf-phase0-policy-corpus-freeze",version:"1.0"});
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
const mean=pts=>[0,1,2].map(j=>pts.reduce((s,p)=>s+p[j],0)/pts.length);
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
  const q=mul(inv,[...world,1]);const vx=q[0]/q[3],vy=q[1]/q[3];
  const [top,bottom,right,left]=vd.cameraViewport.map(Number);
  return {x:(vx-left)/(right-left),y:(top-vy)/(top-bottom)};
};
const inside=p=>Number.isFinite(p?.x)&&Number.isFinite(p?.y)&&p.x>.02&&p.x<.98&&p.y>.02&&p.y<.98;
const selSig=m=>JSON.stringify((m?.model_selection?.selections||[]).map(s=>({
  id:s?.deterministic_id??s?.selection_id??s?.id_string??null,
  f:s?.is_face??null,e:s?.is_edge??null,b:s?.is_body??null,v:s?.is_vertex??null
})));
const desc=(pts,vd)=>{
  const pp=pts.map(p=>project(p,vd)).filter(inside);
  if(!pp.length)return null;
  const xs=pp.map(p=>p.x),ys=pp.map(p=>p.y);
  const minx=Math.min(...xs),maxx=Math.max(...xs),miny=Math.min(...ys),maxy=Math.max(...ys);
  const cx=xs.reduce((a,b)=>a+b,0)/xs.length,cy=ys.reduce((a,b)=>a+b,0)/ys.length;
  const w=maxx-minx,h=maxy-miny;
  return {cx,cy,minx,maxx,miny,maxy,w,h,area:w*h,center_dist:Math.hypot(cx-.5,cy-.5),point_count:pts.length};
};
const metricSpecs=[
  {key:"leftmost",mode:"min",field:"cx",texts:["Select the leftmost visible {K} candidate on Part 1.","Choose the {K} candidate farthest to the left on Part 1.","Pick the {K} candidate at the extreme left of Part 1."]},
  {key:"rightmost",mode:"max",field:"cx",texts:["Select the rightmost visible {K} candidate on Part 1.","Choose the {K} candidate farthest to the right on Part 1.","Pick the {K} candidate at the extreme right of Part 1."]},
  {key:"topmost",mode:"min",field:"cy",texts:["Select the highest visible {K} candidate on Part 1.","Choose the topmost {K} candidate on Part 1.","Pick the {K} candidate nearest the top of the viewport."]},
  {key:"bottommost",mode:"max",field:"cy",texts:["Select the lowest visible {K} candidate on Part 1.","Choose the bottommost {K} candidate on Part 1.","Pick the {K} candidate nearest the bottom of the viewport."]},
  {key:"center_nearest",mode:"min",field:"center_dist",texts:["Select the {K} candidate nearest the viewport center.","Choose the most central {K} candidate.","Pick the {K} candidate closest to the center of the view."]},
  {key:"center_farthest",mode:"max",field:"center_dist",texts:["Select the {K} candidate farthest from the viewport center.","Choose the least central {K} candidate.","Pick the {K} candidate most distant from the center of the view."]},
  {key:"widest",mode:"max",field:"w",texts:["Select the widest projected {K} candidate.","Choose the {K} candidate spanning the most horizontal screen space.","Pick the {K} candidate with the greatest projected width."]},
  {key:"tallest",mode:"max",field:"h",texts:["Select the tallest projected {K} candidate.","Choose the {K} candidate spanning the most vertical screen space.","Pick the {K} candidate with the greatest projected height."]},
  {key:"largest",mode:"max",field:"area",texts:["Select the largest projected {K} candidate.","Choose the {K} candidate with the largest screen-space bounds.","Pick the {K} candidate occupying the greatest projected bounding area."]},
  {key:"smallest",mode:"min",field:"area",texts:["Select the smallest projected {K} candidate.","Choose the {K} candidate with the smallest screen-space bounds.","Pick the {K} candidate occupying the least projected bounding area."]}
];
const uniqueWinner=(arr,spec)=>{
  const vals=arr.map((x,i)=>({i,v:x.geometry[spec.field]})).filter(x=>Number.isFinite(x.v)).sort((a,b)=>spec.mode==="min"?a.v-b.v:b.v-a.v);
  if(vals.length<2||Math.abs(vals[0].v-vals[1].v)<1e-9)return null;
  return vals[0].i;
};
const anonymizeGeom=(arr,prefix)=>arr.map((x,i)=>({
  handle:prefix+(i+1),
  type:x.kind,
  body_name:x.body_name,
  body_relation:x.body_id?"same_body":null,
  geometry:x.geometry
}));
const buildGeomCases=(family,arr,prefix)=>{
  const out=[];
  for(const spec of metricSpecs){
    const wi=uniqueWinner(arr,spec);if(wi==null)continue;
    for(const text of spec.texts){
      out.push({
        case_id:family+"_"+String(out.length+1).padStart(2,"0"),
        family,
        intent_text:text.replaceAll("{K}",family==="Face"?"Face":"Edge"),
        start_state_fingerprint:"live-qualified-view-v1",
        policy_facing:{candidates:anonymizeGeom(arr,prefix)},
        hidden_authoritative_label:{candidate_handle:prefix+(wi+1),deterministic_id:arr[wi].deterministic_id,semantic_type:family},
        label_evidence:{source:"runtime.viewer geometry projection + read-only semantic probe",probe_seed:arr[wi].seed},
        eligibility:"ELIGIBLE"
      });
      if(out.length===10)return out;
    }
  }
  throw new Error(family+" corpus could not produce 10 unique unambiguous relational cases");
};
const uiPolicy=(rows,prefix)=>rows.map((x,i)=>({handle:prefix+(i+1),role:x.role,text:x.text,order:i+1}));
const uiCase=(id,intent,rows,prefix,winnerIndex)=>({
  case_id:id,family:"BodyOrUiSemantic",intent_text:intent,start_state_fingerprint:"live-qualified-ui-v1",
  policy_facing:{candidates:uiPolicy(rows,prefix)},
  hidden_authoritative_label:{candidate_handle:prefix+(winnerIndex+1),data_id:rows[winnerIndex].data_id,text:rows[winnerIndex].text,role:rows[winnerIndex].role},
  label_evidence:{source:"live semantic DOM data-id + visible row/tool order"},
  eligibility:"ELIGIBLE"
});

try{
  const st=await call("onshape_session_status");
  if(st?.auth?.state!=="PROVEN"||st?.auth?.http_status!==200) throw new Error("auth");
  console.log("CF_PHASE0_CORPUS_AUTH=PROVEN");

  const scan=await viewer({op:"selection_scan"});
  const baselineSig=selSig(scan);
  const vd=scan?.view_data;
  if(!Array.isArray(vd?.viewMatrix)||!Array.isArray(vd?.cameraViewport))throw new Error("live view data absent");

  const mapEntities=async(kind,items)=>{
    const targetType=kind==="FACE"?2:1;
    const out=[];
    for(const item of items){
      if(item?.setting_index!==3||!Array.isArray(item?.own?.points))continue;
      const pts=triples(item.own.points);if(pts.length<2)continue;
      const g=desc(pts,vd);if(!g)continue;
      const faceSeeds=[mean(pts)];
      if(kind==="FACE"){
        const ix=Array.isArray(item?.own?.indices)?item.own.indices.map(Number):[];
        for(let k=0;k+2<ix.length&&faceSeeds.length<6;k+=3){
          const a=pts[ix[k]],b=pts[ix[k+1]],cc=pts[ix[k+2]];
          if(a&&b&&cc)faceSeeds.push(mean([a,b,cc]));
        }
        for(let k=0;k+2<pts.length&&faceSeeds.length<6;k+=3)faceSeeds.push(mean([pts[k],pts[k+1],pts[k+2]]));
      }
      const seeds=kind==="FACE"?faceSeeds:[mean(pts),lerp(pts[0],pts[pts.length-1],.25),lerp(pts[0],pts[pts.length-1],.5)];
      let mapped=null;
      for(const world of seeds.slice(0,6)){
        const p=project(world,vd);if(!inside(p))continue;
        const v=await viewer({op:"probe",x_fraction:p.x,y_fraction:p.y});
        if(selSig(v)!==baselineSig)throw new Error("read-only corpus probe changed selection");
        const pick=(v?.probe?.picks||[]).find(x=>x?.deterministic_id&&(
          x?.getters?.entity_type===targetType ||
          (kind==="EDGE"&&x?.entity_metadata?.meshIncrement?.primitiveType===1) ||
          (kind==="FACE"&&x?.getters?.surface_type!=null)
        ));
        if(pick){
          mapped={
            kind,deterministic_id:pick.deterministic_id,
            body_id:pick?.getters?.body_id??pick?.entity_metadata?.bodyId??null,
            body_name:pick?.entity_metadata?.bodyMetaData?.name??null,
            geometry:g,seed:{x_fraction:p.x,y_fraction:p.y}
          };
          break;
        }
      }
      if(mapped&&!out.some(x=>x.deterministic_id===mapped.deterministic_id))out.push(mapped);
    }
    return out;
  };

  const faces=await mapEntities("FACE",scan?.selection_scan?.faces?.active||[]);
  const edges=await mapEntities("EDGE",scan?.selection_scan?.edges?.active||[]);
  console.log("CF_PHASE0_CORPUS_MAPPED_COUNTS="+JSON.stringify({faces:faces.length,edges:edges.length}));
  console.log("CF_PHASE0_CORPUS_FACE_CANDIDATES_PRECHECK="+JSON.stringify(faces));
  console.log("CF_PHASE0_CORPUS_EDGE_CANDIDATES_PRECHECK="+JSON.stringify(edges));
  if(faces.length<2)throw new Error("fewer than 2 semantic Face candidates mapped");
  if(edges.length<2)throw new Error("fewer than 2 semantic Edge candidates mapped");
  const faceCandidates=faces.slice(0,5);
  const edgeCandidates=edges.slice(0,5);
  console.log("CF_PHASE0_CORPUS_FACE_CANDIDATES="+JSON.stringify(faces));
  console.log("CF_PHASE0_CORPUS_EDGE_CANDIDATES="+JSON.stringify(edges));

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

  const faceCases=buildGeomCases("Face",faceCandidates,"F");
  const edgeCases=buildGeomCases("Edge",edgeCandidates,"E");
  const cases=[...faceCases,...edgeCases,...uiCases];
  if(cases.length!==30)throw new Error("corpus size mismatch");
  const after=await viewer({op:"inspect"});
  if(selSig(after)!==baselineSig)throw new Error("corpus freeze mutated authoritative selection");

  const corpus={
    schema:"capability-fabric.onshape-virtual-ui-policy-corpus.v1",
    benchmark_id:"onshape-virtual-ui-phase0-v1",
    fixture:{document_id:did,workspace_id:wid,element_id:eid},
    research_candidate:"c0cadee962c2059ba939c40c6bb9adf1bc99edfe",
    collection_method:"model-free semantic geometry/DOM; read-only; no coordinate sweep",
    model_outputs_inspected:false,
    counts:{Face:faceCases.length,Edge:edgeCases.length,BodyOrUiSemantic:uiCases.length,total:cases.length},
    candidates:{faces:faceCandidates,edges:edgeCandidates},
    cases
  };
  console.log("CF_PHASE0_CORPUS_JSON="+JSON.stringify(corpus));
  console.log("CF_PHASE0_CORPUS_SELECTION_UNCHANGED=pass");
  console.log("CF_PHASE0_CORPUS=pass");
} finally { await c.close().catch(()=>{}); }
NODE

PYTHONPATH="$release/server-deploy/current/fabric-src" python3 - <<'PY'
from capability_fabric.persistence import SqliteExecutionStateStore
p="/var/lib/capability-fabric/onshape-research-phase0/fabric-state/execution.sqlite3"
with SqliteExecutionStateStore(p) as s:
    assert not s.recoverable()
print("CF_PHASE0_CORPUS_POST_RECOVERABLE=zero")
PY
