import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {randomUUID,createHash} from "node:crypto";
import {openWorkflow} from "./dexa_workflow_kernel.mjs";
import {parseTypedPlan} from "./dexa_tool_plan_v3.mjs";
import {executeTypedPlan} from "./dexa_tool_plan_executor_v3.mjs";
import {adoptRecentVerifiedReplanPrefix} from "./dexa_verified_replan_prefix_v1.mjs";

const hash=x=>createHash("sha256").update(JSON.stringify(x)).digest("hex");
const id="tool.cf.wechat_conversation_list";
const base=[{id:1,kind:"TOOL",capabilityId:id,args:{limit:50},deps:[]}];
const filter={id:2,kind:"TRANSFORM",op:"FILTER",source:{step:1,path:["conversations"]},
 predicate:{path:["pinned"],op:"equal",value:true},deps:[1]};
const only={id:3,kind:"TRANSFORM",op:"ONLY",source:{step:2,path:[]},deps:[2]};
const recipe=withOnly=>JSON.stringify({schema:"dexa.tool-plan.v3",
 steps:withOnly?[...base,filter,only]:[...base,filter],
 checks:[{step:2,path:[],op:"exists"}],
 output:{step:2,path:[],format:"json"},answer:{kind:"conversations"}});
const oldRaw=recipe(false),newRaw=recipe(true);
const steps1=parseTypedPlan(oldRaw,[id]).steps;
const steps2=parseTypedPlan(newRaw,[id]).steps;
function receipt(step,result,effectClass="READ",age=0){
 const now=new Date(Date.now()-age).toISOString();
 return {receiptId:"v3:"+step.id+":"+randomUUID(),stepId:step.id,
  kind:step.kind,capabilityId:step.capabilityId||"LOCAL",
  status:"SUCCEEDED_VERIFIED",resultVerified:true,
  outputDigest:hash(result),effectClass,completedAt:now,startedAt:now};
}
async function setup(t,{changed=false,age=1000,result=null,inFlight=false}={}){
 const storeDir=fs.mkdtempSync(path.join(os.tmpdir(),"dexa-prefix-"));
 t.after(()=>fs.rmSync(storeDir,{recursive:true,force:true}));
 const missionId=randomUUID();
 const raw1=oldRaw,raw2=changed?JSON.stringify({...JSON.parse(newRaw),
  steps:[{...base[0],args:{limit:40}},filter,only]}):newRaw;
 const s2=parseTypedPlan(raw2,[id]).steps;
 const first=await openWorkflow({storeDir,missionId,planVersion:1,planRaw:raw1,steps:steps1});
 const response=result||{state:"ACHIEVED",read_state_changed:false,
  conversations:[{name:"Group",pinned:true}]};
 await first.begin(steps1[0],{inputHash:"a",readOnly:true});
 await first.complete(steps1[0],{result:response,receipt:receipt(steps1[0],response,"READ",age),inputHash:"a"});
 if(inFlight)await first.begin(steps1[1],{inputHash:"b",readOnly:true});
 else{
  const filtered=response.conversations.filter(x=>x.pinned===true);
  await first.begin(steps1[1],{inputHash:"b",readOnly:true});
  await first.complete(steps1[1],{result:filtered,
   receipt:receipt(steps1[1],filtered,"PURE_LOCAL",age),inputHash:"b"});
 }
 const next=await openWorkflow({storeDir,missionId,planVersion:2,planRaw:raw2,steps:s2});
 const mission={id:missionId,planVersion:2,stepReceipts:[],plans:[
  {planVersion:1,rawRecipe:raw1,steps:steps1},
  {planVersion:2,rawRecipe:raw2,steps:s2}]};
 return {workflowStoreDir:storeDir,mission,steps:s2,workflow:next};
}

test("identical verified fresh no-effect prefix is adopted with zero second reads",async t=>{
 const f=await setup(t);const adopted=await adoptRecentVerifiedReplanPrefix(f);
 assert.equal(adopted,2);
 assert.deepEqual(f.workflow.summary().completedStepIds,[1,2]);
 assert.equal(f.workflow.get(f.steps[0]).receipt.replayedFromPlanVersion,1);
 assert.equal(f.workflow.get(f.steps[1]).result[0].pinned,true);
});
test("different read parameters never inherit result",async t=>{
 const f=await setup(t,{changed:true});
 assert.equal(await adoptRecentVerifiedReplanPrefix(f),0);
});
test("stale observations never cross replan",async t=>{
 const f=await setup(t,{age:22000});
 assert.equal(await adoptRecentVerifiedReplanPrefix(f),0);
});
test("read that changed provider read state must not be reused",async t=>{
 const f=await setup(t,{result:{state:"ACHIEVED",read_state_changed:true,
  conversations:[{name:"Group",pinned:true}]}});
 assert.equal(await adoptRecentVerifiedReplanPrefix(f),0);
});
test("nonterminal or missing status cannot be reused",async t=>{
 const f=await setup(t,{result:{state:"PENDING",read_state_changed:false,
  conversations:[{name:"Group",pinned:true}]}});
 assert.equal(await adoptRecentVerifiedReplanPrefix(f),0);
});
test("prior in-flight uncertainty blocks adoption",async t=>{
 const f=await setup(t,{inFlight:true});
 assert.equal(await adoptRecentVerifiedReplanPrefix(f),0);
});
test("historical verified write blocks read reuse",async t=>{
 const f=await setup(t);
 f.mission.stepReceipts=[{status:"SUCCEEDED_VERIFIED",effectClass:"WRITE"}];
 assert.equal(await adoptRecentVerifiedReplanPrefix(f),0);
});
test("stable restart does not duplicate already adopted steps",async t=>{
 const f=await setup(t);
 assert.equal(await adoptRecentVerifiedReplanPrefix(f),2);
 assert.equal(await adoptRecentVerifiedReplanPrefix(f),2);
 assert.deepEqual(f.workflow.summary().completedStepIds,[1,2]);
});

test("replanned typed executor consumes transferred checkpoints with ZERO physical rereads",async t=>{
 const f=await setup(t);
 assert.equal(await adoptRecentVerifiedReplanPrefix(f),2);
 let providerCalls=0;
 const out=await executeTypedPlan(newRaw,{
  allowedCapabilities:[id],workflow:f.workflow,
  toolInvoker:async()=>{providerCalls++;throw Error("PROVIDER_REREAD_FORBIDDEN")}
 });
 assert.equal(providerCalls,0);
 assert.equal(out.state,"SUCCEEDED_VERIFIED",JSON.stringify(out).slice(0,440));
 assert.deepEqual(f.workflow.summary().completedStepIds,[1,2,3]);
});
