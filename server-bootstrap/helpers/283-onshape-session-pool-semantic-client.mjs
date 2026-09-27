import fs from "node:fs";
import { performance } from "node:perf_hooks";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const mode=String(process.env.CF_MODE||"qualify");
const token=fs.readFileSync("/run/secrets/mcp-token","utf8").trim();
const c=new Client({name:"cf-session-pool-phase5-live",version:"2.0"});
await c.connect(new StreamableHTTPClientTransport(new URL("http://127.0.0.1:8788/mcp/"+token)));
const parse=r=>JSON.parse((r.content||[]).filter(x=>x.type==="text").map(x=>x.text||"").join("\n"));
const call=async(name,args={})=>parse(await c.callTool({name,arguments:args},undefined,{timeout:180000}));
const invokeRaw=async(capability_id,args={})=>call("onshape_fabric_invoke",{capability_id,arguments:args});
const invoke=async(capability_id,args={})=>{
  const x=await invokeRaw(capability_id,args);
  const r=x.result;
  if(r?.outcome?.state!=="ACHIEVED" || r?.observation?.ackState!=="ACKNOWLEDGED") throw new Error("semantic invocation failed "+capability_id+" "+JSON.stringify(r));
  return r;
};
const warm=async()=>{
  const s=await call("onshape_pool_warmup");
  const id=String(s.operation_id||""); if(!id) throw new Error("warmup id missing");
  for(let i=0;i<240;i++){
    const st=await call("onshape_operation_status",{operation_id:id});
    if(st.status==="SUCCEEDED"){
      const r=st.result||{};
      if(r.pool_enabled!==true||r.proven_sessions!==5||r.session_fingerprints_distinct!==true) throw new Error("warm invariant "+JSON.stringify(r));
      return r;
    }
    if(st.status==="FAILED"||st.status==="AWAITING_INPUT") throw new Error("warmup "+st.status+" "+JSON.stringify(st));
    await new Promise(r=>setTimeout(r,1000));
  }
  throw new Error("warmup timeout");
};
const ctxId=r=>String(r?.observation?.evidence?.executionContextId||"");
const acquire=async(workItem,doc)=>invoke("onshape.execution.context.acquire",{workItem,accessMode:"MATERIAL",documentId:doc});
const release=async(id)=>invoke("onshape.execution.context.release",{executionContextId:id});
const rename=async(id,did,name)=>invoke("onshape.documented.operation",{operationId:"updateDocumentAttributes",pathParams:{did},body:{name},verification:{kind:"document_name_equals",value:name},executionContextId:id});
const readDoc=async(id,did)=>invoke("onshape.documented.operation",{operationId:"getDocument",pathParams:{did},executionContextId:id});
const expectRejected=async(label,fn)=>{
  const x=await fn();
  const r=x?.result;
  if(r?.outcome?.state==="ACHIEVED") throw new Error(label+" unexpectedly achieved");
  return {label,state:r?.outcome?.state||null,ack:r?.observation?.ackState||null,detail:r?.observation?.detail||null};
};

