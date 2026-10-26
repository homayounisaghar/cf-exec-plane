// DX-002 Stage 4. Deterministic owner-control contract; no provider calls,
// semantic routing, guessed handles, or hidden model invocation.
export const CONTROL_SCHEMA = "dexa.mission-control.v1";
export const CONTROL_ACTIONS = Object.freeze(["STATUS","PAUSE_FUTURE","RESUME",
  "MODIFY_FUTURE","STOP_FUTURE","PROVIDER_CANCEL"]);
const ACTION_SET=new Set(CONTROL_ACTIONS);
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TERMINAL=new Set(["SUCCEEDED_VERIFIED","FAILED","BLOCKED",
  "OUTCOME_UNKNOWN","STOPPED_FUTURE","CANCEL_CONFIRMED","CANCEL_REJECTED"]);
export const CONTROL_STOPPED=new Set(["PAUSED","STOPPED_FUTURE"]);
const deny=(reason,extra={})=>Object.freeze({ok:false,reason,...extra});
const verified=r=>r?.status==="SUCCEEDED_VERIFIED"&&r?.resultVerified===true;
export function missionControlStatus(m){
 if(!m||!UUID.test(m.id||""))return deny("CONTROL_MISSION_NOT_FOUND");
 const receipts=Array.isArray(m.stepReceipts)?m.stepReceipts:[];
 const completed=receipts.filter(r=>verified(r)&&r.planVersion===m.planVersion);
 const effects=receipts.filter(r=>verified(r)&&["WRITE","DESTRUCTIVE","IRREVERSIBLE"].includes(r.effectClass));
 const keyed=x=>x?.evidence?.replayedFromReceiptId||x.receiptId;
 return Object.freeze({schema:CONTROL_SCHEMA,missionId:m.id,
  missionVersion:Number(m.version||0),planVersion:Number(m.planVersion||0),
  // Progress events advance missionVersion; only accepted owner controls
  // advance controlVersion. A harmless step receipt cannot stale a pause.
  controlVersion:Number(m.controlVersion||0),
  lastControlId:m.control?.controlId||null,
  lastControlResult:m.control?.lastResult||null,
  state:m.state,controlState:m.control?.state||"NONE",
  logicalState:m.control?.state==="PAUSED"||m.state==="PAUSED"?"PAUSED":
   m.control?.state==="PAUSE_REQUESTED"?"PAUSE_REQUESTED":
   m.control?.state==="STOP_REQUESTED"?"STOP_REQUESTED":
   m.control?.state==="MODIFY_REQUESTED"?"PAUSE_REQUESTED":m.state,
  completedSteps:new Set(completed.map(r=>String(r.planVersion)+":"+String(r.stepId))).size,
  totalSteps:Array.isArray(m.recipe)?m.recipe.length:0,
  currentStepId:m.activeStep?.stepId??null,
  verifiedEffectCount:new Set(effects.map(keyed)).size,
  awaitingProvider:m.state==="WAITING_EXTERNAL",
  awaitingOwner:["WAITING_USER_AUTH","WAITING_USER_DECISION"].includes(m.state),
  uncertain:m.state==="OUTCOME_UNKNOWN"||receipts.some(r=>r.status==="IN_DOUBT")||
   Boolean(m.control?.providerCancelState==="IN_DOUBT"),
  providerCancelState:m.control?.providerCancelState||"NOT_REQUESTED",
  nextStepIndex:Number(m.nextStepIndex||0),
  lastEventVersion:m.events?.at(-1)?.missionVersion??null,
  lastUpdate:m.updatedAt||null,
  lastStatusSummary:m.lastStatusSummary||null,
  providerEffectsNotUndone:true
 });
}
export function admitMissionControl(m,cmd,{
 ownerAuthorized=false,providerCancelVerified=false
}={}){
 if(!ownerAuthorized)return deny("CONTROL_OWNER_UNAUTHORIZED");
 const current=missionControlStatus(m);
 if(current.ok===false)return current;
 if(!cmd||cmd.schema!==CONTROL_SCHEMA||!ACTION_SET.has(cmd.action))
  return deny("CONTROL_ACTION_INVALID");
 if(cmd.missionId!==m.id)return deny("CONTROL_MISSION_MISMATCH");
 if(!Number.isSafeInteger(cmd.expectedVersion)||cmd.expectedVersion<0)
  return deny("CONTROL_VERSION_REQUIRED");
 if(cmd.expectedControlVersion!==undefined){
  if(!Number.isSafeInteger(cmd.expectedControlVersion)||cmd.expectedControlVersion<0)
   return deny("CONTROL_VERSION_REQUIRED");
  if(cmd.expectedControlVersion!==Number(m.controlVersion||0))
   return deny("CONTROL_STALE_CONTROL_VERSION",{
    currentVersion:m.version,currentControlVersion:Number(m.controlVersion||0)});
  if(cmd.expectedVersion>m.version)
   return deny("CONTROL_VERSION_FROM_FUTURE",{currentVersion:m.version});
  if(["MODIFY_FUTURE","PROVIDER_CANCEL"].includes(cmd.action) &&
     (!Number.isSafeInteger(cmd.expectedPlanVersion) ||
      cmd.expectedPlanVersion!==m.planVersion))
   return deny("CONTROL_STALE_PLAN_VERSION",{
    currentVersion:m.version,currentPlanVersion:m.planVersion});
 }else if(cmd.expectedVersion!==m.version){
  // Legacy callers retain strict missionVersion CAS. New owner UI sends
  // controlVersion, which fences concurrent controls, not event telemetry.
  return deny("CONTROL_STALE_VERSION",{currentVersion:m.version});
 }
 if(typeof cmd.controlId!=="string"||!UUID.test(cmd.controlId))
  return deny("CONTROL_ID_REQUIRED");
 if(cmd.action==="STATUS")return Object.freeze({ok:true,action:"STATUS",snapshot:current});
 if(cmd.action==="PROVIDER_CANCEL"){
  if(!providerCancelVerified)return deny("CONTROL_CANCEL_TOOL_UNVERIFIED");
  if(!Number.isSafeInteger(cmd.cancelFromStepId)||cmd.cancelFromStepId<1)
   return deny("CONTROL_CANCEL_STEP_REQUIRED");
  return Object.freeze({ok:true,action:cmd.action,
   requiresProviderDispatchAndReceipt:true,notAutomaticCancellation:true});
 }
 if(TERMINAL.has(m.state))return deny("CONTROL_TERMINAL_MISSION");
 const control=m.control?.state||"NONE";
 if(["PAUSE_REQUESTED","STOP_REQUESTED","MODIFY_REQUESTED","MODIFYING"].includes(control))
  return deny("CONTROL_PREVIOUS_REQUEST_PENDING");
 if(cmd.action==="PAUSE_FUTURE"){
  if(control==="PAUSED")return deny("CONTROL_ALREADY_PAUSED");
  return Object.freeze({ok:true,action:cmd.action,safeBoundaryOnly:true,
   retainsReceipts:true,providerCancellationImplied:false});
 }
 if(cmd.action==="RESUME"){
  if(control!=="PAUSED")return deny("CONTROL_NOT_PAUSED");
  return Object.freeze({ok:true,action:cmd.action,resumeOriginalCheckpoint:true});
 }
 if(cmd.action==="MODIFY_FUTURE"){
  const s=cmd.futureInstruction;
  if(typeof s!=="string"||s.trim().length<3||s.length>1200)
   return deny("CONTROL_FUTURE_INSTRUCTION_REQUIRED");
  if(!Array.isArray(m.recipe)||!m.recipe.length||
     typeof m.recipeRaw!=="string"||!m.recipeRaw.trimStart().startsWith("{"))
   return deny("CONTROL_TYPED_RECIPE_REQUIRED");
  if(m.state==="WAITING_EXTERNAL")return deny("CONTROL_PROVIDER_IN_DOUBT_OR_WAITING");
  return Object.freeze({ok:true,action:cmd.action,
   requiresSameQwenAndStrictPrefix:true,immutableCompletedReceipts:true});
 }
 if(cmd.action==="STOP_FUTURE")return Object.freeze({
  ok:true,action:cmd.action,safeBoundaryOnly:true,
  retainsReceipts:true,providerCancellationImplied:false});
 return deny("CONTROL_ACTION_INVALID");
}
