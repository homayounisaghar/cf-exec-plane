// Additive WeChat material-plane tools. UI file send and native voice send
// are NOT silently qualified by successful material staging.
import {createWeChatCachedMediaAdapter} from './wechat_media_cache_adapter_v1.mjs';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
// One ledger per actual cache root, independent of per-request upload wrappers.
// It stores only short-lived, random, owner-gated file identity receipts.
// The upload/staging functions always come from the *current* MCP request.
const issuedByCacheRoot=new Map();
const MAX_UPLOAD_BYTES=2147483648;
const MAX_SEND_BYTES=64*1024*1024;
const MATERIAL_ROOT='/var/lib/capability-fabric/pcg/run/material-files';
const HANDOFF_CONTAINER_ROOT='/tmp/app/.wechat-handoff';
const HANDOFF_HOST_ROOT='/var/lib/capability-fabric/releases/onshape-vps-fast-r100-direct-orbit1-paa-storage-r268-wechat-file-handoff-dryrun-20261031/.wechat-handoff';
const HEX64=/^[0-9a-f]{64}$/;
function coded(code){const e=new Error(code);e.code=code;return e}
export function createWeChatFileHandoff(ready,options={}){
 const io=options.fsImpl||fs;
 const materialRoot=options.materialRoot||MATERIAL_ROOT;
 const containerRoot=options.containerRoot||HANDOFF_CONTAINER_ROOT;
 const hostRoot=options.hostRoot||HANDOFF_HOST_ROOT;
 const uid=options.uid??1000,gid=options.gid??1000;
 const requireRoot=options.requireRoot!==false;
 const reject=code=>{const e=new Error(code);e.code=code;throw e};
 if(requireRoot&&typeof process.getuid==='function'&&process.getuid()!==0)
  reject('WECHAT_HANDOFF_REQUIRES_ROOT_MATERIAL_READER');
 const handle=/^pcgfile:([0-9a-f]{64})$/.exec(String(ready?.material_file_handle||''));
 const name=ready?.filename;
 if(!handle||typeof name!=='string'||name.length<1||name.length>128||
    /[\/\\\u0000-\u001f\u007f"]/.test(name)||name==='.'||name==='..')
  reject('WECHAT_MATERIAL_IDENTITY_INVALID');
 const size=ready.size_bytes;
 if(!Number.isSafeInteger(size)||size<1||size>MAX_SEND_BYTES)
  reject('WECHAT_FILE_SIZE_OUT_OF_SCOPE');
 const expected=String(ready.sha256_hex||'').toLowerCase();
 if(!HEX64.test(expected))reject('WECHAT_MATERIAL_SHA_REQUIRED');
 const source=path.join(materialRoot,handle[1]+'-'+name);
 let dir=null;
 try{
  const rootStat=io.lstatSync(materialRoot),sourceStat=io.lstatSync(source);
  if(!rootStat.isDirectory()||rootStat.isSymbolicLink()||
     !sourceStat.isFile()||sourceStat.isSymbolicLink()||
     sourceStat.nlink!==1||sourceStat.size!==size)
   reject('WECHAT_MATERIAL_SOURCE_INVALID');
  const rootReal=io.realpathSync(materialRoot),sourceReal=io.realpathSync(source);
  if(sourceReal!==source||!sourceReal.startsWith(rootReal+path.sep))
   reject('WECHAT_MATERIAL_SOURCE_PATH_INVALID');
  const actual=createHash('sha256').update(io.readFileSync(source)).digest('hex');
  if(actual!==expected)reject('WECHAT_MATERIAL_SOURCE_HASH_MISMATCH');
  if(!path.isAbsolute(hostRoot))reject('WECHAT_HANDOFF_HOST_PATH_INVALID');
  const parent=io.lstatSync(containerRoot);
  if(!parent.isDirectory()||parent.isSymbolicLink()||parent.uid!==uid||
     parent.gid!==gid||(parent.mode&0o777)!==0o700)
   reject('WECHAT_HANDOFF_ROOT_NOT_PRIVATE');
  dir=io.mkdtempSync(path.join(containerRoot,'.cf-wechat-'));
  io.chownSync(dir,uid,gid);io.chmodSync(dir,0o700);
  const dest=path.join(dir,name);
  io.copyFileSync(source,dest,io.constants.COPYFILE_EXCL);
  io.chownSync(dest,uid,gid);io.chmodSync(dest,0o600);
  const copied=io.lstatSync(dest);
  if(!copied.isFile()||copied.isSymbolicLink()||copied.nlink!==1||
     copied.uid!==uid||copied.gid!==gid||(copied.mode&0o777)!==0o600||
     copied.size!==size||
     createHash('sha256').update(io.readFileSync(dest)).digest('hex')!==expected)
   reject('WECHAT_HANDOFF_COPY_VERIFICATION_FAILED');
  const hostPath=path.join(hostRoot,path.basename(dir),name);
  let cleaned=false;
  return {path:hostPath,filename:name,size_bytes:size,sha256_hex:expected,
   upload_id:String(ready.upload_id||''),cleanup(){
    if(cleaned)return;cleaned=true;
    io.rmSync(dir,{recursive:true,force:true});
   }};
 }catch(error){
  if(dir){try{io.rmSync(dir,{recursive:true,force:true})}catch{}}
  throw error;
 }
}
const result=x=>({structuredContent:x,content:[{type:'text',text:JSON.stringify(x,null,1)}]});
const fail=(error,fallback)=>result({state:'FAILED',provider:'wechat',
 error:{code:String(error?.code||fallback).slice(0,96),
  message:String(error?.message||fallback).slice(0,180)}});
export function registerWeChatMediaTools(server,z,{
 materialUpload=null,stageMaterialDownload=null,cacheRoot=undefined,
 enableLiveFileSend=false,postJson=null,
 semanticUrl='http://127.0.0.1:9337',handoffFactory=createWeChatFileHandoff}={}){
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
  title:'Send staged WeChat file (self-chat qualification gate)',
  description:'Dry-run only in this release. Exact self-chat File Transfer, <=64 MiB: hash-verified private handoff and qualified chooser open/close without selecting or sending. Live send stays disabled until provider-fresh verification.',
  inputSchema:{target:z.string().trim().min(1).max(256),
   upload_id:z.string().regex(/^[0-9a-f]{64}$/),
   dry_run:z.boolean().optional(),allow_mark_read:z.boolean().optional()},
  annotations:{readOnlyHint:false,destructiveHint:false,
   idempotentHint:false,openWorldHint:true}
 },async input=>{
  let handoff=null;
  try{
   if(input.target!=='File Transfer')throw coded('WECHAT_FILE_SEND_SELF_CHAT_ONLY');
   if(input.allow_mark_read===true)throw coded('WECHAT_FILE_SEND_READ_EFFECT_NOT_ALLOWED');
   const ready=await upload().ready(input.upload_id);
   if(!ready?.material_file_handle||!acceptedName(ready.filename)||
      !Number.isSafeInteger(ready.size_bytes)||ready.size_bytes<1||
      ready.size_bytes>MAX_SEND_BYTES)
    throw coded('WECHAT_FILE_STAGED_MATERIAL_INVALID_OR_OUT_OF_SCOPE');
   if(input.dry_run!==true&&!enableLiveFileSend)
    throw coded('WECHAT_FILE_SEND_PROVIDER_VERIFICATION_GATE_CLOSED');
   handoff=handoffFactory(ready);
   let reply;
   if(input.dry_run!==true)await upload().markSendStarted(ready.upload_id);
   try{
    if(typeof postJson==='function'){
     reply=await postJson('/file-send',{
      target:input.target,allow_mark_read:false,dry_run:input.dry_run===true,
      path:handoff.path,expected_sha256:handoff.sha256_hex});
    }else{
     const response=await fetch(semanticUrl+'/file-send',{
      method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({target:input.target,allow_mark_read:false,
       dry_run:input.dry_run===true,path:handoff.path,
       expected_sha256:handoff.sha256_hex}),
      signal:AbortSignal.timeout(60000),cache:'no-store'});
     const raw=await response.text();
     try{reply=JSON.parse(raw)}catch{throw coded('WECHAT_FILE_SEND_HELPER_BAD_RESPONSE')}
     if(!response.ok||reply?.ok===false)
      throw coded(reply?.error||'WECHAT_FILE_SEND_HELPER_REJECTED');
    }
   }catch(error){
    if(input.dry_run===true)throw error;
    return result({state:'IN_DOUBT',provider:'wechat',
     filename:handoff.filename,size_bytes:handoff.size_bytes,
     sha256_hex:handoff.sha256_hex,provider_confirmed:false,
     provider_fresh:false,effect_may_have_occurred:true,
     blind_retry_safe:false,reason:'WECHAT_FILE_SEND_OUTCOME_UNKNOWN'});
   }
   const state=reply?.state==='DRY_RUN_READY'?'DRY_RUN_READY':
    reply?.state==='UI_OUTBOUND_OBSERVED'?'UI_OUTBOUND_OBSERVED':
    reply?.state==='IN_DOUBT'?'IN_DOUBT':'FAILED';
   return result({provider:'wechat',...reply,state,
    filename:handoff.filename,size_bytes:handoff.size_bytes,
    sha256_hex:handoff.sha256_hex,
    provider_confirmed:false,provider_fresh:false,
    provider_send_performed:state==='UI_OUTBOUND_OBSERVED',
    effect_may_have_occurred:state==='IN_DOUBT'||state==='UI_OUTBOUND_OBSERVED',
    blind_retry_safe:input.dry_run===true});
  }catch(e){return fail(e,'WECHAT_FILE_SEND_FAILED')}
  finally{try{handoff?.cleanup?.()}catch{}}
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
