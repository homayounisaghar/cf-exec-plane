// Additive WeChat material-plane tools. UI file send and native voice send
// are NOT silently qualified by successful material staging.
import {createWeChatCachedMediaAdapter} from './wechat_media_cache_adapter_v1.mjs';
import fs from 'node:fs';
import {createHash} from 'node:crypto';
// One ledger per actual cache root, independent of per-request upload wrappers.
// It stores only short-lived, random, owner-gated file identity receipts.
// The upload/staging functions always come from the *current* MCP request.
const issuedByCacheRoot=new Map();
const MAX_UPLOAD_BYTES=2147483648;
const MAX_FILE_DRYRUN_BYTES=128*1024;
function coded(code){const e=new Error(code);e.code=code;return e}
const result=x=>({structuredContent:x,content:[{type:'text',text:JSON.stringify(x,null,1)}]});
const fail=(error,fallback)=>result({state:'FAILED',provider:'wechat',
 error:{code:String(error?.code||fallback).slice(0,96),
  message:String(error?.message||fallback).slice(0,180)}});
export function registerWeChatMediaTools(server,z,{
 materialUpload=null,stageMaterialDownload=null,cacheRoot=undefined,
 enableLiveFileSend=false,postJson=null,
 materialRoot='/run/pcg-material-files',semanticUrl='http://127.0.0.1:9337'}={}){
 const upload=()=>{
  if(!materialUpload||!['create','status','delete','append','ready','markSendStarted']
    .every(x=>typeof materialUpload[x]==='function'))
   throw coded('WECHAT_MATERIAL_UPLOAD_UNAVAILABLE');
  return materialUpload;
 };
 const cacheAdapter=()=>{
  const transport=upload();
  const key=cacheRoot||'DEFAULT_ROOT';
  let issued=issuedByCacheRoot.get(key);
  if(!issued){issued=new Map();issuedByCacheRoot.set(key,issued)}
  return createWeChatCachedMediaAdapter({
   ...(cacheRoot?{root:cacheRoot}:{}),
   materialUpload:transport,stageMaterialDownload,issued});
 };
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
  title:'WeChat file handoff dry-run (no sending)',
  description:'Only File Transfer self-chat and up to 128 KiB. Verify ready CF material via the existing read-only mount, transfer exact bytes to the local helper and open/close the qualified chooser. No Send click and no external file delivery. Live send is disabled.',
  inputSchema:{target:z.string().trim().min(1).max(256),
   upload_id:z.string().regex(/^[0-9a-f]{64}$/),
   dry_run:z.boolean().optional(),allow_mark_read:z.boolean().optional()},
  annotations:{readOnlyHint:false,destructiveHint:false,
   idempotentHint:false,openWorldHint:true}
 },async input=>{
  try{
   if(input.target!=='File Transfer')throw coded('WECHAT_FILE_SELF_CHAT_ONLY');
   if(input.allow_mark_read===true)throw coded('WECHAT_FILE_MARK_READ_NOT_ALLOWED');
   if(input.dry_run!==true)throw coded('WECHAT_FILE_LIVE_SEND_DISABLED');
   const ready=await upload().ready(input.upload_id);
   const name=ready?.filename;
   const handle=/^pcgfile:([0-9a-f]{64})$/.exec(String(ready?.material_file_handle||''));
   const sha=String(ready?.sha256_hex||'').toLowerCase();
   const bytesCount=ready?.size_bytes;
   if(!handle||!acceptedName(name)||name==='.'||name==='..'||name.includes('"')||
      !Number.isSafeInteger(bytesCount)||bytesCount<1||bytesCount>MAX_FILE_DRYRUN_BYTES||
      !/^[0-9a-f]{64}$/.test(sha))
    throw coded('WECHAT_FILE_DRYRUN_MATERIAL_INVALID');
   const source=materialRoot+'/'+handle[1]+'-'+name;
   let file;
   try{
    const flags=fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW;
    const fd=fs.openSync(source,flags);
    try{
     const st=fs.fstatSync(fd);
     if(!st.isFile()||st.nlink!==1||st.size!==bytesCount)
      throw coded('WECHAT_FILE_DRYRUN_SOURCE_CHANGED');
     file=fs.readFileSync(fd);
    }finally{fs.closeSync(fd)}
   }catch(e){
    if(e?.code==='WECHAT_FILE_DRYRUN_SOURCE_CHANGED')throw e;
    throw coded('WECHAT_FILE_DRYRUN_SOURCE_NOT_READABLE');
   }
   if(file.length!==bytesCount||
      createHash('sha256').update(file).digest('hex')!==sha)
    throw coded('WECHAT_FILE_DRYRUN_SHA_MISMATCH');
   const request={target:'File Transfer',filename:name,expected_sha256:sha,
    data_base64:file.toString('base64'),dry_run:true,allow_mark_read:false};
   let reply;
   if(typeof postJson==='function'){
    reply=await postJson('/file-send',request);
   }else{
    const response=await fetch(semanticUrl+'/file-send',{
     method:'POST',headers:{'content-type':'application/json'},
     body:JSON.stringify(request),signal:AbortSignal.timeout(30000),cache:'no-store'});
    const raw=await response.text();
    try{reply=JSON.parse(raw)}catch{throw coded('WECHAT_FILE_DRYRUN_HELPER_BAD_JSON')}
    if(!response.ok||reply?.ok===false)
     throw coded(String(reply?.error||'WECHAT_FILE_DRYRUN_HELPER_REJECTED'));
   }
   if(reply?.state!=='DRY_RUN_READY'||reply?.private_bytes_verified!==true||
      reply?.sha256_hex!==sha||reply?.file_size!==bytesCount||
      reply?.effect_performed!==false)
    throw coded('WECHAT_FILE_DRYRUN_HELPER_RESULT_INVALID');
   return result({state:'DRY_RUN_READY',provider:'wechat',
    target:'File Transfer',filename:name,size_bytes:bytesCount,sha256_hex:sha,
    private_bytes_verified:true,provider_send_performed:false,
    provider_confirmed:false,blind_retry_safe:true});
  }catch(e){return fail(e,'WECHAT_FILE_DRYRUN_FAILED')}
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
