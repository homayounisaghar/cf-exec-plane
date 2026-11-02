// DX-003 exact-owner-visible memory as an executable local Rana READ.
// The planner sees opaque scoped ref IDs; only this adapter resolves text
// from persisted, successfully verified exchanges in the SAME browser scope.
import {createHash} from 'node:crypto';
import {DUAL_MEMORY_SCHEMA,resolveDeepExchange} from './dexa_dual_memory_v1.mjs';
import {validateDexaRef} from './dexa_resource_refs_v1.mjs';
export const DEXA_MEMORY_READ_ID='dexa.memory.read';
export const DEXA_MEMORY_READ_ROUTE='dexa_memory_read';
export const DEXA_MEMORY_READ_INPUT_SCHEMA=Object.freeze({
 type:'object',additionalProperties:false,required:['refId'],
 properties:{refId:{type:'string',minLength:8,maxLength:191}}
});
const err=code=>{throw Object.assign(new Error(code),{code})};
const sha=t=>createHash('sha256').update(t).digest('hex');
export function readVerifiedDexaMemory({refId,snapshot,missions,scopeHash,at=Date.now()}={}){
 if(snapshot?.schema!==DUAL_MEMORY_SCHEMA||typeof scopeHash!=='string'||
    !scopeHash||snapshot.scopeHash!==scopeHash)
  err('DX003_MEMORY_READ_SCOPE_DENIED');
 if(typeof refId!=='string'||!refId)err('DX003_MEMORY_REF_REQUIRED');
 const authorized=(snapshot.refs||[]).filter(r=>r.id===refId&&
  r.source==='dexa.memory'&&r.kind==='ResourceRef'&&
  r.resourceKind==='conversation_answer');
 if(authorized.length!==1)err('DX003_MEMORY_REF_NOT_ADMITTED');
 const ref=validateDexaRef(authorized[0],{
  ownerId:scopeHash,sessionId:scopeHash,at
 });
 const summary=(snapshot.summaries||[]).find(s=>s.exchangeId===ref.exchangeId);
 if(!summary||summary.status!=='SUCCEEDED_VERIFIED'||
    summary.replyAvailable!==true||summary.replyRefId!==refId)
  err('DX003_MEMORY_REPLY_NOT_VERIFIED');
 // The durable mission itself, not a prompt note, is the status authority.
 const stableMissionList=[...missions];
 const completed=stableMissionList.map(e=>Array.isArray(e)?e[1]:e).filter(e=>
  e?.id===ref.exchangeId&&e?.context?.scopeHash===scopeHash);
 if(completed.length!==1||completed[0].state!=='SUCCEEDED_VERIFIED')
  err('DX003_MEMORY_ORIGIN_NOT_SUCCEEDED_VERIFIED');
 const displayed=resolveDeepExchange({snapshot,missions:stableMissionList,scopeHash,
  exchangeId:ref.exchangeId,part:'assistant_reply',
  maxBytes:Math.min(65536,ref.limits.maxBytes)});
 if(displayed.digest!==ref.version||displayed.exchangeId!==ref.nativeId||
    sha(displayed.text)!==ref.version)
  err('DX003_MEMORY_REPLY_VERSION_MISMATCH');
 return Object.freeze({
  schema:'dexa.memory-read.v1',text:displayed.text,
  exchangeId:displayed.exchangeId,refId,
  digest:displayed.digest,
  sourceVerification:'VERIFIED_PRIOR_OWNER_VISIBLE_REPLY'
 });
}
