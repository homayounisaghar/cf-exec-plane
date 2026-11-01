import test from "node:test";
import assert from "node:assert/strict";
import {catalogKnownOutputShape,describeTypedProjection} from "./dexa_catalog_output_adapters_v1.mjs";
import {parseTypedPlan} from "./dexa_tool_plan_v3.mjs";
import {executeTypedPlan} from "./dexa_tool_plan_executor_v3.mjs";
import {prepareFastGeneralPlan,diagnosticRetryPrompt}
 from "./dexa_general_plan_cycle_v2.mjs";

const read="tool.cf.wechat_unread_list";
const other="tool.cf.wechat_screenshot";
const unreadResult={state:"ACHIEVED",provider:"wechat",complete:false,
 read_state_changed:false,conversations:[
 {name:"Some Group",unread_count:3,has_unread:true,
  pinned:null,conversation_ref:"wechat-name:Some%20Group"}]};
const p=(capabilityId=read,answerKind="conversations")=>({
 schema:"dexa.tool-plan.v3",
 steps:[{id:1,kind:"TOOL",capabilityId,args:{limit:10,max_pages:1},deps:[]}],
 checks:[{step:1,path:["conversations"],op:"exists"}],
 output:{step:1,path:["conversations"],format:"json"},
 answer:{kind:answerKind}
});

test("audited WeChat unread list exposes actual native conversation family",()=>{
 const shape=catalogKnownOutputShape(read);
 assert.equal(shape.arrays.conversations.fieldTypes.name,"string");
 assert.equal(shape.arrays.conversations.fieldTypes.unread_count,"integer");
 assert.ok(shape.arrays.conversations.fields.includes("has_unread"));
 assert.equal(shape.arrays.conversations.coverage,"BOUNDED_VISIBLE_UNREAD_CHAT_LIST_NOT_GLOBAL");
 assert.equal(shape.arrays.conversations.identityAuthority,"PROVIDER_OBSERVED_NAME_ONLY_NO_STABLE_HANDLE");
 const plan=parseTypedPlan(JSON.stringify(p()),[read]);
 const projection=describeTypedProjection(plan.steps,1,["conversations"]);
 assert.equal(projection.kind,"array");
 assert.equal(projection.fieldTypes.name,"string");
 assert.doesNotThrow(()=>parseTypedPlan(JSON.stringify(p()),[read]));
});

test("schema remains strict for unrelated source claiming conversations",()=>{
 const x=p(other);
 x.steps[0].args={};
 assert.throws(()=>parseTypedPlan(JSON.stringify(x),[other]),
  e=>e?.code==="TOOL_ANSWER_CONVERSATION_ORIGIN_INVALID");
});

test("read-only unread tool answer passes full typed runtime and is provider grounded",async()=>{
 let calls=0;
 const result=await executeTypedPlan(JSON.stringify(p()),{
  allowedCapabilities:[read],
  toolInvoker:async({capabilityId,args})=>{
   calls++; assert.equal(capabilityId,read);
   assert.equal(args.max_pages,1);
   return {result:unreadResult,providerTool:"wechat_unread_list"};
  }
 });
 assert.equal(calls,1);
 assert.equal(result.state,"SUCCEEDED_VERIFIED",JSON.stringify(result).slice(0,450));
 assert.ok(JSON.stringify(result).includes("Some Group"));
});

test("planning guidance uses fast bounded first page without asserting global negatives",()=>{
 const {prompt}=prepareFastGeneralPlan({goal:"Is there a new message in WeChat?",
  kataCapabilityIds:[read,"tool.cf.wechat_conversation_list"]});
 assert.ok(prompt.includes("limit:10"));
 assert.ok(prompt.includes("max_pages:1"));
 assert.ok(prompt.includes("incomplete"));
 assert.ok(prompt.includes("answer.kind conversations requires documented"));
});

test("once-only answer-origin repair includes diagnostic but never rejected text",()=>{
 const prefix="ORIGINAL OWNER AUTHORIZED PROMPT";
 const r=diagnosticRetryPrompt(prefix,"TOOL_ANSWER_CONVERSATION_ORIGIN_INVALID");
 assert.ok(r.startsWith(prefix));
 assert.ok(r.includes("VALIDATION CODE"));
 assert.ok(r.includes("OUTPUT ORIGIN"));
 assert.equal(diagnosticRetryPrompt(prefix,"TOOL_PLAN_MODE_FIELDS_INVALID"),prefix);
 assert.throws(()=>diagnosticRetryPrompt("X".repeat(174001),
 "TOOL_ANSWER_CONVERSATION_ORIGIN_INVALID"),
 e=>e.code==="FAST_PLAN_RETRY_PROMPT_BUDGET_EXCEEDED");
});
