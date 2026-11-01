import test from "node:test";
import assert from "node:assert/strict";
import {parseTypedPlan} from "./dexa_tool_plan_v3.mjs";
import {compileFastGeneralMissionPlan,STRUCTURAL_RETRY_CODES}
 from "./dexa_general_plan_cycle_v2.mjs";
const good={schema:"dexa.tool-plan.v3",
 steps:[{id:1,kind:"TOOL",deps:[],capabilityId:"tool.cf.wechat_conversation_list",
 args:{limit:9}}],
 checks:[{step:1,path:["conversations"],op:"non_empty"}],
 output:{step:1,path:["conversations"],format:"json"},
 answer:{kind:"conversations"}};
const invalid={schema:"dexa.tool-plan.v3",
 steps:[{id:1,kind:"TOOL",deps:[],capabilityId:"tool.cf.telegram_capability_list",args:{}}],
 checks:[{step:1,path:["capabilities"],op:"exists"}],
 output:{step:1,path:["capabilities"],format:"json"},
 answer:{kind:"conversations"}};
const allowed=["tool.cf.wechat_conversation_list","tool.cf.telegram_capability_list"];

test("typed answer origin mismatch remains an unconditional zero-effect parser rejection",()=>{
 assert.throws(()=>parseTypedPlan(JSON.stringify(invalid),allowed),
 e=>e.code==="TOOL_ANSWER_CONVERSATION_ORIGIN_INVALID");
 assert.doesNotThrow(()=>parseTypedPlan(JSON.stringify(good),allowed));
 assert.equal(STRUCTURAL_RETRY_CODES.has("TOOL_ANSWER_CONVERSATION_ORIGIN_INVALID"),true);
 assert.equal(STRUCTURAL_RETRY_CODES.has("TOOL_ANSWER_MESSAGES_ORIGIN_INVALID"),true);
 assert.equal(STRUCTURAL_RETRY_CODES.has("GENERAL_PLAN_IDENTITY_NOT_PROVIDER_GROUNDED"),false);
});
test("proven answer-origin schema mismatch gets one already-authorized same-prompt correction, no provider tools",async()=>{
 let calls=0,reservations=0,prompt;
 const out=await compileFastGeneralMissionPlan({
  goal:"Do I have new messages in WeChat?",
  kataCapabilityIds:allowed,
  askModel:async p=>{
   calls++;
   if(calls===1)prompt=p;
   else assert.equal(p,prompt);
   return {recipe:JSON.stringify({schema:"dexa.owner-decision.v1",
    decision:"EXECUTE",plan:calls===1?invalid:good}),model:"fixture"};
  },
  claimStructuralRetry:async({validationCode,modelCallCount})=>{
   assert.equal(validationCode,"TOOL_ANSWER_CONVERSATION_ORIGIN_INVALID");
   assert.equal(modelCallCount,1);
   reservations++;
   return true;
  }
 });
 assert.equal(calls,2);
 assert.equal(reservations,1);
 assert.equal(out.decision,"SELECT");
 assert.equal(out.parsed.steps.length,1);
 assert.deepEqual(out.parsed.output.path,["conversations"]);
});
test("without durable retry reservation a schema mismatch rejects without a second model send",async()=>{
 let calls=0;
 await assert.rejects(()=>compileFastGeneralMissionPlan({
  goal:"Do I have new messages in WeChat?",kataCapabilityIds:allowed,
  askModel:async()=>{calls++;return {recipe:JSON.stringify({
   schema:"dexa.owner-decision.v1",decision:"EXECUTE",plan:invalid}),model:"fixture"};}
 }),e=>e.code==="FAST_PLAN_VALIDATION_REJECTED"&&
 e.validationCode==="TOOL_ANSWER_CONVERSATION_ORIGIN_INVALID");
 assert.equal(calls,1);
});
