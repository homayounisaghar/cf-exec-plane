// Dexa material streaming adapter: a typed runtime transport, never a planner.
// The model selects the exact source + upload/target tools; bytes never enter prompts.
// Each admitted upload/chunk uses the owner's existing CF OAuth, with one-byte-stream
// pipeline, exact size+SHA, durable local offsets and zero provider send here.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';

const fail=(code)=>{throw Object.assign(new Error(code),{code})};
const HEX64=/^[0-9a-f]{64}$/;
const ROOT='/home/cfserver/.local/share/dexa/material-stream-v1';
export const MATERIAL_SOURCES=Object.freeze(new Set([
 'tool.cf.telegram_attachment_get','tool.cf.whatsapp_attachment_get',
 'tool.cf.alibaba_attachment_get','tool.cf.bale_attachment_get',
 'tool.cf.wechat_cached_media_get'
]));
// Explicit native tool bindings are transport adapters, not language heuristics.
// Additional providers must declare and qualify their own exact upload protocol.
export const MATERIAL_UPLOAD_ADAPTERS=Object.freeze([
 Object.freeze({upload:'tool.cf.wechat_file_upload',
  chunk:'tool.cf.wechat_file_upload_chunk',maxBytes:1073741824,
  chunkBytes:2*1024*1024})
]);
export const streamAdapter=(upload,chunk)=>
 MATERIAL_UPLOAD_ADAPTERS.find(x=>x.upload===upload&&x.chunk===chunk)||null;
const privateName=name=>typeof name==='string'&&name.length>0&&name.length<=128&&
 !/[\/\\\x00-\x1f\x7f]/.test(name)&&name!=='.'&&name!=='..';
