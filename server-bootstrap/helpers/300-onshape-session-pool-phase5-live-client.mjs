import fs from "node:fs";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const token=fs.readFileSync("/run/secrets/mcp-token","utf8").trim();
const phase=String(process.env.CF_PHASE||"");
const source=String(process.env.CF_FIXTURE||"").split(":");
const [sourceDid,sourceWid,sourceEid]=source;
const docA=String(process.env.CF_DOC_A||"");
const docB=String(process.env.CF_DOC_B||"");
const widA=String(process.env.CF_WID_A||"");
const widB=String(process.env.CF_WID_B||"");
const hex24=x=>/^[0-9a-f]{24}$/.test(x||"");
if(!["create","exercise","authdrift","ackloss","restart-acquire","restart-reconcile"].includes(phase)) throw new Error("bad phase");
if(![sourceDid,sourceWid,sourceEid].every(hex24)) throw new Error("bad source fixture");
if(["exercise","authdrift","ackloss","restart-acquire","restart-reconcile"].includes(phase) && ![docA,docB,widA,widB].every(hex24)) throw new Error("bad disposable docs");

const c=new Client({name:"cf-phase5-multimutator-live",version:"1.0"});
await c.connect(new StreamableHTTPClientTransport(new URL("http://127.0.0.1:8788/mcp/"+token)));
const parse=res=>{
  const raw=(res?.content||[]).filter(x=>x.type==="text").map(x=>x.text||"").join("\n");
  if(!raw) return {};
  try{return JSON.parse(raw);}catch{return {raw,isError:res?.isError===true};}
};
const call=async(name,args={})=>parse(await c.callTool({name,arguments:args},undefined,{timeout:240000}));
const invokeRaw=async(capabilityId,args={})=>call("onshape_fabric_invoke",{capability_id:capabilityId,arguments:args});
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const qualificationAction=async(action,args={})=>{
  const key=createHash("sha256").update(`fabric-agent:${token}`).digest("hex");
  const response=await fetch(`http://127.0.0.1:8789/internal/fabric/${key}`,{
    method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({action,...args}),
  });
  const body=await response.json();
  if(!response.ok||body?.ok!==true) throw new Error("qualification action failed "+JSON.stringify(body));
  return body.result;
};
const restorePool=async()=>{
  const started=await call("onshape_pool_warmup");
  const op=String(started.operation_id||"");
  if(!op) throw new Error("pool warmup missing operation "+JSON.stringify(started));
  for(let i=0;i<180;i++){
    const st=await call("onshape_operation_status",{operation_id:op});
    if(st.status==="SUCCEEDED") return st;
    if(st.status==="FAILED"||st.status==="AWAITING_INPUT") throw new Error("pool warmup did not recover "+JSON.stringify(st));
    await sleep(1000);
  }
  throw new Error("pool warmup timeout");
};
const reconcileInDoubt=async r=>{
  if(r?.outcome?.state!=="IN_DOUBT") return r;
  const attempt=String(r?.attemptId||"");
  if(!attempt.startsWith("attempt:")) throw new Error("in-doubt result missing attempt identity "+JSON.stringify(r));
  for(let i=0;i<180;i++){
    await sleep(1000);
    const rec=await call("onshape_fabric_reconcile",{attempt_id:attempt});
    const rr=rec?.result;
    if(rr?.outcome?.state==="IN_DOUBT") continue;
    if(rr) return rr;
    throw new Error("same-attempt reconcile returned no result "+JSON.stringify(rec));
  }
  throw new Error("same-attempt reconcile remained IN_DOUBT "+attempt);
};
const achieved=async(capabilityId,args={})=>{
  const x=await invokeRaw(capabilityId,args);
  const r=await reconcileInDoubt(x?.result);
  if(r?.outcome?.state!=="ACHIEVED" || r?.observation?.ackState!=="ACKNOWLEDGED"){
    throw new Error("invoke terminal non-achieved "+capabilityId+" "+JSON.stringify(r));
  }
  return r;
};
const ctxId=r=>{
  const id=String(r?.observation?.evidence?.executionContextId||"");
  if(!/^ctx_[0-9a-f]{32}$/.test(id)) throw new Error("bad context id");
  if(/session[_-]?id|sessionRole|session_role/.test(JSON.stringify(r?.observation?.evidence||{}))) throw new Error("physical slot leaked");
  return id;
};
const release=ctx=>achieved("onshape.execution.context.release",{executionContextId:ctx});
const readName=async(did,ctx)=>{
  const r=await achieved("onshape.documented.operation",{operationId:"getDocument",pathParams:{did},executionContextId:ctx});
  const body=r?.observation?.evidence?.body||{};
  if(body.id!==did || typeof body.name!=="string") throw new Error("bad document readback");
  return body.name;
};
const update=async(did,ctx,name)=>{
  const r=await achieved("onshape.documented.operation",{
    operationId:"updateDocumentAttributes",
    pathParams:{did},
    body:{name},
    verification:{kind:"document_name_equals",value:name},
    executionContextId:ctx,
  });
  const e=r?.observation?.evidence||{};
  if(e.effectSent!==true || e.postconditionVerified!==true) throw new Error("mutation not authoritatively verified");
  return r;
};

