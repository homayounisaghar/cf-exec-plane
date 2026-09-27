import fs from "node:fs";
import { performance } from "node:perf_hooks";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const [did,wid,eid]=String(process.env.CF_FIXTURE||"").split(":");
if (![did,wid,eid].every(x=>/^[0-9a-f]{24}$/.test(x||""))) throw new Error("invalid fixture");
const token=fs.readFileSync("/run/secrets/mcp-token","utf8").trim();
const c=new Client({name:"cf-session-pool-semantic-live",version:"1.0"});
await c.connect(new StreamableHTTPClientTransport(new URL("http://127.0.0.1:8788/mcp/"+token)));

const parse=r=>JSON.parse((r.content||[]).filter(x=>x.type==="text").map(x=>x.text||"").join("\n"));
const call=async(name,args={})=>parse(await c.callTool({name,arguments:args},undefined,{timeout:180000}));
const invoke=async(capability_id,args={})=>{
  const x=await call("onshape_fabric_invoke",{capability_id,arguments:args});
  const r=x.result;
  if(r?.outcome?.state!=="ACHIEVED" || r?.observation?.ackState!=="ACKNOWLEDGED"){
    throw new Error("semantic invocation failed "+capability_id+" "+JSON.stringify(r));
  }
  return r;
};
const q=(xs,p)=>{const a=[...xs].sort((x,y)=>x-y);const i=(a.length-1)*p,lo=Math.floor(i),hi=Math.ceil(i);return a[lo]+(a[hi]-a[lo])*(i-lo)};
const stats=xs=>({n:xs.length,min:+Math.min(...xs).toFixed(2),p50:+q(xs,.5).toFixed(2),p95:+q(xs,.95).toFixed(2),max:+Math.max(...xs).toFixed(2),mean:+(xs.reduce((a,b)=>a+b,0)/xs.length).toFixed(2)});

try {
  const warm=await call("onshape_pool_warmup");
  if(warm.pool_enabled!==true || warm.proven_sessions!==5 || warm.session_fingerprints_distinct!==true) throw new Error("warmup failed");

  const catalog=await call("onshape_fabric_capabilities");
  const ids=new Set((catalog.capabilities||[]).map(x=>x.id));
  for(const id of ["onshape.execution.context.acquire","onshape.execution.context.status","onshape.execution.context.release","onshape.documented.operation"]){
    if(!ids.has(id)) throw new Error("missing capability "+id);
  }

  const contexts=[];
  const acquireMs=[];
  const specs=[
    ["semantic-client-1","MATERIAL"],
    ["semantic-client-2","READ_ONLY"],
    ["semantic-client-3","READ_ONLY"],
    ["semantic-client-4","READ_ONLY"],
    ["semantic-client-5","READ_ONLY"],
  ];
  for(const [workItem,accessMode] of specs){
    const t=performance.now();
    const r=await invoke("onshape.execution.context.acquire",{workItem,accessMode,documentId:did,workspaceId:wid,elementId:eid});
    acquireMs.push(performance.now()-t);
    const id=r.observation?.evidence?.executionContextId;
    if(!/^ctx_[0-9a-f]{32}$/.test(String(id||""))) throw new Error("bad context id");
    const exposed=JSON.stringify(r.observation?.evidence||{});
    if(/session[_-]?id|sessionRole|session_role/.test(exposed)) throw new Error("physical slot leaked");
    contexts.push(id);
  }

  const operator=await call("onshape_pool_status");
  if(operator.workflow_lease_count!==5) throw new Error("lease count mismatch");
  const slots=(operator.workflow_leases||[]).map(x=>x.session_id);
  if(new Set(slots).size!==5) throw new Error("physical slots not distinct");

  for(const ctx of contexts){
    const r=await invoke("onshape.execution.context.status",{executionContextId:ctx});
    if(r.observation?.evidence?.executionContextId!==ctx) throw new Error("status context mismatch");
    if(/session[_-]?id|sessionRole|session_role/.test(JSON.stringify(r.observation?.evidence||{}))) throw new Error("status leaked physical slot");
  }

  const readMs=[];
  for(let round=0;round<20;round++){
    const rr=await Promise.all(contexts.map(async(ctx)=>{
      const t=performance.now();
      const r=await invoke("onshape.documented.operation",{operationId:"getDocument",pathParams:{did},executionContextId:ctx});
      const ms=performance.now()-t;
      if(r.observation?.evidence?.executionContextId!==ctx) throw new Error("read context mismatch");
      const pe=r.observation?.evidence?.poolExecution||{};
      if(pe.session_id!==undefined || pe.session_role!==undefined || pe.session_durability!==undefined) throw new Error("pool slot leaked");
      return ms;
    }));
    readMs.push(...rr);
  }

  const releaseMs=[];
  for(const ctx of contexts){
    const t=performance.now();
    const r=await invoke("onshape.execution.context.release",{executionContextId:ctx});
    releaseMs.push(performance.now()-t);
    if(r.observation?.evidence?.contextReleased!==true) throw new Error("release failed");
  }

  const finalPool=await call("onshape_pool_status");
  if(finalPool.workflow_lease_count!==0 || finalPool.active_count!==0 || finalPool.queued_count!==0) throw new Error("pool not clean");
  if((finalPool.sessions||[]).some(x=>x?.auth?.state!=="PROVEN" || x?.auth?.http_status!==200)) throw new Error("post auth failed");

  console.log(JSON.stringify({
    ok:true,
    semantic_contexts:5,
    physical_slots_distinct:new Set(slots).size,
    acquire_ms:stats(acquireMs),
    documented_reads:readMs.length,
    documented_read_ms:stats(readMs),
    release_ms:stats(releaseMs),
    post_auth_proven:(finalPool.sessions||[]).length,
    fingerprints_distinct:finalPool.session_fingerprints_distinct,
    final_workflow_lease_count:finalPool.workflow_lease_count,
    final_active_count:finalPool.active_count,
    physical_slot_redaction:true,
  }));
} finally {
  await c.close().catch(()=>{});
}
