import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {openWorkflow} from './dexa_workflow_kernel.mjs';
import assert from 'node:assert/strict';
import {deliverTypedAnswer} from './dexa_answer_contract_v1.mjs';
import {catalogKnownOutputShape} from './dexa_catalog_output_adapters_v1.mjs';
import {validateGenericPlanContract} from './dexa_general_plan_contract_v1.mjs';
import {executeTypedPlan} from './dexa_tool_plan_executor_v3.mjs';

const native=[
 {body:'سلام، این متن واقعیِ نمای چت است.',body_may_be_truncated:false,
  sender:null,direction:'unknown',source:'visible_native_accessibility_list_item'},
 {body:'این پیام دوم در محدودهٔ قابل مشاهده است.',body_may_be_truncated:true,
  sender:null,direction:'unknown',source:'visible_native_accessibility_list_item'}
];
const original=()=>structuredClone(native);
test('native WeChat documented body is audited as messages despite lacking text field',()=>{
 const shape=catalogKnownOutputShape('tool.cf.wechat_message_list').arrays.messages;
 assert.ok(shape.fields.includes('body'));
 assert.equal(shape.fieldTypes.body,'string');
 assert.equal(shape.latestEdgeGuaranteed,false);
});
test('unknown native body output is rejected until producer type audit allows alias',()=>{
 assert.throws(()=>deliverTypedAnswer({answer:{kind:'messages'},output:original(),format:'json'}),
  e=>e?.code==='TOOL_ANSWER_MESSAGES_UNSAFE');
});
test('audited native body renders faithfully with no guessed sender and bounded edge qualification',()=>{
 const rows=original(),copy=structuredClone(rows);
 const answer=deliverTypedAnswer({answer:{kind:'messages'},output:rows,format:'json',
  verifiedNativeMessageBody:true,boundedVisibleMessages:true});
 assert.ok(answer.proof.verified);
 assert.match(answer.text,/سلام، این متن واقعی/);
 assert.match(answer.text,/متن پیام‌ها در نمای پیام‌رسان کوتاه/);
 assert.match(answer.text,/تازه‌ترین پیام کل گفت‌وگو تأیید نشده است/);
 assert.doesNotMatch(answer.text,/پیام از /);
 assert.deepEqual(rows,copy);
});
test('original canonical text messages are unaffected, no invented visible-only caveat',()=>{
 const answer=deliverTypedAnswer({answer:{kind:'messages'},format:'json',
  output:[{text:'hello',sender_name:'Ali'}]});
 assert.match(answer.text,/Ali/);
 assert.doesNotMatch(answer.text,/تازه‌ترین پیام/);
});
test('even audited body presentation rejects a non-string native message body',()=>{
 assert.throws(()=>deliverTypedAnswer({answer:{kind:'messages'},format:'json',
  verifiedNativeMessageBody:true,output:[{body:48}]}),
  e=>e?.code==='TOOL_ANSWER_MESSAGES_UNSAFE');
});
test('complete typed provider workflow projects actual native body only after verified effect receipt',async()=>{
 const first='tool.cf.wechat_conversation_list',second='tool.cf.wechat_message_list';
 const plan={schema:'dexa.tool-plan.v3',
  steps:[
   {id:1,kind:'TOOL',capabilityId:first,args:{limit:10,max_pages:1},deps:[]},
   {id:2,kind:'TRANSFORM',op:'MATCH',source:{step:1,path:['canonical_conversations']},
    query:'Kazem-tenghai',fields:[['name']],mode:'normalized_exact',deps:[1]},
   {id:3,kind:'TOOL',capabilityId:second,
    args:{target:{$ref:{step:2,path:['name']}},limit:5,allow_mark_read:false},deps:[2]}
  ],checks:[{step:3,path:['messages'],op:'exists'}],
  output:{step:3,path:['messages'],format:'json'},answer:{kind:'messages'}};
 const authorized=[first,second];
 const compiled=validateGenericPlanContract(JSON.stringify(plan),authorized,{
  ownerGoal:'توی اون گروهی که توی لیستت اولی بود، آخرین پیام چیه؟'});
 let calls=0;
 const storeDir=fs.mkdtempSync(path.join(os.tmpdir(),'dexa-native-body-'));
 try{
 const wf=await openWorkflow({storeDir,missionId:randomUUID(),
  planVersion:1,planRaw:compiled.raw,steps:compiled.typed.steps});
 const output=await executeTypedPlan(compiled.raw,{allowedCapabilities:authorized,
  workflow:wf,connectionProbe:async()=>true,
  toolInvoker:async({capabilityId})=>{
   calls++;
   if(capabilityId===first)return {providerTool:'wechat_conversation_list',
    result:{state:'ACHIEVED',provider:'wechat',complete:false,
     conversations:[{name:'Kazem-tenghai',unread_count:0,has_unread:false}]}};
   if(capabilityId===second)return {providerTool:'wechat_message_list',
    effectProof:{providerTool:'wechat_message_list',outcome:'PROVIDER_REPORTED_SUCCEEDED'},
    result:{state:'ACHIEVED',provider:'wechat',scope:'bounded_visible_messages_only',
     at_latest_edge_verified:false,complete:false,read_state_changed:false,
     messages:original()}};
   throw Error('NOT_SELECTED');
  }});
 assert.equal(calls,2);
 assert.equal(output.state,'SUCCEEDED_VERIFIED',JSON.stringify(output).slice(0,600));
 assert.equal(output.proof.verifiedReceipts.length,3);
 assert.match(output.result,/سلام، این متن واقعی/);
 assert.match(output.result,/تازه‌ترین پیام کل گفت‌وگو تأیید نشده است/);
 assert.ok(!output.result.includes('Service Notifications'));
 }finally{fs.rmSync(storeDir,{recursive:true,force:true})}
});

