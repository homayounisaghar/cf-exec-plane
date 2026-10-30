// WeChat Linux local decrypted media-cache acquisition. NO native API, no
// encrypted DB access, no UI navigation, no inferred message/peer identity.
// Reuse the CF resumable material plane and short-lived owner download gate.
import fs from 'node:fs';
import path from 'node:path';
import {randomBytes,createHash} from 'node:crypto';
const DEFAULT_ROOT='/var/lib/capability-fabric/pcg/wechat/home/xwechat_files';
const MAX_BYTES=2147483648,CHUNK=1024*1024,TTL=20*60*1000;
const MIMES={'.txt':'text/plain','.pdf':'application/pdf',
 '.doc':'application/msword','.docx':'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
 '.xlsx':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
 '.xls':'application/vnd.ms-excel','.zip':'application/zip',
 '.step':'application/step','.stp':'application/step','.stl':'model/stl',
 '.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp',
 '.gif':'image/gif','.mp4':'video/mp4','.mov':'video/quicktime',
 '.webm':'video/webm','.m4a':'audio/mp4','.mp3':'audio/mpeg',
 '.wav':'audio/wav','.ogg':'audio/ogg','.opus':'audio/ogg','.amr':'audio/amr'};
const ACCOUNT=/^wxid_[A-Za-z0-9_]{5,80}$/;
const validFile=x=>typeof x==='string'&&x.length>0&&x.length<200&&
 !/[\u0000-\u001f\u007f]/.test(x)&&x!=='.'&&x!=='..';
const fail=code=>{let e=new Error(code);e.code=code;throw e};
const type=ext=>['.png','.jpg','.jpeg','.webp','.gif'].includes(ext)?'image':
 ['.mp4','.mov','.webm'].includes(ext)?'video':
 ['.m4a','.mp3','.wav','.ogg','.opus','.amr'].includes(ext)?'audio':'file';
