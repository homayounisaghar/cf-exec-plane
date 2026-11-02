import test from 'node:test';
import assert from 'node:assert/strict';
import {catalogRoute} from './dexa_catalog_registry.mjs';
import {validateWriterBackedOutgoingTextStep as verify} from './dexa_outgoing_language_policy_v1.mjs';
const writer={id:1,kind:'TOOL',capabilityId:'dexa.text.process',
 args:{operation:'draft'},deps:[]};
const routes=[
 ['telegram.message.send','text'],
 ['tool.cf.whatsapp_send','text'],
 ['tool.cf.wechat_send','text'],
 ['tool.cf.alibaba_send','text'],
 ['tool.cf.bale_send','text'],
 ['tool.cf.android_sms_send','body'],
 ['tool.cf.alibaba_reply','text']
];
for(const [id,key] of routes){
 test('literal outgoing text rejected before provider dispatch: '+id,()=>{
  assert.ok(catalogRoute(id)?.cfName,id);
  const step={id:2,kind:'TOOL',capabilityId:id,
   args:{[key]:'Please send the file tomorrow'},deps:[]};
  assert.throws(()=>verify(step,{steps:[step],ownerGoal:'بهش بگو فردا فایل را بفرست'}),
   {code:'DEXA_OUTGOING_UNDRAFTED_LITERAL_FORBIDDEN'});
 });
 test('writer-backed draft admitted: '+id,()=>{
  const step={id:2,kind:'TOOL',capabilityId:id,
   args:{[key]:{$ref:{step:1,path:['text']}}},deps:[1]};
  assert.equal(verify(step,{steps:[writer,step],ownerGoal:'بهش پیام بده'}),true);
  assert.throws(()=>verify({...step,deps:[]},{steps:[writer,step],ownerGoal:'بهش پیام بده'}),
   {code:'DEXA_OUTGOING_WRITER_STEP_REQUIRED'});
 });
}
test('verbatim user quotation only can preserve exact payload',()=>{
 const step={id:2,kind:'TOOL',capabilityId:'telegram.message.send',args:{text:'Hello Peter'},deps:[]};
 assert.equal(verify(step,{steps:[step],ownerGoal:'به پیتر دقیقاً بگو «Hello Peter»'}),true);
 assert.throws(()=>verify({...step,args:{text:'Hello Peter!'}},{steps:[step],ownerGoal:'به پیتر دقیقاً بگو «Hello Peter»'}),
  {code:'DEXA_OUTGOING_UNDRAFTED_LITERAL_FORBIDDEN'});
});
test('forged writer step is never treated as a draft',()=>{
 const step={id:2,kind:'TOOL',capabilityId:'telegram.message.send',
  args:{text:{$ref:{step:1,path:['text']}}},deps:[1]};
 assert.throws(()=>verify(step,{steps:[{...writer,capabilityId:'web.read'},step],ownerGoal:'send'}),
  {code:'DEXA_OUTGOING_WRITER_STEP_REQUIRED'});
});
