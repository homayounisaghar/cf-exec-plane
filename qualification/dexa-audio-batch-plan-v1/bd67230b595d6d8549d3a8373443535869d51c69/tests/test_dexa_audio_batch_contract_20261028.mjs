import test from "node:test";
import assert from "node:assert/strict";
import {buildTypedPlannerPrompt} from "./dexa_typed_planner_prompt_v3.mjs";
import {parseTypedPlan} from "./dexa_tool_plan_v3.mjs";
import {inputSchemaFor,admitCatalogCall} from "./dexa_catalog_registry.mjs";

const audioId="tool.cf.audio_transcribe";
const readId="telegram.message.read_recent";
const searchId="tool.cf.telegram_conversation_search";
const writerId="dexa.text.process";
const cards=[
 {id:searchId,description:"Search Telegram conversations",routes:[]},
 {id:readId,description:"Read recent messages",routes:[]},
 {id:audioId,description:"Transcribe one or more Telegram audio messages",routes:[]},
 {id:writerId,description:"Summarize verified source text",routes:[]},
];
const handle=i=>"tgmsg:00000000-0000-4000-8000-"+String(i).padStart(12,"0");
const fileItems=n=>Array.from({length:n},(_,i)=>({telegram_message_handle:handle(i+1)}));
function makePlan(count){
 const files=Array.from({length:count},(_,i)=>({
  telegram_message_handle:{$ref:{step:3,path:["messages",i,"handle"]}}
 }));
 return {
  schema:"dexa.tool-plan.v3",
  steps:[
   {id:1,kind:"TOOL",capabilityId:searchId,args:{query:"Test Audio Conversation",limit:10},deps:[]},
   {id:2,kind:"TRANSFORM",op:"MATCH",source:{step:1,path:["conversations"]},
    query:"Test Audio Conversation",fields:[["name"]],mode:"safe_unique",deps:[1]},
   {id:3,kind:"TOOL",capabilityId:readId,
    args:{conversation:{$ref:{step:2,path:["handle"]}},limit:count},deps:[2]},
   {id:4,kind:"TOOL",capabilityId:audioId,args:{files},deps:[3]},
   {id:5,kind:"TOOL",capabilityId:writerId,
    args:{operation:"summarize",source:{$ref:{step:4,path:["files"]}},
      instruction:"Summarize every transcript in the array, not only the first item, in one Persian paragraph.",language:"fa"},
    deps:[4]},
  ],
  checks:[{step:5,path:["text"],op:"non_empty"}],
  output:{step:5,path:["text"],format:"text"},
  answer:{kind:"text"}
 };
}
test("audio_transcribe native schema supports one batch of 1-20 identified files",()=>{
 const schema=inputSchemaFor(audioId);
 assert.equal(schema.properties.files.type,"array");
 assert.equal(schema.properties.files.minItems,1);
 assert.equal(schema.properties.files.maxItems,20);
 assert.doesNotThrow(()=>admitCatalogCall({capabilityId:audioId,args:{files:fileItems(20)},readOnlyOnly:true}));
 assert.throws(()=>admitCatalogCall({capabilityId:audioId,args:{files:fileItems(21)},readOnlyOnly:true}));
});
test("planner contract prefers one files[] batch over EACH and summarizes all transcripts",()=>{
 const prompt=buildTypedPlannerPrompt({goal:"Summarize 11 Telegram audio messages in one paragraph.",cards});
 assert.ok(prompt.includes("Batch-capable native input takes precedence over TOOL E.A.C.H."));
 assert.ok(prompt.includes("MANDATORY AUDIO BATCH CONTRACT"));
 assert.ok(prompt.includes("maxItems=20"));
 assert.ok(prompt.includes("Never use mode:EACH or issue one audio_transcribe call per file when N<=20"));
 assert.ok(prompt.includes("For multiple audio files, the writer source MUST reference the whole audio result array"));
});
test("11 audio message handles compile into one valid audio_transcribe TOOL with 11 refs",()=>{
 const parsed=parseTypedPlan(JSON.stringify(makePlan(11)),cards.map(c=>c.id));
 const audio=parsed.steps.find(s=>s.capabilityId===audioId);
 assert.ok(audio);
 assert.equal(audio.mode,undefined);
 assert.equal(audio.source,undefined);
 assert.equal(audio.maxItems,undefined);
 assert.equal(audio.args.files.length,11);
 assert.deepEqual(audio.deps,[3]);
 assert.ok(audio.args.files.every((f,i)=>f.telegram_message_handle.$ref.step===3&&
   f.telegram_message_handle.$ref.path[1]===i));
 const writer=parsed.steps.find(s=>s.capabilityId===writerId);
 assert.deepEqual(writer.args.source,{$ref:{step:4,path:["files"]}});
});
test("20 message handles fit the typed batch plan",()=>{
 const parsed=parseTypedPlan(JSON.stringify(makePlan(20)),cards.map(c=>c.id));
 assert.equal(parsed.steps.find(s=>s.capabilityId===audioId).args.files.length,20);
});