try{
  await warm();
  if(mode==="setup"){
    const stamp=Date.now();
    const make=async suffix=>{
      const name="CF Phase5 disposable "+suffix+" "+stamp;
      const r=await invoke("onshape.documented.operation",{operationId:"createDocument",body:{name}});
      const b=r.observation?.evidence?.body||{};
      const did=String(b.id||b.documentId||b.newDocumentId||"");
      const wid=String(b.defaultWorkspace?.id||b.defaultWorkspaceId||b.newWorkspaceId||"");
      if(!/^[0-9a-f]{24}$/i.test(did)||!/^[0-9a-f]{24}$/i.test(wid)) throw new Error("createDocument ids missing "+JSON.stringify(r.observation?.evidence));
      return {did:did.toLowerCase(),wid:wid.toLowerCase(),name};
    };
    const [a,b]=await Promise.all([make("A"),make("B")]);
    console.log(JSON.stringify({ok:true,mode:"setup",a,b}));
    process.exit(0);
  }

  const docs=JSON.parse(String(process.env.CF_DOCS||"{}"));
  const A=String(docs?.a?.did||""), B=String(docs?.b?.did||"");
  if(!/^[0-9a-f]{24}$/.test(A)||!/^[0-9a-f]{24}$/.test(B)||A===B) throw new Error("bad docs");

  const [ar,br]=await Promise.all([acquire("phase5-live-A",A),acquire("phase5-live-B",B)]);
  const ca=ctxId(ar), cb=ctxId(br);
  if(!/^ctx_[0-9a-f]{32}$/.test(ca)||!/^ctx_[0-9a-f]{32}$/.test(cb)) throw new Error("bad contexts");
  const op=await call("onshape_pool_status");
  const leaseByWork=new Map((op.workflow_leases||[]).map(x=>[x.work_item,x]));
  const sa=leaseByWork.get("phase5-live-A")?.session_id, sb=leaseByWork.get("phase5-live-B")?.session_id;
  if(!sa||!sb||sa===sb) throw new Error("different-doc contexts did not use distinct slots");

  const conflict=await expectRejected("same-document-fence",()=>invokeRaw("onshape.execution.context.acquire",{workItem:"phase5-live-C",accessMode:"MATERIAL",documentId:A}));

  const t0=performance.now();
  const [ma,mb]=await Promise.all([
    rename(ca,A,"CF Phase5 A achieved "+Date.now()),
    rename(cb,B,"CF Phase5 B achieved "+Date.now())
  ]);
  const concurrentMs=performance.now()-t0;
  const ra=await readDoc(ca,A), rb=await readDoc(cb,B);
  if(!String(ra.observation?.evidence?.body?.name||"").startsWith("CF Phase5 A achieved")) throw new Error("A readback mismatch");
  if(!String(rb.observation?.evidence?.body?.name||"").startsWith("CF Phase5 B achieved")) throw new Error("B readback mismatch");

  const wrongWork=await expectRejected("wrong-workitem",()=>invokeRaw("onshape.execution.context.acquire",{workItem:"phase5-live-NO-GRANT",accessMode:"MATERIAL",documentId:A}));
  const wrongDoc=await expectRejected("wrong-document",()=>invokeRaw("onshape.execution.context.acquire",{workItem:"phase5-live-A",accessMode:"MATERIAL",documentId:B}));
  const revoked=await expectRejected("revoked-grant",()=>invokeRaw("onshape.execution.context.acquire",{workItem:"phase5-live-REVOKED",accessMode:"MATERIAL",documentId:B}));
  const exhausted=await expectRejected("exhausted-budget",()=>invokeRaw("onshape.execution.context.acquire",{workItem:"phase5-live-EXHAUSTED",accessMode:"MATERIAL",documentId:B}));

  await release(ca); await release(cb);
  const cr=await acquire("phase5-live-C",A); const cc=ctxId(cr);
  if(!/^ctx_[0-9a-f]{32}$/.test(cc)) throw new Error("post-release fence did not reopen");
  await release(cc);

  const budgetCtx=ctxId(await acquire("phase5-live-BUDGET",B));
  const budgetResults=await Promise.all(Array.from({length:4},(_,i)=>{
    const name="CF Phase5 budget "+i+" "+Date.now();
    return invokeRaw("onshape.documented.operation",{operationId:"updateDocumentAttributes",pathParams:{did:B},body:{name},verification:{kind:"document_name_equals",value:name},executionContextId:budgetCtx});
  }));
  const achieved=budgetResults.filter(x=>x?.result?.outcome?.state==="ACHIEVED").length;
  const rejected=budgetResults.length-achieved;
  if(achieved<1||achieved>2||rejected!==(4-achieved)) throw new Error("atomic budget mismatch "+JSON.stringify({achieved,rejected,budgetResults}));
  await release(budgetCtx);

  const final=await call("onshape_pool_status");
  if(final.workflow_lease_count!==0||final.active_count!==0||final.navigation_limit!==2) throw new Error("pool not clean");
  if((final.sessions||[]).some(x=>x?.auth?.state!=="PROVEN"||x?.auth?.http_status!==200)) throw new Error("post auth not proven");

  console.log(JSON.stringify({
    ok:true,mode:"qualify",different_document_slots:[sa,sb],different_document_slots_distinct:true,
    same_document_conflict:conflict,different_document_concurrent_client_window_ms:+concurrentMs.toFixed(2),
    authoritative_readback:true,wrong_workitem:wrongWork,wrong_document:wrongDoc,revoked_grant:revoked,
    exhausted_budget:exhausted,budget_atomic:{attempts:4,achieved,rejected,max:2},
    navigation_limit:final.navigation_limit,post_auth_proven:(final.sessions||[]).length,
    fingerprints_distinct:final.session_fingerprints_distinct,final_workflow_lease_count:final.workflow_lease_count
  }));
} finally { await c.close().catch(()=>{}); }
