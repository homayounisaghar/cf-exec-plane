import test from 'node:test';
import assert from 'node:assert/strict';
import {excludeDexaWeChatServiceChat} from './dexa_messaging_record_contract_v1.mjs';
import {executeTypedPlan} from './dexa_tool_plan_executor_v3.mjs';

const nativeTool=tool=>'wechat_'+tool;
const apply=(tool,result,readOnly=true)=>
 excludeDexaWeChatServiceChat({nativeTool:nativeTool(tool),result,readOnly});
const service={name:'Service Notifications',unread_count:3,has_unread:true,
 conversation_ref:'wechat-name:Service%20Notifications'};
const ordinary={name:'Kazem-tenghai',unread_count:2,has_unread:true,
 conversation_ref:'wechat-name:Kazem-tenghai'};
const more={name:'Service Notifications Team',unread_count:1,has_unread:true};

for(const tool of ['conversation_list','unread_list']){
 test('hide exact service chat, not ordinary chats, in '+tool,()=>{
  const native={state:'ACHIEVED',provider:'wechat',complete:false,
   count:3,returned:3,read_state_changed:false,
   conversations:[ordinary,service,more]};
  const out=apply(tool,native);
  assert.deepEqual(out.conversations,[ordinary,more]);
  assert.equal(out.count,2);
  assert.equal(out.returned,2);
  assert.equal(out.complete,false);
  assert.equal(out.read_state_changed,false);
  assert.equal(native.conversations.length,3);
  assert.deepEqual(native.conversations[1],service);
 });
}
test('case and whitespace normalize only the exact WeChat chat name',()=>{
 const inp={state:'ACHIEVED',conversations:[
  {name:'  SERVICE NOTIFICATIONS  '},more,ordinary]};
 const out=apply('conversation_list',inp);
 assert.deepEqual(out.conversations,[more,ordinary]);
});
test('native conversation and contact searches omit the exact ignored result',()=>{
 for(const tool of ['conversation_search','contact_search']){
  const inp={state:'ACHIEVED',provider:'wechat',count:3,results:[
   {name:'Service Notifications',category:'Contacts'},
   {name:'Service Notifications Team',category:'Contacts'},
   {name:'Lin',category:'Contacts'}]};
  const out=apply(tool,inp);
  assert.deepEqual(out.results.map(x=>x.name),['Service Notifications Team','Lin']);
  assert.equal(out.count,2);
 }
});
test('message search excludes hits only by provider-observed chat identity',()=>{
 const src={state:'ACHIEVED',results:[
  {chat_name:'Service Notifications',body:'card'},
  {chat_name:'Kazem-tenghai',body:'Service Notifications'},
  {name:'Service Notifications',chat_name:'Kazem-tenghai',body:'ordinary'}]};
 const out=apply('message_search',src);
 assert.equal(out.results.length,2);
 assert.deepEqual(out.results.map(r=>r.chat_name),['Kazem-tenghai','Kazem-tenghai']);
});
test('unrelated providers, selected-conversation reads and message read remain unchanged',()=>{
 const src={state:'ACHIEVED',conversations:[service,ordinary]};
 assert.equal(excludeDexaWeChatServiceChat({
  nativeTool:'telegram_unread_list',result:src,readOnly:true}),src);
 assert.equal(apply('selected_conversation',src),src);
 assert.equal(apply('message_list',src,false),src);
 assert.equal(apply('unread_list',src,false),src);
});
test('failed or incomplete provider results are not turned into success',()=>{
 for(const state of ['FAILED','INCOMPLETE','IN_DOUBT']){
  const src={state,conversations:[service]};
  assert.equal(apply('unread_list',src),src);
 }
});
test('provider report counts that are not observed-row counts are not altered',()=>{
 const src={state:'ACHIEVED',count:160,returned:2,
  conversations:[service,ordinary]};
 const out=apply('conversation_list',src);
 assert.equal(out.count,160);
 assert.equal(out.returned,1);
});
test('real typed workflow omits ignored WeChat unread result before both native and canonical output',async()=>{
 const id='tool.cf.wechat_unread_list';
 const fixture={state:'ACHIEVED',provider:'wechat',complete:false,
  conversations:[service,ordinary],count:2};
 for(const path of ['conversations','canonical_conversations']){
  let reads=0;
  const plan={schema:'dexa.tool-plan.v3',
   steps:[{id:1,kind:'TOOL',capabilityId:id,args:{limit:10,max_pages:1},deps:[]}],
   checks:[{step:1,path:[path],op:'exists'}],
   output:{step:1,path:[path],format:'json'},answer:{kind:'conversations'}};
  const out=await executeTypedPlan(JSON.stringify(plan),{
   allowedCapabilities:[id],
   toolInvoker:async()=>{reads++;return {result:fixture,
    providerTool:'wechat_unread_list'}}
  });
  assert.equal(reads,1);
  assert.equal(out.state,'SUCCEEDED_VERIFIED',JSON.stringify(out).slice(0,550));
  assert.ok(out.result.includes('Kazem-tenghai'));
  assert.ok(!out.result.includes('Service Notifications'));
  assert.equal(out.proof.postconditionReceipts[0].passed,true);
 }
});
test('only ignored unread chat yields a verified zero-visible-result, never false failure',async()=>{
 const id='tool.cf.wechat_unread_list';
 const plan={schema:'dexa.tool-plan.v3',
 steps:[{id:1,kind:'TOOL',capabilityId:id,args:{limit:10,max_pages:1},deps:[]}],
 checks:[{step:1,path:['canonical_conversations'],op:'exists'}],
 output:{step:1,path:['canonical_conversations'],format:'json'},
 answer:{kind:'conversations'}};
 const out=await executeTypedPlan(JSON.stringify(plan),{
  allowedCapabilities:[id],
  toolInvoker:async()=>({result:{state:'ACHIEVED',provider:'wechat',
   conversations:[service],count:1},providerTool:'wechat_unread_list'})
 });
 assert.equal(out.state,'SUCCEEDED_VERIFIED');
 assert.match(out.result,/خوانده‌نشده/);
 assert.ok(!out.result.includes('Service Notifications'));
});
