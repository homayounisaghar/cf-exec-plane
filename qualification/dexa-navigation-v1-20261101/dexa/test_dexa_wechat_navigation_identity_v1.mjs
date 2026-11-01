import test from 'node:test';
import assert from 'node:assert/strict';
import {validateGenericPlanContract} from './dexa_general_plan_contract_v1.mjs';
import {catalogKnownOutputShape} from './dexa_catalog_output_adapters_v1.mjs';
const reader='tool.cf.wechat_message_list',source='tool.cf.wechat_conversation_list';
function plan(){
 return {schema:'dexa.tool-plan.v3',
 steps:[{id:1,kind:'TOOL',capabilityId:reader,
  args:{target:'Service Notifications',limit:10,allow_mark_read:true},deps:[]}],
 checks:[{step:1,path:['messages'],op:'exists'}],
 output:{step:1,path:['messages'],format:'json'},answer:{kind:'messages'}};
}
test('navigation read selector declares exact unique native chat verification',()=>{
 const policy=catalogKnownOutputShape(reader).identityInputs.target;
 assert.equal(policy.kind,'NATIVE_UNIQUE_EXACT_LABEL');
 assert.equal(policy.nativeOperationVerifiesUniqueExactRecipient,true);
 assert.equal(policy.notARecipientWrite,true);
});
test('explicit owner-approved navigation is grounded in native provider lookup and unique MATCH',()=>{
 const result=validateGenericPlanContract(JSON.stringify(plan()),[reader,source],{
  ownerGoal:'Read Service Notifications messages, marking this conversation read is allowed'});
 assert.equal(result.typed.steps.length,3);
 assert.equal(result.typed.steps[0].capabilityId,source);
 assert.equal(result.typed.steps[1].op,'MATCH');
 assert.equal(result.typed.steps[2].capabilityId,reader);
 assert.deepEqual(result.typed.steps[2].args.target,{$ref:{step:2,path:['name']}});
 assert.equal(result.typed.steps[2].args.allow_mark_read,true);
});
test('do not grant unverified chat target without owner designation',()=>{
 assert.throws(()=>validateGenericPlanContract(JSON.stringify(plan()),[reader,source],{
  ownerGoal:'Read messages from somewhere'}));
});
