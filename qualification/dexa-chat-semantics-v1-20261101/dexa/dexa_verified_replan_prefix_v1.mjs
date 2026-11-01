// Reuse an exact, recently verified, read-only plan prefix on model replan.
// No global cache, no provider writes, no guess from a previous conversation.
import {openWorkflow} from "./dexa_workflow_kernel.mjs";
import {catalogRoute} from "./dexa_catalog_registry.mjs";

const MAX_AGE_MS=20000;
const hasEffect=mission=>(mission.stepReceipts||[]).some(r=>
 r.status==="SUCCEEDED_VERIFIED"&&
 ["WRITE","DESTRUCTIVE","IRREVERSIBLE"].includes(r.effectClass));
const identical=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const fresh=receipt=>{
 const ms=Date.parse(receipt?.completedAt||"");
 const age=Date.now()-ms;
 return Number.isFinite(age)&&age>=0&&age<=MAX_AGE_MS;
};
const safeRead=(step,result,receipt)=>{
 if(step.kind!=="TOOL"||receipt.effectClass!=="READ")return false;
 const route=catalogRoute(step.capabilityId);
 return route?.isReadOnly===true &&
  result?.read_state_changed===false &&
  result?.provider_visible_state_changed!==true &&
  ["ACHIEVED","SUCCEEDED","COMPLETED"].includes(result?.state);
};

export async function adoptRecentVerifiedReplanPrefix({
 mission,steps,workflow,workflowStoreDir
}={}){
 if(!mission||!workflow||!Array.isArray(steps)||
    !Number.isSafeInteger(mission.planVersion)||mission.planVersion<2||
    !workflowStoreDir||hasEffect(mission))return 0;
 const prev=(mission.plans||[]).find(p=>
  p.planVersion===mission.planVersion-1);
 if(!prev||!Array.isArray(prev.steps)||typeof prev.rawRecipe!=="string")
  return 0;
 if(workflow.summary().inFlightStepIds.length)return 0;
 const old=await openWorkflow({storeDir:workflowStoreDir,
  missionId:mission.id,planVersion:prev.planVersion,
  planRaw:prev.rawRecipe,steps:prev.steps});
 if(old.summary().inFlightStepIds.length)return 0;
 let reused=0;
 for(let i=0;i<Math.min(steps.length,prev.steps.length);i++){
  const from=prev.steps[i],to=steps[i];
  if(!identical(from,to))break;
  const entry=old.get(from);
  if(!entry||entry.receipt?.status!=="SUCCEEDED_VERIFIED"||
     entry.receipt?.resultVerified!==true||!fresh(entry.receipt))break;
  if(from.kind==="TOOL"&&!safeRead(from,entry.result,entry.receipt))break;
  if(!["TOOL","TRANSFORM"].includes(from.kind))break;
  if(to.kind==="TRANSFORM"&&
     entry.receipt.effectClass!=="PURE_LOCAL")break;
  if(!workflow.get(to)){
   await workflow.adoptVerifiedStep(to,{result:entry.result,
    receipt:entry.receipt,fromPlanVersion:prev.planVersion});
  }
  reused++;
 }
 return reused;
}
