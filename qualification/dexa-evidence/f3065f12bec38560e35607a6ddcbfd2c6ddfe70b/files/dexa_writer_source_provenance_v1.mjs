// Stage 5 source lineage shared by writer, web and future typed provider readers.
// A source's provenance is bound to completed Rana receipts, not to
// model-authored strings or provider-specific field-name guesses.
import {createHash} from "node:crypto";
export const DEXA_WRITER_SOURCE_SCHEMA="dexa.verified-writer-source.v1";
const hash=x=>createHash("sha256").update(JSON.stringify(x)).digest("hex");
const bad=code=>{throw Object.assign(new Error(code),{code})};
const isObject=x=>x&&typeof x==="object"&&!Array.isArray(x);
export function sourceLineageForWriter({writerStep,steps,receipts,sourceValue}={}){
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
 const isWeb=["web.search","web.read","web.evidence"].includes(producer.capabilityId);
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
