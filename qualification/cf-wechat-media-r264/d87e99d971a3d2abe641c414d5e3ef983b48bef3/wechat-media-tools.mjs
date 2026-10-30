// Additive WeChat material-plane tools. UI file send and native voice send
// are NOT silently qualified by successful material staging.
import {createWeChatCachedMediaAdapter} from './wechat_media_cache_adapter_v1.mjs';
const MAX_UPLOAD_BYTES=2147483648;
function coded(code){const e=new Error(code);e.code=code;return e}
const result=x=>({structuredContent:x,content:[{type:'text',text:JSON.stringify(x,null,1)}]});
const fail=(error,fallback)=>result({state:'FAILED',provider:'wechat',
 error:{code:String(error?.code||fallback).slice(0,96),
  message:String(error?.message||fallback).slice(0,180)}});
export function registerWeChatMediaTools(server,z,{
 materialUpload=null,stageMaterialDownload=null,cacheRoot=undefined,
 enableLiveFileSend=false,postJson=null}={}){
 let cache=null;
 const upload=()=>{
  if(!materialUpload||!['create','status','delete','append','ready','markSendStarted']
    .every(x=>typeof materialUpload[x]==='function'))
   throw coded('WECHAT_MATERIAL_UPLOAD_UNAVAILABLE');
  return materialUpload;
 };
 const cacheAdapter=()=>cache||(cache=createWeChatCachedMediaAdapter({
  ...(cacheRoot?{root:cacheRoot}:{}),
  materialUpload:upload(),stageMaterialDownload}));
 const acceptedName=x=>typeof x==='string'&&x.length>=1&&x.length<=128&&
  !/[\/\\\u0000-\u001f\u007f]/.test(x);
 server.registerTool('wechat_file_upload',{
  title:'Stage WeChat file',
  description:'Create, inspect or delete a resumable WeChat material ticket; this does NOT send the file to a chat.',
  inputSchema:{action:z.enum(['create','status','delete']),
   upload_id:z.string().regex(/^[0-9a-f]{64}$/).optional(),
   filename:z.string().min(1).max(128).optional(),
   media_type:z.string().min(3).max(128).optional(),
   size_bytes:z.number().int().min(1).max(MAX_UPLOAD_BYTES).optional(),
   sha256_hex:z.string().regex(/^[0-9a-fA-F]{64}$/).optional()},
  annotations:{readOnlyHint:false,destructiveHint:false,
   idempotentHint:false,openWorldHint:true}
 },async input=>{
  try{
   const u=upload();let value;
   if(input.action==='create'){
    if(!acceptedName(input.filename)||!input.media_type||
       !Number.isSafeInteger(input.size_bytes))
     throw coded('WECHAT_MATERIAL_UPLOAD_FIELDS_REQUIRED');
    value=await u.create({filename:input.filename,media_type:input.media_type,
     size_bytes:input.size_bytes,sha256_hex:input.sha256_hex||null});
   }else{
    if(!input.upload_id)throw coded('WECHAT_MATERIAL_UPLOAD_ID_REQUIRED');
    value=input.action==='status'?await u.status(input.upload_id):
      await u.delete(input.upload_id);
   }
   return result({state:'ACHIEVED',provider:'wechat',
    realization:'SHARED_MATERIAL_STAGING_ONLY',...value,
    provider_send_performed:false});
  }catch(e){return fail(e,'WECHAT_FILE_UPLOAD_FAILED')}
 });
 server.registerTool('wechat_file_upload_chunk',{
  title:'Append WeChat file chunk',
  description:'Append a bounded base64 chunk to an existing resumable material upload ticket; no WeChat UI action.',
  inputSchema:{upload_id:z.string().regex(/^[0-9a-f]{64}$/),
   offset:z.number().int().min(0).max(MAX_UPLOAD_BYTES),
   data_base64:z.string().min(1).max(2900000)},
  annotations:{readOnlyHint:false,destructiveHint:false,
   idempotentHint:true,openWorldHint:true}
 },async input=>{
  try{
   const value=await upload().append(input.upload_id,input.offset,
    {data_base64:input.data_base64});
   return result({state:'ACHIEVED',provider:'wechat',
    realization:'SHARED_MATERIAL_STAGING_ONLY',...value,
    provider_send_performed:false});
  }catch(e){return fail(e,'WECHAT_FILE_UPLOAD_CHUNK_FAILED')}
 });
 server.registerTool('wechat_cached_media_list',{
  title:'List cached WeChat files',
  description:'List bounded locally available decrypted WeChat file/video/image/audio cache entries. NEVER asserts a message or sender match, all-account history or uncached media.',
  inputSchema:{kind:z.enum(['all','file','image','video','audio']).optional(),
   limit:z.number().int().min(1).max(100).optional()},
  annotations:{readOnlyHint:true,destructiveHint:false,
   idempotentHint:false,openWorldHint:true}
 },async input=>{
  try{return result(cacheAdapter().scan(input))}
  catch(e){return fail(e,'WECHAT_CACHED_MEDIA_LIST_FAILED')}
 });
 server.registerTool('wechat_cached_media_get',{
  title:'Download an observed cached WeChat file',
  description:'Stage one exact previously listed decrypted WeChat cache file into the shared short-lived download plane. No message/sender identity proof, no UI navigation and no encrypted database access.',
  inputSchema:{file_ref:z.string().regex(/^wechatcache:[0-9a-f]{48}$/)},
  annotations:{readOnlyHint:true,destructiveHint:false,
   idempotentHint:false,openWorldHint:true}
 },async input=>{
  try{
   const value=await cacheAdapter().acquire(input);
   return {structuredContent:value,content:[
    {type:'text',text:JSON.stringify(value,null,1)},
    {type:'resource_link',uri:'https://cf-onshape.duckdns.org'+value.download_path,
     name:value.filename,mimeType:value.mime_type,size:value.size_bytes,
     description:'Expiring locally cached WeChat file; message not identified.'}
   ]};
  }catch(e){return fail(e,'WECHAT_CACHED_MEDIA_GET_FAILED')}
 });
 server.registerTool('wechat_file_send',{
  title:'Send staged WeChat file (qualification-gated)',
  description:'Send only a ready material upload via the existing bounded WeChat UI file chooser. Currently DISABLED until independent file-picker qualification. dry_run verifies staged bytes without UI navigation. Never blind-retry uncertain sends.',
  inputSchema:{target:z.string().trim().min(1).max(256),
   upload_id:z.string().regex(/^[0-9a-f]{64}$/),
   dry_run:z.boolean().optional(),allow_mark_read:z.boolean().optional()},
  annotations:{readOnlyHint:false,destructiveHint:false,
   idempotentHint:false,openWorldHint:true}
 },async input=>{
  try{
   const ready=await upload().ready(input.upload_id);
   if(!ready?.material_file_handle||!acceptedName(ready.filename))
    throw coded('WECHAT_FILE_STAGED_MATERIAL_INVALID');
   if(input.dry_run===true)return result({state:'DRY_RUN_READY',
    provider:'wechat',staged_file_name:ready.filename,
    size_bytes:ready.size_bytes,provider_send_performed:false,
    provider_ui_file_picker_qualified:false});
   if(!enableLiveFileSend||typeof postJson!=='function')
    throw coded('WECHAT_FILE_SEND_PROVIDER_CHOOSER_UNQUALIFIED');
   // Only after a separately qualified, owner-accepted UI file-picker;
   // mark intent before possible provider effect to forbid blind retries.
   const handle=String(ready.material_file_handle);
   if(!/^pcgfile:[0-9a-f]{64}$/.test(handle))
    throw coded('WECHAT_MATERIAL_HANDLE_INVALID');
   const filePath='/var/lib/capability-fabric/pcg/run/material-files/'+
    handle.slice('pcgfile:'.length)+'-'+ready.filename;
   // Strict material-host construction: the existing helper rejects all
   // other directories/symlinks and independently checks the UI chooser.
   upload().markSendStarted(ready.upload_id);
   let reply;
   try{reply=await postJson('/file-send',{
    target:input.target,allow_mark_read:input.allow_mark_read===true,
    dry_run:false,path:filePath});}
   catch(error){
    // The remote attempt may already have started. Returning FAILED would
    // invite a duplicate external send; force the caller into IN_DOUBT.
    return result({state:'IN_DOUBT',provider:'wechat',
     provider_confirmed:false,effect_may_have_occurred:true,
     blind_retry_safe:false,reason:'WECHAT_FILE_SEND_OUTCOME_UNKNOWN'});
   }
   // Never upgrade an observed UI acknowledgement to remote-provider
   // confirmation; this session has no fresh provider verifier.
   return result({provider:'wechat',...reply,
    provider_confirmed:false,blind_retry_safe:false,
    state:reply?.state==='DRY_RUN_READY'?'DRY_RUN_READY':
      reply?.state==='ACKNOWLEDGED_UNVERIFIED'?'ACKNOWLEDGED_UNVERIFIED':'IN_DOUBT'});
  }catch(e){return fail(e,'WECHAT_FILE_SEND_FAILED')}
 });
 server.registerTool('wechat_native_voice_capability',{
  title:'WeChat native voice send qualification',
  description:'Report native WeChat voice-message injection qualification truth. An audio file upload is NOT a native voice message.',
  inputSchema:{},
  annotations:{readOnlyHint:true,destructiveHint:false,
   idempotentHint:true,openWorldHint:false}
 },async()=>result({state:'ACHIEVED',provider:'wechat',
  native_voice_send_qualified:false,
  native_voice_receive_qualified:false,
  send_voice_button_observed:true,
  playable_audio_file_does_not_prove_native_voice_send:true,
  upload_transport_available:Boolean(materialUpload),
  native_voice_tool_not_exposed:true,
  reason:'NO_VERIFIED_UI_AUDIO_INJECTION_OR_MESSAGE_IDENTITY'}));
}
