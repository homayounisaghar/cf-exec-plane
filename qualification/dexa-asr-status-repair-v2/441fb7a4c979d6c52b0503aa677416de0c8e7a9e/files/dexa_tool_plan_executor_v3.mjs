// Versioned, provider-agnostic read-only executor.
// No parsing of Persian/English intent at execution time. No hidden tool args.
// Provider commands are admitted from the catalog and authenticated by gateway.
import fs from "node:fs";
import {createHash} from "node:crypto";
import {parseTypedPlan,isReference,resolveStepArgs,applyTypedTransform,getAt,verifyTypedPostconditions} from "./dexa_tool_plan_v3.mjs";
import {admitCatalogCall,catalogRoute,inputSchemaFor} from "./dexa_catalog_registry.mjs";
import {finishG2AReadOnlyPlan} from "./dexa_g2a_report_v1.mjs";
import {deliverTypedAnswer} from "./dexa_answer_contract_v1.mjs";
import {prepareBoundedEachRead,executeBoundedEachRead} from "./dexa_bounded_each_read_v1.mjs";
import {classifyInitialAsync,classifyTerminalStatus,
 adapterFromCheckpoint} from "./dexa_async_receipt_protocol.mjs";
import {isCatalogRetryableCode} from "./dexa_catalog_transport_contract.mjs";
import {executeBilingualIdentityLookup} from "./dexa_bilingual_identity_search_v1.mjs";
import {admittedEntityList,attachAdmittedIdentityList,
 uniqueEntityLabelFilter,admittedEntitySelectorQuery}
 from "./dexa_entity_resolver_v1.mjs";
import {DEXA_TEXT_WRITER_ID,validateWriterPlanStep,writerSourceIsReferenced}
 from "./dexa_text_writer_v1.mjs";
import {DEXA_WEB_SEARCH_ID,DEXA_WEB_READ_ID,executeDexaWebRead}
 from "./dexa_web_read_v1.mjs";
import {DEXA_WEB_EVIDENCE_ID,executeEvidenceCollection}
 from "./dexa_web_evidence_v1.mjs";
import {sourceLineageForWriter}
 from "./dexa_writer_source_provenance_v1.mjs";
import {catalogEffectClass,isProviderEffect} from "./dexa_effect_contract_v1.mjs";
import {optionalPredicateFieldProven}
 from "./dexa_catalog_output_adapters_v1.mjs";
const KEY="/home/cfserver/.local/share/dexa-catalog-gateway-20261023/internal-key";
const EXECUTOR_PORT=Number(process.env.DEXA_CATALOG_EXECUTOR_PORT||9484);
if(!Number.isSafeInteger(EXECUTOR_PORT)||EXECUTOR_PORT<1024||EXECUTOR_PORT>65535)
 throw Error("CATALOG_EXECUTOR_PORT_INVALID");
const ENDPOINT="http://127.0.0.1:"+EXECUTOR_PORT+"/catalog/execute";
const STATUS_ENDPOINT="http://127.0.0.1:"+EXECUTOR_PORT+"/catalog/status";
async function authenticatedCatalogReady(){
 const key=fs.readFileSync(KEY,"utf8").trim();
 const res=await fetch(STATUS_ENDPOINT,{method:"GET",
  headers:{"x-dexa-catalog-internal-key":key},
  signal:AbortSignal.timeout(3500)});
 if(!res.ok)throw Object.assign(new Error("CATALOG_STATUS_UNAVAILABLE"),
  {code:"CATALOG_STATUS_UNAVAILABLE"});
 const status=await res.json();
 if(status?.ok!==true)throw Object.assign(new Error("CATALOG_STATUS_INVALID"),
  {code:"CATALOG_STATUS_INVALID"});
 return status.oauthConnected===true;
}
const SHA=x=>createHash("sha256").update(JSON.stringify(x)).digest("hex");
const WAITING=new Set(["CATALOG_OAUTH_NOT_CONNECTED","CATALOG_OAUTH_TOKEN_FAILED"]);
function hasActualTypedReference(value){
 if(isReference(value))return true;
 if(value&&typeof value==="object"&&Object.hasOwn(value,"$item"))return true;
 if(Array.isArray(value))return value.some(hasActualTypedReference);
 if(value&&typeof value==="object")return Object.values(value).some(hasActualTypedReference);
 return false;
}
const PRIVATE_ERRORS=new Set(["CATALOG_OWNER_APPROVAL_REQUIRED",
 "CATALOG_SENSITIVE_READ_OWNER_APPROVAL_REQUIRED"]);