const safeName=name=>String(name).replace(/[\u0000-\u001f\u007f\\/"\r\n]/g,'_').slice(0,128);
const isDir=p=>{try{return fs.lstatSync(p).isDirectory()}catch{return false}};
const isChild=(root,absolute)=>absolute.startsWith(root+path.sep);
export function createWeChatCachedMediaAdapter({root=DEFAULT_ROOT,
 materialUpload,stageMaterialDownload,now=()=>Date.now()}={}){
 if(typeof root!=='string'||!path.isAbsolute(root)||!isDir(root))
  fail('WECHAT_MEDIA_CACHE_ROOT_UNAVAILABLE');
 const trustedRoot=fs.realpathSync(root);
 const issued=new Map();
 const stillValid=(item)=>{
  if(now()>=item.expires)return false;
  let st,real;
  try{st=fs.lstatSync(item.absolute);real=fs.realpathSync(item.absolute)}
  catch{return false}
  return st.isFile()&&!st.isSymbolicLink()&&isChild(trustedRoot,real)&&
   st.ino===item.ino&&st.dev===item.dev&&st.size===item.size&&
   st.mtimeMs===item.mtimeMs;
 };
 function scan({kind='all',limit=30}={}){
  if(!['all','file','image','video','audio'].includes(kind)||
     !Number.isSafeInteger(limit)||limit<1||limit>100)fail('WECHAT_CACHE_LIST_ARGS_INVALID');
  for(const [key,item] of issued)if(now()>=item.expires)issued.delete(key);
  const rows=[];
  const accounts=fs.readdirSync(trustedRoot,{withFileTypes:true})
   .filter(x=>x.isDirectory()&&ACCOUNT.test(x.name));
  // This is a logged-in single-client adapter, not a recursive disk search
  // that can silently merge artifacts from multiple WeChat accounts.
  if(accounts.length!==1)fail('WECHAT_CACHE_ACCOUNT_NOT_UNIQUE');
  for(const account of accounts){
   const msg=path.join(trustedRoot,account.name,'msg');
   // Only observed, *decrypted* media directories; skip opaque/encrypted DAT.
   for(const category of ['file','video','image','audio','voice']){
    const directory=path.join(msg,category);
    if(!isDir(directory))continue;
    const stack=[{directory,depth:0}];let count=0;
    while(stack.length&&count<1500){
     const entry=stack.pop();let children;
     try{children=fs.readdirSync(entry.directory,{withFileTypes:true})}
     catch{continue}
     for(const child of children){
      if(++count>1500)break;
      if(!validFile(child.name)||child.isSymbolicLink())continue;
      const absolute=path.join(entry.directory,child.name);
      if(child.isDirectory()&&entry.depth<4){stack.push({directory:absolute,depth:entry.depth+1});continue}
      if(!child.isFile())continue;
      const ext=path.extname(child.name).toLowerCase();
      const mime=MIMES[ext];if(!mime)continue;
      const mediaType=type(ext);
      if(kind!=='all'&&kind!==mediaType)continue;
      let st,real;
      try{st=fs.lstatSync(absolute);real=fs.realpathSync(absolute)}
      catch{continue}
      if(!st.isFile()||st.isSymbolicLink()||!isChild(trustedRoot,real)||
         st.size<1||st.size>MAX_BYTES)continue;
      rows.push({absolute,size:st.size,mtimeMs:st.mtimeMs,
       ino:st.ino,dev:st.dev,filename:safeName(child.name),
       mime_type:mime,kind:mediaType,category});
     }
    }
   }
  }
  rows.sort((a,b)=>b.mtimeMs-a.mtimeMs||a.filename.localeCompare(b.filename));
  const files=rows.slice(0,limit).map(x=>{
   const file_ref='wechatcache:'+randomBytes(24).toString('hex');
   issued.set(file_ref,{...x,expires:now()+TTL});
   return {file_ref,filename:x.filename,mime_type:x.mime_type,
    media_kind:x.kind,size_bytes:x.size,
    local_cache_modified_at:new Date(x.mtimeMs).toISOString(),
    cache_category:x.category,expires_after_seconds:Math.floor(TTL/1000),
    provider_message_id:null,provider_sender_id:null,
    conversation_identity_verified:false,
    message_attribution_verified:false};
  });
  return {state:'ACHIEVED',provider:'wechat',source:'AUTHENTICATED_LOCAL_MEDIA_CACHE',
   files,observed_cache_records:rows.length,
   scope:'AVAILABLE_DECRYPTED_CACHED_FILES_ONLY',
   complete:false,message_attribution_verified:false,
   supports_uncached_or_encrypted_media:false};
 }
 async function acquire({file_ref}={}){
  if(typeof file_ref!=='string'||!/^wechatcache:[0-9a-f]{48}$/.test(file_ref))
   fail('WECHAT_CACHE_REF_INVALID');
  const item=issued.get(file_ref);
  if(!item||!stillValid(item))fail('WECHAT_CACHE_REF_EXPIRED_OR_CHANGED');
  if(!materialUpload||typeof materialUpload.create!=='function'||
     typeof materialUpload.append!=='function'||
     typeof materialUpload.ready!=='function'||
     typeof materialUpload.delete!=='function'||
     typeof stageMaterialDownload!=='function')
   fail('WECHAT_CACHE_MATERIAL_TRANSPORT_UNAVAILABLE');
  let created=null,handle=null,offset=0;
  try{
   handle=fs.openSync(item.absolute,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
   const current=fs.fstatSync(handle);
   if(current.ino!==item.ino||current.dev!==item.dev||current.size!==item.size||
      current.mtimeMs!==item.mtimeMs)fail('WECHAT_CACHE_FILE_CHANGED');
   created=await materialUpload.create({filename:item.filename,
    media_type:item.mime_type,size_bytes:item.size,sha256_hex:null});
   if(!created?.upload_id)fail('WECHAT_CACHE_MATERIAL_CREATE_FAILED');
   const hash=createHash('sha256');
   while(offset<item.size){
    const chunk=Buffer.alloc(Math.min(CHUNK,item.size-offset));
    const got=fs.readSync(handle,chunk,0,chunk.length,offset);
    if(got!==chunk.length)fail('WECHAT_CACHE_FILE_SHORT_READ');
    hash.update(chunk);
    const res=await materialUpload.append(created.upload_id,offset,
     {data_base64:chunk.toString('base64')});
    const next=Number(res?.offset);
    if(next!==offset+chunk.length)fail('WECHAT_CACHE_MATERIAL_OFFSET_MISMATCH');
    offset=next;
   }
   const digest=hash.digest('hex');
   const checked=fs.fstatSync(handle);
   if(checked.ino!==item.ino||checked.dev!==item.dev||
      checked.mtimeMs!==item.mtimeMs||checked.size!==item.size)
    fail('WECHAT_CACHE_FILE_CHANGED_DURING_READ');
   const ready=await materialUpload.ready(created.upload_id);
   if(ready?.sha256_hex&&ready.sha256_hex.toLowerCase()!==digest)
    fail('WECHAT_CACHE_MATERIAL_DIGEST_MISMATCH');
   const download=await stageMaterialDownload(ready);
   if(!download||typeof download.download_path!=='string'||
      !download.download_path.startsWith('/mcp/wechat-file/'))
    fail('WECHAT_CACHE_DOWNLOAD_LINK_UNQUALIFIED');
   // One-shot capability. Preserve the material until its own short TTL.
   issued.delete(file_ref);
   return {state:'ACHIEVED',provider:'wechat',
    source:'AUTHENTICATED_LOCAL_MEDIA_CACHE',
    filename:item.filename,mime_type:item.mime_type,
    media_kind:item.kind,size_bytes:item.size,sha256_hex:digest,
    download_path:download.download_path,
    expires_after_seconds:download.expires_after_seconds,
    message_attribution_verified:false,
    provider_message_id:null,provider_sender_id:null,
    full_history_verified:false,
    original_wechat_content_verified:'LOCAL_BYTES_ONLY',
    no_wechat_navigation:true};
  }catch(e){
   if(created?.upload_id)try{await materialUpload.delete(created.upload_id)}catch{}
   throw e;
  }finally{if(handle!==null)fs.closeSync(handle)}
 }
 return {scan,acquire};
}
