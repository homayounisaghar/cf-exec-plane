// Stage 5 source lineage shared by writer, web and future typed provider readers.
// A source's provenance is bound to completed Rana receipts, not to
// model-authored strings or provider-specific field-name guesses.
import {createHash} from "node:crypto";
export const DEXA_WRITER_SOURCE_SCHEMA="dexa.verified-writer-source.v1";
const hash=x=>createHash("sha256").update(JSON.stringify(x)).digest("hex");
const bad=code=>{throw Object.assign(new Error(code),{code})};
const isObject=x=>x&&typeof x==="object"&&!Array.isArray(x);
// Inspect the ORIGINAL verified provider envelope, not the projected
// caption string, so a model cannot conceal that attached media was never
// extracted merely by selecting ["messages",0,"text"].
const mediaBearing=row=>{
 if(!isObject(row))return false;
 const kind=String(row.media_open_kind||row.media_type||row.type||"").toLowerCase();
 if(["voice","audio","video"].includes(kind))return true;
 if(/^(audio|video)\//i.test(String(row.mime_type||"")))return true;
 return Array.isArray(row.attachments)&&row.attachments.some(a=>isObject(a)&&(
  /^(audio|video)\//i.test(String(a.mime_type||a.media_type||""))||
  ["voice","audio","video"].includes(String(a.kind||a.type||"").toLowerCase())));
};
function mediaInProviderEnvelope(value,depth=0){
 if(depth>4||!value||typeof value!=="object")return false;
 if(Array.isArray(value))return value.slice(0,50).some(x=>mediaInProviderEnvelope(x,depth+1));
 if(mediaBearing(value))return true;
 // Only documented provider collection keys; never inspect arbitrary text
 // or unrelated nested objects as untrusted instructions.
 return ["messages","records","items","results"].some(k=>
  Array.isArray(value[k])&&mediaInProviderEnvelope(value[k],depth+1));
}
function readPath(value,path){
 if(!Array.isArray(path))return undefined;
 return path.reduce((v,key)=>v!=null?Object.hasOwn(Object(v),key)?v[key]:undefined:undefined,value);
}
function selectedRecordHasUnextractedMedia(ref,byId,results){
 if(!(results instanceof Map)||!ref)return false;
 const current=byId.get(ref.step);
 if(!current)return false;
 const path=ref.path||[];
 const point=readPath(results.get(ref.step),
  ["text","body","content","snippet","description","caption"].includes(path.at(-1))?
   path.slice(0,-1):path);
 if(mediaInProviderEnvelope(point))return true;
 // If the typed transform picked a scalar caption, inspect its immediate
 // source record (already verified by a previous committed Rana receipt).
 if(current.kind==="TRANSFORM"&&current.op==="PICK"){
  const parent=readPath(results.get(current.source?.step),current.source?.path||[]);
  return mediaInProviderEnvelope(parent);
 }
 return false;
}
export function sourceLineageForWriter({
 writerStep,steps,receipts,sourceValue,originResults=null
}={}){
 const ref=writerStep?.args?.source?.$ref;
 if(!Number.isSafeInteger(ref?.step)||ref.step<1||!Array.isArray(ref.path)||
    !Array.isArray(steps)||!Array.isArray(receipts)||
    sourceValue===undefined)
  bad("DX005_WRITER_SOURCE_REFERENCE_REQUIRED");
 const byId=new Map(steps.map(s=>[s.id,s]));
 let producer=byId.get(ref.step),depth=0;
 const chain=[];
 while(producer&&producer.kind==="TRANSFORM"){
  if(++depth>18||chain.includes(producer.id))
   bad("DX005_WRITER_SOURCE_CHAIN_INVALID");
  chain.push(producer.id);producer=byId.get(producer.source?.step);
 }
 const origin=producer?.id;
 if(writerStep?.args?.operation==="summarize"&&
    originResults instanceof Map&&
    selectedRecordHasUnextractedMedia(ref,byId,originResults)&&
    producer?.capabilityId!=="tool.cf.audio_transcribe")
  bad("DX005_WRITER_MEDIA_SOURCE_REQUIRES_CONTENT");
 if(!Number.isSafeInteger(origin)||producer?.kind!=="TOOL"||
    producer.capabilityId==="dexa.text.process")
  bad("DX005_WRITER_SOURCE_ORIGIN_UNVERIFIED");
 for(const id of [...chain,origin]){
  const r=receipts.find(x=>x.stepId===id);
  if(!r||r.status!=="SUCCEEDED_VERIFIED"||r.resultVerified!==true)
   bad("DX005_WRITER_SOURCE_RECEIPT_MISSING");
 }
 const receipt=receipts.find(x=>x.stepId===origin);
 if(typeof receipt.receiptId!=="string"||!receipt.receiptId||
    typeof receipt.physicalTool!=="string"||!receipt.physicalTool)
  bad("DX005_WRITER_SOURCE_PROOF_INVALID");
 const isWeb=producer.capabilityId==="web.search"||producer.capabilityId==="web.read";
 const readAt=receipt.completedAt;
 if(typeof readAt!=="string"||!Number.isFinite(Date.parse(readAt)))
  bad("DX005_WRITER_SOURCE_RECEIPT_TIME_INVALID");
 const sourceTrust=isWeb?"UNTRUSTED_PUBLIC_WEB_DATA":
  "AUTHENTICATED_PROVIDER_CONTENT_NOT_INSTRUCTIONS";
 return Object.freeze({
  schema:DEXA_WRITER_SOURCE_SCHEMA,
  sourceVerification:"SOURCE_VERIFIED",
  sourceTrust,
  sourceStepId:ref.step,
  originStepId:origin,
  originCapabilityId:producer.capabilityId,
  sourcePath:[...ref.path],
  provider:receipt.physicalTool,
  providerTool:receipt.physicalTool,
  providerReceiptId:receipt.receiptId,
  readAt,
  contentDigest:hash(sourceValue),
  contentBytes:Buffer.byteLength(JSON.stringify(sourceValue),"utf8")
 });
}
export function validateWriterSourceLineage(provenance,sourceValue){
 if(!isObject(provenance)||provenance.schema!==DEXA_WRITER_SOURCE_SCHEMA||
    provenance.sourceVerification!=="SOURCE_VERIFIED"||
    !Number.isSafeInteger(provenance.sourceStepId)||
    !Number.isSafeInteger(provenance.originStepId)||
    typeof provenance.providerReceiptId!=="string"||
    provenance.providerReceiptId.length<3||
    !Number.isSafeInteger(provenance.contentBytes)||provenance.contentBytes<0||
    provenance.contentBytes>1048576||
    provenance.contentDigest!==hash(sourceValue))
  bad("DX005_WRITER_SOURCE_LINEAGE_INVALID");
 return provenance;
}