const MAX_PURE_READ_ATTEMPTS=3; // initial dispatch + at most two bounded recoveries
const READ_RETRY_DELAYS_MS=[180,420];
const waitReadRetry=delay=>new Promise(resolve=>setTimeout(resolve,delay));
function status(code,extra={}){
 return Object.assign({state:"REPLAN_REQUIRED",reason:code,
  result:"اجرای پذیرفته‌شده به مانع مشاهده‌شده رسید.",
  proof:{effectsExecuted:0,executionEntered:true}},extra);
}
// All pre-dispatch plan/connector failures are final no-effect admission
// failures, NEVER grounds for another model call or a second Kata search.
function preflight(code,extra={}){
 return Object.assign({state:"FAILED",reason:code,
  result:"رسپی قبل از اجرای ابزارها قابل پذیرش نبود؛ هیچ عملیاتی اجرا نشد.",
  proof:{effectsExecuted:0,initialPlanRejected:true,executionEntered:false}},extra);
}
function guidance(code,question,extras={}){
 return {state:"WAITING_USER_DECISION",reason:code,
  userQuestion:question,result:question,
  proof:{effectsExecuted:0,...extras}};
}
function waitLogin(){
 return {state:"WAITING_USER_AUTH",reason:"CATALOG_OWNER_OAUTH_REQUIRED",
  userQuestion:"اتصال OAuth حساب ابزار در پنل کاتالوگ دکسا نیاز به تایید مالک دارد.",
  result:"حساب ارائه دهنده را در کاتالوگ متصل کن.",
  proof:{effectsExecuted:0}};
}
async function invokeSingleReadOnlyCatalog({capabilityId,args},options={}){
 const key=fs.readFileSync(KEY,"utf8").trim();
 if(!/^[0-9a-f]{64}$/i.test(key))throw Error("CATALOG_SERVICE_KEY_INVALID");
 let res;
 try{
  res=await fetch(ENDPOINT,{
   method:"POST",
   headers:{"content-type":"application/json","x-dexa-catalog-internal-key":key},
   body:JSON.stringify({capabilityId,args}),
   signal:AbortSignal.timeout(options.timeoutMs||47000)
  });
 }catch(error){
  const code=error?.name==="AbortError"||error?.name==="TimeoutError"?
   "CATALOG_GATEWAY_TIMEOUT":"CATALOG_GATEWAY_UNAVAILABLE";
  throw Object.assign(new Error(code),{code,stage:"CATALOG_GATEWAY_REQUEST"});
 }
 let payload;
 try{payload=await res.json()}catch{
  const e=new Error("CATALOG_GATEWAY_REPLY_INVALID");e.code=e.message;
  e.stage="CATALOG_GATEWAY_REPLY";throw e;
 }
 if(!res.ok||payload?.ok!==true){
  // The gateway exposes ONLY sanitized code/stage, never raw provider text.
  const code=typeof payload?.error==="string"&&
   /^CATALOG_[A-Z0-9_]{3,100}$/.test(payload.error)?
   payload.error:"CATALOG_PROVIDER_REJECTED";
  const e=Object.assign(new Error(code),{code,httpStatus:res.status});
  if(typeof payload?.stage==="string"&&
   /^[A-Z_]{3,40}$/.test(payload.stage))e.stage=payload.stage;
  if(Number.isInteger(payload?.upstreamStatus)&&
   payload.upstreamStatus>=100&&payload.upstreamStatus<=599)
    e.upstreamStatus=payload.upstreamStatus;
  throw e;
 }
 return {result:payload.result,providerTool:payload.tool,
  durationMs:payload.durationMs,mode:payload.mode,
  effectProof:payload.effectProof||null,
  readOnly:payload.readOnly};
}
export async function invokeReadOnlyCatalog({capabilityId,args},options={}){
 const invoked=call=>invokeSingleReadOnlyCatalog(call,options);
 const identitySearch=/_(?:contact|conversation)_search$/.test(
  catalogRoute(capabilityId)?.cfName||'');
 if(identitySearch)
  return executeBilingualIdentityLookup({capabilityId,args,
   verifiedLabels:options.verifiedLabels||[],
   allowedCapabilities:options.allowedCapabilities||[],
   fullTarget:options.identityQuery||null,invokeOne:invoked});
 // A subset collection (e.g. unread chats) can be a valid user display
 // operation AND a bad source for resolving an entity with zero matching
 // subset records. ONLY when the typed plan has an explicit MATCH query,
 // extend that single read with an already Kata-admitted full collection.
 const ordinary=await invoked({capabilityId,args});
 if(typeof options.identityQuery!=='string'||!options.identityQuery.trim())
  return ordinary;
 const source=admittedEntityList({searchCapabilityId:capabilityId,
  allowedCapabilities:options.allowedCapabilities||[]});
 if(!source)return ordinary;
 const meta={schema:'dexa.bilingual-identity-search.v1',
  searchCapabilityId:capabilityId,
  queryCount:0,providerReadCount:1,
  sourceCapabilities:[capabilityId],verifiedProviderResults:true};
 const original={...ordinary,result:{...ordinary.result,bilingualLookup:meta}};
 const list=await invoked({capabilityId:source.capabilityId,args:source.args});
 if(list?.result&&['QUEUED','ACKNOWLEDGED','RUNNING','PENDING']
   .includes(list.result.status||list.result.state)){
  const error=new Error('CATALOG_BILINGUAL_ASYNC_CHECKPOINT_REQUIRED');
  error.code=error.message;throw error;
 }
 return attachAdmittedIdentityList({searchReply:original,listReply:list,
  listCapabilityId:source.capabilityId,listArgs:source.args});
}
async function reconcileStoredExternal({
 step,workflow,statusInvoker,expectedInputDigest
}){
 const current=workflow.external(step);
 if(!current)return {kind:"UNKNOWN",reason:"ASYNC_CHECKPOINT_NOT_WAITING"};
 if(current.originCapabilityId!==step.capabilityId)
  return {kind:"UNKNOWN",reason:"ASYNC_ORIGIN_CAPABILITY_MISMATCH"};
 let adapter;
 try{adapter=adapterFromCheckpoint(current)}
 catch(e){
  await workflow.quarantineExternal(step,{reason:e.code||"ASYNC_ADAPTER_MISMATCH"});
  return {kind:"UNKNOWN",reason:e.code||"ASYNC_ADAPTER_MISMATCH"};
 }
 if(Number.isFinite(Date.parse(current.nextPollAt))&&
    Date.now()<Date.parse(current.nextPollAt))
  return {kind:"WAIT",reason:"ASYNC_STATUS_CHECK_NOT_YET_DUE",
   nextPollAt:current.nextPollAt};
 const args=adapter.buildStatusArgs(current.requestId);
 let call;
 try{call=admitCatalogCall({capabilityId:current.statusCapabilityId,args})}
 catch(e){
  await workflow.quarantineExternal(step,{reason:e.code||"ASYNC_STATUS_NOT_AUTHORIZED"});
  return {kind:"UNKNOWN",reason:e.code||"ASYNC_STATUS_NOT_AUTHORIZED"};
 }
 let reply;
 try{reply=await statusInvoker({capabilityId:call.capabilityId,args:call.args})}
 catch(e){
  const checked=await workflow.noteExternalPoll(step,{
   errorCode:String(e.code||e.message||"ASYNC_STATUS_TRANSPORT_ERROR").slice(0,96)});
  return checked.state==="IN_DOUBT"?
   {kind:"UNKNOWN",reason:"ASYNC_STATUS_POLL_BUDGET_EXHAUSTED"}:
   {kind:"WAIT",reason:"ASYNC_STATUS_TRANSPORT_TEMPORARILY_UNAVAILABLE",
    nextPollAt:checked.nextPollAt};
 }
 if(reply?.providerTool&&reply.providerTool!==call.tool){
  await workflow.quarantineExternal(step,{reason:"ASYNC_STATUS_PROVIDER_IDENTITY_MISMATCH"});
  return {kind:"UNKNOWN",reason:"ASYNC_STATUS_PROVIDER_IDENTITY_MISMATCH"};
 }
 let classified;
 try{classified=classifyTerminalStatus({
  response:reply?.result,expectedRequestId:current.requestId})}
 catch(e){
  await workflow.quarantineExternal(step,{reason:e.code||"ASYNC_TERMINAL_PROOF_INVALID"});
  return {kind:"UNKNOWN",reason:e.code||"ASYNC_TERMINAL_PROOF_INVALID"};
 }
 if(classified.kind==="TRANSPORT_UNAVAILABLE"){
  const checked=await workflow.noteExternalPoll(step,{
   errorCode:classified.errorCode});
  return checked.state==="IN_DOUBT"?
   {kind:"UNKNOWN",reason:"ASYNC_STATUS_POLL_BUDGET_EXHAUSTED"}:
   {kind:"WAIT",reason:"ASYNC_STATUS_SERVICE_UNAVAILABLE",
    nextPollAt:checked.nextPollAt};
 }
 if(classified.kind==="PENDING"){
  const checked=await workflow.noteExternalPoll(step,{status:classified.status});
  return checked.state==="IN_DOUBT"?
   {kind:"UNKNOWN",reason:"ASYNC_STATUS_POLL_BUDGET_EXHAUSTED"}:
   {kind:"WAIT",reason:"ASYNC_PROVIDER_STILL_EXECUTING",
    nextPollAt:checked.nextPollAt};
 }
 if(classified.kind==="FAILED"){
  await workflow.failExternal(step,{
   status:classified.status,errorCode:classified.errorCode});
  return {kind:"FAILED",reason:classified.errorCode,status:classified.status};
 }
 return {kind:"COMPLETED",result:classified.result,status:classified.status,
  requestId:current.requestId,adapterId:current.adapterId,
  statusCapabilityId:current.statusCapabilityId,
  providerStatusTool:call.tool,
  statusDurationMs:reply?.durationMs??null,
  expectedInputDigest};
}

