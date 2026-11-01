import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {pathToFileURL} from "node:url";

const file=process.env.WECHAT_CF_CANDIDATE;
if(!file)throw Error("WECHAT_CF_CANDIDATE_REQUIRED");
const m=await import(pathToFileURL(file).href);
function z(){
 const chain=()=>({trim(){return this},min(){return this},max(){return this},
  int(){return this},optional(){return this}});
 return {string:chain,number:chain,boolean:chain};
}
function harness(){
 const reg=new Map();
 const server={registerTool:(name,meta,fn)=>reg.set(name,{meta,fn})};
 m.registerWeChatConversationTool(server,z(),{semanticUrl:"http://cf-fixture.invalid"});
 return reg;
}

test("new tool appears once, type is conditional read and default is no mark-read",()=>{
 const reg=harness();
 assert.ok(reg.has("wechat_message_list"));
 const x=reg.get("wechat_message_list");
 assert.equal(x.meta.annotations.readOnlyHint,false);
 assert.equal(typeof x.fn,"function");
});
test("bounded native read returns actual rows and observed side-effect envelope",async()=>{
 const reg=harness(), f=reg.get("wechat_message_list").fn;
 const existing=globalThis.fetch;
 const seen=[];
 globalThis.fetch=async(url,opts)=>{
  seen.push({url:String(url),body:JSON.parse(opts.body)});
  return {ok:true,json:async()=>({
   ok:true,provider:"wechat",state:"ACHIEVED",
   conversation:"Exact Chat",scope:"bounded_visible_messages_only",
   complete:false,returned:1,read_state_changed:false,
   realization:{source:"native_wechat_accessibility_visible_rows"},
   side_effects:{chat_selection_possible:true,read_state_changed:false},
   messages:[{body:"Fixture",direction:"unknown",sender:null}]
  })};
 };
 try{
  const x=await f({target:"Exact Chat",limit:3});
  assert.equal(x.structuredContent.state,"ACHIEVED");
  assert.equal(x.structuredContent.ok,true);
  assert.equal(x.structuredContent.operation,undefined); // the mock omits it, no synthesis.
  assert.equal(x.structuredContent.complete,false);
  assert.equal(seen.length,1);
  assert.deepEqual(seen[0].body,{target:"Exact Chat",limit:3,allow_mark_read:false});
 }finally{globalThis.fetch=existing}
});
test("wrong target, scope or invented completion is rejected",async()=>{
 const reg=harness(), f=reg.get("wechat_message_list").fn;
 const save=globalThis.fetch;
 globalThis.fetch=async()=>({ok:true,json:async()=>({
  ok:true,state:"ACHIEVED",provider:"wechat",
  conversation:"Other",scope:"global_history",complete:true,messages:[]
 })});
 try{
  const x=await f({target:"Exact Chat"});
  assert.equal(x.structuredContent.state,"FAILED");
  assert.equal(x.structuredContent.error.code,"WECHAT_MESSAGE_LIST_PROOF_INVALID");
 }finally{globalThis.fetch=save}
});
