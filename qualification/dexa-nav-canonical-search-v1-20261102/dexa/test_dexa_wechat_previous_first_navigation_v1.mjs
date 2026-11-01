import test from 'node:test';
import assert from 'node:assert/strict';
import {validateGenericPlanContract} from './dexa_general_plan_contract_v1.mjs';
import {prepareFastGeneralPlan} from './dexa_general_plan_cycle_v2.mjs';
import {buildTypedPlannerPrompt} from './dexa_typed_planner_prompt_v3.mjs';

const list='tool.cf.wechat_conversation_list';
const navigate='tool.cf.wechat_message_list';
const send='tool.cf.wechat_send';
const target='Kazem-tenghai';
const plan=(consumer=navigate)=>({
 schema:'dexa.tool-plan.v3',
 steps:[
  {id:1,kind:'TOOL',capabilityId:list,
   args:{limit:10,max_pages:1},deps:[]},
  {id:2,kind:'TRANSFORM',op:'MATCH',
   source:{step:1,path:['canonical_conversations']},
   query:target,fields:[['name']],mode:'normalized_exact',deps:[1]},
  {id:3,kind:'TOOL',capabilityId:consumer,
   args:consumer===navigate?{target:{$ref:{step:2,path:['name']}},limit:10,allow_mark_read:false}:
     {target:{$ref:{step:2,path:['name']}},text:'This is a write'},
   deps:[2]}
 ],
 checks:[{step:3,path:consumer===navigate?['messages']:['state'],op:'exists'}],
 output:{step:3,path:consumer===navigate?['messages']:['state'],format:'json'},
 answer:{kind:consumer===navigate?'messages':'text'}
});
const allowed=[list,navigate,send];
const errCode=e=>e?.code||e?.message;

test('canonical conversation name is mechanically rebound to audited native list ONLY for bounded read-navigation',()=>{
 const p=plan();
 const out=validateGenericPlanContract(JSON.stringify(p),allowed,{
  ownerGoal:'توی اون گروهی که توی لیستت اولی بود، آخرین پیام چیه؟'});
 assert.equal(out.typed.steps.length,3);
 assert.equal(out.typed.steps[0].capabilityId,list);
 assert.equal(out.typed.steps[1].op,'MATCH');
 assert.deepEqual(out.typed.steps[1].source.path,['conversations']);
 assert.deepEqual(out.typed.steps[2].args.target,{$ref:{step:2,path:['name']}});
 assert.equal(out.typed.steps[2].args.allow_mark_read,false);
 assert.match(out.rule,/VERIFIED_NAVIGATION_NATIVE_NAME_SOURCE_REBIND/);
});
test('same canonical name can NEVER become an unauthorized SEND identity',()=>{
 const p=plan(send);
 assert.throws(()=>validateGenericPlanContract(JSON.stringify(p),allowed,{
  ownerGoal:'توی اون گروهی که توی لیستت اولی بود، آخرین پیام چیه؟'}),
  e=>errCode(e)==='GENERAL_PLAN_CANONICAL_IDENTITY_WRITE_FORBIDDEN');
});
test('an unverified first-record TAKE is not a unique native navigation identity',()=>{
 const p=plan();
 p.steps[1]={id:2,kind:'TRANSFORM',op:'TAKE',source:{step:1,path:['canonical_conversations']},
  count:1,deps:[1]};
 assert.throws(()=>validateGenericPlanContract(JSON.stringify(p),allowed,{
  ownerGoal:'Read first previous chat'}));
});
test('literal target cannot bypass provider-grounded same-plan identity lookup',()=>{
 const p=plan();p.steps[2].args.target=target;
 assert.throws(()=>validateGenericPlanContract(JSON.stringify(p),allowed,{ownerGoal:'Read this chat'}));
});
test('native-navigation rebind preserves independently observed native title while output remains messages',()=>{
 const p=plan();p.steps[2].args.allow_mark_read=true;
 const out=validateGenericPlanContract(JSON.stringify(p),allowed,{ownerGoal:'Read the chat'});
 assert.equal(out.typed.steps[2].args.allow_mark_read,true);
 assert.equal(out.typed.answer.kind,'messages');
 assert.deepEqual(out.typed.output.path,['messages']);
});
test('general prompt explicitly grounds prior displayed first chat and native selector',()=>{
 const {prompt}=prepareFastGeneralPlan({
  goal:'توی اون گروهی که توی لیستت اولی بود، آخرین پیام چیه؟',
  context:'OWNER EXCHANGE SUMMARIES: verified previous reply • Kazem-tenghai • File Transfer',
  kataCapabilityIds:[list,navigate]});
 assert.match(prompt,/PREVIOUS reply/);
 assert.match(prompt,/not a literal target nor a TAKE/);
 assert.match(prompt,/native conversations\[\]/);
});

test('actual real-model search canonical alias is rebound to verified native conversation list, no provider search dispatched',()=>{
 const search='tool.cf.wechat_conversation_search';
 const p=plan();
 p.steps[0]={id:1,kind:'TOOL',capabilityId:search,
  args:{query:target,limit:10},deps:[]};
 p.steps[1].mode='normalized_exact';
 p.steps[2].args={target:{$ref:{step:2,path:['name']}},limit:10};
 p.steps.push(
  {id:4,kind:'TRANSFORM',op:'REVERSE',
   source:{step:3,path:['messages']},deps:[3]},
  {id:5,kind:'TRANSFORM',op:'TAKE',
   count:1,source:{step:4,path:[]},deps:[4]});
 p.checks=[{step:5,path:[],op:'exists'}];
 p.output={step:5,path:[],format:'json'};
 const out=validateGenericPlanContract(JSON.stringify(p),[search,list,navigate],{
  ownerGoal:'توی اون گروهی که توی لیستت اولی بود، آخرین پیام چیه؟'});
 assert.equal(out.typed.steps.length,5);
 assert.equal(out.typed.steps[0].capabilityId,list);
 assert.ok(out.typed.steps[0].args.max_pages>=1);
 assert.deepEqual(out.typed.steps[1].source.path,['conversations']);
 assert.equal(out.typed.steps[1].query,target);
 assert.deepEqual(out.typed.steps[2].args.target,{$ref:{step:2,path:['name']}});
 assert.match(out.rule,/VERIFIED_NAVIGATION_NATIVE_LOOKUP_REBIND/);
});
test('same search canonical alias may never be used to change a SEND recipient',()=>{
 const search='tool.cf.wechat_conversation_search';
 const p=plan(send);
 p.steps[0]={id:1,kind:'TOOL',capabilityId:search,
  args:{query:target,limit:10},deps:[]};
 assert.throws(()=>validateGenericPlanContract(JSON.stringify(p),[search,list,send],{
  ownerGoal:'توی اون گروهی که توی لیستت اولی بود، آخرین پیام چیه؟'}),
  e=>errCode(e)==='GENERAL_PLAN_CANONICAL_IDENTITY_WRITE_FORBIDDEN');
});