export async function executeTypedPlan(raw,{
 allowedCapabilities=[],toolInvoker=invokeReadOnlyCatalog,
 onReceipt=async()=>{},onStep=async()=>{},onReplay=async()=>{},
 onBeforeStep=async()=>null,
 onOperationOutcome=async()=>{},onProgress=async()=>{},
 onVerifiedFileRead=async()=>null,workflow=null,
 statusInvoker=invokeReadOnlyCatalog,bilingualVerifiedLabels=[],
 ownerGoal=null,writerInvoker=null,
 connectionProbe=authenticatedCatalogReady
 }={}){
 let plan;
 try{plan=typeof raw==="string"?parseTypedPlan(raw,allowedCapabilities):parseTypedPlan(JSON.stringify(raw),allowedCapabilities)}
 catch(e){
  const code=String(e.code||e.message||"TOOL_PLAN_INVALID");
  // A malformed G2A candidate is a no-effect planner error, not an
  // invitation to auto-repair/re-send the owner request.
  return preflight(code)
 }
 if(plan.status==="NEEDS_INPUT"){
  const prompt=plan.missing.map(m=>m.question).join(" ");
  return guidance("TOOL_PLAN_NEEDS_INPUT",prompt.slice(0,1200),
   {missingFields:plan.missing.map(m=>({field:m.field,capabilityId:m.capabilityId||null}))});
 }
 if(plan.status==="UNRESOLVED"){
  return preflight("TOOL_PLAN_UNRESOLVED",{
   result:"هیچ مسیر مجاز و معتبری برای اجرای درخواست شناسایی نشده است.",
   proof:{effectsExecuted:0,modelReason:plan.reason}});
 }
 const g2a=Array.isArray(plan.outputs)&&plan.outputs.length>1;
 if(g2a&&(!workflow||typeof workflow.recordOutcome!=="function"))
  return {state:"FAILED",reason:"G2A_DURABLE_WORKFLOW_REQUIRED",
   result:"ثبت پایدارِ نتیجهٔ عملیات مستقل در دسترس نیست؛ هیچ ابزاری اجرا نشد.",
   proof:{effectsExecuted:0,initialPlanRejected:true}};
 // The writer is a regular admitted TOOL. Its source provenance and bound
 // same-model executor must be established BEFORE any provider read.
 const byId=new Map(plan.steps.map(s=>[s.id,s]));
 // Preflight the *entire plan* before executing a single tool. A model cannot
 // smuggle a late write after earlier reads or waste reads with missing args.
 for(const step of plan.steps){
  if(step.kind!=="TOOL")continue;
  const route=catalogRoute(step.capabilityId);
  if(route?.internalExecutor==="bounded_cerebras_text"){
   if(typeof writerInvoker!=='function')
    return preflight('DX001_WRITER_EXECUTOR_UNBOUND');
   try{validateWriterPlanStep(step,{ownerGoal,byId})}
   catch(error){return preflight(error?.code||'DX001_WRITER_PREFLIGHT_INVALID')}
  }else if(route?.internalExecutor==="bounded_public_web"){
   // A literal URL can be read only if the owner actually supplied it.
   // A URL returned by web.search must arrive via the normal typed $ref.
   if(step.capabilityId===DEXA_WEB_READ_ID&&
      typeof step.args?.url==="string"&&
      !String(ownerGoal||"").includes(step.args.url))
    return preflight("DX005_WEB_LITERAL_URL_NOT_OWNER_GROUNDED");
  }
  if(!route||!route.cfName)
   return preflight("TOOL_PROVIDER_CONNECTOR_NOT_BOUND",{
    result:"مجری ابزار "+step.capabilityId+" هنوز متصل نیست.",
    proof:{effectsExecuted:0,initialPlanRejected:true,
     executionEntered:false,blockedStepId:step.id}});
  // The authenticated sole owner approved ALL bound tools. No redundant
  // per-tool or per-risk approval is invented by Dexa at preflight.
  if(step.mode==="EACH"&&!route.isReadOnly)
   return preflight("TOOL_EFFECT_EACH_REQUIRES_EXPLICIT_STEPS",{
    proof:{effectsExecuted:0,initialPlanRejected:true,
     blockedStepId:step.id}});
  const missing=(inputSchemaFor(step.capabilityId)?.required||[])
   .filter(key=>!Object.hasOwn(step.args,key));
  if(missing.length)return guidance("TOOL_REQUIRED_ARGUMENTS_MISSING",
   "برای ابزار "+step.capabilityId+" مقدار این پارامترها لازم است: "+missing.join("، "),
   {blockedStepId:step.id,missingFields:missing});
  // G2A cannot downgrade a predictable bad later literal call into partial
  // execution. All statically checkable calls are admitted before first read.
  if(!hasActualTypedReference(step.args)){
   try{admitCatalogCall({capabilityId:step.capabilityId,args:step.args,
     readOnlyOnly:false})}
   catch(error){return {state:"FAILED",reason:"G2A_PREFLIGHT_ARGUMENTS_INVALID",
    result:"آرگومان یکی از ابزارهای رسپی از ابتدا نامعتبر است؛ هیچ ابزاری اجرا نشد.",
    proof:{effectsExecuted:0,initialPlanRejected:true,blockedStepId:step.id,
     errorCode:String(error?.code||"CATALOG_ARGUMENTS_INVALID").slice(0,100)}}}
  }
 }
 if(plan.steps.some(step=>step.kind==="USER_GATE")&&!workflow)
  return preflight("WORKFLOW_GATE_REQUIRES_DURABLE_KERNEL");
 const effectful=plan.steps.some(step=>step.kind==="TOOL"&&
  isProviderEffect(catalogRoute(step.capabilityId)));
 if(effectful&&!workflow)
  return preflight("WORKFLOW_EFFECT_DURABLE_KERNEL_REQUIRED");
 if(effectful){
  // Check existing owner OAuth BEFORE writing any DISPATCHED checkpoint. A
  // missing provider session is not a new owner-approval requirement.
  try{
   if(await connectionProbe()!==true)return waitLogin();
  }catch(error){return preflight(error?.code||"CATALOG_STATUS_UNAVAILABLE")}
 }
 const results=new Map(),receipts=[],operationOutcomes=new Map();
 const fileArtifacts=new Map();
 const usedArtifactRefs=value=>{
  const found=new Map();
  const scan=x=>{
   if(isReference(x)){
    const ref=fileArtifacts.get(x.$ref.step);
    if(ref)found.set(x.$ref.step,ref);
    return;
   }
   if(Array.isArray(x)){for(const item of x)scan(item);return}
   if(x&&typeof x==='object')for(const item of Object.values(x))scan(item);
  };
  scan(value);
  return [...found.entries()].map(([sourceStep,ref])=>({sourceStep,ref}));
 };
 const started=Date.now();
 const effectCount=()=>receipts.filter(r=>r.kind==="TOOL"&&
  ["WRITE","DESTRUCTIVE","IRREVERSIBLE"].includes(r.effectClass)).length;
 const runtimeStatus=(code,extra={})=>{
  const effects=effectCount();
  if(!effects)return status(code,extra);
  return {state:"OUTCOME_UNKNOWN",reason:code,
   result:"بخشی از عملیات واقعاً انجام شده است؛ بدون تکرار آثار قبلی، وضعیت بقیه بررسی شود.",
   proof:{...extra.proof,effectsExecuted:effects,
    verifiedReceipts:receipts,partialVerifiedEffects:true}};
 };
 const failure=(code)=>Object.assign(new Error(code),{code,g2aVerifiedFailure:true});
 async function recordOperation(step,statusCode,reasonCode=null,replayed=false){
  if(statusCode!=="SUCCEEDED_VERIFIED"){
   if(!workflow)throw Error("G2A_OUTCOME_JOURNAL_MISSING");
   await workflow.recordOutcome(step,{status:statusCode,reasonCode});
  }
  const entry={stepId:step.id,status:statusCode,
   ...(reasonCode===null?{}:{reasonCode}),replayed};
  operationOutcomes.set(step.id,entry);
  await onOperationOutcome(entry);
 }
 for(const step of plan.steps){
  const stepStarted=new Date().toISOString();
  try{
   if(g2a){
    const prior=workflow.outcome(step);
    if(prior){
     operationOutcomes.set(step.id,{stepId:step.id,status:prior.state,
      reasonCode:prior.reasonCode,replayed:true});
     await onOperationOutcome({stepId:step.id,status:prior.state,
      reasonCode:prior.reasonCode,replayed:true});
     continue;
    }
    const blocked=[...step.deps,...(step.after||[])].find(id=>
     ["FAILED_VERIFIED","SKIPPED_DEPENDENCY"].includes(operationOutcomes.get(id)?.status));
    if(blocked!==undefined){
     await recordOperation(step,"SKIPPED_DEPENDENCY","G2A_DEPENDENCY_FAILED");
     continue;
    }
   }
   const cached=workflow?.get(step);
   if(cached){
    if(step.kind==="TOOL"&&step.mode!=="EACH"){
     const prior=await onVerifiedFileRead({step,receipt:cached.receipt,
      result:cached.result,args:step.args,replayed:true});
     if(prior?.ref)fileArtifacts.set(step.id,prior.ref);
    }
    results.set(step.id,cached.result);
    receipts.push(cached.receipt);
    // Reconcile main mission JSON if a crash happened AFTER checkpoint commit
    // but BEFORE its normal receipt/cursor were durably persisted.
    await onReplay({step,receipt:cached.receipt});
    if(g2a)await recordOperation(step,"SUCCEEDED_VERIFIED",null,true);
    continue;
   }
   // The owner may pause/stop ONLY the unstarted future at the next
   // safe boundary. Verified earlier checkpoints remain immutable. No
   // post-dispatch interruption or provider-side cancellation is implied.
   const control=await onBeforeStep({stepId:step.id,
    capabilityId:step.capabilityId||"LOCAL",planVersion:workflow?.summary()?.planVersion||null,
    effectsAlreadyVerified:effectCount()});
   if(control?.state==="PAUSED"||control?.state==="STOPPED_FUTURE"){
    return {state:control.state,reason:"OWNER_"+control.state,
     result:control.state==="PAUSED"?
      "مأموریت در مرز امن متوقف شد؛ عملیات قبلی لغو نشده‌اند.":
      "اجرای مراحل آینده متوقف شد؛ عملیات قبلی نزد ارائه‌دهنده لغو نشده‌اند.",
     proof:{effectsExecuted:effectCount(),verifiedReceipts:receipts,
      completedStepCount:receipts.length,
      stoppedBeforeStepId:step.id,providerCancellationVerified:false,
      safeFutureBoundary:true}};
   }
   if(step.kind==="USER_GATE"){
    const gate=await workflow.waitForOwner(step);
    if(gate.state==="COMPLETED"){
     results.set(step.id,gate.result);
     receipts.push(gate.receipt);
     await onReplay({step,receipt:gate.receipt});
     if(g2a)await recordOperation(step,"SUCCEEDED_VERIFIED",null,true);
     continue;
    }
    return {state:"WAITING_USER_DECISION",reason:"WORKFLOW_USER_GATE",
     userQuestion:step.question,result:step.question,proof:{
      component:"workflow_kernel",typedPlanSchema:"dexa.tool-plan.v3",
      planVersion:workflow.summary().planVersion,stepId:step.id,
      gateId:gate.gateId,effectsExecuted:0,
      verifiedReceipts:receipts}};
   }
   await onStep({stepId:step.id,kind:step.kind,
    capabilityId:step.capabilityId||"LOCAL"});
   let result,providerTool=null,toolDuration=null,evidenceKind=null,argsDigest=null,matchEvidence=null;
   let verifiedToolArgs=null,artifactInputs=[];
   let providerEffectProof=null;
   let fanoutEvidence=null,fanoutCount=0;
   let asyncTerminal=null,catalogReadAttemptCount=1;
   if(step.kind==="TOOL"){
    const route=catalogRoute(step.capabilityId);
    if(!route?.cfName){
     return runtimeStatus("TOOL_PROVIDER_CONNECTOR_NOT_BOUND",{
      result:"مسیر اتصال "+step.capabilityId+" هنوز به مجری تاییدشده مجهز نیست.",
      proof:{effectsExecuted:0,blockedStepId:step.id,receipts}});
    }
    // Every bound tool is executable under the owner's authenticated account.
    // Runtime admission checks actual schema and durable effects, NOT risk labels.
    let preparedEach=null;
    let admitted;
    try{
     if(step.mode==="EACH"){
      preparedEach=prepareBoundedEachRead(step,results);
      admitted=preparedEach.entries[0].admitted;
     }else{
      const referenced=usedArtifactRefs(step.args);
      for(const item of referenced){
       const source=results.get(item.sourceStep);
       const sourceContent=source?.result?.content;
       if(typeof sourceContent!=='string'||
        createHash('sha256').update(Buffer.from(sourceContent,'utf8')).digest('hex')!==item.ref.digest)
        throw Object.assign(new Error('ARTIFACT_REF_RESULT_DIGEST_MISMATCH'),
         {code:'ARTIFACT_REF_RESULT_DIGEST_MISMATCH'});
      }
      artifactInputs=referenced.map(x=>x.ref.id);
      const args=resolveStepArgs(step.args,results);
      admitted=admitCatalogCall({capabilityId:step.capabilityId,args,
       readOnlyOnly:false});
     }
    }
    catch(err){
     if(err?.code==="CATALOG_ARGUMENTS_SCHEMA_INVALID"){
      const fields=err.issues?.filter(x=>x.keyword==="required").map(x=>x.property).filter(Boolean)||[];
      if(fields.length)return guidance("TOOL_REQUIRED_ARGUMENTS_MISSING",
       "برای ابزار "+step.capabilityId+" مقادیر پارامترهای "+fields.join("، ")+" لازم است.",
       {missingFields:fields,blockedStepId:step.id,receipts});
     }
     return runtimeStatus(err?.code||"TOOL_ARGS_SCHEMA_INVALID",{
      proof:{effectsExecuted:0,blockedStepId:step.id,receipts}});
    }
    verifiedToolArgs=admitted.args;
    argsDigest=preparedEach?.inputDigest||SHA(admitted.args);
    if(workflow){
     const start=await workflow.begin(step,{inputHash:argsDigest,
      readOnly:route.isReadOnly});
     if(start.state==="WAITING_EXTERNAL"){
      const terminal=await reconcileStoredExternal({
       step,workflow,statusInvoker,expectedInputDigest:argsDigest});
      if(terminal.kind==="WAIT")
       return {state:"WAITING_EXTERNAL",reason:"WORKFLOW_EXTERNAL_RESULT_PENDING",
        result:"فرمان اصلی هنوز نتیجهٔ نهایی ندارد؛ فقط شناسهٔ قبلی پیگیری می‌شود.",
        proof:{component:"workflow_kernel",stepId:step.id,
         planVersion:workflow.summary().planVersion,effectsExecuted:0,
         nextPollAt:terminal.nextPollAt||null}};
      if(terminal.kind==="UNKNOWN")
       return {state:"OUTCOME_UNKNOWN",reason:terminal.reason,
        result:"رسید واقعی فرمان قابل تأیید نیست؛ فرمان مجدداً ارسال نمی‌شود.",
        proof:{component:"workflow_kernel",blockedStepId:step.id,
         effectsExecuted:0}};
      if(terminal.kind==="FAILED"){
       if(g2a)throw failure("WORKFLOW_EXTERNAL_PROVIDER_FAILED");
       return {state:"FAILED",reason:"WORKFLOW_EXTERNAL_PROVIDER_FAILED",
        result:"فرمان قبلی طبق رسید واقعی ارائه‌دهنده ناموفق بوده است.",
        proof:{component:"workflow_kernel",stepId:step.id,
         providerErrorCode:terminal.reason,terminalStatus:terminal.status,
         effectsExecuted:0}};
      }
      asyncTerminal=terminal;
      result=terminal.result;
      providerTool=admitted.tool;
      toolDuration=terminal.statusDurationMs;
      evidenceKind="AUTHENTICATED_ASYNC_TERMINAL_RESULT";
     }
     if(start.state==="EXTERNAL_FAILED"){
      if(g2a)throw failure("WORKFLOW_EXTERNAL_PROVIDER_FAILED");
      return {state:"FAILED",reason:"WORKFLOW_EXTERNAL_PROVIDER_FAILED",
       result:"ارائه‌دهنده قبلاً پایان ناموفق فرمان را تأیید کرده است.",
       proof:{component:"workflow_kernel",stepId:step.id,
        providerErrorCode:start.errorCode,effectsExecuted:0}};
     }
     if(start.state==="IN_DOUBT")
      return {state:"OUTCOME_UNKNOWN",reason:"WORKFLOW_EFFECT_IN_DOUBT",
       result:"اجرای گام نامطمئن است؛ بدون تطبیق وضعیت واقعی تکرار نخواهد شد.",
       proof:{effectsExecuted:0,blockedStepId:step.id}};
     if(start.state==="FAILED_VERIFIED"||start.state==="SKIPPED_DEPENDENCY")
      return {state:"FAILED",reason:start.reasonCode,
       result:"گام خواندنی قبلاً با علت ثبت‌شده ناموفق شده است؛ درخواست دوباره فرستاده نشد.",
       proof:{component:"workflow_kernel",blockedStepId:step.id,
        effectsExecuted:0,fromDurableCheckpoint:true}};
    }
    if(!asyncTerminal){
    let response,error=null,dispatchAttempts=0;
    // A gateway-labelled readOnly operation is NOT automatically repeatable:
    // queued phone reads can have effects. Retry only separately audited,
    // side-effect-free catalog reads, and only on known transient errors.
    const retrySafeRead=route.retrySafeRead===true&&admitted.readOnly===true;
    const maxAttempts=retrySafeRead?MAX_PURE_READ_ATTEMPTS:1;
    for(let attempt=1;attempt<=maxAttempts;attempt++){
     dispatchAttempts=attempt;
     try{
      if(preparedEach){
       const batch=await executeBoundedEachRead(preparedEach,{toolInvoker,
        onProgress:progress=>onProgress({stepId:step.id,...progress})});
       response={result:batch.results,providerTool:batch.physicalTool,
        durationMs:batch.providerDurationMs};
       fanoutEvidence=batch.evidence;
       fanoutCount=batch.readCount;
      }else if(route.internalExecutor==="bounded_cerebras_text"){
       const sourceProvenance=writerSourceIsReferenced(step)?
        sourceLineageForWriter({writerStep:step,steps:plan.steps,
         receipts,sourceValue:admitted.args.source,
         originResults:results}):null;
       response=await writerInvoker({capabilityId:admitted.capabilityId,
        args:admitted.args,stepId:step.id,inputDigest:argsDigest,
        sourceProvenance});
      }else if(route.internalExecutor==="bounded_public_web"){
       response=step.capabilityId===DEXA_WEB_EVIDENCE_ID?
        await executeEvidenceCollection({capabilityId:admitted.capabilityId,
         args:admitted.args}):
        await executeDexaWebRead({capabilityId:admitted.capabilityId,
         args:admitted.args});
      }else{
       // The provider-neutral identity broker gets the SAME explicit name
       // whether Qwen emits MATCH or FILTER -> FILTER -> ONLY. No text
       // parsing, invented query, extra model call or provider change.
       const selector=admittedEntitySelectorQuery(plan.steps,step.id,{
        outputStepId:plan.output?.step});
       response=await toolInvoker({capabilityId:admitted.capabilityId,
        args:admitted.args},{verifiedLabels:bilingualVerifiedLabels,
        allowedCapabilities,identityQuery:selector});
      }
      error=null;
      break;
     }catch(err){
      error=err;
      if(!retrySafeRead||
         !isCatalogRetryableCode(err?.code||err?.message)||
         attempt===maxAttempts)break;
      await waitReadRetry(READ_RETRY_DELAYS_MS[attempt-1]);
     }
    }
    catalogReadAttemptCount=preparedEach?fanoutCount:
     (Number.isSafeInteger(response?.result?.bilingualLookup?.providerReadCount)?
       response.result.bilingualLookup.providerReadCount:dispatchAttempts);
    if(error){
     const code=String(error?.code||error?.message||"CATALOG_UNKNOWN").slice(0,100);
     // These two in-process public HTTPS operations are independently
     // audited GET-only/no-effect. An unreachable external page is a
     // definitive read obstacle, not an uncertain provider-side write.
     // Do not retry the same URL blindly or erase earlier search receipts.
     if(route.internalExecutor==="bounded_public_web"&&
        /^DEXA_WEB_[A-Z0-9_]{3,100}$/.test(code))
      return runtimeStatus("DX005_PUBLIC_WEB_READ_OBSTRUCTED",{
       result:"خواندن منبع عمومی وب ناموفق بود؛ هیچ دادهٔ جاری از آن تأیید نشد.",
       proof:{effectsExecuted:0,blockedStepId:step.id,
        verifiedReceipts:receipts,errorCode:code,
        attemptedPureGet:true,mayRetryOnlyWithNewAdmittedPlan:true}});
     if(WAITING.has(code))return waitLogin();
     if(code==="DX005_WRITER_MEDIA_SOURCE_REQUIRES_CONTENT"||
        code==="DX001_WRITER_MEDIA_CONTENT_NOT_TRANSCRIBED")
      return runtimeStatus(code,{
       result:"متن واقعی پیوست دریافت یا رونویسی نشده؛ توضیح کنار فایل جایگزین آن نیست.",
       proof:{effectsExecuted:0,blockedStepId:step.id,
        verifiedReceipts:receipts,ownerSemanticObjectiveIndependentlyProven:false}});
     // Provider-native authentication is still enforced upstream; Dexa
     // invents no per-tool/risk "strong owner approval" request.
     const definitiveCatalogFailure=retrySafeRead&&
      /^CATALOG_[A-Z0-9_]{3,100}$/.test(code)&&code!=="CATALOG_BACKEND_ERROR";
     if(definitiveCatalogFailure){
      // The durable workflow already recorded DISPATCHED. An independently
      // audited repeatable read has no pending effect to reconcile; commit a
      // VERIFIED STEP FAILURE to avoid spurious IN_DOUBT on restart.
      const reason=isCatalogRetryableCode(code)?
       "TOOL_READONLY_TRANSPORT_EXHAUSTED":"TOOL_READONLY_PROVIDER_FAILED";
      // A multi-output G2A report must retain verified successful siblings.
      // Journal the failed part, skip its dependencies and continue other
      // independently allowed reads instead of erasing partial progress.
      if(g2a){
       await recordOperation(step,"FAILED_VERIFIED",reason);
       continue;
      }
      if(workflow)await workflow.recordOutcome(step,{
       status:"FAILED_VERIFIED",reasonCode:reason});
      return {state:"FAILED",reason,
       result:"خواندن داده از سرویس برقرار نشد؛ هیچ نتیجه‌ای تأیید نشده است.",
       proof:{component:"catalog_read_only",effectsExecuted:0,
        blockedStepId:step.id,errorCode:code,
        errorStage:typeof error?.stage==="string"?error.stage:null,
        upstreamStatus:Number.isInteger(error?.upstreamStatus)?
         error.upstreamStatus:null,
        attemptCount:dispatchAttempts,retryCount:dispatchAttempts-1,
        verifiedReceipts:receipts}};
     }
     if(workflow)return {state:"OUTCOME_UNKNOWN",
      reason:"WORKFLOW_PROVIDER_DISPATCH_IN_DOUBT",
      result:"فرمان ارسال شده اما رسید نتیجه دریافت نشده است؛ بدون آشتی‌دادن وضعیت واقعی دوباره اجرا نمی‌شود.",
      proof:{component:"workflow_kernel",effectsExecuted:0,blockedStepId:step.id,
       errorCode:code,verifiedReceipts:receipts}};
     return runtimeStatus("TOOL_PROVIDER_ERROR",{
      result:"ابزار پاسخ معتبر نداد؛ بدون ارسال مجدد عملیات، اتصال و لاگ آن بررسی شود.",
      proof:{effectsExecuted:0,blockedStepId:step.id,
       errorCode:code,receipts}});
    }
    result=response?.result;
    providerTool=response?.providerTool||admitted.tool;
    toolDuration=response?.durationMs||null;
    if(isProviderEffect(route)){
     // The authenticated gateway must return a terminal provider-origin proof.
     // Otherwise the dispatch is IN_DOUBT and cannot be automatically repeated.
     providerEffectProof=response?.effectProof||null;
     if(providerEffectProof?.providerTool!==admitted.tool||
        providerEffectProof.outcome!=="PROVIDER_REPORTED_SUCCEEDED")
      return {state:"OUTCOME_UNKNOWN",reason:"WORKFLOW_PROVIDER_EFFECT_RECEIPT_UNKNOWN",
       result:"فرمان اجرا شده، ولی نتیجهٔ قطعیِ ارائه‌دهنده اثبات نشده؛ تکرار نمی‌شود.",
       proof:{effectsExecuted:effectCount(),verifiedReceipts:receipts,
        blockedStepId:step.id}};
    }
    evidenceKind=route.internalExecutor==="bounded_cerebras_text"?
      "DX001_DURABLE_TEXT_TOOL_RESULT":
      route.internalExecutor==="bounded_public_web"?"DX005_VERIFIED_PUBLIC_WEB_READ":
      isProviderEffect(route)?"OWNER_AUTHENTICATED_PROVIDER_EFFECT_TERMINAL":
      preparedEach?"BOUNDED_AUTHENTICATED_PROVIDER_READS":
      "OWNER_AUTHENTICATED_PROVIDER_READ";
    const initial=classifyInitialAsync({
     capabilityId:step.capabilityId,result});
    if(initial.kind==="PENDING"){
      if(!workflow)return {state:"OUTCOME_UNKNOWN",
       reason:"ASYNC_DURABLE_KERNEL_REQUIRED",
       result:"فرمان صف‌شده بدون دفتر پایدار قابل پیگیری نیست.",
       proof:{effectsExecuted:0,blockedStepId:step.id}};
      await workflow.waitExternal(step,{
       requestId:initial.requestId,status:initial.status,
       adapterId:initial.adapterId,originCapabilityId:initial.originCapabilityId,
       statusCapabilityId:initial.statusCapabilityId});
      return {state:"WAITING_EXTERNAL",reason:"WORKFLOW_EXTERNAL_RESULT_PENDING",
       result:"شناسهٔ فرمان ذخیره شد؛ تکمیل واقعی دستگاه هنوز تأیید نشده است.",
       proof:{component:"workflow_kernel",
        planVersion:workflow.summary().planVersion,
        stepId:step.id,requestIdPresent:true,effectsExecuted:0}};
    }
    if(initial.kind==="FAILED"){
     if(g2a)throw failure("ASYNC_IMMEDIATE_PROVIDER_FAILED");
     return {state:"FAILED",reason:"ASYNC_IMMEDIATE_PROVIDER_FAILED",
      result:"ارائه‌دهنده اجرای فرمان را ناموفق اعلام کرده است.",
      proof:{component:"workflow_kernel",blockedStepId:step.id,
       effectsExecuted:0}};
    }
    if(initial.kind==="COMPLETED"){
     // Direct terminal receipt uses actual returned payload, never QUEUED body.
     result=initial.result;
     asyncTerminal={status:initial.status,requestId:initial.requestId,
      adapterId:initial.adapterId,statusCapabilityId:initial.statusCapabilityId};
     evidenceKind="AUTHENTICATED_ASYNC_TERMINAL_RESULT";
    }
    }
    if(g2a&&result!==null&&typeof result==="object"&&
       /^(FAILED|ERROR|DENIED|BLOCKED)$/i.test(String(result.state||"")))
     throw failure("TOOL_PROVIDER_REPORTED_FAILED");
    if(g2a&&(result===null||result===undefined||result?.isError===true||
       result?.ok===false||/^(IN_DOUBT)$/i.test(String(result?.state||""))))
     return {state:"OUTCOME_UNKNOWN",reason:"G2A_PROVIDER_RESULT_UNVERIFIED",
      result:"نتیجهٔ یکی از ابزارها نامعلوم است؛ ادامهٔ مستقل نیز برای ایمنی متوقف شد.",
      proof:{component:"workflow_kernel",blockedStepId:step.id,
       effectsExecuted:0,verifiedReceipts:receipts}};
    if(result===null||result===undefined||result?.isError===true||
       result?.ok===false||/^(FAILED|ERROR|DENIED|BLOCKED|IN_DOUBT)$/i.test(String(result?.state||""))){
     return runtimeStatus("TOOL_PROVIDER_RESULT_UNVERIFIED",{proof:{
      effectsExecuted:0,blockedStepId:step.id,receipts}});
    }
   }else{
    if(!results.has(step.source.step))
     return runtimeStatus("TOOL_DEPENDENCY_NOT_VERIFIED");
    if(workflow){
     const start=await workflow.begin(step,{
      inputHash:SHA({sourceStep:step.source.step,
       sourceDigest:SHA(results.get(step.source.step)),op:step.op}),
      readOnly:true});
     if(start.state==="IN_DOUBT")
      return runtimeStatus("WORKFLOW_LOCAL_STEP_IN_DOUBT");
    }
    result=applyTypedTransform(step,results,{
     onMatch:e=>{matchEvidence=e},
     uniqueIdentityLabel:uniqueEntityLabelFilter(plan.steps,step),
     allowMissingOptionalField:step.op==='FILTER'&&
      optionalPredicateFieldProven(plan.steps,step.source.step,
       step.source.path,step.predicate?.path)
    });
    evidenceKind="DETERMINISTIC_TRANSFORMATION";
   }
   const json=JSON.stringify(result);
   if(json===undefined||json.length>400000)
    return runtimeStatus("TOOL_RESULT_EXCEEDS_MEMORY_BUDGET");
   const completedAt=new Date().toISOString();
   const receipt=Object.freeze({
    receiptId:"v3:"+step.id+":"+SHA({stepId:step.id,completedAt,result:SHA(result)}).slice(0,24),
    stepId:step.id,kind:step.kind,capabilityId:step.capabilityId||"LOCAL",
    physicalTool:providerTool,sourceStep:step.source?.step||null,
    inputDigest:argsDigest,outputDigest:SHA(result),evidenceKind,
    matchEvidence,
    effectClass:step.kind==="TOOL"?catalogEffectClass(catalogRoute(step.capabilityId)):"PURE_LOCAL",
    effectProof:providerEffectProof,
    asyncAdapterId:asyncTerminal?.adapterId||null,
    asyncStatusCapabilityId:asyncTerminal?.statusCapabilityId||null,
    asyncTerminalStatus:asyncTerminal?.status||null,
    asyncRequestIdDigest:asyncTerminal?SHA(asyncTerminal.requestId):null,
    asyncStatusProviderTool:asyncTerminal?.providerStatusTool||null,
    providerDurationMs:toolDuration,
    catalogReadAttemptCount,
    ...(artifactInputs.length?{artifactInputRefs:[...artifactInputs]}:{}),
    ...(fanoutEvidence?{fanoutCount,fanoutEvidence}:{}),
    startedAt:stepStarted,completedAt,
    status:"SUCCEEDED_VERIFIED",resultVerified:true
   });
   if(workflow)await workflow.complete(step,{result,receipt,
    inputHash:argsDigest|| (step.kind==="TRANSFORM"?SHA({
     sourceStep:step.source.step,sourceDigest:SHA(results.get(step.source.step)),
     op:step.op}):null)});
   if(step.kind==="TOOL"&&step.mode!=="EACH"){
    const witnessed=await onVerifiedFileRead({step,receipt,result,
     args:verifiedToolArgs,replayed:false});
    if(witnessed?.ref)fileArtifacts.set(step.id,witnessed.ref);
   }
   results.set(step.id,result);
   receipts.push(receipt);
   await onReceipt(receipt);
   if(g2a)await recordOperation(step,"SUCCEEDED_VERIFIED");
  }catch(err){
   if(g2a&&err?.g2aVerifiedFailure===true){
    await recordOperation(step,"FAILED_VERIFIED",err.code);
    continue;
   }
   const code=String(err?.code||err?.message||"TOOL_PLAN_EXECUTION_ERROR").slice(0,100);
   if(workflow&&(code.startsWith("WORKFLOW_")||code.startsWith("ASYNC_"))){
    return {state:"OUTCOME_UNKNOWN",reason:code,
     result:"وضعیت checkpoint قابل‌اعتماد نیست؛ هیچ فرمانی تکرار نمی‌شود.",
     proof:{component:"workflow_kernel",effectsExecuted:0,
      blockedStepId:step.id,verifiedReceipts:receipts}};
   }
   if(g2a&&step.kind==="TRANSFORM"&&code.startsWith("TOOL_PLAN_")){
    await recordOperation(step,"FAILED_VERIFIED",code);
    continue;
   }
   if(code.startsWith("TOOL_PLAN_MATCH_")){
    return runtimeStatus(code,{
     result:"تطبیق نام طبق محدوده و قواعد رسپی ممکن یا یکتا نبود؛ هیچ هدفی حدس زده نشد.",
     proof:{effectsExecuted:0,blockedStepId:step.id,
      matchDiagnostics:err?.diagnostics||null,receipts}});
   }
   if(code==="TOOL_PLAN_UNIQUE_RESULT_REQUIRED")
    return guidance("TOOL_AMBIGUOUS_OR_EMPTY_MATCH",
     "منبع داده هیچ تطابق یکتایی ندارد. نام یا مشخصهٔ دقیق‌تر لازم است.",
     {blockedStepId:step.id,receipts});
   return runtimeStatus(code,{proof:{effectsExecuted:0,blockedStepId:step.id,receipts}});
  }
 }
 if(g2a)return finishG2AReadOnlyPlan({plan,results,receipts,
  stepOutcomes:operationOutcomes,started});
 try{
  const checks=verifyTypedPostconditions(plan,results);
  if(!checks.ok)return runtimeStatus("TOOL_PLAN_POSTCONDITION_FAILED",{
   result:"شرط قابل‌آزمایش برنامه برقرار نشد؛ نتیجه به‌عنوان موفق ثبت نمی‌شود.",
   proof:{effectsExecuted:0,checks:checks.checks,
    verifiedReceipts:receipts,ownerSemanticObjectiveIndependentlyProven:false}});
  const output=getAt(results.get(plan.output.step),plan.output.path);
  if(output===undefined||output===null)
   return runtimeStatus("TOOL_FINAL_OUTPUT_MISSING");
  // All physical read receipts must be verified before a model can see
  // their text. A search-result JSON object is DATA, not an owner answer.
  if(receipts.length!==plan.steps.length||receipts.some(x=>!x.resultVerified))
   return runtimeStatus("TOOL_STEPS_NOT_ALL_PROVIDER_VERIFIED");
  // The model already chose a typed final answer before admission.
  // Rana verifies dataflow, checks and receipts, never infers from owner
  // keywords whether another text-generating model step is needed.
  // A model-text task is an ADMITTED TOOL inside this immutable recipe.
  // No hidden post-recipe second-planner or semantic-output state.
  const insufficient=plan.steps.find(step=>step.capabilityId===DEXA_TEXT_WRITER_ID&&
   results.get(step.id)?.status==="INSUFFICIENT");
  if(insufficient)return {state:"OUTCOME_UNKNOWN",
   reason:"DX001_WRITER_INSUFFICIENT",
   result:results.get(insufficient.id).text,
   proof:{effectsExecuted:0,verifiedReceipts:receipts,
    ownerSemanticObjectiveIndependentlyProven:false}};
 
  // Pure retrieval/list/count objectives stay local and finish without
  // a second model call.
  const delivery=deliverTypedAnswer({answer:plan.answer,output,
   format:plan.output.format});
  const text=delivery.text;
  return {state:"SUCCEEDED_VERIFIED",reason:"TYPED_PROVIDER_RESULTS_AND_DATAFLOW_VERIFIED",
   result:text,proof:{
    planSchema:plan.schema,planSteps:plan.steps.length,verifiedReceipts:receipts,
    answerDelivery:delivery.proof,
    finalStep:plan.output.step,finalResultHash:SHA(output),
    providerReadOnlyCalls:receipts.reduce((sum,x)=>
     sum+(x.kind==="TOOL"&&!["WRITE","DESTRUCTIVE","IRREVERSIBLE"].includes(x.effectClass)?(x.fanoutCount||1):0),0),
    pureTransforms:receipts.filter(x=>x.kind==="TRANSFORM").length,
    effectsExecuted:effectCount(),allDependenciesVerified:true,
    ownerSemanticObjectiveIndependentlyProven:false,
    planPostconditionsVerified:true,postconditionReceipts:checks.checks,
    elapsedMs:Date.now()-started
   }};
 }catch(err){return runtimeStatus(String(err?.code||err?.message||"TOOL_OUTPUT_PROJECTION_FAILED"),{
  proof:{effectsExecuted:0,receipts}})}
}
