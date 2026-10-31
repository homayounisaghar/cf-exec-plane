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
const MAX_FILE_SEND_BYTES=1024*1024*1024; // 1 GiB transport ceiling; provider may enforce less
const HASH_BLOCK_BYTES=1024*1024;
function coded(code){const e=new Error(code);e.code=code;return e}
const result=x=>({structuredContent:x,content:[{type:'text',text:JSON.stringify(x,null,1)}]});
const fail=(error,fallback)=>result({state:'FAILED',provider:'wechat',
 error:{code:String(error?.code||fallback).slice(0,96),
  message:String(error?.message||fallback).slice(0,180)}});
export function registerWeChatMediaTools(server,z,{
 materialUpload=null,stageMaterialDownload=null,cacheRoot=undefined,
 enableLiveFileSend=false,postJson=null,postStream=null,
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
  title:'Send a verified staged WeChat file',
  description:'Send one ready, hash-verified file up to 1 GiB through the native WeChat chooser to a uniquely matched exact chat. A durable one-shot marker is reserved before any possible send; never blindly retry. UI_OUTBOUND_OBSERVED means a fresh outgoing file row, NOT independent provider delivery confirmation. Supports dry_run=true without sending.',
  inputSchema:{target:z.string().trim().min(1).max(256),
   upload_id:z.string().regex(/^[0-9a-f]{64}$/),
   dry_run:z.boolean().optional(),allow_mark_read:z.boolean().optional()},
  annotations:{readOnlyHint:false,destructiveHint:false,
   idempotentHint:false,openWorldHint:true}
 },async input=>{
  let reserved=false;
  const dryRun=input.dry_run===true;
  try{
   const target=String(input.target||'').trim();
   if(!target||target.length>256)throw coded('WECHAT_FILE_TARGET_INVALID');
   // The helper independently admits only exact unique header/list identity.
   if(input.allow_mark_read===true)throw coded('WECHAT_FILE_TARGET_MARK_READ_DISALLOWED');
   const ready=await upload().ready(input.upload_id);
   const name=ready?.filename;
   const handle=/^pcgfile:([0-9a-f]{64})$/.exec(String(ready?.material_file_handle||''));
   const sha=String(ready?.sha256_hex||'').toLowerCase();
   const bytesCount=ready?.size_bytes;
   if(!handle||!acceptedName(name)||name==='.'||name==='..'||name.includes('"')||
      !Number.isSafeInteger(bytesCount)||bytesCount<1||bytesCount>MAX_FILE_SEND_BYTES||
      !/^[0-9a-f]{64}$/.test(sha))
    throw coded('WECHAT_FILE_MATERIAL_INVALID');
   const source=materialRoot+'/'+handle[1]+'-'+name;
   // Verify the ready ticket on a bounded memory footprint before reserving
   // a provider send. A later source change still fails the helper's own SHA.
   let file=null,fd=null;
   try{
    fd=fs.openSync(source,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
    const st=fs.fstatSync(fd);
    if(!st.isFile()||st.nlink!==1||st.size!==bytesCount)
     throw coded('WECHAT_FILE_SOURCE_CHANGED');
    const h=createHash('sha256'),buf=Buffer.allocUnsafe(HASH_BLOCK_BYTES);
    for(let pos=0;pos<bytesCount;){
     const n=fs.readSync(fd,buf,0,Math.min(buf.length,bytesCount-pos),pos);
     if(n<=0)throw coded('WECHAT_FILE_SOURCE_CHANGED');
     h.update(buf.subarray(0,n));pos+=n;
    }
    if(h.digest('hex')!==sha)throw coded('WECHAT_FILE_SOURCE_SHA_MISMATCH');
    if(bytesCount<=MAX_FILE_DRYRUN_BYTES){
     file=Buffer.alloc(bytesCount);
     let pos=0;
     while(pos<bytesCount){
      const n=fs.readSync(fd,file,pos,bytesCount-pos,pos);
      if(n<=0)throw coded('WECHAT_FILE_SOURCE_CHANGED');
      pos+=n;
     }
    }
   }catch(e){
    if(e?.code?.startsWith('WECHAT_FILE_'))throw e;
    throw coded('WECHAT_FILE_SOURCE_NOT_READABLE');
   }finally{if(fd!==null)fs.closeSync(fd)}
   const streamMode=bytesCount>MAX_FILE_DRYRUN_BYTES;
   const request={target,filename:name,expected_sha256:sha,
    upload_id:input.upload_id,dry_run:dryRun,allow_mark_read:false};
   if(!streamMode)request.data_base64=file.toString('base64');
   if(!dryRun){
    await upload().markSendStarted(input.upload_id);
    reserved=true;
   }
   let reply;
   try{
    if(streamMode){
     // Raw bytes over the existing localhost helper channel; never create a
     // giant JS Buffer, base64 string, JSON body, or additional network API.
     const sourceStream=fs.createReadStream(source,{
      flags:fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW,
      highWaterMark:HASH_BLOCK_BYTES});
     try{
      if(typeof postStream==='function'){
       reply=await postStream('/file-send-stream',request,sourceStream);
      }else{
       const response=await fetch(semanticUrl+'/file-send-stream',{
        method:'POST',
        headers:{'content-type':'application/octet-stream',
         'content-length':String(bytesCount),
         'x-cf-wechat-meta':Buffer.from(JSON.stringify(request)).toString('base64')},
        body:sourceStream,duplex:'half',cache:'no-store',
        signal:AbortSignal.timeout(dryRun?900000:1800000)});
       const raw=await response.text();
       try{reply=JSON.parse(raw)}
       catch{throw coded('WECHAT_FILE_HELPER_BAD_JSON')}
       if(!response.ok||reply?.ok===false)
        throw coded(String(reply?.error||'WECHAT_FILE_HELPER_REJECTED'));
      }
     }finally{sourceStream.destroy()}
    }else if(typeof postJson==='function'){
     reply=await postJson('/file-send',request);
    }else{
     const response=await fetch(semanticUrl+'/file-send',{
      method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify(request),signal:AbortSignal.timeout(dryRun?30000:60000),
      cache:'no-store'});
     const raw=await response.text();
     try{reply=JSON.parse(raw)}
     catch{throw coded('WECHAT_FILE_HELPER_BAD_JSON')}
     if(!response.ok||reply?.ok===false)
      throw coded(String(reply?.error||'WECHAT_FILE_HELPER_REJECTED'));
    }
   }catch(e){
    if(reserved)return result({state:'IN_DOUBT',provider:'wechat',
     target,filename:name,sha256_hex:sha,size_bytes:bytesCount,
     provider_confirmed:false,effect_may_have_occurred:true,
     blind_retry_safe:false,reason:'WECHAT_FILE_HELPER_OUTCOME_UNKNOWN'});
    throw e;
   }
   const shared={provider:'wechat',target,filename:name,sha256_hex:sha,
    size_bytes:bytesCount,provider_confirmed:false,provider_fresh:false};
   if(dryRun){
    if(reply?.state!=='DRY_RUN_READY'||reply?.private_bytes_verified!==true||
       reply?.sha256_hex!==sha||reply?.file_size!==bytesCount||
       reply?.effect_performed!==false||reply?.provider_send_performed!==false)
      throw coded('WECHAT_FILE_DRYRUN_HELPER_RESULT_INVALID');
    return result({...shared,state:'DRY_RUN_READY',
     private_bytes_verified:true,provider_send_performed:false,
     blind_retry_safe:true});
   }
   const exact=reply?.target===target&&reply?.filename===name&&
    reply?.sha256_hex===sha&&reply?.file_size===bytesCount;
   if(!exact)return result({...shared,state:'IN_DOUBT',
    reason:'WECHAT_FILE_RECEIPT_IDENTITY_MISMATCH',
    effect_may_have_occurred:true,blind_retry_safe:false});
   if(reply?.state==='UI_OUTBOUND_OBSERVED'&&reply?.direction==='out'&&
      reply?.fresh_outbound_row===true&&reply?.send_enabled_after===false&&
      reply?.send_clicks<=1&&reply?.send_clicks>=0)
    return result({...shared,state:'UI_OUTBOUND_OBSERVED',
     direction:'out',fresh_outbound_row:true,
     send_clicks:reply.send_clicks,send_enabled_after:false,
     provider_send_performed:true,effect_may_have_occurred:true,
     verification_source:'same_client_accessibility_and_screen_geometry',
     blind_retry_safe:false});
   return result({...shared,state:'IN_DOUBT',
    reason:String(reply?.reason||'WECHAT_FILE_OUTBOUND_UI_UNVERIFIED').slice(0,100),
    effect_may_have_occurred:true,blind_retry_safe:false});
  }catch(e){
   if(reserved)return result({state:'IN_DOUBT',provider:'wechat',
    provider_confirmed:false,effect_may_have_occurred:true,
    blind_retry_safe:false,reason:'WECHAT_FILE_AFTER_RESERVATION_ERROR'});
   return fail(e,'WECHAT_FILE_SEND_FAILED');
  }
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
