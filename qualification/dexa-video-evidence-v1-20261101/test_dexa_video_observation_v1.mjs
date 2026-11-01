import test from 'node:test';
import assert from 'node:assert/strict';
import {catalogRoute} from './dexa_catalog_registry.mjs';
import {catalogKnownOutputShape} from './dexa_catalog_output_adapters_v1.mjs';
import {attachCanonicalMessagingView}
 from './dexa_messaging_record_contract_v1.mjs';
import {validateGenericPlanContract}
 from './dexa_general_plan_contract_v1.mjs';
import {applyTypedTransform} from './dexa_tool_plan_v3.mjs';
import {executeTypedPlan} from './dexa_tool_plan_executor_v3.mjs';
const search='tool.cf.telegram_conversation_search';
const read='telegram.message.read_recent';
const allowed=[search,read];
const observedRows=[
 {handle:'tgmsg:video-latest',kind:'message',date:1793478611,
  media_type:'messageMediaDocument',media_open_kind:null,
  attachments:[{handle:'tgatt:first',media_kind:'video',
   media_type:'video/mp4',size_bytes:4057059,width:720,height:1280}]},
 {handle:'tgmsg:video-document',kind:'message',date:1793459745,
  media_type:'messageMediaDocument',media_open_kind:null,
  attachments:[{handle:'tgatt:second',media_kind:'file',
   media_type:'video/mp4',size_bytes:2927052}]},
 {handle:'tgmsg:no-media',kind:'message',date:1793433782,
  media_type:null,media_open_kind:null,attachments:[]},
 {handle:'tgmsg:animated-gif',kind:'message',date:1793428929,
  media_type:'messageMediaDocument',media_open_kind:null,
  attachments:[{handle:'tgatt:gif',media_kind:'gif',
   media_type:'video/mp4',size_bytes:12345}]},
 {handle:'tgmsg:other-file',kind:'message',date:1793427815,
  media_type:'messageMediaDocument',media_open_kind:null,
  attachments:[{handle:'tgatt:pdf',media_kind:'file',
   media_type:'application/pdf',size_bytes:1234}]},
 {handle:'tgmsg:filename-not-proof',kind:'message',date:1793427814,
  media_type:'messageMediaDocument',media_open_kind:null,
  attachments:[{handle:'tgatt:bad',media_kind:'file',
   media_type:'application/octet-stream',filename:'unverified.mp4'}]}
];
const plan=()=>({schema:'dexa.tool-plan.v3',
 steps:[
  {id:1,kind:'TOOL',capabilityId:search,
   args:{query:'Owner Notes',limit:10},deps:[]},
  {id:2,kind:'TRANSFORM',op:'MATCH',mode:'safe_unique',
   source:{step:1,path:['conversations']},query:'Owner Notes',
   fields:[['name']],deps:[1]},
  {id:3,kind:'TOOL',capabilityId:read,
   args:{conversation:{$ref:{step:2,path:['handle']}},limit:20},deps:[2]},
  {id:4,kind:'TRANSFORM',op:'FILTER',
   source:{step:3,path:['messages']},
   predicate:{path:['media_open_kind'],op:'equal',value:'video'},deps:[3]},
  {id:5,kind:'TRANSFORM',op:'SORT',
   source:{step:4,path:[]},path:['date'],direction:'desc',deps:[4]},
  {id:6,kind:'TRANSFORM',op:'TAKE',
   source:{step:5,path:[]},count:1,deps:[5]},
  {id:7,kind:'TRANSFORM',op:'ONLY',
   source:{step:6,path:[]},deps:[6]}
 ],checks:[],output:{step:7,path:['handle'],format:'text'},
 answer:{kind:'text'}
});
const converted=()=>attachCanonicalMessagingView({nativeTool:'telegram_message_list',
 readOnly:true,result:{state:'ACHIEVED',ordering:'newest_first',
 count:observedRows.length,messages:structuredClone(observedRows)}});
