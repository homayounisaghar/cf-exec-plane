import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {canonicalizeNativeVisibleMessageChronology,
 validateGenericPlanContract} from './dexa_general_plan_contract_v1.mjs';
import {executeTypedPlan} from './dexa_tool_plan_executor_v3.mjs';
import {openWorkflow} from './dexa_workflow_kernel.mjs';

const list='tool.cf.wechat_conversation_list';
const read='tool.cf.wechat_message_list';
const textOlder='Older observed content from the same native chat';
const textLatest='Latest observed content from the same native chat';
function recipe(){
 return {schema:'dexa.tool-plan.v3',steps:[
  {id:1,kind:'TOOL',capabilityId:list,args:{limit:50,max_pages:1},deps:[]},
  {id:2,kind:'TRANSFORM',op:'MATCH',
   source:{step:1,path:['conversations']},query:'Kazem-tenghai',
   fields:[['name']],mode:'bilingual_exact',deps:[1]},
  {id:3,kind:'TOOL',capabilityId:read,
   args:{target:{$ref:{step:2,path:['name']}},limit:5,allow_mark_read:false},
   deps:[2]},
  {id:4,kind:'TRANSFORM',op:'SORT',source:{step:3,path:['messages']},
   path:['time'],direction:'desc',deps:[3]},
  {id:5,kind:'TRANSFORM',op:'TAKE',source:{step:4,path:[]},count:1,deps:[4]}
 ],checks:[{step:5,path:[],op:'exists'}],
 output:{step:5,path:[],format:'json'},answer:{kind:'messages'}};
}
test('real Qwen descending native time SORT rewrites only to native REVERSE',()=>{
 const original=recipe(),raw=JSON.stringify(original);
 const r=canonicalizeNativeVisibleMessageChronology(raw);
 assert.equal(r.changed,true);
 assert.equal(r.rule,'NATIVE_VISIBLE_MESSAGE_CHRONOLOGY_REBIND');
 const p=JSON.parse(r.raw);
 assert.equal(p.steps[3].op,'REVERSE');
 assert.equal(p.steps[3].path,undefined);
 assert.equal(p.steps[3].direction,undefined);
 assert.equal(p.steps[4].count,1);
 assert.equal(original.steps[3].op,'SORT');
});
test('non-descending, non-time and non-WeChat sorting retain original meaning',()=>{
 for(const mod of [
  p=>{p.steps[3].direction='asc'},
  p=>{p.steps[3].path=['after_separator']},
  p=>{p.steps[2].capabilityId='tool.cf.telegram_message_list'}
 ]){
  const p=recipe();mod(p);
  assert.equal(canonicalizeNativeVisibleMessageChronology(JSON.stringify(p)).changed,false);
 }
});
for(const edge of [true,false]){
 test('live-like five-step provider read selects LAST observed row; attestation='+edge,async()=>{
  const admitted=validateGenericPlanContract(JSON.stringify(recipe()),[list,read],{
   ownerGoal:'توی اون گروهی که توی لیستت اولی بود، آخرین پیام چیه؟'});
  assert.equal(admitted.typed.steps[3].op,'REVERSE');
  assert.match(admitted.rule,/NATIVE_VISIBLE_MESSAGE_CHRONOLOGY_REBIND/);
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'wechat-newest-native-'));
  try{
   const wf=await openWorkflow({storeDir:dir,missionId:randomUUID(),
    planVersion:1,planRaw:admitted.raw,steps:admitted.typed.steps});
   const output=await executeTypedPlan(admitted.raw,{
    allowedCapabilities:[list,read],workflow:wf,connectionProbe:async()=>true,
    toolInvoker:async({capabilityId})=>{
     if(capabilityId===list)return {providerTool:'wechat_conversation_list',
      result:{state:'ACHIEVED',conversations:[{name:'Kazem-tenghai',unread_count:0}]}};
     if(capabilityId===read)return {
      providerTool:'wechat_message_list',
      effectProof:{providerTool:'wechat_message_list',outcome:'PROVIDER_REPORTED_SUCCEEDED'},
      result:{state:'ACHIEVED',scope:'bounded_visible_messages_only',
       at_latest_edge_verified:edge,complete:false,read_state_changed:false,
       messages:[{body:textOlder,time:null},{body:textLatest,time:null}]}
     };
     throw new Error('OTHER_CAPABILITY');
    }});
   assert.equal(output.state,'SUCCEEDED_VERIFIED',JSON.stringify(output).slice(0,600));
   assert.equal(output.proof.verifiedReceipts.length,5);
   assert.match(output.result,/Latest observed content/);
   assert.doesNotMatch(output.result,/Older observed content/);
   if(edge)assert.doesNotMatch(output.result,/تازه‌ترین پیام کل گفت‌وگو تأیید نشده است/);
   else assert.match(output.result,/تازه‌ترین پیام کل گفت‌وگو تأیید نشده است/);
  }finally{fs.rmSync(dir,{recursive:true,force:true})}
 });
}
