// Provider-neutral cancellation eligibility is derived from an actual
// VERIFIED original workflow result and the same bound tool's typed input
// contract. An arbitrary cancel-looking catalog card is never authority.
import {catalogRoute,inputSchemaFor,admitCatalogCall} from "./dexa_catalog_registry.mjs";
import {openWorkflow} from "./dexa_workflow_kernel.mjs";
import {createHash} from "node:crypto";
const hash=x=>createHash("sha256").update(JSON.stringify(x)).digest("hex");
const bad=code=>{throw Object.assign(new Error(code),{code})};
// Standard authenticated catalog envelope: unwrap only for same native tool.
function resultObject(value,expectedTool=null){
 if(!value||typeof value!=="object"||Array.isArray(value))return null;
 if(value.state==="ACHIEVED"&&value.tool===expectedTool&&
    value.result&&typeof value.result==="object"&&!Array.isArray(value.result))
  return value.result;
 return value;
}
function matchesSchema(value,schema){
 if(typeof value!=="string"||!value||value.length>256)return false;
 if(schema.type&&schema.type!=="string")return false;
 if(schema.pattern){
  try{if(!new RegExp(schema.pattern).test(value))return false}catch{return false}
 }
 return true;
}
export async function deriveCancellationFromVerifiedWorkflow({
 mission,storeDir,sourceStepId
}={}){
 if(!Number.isSafeInteger(sourceStepId)||sourceStepId<1)bad("CONTROL_CANCEL_STEP_REQUIRED");
 const plan=(mission?.plans||[]).find(x=>x.planVersion===mission.planVersion);
 const step=mission?.recipe?.find(s=>s.id===sourceStepId);
 if(!plan||!step||step.kind!=="TOOL"||typeof mission.recipeRaw!=="string")
  bad("CONTROL_CANCEL_ORIGINAL_PLAN_UNAVAILABLE");
 const original=(mission.stepReceipts||[]).find(r=>r.planVersion===mission.planVersion&&
  r.stepId===sourceStepId&&r.status==="SUCCEEDED_VERIFIED"&&r.resultVerified===true);
 if(!original||!["WRITE","DESTRUCTIVE","IRREVERSIBLE"].includes(original.effectClass)||
    original.evidence?.effectProof?.outcome!=="PROVIDER_REPORTED_SUCCEEDED")
  bad("CONTROL_CANCEL_ORIGINAL_EFFECT_UNVERIFIED");
 const route=catalogRoute(step.capabilityId);
 const schema=inputSchemaFor(step.capabilityId);
 if(!route?.cfName||!schema?.properties?.action?.enum?.includes("cancel")||
    !schema?.properties?.action?.enum?.includes(step.args?.action)||
    step.args.action==="cancel")
  bad("CONTROL_CANCEL_NATIVE_OPERATION_UNBOUND");
 const workflow=await openWorkflow({storeDir,missionId:mission.id,
  planVersion:mission.planVersion,planRaw:mission.recipeRaw,steps:mission.recipe});
 const committed=workflow.get(step);
 if(!committed||committed.receipt?.status!=="SUCCEEDED_VERIFIED"||
    committed.receipt?.outputDigest!==original.evidence?.outputDigest)
  bad("CONTROL_CANCEL_PROVIDER_RESULT_NOT_CHECKPOINTED");
 const result=resultObject(committed.result,route.cfName);
 if(!result)bad("CONTROL_CANCEL_ORIGINAL_RESULT_INVALID");
 // Select exactly ONE native schema-declared identifier that appears with
 // the identical field name in the actual provider result. Never use a
 // model-supplied contact, guessed handle, filename, or prior display text.
 const idCandidates=Object.entries(schema.properties)
  .filter(([name,node])=>name.endsWith("_id")&&
   matchesSchema(result[name],node))
  .map(([name])=>name);
 if(idCandidates.length!==1)bad("CONTROL_CANCEL_PROVIDER_ID_NOT_UNIQUE");
 const idField=idCandidates[0];
 const args={action:"cancel",[idField]:result[idField]};
 const admitted=admitCatalogCall({capabilityId:step.capabilityId,args,
  readOnlyOnly:false});
 if(admitted?.tool!==route.cfName)
  bad("CONTROL_CANCEL_PROVIDER_TOOL_IDENTITY_MISMATCH");
 const planRaw=JSON.stringify({schema:"dexa.tool-plan.v3",
  steps:[{id:1,kind:"TOOL",capabilityId:step.capabilityId,args,deps:[]}],
  checks:[{step:1,path:[],op:"exists"}],
  output:{step:1,path:[],format:"json"},answer:{kind:"json"}});
 return Object.freeze({
  capabilityId:step.capabilityId,sourceStepId,
  providerTool:route.cfName,sourceReceiptId:original.receiptId,
  operationIdDigest:hash({tool:route.cfName,idField,value:result[idField]}),
  planRaw,planVersion:1,
  outputExpected:"TERMINAL_PROVIDER_CANCEL",
  sourcePlanVersion:mission.planVersion
 });
}
export function verifiedProviderCancellationResult({
 execution,committed,physicalTool
}={}){
 if(execution?.state!=="SUCCEEDED_VERIFIED"||
    !committed||committed.receipt?.resultVerified!==true||
    committed.receipt?.physicalTool!==physicalTool||
    committed.receipt?.effectProof?.outcome!=="PROVIDER_REPORTED_SUCCEEDED")
  return {state:"IN_DOUBT",reason:"CONTROL_CANCEL_PROVIDER_EFFECT_UNVERIFIED"};
 const result=resultObject(committed.result,physicalTool);
 if(!result)return {state:"IN_DOUBT",reason:"CONTROL_CANCEL_RESULT_MISSING"};
 if(["QUEUED","RUNNING","PENDING","ACKNOWLEDGED"].includes(
     String(result.state||result.status||"").toUpperCase()))
  return {state:"CANCEL_REQUESTED",reason:"CONTROL_CANCEL_PROVIDER_PENDING"};
 if(result.cancelled===true||result.canceled===true||
    ["CANCELLED","CANCELED"].includes(String(result.state||result.status||"").toUpperCase()))
  return {state:"CANCEL_CONFIRMED",reason:"CONTROL_CANCEL_PROVIDER_CONFIRMED"};
 if(result.ok===false||["REJECTED","FAILED"].includes(
     String(result.state||result.status||"").toUpperCase()))
  return {state:"CANCEL_REJECTED",reason:"CONTROL_CANCEL_PROVIDER_REJECTED"};
 // Gateway dispatch ACHIEVED alone is not evidence that the order/file
 // itself was cancelled. Fail closed on an ambiguous terminal body.
 return {state:"IN_DOUBT",reason:"CONTROL_CANCEL_STATUS_NOT_PROVEN"};
}
