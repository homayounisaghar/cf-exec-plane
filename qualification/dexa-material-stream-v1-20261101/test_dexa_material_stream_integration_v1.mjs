import test from 'node:test';
import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {parseTypedPlan} from './dexa_tool_plan_v3.mjs';
import {executeTypedPlan} from './dexa_tool_plan_executor_v3.mjs';
import {openWorkflow} from './dexa_workflow_kernel.mjs';
const sid='a'.repeat(64);
const data=Buffer.alloc(4*1024*1024+29,72);
const sha=createHash('sha256').update(data).digest('hex');
const raw=JSON.stringify({schema:'dexa.tool-plan.v3',steps:[
 {id:1,kind:'TOOL',deps:[],capabilityId:'tool.cf.telegram_attachment_get',
  args:{conversation:'Saved Messages',latest_message:true}},
 {id:2,kind:'TOOL',deps:[1],capabilityId:'tool.cf.wechat_file_upload',
  mode:'STREAM',source:{step:1,path:[]},
  chunkCapabilityId:'tool.cf.wechat_file_upload_chunk',args:{action:'create'}},
 {id:3,kind:'TOOL',deps:[2],capabilityId:'tool.cf.wechat_file_send',
  args:{target:'File Transfer',upload_id:{$ref:{step:2,path:['upload_id']}}}}
 ],checks:[{step:3,path:['state'],op:'equal',value:'UI_OUTBOUND_OBSERVED'}],
 output:{step:3,path:['state'],format:'text'}});
const allowed=['tool.cf.telegram_attachment_get','tool.cf.wechat_file_upload',
 'tool.cf.wechat_file_upload_chunk','tool.cf.wechat_file_send'];
test('one physical material stage, separate exact one-shot send, durable no-replay',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'dexa-material-flow-'));
 const fetchOriginal=globalThis.fetch;
 try{
  globalThis.fetch=async url=>{
   assert.equal(url,'https://cf-onshape.duckdns.org/mcp/telegram-file/test');
   return{ok:true,headers:{get:()=>String(data.length)},
    body:Readable.from([data.subarray(0,4),data.subarray(4)])};
  };
  const parsed=parseTypedPlan(raw,allowed);
  let fetches=0,create=0,append=0,send=0;
  const invoker=async({capabilityId,args})=>{
   if(capabilityId==='tool.cf.telegram_attachment_get'){
    fetches++;
    return{providerTool:'telegram_attachment_get',
      result:{state:'ACHIEVED',resource_links:[{uri:'https://cf-onshape.duckdns.org/mcp/telegram-file/test',
       name:'movie.mp4',mimeType:'video/mp4',size:data.length}]}};
   }
   if(capabilityId==='tool.cf.wechat_file_upload'){
    if(args.action==='create'){
     create++;assert.equal(args.sha256_hex,sha);
     return{providerTool:'wechat_file_upload',effectProof:{providerTool:'wechat_file_upload',
      outcome:'PROVIDER_REPORTED_SUCCEEDED'},result:{state:'ACHIEVED',
       provider_send_performed:false,upload_id:sid}};
    }
    return{providerTool:'wechat_file_upload',effectProof:{providerTool:'wechat_file_upload',
      outcome:'PROVIDER_REPORTED_SUCCEEDED'},result:{state:'ACHIEVED',
       provider_send_performed:false,upload_id:sid,size_bytes:data.length,sha256_hex:sha,
       offset:data.length}};
   }
   if(capabilityId==='tool.cf.wechat_file_upload_chunk'){
    append++;
    return{providerTool:'wechat_file_upload_chunk',
     effectProof:{providerTool:'wechat_file_upload_chunk',outcome:'PROVIDER_REPORTED_SUCCEEDED'},
     result:{state:'ACHIEVED',provider_send_performed:false,upload_id:sid,
      next_offset:args.offset+Buffer.from(args.data_base64,'base64').length}};
   }
   if(capabilityId==='tool.cf.wechat_file_send'){
    send++;assert.equal(args.upload_id,sid);assert.equal(args.target,'File Transfer');
    return{providerTool:'wechat_file_send',effectProof:{providerTool:'wechat_file_send',
     outcome:'PROVIDER_REPORTED_SUCCEEDED'},
     result:{state:'UI_OUTBOUND_OBSERVED',target:'File Transfer',filename:'movie.mp4',
      sha256_hex:sha,size_bytes:data.length,direction:'out',fresh_outbound_row:true,
      send_enabled_after:false,send_clicks:1,provider_confirmed:false,
      provider_send_performed:true,blind_retry_safe:false}};
   }
   throw Error('UNEXPECTED_TOOL:'+capabilityId);
  };
  const workflow=()=>openWorkflow({storeDir:dir,missionId:'qa-'+randomUUID(),
    planVersion:1,planRaw:raw,steps:parsed.steps});
  const missionId=randomUUID();
  const open=()=>openWorkflow({storeDir:dir,missionId,planVersion:1,
   planRaw:raw,steps:parsed.steps});
  const first=await executeTypedPlan(raw,{allowedCapabilities:allowed,
   workflow:await open(),toolInvoker:invoker,connectionProbe:async()=>true});
  assert.equal(first.state,'SUCCEEDED_VERIFIED',JSON.stringify(first).slice(0,1300));
  assert.equal(create,1);assert.equal(append,3);assert.equal(send,1);assert.equal(fetches,1);
  const completed=(await open()).summary().completedStepIds;
  assert.deepEqual(completed,[1,2,3]);
  const replay=await executeTypedPlan(raw,{allowedCapabilities:allowed,
   workflow:await open(),toolInvoker:()=>{throw Error('NO_REPLAY');},
   connectionProbe:async()=>true});
  assert.equal(replay.state,'SUCCEEDED_VERIFIED');
  assert.equal(send,1);
 }finally{globalThis.fetch=fetchOriginal;await fs.rm(dir,{recursive:true,force:true})}
});
