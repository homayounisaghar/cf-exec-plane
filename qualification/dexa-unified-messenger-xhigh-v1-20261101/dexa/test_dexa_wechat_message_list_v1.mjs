import test from "node:test";
import assert from "node:assert/strict";
import {catalogCounts,catalogRoute,admitCatalogCall} from "./dexa_catalog_registry.mjs";
import {catalogKnownOutputShape} from "./dexa_catalog_output_adapters_v1.mjs";
import {parseTypedPlan} from "./dexa_tool_plan_v3.mjs";

const id="tool.cf.wechat_message_list";
const base={schema:"dexa.tool-plan.v3",
 steps:[{id:1,kind:"TOOL",capabilityId:id,
  args:{target:"File Transfer",limit:10,allow_mark_read:false},deps:[]}],
 checks:[{step:1,path:["messages"],op:"exists"}],
 output:{step:1,path:["messages"],format:"json"},
 answer:{kind:"messages"}};
test("new live catalog uses exactly one CF-native message-list route",()=>{
 const c=catalogCounts();
 assert.equal(c.catalog,298);
 assert.equal(c.cfMapped,194);
 const route=catalogRoute(id);
 assert.ok(route);
 assert.equal(route.cfName,"wechat_message_list");
 const admitted=admitCatalogCall({capabilityId:id,
  args:{target:"File Transfer",limit:10,allow_mark_read:false}});
 assert.equal(admitted.tool,"wechat_message_list");
 assert.equal(admitted.readOnly,false);
 assert.equal(admitted.effectClass,"WRITE");
});
test("native visible message collection is a real typed messages output, not invented full history",()=>{
 const shape=catalogKnownOutputShape(id).arrays.messages;
 assert.equal(shape.fullHistoryGuaranteed,false);
 assert.equal(shape.latestEdgeGuaranteed,false);
 assert.equal(shape.identityAuthority,"NO_MESSAGE_IDS_OR_VERIFIED_SENDER");
 assert.ok(shape.fields.includes("direction"));
 assert.ok(shape.fields.includes("body"));
 assert.equal(parseTypedPlan(JSON.stringify(base),[id]).steps.length,1);
});
test("incorrect output family and ungrounded handles are still rejected",()=>{
 const wrong=structuredClone(base);
 wrong.answer.kind="conversations";
 assert.throws(()=>parseTypedPlan(JSON.stringify(wrong),[id]),
  e=>String(e.code||"").includes("ORIGIN_INVALID"));
 const bad=structuredClone(base);
 bad.steps[0].args.target={$ref:{step:99,path:["name"]}};
 assert.throws(()=>parseTypedPlan(JSON.stringify(bad),[id]));
});