test('observed video documents with absent native media_open_kind remain intact',()=>{
 const r=converted();
 assert.equal(r.messages.length,6);
 assert.equal(r.messages[0].media_open_kind,null);
 assert.equal(r.messages[1].media_open_kind,null);
 assert.equal(r.canonical_messages.length,6);
 assert.equal(r.canonical_meta.no_additional_provider_reads,true);
 assert.equal(r.canonical_messages[0].handle,r.messages[0].handle);
 assert.equal(r.canonical_messages[1].handle,r.messages[1].handle);
});
test('audited MIME refines generic document/file; specific GIF overrides video/mp4',()=>{
 const r=converted();
 assert.deepEqual(r.canonical_messages.map(x=>x.type),
  ['video','video','text','gif','file','file']);
 assert.equal(r.canonical_messages[0].attachments[0].kind,'video');
 assert.equal(r.canonical_messages[1].attachments[0].kind,'video');
 assert.equal(r.canonical_messages[3].attachments[0].kind,'gif');
 assert.equal(r.canonical_messages[5].attachments[0].kind,'file');
});
test('native misleading video category rewrites to same-read canonical message type',()=>{
 const a=catalogKnownOutputShape(read);
 assert.equal(a.canonicalContract.additiveToProviderNative,true);
 assert.equal(a.canonicalContract.collection,'canonical_messages');
 assert.equal(a.arrays.messages.semanticValueMappings.media_open_kind.video.collection,
  'canonical_messages');
 const result=validateGenericPlanContract(JSON.stringify(plan()),allowed);
 assert.match(result.rule,/VERIFIED_PROVIDER_CATEGORY_CANONICALIZATION/);
 assert.deepEqual(result.typed.steps[3].source.path,['canonical_messages']);
 assert.deepEqual(result.typed.steps[3].predicate,
  {path:['type'],op:'equal',value:'video'});
 assert.deepEqual(result.typed.steps[4].path,['date']);
 assert.deepEqual(result.typed.steps[6].source,{step:6,path:[]});
 assert.equal(validateGenericPlanContract(result.raw,allowed).raw,result.raw);
});
test('provider observation reproduces previous empty result and fixed latest-video result',()=>{
 const source=converted();
 const native=observedRows.filter(m=>m.media_open_kind==='video');
 assert.equal(native.length,0,'old filter spuriously found no videos');
 const checked=validateGenericPlanContract(JSON.stringify(plan()),allowed).typed;
 const result=new Map([[3,source]]);
 for(const step of checked.steps.slice(3)){
  result.set(step.id,applyTypedTransform(step,result));
 }
 const videoRows=result.get(4);
 assert.equal(videoRows.length,2,'only actual video media, never generic documents or GIFs');
 assert.equal(result.get(7).handle,'tgmsg:video-latest');
 assert.equal(result.get(7).date,1793478611);
});
test('end-to-end read-only Rana typed execution selects correct video, no send',async()=>{
 const checked=validateGenericPlanContract(JSON.stringify(plan()),allowed);
 let reads=0,writes=0;
 const result=await executeTypedPlan(checked.raw,{
  allowedCapabilities:allowed,
  toolInvoker:async({capabilityId,args})=>{
   reads++;
   if(capabilityId===search)return{
    providerTool:catalogRoute(search).cfName,
    result:{state:'ACHIEVED',conversations:[
     {name:'Owner Notes',handle:'tgchat:verified'}]}
   };
   assert.equal(capabilityId,read);
   assert.equal(args.conversation,'tgchat:verified');
   assert.equal(args.limit,20);
   return{providerTool:catalogRoute(read).cfName,
    result:{state:'ACHIEVED',count:observedRows.length,
     ordering:'newest_first',messages:structuredClone(observedRows)}};
  }});
 assert.equal(reads,2);
 assert.equal(writes,0);
 assert.equal(result.state,'SUCCEEDED_VERIFIED',result.reason);
 assert.match(result.result,/tgmsg:video-latest/);
});
test('unsupported synthetic native field values are never broadly rewritten',()=>{
 const p=plan();
 p.steps[3].predicate.value='unknown-media-kind';
 const result=validateGenericPlanContract(JSON.stringify(p),allowed);
 assert.deepEqual(result.typed.steps[3].source.path,['messages']);
 assert.deepEqual(result.typed.steps[3].predicate.path,['media_open_kind']);
});