async function warm(){
  const proven=x=>x?.auth?.state==="PROVEN"&&x?.auth?.http_status===200;
  let s=await call("onshape_pool_status");
  if(s.pool_enabled===true&&s.warming===false&&(s.sessions||[]).length===5&&(s.sessions||[]).every(proven)) return s;
  const ids=(s.sessions||[]).map(x=>String(x.session_id||"")).sort();
  if(ids.length!==5||ids.some(id=>!/^session-[1-5]$/.test(id))) throw new Error("invalid pool session ids");
  for(const sid of ids){
    s=await call("onshape_pool_status");
    if(proven((s.sessions||[]).find(x=>x.session_id===sid))) continue;
    let recovered=false;
    for(let authAttempt=1;authAttempt<=2&&!recovered;authAttempt++){
      const started=await call("onshape_pool_session_reauth",{session_id:sid});
      const op=String(started.operation_id||"");
      if(!op) throw new Error("missing reauth operation "+sid+" "+JSON.stringify(started));
      let terminal=null;
      for(let i=0;i<180;i++){
        const st=await call("onshape_operation_status",{operation_id:op});
        if(["SUCCEEDED","FAILED","AWAITING_INPUT"].includes(st.status)){terminal=st;break;}
        await new Promise(r=>setTimeout(r,1000));
      }
      if(!terminal) throw new Error("reauth timeout "+sid);
      if(terminal.status==="AWAITING_INPUT") throw new Error("reauth input required "+sid+" "+JSON.stringify(terminal));
      const after=await call("onshape_pool_status");
      const ok=proven((after.sessions||[]).find(x=>x.session_id===sid));
      const code=String(terminal?.error?.code||"");
      if(terminal.status==="SUCCEEDED"&&ok){recovered=true;break;}
      if((code==="POOL_FINAL_AUTH_NOT_PROVEN"||code==="LOGIN_STATE_UNRESOLVED")&&ok){recovered=true;break;}
      if(code==="LOGIN_STATE_UNRESOLVED"&&!ok&&authAttempt===1) continue;
      throw new Error("reauth failed "+sid+" "+JSON.stringify(terminal));
    }
    if(!recovered) throw new Error("session did not recover "+sid);
  }
  const p=await call("onshape_pool_status");
  if(p.pool_enabled!==true||p.size!==5||p.navigation_limit!==2||p.session_fingerprints_distinct!==true) throw new Error("pool invariant failed "+JSON.stringify(p));
  if((p.sessions||[]).some(x=>!proven(x))) throw new Error("auth not proven");
  if(new Set((p.sessions||[]).map(x=>x?.auth?.account_id).filter(Boolean)).size!==1) throw new Error("account mismatch");
  return p;
}

