import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {validateGenericPlanContract,providerIdentityArgumentFields}
 from './dexa_general_plan_contract_v1.mjs';
import {executeTypedPlan} from './dexa_tool_plan_executor_v3.mjs';
import {openWorkflow} from './dexa_workflow_kernel.mjs';
import {catalogKnownOutputShape} from './dexa_catalog_output_adapters_v1.mjs';
const IDS=[
 'tool.cf.telegram_conversation_search',
 'tool.cf.telegram_attachment_get',
 'tool.cf.wechat_conversation_list',
 'tool.cf.wechat_conversation_search',
 'tool.cf.wechat_file_upload','tool.cf.wechat_file_upload_chunk',
 'tool.cf.wechat_file_send',
];
const plan=()=>({schema:'dexa.tool-plan.v3',steps:[
 {id:1,kind:'TOOL',capabilityId:IDS[0],
  args:{query:'Saved Messages',limit:10},deps:[]},
 {id:2,kind:'TRANSFORM',op:'MATCH',mode:'normalized_exact',
  source:{step:1,path:['conversations']},query:'Saved Messages',
  fields:[['name']],deps:[1]},
 {id:3,kind:'TOOL',capabilityId:IDS[1],deps:[2],
  args:{conversation:{$ref:{step:2,path:['handle']}},
   latest_message:true,portable_format:'original'}},
 {id:4,kind:'TOOL',capabilityId:IDS[2],
  args:{limit:40,max_pages:2},deps:[]},
 {id:5,kind:'TRANSFORM',op:'MATCH',mode:'normalized_exact',
  source:{step:4,path:['conversations']},query:'File Transfer',
  fields:[['name']],deps:[4]},
 {id:6,kind:'TOOL',capabilityId:IDS[4],mode:'STREAM',
  chunkCapabilityId:IDS[5],source:{step:3,path:[]},
  args:{action:'create'},deps:[3]},
 {id:7,kind:'TOOL',capabilityId:IDS[6],deps:[5,6],
  args:{target:{$ref:{step:5,path:['name']}},
        upload_id:{$ref:{step:6,path:['upload_id']}}}}
 ],checks:[{step:7,path:['state'],op:'equal',value:'UI_OUTBOUND_OBSERVED'}],
 output:{step:7,path:['state'],format:'text'},answer:{kind:'json'}});
const code=e=>e?.code||e?.message||'UNKNOWN';
test('native metadata: provider read evidence distinct from native exact-name recipient',()=>{
 const source=catalogKnownOutputShape(IDS[2]);
 const dest=catalogKnownOutputShape(IDS[6]);
 assert.ok(source.arrays.conversations.fields.includes('name'));
 assert.ok(source.arrays.conversations.fields.includes('conversation_ref'));
 assert.equal(source.arrays.conversations.fields.includes('handle'),false);
 assert.equal(dest.identityInputs.target.kind,'NATIVE_UNIQUE_EXACT_LABEL');
 assert.equal(dest.identityInputs.target.nativeOperationVerifiesUniqueExactRecipient,true);
 assert.deepEqual(providerIdentityArgumentFields(IDS[6]),['target']);
});
test('same-provider native conversation list -> exact UNIQUE MATCH -> bound send and source are admitted',()=>{
 const accepted=validateGenericPlanContract(JSON.stringify(plan()),IDS);
 assert.equal(accepted.typed.steps.length,7);
 assert.equal(accepted.typed.steps[6].args.target.$ref.step,5);
 assert.equal(accepted.typed.steps[6].args.target.$ref.path[0],'name');
 assert.equal(accepted.typed.steps[2].args.conversation.$ref.step,2);
 assert.equal(accepted.typed.steps[5].mode,'STREAM');
});
test('literal send target remains forbidden; a read-only conversation label may be closed via observed provider lookup',()=>{
 const unsafe=plan();unsafe.steps[6].args.target='File Transfer';
 unsafe.steps[6].deps=[6];
 assert.throws(()=>validateGenericPlanContract(JSON.stringify(unsafe),IDS),
  e=>code(e)==='GENERAL_PLAN_IDENTITY_NOT_PROVIDER_GROUNDED');
 const read=plan();read.steps[2].args.conversation='Saved Messages';
 read.steps[2].deps=[];
 const valid=validateGenericPlanContract(JSON.stringify(read),IDS);
 assert.match(valid.rule,/VERIFIED_READ_IDENTITY_DEPENDENCY_CLOSURE/);
 assert.equal(valid.typed.steps[4].args.conversation.$ref.path[0],'handle');
});
test('reject canonical read-only handle and search with no audited native target source',()=>{
 for(const sourcePath of [['canonical_conversations'],['messages']]){
  const p=plan();p.steps[4].source.path=sourcePath;
  assert.throws(()=>validateGenericPlanContract(JSON.stringify(p),IDS));
 }
 const p=plan();p.steps[3].capabilityId=IDS[3];p.steps[3].args={query:'File Transfer'};
 assert.throws(()=>validateGenericPlanContract(JSON.stringify(p),IDS));
});
test('fuzzy/first/non-unique selection, fake field, cross-provider source rejected',()=>{
 for(const change of [
  p=>p.steps[4].mode='safe_unique',
  p=>p.steps[4].fields=[['unread_count']],
  p=>p.steps[6].args.target.$ref.path=['conversation_ref'],
  p=>p.steps[4].op='TAKE',
  p=>{p.steps[4].source.step=1;p.steps[4].deps=[1];},
  p=>{p.steps[4].mode='safe_unique';p.steps[4].query='Transfer';}
 ]){
  const p=plan();change(p);
  assert.throws(()=>validateGenericPlanContract(JSON.stringify(p),IDS));
 }
});
test('mock native recipient matching enforces exact unique and never sends on duplicate',async()=>{
 const tmp=await fs.mkdtemp(path.join(os.tmpdir(),'dexa-identity-only-'));
 try{
  // No native provider request: only read mocks and a duplicate result.
  const id=randomUUID(),p=plan();
  let writes=0;
  const call=async({capabilityId})=>{
   if(capabilityId===IDS[0])return{providerTool:'telegram_conversation_search',
    result:{state:'ACHIEVED',conversations:[{name:'Saved Messages',
     handle:'tgchat:verified'}]}};
   if(capabilityId===IDS[2])return{providerTool:'wechat_conversation_list',
    result:{state:'ACHIEVED',conversations:[
     {name:'File Transfer',conversation_ref:'wechat-name:File%20Transfer'},
     {name:'File Transfer',conversation_ref:'wechat-name:Duplicate'}]}};
   if(capabilityId===IDS[1])return{providerTool:'telegram_attachment_get',
    result:{state:'ACHIEVED',resource_links:[]}};
   writes++;throw Error('WRITES_MUST_NOT_HAPPEN_AFTER_DUPLICATE');
  };
  const typed=validateGenericPlanContract(JSON.stringify(p),IDS);
  const wf=await openWorkflow({storeDir:tmp,missionId:id,planVersion:1,
   planRaw:typed.raw,steps:typed.typed.steps});
  const result=await executeTypedPlan(typed.raw,{allowedCapabilities:IDS,
   workflow:wf,toolInvoker:call,connectionProbe:async()=>true});
  assert.notEqual(result.state,'SUCCEEDED_VERIFIED');
  assert.equal(writes,0);
 }finally{await fs.rm(tmp,{recursive:true,force:true})}
});

