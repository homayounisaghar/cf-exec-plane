import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {issueDexaRef} from './dexa_resource_refs_v1.mjs';
import {readVerifiedDexaMemory} from './dexa_memory_read_v1.mjs';
import {validateGenericPlanContract} from './dexa_general_plan_contract_v1.mjs';
import {executeTypedPlan} from './dexa_tool_plan_executor_v3.mjs';
import {prepareTextWriter,verifyTextWriterReply,validateWriterPlanStep} from './dexa_text_writer_v1.mjs';
import {prepareFastGeneralPlan} from './dexa_general_plan_cycle_v2.mjs';

const sha=s=>createHash('sha256').update(s).digest('hex');
const scope='stable-owner-session-demo';
const olderId='aa6d38cc-77e2-4a6d-b865-a675b4d1ab6e';
const reply='Peter wrote: I will send you the document tomorrow.';
function fixture(){
 const ref=issueDexaRef({kind:'ResourceRef',resourceKind:'conversation_answer',
 source:'dexa.memory',provider:'dexa',ownerId:scope,sessionId:scope,
 nativeId:olderId,version:sha(reply),exchangeId:olderId,
 issuer:'dexa.owner-visible-result.v1',
 verifiedPayload:{id:olderId,visible:reply,version:3},
 maxBytes:65536,ttlMs:86400000});
 const old={id:olderId,context:{scopeHash:scope},text:'What did Peter say?',
 state:'SUCCEEDED_VERIFIED',displayedReplyExact:reply};
 const snapshot={schema:'dexa.dual-exchange-memory.v1',scopeHash:scope,
 activeExchangeIds:[olderId],refs:[ref],summaries:[
  {exchangeId:olderId,user:'What did Peter say?',reply:'Peter wrote...',
   status:'SUCCEEDED_VERIFIED',replyAvailable:true,replyRefId:ref.id}
 ]};
 return {ref,old,snapshot};
}
const ownerGoal='به فارسی ترجمه‌ش کن';
function plan(refId){
 return {schema:'dexa.tool-plan.v3',steps:[
  {id:1,kind:'TOOL',capabilityId:'dexa.memory.read',
   args:{refId},deps:[]},
  {id:2,kind:'TOOL',capabilityId:'dexa.text.process',
   args:{operation:'translate',language:'فارسی',
    source:{$ref:{step:1,path:['text']}},
    instruction:'متن پاسخ قبلی را به فارسی روان و وفادار به معنا ترجمه کن'},
   deps:[1]}
 ],checks:[{step:2,path:['text'],op:'non_empty'}],
 output:{step:2,path:['text'],format:'text'},answer:{kind:'text'}};
}
test('exact previous reply is read under pinned scope and proof',()=>{
 const {ref,old,snapshot}=fixture();
 const x=readVerifiedDexaMemory({refId:ref.id,snapshot,missions:[old],scopeHash:scope});
 assert.equal(x.text,reply);
 assert.equal(x.exchangeId,old.id);
 assert.equal(x.digest,sha(reply));
 assert.equal(x.sourceVerification,'VERIFIED_PRIOR_OWNER_VISIBLE_REPLY');
});
test('cross-scope and forged memory references fail closed',()=>{
 const {ref,old,snapshot}=fixture();
 assert.throws(()=>readVerifiedDexaMemory({
  refId:ref.id,snapshot,missions:[old],scopeHash:'another-owner-session'}),
  {code:'DX003_MEMORY_READ_SCOPE_DENIED'});
 assert.throws(()=>readVerifiedDexaMemory({
  refId:'not-a-issued-ref',snapshot,missions:[old],scopeHash:scope}),
  {code:'DX003_MEMORY_REF_NOT_ADMITTED'});
});
test('failed previous answer cannot become writer source',()=>{
 const {ref,old,snapshot}=fixture();snapshot.summaries[0].status='FAILED';
 assert.throws(()=>readVerifiedDexaMemory({
  refId:ref.id,snapshot,missions:[old],scopeHash:scope}),
  {code:'DX003_MEMORY_REPLY_NOT_VERIFIED'});
});
test('tampered persisted previous reply is rejected by content hash',()=>{
 const {ref,old,snapshot}=fixture();old.displayedReplyExact='Different text';
 assert.throws(()=>readVerifiedDexaMemory({
  refId:ref.id,snapshot,missions:[old],scopeHash:scope}),
  {code:'DX003_MEMORY_REPLY_VERSION_MISMATCH'});
});
test('actual prior reply may NEVER be inlined without owner saying it',()=>{
 const step=plan('placeholder').steps[1];
 step.args.source=reply;
 assert.throws(()=>validateWriterPlanStep(step,{ownerGoal}),{
  code:'DX001_WRITER_LITERAL_SOURCE_NOT_OWNER_GROUNDED'});
});
test('bounded translation from memory $ref compiles without fabricated source',()=>{
 const {ref}=fixture();
 const p=validateGenericPlanContract(JSON.stringify(plan(ref.id)),
  ['dexa.memory.read','dexa.text.process'],{ownerGoal});
 assert.equal(p.typed.steps.length,2);
 assert.deepEqual(p.typed.steps[1].args.source,{$ref:{step:1,path:['text']}});
 assert.equal(p.typed.steps[1].args.operation,'translate');
});
test('same Kata planner exposes a selected memory read + writer with language rules',()=>{
 const p=prepareFastGeneralPlan({goal:ownerGoal,kataCapabilityIds:[
  'tool.cf.wechat_message_list']});
 assert.ok(p.allowed.includes('dexa.memory.read'));
 assert.ok(p.allowed.includes('dexa.text.process'));
 assert.match(p.prompt,/replyRefId/);
 assert.match(p.prompt,/language of CURRENT owner question/);
 assert.match(p.prompt,/colloquial/);
});
test('typed engine authenticates memory receipt before writer receives text',async()=>{
 const {ref,old,snapshot}=fixture();
 const p=validateGenericPlanContract(JSON.stringify(plan(ref.id)),
  ['dexa.memory.read','dexa.text.process'],{ownerGoal});
 let memCalls=0,writerCalls=0,verifiedSource=null;
 const result=await executeTypedPlan(p.raw,{ownerGoal,
  allowedCapabilities:['dexa.memory.read','dexa.text.process'],
  memoryInvoker:async({args})=>{
   memCalls++;
   return {result:readVerifiedDexaMemory({refId:args.refId,
    snapshot,missions:[old],scopeHash:scope}),providerTool:'DEXA.INTERNAL.dexa_memory_read'};
  },
  writerInvoker:async({args,sourceProvenance})=>{
   writerCalls++;verifiedSource=sourceProvenance;
   const prepared=prepareTextWriter({args,ownerGoal,sourceProvenance});
   const answer=verifyTextWriterReply(JSON.stringify({
    schema:'dexa.text-process.result.v1',status:'COMPLETE',
    text:'پیتر نوشت: فردا سند را برایت می‌فرستم.',
    evidence_indices:[]}),{prepared});
   return {result:answer,providerTool:'DEXA.INTERNAL.dexa_text_process'};
  }});
 assert.equal(result.state,'SUCCEEDED_VERIFIED',JSON.stringify(result).slice(0,650));
 assert.equal(memCalls,1);assert.equal(writerCalls,1);
 assert.equal(verifiedSource.originCapabilityId,'dexa.memory.read');
 assert.match(result.result,/پیتر نوشت/);
 assert.equal(result.proof.verifiedReceipts.length,2);
});