function extractOriginal(source){
 if(!source||typeof source!=='object'||Array.isArray(source))
  fail('MATERIAL_SOURCE_RESULT_NOT_OBJECT');
 const links=source.resource_links;
 if(!Array.isArray(links)||links.length!==1)
  fail('MATERIAL_EXACT_SOURCE_LINK_REQUIRED');
 const link=links[0];
 if(!link||typeof link.uri!=='string')fail('MATERIAL_SOURCE_URI_MISSING');
 let url;
 try{url=new URL(link.uri)}catch{fail('MATERIAL_SOURCE_URI_INVALID')}
 // Only the existing owner's CF material plane, no SSRF, arbitrary domains,
 // local addresses, redirect following, query-derived hostnames or file URLs.
 if(url.protocol!=='https:'||url.hostname!=='cf-onshape.duckdns.org'||
  url.port||!url.pathname.startsWith('/mcp/')||url.username||url.password)
  fail('MATERIAL_SOURCE_NOT_CF_DOWNLOAD');
 const name=link.name;
 if(!privateName(name))fail('MATERIAL_SOURCE_FILENAME_INVALID');
 const mime=link.mimeType;
 if(typeof mime!=='string'||mime.length<3||mime.length>128||
  !/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(mime))
  fail('MATERIAL_SOURCE_MIME_INVALID');
 const expectedSize=link.size;
 if(expectedSize!==undefined&&
  (!Number.isSafeInteger(expectedSize)||expectedSize<1||expectedSize>1073741824))
  fail('MATERIAL_SOURCE_SIZE_INVALID');
 return Object.freeze({uri:url.href,name,mime,expectedSize});
}
async function atomicJournal(dir,data){
 const target=path.join(dir,'progress.json'),temp=target+'.new';
 const fh=await fsp.open(temp,'wx',0o600);
 try{await fh.writeFile(JSON.stringify(data));await fh.sync()}finally{await fh.close()}
 await fsp.rename(temp,target);
 const parent=await fsp.open(dir,'r');
 try{await parent.sync()}finally{await parent.close()}
}
async function ingestDownload(link,dir,{fetcher=fetch,maxBytes}={}){
 const dest=path.join(dir,'source.bin');
 const response=await fetcher(link.uri,{redirect:'error',
  signal:AbortSignal.timeout(120000)});
 if(!response||!response.ok||!response.body)
  fail('MATERIAL_SOURCE_DOWNLOAD_FAILED');
 const advertised=Number(response.headers?.get?.('content-length'));
 if(Number.isFinite(advertised)&&advertised>maxBytes)
  fail('MATERIAL_SOURCE_TOO_LARGE');
 const fd=await fsp.open(dest,'wx',0o600);
 let size=0;
 const sha=createHash('sha256');
 try{
  for await(const block of response.body){
   const chunk=Buffer.from(block); size+=chunk.length;
   if(size>maxBytes)fail('MATERIAL_SOURCE_TOO_LARGE');
   sha.update(chunk);
   let off=0;
   while(off<chunk.length){
    const out=await fd.write(chunk,off,chunk.length-off,null);
    if(out.bytesWritten<=0)fail('MATERIAL_DISK_WRITE_STALLED');
    off+=out.bytesWritten;
   }
  }
  await fd.sync();
 }finally{await fd.close()}
 if(!size||link.expectedSize!==undefined&&size!==link.expectedSize)
  fail('MATERIAL_SOURCE_SIZE_MISMATCH');
 return Object.freeze({path:dest,size,sha256:sha.digest('hex')});
}
const receiptVerified=(reply,expected)=>{
 if(reply?.providerTool!==expected||
  reply?.effectProof?.providerTool!==expected||
  reply?.effectProof?.outcome!=='PROVIDER_REPORTED_SUCCEEDED'||
  reply?.result?.state!=='ACHIEVED'||
  reply?.result?.provider_send_performed!==false)
  fail('MATERIAL_PROVIDER_STAGE_RECEIPT_UNVERIFIED');
 return reply.result;
};
function exactUploadId(record){
 const id=record?.upload_id;
 if(typeof id!=='string'||!HEX64.test(id))
  fail('MATERIAL_UPLOAD_ID_MISSING');
 return id;
}
export async function stageMaterialStream({
 source,uploadCapabilityId,chunkCapabilityId,invoke,
 onProgress=async()=>{},fetcher=fetch,storeRoot=ROOT,pacingMs=310,
}={}){
 const adapter=streamAdapter(uploadCapabilityId,chunkCapabilityId);
 if(!adapter)fail('MATERIAL_UPLOAD_ADAPTER_NOT_ADMITTED');
 if(typeof invoke!=='function')fail('MATERIAL_INVOKER_NOT_BOUND');
 const link=extractOriginal(source);
 await fsp.mkdir(storeRoot,{recursive:true,mode:0o700});
 const stat=await fsp.lstat(storeRoot);
 if(!stat.isDirectory()||stat.isSymbolicLink()||(stat.mode&0o077))
  fail('MATERIAL_PRIVATE_STORE_UNSAFE');
 const dir=await fsp.mkdtemp(path.join(storeRoot,'stage-'));
 await fsp.chmod(dir,0o700);
 let ready=false;
 try{
  const data=await ingestDownload(link,dir,{fetcher,maxBytes:adapter.maxBytes});
  await atomicJournal(dir,{state:'DOWNLOADED',sha256:data.sha256,size:data.size});
  const created=receiptVerified(await invoke({capabilityId:uploadCapabilityId,args:{
   action:'create',filename:link.name,media_type:link.mime,
   size_bytes:data.size,sha256_hex:data.sha256
  }}),'wechat_file_upload');
  const id=exactUploadId(created);
  await atomicJournal(dir,{state:'UPLOADING',upload_id:id,sha256:data.sha256,
   size:data.size,offset:0});
  const fd=await fsp.open(data.path,'r');
  try{
   let offset=0;
   const chunk=Buffer.allocUnsafe(adapter.chunkBytes);
   while(offset<data.size){
    const count=Math.min(chunk.length,data.size-offset);
    const read=await fd.read(chunk,0,count,offset);
    if(read.bytesRead!==count)fail('MATERIAL_SOURCE_STREAM_TRUNCATED');
    const value=receiptVerified(await invoke({capabilityId:chunkCapabilityId,args:{
     upload_id:id,offset,data_base64:chunk.subarray(0,count).toString('base64')
    }}),'wechat_file_upload_chunk');
    if(value.upload_id!==undefined&&value.upload_id!==id)
     fail('MATERIAL_CHUNK_UPLOAD_ID_MISMATCH');
    offset+=count;
    if(value.next_offset!==undefined&&value.next_offset!==offset)
     fail('MATERIAL_PROVIDER_OFFSET_MISMATCH');
    await atomicJournal(dir,{state:'UPLOADING',upload_id:id,sha256:data.sha256,
     size:data.size,offset});
    if(offset<data.size&&pacingMs>0)
     await new Promise(resolve=>setTimeout(resolve,pacingMs));
    if(offset===data.size||offset%(8*adapter.chunkBytes)===0)
     await onProgress({bytesUploaded:offset,totalBytes:data.size});
   }
  }finally{await fd.close()}
  const checked=receiptVerified(await invoke({capabilityId:uploadCapabilityId,
   args:{action:'status',upload_id:id}}),'wechat_file_upload');
  if(checked.upload_id!==undefined&&checked.upload_id!==id)
   fail('MATERIAL_STATUS_UPLOAD_ID_MISMATCH');
  for(const sizeKey of ['size_bytes','expected_size_bytes']){
   if(checked[sizeKey]!==undefined&&checked[sizeKey]!==data.size)
    fail('MATERIAL_STATUS_SIZE_MISMATCH');
  }
  if(checked.sha256_hex!==undefined&&checked.sha256_hex!==null&&
   String(checked.sha256_hex).toLowerCase()!==data.sha256)
   fail('MATERIAL_STATUS_HASH_MISMATCH');
  if(Number.isSafeInteger(checked.offset)&&checked.offset!==data.size)
   fail('MATERIAL_STATUS_INCOMPLETE');
  await atomicJournal(dir,{state:'READY',upload_id:id,sha256:data.sha256,
   size:data.size,offset:data.size});
  ready=true;
  return Object.freeze({result:{upload_id:id,filename:link.name,
   sha256_hex:data.sha256,size_bytes:data.size,media_type:link.mime,
   state:'READY_VERIFIED',provider_send_performed:false},
   providerTool:'wechat_file_upload',
   effectProof:{schema:'dexa.provider-effect-proof.v1',
    providerTool:'wechat_file_upload',
    outcome:'PROVIDER_REPORTED_SUCCEEDED',
    resultDigest:createHash('sha256').update(id+':'+data.sha256+':'+data.size).digest('hex'),
    receiptBasis:'VERIFIED_DYNAMIC_MATERIAL_UPLOAD_NO_PROVIDER_SEND',
    independentlyReconciled:false}});
 }finally{
  // Only the local downloaded temporary copy is removed; a CF-side
  // material ticket remains eligible for TTL/reconciliation if uncertain.
  await fsp.rm(dir,{recursive:true,force:true});
 }
}
