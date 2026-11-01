import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {randomUUID} from "node:crypto";
import {createCerebrasApiPlanner,cerebrasApiPlannerStatus,CEREBRAS_API_TRANSPORT}
 from "./cerebras_api_planner.mjs";
import {deriveRuntimeProvenance} from "./mission_provenance.mjs";

const missionId=randomUUID();
const syntheticPrompt="Produce one valid readonly plan in JSON; do not invoke any tool.";
const reply=(content='{"schema":"dexa.tool-plan.v3","steps":[]}')=>
 new Response(JSON.stringify({choices:[{finish_reason:"stop",
  message:{content}}],usage:{prompt_tokens:100,completion_tokens:32,total_tokens:132}}),
  {status:200,headers:{"content-type":"application/json"}});
function setup(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),"dexa-api-config-"));
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const keyFile=path.join(dir,"cerebras-api.env");
 fs.writeFileSync(keyFile,"CEREBRAS_API_KEY=csk-"+"a".repeat(42)+"\n",{mode:0o600});
 return keyFile;
}
test("Cerebras API route is opt-in, does not remove original phone bridge, and requires full reply before Rana",()=>{
 const s=fs.readFileSync(new URL("./server.mjs",import.meta.url),"utf8");
 assert.match(s,/const CEREBRAS_API_ACTIVE=CEREBRAS_LIVE&&/);
 assert.match(s,/process\.env\.DEXA_CEREBRAS_TRANSPORT==="api"/);
 assert.match(s,/CEREBRAS_PHONE_BRIDGE=CEREBRAS_LIVE&&!CEREBRAS_API_ACTIVE/);
 assert.match(s,/CEREBRAS_API_ACTIVE\?requestCerebrasApiRecipe:/);
 assert.match(s,/CEREBRAS_PHONE_BRIDGE\?requestCerebrasPhoneRecipe:requestInstantRecipe/);
 assert.match(s,/!CEREBRAS_PHONE_BRIDGE&&!CEREBRAS_API_ACTIVE/);
 assert.match(s,/CEREBRAS_API_ACTIVE\)\;/);
 assert.match(s,/if\(CEREBRAS_API_ACTIVE\)return cerebrasApiPlannerStatus\(\)/);
 assert.match(s,/const stream=\(SYNTHETIC_PLANNER\|\|CEREBRAS_FULL_RESPONSE_BEFORE_RANA\)\?null/);
});
test("API mode has truthful separate real planner provenance without changing phone mode",()=>{
 assert.equal(deriveRuntimeProvenance({
  DEXA_CEREBRAS_PLANNER_ENABLED:"1",DEXA_CEREBRAS_TRANSPORT:"api"
 }).plannerMode,"REAL_CEREBRAS_API");
 assert.equal(deriveRuntimeProvenance({
  DEXA_CEREBRAS_PLANNER_ENABLED:"1"
 }).plannerMode,"REAL_CEREBRAS_WEB");
});
test("Planner status inspects only restricted local key file; never contacts network",t=>{
 const keyFile=setup(t);
 const status=cerebrasApiPlannerStatus({keyFile,env:{}});
 assert.equal(status.ready,true);
 assert.equal(status.phase,"READY");
 assert.equal(status.transport,CEREBRAS_API_TRANSPORT);
 assert.equal(status.modelLabel,"gpt-oss-120b");
 assert.equal(Object.hasOwn(status,"apiKey"),false);
 fs.chmodSync(keyFile,0o644);
 const unsafe=cerebrasApiPlannerStatus({keyFile,env:{}});
 assert.equal(unsafe.ready,false);
 assert.equal(unsafe.lastErrorCode,"CEREBRAS_API_KEY_PERMISSIONS");
});
test("API planner returns whole plan with comparable latency and token receipts",async()=>{
 let count=0,notice=[];
 const planner=createCerebrasApiPlanner({
  readKey:()=> "csk-DO_NOT_LOG_TEST_ONLY",
  env:{DEXA_CEREBRAS_API_MODEL:"gpt-oss-120b"},
  fetchImpl:async(url,options)=>{
   count++;
   assert.equal(url,"https://api.cerebras.ai/v1/chat/completions");
   assert.equal(options.method,"POST");
   assert.match(options.headers.authorization,/^Bearer csk-/);
   const posted=JSON.parse(options.body);
   assert.equal(posted.model,"gpt-oss-120b");
   assert.equal(posted.max_completion_tokens,8500);
   assert.equal(Object.hasOwn(posted,"reasoning_effort"),false);
   assert.equal(posted.stream,false);
   assert.equal(posted.messages[0].content,syntheticPrompt);
   assert.equal(posted.messages.length,1);
   return reply();
  }
 });
 const result=await planner(syntheticPrompt,{missionId,onProgress:m=>notice.push(m)});
 assert.equal(count,1);
 assert.equal(result.transport,"CEREBRAS_API_HTTPS");
 assert.equal(result.actualBrowserBridge,false);
 assert.equal(result.didSend,true);
 assert.equal(result.model,"gpt-oss-120b");
 assert.equal(result.responseMessageCount,1);
 assert.equal(result.transportTimings.promptTokens,100);
 assert.equal(result.transportTimings.completionTokens,32);
 assert.equal(result.transportTimings.totalTokens,132);
 assert.equal(result.transportTimings.requestHash.length,64);
 assert.match(result.recipe,/dexa\.tool-plan\.v3/);
 assert.ok(Number.isFinite(result.elapsedMs)&&result.elapsedMs>=0);
 assert.equal(notice.length,2);
});
test("Alternate available Cerebras model can be selected without changing the planner contract",async()=>{
 let count=0;
 const planner=createCerebrasApiPlanner({
  readKey:()=> "csk-MOCK",
  env:{DEXA_CEREBRAS_API_MODEL:"qwen-3.8-27b"},
  fetchImpl:async(_url,options)=>{
   count++;const body=JSON.parse(options.body);
   assert.equal(body.model,"qwen-3.8-27b");
   assert.equal(body.max_completion_tokens,16000);
   assert.equal(body.reasoning_effort,"xhigh");
   assert.equal(body.stream,false);
   return reply();
  }
 });
 assert.equal((await planner(syntheticPrompt,{missionId})).model,"qwen-3.8-27b");
 assert.equal(count,1);
});
test("API failures are stable sanitized codes; failed/ambiguous sends never auto-retry",async()=>{
 for(const [responseOrError,code] of [
  [new Response(JSON.stringify({error:{message:"SUPER_SECRET"}}),{status:401}),"CEREBRAS_API_AUTH_FAILED"],
  [new Response("{}",{status:429}),"CEREBRAS_API_RATE_LIMITED"],
  [new Response("{}",{status:503}),"CEREBRAS_API_UPSTREAM_UNAVAILABLE"],
  [new Response("{}",{status:422}),"CEREBRAS_API_UPSTREAM_REJECTED"],
  [new Response("not-json",{status:200}),"CEREBRAS_API_REPLY_INVALID"],
  [new Response(JSON.stringify({choices:[{finish_reason:"length",message:{content:"partial"}}]}),{status:200}),"CEREBRAS_API_REPLY_TRUNCATED"],
  [new Error("SUPER_SECRET_TRANSPORT"),"CEREBRAS_API_SEND_IN_DOUBT"]
 ]){
  let count=0;
  const planner=createCerebrasApiPlanner({readKey:()=>"csk-MOCK",
   fetchImpl:async()=>{count++;if(responseOrError instanceof Error)throw responseOrError;
    return responseOrError.clone()}});
  await assert.rejects(planner(syntheticPrompt,{missionId}),
    e=>e.code===code&&!String(e.message).includes("SUPER_SECRET"));
  assert.equal(count,1);
 }
});
test("Missing keys/unsupported models never send API requests",async()=>{
 let count=0;
 const planner=createCerebrasApiPlanner({readKey:()=>{throw Error("NEVER_SEND")},fetchImpl:async()=>{count++}});
 await assert.rejects(planner(syntheticPrompt,{missionId}),/NEVER_SEND/);
 const invalidModel=createCerebrasApiPlanner({env:{DEXA_CEREBRAS_API_MODEL:"evil-model"},readKey:()=>"csk-MOCK",
  fetchImpl:async()=>{count++}});
 await assert.rejects(invalidModel(syntheticPrompt,{missionId}),e=>e.code==="CEREBRAS_API_MODEL_UNSUPPORTED");
 assert.equal(count,0);
});


test("Qwen model exhausting its total completion budget fails closed and never retries",async()=>{
 let count=0;
 const planner=createCerebrasApiPlanner({
  readKey:()=>"csk-MOCK",
  env:{DEXA_CEREBRAS_API_MODEL:"qwen-3.8-27b"},
  fetchImpl:async(_url,options)=>{
   count++;const request=JSON.parse(options.body);
   assert.equal(request.reasoning_effort,"xhigh");
   assert.equal(request.max_completion_tokens,16000);
   return new Response(JSON.stringify({choices:[{finish_reason:"length",
    message:{content:"unfinished json"}}]}),{status:200});
  }
 });
 await assert.rejects(planner(syntheticPrompt,{missionId}),
  error=>error.code==="CEREBRAS_API_REPLY_TRUNCATED");
 assert.equal(count,1);
});
