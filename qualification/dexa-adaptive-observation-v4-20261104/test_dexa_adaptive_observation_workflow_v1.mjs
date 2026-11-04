import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {validateGenericPlanContract} from './dexa_general_plan_contract_v1.mjs';
import {executeTypedPlan} from './dexa_tool_plan_executor_v3.mjs';
import {openWorkflow} from './dexa_workflow_kernel.mjs';
import {universalMissionContext}
 from './dexa_universal_mission_context_v1.mjs';
const unread='tool.cf.wechat_unread_list';
const read='tool.cf.wechat_message_list';
const selected=[unread,read];
const plan={schema:'dexa.tool-plan.v3',steps:[
 {id:1,kind:'TOOL',capabilityId:unread,args:{limit:15},deps:[]},
 {id:2,kind:'TRANSFORM',op:'ONLY',source:{step:1,path:['conversations']},deps:[1]},
 {id:3,kind:'TOOL',capabilityId:read,args:{
   target:{$ref:{step:2,path:['name']}},limit:5},deps:[2]}
],checks:[{step:3,path:['messages'],op:'exists'}],
 output:{step:3,path:['messages'],format:'json'},answer:{kind:'messages'}};
const validated=validateGenericPlanContract(JSON.stringify(plan),selected);
async function run(rows){
 const root=path.join('/home/cfserver/dexa-adaptive-observation-20261103',
  'fixture-checkpoints');
 fs.mkdirSync(root,{recursive:true});
 const missionId=randomUUID();
 const workflow=await openWorkflow({storeDir:root,missionId,planVersion:1,
  planRaw:validated.raw,steps:validated.typed.steps});
 const calls=[];
 const result=await executeTypedPlan(validated.raw,{
  allowedCapabilities:selected,workflow,connectionProbe:async()=>true,
  toolInvoker:async ({capabilityId,args})=>{
   calls.push({capabilityId,args});
   return capabilityId===unread?
    {result:{state:'ACHIEVED',conversations:rows,count:rows.length},
      providerTool:'wechat_unread_list',readOnly:true}:
    {result:{state:'ACHIEVED',messages:[{body:'observed text',
     direction:'incoming',source:'accessibility'}]},
      providerTool:'wechat_message_list',readOnly:false,
      effectProof:{providerTool:'wechat_message_list',
       outcome:'PROVIDER_REPORTED_SUCCEEDED'}};
  }
 });
 return {result,calls,missionId};
}
test('durable one-winner owner observation finishes with actual native target',async()=>{
 const {result,calls}=await run([{name:'Unique Group',
  has_unread:true,unread_count:1}]);
 assert.equal(result.state,'SUCCEEDED_VERIFIED',JSON.stringify(result).slice(0,600));
 assert.equal(calls.length,2);
 assert.equal(calls[1].args.target,'Unique Group');
});
test('durable multiple observation yields bounded model continuation without navigation',async()=>{
 const {result,calls}=await run([{name:'Group A',has_unread:true,unread_count:1},
  {name:'Group B',has_unread:true,unread_count:2}]);
 assert.equal(result.state,'REPLAN_REQUIRED',JSON.stringify(result).slice(0,600));
 assert.equal(result.reason,'TOOL_PLAN_OBSERVATION_NEEDS_MODEL');
 assert.equal(calls.length,1);
 assert.equal(result.proof.observation.observedCandidateCount,2);
 const context=universalMissionContext({
  originalGoal:'Which unread conversation is the group?',
  observedEvidence:result.proof.observation});
 assert.ok(context.includes('Group B'));
 assert.ok(context.includes('UNTRUSTED DATA'));
});
