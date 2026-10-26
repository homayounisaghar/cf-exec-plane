// Safe future-only change: never rewrite completed provider observations,
// mutate historic source plans, or execute a guessed recipient.
import {parseTypedPlan} from "./dexa_tool_plan_v3.mjs";
import {validateGenericPlanContract} from "./dexa_general_plan_contract_v1.mjs";
import {openWorkflow} from "./dexa_workflow_kernel.mjs";
import {createHash} from "node:crypto";
const hash=s=>createHash("sha256").update(s).digest("hex");
const fail=code=>{throw Object.assign(new Error(code),{code})};
export function verifyFutureOnlyCandidate({
 priorSteps,candidateRaw,allowed,completedStepIds=[],inFlightStepIds=[]
}={}){
 if(inFlightStepIds.length)fail("CONTROL_FUTURE_IN_FLIGHT");
 if(!Array.isArray(priorSteps)||!Array.isArray(completedStepIds)||
    typeof candidateRaw!=="string"||candidateRaw.length>35000)
  fail("CONTROL_FUTURE_INVALID_INPUT");
 const validated=validateGenericPlanContract(candidateRaw,allowed);
 const plan=validated.typed;
 if(plan.status||!Array.isArray(plan.steps))fail("CONTROL_FUTURE_PLAN_NOT_EXECUTABLE");
 const completed=new Set(completedStepIds);
 // A completed result is immutable; a provider step may not be pulled
 // before it, reordered, re-parameterized or silently removed.
 for(const id of completed){
  const old=priorSteps.find(s=>s.id===id);
  const next=plan.steps.find(s=>s.id===id);
  if(!old||!next||JSON.stringify(old)!==JSON.stringify(next))
   fail("CONTROL_COMPLETED_STEP_MUTATION");
 }
 const prefix=[];
 for(const step of priorSteps){
  if(!completed.has(step.id))break;
  prefix.push(step);
 }
 if(completed.size!==prefix.length)
  fail("CONTROL_NONPREFIX_COMPLETION_NOT_FORKABLE");
 if(prefix.length===priorSteps.length)
  fail("CONTROL_NO_FUTURE_STEPS");
 // Future steps must not be silently selected with a different/independent
 // original source step ID before the finished prefix.
 if(plan.steps.length<=prefix.length)
  fail("CONTROL_FUTURE_PLAN_EMPTY");
 if(plan.steps.some((s,i)=>s.id!==i+1))
  fail("CONTROL_FUTURE_STEP_IDS_INVALID");
 return Object.freeze({raw:validated.raw,steps:plan.steps,
  completedPrefix:prefix.length,
  candidateHash:hash(validated.raw),
  finalStep:plan.output.step});
}
export async function forkVerifiedFutureWorkflow({
 storeDir,missionId,previousVersion,previousRaw,previousSteps,
 nextVersion,nextRaw,nextSteps,completedPrefix
}={}){
 if(!Number.isSafeInteger(previousVersion)||previousVersion<1||
    nextVersion!==previousVersion+1||!Number.isSafeInteger(completedPrefix)||
    completedPrefix<0)fail("CONTROL_FORK_VERSION_INVALID");
 const old=await openWorkflow({storeDir,missionId,
  planVersion:previousVersion,planRaw:previousRaw,steps:previousSteps});
 if(old.summary().inFlightStepIds.length)
  fail("CONTROL_FORK_OLD_DISPATCH_UNCERTAIN");
 const next=await openWorkflow({storeDir,missionId,
  planVersion:nextVersion,planRaw:nextRaw,steps:nextSteps});
 if(next.summary().completedStepIds.length)
  fail("CONTROL_FORK_TARGET_ALREADY_COMMITTED");
 const lineage=[];
 for(let i=0;i<completedPrefix;i++){
  const step=previousSteps[i], other=nextSteps[i];
  if(!other||JSON.stringify(step)!==JSON.stringify(other))
   fail("CONTROL_COMPLETED_STEP_MUTATION");
  const entry=old.get(step);
  if(!entry||entry.receipt?.status!=="SUCCEEDED_VERIFIED"||
     entry.receipt?.resultVerified!==true)
   fail("CONTROL_FORK_MISSING_VERIFIED_CHECKPOINT");
  const adopted=await next.adoptVerifiedStep(other,{
   result:entry.result,receipt:entry.receipt,fromPlanVersion:previousVersion});
  lineage.push({stepId:step.id,sourceReceiptId:entry.receipt.receiptId,
   adoptedReceiptId:adopted.receipt.receiptId});
 }
 return {completedPrefix,lineage,newCheckpoint:next.summary()};
}
