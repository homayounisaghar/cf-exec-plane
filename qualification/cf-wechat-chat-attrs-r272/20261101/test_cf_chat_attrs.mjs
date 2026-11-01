import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

// Tested against the actual integrity-checked running release module, never a
// lookalike hand-written reimplementation of the CF normalization boundary.
const baselineFile=process.env.CF_WECHAT_INGRESS_BASELINE;
const patchFile=process.env.CF_CHAT_ATTRIBUTE_PATCH;
if(!baselineFile||!patchFile)throw Error("EXACT_SOURCE_AND_PATCH_REQUIRED");
const baseline=fs.readFileSync(baselineFile,"utf8");
const patch=JSON.parse(fs.readFileSync(patchFile,"utf8"));
assert.equal(patch.schema,"cf.wechat.conversation-attributes-projection.v1");
assert.equal(patch.target_file,"wechat-ingress.mjs");
assert.equal(baseline.split(patch.baseline_fragment).length,2,"one exact old mapping");
const updated=baseline.replace(patch.baseline_fragment,patch.candidate_fragment);
assert.equal(updated.split(patch.candidate_fragment).length,2);
const begin=updated.indexOf("function normalizeConversation(item) {");
const end=updated.indexOf("\nasync function currentConversations(",begin);
assert.ok(begin>=0&&end>begin);
const projection=vm.runInNewContext("("+updated.slice(begin,end)+")");

test("native true passes through without positional or name-based assumptions",()=>{
 const p=projection({name:"Unrelated Group",pinned:true,
  unread_count:4,selected:true,muted:true,preview:"Hello"});
 assert.equal(p.pinned,true);assert.equal(p.has_unread,true);
 assert.equal(p.unread_count,4);assert.equal(p.muted,true);
 assert.equal(p.preview,"Hello");assert.equal(p.name,"Unrelated Group");
});
test("an explicitly observed false stays false",()=>{
 assert.equal(projection({name:"Another Group",pinned:false}).pinned,false);
});
test("missing, null, or text status is UNKNOWN and never guessed",()=>{
 for(const v of [undefined,null,"true",1,0]){
  assert.equal(projection({name:"Another Group",pinned:v}).pinned,null);
 }
 assert.equal(projection({name:"Pinned to top",preview:"Pinned to top"}).pinned,null);
});
test("no change to unread and identity outputs",()=>{
 const a=projection({name:"File Transfer",unread_count:0,selected:false});
 assert.equal(a.unread_count,0);assert.equal(a.has_unread,false);
 assert.equal(a.conversation_ref,"wechat-name:File%20Transfer");
 assert.equal(a.source,"bounded_atspi_semantic_helper");
});
