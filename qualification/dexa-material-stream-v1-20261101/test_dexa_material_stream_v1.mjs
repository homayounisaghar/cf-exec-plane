import test from 'node:test';
import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
import {createHash} from 'node:crypto';
import os from 'node:os';
import fs from 'node:fs/promises';
import path from 'node:path';
import {stageMaterialStream} from './dexa_material_stream_v1.mjs';
import {parseTypedPlan} from './dexa_tool_plan_v3.mjs';
import {nativeMaterialEffectProof} from './dexa_native_material_effect_v1.mjs';
import {catalogRoute} from './dexa_catalog_registry.mjs';
import {attachMcpMaterialLinks} from './dexa_mcp_material_link_v1.mjs';

const UP='tool.cf.wechat_file_upload',CH='tool.cf.wechat_file_upload_chunk';
const SID='8'.repeat(64);
const attrs={uri:'https://cf-onshape.duckdns.org/mcp/telegram-file/mock',
 name:'evidence.mp4',mimeType:'video/mp4'};
const positivePlan=()=>({schema:'dexa.tool-plan.v3',steps:[
{id:1,kind:'TOOL',capabilityId:'tool.cf.telegram_attachment_get',deps:[],
 args:{conversation:'Saved Messages',latest_message:true}},
{id:2,kind:'TOOL',capabilityId:UP,mode:'STREAM',
 source:{step:1,path:[]},chunkCapabilityId:CH,deps:[1],args:{action:'create'}},
{id:3,kind:'TOOL',capabilityId:'tool.cf.wechat_file_send',deps:[2],
 args:{target:'File Transfer',upload_id:{$ref:{step:2,path:['upload_id']}}}}],
checks:[{step:3,path:['state'],op:'equal',value:'UI_OUTBOUND_OBSERVED'}],
output:{step:3,path:['state'],format:'text'}});
const allowed=['tool.cf.telegram_attachment_get',UP,CH,'tool.cf.wechat_file_send'];
test('typed one-stage runtime stream + independent one-shot send is admissible',()=>{
 const plan=parseTypedPlan(JSON.stringify(positivePlan()),allowed);
 assert.equal(plan.steps[1].mode,'STREAM');
 assert.equal(plan.steps[2].args.upload_id.$ref.step,2);
});
test('unselected chunk tool, invalid source, guessed base64 and extra args fail before effects',()=>{
 const raw=positivePlan();
 assert.throws(()=>parseTypedPlan(JSON.stringify(raw),allowed.filter(x=>x!==CH)),
  /TOOL_PLAN_STREAM_ADAPTER_NOT_SELECTED/);
 raw.steps[0].capabilityId='tool.cf.wechat_selected_conversation';
 assert.throws(()=>parseTypedPlan(JSON.stringify(raw),[...allowed,'tool.cf.wechat_selected_conversation']),
 /TOOL_PLAN_STREAM_SOURCE_NOT_AUTHENTICATED_ATTACHMENT/);
 raw.steps[0].capabilityId='tool.cf.telegram_attachment_get';
 raw.steps[1].args.data_base64='fake';
 assert.throws(()=>parseTypedPlan(JSON.stringify(raw),allowed),/TOOL_PLAN_STREAM_CREATE_ONLY/);
});
test('stream stage checks exact source link, size, SHA, bounded chunks, receipts, no message send',async()=>{
 const bytes=Buffer.alloc(4*1024*1024+37,119);
 const tmp=await fs.mkdtemp(path.join(os.tmpdir(),'dexa-material-qa-'));
 try{
  const uploads=[],progress=[];
  let created=0,seenSize=0;
  const invoke=async({capabilityId,args})=>{
   const route=catalogRoute(capabilityId);
   if(capabilityId===UP){
    if(args.action==='create'){
     created++;seenSize=args.size_bytes;
     assert.equal(args.sha256_hex,createHash('sha256').update(bytes).digest('hex'));
     assert.equal(args.filename,'evidence.mp4');
     return {providerTool:'wechat_file_upload',effectProof:{
      providerTool:'wechat_file_upload',outcome:'PROVIDER_REPORTED_SUCCEEDED'},
      result:{state:'ACHIEVED',provider_send_performed:false,upload_id:SID}};
    }
    assert.equal(args.action,'status');assert.equal(args.upload_id,SID);
    return {providerTool:'wechat_file_upload',effectProof:{
     providerTool:'wechat_file_upload',outcome:'PROVIDER_REPORTED_SUCCEEDED'},
     result:{state:'ACHIEVED',provider_send_performed:false,upload_id:SID,
      size_bytes:bytes.length,sha256_hex:createHash('sha256').update(bytes).digest('hex'),
      offset:bytes.length}};
   }
   assert.equal(capabilityId,CH);
   assert.equal(args.upload_id,SID);
   uploads.push({offset:args.offset,bytes:Buffer.from(args.data_base64,'base64')});
   return {providerTool:'wechat_file_upload_chunk',effectProof:{
    providerTool:'wechat_file_upload_chunk',outcome:'PROVIDER_REPORTED_SUCCEEDED'},
    result:{state:'ACHIEVED',provider_send_performed:false,upload_id:SID,
     next_offset:args.offset+Buffer.from(args.data_base64,'base64').length}};
  };
  const result=await stageMaterialStream({source:{resource_links:[{...attrs,size:bytes.length}]},
    uploadCapabilityId:UP,chunkCapabilityId:CH,invoke,
    onProgress:x=>progress.push(x),
    storeRoot:tmp,pacingMs:0,
    fetcher:async(url,options)=>{
     assert.equal(url,attrs.uri);assert.equal(options.redirect,'error');
     return {ok:true,headers:{get:()=>String(bytes.length)},
      body:Readable.from([bytes.subarray(0,9),bytes.subarray(9,12433),bytes.subarray(12433)])};
    }});
  assert.equal(created,1);
  assert.equal(seenSize,bytes.length);
  assert.equal(uploads.length,3);
  assert.deepEqual(uploads.map(x=>x.offset),[0,2097152,4194304]);
  assert.deepEqual(Buffer.concat(uploads.map(x=>x.bytes)),bytes);
  assert.equal(result.result.upload_id,SID);
  assert.equal(result.result.provider_send_performed,false);
  assert.equal(result.effectProof.receiptBasis,'VERIFIED_DYNAMIC_MATERIAL_UPLOAD_NO_PROVIDER_SEND');
  assert.equal(progress.at(-1).bytesUploaded,bytes.length);
  assert.equal((await fs.readdir(tmp)).length,0);
 }finally{await fs.rm(tmp,{recursive:true,force:true})}
});
test('link outside CF owner material plane is rejected before any network call',async()=>{
 let invoked=false;
 await assert.rejects(stageMaterialStream({
   source:{resource_links:[{...attrs,uri:'http://127.0.0.1/secret'}]},
   uploadCapabilityId:UP,chunkCapabilityId:CH,
   invoke:async()=>{invoked=true;}},),/MATERIAL_SOURCE_NOT_CF_DOWNLOAD/);
 assert.equal(invoked,false);
});
test('native adapter only accepts exact staging or fresh UI evidence, never dry-run/IN_DOUBT',()=>{
 const cr=catalogRoute(UP);
 const create={provider:'wechat',state:'ACHIEVED',
  realization:'SHARED_MATERIAL_STAGING_ONLY',upload_id:SID,provider_send_performed:false};
 assert.equal(nativeMaterialEffectProof({route:cr,response:create,requestArgs:{action:'create'}})?.outcome,
  'PROVIDER_REPORTED_SUCCEEDED');
 assert.equal(nativeMaterialEffectProof({route:cr,response:{...create,state:'IN_DOUBT'},requestArgs:{action:'create'}}),null);
 const send=catalogRoute('tool.cf.wechat_file_send');
 const reply={provider:'wechat',state:'UI_OUTBOUND_OBSERVED',
  target:'File Transfer',filename:'evidence.mp4',sha256_hex:'f'.repeat(64),
  size_bytes:123,provider_confirmed:false,blind_retry_safe:false,
  provider_send_performed:true,direction:'out',fresh_outbound_row:true,
  send_enabled_after:false,send_clicks:1};
 const requestArgs={target:'File Transfer',upload_id:SID};
 assert.equal(nativeMaterialEffectProof({route:send,response:reply,requestArgs})?.outcome,
  'PROVIDER_REPORTED_SUCCEEDED');
 assert.equal(nativeMaterialEffectProof({route:send,response:{...reply,state:'DRY_RUN_READY'},requestArgs}),null);
 assert.equal(nativeMaterialEffectProof({route:send,response:{...reply,fresh_outbound_row:false},requestArgs}),null);
});

test('authenticated MCP resource_link retained without inline bytes or URI invention',()=>{
 const native={state:'ACHIEVED',filename:'raw.mp4'};
 const content=[{type:'text',text:'metadata'},
  {type:'resource_link',uri:attrs.uri,name:attrs.name,mimeType:attrs.mimeType,size:14523}];
 const admitted=attachMcpMaterialLinks(native,content);
 assert.equal(admitted.state,'ACHIEVED');
 assert.deepEqual(admitted.resource_links,[{...attrs,size:14523}]);
 assert.equal('content' in admitted,false);
 assert.equal(attachMcpMaterialLinks(native,[{type:'text',text:'no link'}]),native);
 assert.throws(()=>attachMcpMaterialLinks({...native,resource_links:[]},content),/MCP_RESOURCE_LINK_CONFLICT/);
 assert.throws(()=>attachMcpMaterialLinks(native,[{type:'resource_link',uri:3,name:'x'}]),/MCP_RESOURCE_LINK_INVALID/);
});
