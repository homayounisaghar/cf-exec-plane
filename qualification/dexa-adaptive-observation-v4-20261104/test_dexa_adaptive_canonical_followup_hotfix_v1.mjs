import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdirSync} from 'node:fs';
import {validateGenericPlanContract}
 from './dexa_general_plan_contract_v1.mjs';
import {executeTypedPlan} from './dexa_tool_plan_executor_v3.mjs';
import {openWorkflow} from './dexa_workflow_kernel.mjs';
const unread='tool.cf.wechat_unread_list',list='tool.cf.wechat_conversation_list';
const read='tool.cf.wechat_message_list',send='tool.cf.wechat_send';
function plan(producer=unread,kind='MATCH'){
 const prefix=[{id:1,kind:'TOOL',capabilityId:producer,
  args:{limit:15},deps:[]}];
 let choice;
 if(kind==='MATCH'){
  choice={id:2,kind:'TRANSFORM',op:'MATCH',
   source:{step:1,path:['canonical_conversations']},
   query:'Observed Unique Team',fields:[['name']],
   mode:'normalized_exact',deps:[1]};
 }else{
  prefix.push({id:2,kind:'TRANSFORM',op:'FILTER',
   source:{step:1,path:['canonical_conversations']},
   predicate:{path:['kind'],op:'equal',value:'group'},deps:[1]});
  choice={id:3,kind:'TRANSFORM',op:'ONLY',
   source:{step:2,path:[]},deps:[2]};
 }
 const idx=choice.id+1;
 return {schema:'dexa.tool-plan.v3',
  steps:[...prefix,choice,{id:idx,kind:'TOOL',capabilityId:read,
   args:{target:{$ref:{step:choice.id,path:['name']}},limit:5},
   deps:[choice.id]}],
  checks:[{step:idx,path:['messages'],op:'exists'}],
  output:{step:idx,path:['messages'],format:'json'},
  answer:{kind:'messages'}};
}
test('one audited canonical MATCH on verified unread source is a read-navigation identity',()=>{
 const p=plan();
 const r=validateGenericPlanContract(JSON.stringify(p),[unread,read]);
 assert.equal(r.typed.steps[2].capabilityId,read);
 assert.deepEqual(r.typed.steps[2].args.target.$ref.path,['name']);
});
test('one audited canonical MATCH on full conversation list is same-provider proof',()=>{
 const p=plan(list);
 const r=validateGenericPlanContract(JSON.stringify(p),[list,read]);
 assert.equal(r.typed.steps[2].capabilityId,read);
});
test('exact same canonical observation cannot authorize a send',()=>{
 const p=plan();
 p.steps.at(-1).capabilityId=send;
 delete p.steps.at(-1).args.limit;
 assert.throws(()=>validateGenericPlanContract(JSON.stringify(p),[unread,send]));
});
test('provider kind missing gives model four actual observed rows, but zero matched',async()=>{
 const p=plan(unread,'FILTER');
 const v=validateGenericPlanContract(JSON.stringify(p),[unread,read]);
 const store='/home/cfserver/dexa-adaptive-observation-20261103/fixture-checkpoints';
 mkdirSync(store,{recursive:true});
 const workflow=await openWorkflow({storeDir:store,missionId:randomUUID(),
  planVersion:1,planRaw:v.raw,steps:v.typed.steps});
 const actual=await executeTypedPlan(v.raw,{allowedCapabilities:[unread,read],
  workflow,connectionProbe:async()=>true,
  toolInvoker:async ({capabilityId})=>{
   assert.equal(capabilityId,unread);
   return {result:{state:'ACHIEVED',conversations:Array.from({length:4},(_,i)=>({
    name:'Conversation '+(i+1),unread_count:1,has_unread:true
   }))},providerTool:'wechat_unread_list'};
  }});
 assert.equal(actual.reason,'TOOL_PLAN_OBSERVATION_NEEDS_MODEL');
 const obs=actual.proof.observation;
 assert.equal(obs.observedCandidateCount,0);
 assert.equal(obs.originalObservedCount,4);
 assert.equal(obs.candidatesMatchSelection,false);
 assert.equal(obs.candidates.length,4);
 assert.equal(obs.candidates[3].name,'Conversation 4');
 assert.equal(actual.proof.verifiedReceipts.length,2);
});
