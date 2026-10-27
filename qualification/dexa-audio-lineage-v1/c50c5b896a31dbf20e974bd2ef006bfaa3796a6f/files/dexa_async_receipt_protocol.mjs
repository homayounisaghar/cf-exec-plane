// Dexa async tool dispatch/receipt protocol v1.
// An ACK/QUEUE is never "completed". Only provider-authenticated terminal
// status with the EXACT persisted request ID and a concrete result may do so.
// This module contains NO intent reasoning, retries, phone commands or secrets.
import {catalogRoute} from "./dexa_catalog_registry.mjs";

export const ASYNC_RECEIPT_PROTOCOL="dexa.async-receipt.v1";
export const REQUEST_ID_RE=/^[A-Za-z0-9_.-]{8,96}$/;
const PENDING=new Set(["QUEUED","ACKNOWLEDGED","ACCEPTED","RUNNING",
 "IN_PROGRESS","PENDING","PROCESSING","STARTED"]);
const COMPLETED=new Set(["COMPLETED","SUCCEEDED","SUCCESS","FINISHED","DONE"]);
const FAILURE=new Set(["FAILED","ERROR","DENIED","REJECTED",
 "CANCELLED","CANCELED","EXPIRED","TIMED_OUT"]);
const err=code=>Object.assign(new Error(code),{code});
const record=x=>x!==null&&typeof x==="object"&&!Array.isArray(x);
const has=(r,key)=>record(r)&&Object.hasOwn(r,key);
function idFrom(value){
 const ids=[];
 if(has(value,"request_id"))ids.push(value.request_id);
 if(has(value,"requestId"))ids.push(value.requestId);
 if(has(value,"command_id"))ids.push(value.command_id);
 if(has(value,"command")&&record(value.command)){
  if(has(value.command,"request_id"))ids.push(value.command.request_id);
  if(has(value.command,"requestId"))ids.push(value.command.requestId);
 }
 if(ids.length===0)return null;
 if(ids.some(x=>typeof x!=="string"||!REQUEST_ID_RE.test(x)))
  throw err("ASYNC_REQUEST_ID_INVALID");
 if(ids.some(x=>x!==ids[0]))throw err("ASYNC_REQUEST_ID_CONFLICT");
 return ids[0];
}
function stateOf(value){
 if(!record(value))return null;
 const statuses=[];
 for(const key of ["status","state"]){
  if(has(value,key)&&typeof value[key]==="string")
   statuses.push(value[key].toUpperCase());
 }
 if(has(value,"command")&&record(value.command)){
  for(const key of ["status","state"]){
   if(typeof value.command[key]==="string")
    statuses.push(value.command[key].toUpperCase());
  }
 }
 if(!statuses.length)return null;
 if(statuses.some(x=>x!==statuses[0]))
  throw err("ASYNC_STATE_CONFLICT");
 return statuses[0];
}
function typeOf(status){
 if(PENDING.has(status))return "PENDING";
 if(COMPLETED.has(status))return "COMPLETED";
 if(FAILURE.has(status))return "FAILED";
 return "UNKNOWN";
}
// Physical adapters are *declarations* for a protocol, not special language
// rules. Additional providers can register a typed status call later.
const AUDIO_BATCH_ID=/^[a-f0-9]{64}$/;
const AUDIO_CAPABILITY="tool.cf.audio_transcribe";
// Existing single CF surface: initial files[] dispatch and batch_id polling.
// All returned transcripts must be independently terminal before Rana may
// release their data to the source-bound writer.
function inspectAudioBatch(result,{expectedBatchId=null}={}){
 if(!record(result)||result.state!=="ACHIEVED"||
    typeof result.batch_id!=="string"||!AUDIO_BATCH_ID.test(result.batch_id))
  throw err("ASYNC_AUDIO_BATCH_RECEIPT_INVALID");
 if(expectedBatchId!==null&&result.batch_id!==expectedBatchId)
  throw err("ASYNC_STATUS_REQUEST_ID_MISMATCH");
 if(typeof result.transcription_pending!=="boolean"||
    !Array.isArray(result.files)||result.files.length>20||
    !Number.isSafeInteger(result.files_total)||result.files_total<1||
    result.files_total>20)
  throw err("ASYNC_AUDIO_BATCH_SHAPE_INVALID");
 const stage=String(result.batch_state||"").toUpperCase();
 if(result.transcription_pending===true){
  if(!["RUNNING","QUEUED","PENDING","PROCESSING"].includes(stage))
   throw err("ASYNC_AUDIO_BATCH_STATE_CONFLICT");
  return Object.freeze({kind:"PENDING",status:"RUNNING",
   requestId:result.batch_id});
 }
 if(stage==="FAILED"||stage==="PARTIAL"||stage==="PARTIALLY_FAILED")
  return Object.freeze({kind:"FAILED",status:"FAILED",
   requestId:result.batch_id,errorCode:"ASYNC_AUDIO_BATCH_INCOMPLETE"});
 if(stage!=="SUCCEEDED"||result.files.length!==result.files_total||
    result.files_succeeded!==result.files_total||
    result.files_failed!==0||
    result.files.some(f=>!record(f)||f.state!=="SUCCEEDED"||
      f.transcript_available!==true||
      typeof f.transcript!=="string"||!f.transcript.trim()))
  throw err("ASYNC_AUDIO_BATCH_TERMINAL_NOT_VERIFIED");
 return Object.freeze({kind:"COMPLETED",status:"SUCCEEDED",
  requestId:result.batch_id,result});
}
const ADAPTERS=Object.freeze([
 Object.freeze({
  id:"CF_AUDIO_TRANSCRIBE_V1",
  statusCapabilityId:AUDIO_CAPABILITY,
  matches:route=>route?.cfName==="audio_transcribe",
  buildStatusArgs:batchId=>({batch_id:batchId})
 }),
 Object.freeze({
  id:"CF_ANDROID_REQUEST_V1",
  statusCapabilityId:"tool.cf.android_command_status",
  matches:route=>Boolean(route?.cfName?.startsWith("android_")&&
   route.cfName!=="android_command_status"),
  buildStatusArgs:requestId=>({request_id:requestId})
 })
]);
export function adapterForCapability(capabilityId){
 const route=catalogRoute(capabilityId);
 if(!route||!route.cfName)return null;
 const adapter=ADAPTERS.find(x=>x.matches(route));
 if(!adapter)return null;
 const statusRoute=catalogRoute(adapter.statusCapabilityId);
 if(!statusRoute?.cfName||!statusRoute.isReadOnly||
    statusRoute.requiresElevation)throw err("ASYNC_STATUS_ADAPTER_NOT_AUTHORIZED");
 return adapter;
}
export function adapterFromCheckpoint({adapterId,originCapabilityId,
 statusCapabilityId}={}){
 const adapter=ADAPTERS.find(x=>x.id===adapterId);
 if(!adapter||adapter.statusCapabilityId!==statusCapabilityId||
    !adapter.matches(catalogRoute(originCapabilityId)))
  throw err("ASYNC_ADAPTER_CHECKPOINT_MISMATCH");
 const route=catalogRoute(statusCapabilityId);
 if(!route?.cfName||!route.isReadOnly||route.requiresElevation)
  throw err("ASYNC_STATUS_ADAPTER_NOT_AUTHORIZED");
 return adapter;
}
export function classifyInitialAsync({capabilityId,result}={}){
 if(!record(result))return {kind:"DIRECT"};
 if(capabilityId===AUDIO_CAPABILITY){
  // Never confuse a batch-admission ACK with a finished transcript.
  const checked=inspectAudioBatch(result);
  if(checked.kind==="PENDING")
   return {...checked,adapterId:"CF_AUDIO_TRANSCRIBE_V1",
    statusCapabilityId:AUDIO_CAPABILITY,originCapabilityId:capabilityId};
  if(checked.kind==="FAILED")return checked;
  return {kind:"DIRECT"}; // verified terminal original result
 }
 const status=stateOf(result);
 const issuedId=idFrom(result);
 const adapter=adapterForCapability(capabilityId);
 // Some asynchronous providers return only request_id/queued=true without a
 // state. That is ALWAYS a dispatch ACK, never the actual tool result.
 const kind=status===null&&issuedId&&adapter?"PENDING":typeOf(status);
 if(kind==="UNKNOWN"&&issuedId&&adapter)throw err("ASYNC_UNKNOWN_ACK_STATE");
 if(kind==="UNKNOWN"||!kind)return {kind:"DIRECT"};
 if(kind==="PENDING"){
  const requestId=idFrom(result);
  if(!requestId)throw err("ASYNC_QUEUED_WITHOUT_REQUEST_ID");
  const adapter=adapterForCapability(capabilityId);
  if(!adapter)throw err("ASYNC_PROVIDER_NOT_BOUND");
  return {kind:"PENDING",status:status||"QUEUED",requestId,
   adapterId:adapter.id,statusCapabilityId:adapter.statusCapabilityId,
   originCapabilityId:capabilityId};
 }
 // Explicit immediate terminal responses may carry a result and request id.
 // Do not mistake unrelated "status" fields for a device receipt.
 if(kind==="COMPLETED"&&adapter&&!issuedId)
  throw err("ASYNC_TERMINAL_CORRELATION_MISSING");
 if(kind==="COMPLETED"&&idFrom(result)){
  const adapter=adapterForCapability(capabilityId);
  if(!adapter)return {kind:"DIRECT"};
  const receipt=classifyTerminalStatus({
   response:result,expectedRequestId:idFrom(result)});
  return {kind:"COMPLETED",status,requestId:idFrom(result),
   result:receipt.result,adapterId:adapter.id,
   statusCapabilityId:adapter.statusCapabilityId};
 }
 if(kind==="FAILED"&&adapter)
  return {kind:"FAILED",status,requestId:issuedId||null};
 return {kind:"DIRECT"};
}
export function classifyTerminalStatus({response,expectedRequestId}={}){
 // This response can only reach us after the persisted, owner-scoped
 // audio batch adapter selects the same CF tool for STATUS, not dispatch.
 if(record(response)&&Object.hasOwn(response,"batch_id")){
  const checked=inspectAudioBatch(response,{expectedBatchId:expectedRequestId});
  return checked.kind==="PENDING"?{kind:"PENDING",status:checked.status}:
   checked.kind==="FAILED"?{kind:"FAILED",status:checked.status,
     errorCode:checked.errorCode}:
   {kind:"COMPLETED",status:"SUCCEEDED",result:checked.result};
 }
 if(typeof expectedRequestId!=="string"||
    !REQUEST_ID_RE.test(expectedRequestId))throw err("ASYNC_REQUEST_ID_INVALID");
 if(!record(response))throw err("ASYNC_STATUS_NOT_OBJECT");
 const observedId=idFrom(response);
 if(!observedId){
  const unavailable=String(response?.error?.code||response?.code||"");
  // This is a GLOBAL status-service failure, not a command-specific receipt.
  // The real Android provider returns this shape when its command service is
  // unavailable. Keep waiting/back off; do not claim the command failed.
  if(["ANDROID_COMMAND_SERVICE_UNAVAILABLE","ANDROID_DEVICE_OFFLINE",
      "ANDROID_COMMAND_STATUS_UNAVAILABLE"].includes(unavailable))
   return Object.freeze({kind:"TRANSPORT_UNAVAILABLE",errorCode:unavailable});
  throw err("ASYNC_STATUS_CORRELATION_MISSING");
 }
 if(observedId!==expectedRequestId)
  throw err("ASYNC_STATUS_REQUEST_ID_MISMATCH");
 const status=stateOf(response);
 if(!status)throw err("ASYNC_STATUS_STATE_MISSING");
 const kind=typeOf(status);
 if(kind==="UNKNOWN")throw err("ASYNC_STATUS_UNKNOWN");
 if(kind==="PENDING")return Object.freeze({kind,status});
 if(kind==="FAILED")return Object.freeze({kind,status,
  errorCode:String(response?.error?.code||
   response?.command?.error?.code||"ASYNC_PROVIDER_OPERATION_FAILED").slice(0,96)});
 // Required real terminal result, not merely "status: succeeded".
 // Empty list or false/0 are legitimate verified values; undefined is not.
 let result;
 if(has(response,"result"))result=response.result;
 else if(has(response,"output"))result=response.output;
 else if(record(response.command)&&has(response.command,"result"))
  result=response.command.result;
 else throw err("ASYNC_TERMINAL_RESULT_MISSING");
 if(result===null||result===undefined)throw err("ASYNC_TERMINAL_RESULT_MISSING");
 if(record(result)&&(
  result.ok===false||result.isError===true||
  typeOf(stateOf(result))==="FAILED"))
  throw err("ASYNC_TERMINAL_RESULT_ERROR");
 return Object.freeze({kind,status,result});
}
export function validateAsyncPendingMetadata({requestId,status,adapterId,
 originCapabilityId,statusCapabilityId}={}){
 if(typeof requestId!=="string"||!REQUEST_ID_RE.test(requestId))
  throw err("ASYNC_REQUEST_ID_INVALID");
 if(!PENDING.has(String(status).toUpperCase()))
  throw err("ASYNC_PENDING_STATE_INVALID");
 adapterFromCheckpoint({adapterId,originCapabilityId,statusCapabilityId});
 return true;
}
export function asyncReceiptAdapters(){
 return ADAPTERS.map(a=>({id:a.id,statusCapabilityId:a.statusCapabilityId}));
}
