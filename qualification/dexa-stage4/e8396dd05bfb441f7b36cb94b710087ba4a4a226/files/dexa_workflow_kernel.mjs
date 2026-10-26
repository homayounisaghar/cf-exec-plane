// Dexa persistent workflow checkpoint kernel. No semantic reasoning.
// Every completed step's ORIGINAL typed result and receipt are committed to a
// 0600 private atomic, fsync'd checkpoint before its completion is announced.
// No model calls, no device commands, no hidden retries. Fail closed on bad
// plan identity / checksum / uncertain non-readonly dispatch.
import fs from "node:fs";
import path from "node:path";
import {createHash,randomUUID} from "node:crypto";
import {validateAsyncPendingMetadata} from "./dexa_async_receipt_protocol.mjs";

export const WORKFLOW_SCHEMA="dexa.workflow-checkpoint.v1";
const MAX_RESULT_BYTES=450000;
const MAX_STEPS=20;
const MAX_EXTERNAL_POLLS=300;
const MAX_EXTERNAL_AGE_MS=24*60*60*1000;
const pollDelayMs=n=>Math.min(5*60*1000,15000*Math.pow(1.6,Math.min(n,8)));
const SHA=value=>createHash("sha256").update(JSON.stringify(value)).digest("hex");
const object=x=>x!==null&&typeof x==="object"&&!Array.isArray(x);
function failure(code){throw Object.assign(new Error(code),{code})}
function uuid(value){
 if(typeof value!=="string"||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value))
  failure("WORKFLOW_MISSION_ID_INVALID");
 return value.toLowerCase();
}
function stringify(data){
 const out=JSON.stringify(data);
 if(typeof out!=="string")failure("WORKFLOW_SERIALIZATION_INVALID");
 return out;
}
async function durableWrite(directory,file,data){
 await fs.promises.mkdir(directory,{recursive:true,mode:0o700});
 await fs.promises.chmod(directory,0o700);
 const raw=stringify(data);
 const temp=file+"."+process.pid+"."+randomUUID()+".tmp";
 const fd=await fs.promises.open(temp,"wx",0o600);
 try{await fd.writeFile(raw+"\n","utf8");await fd.sync()}finally{await fd.close()}
 try{await fs.promises.rename(temp,file);await fs.promises.chmod(file,0o600)}
 catch(e){await fs.promises.rm(temp,{force:true}).catch(()=>{});throw e}
 const d=await fs.promises.open(directory,"r");
 try{await d.sync()}finally{await d.close()}
}
function normalizedStep(entry){
 if(!object(entry)||!Number.isSafeInteger(entry.id)||entry.id<1||
    entry.id>MAX_STEPS||typeof entry.kind!=="string")failure("WORKFLOW_STEP_INVALID");
 return {id:entry.id,kind:entry.kind,hash:SHA(entry)};
}
export function workflowKey({missionId,planVersion,planRaw}){
 const id=uuid(missionId);
 if(!Number.isSafeInteger(planVersion)||planVersion<1||planVersion>100000)
  failure("WORKFLOW_PLAN_VERSION_INVALID");
 if(typeof planRaw!=="string"||planRaw.length<20||planRaw.length>50000)
  failure("WORKFLOW_PLAN_RAW_INVALID");
 return {id,planVersion,planHash:SHA(planRaw)};
}
export async function openWorkflow({
 storeDir,missionId,planVersion,planRaw,steps
}){
 if(typeof storeDir!=="string"||!path.isAbsolute(storeDir))
  failure("WORKFLOW_STORE_DIR_INVALID");
 const identity=workflowKey({missionId,planVersion,planRaw});
 if(!Array.isArray(steps)||steps.length<1||steps.length>MAX_STEPS)
  failure("WORKFLOW_STEPS_INVALID");
 const specs=steps.map(normalizedStep);
 const stepSet=new Set(specs.map(s=>s.id));
 if(stepSet.size!==steps.length)failure("WORKFLOW_STEP_DUPLICATE");
 const dir=path.join(storeDir,identity.id+"-workflow");
 const target=path.join(dir,"v"+planVersion+"-"+identity.planHash.slice(0,24)+".json");
 let state;
 try{
  const raw=await fs.promises.readFile(target,"utf8");
  const parsed=JSON.parse(raw);
  if(!object(parsed)||parsed.schema!==WORKFLOW_SCHEMA||
     parsed.missionId!==identity.id||parsed.planVersion!==identity.planVersion||
     parsed.planHash!==identity.planHash||!object(parsed.entries)||
     !Array.isArray(parsed.steps)||parsed.steps.length!==specs.length||
     parsed.steps.some((v,i)=>v.id!==specs[i].id||v.kind!==specs[i].kind||v.hash!==specs[i].hash))
   failure("WORKFLOW_PLAN_IDENTITY_MISMATCH");
  const {commitHash,...payload}=parsed;
  if(typeof commitHash!=="string"||SHA(payload)!==commitHash)
   failure("WORKFLOW_CHECKPOINT_INTEGRITY_MISMATCH");
  for(const [key,value] of Object.entries(parsed.entries)){
   const index=Number(key);
   const spec=specs.find(s=>s.id===index);
   if(!spec||!object(value)||value.stepHash!==spec.hash ||
      !["DISPATCHED","WAITING_USER","WAITING_EXTERNAL","COMPLETED","IN_DOUBT","EXTERNAL_FAILED","FAILED_VERIFIED","SKIPPED_DEPENDENCY"].includes(value.state))
    failure("WORKFLOW_CHECKPOINT_INTEGRITY_MISMATCH");
   if(["FAILED_VERIFIED","SKIPPED_DEPENDENCY"].includes(value.state)&&
      (typeof value.reasonCode!=="string"||
       !/^[A-Z][A-Z0-9_]{2,119}$/.test(value.reasonCode)))
    failure("WORKFLOW_CHECKPOINT_INTEGRITY_MISMATCH");
   if(value.state==="WAITING_EXTERNAL"){
    if(!value.requestId||!value.adapterId||!value.statusCapabilityId||
       !value.originCapabilityId||value.stepHash!==spec.hash)
     failure("WORKFLOW_EXTERNAL_METADATA_INVALID");
    try{validateAsyncPendingMetadata({...value,status:value.providerStatus})}
    catch{failure("WORKFLOW_EXTERNAL_METADATA_INVALID")}
   }
   if(value.state==="COMPLETED"){
    if(!object(value.receipt)||!Object.hasOwn(value,"result")||
       value.resultHash!==SHA(value.result) ||
       value.receipt.outputDigest!==value.resultHash ||
       value.receipt.stepId!==index||value.receipt.status!=="SUCCEEDED_VERIFIED")
     failure("WORKFLOW_CHECKPOINT_INTEGRITY_MISMATCH");
   }
  }
  state=parsed;
 }catch(e){
  if(e?.code!=="ENOENT")throw e;
  state={
   schema:WORKFLOW_SCHEMA,missionId:identity.id,planVersion,planHash:identity.planHash,
   createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),
   revision:0,steps:specs,entries:{}
  };
  const hashed={...state,commitHash:SHA(state)};
  await durableWrite(dir,target,hashed);
  state=hashed;
 }
 let writeChain=Promise.resolve();
 async function save(){
  const operation=async()=>{
   const {commitHash:old,...payload}=state;
   const next={...payload,revision:payload.revision+1,updatedAt:new Date().toISOString()};
   state={...next,commitHash:SHA(next)};
   await durableWrite(dir,target,state);
  };
  writeChain=writeChain.then(operation,operation);
  return writeChain;
 }
 function entry(step){
  const spec=normalizedStep(step);
  if(!specs.some(x=>x.id===spec.id&&x.hash===spec.hash))
   failure("WORKFLOW_STEP_PLAN_MISMATCH");
  return state.entries[String(step.id)]||null;
 }
 function assertInput(previous,inputHash){
  if(previous&&previous.inputHash&&inputHash&&previous.inputHash!==inputHash)
   failure("WORKFLOW_REPLAY_INPUT_MISMATCH");
 }
 function summary(){
  return Object.freeze({
   schema:WORKFLOW_SCHEMA,planVersion:identity.planVersion,
   planHash:identity.planHash,revision:state.revision,
   completedStepIds:Object.keys(state.entries).filter(id=>state.entries[id].state==="COMPLETED")
    .map(Number).sort((a,b)=>a-b),
   failedStepIds:Object.keys(state.entries).filter(id=>state.entries[id].state==="FAILED_VERIFIED")
    .map(Number).sort((a,b)=>a-b),
   skippedStepIds:Object.keys(state.entries).filter(id=>state.entries[id].state==="SKIPPED_DEPENDENCY")
    .map(Number).sort((a,b)=>a-b),
   waitingStepIds:Object.keys(state.entries).filter(id=>state.entries[id].state==="WAITING_USER")
    .map(Number).sort((a,b)=>a-b),
   inFlightStepIds:Object.keys(state.entries).filter(id=>["DISPATCHED","IN_DOUBT",
    "WAITING_EXTERNAL"].includes(state.entries[id].state)).map(Number).sort((a,b)=>a-b)
  });
 }
 return {
  target,summary,
  get(step){
   const current=entry(step);
   if(!current||current.state!=="COMPLETED")return null;
   return {result:current.result,receipt:current.receipt};
  },
  // A future-only owner amendment may import a completed, byte-identical
  // prefix from the PREVIOUS plan. This is a verified result migration, NOT
  // a second provider dispatch, and it keeps the original checkpoint intact.
  async adoptVerifiedStep(step,{result,receipt,fromPlanVersion}={}){
   if(!Number.isSafeInteger(fromPlanVersion)||fromPlanVersion<1||
      fromPlanVersion>=identity.planVersion)
    failure("WORKFLOW_FORK_SOURCE_VERSION_INVALID");
   const prev=entry(step);
   if(prev)failure("WORKFLOW_FORK_TARGET_NOT_EMPTY");
   if(!object(receipt)||receipt.status!=="SUCCEEDED_VERIFIED"||
      receipt.resultVerified!==true||receipt.stepId!==step.id||
      receipt.outputDigest!==SHA(result))
    failure("WORKFLOW_FORK_SOURCE_RECEIPT_INVALID");
   if(Buffer.byteLength(stringify(result),"utf8")>MAX_RESULT_BYTES)
    failure("WORKFLOW_RESULT_TOO_LARGE");
   const oldReceiptId=String(receipt.receiptId||"");
   if(!oldReceiptId||oldReceiptId.length>256)
    failure("WORKFLOW_FORK_SOURCE_RECEIPT_INVALID");
   const clone={...receipt,receiptId:"v3:fork:"+identity.planVersion+":"+
    SHA({oldReceiptId,stepId:step.id,planHash:identity.planHash}).slice(0,32),
    replayedFromPlanVersion:fromPlanVersion,
    replayedFromReceiptId:oldReceiptId};
   state.entries[String(step.id)]={
    stepHash:normalizedStep(step).hash,state:"COMPLETED",
    inputHash:null,readOnly:receipt.effectClass==="READ",
    result,receipt:clone,resultHash:SHA(result),
    completedAt:receipt.completedAt,attempts:0,
    adoptedFromPlanVersion:fromPlanVersion,
    adoptedFromReceiptId:oldReceiptId
   };
   await save();
   return Object.freeze({result,receipt:clone});
  },
  outcome(step){
   const current=entry(step);
   if(!current||!["FAILED_VERIFIED","SKIPPED_DEPENDENCY"].includes(current.state))return null;
   return Object.freeze({state:current.state,reasonCode:current.reasonCode});
  },
  async recordOutcome(step,{status,reasonCode}={}){
   if(!["FAILED_VERIFIED","SKIPPED_DEPENDENCY"].includes(status)||
      typeof reasonCode!=="string"||!/^[A-Z][A-Z0-9_]{2,119}$/.test(reasonCode))
    failure("WORKFLOW_OPERATION_OUTCOME_INVALID");
   const prev=entry(step);
   if(prev?.state===status&&prev.reasonCode===reasonCode)
    return Object.freeze({state:status,reasonCode});
   if(prev?.state==="COMPLETED"||prev?.state==="IN_DOUBT"||
      prev?.state==="WAITING_EXTERNAL"||prev?.state==="WAITING_USER"||
      prev?.state==="FAILED_VERIFIED"||prev?.state==="SKIPPED_DEPENDENCY"||
      (status==="SKIPPED_DEPENDENCY"&&prev)||
      (prev?.state==="DISPATCHED"&&status!=="FAILED_VERIFIED")||
      (prev?.state==="EXTERNAL_FAILED"&&status!=="FAILED_VERIFIED"))
    failure("WORKFLOW_OPERATION_OUTCOME_CONFLICT");
   state.entries[String(step.id)]={...prev,
    stepHash:normalizedStep(step).hash,state:status,reasonCode,
    readOnly:prev?.readOnly===true,attempts:prev?.attempts||0,
    finishedAt:new Date().toISOString()};
   await save();
   return Object.freeze({state:status,reasonCode});
  },
  async begin(step,{inputHash,readOnly}={}){
   const prev=entry(step);
   assertInput(prev,inputHash);
   if(prev?.state==="COMPLETED")return {state:"COMPLETED",result:prev.result,receipt:prev.receipt};
   if(prev?.state==="WAITING_USER")return {state:"WAITING_USER",gateId:prev.gateId};
   if(prev?.state==="WAITING_EXTERNAL")return {state:"WAITING_EXTERNAL"};
   if(prev?.state==="IN_DOUBT")return {state:"IN_DOUBT"};
   if(["FAILED_VERIFIED","SKIPPED_DEPENDENCY"].includes(prev?.state))
    return {state:prev.state,reasonCode:prev.reasonCode};
   if(prev?.state==="EXTERNAL_FAILED")return {state:"EXTERNAL_FAILED",
    status:prev.providerStatus,errorCode:prev.errorCode};
   // A dispatch without a durable completion receipt might already have
   // executed. A catalog read may queue a phone command or change read-state.
   // Never assume readOnly==idempotent; only pure local transforms are replayable.
   if(prev?.state==="DISPATCHED"&&step.kind==="TOOL"){
    state.entries[String(step.id)]={...prev,state:"IN_DOUBT",updatedAt:new Date().toISOString()};
    await save();
    return {state:"IN_DOUBT"};
   }
   if(step.kind==="TOOL"&&typeof readOnly!=="boolean")
    failure("WORKFLOW_TOOL_EFFECT_CLASS_UNDECLARED");
   // An authenticated owner can execute a write. Durable DISPATCHED is
   // fsync'd BEFORE external effects and is never blindly retransmitted
   // after an uncertain outcome. This is correctness, not an approval gate.
   const now=new Date().toISOString();
   state.entries[String(step.id)]={
    stepHash:normalizedStep(step).hash,state:"DISPATCHED",
    inputHash:inputHash||null,readOnly:readOnly===true,
    dispatchedAt:prev?.dispatchedAt||now,updatedAt:now,
    attempts:Number(prev?.attempts||0)+1
   };
   await save(); // Must precede any actual provider invocation.
   return {state:"READY",attempts:state.entries[String(step.id)].attempts};
  },
  async complete(step,{result,receipt,inputHash}={}){
   const prev=entry(step);
   if(prev?.state==="COMPLETED"){
    if(prev.resultHash!==SHA(result))failure("WORKFLOW_DUPLICATE_RESULT_CONFLICT");
    return {result:prev.result,receipt:prev.receipt};
   }
   if(!prev||!["DISPATCHED","WAITING_USER","WAITING_EXTERNAL"].includes(prev.state))
    failure("WORKFLOW_COMPLETION_WITHOUT_DISPATCH");
   assertInput(prev,inputHash);
   const raw=stringify(result);
   if(Buffer.byteLength(raw,"utf8")>MAX_RESULT_BYTES)
    failure("WORKFLOW_RESULT_TOO_LARGE");
   if(!object(receipt)||receipt.stepId!==step.id||
      receipt.status!=="SUCCEEDED_VERIFIED"||
      receipt.outputDigest!==SHA(result)||receipt.resultVerified!==true)
    failure("WORKFLOW_RECEIPT_NOT_VERIFIED");
   if(prev.state==="WAITING_EXTERNAL"&&(
     receipt.evidenceKind!=="AUTHENTICATED_ASYNC_TERMINAL_RESULT"||
     receipt.asyncRequestIdDigest!==SHA(prev.requestId)||
     receipt.asyncAdapterId!==prev.adapterId||
     receipt.asyncStatusCapabilityId!==prev.statusCapabilityId||
     receipt.asyncTerminalStatus!=="COMPLETED"&&
     receipt.asyncTerminalStatus!=="SUCCEEDED"&&
     receipt.asyncTerminalStatus!=="SUCCESS"&&
     receipt.asyncTerminalStatus!=="FINISHED"&&
     receipt.asyncTerminalStatus!=="DONE"))
     failure("WORKFLOW_EXTERNAL_RECEIPT_UNVERIFIED");
   state.entries[String(step.id)]={
    stepHash:normalizedStep(step).hash,state:"COMPLETED",
    inputHash:inputHash||prev.inputHash||null,readOnly:prev.readOnly,
    result,receipt,resultHash:SHA(result),completedAt:receipt.completedAt,
    attempts:prev.attempts||1
   };
   await save(); // Atomic result+receipt BEFORE notifying main mission store.
   return {result,receipt};
  },
  async waitExternal(step,{requestId,status,adapterId,originCapabilityId,
    statusCapabilityId}={}){
   if(step.kind!=="TOOL")failure("WORKFLOW_EXTERNAL_NOT_TOOL");
   try{validateAsyncPendingMetadata({requestId,status,adapterId,
    originCapabilityId,statusCapabilityId})}
   catch{failure("WORKFLOW_EXTERNAL_CORRELATION_INVALID")}
   if(step.capabilityId!==originCapabilityId)
    failure("WORKFLOW_EXTERNAL_CAPABILITY_MISMATCH");
   const prev=entry(step);
   if(!prev||prev.state!=="DISPATCHED")failure("WORKFLOW_EXTERNAL_NOT_DISPATCHED");
   state.entries[String(step.id)]={...prev,state:"WAITING_EXTERNAL",
    requestId,requestIdHash:SHA(requestId),providerStatus:status,
    adapterId,originCapabilityId,statusCapabilityId,
    queuedAt:new Date().toISOString(),pollCount:0,
    nextPollAt:new Date(Date.now()+15000).toISOString(),
    updatedAt:new Date().toISOString()};
   await save();
   return {state:"WAITING_EXTERNAL"};
  },
  external(step){
   const prev=entry(step);
   if(!prev||prev.state!=="WAITING_EXTERNAL")return null;
   validateAsyncPendingMetadata({...prev,status:prev.providerStatus});
   return Object.freeze({
    requestId:prev.requestId,adapterId:prev.adapterId,
    originCapabilityId:prev.originCapabilityId,
    statusCapabilityId:prev.statusCapabilityId,
    providerStatus:prev.providerStatus,
    queuedAt:prev.queuedAt,nextPollAt:prev.nextPollAt,
    pollCount:prev.pollCount||0
   });
  },
  async noteExternalPoll(step,{status=null,errorCode=null}={}){
   const prev=entry(step);
   if(!prev||prev.state!=="WAITING_EXTERNAL")
    failure("WORKFLOW_EXTERNAL_NOT_WAITING");
   if(status!==null){
    validateAsyncPendingMetadata({...prev,status});
   }
   const count=(prev.pollCount||0)+1;
   const age=Date.now()-Date.parse(prev.queuedAt||prev.updatedAt);
   const exhausted=count>=MAX_EXTERNAL_POLLS||
    !Number.isFinite(age)||age>=MAX_EXTERNAL_AGE_MS;
   state.entries[String(step.id)]={...prev,
    pollCount:count,providerStatus:status||prev.providerStatus,
    lastPollErrorCode:errorCode?String(errorCode).slice(0,96):null,
    nextPollAt:new Date(Date.now()+pollDelayMs(count)).toISOString(),
    updatedAt:new Date().toISOString()};
   if(exhausted){
    state.entries[String(step.id)].state="IN_DOUBT";
    state.entries[String(step.id)].errorCode="WORKFLOW_EXTERNAL_POLL_BUDGET_EXHAUSTED";
   }
   await save();
   return {state:exhausted?"IN_DOUBT":"WAITING_EXTERNAL",
    pollCount:count,nextPollAt:state.entries[String(step.id)].nextPollAt};
  },
  async failExternal(step,{status,errorCode}={}){
   const prev=entry(step);
   if(!prev||prev.state!=="WAITING_EXTERNAL")
    failure("WORKFLOW_EXTERNAL_NOT_WAITING");
   state.entries[String(step.id)]={...prev,state:"EXTERNAL_FAILED",
    providerStatus:String(status||"FAILED").slice(0,48),
    errorCode:String(errorCode||"ASYNC_PROVIDER_OPERATION_FAILED").slice(0,96),
    finishedAt:new Date().toISOString()};
   await save();
   return {state:"EXTERNAL_FAILED",errorCode:state.entries[String(step.id)].errorCode};
  },
  async quarantineExternal(step,{reason}={}){
   const prev=entry(step);
   if(!prev||prev.state!=="WAITING_EXTERNAL")
    failure("WORKFLOW_EXTERNAL_NOT_WAITING");
   state.entries[String(step.id)]={...prev,state:"IN_DOUBT",
    errorCode:String(reason||"ASYNC_STATUS_UNTRUSTWORTHY").slice(0,96),
    updatedAt:new Date().toISOString()};
   await save();
   return {state:"IN_DOUBT"};
  },
  async waitForOwner(step){
   const prev=entry(step);
   if(step.kind!=="USER_GATE")failure("WORKFLOW_NOT_USER_GATE");
   if(prev?.state==="COMPLETED")return {state:"COMPLETED",receipt:prev.receipt,result:prev.result};
   const gateId=SHA(identity.planHash+"|"+identity.id+"|"+step.id+"|"+
    normalizedStep(step).hash).slice(0,40);
   if(prev?.state==="WAITING_USER"){
    if(prev.gateId!==gateId)failure("WORKFLOW_GATE_ID_MISMATCH");
    return {state:"WAITING_USER",gateId};
   }
   if(prev)failure("WORKFLOW_GATE_STATE_CONFLICT");
   state.entries[String(step.id)]={
    stepHash:normalizedStep(step).hash,state:"WAITING_USER",gateId,
    readOnly:true,inputHash:null,attempts:0,requestedAt:new Date().toISOString()
   };
   await save();
   return {state:"WAITING_USER",gateId};
  },
  async acceptOwnerAnswer(step,{gateId,message}={}){
   if(step.kind!=="USER_GATE")failure("WORKFLOW_NOT_USER_GATE");
   if(typeof message!=="string"||!message.trim()||message.length>1200)
    failure("WORKFLOW_OWNER_ANSWER_INVALID");
   const prev=entry(step);
   if(!prev||prev.gateId!==gateId)
    failure("WORKFLOW_GATE_NOT_WAITING");
   const result={answer:message.trim()};
   // A crash may occur after the private answer+receipt were committed but
   // before the main mission JSON changed. The SAME answer is safe to accept
   // again; a different answer must not overwrite it.
   if(prev.state==="COMPLETED"){
    if(prev.resultHash!==SHA(result))failure("WORKFLOW_GATE_ANSWER_CONFLICT");
    return {result:prev.result,receipt:prev.receipt,replayed:true};
   }
   if(prev.state!=="WAITING_USER")failure("WORKFLOW_GATE_NOT_WAITING");
   const at=new Date().toISOString();
   const receipt=Object.freeze({
    receiptId:"v3:"+step.id+":"+SHA({missionId:identity.id,stepId:step.id,
     planHash:identity.planHash,gateId,resultHash:SHA(result)}).slice(0,24),
    stepId:step.id,kind:"USER_GATE",capabilityId:"USER",
    physicalTool:null,sourceStep:null,
    inputDigest:SHA({gateId,answer:result.answer}),
    outputDigest:SHA(result),evidenceKind:"EXPLICIT_OWNER_GATE_RESPONSE",
    providerDurationMs:null,startedAt:prev.requestedAt,completedAt:at,
    status:"SUCCEEDED_VERIFIED",resultVerified:true
   });
   // Persist user answer and durable receipt as one checkpoint transaction.
   // Do not put the raw answer into the UI/public mission receipt.
   const raw=stringify(result);
   if(Buffer.byteLength(raw,"utf8")>MAX_RESULT_BYTES)failure("WORKFLOW_RESULT_TOO_LARGE");
   state.entries[String(step.id)]={...prev,state:"COMPLETED",result,
    receipt,resultHash:SHA(result),completedAt:at};
   await save();
   return {result,receipt};
  }
 };
}