test('real-model REVERSE then TAKE retains authenticated native body and admits only bounded latest-visible wording',async()=>{
 const first='tool.cf.wechat_conversation_list',reader='tool.cf.wechat_message_list';
 const plan={schema:'dexa.tool-plan.v3',steps:[
  {id:1,kind:'TOOL',capabilityId:first,args:{limit:10,max_pages:1},deps:[]},
  {id:2,kind:'TRANSFORM',op:'MATCH',source:{step:1,path:['conversations']},
   query:'Kazem-tenghai',fields:[['name']],mode:'bilingual_exact',deps:[1]},
  {id:3,kind:'TOOL',capabilityId:reader,
   args:{target:{$ref:{step:2,path:['name']}},limit:10},deps:[2]},
  {id:4,kind:'TRANSFORM',op:'REVERSE',source:{step:3,path:['messages']},deps:[3]},
  {id:5,kind:'TRANSFORM',op:'TAKE',count:1,source:{step:4,path:[]},deps:[4]}
 ],checks:[{step:5,path:[],op:'exists'}],output:{step:5,path:[],format:'json'},
 answer:{kind:'messages'}};
 const allowed=[first,reader];
 const compiled=validateGenericPlanContract(JSON.stringify(plan),allowed,{
  ownerGoal:'توی اون گروهی که توی لیستت اولی بود، آخرین پیام چیه؟'});
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dexa-verified-body-transform-'));
 try{
  const wf=await openWorkflow({storeDir:dir,missionId:randomUUID(),
   planVersion:1,planRaw:compiled.raw,steps:compiled.typed.steps});
  const output=await executeTypedPlan(compiled.raw,{allowedCapabilities:allowed,
   workflow:wf,connectionProbe:async()=>true,
   toolInvoker:async({capabilityId})=>capabilityId===first?{
    providerTool:'wechat_conversation_list',
    result:{state:'ACHIEVED',conversations:[{name:'Kazem-tenghai',unread_count:0}]}
   }:{
    providerTool:'wechat_message_list',
    effectProof:{providerTool:'wechat_message_list',outcome:'PROVIDER_REPORTED_SUCCEEDED'},
    result:{state:'ACHIEVED',scope:'bounded_visible_messages_only',
     complete:false,at_latest_edge_verified:false,messages:original()}
   }});
  assert.equal(output.state,'SUCCEEDED_VERIFIED',JSON.stringify(output).slice(0,500));
  assert.equal(output.proof.verifiedReceipts.length,5);
  assert.match(output.result,/این پیام دوم در محدودهٔ قابل مشاهده است/);
  assert.doesNotMatch(output.result,/سلام، این متن واقعی/);
  assert.match(output.result,/تازه‌ترین پیام کل گفت‌وگو تأیید نشده است/);
  assert.match(output.result,/متن پیام‌ها در نمای پیام‌رسان کوتاه/);
 }finally{fs.rmSync(dir,{recursive:true,force:true})}
});