try{
  await warm();

  if(phase==="create"){
    const copies=[];
    for(const [workItem,suffix] of [["phase5-copy","A"],["phase5-copy","B"]]){
      const acq=await achieved("onshape.execution.context.acquire",{workItem,accessMode:"MATERIAL",documentId:sourceDid,workspaceId:sourceWid,elementId:sourceEid});
      const ctx=ctxId(acq);
      const name="CF Phase5 Disposable "+suffix+" "+Date.now();
      const unresolvedPath="/agent-state/phase5-live-unresolved.json";
      fs.writeFileSync(unresolvedPath,JSON.stringify({
        attemptId:null,phase:"create-copyWorkspace-dispatching",expectedName:name,workItem,executionContextId:ctx
      })+"\n",{mode:0o600});
      let raw;
      try{
        raw=await invokeRaw("onshape.documented.operation",{
          operationId:"copyWorkspace",
          pathParams:{did:sourceDid,wid:sourceWid},
          body:{newName:name,isPublic:false},
          executionContextId:ctx,
        });
      }catch(error){
        throw new Error("copy transport failed before authoritative result; unresolved state preserved "+String(error?.name||error));
      }
      let r=raw?.result;
      if(!r){
        throw new Error("copy returned no authoritative result; unresolved state preserved "+JSON.stringify(raw));
      }
      if(r?.outcome?.state==="IN_DOUBT"){
        const attempt=String(r.attemptId||"");
        if(!attempt.startsWith("attempt:")) throw new Error("copy uncertainty missing attempt; unresolved state preserved");
        fs.writeFileSync(unresolvedPath,JSON.stringify({
          attemptId:attempt,phase:"create-copyWorkspace",expectedName:name,workItem,executionContextId:ctx
        })+"\n",{mode:0o600});
        const resolved=await reconcileInDoubt(r);
        if(resolved?.outcome?.state==="ACHIEVED"){
          fs.rmSync(unresolvedPath,{force:true});
          r=resolved;
        }else if(resolved?.outcome?.state==="ABSENT"){
          fs.rmSync(unresolvedPath,{force:true});
          throw new Error("copy Attempt authoritatively ABSENT; no replay in this run "+attempt);
        }else{
          throw new Error("copy Attempt remains unresolved "+attempt+" "+JSON.stringify(rec));
        }
      }else{
        fs.rmSync(unresolvedPath,{force:true});
      }
      if(r?.outcome?.state!=="ACHIEVED"||r?.observation?.ackState!=="ACKNOWLEDGED") throw new Error("copy failed "+JSON.stringify(r));
      const v=r?.observation?.evidence?.verification||{};
      const nd=String(v.newDocumentId||"").toLowerCase();
      const nw=String(v.newWorkspaceId||"").toLowerCase();
      if(!hex24(nd)||!hex24(nw)||v.observedName!==name) throw new Error("copy verification missing");
      copies.push({documentId:nd,workspaceId:nw,name,attemptId:r.attemptId});
      await release(ctx);
    }
    console.log(JSON.stringify({ok:true,phase,copies}));
  }

  if(phase==="exercise"){
    const t0=performance.now();
    const [a,b]=await Promise.all([
      achieved("onshape.execution.context.acquire",{workItem:"phase5-A",accessMode:"MATERIAL",documentId:docA,workspaceId:widA}),
      achieved("onshape.execution.context.acquire",{workItem:"phase5-B",accessMode:"MATERIAL",documentId:docB,workspaceId:widB}),
    ]);
    const ctxA=ctxId(a),ctxB=ctxId(b);
    const pool=await call("onshape_pool_status");
    const leases=(pool.workflow_leases||[]).filter(x=>[ctxA,ctxB].includes(x.lease_id));
    if(leases.length!==2) throw new Error("missing material leases");
    if(new Set(leases.map(x=>x.session_id)).size!==2) throw new Error("different docs did not get distinct slots");
    if(leases.some(x=>x.effect!=="MATERIAL"||x.state!=="ACTIVE")) throw new Error("material leases not active");

    const blocked=await invokeRaw("onshape.execution.context.acquire",{workItem:"phase5-C",accessMode:"MATERIAL",documentId:docA,workspaceId:widA});
    if(blocked?.result?.outcome?.state==="ACHIEVED" || blocked?.result?.observation?.evidence?.effectSent===true) throw new Error("same-document competing context was admitted");
    const blockedText=JSON.stringify(blocked);
    if(!/POOL_DOCUMENT_MATERIAL_LEASE_CONFLICT|material.*fence|material.*context/i.test(blockedText)) throw new Error("same-doc rejection not attributable to fence "+blockedText);

    const nameA="CF-PHASE5-A-"+Date.now();
    const nameB="CF-PHASE5-B-"+Date.now();
    const m0=performance.now();
    const [ra,rb]=await Promise.all([update(docA,ctxA,nameA),update(docB,ctxB,nameB)]);
    const mutationWindowMs=performance.now()-m0;
    const execA=ra?.observation?.evidence?.poolExecution||{};
    const execB=rb?.observation?.evidence?.poolExecution||{};
    const startA=Date.parse(execA.started_at||""), finishA=Date.parse(execA.finished_at||"");
    const startB=Date.parse(execB.started_at||""), finishB=Date.parse(execB.finished_at||"");
    if(![startA,finishA,startB,finishB].every(Number.isFinite)) throw new Error("missing mutation execution interval");
    const overlapMs=Math.min(finishA,finishB)-Math.max(startA,startB);
    if(!(overlapMs>0)) throw new Error("different-document mutations did not overlap in execution");
    const [readA,readB]=await Promise.all([readName(docA,ctxA),readName(docB,ctxB)]);
    if(readA!==nameA||readB!==nameB) throw new Error("authoritative readback mismatch");

    await Promise.all([release(ctxA),release(ctxB)]);
    const cctx=ctxId(await achieved("onshape.execution.context.acquire",{workItem:"phase5-C",accessMode:"MATERIAL",documentId:docA,workspaceId:widA}));
    await release(cctx);
    const final=await call("onshape_pool_status");
    if(final.workflow_lease_count!==0||final.document_lock_count!==0||final.active_count!==0) throw new Error("pool did not cleanly release");
    console.log(JSON.stringify({
      ok:true,phase,
      slots:leases.map(x=>({work_item:x.work_item,session_id:x.session_id,grant_id:x.grant_id})),
      same_document_competitor_blocked:true,
      different_document_mutations:[ra.attemptId,rb.attemptId],
      mutation_window_ms:+mutationWindowMs.toFixed(2),
      execution_overlap_ms:overlapMs,
      execution_intervals:{a:{started_at:execA.started_at,finished_at:execA.finished_at},b:{started_at:execB.started_at,finished_at:execB.finished_at}},
      elapsed_ms:+(performance.now()-t0).toFixed(2),
      readback:{[docA]:readA,[docB]:readB},
      nav_limit:final.navigation_limit,
      auth_proven:(final.sessions||[]).filter(x=>x?.auth?.state==="PROVEN"&&x?.auth?.http_status===200).length,
    }));
  }


  if(phase==="authdrift"){
    const acq=await achieved("onshape.execution.context.acquire",{workItem:"phase5-auth",accessMode:"MATERIAL",documentId:docA,workspaceId:widA});
    const ctx=ctxId(acq);
    const before=await readName(docA,ctx);
    const fault=await qualificationAction("qualification_auth_drift",{executionContextId:ctx});
    if(fault?.armed!==true||fault?.execution_context_id!==ctx) throw new Error("auth drift fault not armed on opaque context");
    if("session_id" in (fault||{})||"sessionId" in (fault||{})) throw new Error("auth drift fault leaked physical slot identity");
    if(fault?.observed_auth_state==="PROVEN") throw new Error("auth drift did not invalidate browser authentication");
    const attempted="CF-PHASE5-AUTH-DRIFT-"+Date.now();
    const raw=await invokeRaw("onshape.documented.operation",{
      operationId:"updateDocumentAttributes",
      pathParams:{did:docA},
      body:{name:attempted},
      verification:{kind:"document_name_equals",value:attempted},
      executionContextId:ctx,
    });
    const r=raw?.result;
    if(r?.outcome?.state!=="ABSENT") throw new Error("auth drift did not terminate ABSENT "+JSON.stringify(r));
    if(r?.observation?.ackState!=="REJECTED"||r?.observation?.evidence?.effectSent!==false) throw new Error("auth drift not proven pre-effect "+JSON.stringify(r));
    if(!/SESSION_REJECTED|SESSION_UNKNOWN/.test(String(r?.observation?.detail||""))) throw new Error("auth drift rejection reason missing");
    const disabled=await call("onshape_pool_status");
    if(disabled.pool_enabled!==false) throw new Error("auth drift did not fail-close pool");
    await release(ctx);
    await restorePool();
    const restored=await call("onshape_pool_status");
    if(restored.pool_enabled!==true||restored.warming!==false||(restored.sessions||[]).filter(x=>x?.auth?.state==="PROVEN"&&x?.auth?.http_status===200).length!==5) {
      throw new Error("pool did not recover after qualification auth drift");
    }
    const rd=ctxId(await achieved("onshape.execution.context.acquire",{workItem:"phase5-read",accessMode:"READ_ONLY",documentId:docA,workspaceId:widA}));
    const after=await readName(docA,rd);
    await release(rd);
    if(after!==before||after===attempted) throw new Error("auth drift changed provider state");
    console.log(JSON.stringify({
      ok:true,phase,attemptId:r.attemptId,outcome:"ABSENT",
      observed_auth_state:fault.observed_auth_state,
      effect_sent:false,provider_state_unchanged:true,pool_fail_closed:true,pool_restored:true,
      physical_slot_hidden:true,
    }));
  }

  if(phase==="ackloss"){
    const acq=await achieved("onshape.execution.context.acquire",{workItem:"phase5-ack",accessMode:"MATERIAL",documentId:docA,workspaceId:widA});
    const ctx=ctxId(acq);
    const name="CF-PHASE5-ACK-"+Date.now();
    const response=await fetch("http://127.0.0.1:8791/v1/qualification/invoke-ack-loss",{
      method:"POST",
      headers:{"content-type":"application/json"},
      body:JSON.stringify({capabilityId:"onshape.documented.operation",arguments:{
        operationId:"updateDocumentAttributes",pathParams:{did:docA},body:{name},
        verification:{kind:"document_name_equals",value:name},executionContextId:ctx,
      }}),
    });
    const ack=await response.json();
    if(!response.ok||ack?.ok!==true) throw new Error("ack-loss endpoint failed "+JSON.stringify(ack));
    const r=ack.result;
    if(r?.outcome?.state!=="IN_DOUBT") throw new Error("ack loss did not produce IN_DOUBT "+JSON.stringify(r));
    const attempt=String(r.attemptId||"");
    if(!attempt.startsWith("attempt:")) throw new Error("ack loss missing attempt");
    const fenced=await call("onshape_pool_status");
    const lease=(fenced.workflow_leases||[]).find(x=>x.lease_id===ctx);
    if(lease?.state!=="UNCERTAIN") throw new Error("ack loss did not fence context UNCERTAIN");
    const blocked=await invokeRaw("onshape.execution.context.acquire",{workItem:"phase5-C",accessMode:"MATERIAL",documentId:docA,workspaceId:widA});
    if(blocked?.result?.outcome?.state==="ACHIEVED") throw new Error("ack-loss fence allowed replacement context");
    const rec=await call("onshape_fabric_reconcile",{attempt_id:attempt});
    if(rec?.result?.outcome?.state!=="ACHIEVED") throw new Error("same-attempt reconcile failed "+JSON.stringify(rec));
    const post=await call("onshape_pool_status");
    if((post.workflow_leases||[]).some(x=>x.lease_id===ctx)) throw new Error("reconciled context fence not released");
    const rd=ctxId(await achieved("onshape.execution.context.acquire",{workItem:"phase5-read",accessMode:"READ_ONLY",documentId:docA,workspaceId:widA}));
    const observed=await readName(docA,rd);
    await release(rd);
    if(observed!==name) throw new Error("ack-loss authoritative result mismatch");
    console.log(JSON.stringify({ok:true,phase,attemptId:attempt,outcome:"IN_DOUBT",reconciled:"ACHIEVED",readback:observed,no_blind_retry:true}));
  }

  if(phase==="restart-acquire"){
    const acq=await achieved("onshape.execution.context.acquire",{workItem:"phase5-restart",accessMode:"MATERIAL",documentId:docB,workspaceId:widB});
    const ctx=ctxId(acq);
    console.log(JSON.stringify({ok:true,phase,contextId:ctx,attemptId:acq.attemptId}));
  }

  if(phase==="restart-reconcile"){
    const attempt=String(process.env.CF_RESTART_ATTEMPT||"");
    const contextId=String(process.env.CF_RESTART_CONTEXT||"");
    if(!attempt.startsWith("attempt:")||!/^ctx_[0-9a-f]{32}$/.test(contextId)) throw new Error("bad restart ids");
    const pool=await call("onshape_pool_status");
    const lease=(pool.workflow_leases||[]).find(x=>x.lease_id===contextId);
    if(lease?.state!=="UNCERTAIN"||lease?.effect!=="MATERIAL") throw new Error("restart did not preserve UNCERTAIN material fence");
    const blocked=await invokeRaw("onshape.execution.context.acquire",{workItem:"phase5-B",accessMode:"MATERIAL",documentId:docB,workspaceId:widB});
    if(blocked?.result?.outcome?.state==="ACHIEVED") throw new Error("restart fence allowed competing context");
    const rec=await call("onshape_fabric_reconcile",{attempt_id:attempt});
    if(rec?.result?.outcome?.state!=="ACHIEVED") throw new Error("restart acquire reconciliation failed "+JSON.stringify(rec));
    const post=await call("onshape_pool_status");
    if((post.workflow_leases||[]).some(x=>x.lease_id===contextId)) throw new Error("restart acquire fence not released");
    const retry=ctxId(await achieved("onshape.execution.context.acquire",{workItem:"phase5-B",accessMode:"MATERIAL",documentId:docB,workspaceId:widB}));
    await release(retry);
    console.log(JSON.stringify({ok:true,phase,attemptId:attempt,restart_uncertain:true,competing_context_blocked:true,same_attempt_reconciled:true}));
  }
} finally {
  await c.close().catch(()=>{});
}