test('provider-neutral read closure works in mixed read + STREAM + write without touching target',()=>{
 const p=plan();
 p.steps=[
  {id:1,kind:'TOOL',capabilityId:'telegram.message.read_recent',
   args:{conversation:'Saved Messages',limit:3},deps:[]},
  {id:2,kind:'TOOL',capabilityId:IDS[1],
   args:{message_handle:{$ref:{step:1,path:['messages',0,'handle']}},
     portable_format:'original'},deps:[1]},
  {id:3,kind:'TOOL',capabilityId:IDS[2],args:{limit:40,max_pages:2},deps:[]},
  {id:4,kind:'TRANSFORM',op:'MATCH',mode:'normalized_exact',
   source:{step:3,path:['conversations']},query:'File Transfer',
   fields:[['name']],deps:[3]},
  {id:5,kind:'TOOL',capabilityId:IDS[4],mode:'STREAM',deps:[2],
   source:{step:2,path:[]},chunkCapabilityId:IDS[5],args:{action:'create'}},
  {id:6,kind:'TOOL',capabilityId:IDS[6],deps:[4,5],
   args:{target:{$ref:{step:4,path:['name']}},
     upload_id:{$ref:{step:5,path:['upload_id']}}}}
 ];
 p.checks=[{step:6,path:['state'],op:'equal',value:'UI_OUTBOUND_OBSERVED'}];
 p.output={step:6,path:['state'],format:'text'};
 const valid=validateGenericPlanContract(JSON.stringify(p),
  [...IDS,'telegram.message.read_recent']);
 assert.equal(valid.typed.steps.length,8);
 assert.match(valid.rule,/VERIFIED_READ_IDENTITY_DEPENDENCY_CLOSURE/);
 const source=valid.typed.steps[2];
 assert.equal(source.capabilityId,'telegram.message.read_recent');
 assert.deepEqual(source.args.conversation,{$ref:{step:2,path:['handle']}});
 const send=valid.typed.steps.at(-1);
 assert.equal(send.capabilityId,IDS[6]);
 assert.deepEqual(send.args.target,{$ref:{step:6,path:['name']}});
 assert.deepEqual(send.args.upload_id,{$ref:{step:7,path:['upload_id']}});
 assert.equal(valid.typed.steps[6].mode,'STREAM');
 // A literal send target is never upgraded/authorized.
 p.steps[5].args.target='File Transfer';
 assert.throws(()=>validateGenericPlanContract(JSON.stringify(p),
  [...IDS,'telegram.message.read_recent']),
  e=>['GENERAL_PLAN_IDENTITY_NOT_PROVIDER_GROUNDED',
    'TOOL_PLAN_UNDECLARED_DATA_DEPENDENCY'].includes(code(e)));
});
test('universal decision compiler admits provider-bound send without provider calls',async()=>{
 const {compileFastGeneralMissionPlan}=await import('./dexa_general_plan_cycle_v2.mjs');
 const goal='Copy an observed attachment to the exact owner-named self chat; send once.';
 const modelReply=JSON.stringify({schema:'dexa.owner-decision.v1',
  decision:'EXECUTE',plan:plan()});
 let modelCalls=0,providerCalls=0;
 const admitted=await compileFastGeneralMissionPlan({
  goal,kataCapabilityIds:IDS,
  askModel:async()=>{modelCalls++;return{recipe:modelReply,model:'fixture'}},
  onProgress:async()=>{},
 });
 assert.equal(modelCalls,1);
 assert.equal(providerCalls,0);
 assert.equal(admitted.decision,'SELECT');
 assert.equal(admitted.ownerDecision.decision,'EXECUTE');
 assert.equal(admitted.parsed.steps.length,7);
 assert.ok(admitted.parsed.steps.some(x=>x.mode==='STREAM'));
 assert.ok(admitted.parsed.steps.some(x=>x.capabilityId===IDS[6]));
});
