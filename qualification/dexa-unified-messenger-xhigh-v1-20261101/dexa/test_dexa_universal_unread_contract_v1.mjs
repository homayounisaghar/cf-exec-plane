import test from "node:test";
import assert from "node:assert/strict";
import {canonicalOutputShapeForRoute,attachCanonicalMessagingView} from "./dexa_messaging_record_contract_v1.mjs";
import {catalogKnownOutputShape} from "./dexa_catalog_output_adapters_v1.mjs";
import {parseTypedPlan} from "./dexa_tool_plan_v3.mjs";
import {executeTypedPlan} from "./dexa_tool_plan_executor_v3.mjs";

const sources=["telegram","whatsapp","bale","alibaba","wechat"];
for (const provider of sources){
 const name=provider+"_unread_list", id="tool.cf."+name;
 test("one shared canonical unread contract: "+provider,()=>{
  const contract=canonicalOutputShapeForRoute(name);
  assert.equal(contract.arrayKey,"canonical_conversations");
  assert.equal(contract.arrayShape.family,"conversations");
  const shape=catalogKnownOutputShape(id);
  assert.equal(shape.arrays.canonical_conversations.family,"conversations");
  assert.ok(shape.arrays.canonical_conversations.fields.includes("unread_count"));
  const plan={schema:"dexa.tool-plan.v3",
   steps:[{id:1,kind:"TOOL",capabilityId:id,args:{limit:2},deps:[]}],
   checks:[{step:1,path:["canonical_conversations"],op:"exists"}],
   output:{step:1,path:["canonical_conversations"],format:"json"},
   answer:{kind:"conversations"}};
  assert.equal(parseTypedPlan(JSON.stringify(plan),[id]).steps.length,1);
  const native={state:"ACHIEVED",provider,count:1,
   conversations:[{name:"Synthetic Group",unread_count:2,has_unread:true,
      handle:provider==="wechat"?null:"ref:test"}]};
  const converted=attachCanonicalMessagingView({nativeTool:name,result:native,readOnly:true});
  assert.equal(converted.canonical_conversations.length,1);
  assert.equal(converted.canonical_conversations[0].provider,provider);
  assert.equal(converted.canonical_conversations[0].unread_count,2);
  assert.equal(converted.canonical_conversations[0].has_unread,true);
  assert.equal(converted.canonical_conversations[0].identity.addressable_with_handle,
    provider!=="wechat");
  assert.deepEqual(native.conversations[0],{
   name:"Synthetic Group",unread_count:2,has_unread:true,
   handle:provider==="wechat"?null:"ref:test"});
 });
}
test("shared unread canonicalizer supports zero rows without fabricated items",()=>{
 const native={state:"ACHIEVED",conversations:[],count:0,complete:false};
 for(const provider of sources){
  const actual=attachCanonicalMessagingView({
   nativeTool:provider+"_unread_list",result:native,readOnly:true});
  assert.deepEqual(actual.canonical_conversations,[]);
  assert.equal(actual.canonical_meta.bounded_result,true);
  assert.equal(actual.canonical_meta.full_population_verified,false);
 }
});
test("unknown namespace, state, or non-read-only call cannot masquerade as an audited unread list",()=>{
 assert.equal(canonicalOutputShapeForRoute("undefined_unread_list"),null);
 const x={state:"ACHIEVED",conversations:[{name:"test"}]};
 assert.equal(attachCanonicalMessagingView({
  nativeTool:"whatsapp_unread_list",result:x,readOnly:false}),x);
 assert.equal(attachCanonicalMessagingView({
  nativeTool:"whatsapp_unread_list",result:{...x,state:"FAILED"},readOnly:true}).canonical_conversations,undefined);
});
test("WeChat unknown message history remains unavailable for typed proof",()=>{
 assert.equal(canonicalOutputShapeForRoute("wechat_message_search"),null);
});
