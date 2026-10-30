import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomBytes,createHash} from 'node:crypto';
import {Writable} from 'node:stream';
import {createWeChatCachedMediaAdapter} from './wechat_media_cache_adapter_v1.mjs';
import {installWeChatMaterialDownloadBridge} from './wechat-material-download-bridge.mjs';
import {registerWeChatMediaTools} from './wechat-media-tools.mjs';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'wechat-cache-synthetic-'));
const account=path.join(root,'wechat','wxid_fakeonly123_abcd','msg');
const materialRoot=path.join(root,'material');
fs.mkdirSync(materialRoot,{recursive:true});
for(const cat of ['file','video','audio','attach'])fs.mkdirSync(path.join(account,cat,'2026-10'),{recursive:true});
const source={
 txt:Buffer.from('synthetic fixture only, not a real WeChat message'),
 pdf:Buffer.from('%PDF-1.7\nsynthetic unit test\n'),
 video:Buffer.from('synthetic mp4 fixture'),
 voice:Buffer.from('OggSsynthetic ogg fixture')};
const create=(cat,name,buf)=>fs.writeFileSync(path.join(account,cat,'2026-10',name),buf);
create('file','synthetic-local-media-file.txt',source.txt);
create('file','fixture.pdf',source.pdf);
create('video','fixture.mp4',source.video);
create('audio','fixture.ogg',source.voice);
create('attach','encrypted.dat',Buffer.from('NOT_A_DECRYPTED_FILE'));
fs.symlinkSync('/etc/hosts',path.join(account,'file','2026-10','linked.txt'));
const uploadRegistry=new Map();
function mockUpload(){
 return {
  create({filename,media_type,size_bytes}){
   const upload_id=randomBytes(32).toString('hex');
   uploadRegistry.set(upload_id,{filename,media_type,size_bytes,data:Buffer.alloc(0)});
   return {upload_id,offset:0,filename,media_type,size_bytes};
  },
  append(upload_id,offset,{data_base64}){
   const r=uploadRegistry.get(upload_id);
   assert.ok(r);assert.equal(r.data.length,offset);
   const b=Buffer.from(data_base64,'base64');r.data=Buffer.concat([r.data,b]);
   return {upload_id,offset:r.data.length};
  },
  status(upload_id){const r=uploadRegistry.get(upload_id);return {upload_id,offset:r?.data.length||0}},
  ready(upload_id){
   const r=uploadRegistry.get(upload_id);
   if(!r||r.data.length!==r.size_bytes)throw Error('INCOMPLETE_UPLOAD');
   const sha256_hex=createHash('sha256').update(r.data).digest('hex');
   fs.writeFileSync(path.join(materialRoot,sha256_hex+'-'+r.filename),r.data);
   return {upload_id,filename:r.filename,media_type:r.media_type,
    size_bytes:r.size_bytes,sha256_hex,material_file_handle:'pcgfile:'+sha256_hex};
  },
  delete(upload_id){uploadRegistry.delete(upload_id);return {deleted:true}},
  markSendStarted(upload_id){return {upload_id,send_started:true}}
 };
}
const upload=mockUpload();
const routes=new Map();
const app={get(route,fn){routes.set(route,fn)}};
const stage=installWeChatMaterialDownloadBridge({app,root:materialRoot,
 materialUpload:upload,ttlMs:180000});
const adapter=createWeChatCachedMediaAdapter({root:path.join(root,'wechat'),
 materialUpload:upload,stageMaterialDownload:stage});
const makeError=(fn,code)=>assert.rejects(fn,e=>e?.code===code);
test('List decrypted cached file/image/video/audio without encrypted DAT or symlinks, with bounded unverifiable identity',()=>{
 const list=adapter.scan({limit:20});
 assert.equal(list.state,'ACHIEVED');
 assert.equal(list.files.length,4);
 assert.deepEqual(new Set(list.files.map(x=>x.media_kind)),new Set(['file','video','audio']));
 assert.ok(list.files.some(x=>x.filename==='synthetic-local-media-file.txt'));
 assert.equal(list.files.some(x=>x.filename==='encrypted.dat'),false);
 assert.equal(list.files.some(x=>x.filename==='linked.txt'),false);
 assert.equal(list.complete,false);
 assert.equal(list.message_attribution_verified,false);
 for(const f of list.files){
  assert.match(f.file_ref,/^wechatcache:[0-9a-f]{48}$/);
  assert.equal(f.provider_message_id,null);
  assert.equal(f.provider_sender_id,null);
  assert.equal(f.message_attribution_verified,false);
 }
 assert.equal(adapter.scan({kind:'audio'}).files.length,1);
 assert.equal(adapter.scan({kind:'video'}).files.length,1);
});
test('Retrieve exact listed TXT cache file via material plane and private 55m-style download gate',async()=>{
 const seen=adapter.scan({limit:10}).files.find(x=>x.filename.endsWith('.txt'));
 const out=await adapter.acquire({file_ref:seen.file_ref});
 assert.equal(out.state,'ACHIEVED');
 assert.equal(out.sha256_hex,createHash('sha256').update(source.txt).digest('hex'));
 assert.equal(out.message_attribution_verified,false);
 assert.equal(out.no_wechat_navigation,true);
 assert.match(out.download_path,/^\/mcp\/wechat-file\/[0-9a-f]{64}$/);
 const cb=routes.get('/mcp/wechat-file/:download_id');
 assert.equal(typeof cb,'function');
 const chunks=[];
 const res=new Writable({write(chunk,_encoding,done){chunks.push(Buffer.from(chunk));done();}});
 const headers={};res.setHeader=(k,v)=>{headers[k]=v};
 res.status=(code)=>{res.statusCode=code;return res};res.json=x=>{res.jsonBody=x};
 const done=new Promise(resolve=>res.once('finish',resolve));
 cb({params:{download_id:out.download_path.split('/').at(-1)}},res);
 await done;
 assert.deepEqual(Buffer.concat(chunks),source.txt);
 assert.equal(headers['content-type'],'text/plain');
 assert.match(headers['content-disposition'],/^attachment;/);
 assert.equal(headers['cache-control'],'private, no-store, max-age=0');
 await makeError(()=>adapter.acquire({file_ref:seen.file_ref}),
  'WECHAT_CACHE_REF_EXPIRED_OR_CHANGED');
});
test('Strict source proof rejects forged token and changed cached bytes',async()=>{
 await makeError(()=>adapter.acquire({file_ref:'wechatcache:'+'0'.repeat(48)}),
  'WECHAT_CACHE_REF_EXPIRED_OR_CHANGED');
 await makeError(()=>adapter.acquire({file_ref:'../../etc/passwd'}),
  'WECHAT_CACHE_REF_INVALID');
 const original=adapter.scan({kind:'video'}).files[0];
 create('video','fixture.mp4',Buffer.from('changed after list'));
 await makeError(()=>adapter.acquire({file_ref:original.file_ref}),
  'WECHAT_CACHE_REF_EXPIRED_OR_CHANGED');
});
test('CF registration: reusable upload tickets and bounded append, with zero WeChat UI sends',async()=>{
 const tools=new Map();
 const schema=new Proxy(function(){return schema},{get(_p,name){
  if(name==='enum')return()=>schema;
  return(..._args)=>schema;
 }});
 const z={enum:()=>schema,string:()=>schema,number:()=>schema,boolean:()=>schema};
 const server={registerTool:(name,spec,fn)=>tools.set(name,{spec,fn})};
 registerWeChatMediaTools(server,z,{cacheRoot:path.join(root,'wechat'),
  materialUpload:upload,stageMaterialDownload:stage});
 for(const name of ['wechat_file_upload','wechat_file_upload_chunk',
  'wechat_cached_media_list','wechat_cached_media_get',
  'wechat_file_send','wechat_native_voice_capability'])assert.ok(tools.has(name),name);
 const createTool=tools.get('wechat_file_upload').fn;
 const created=(await createTool({action:'create',filename:'synthetic.txt',
  media_type:'text/plain',size_bytes:source.txt.length})).structuredContent;
 assert.equal(created.state,'ACHIEVED');
 assert.equal(created.provider_send_performed,false);
 const chunk=(await tools.get('wechat_file_upload_chunk').fn({
  upload_id:created.upload_id,offset:0,
  data_base64:source.txt.toString('base64')})).structuredContent;
 assert.equal(chunk.offset,source.txt.length);
 const dry=(await tools.get('wechat_file_send').fn({
  target:'File Transfer',upload_id:created.upload_id,dry_run:true})).structuredContent;
 assert.equal(dry.state,'DRY_RUN_READY');
 assert.equal(dry.provider_send_performed,false);
 assert.equal(dry.provider_ui_file_picker_qualified,false);
 const blocked=(await tools.get('wechat_file_send').fn({
  target:'File Transfer',upload_id:created.upload_id,dry_run:false})).structuredContent;
 assert.equal(blocked.state,'FAILED');
 assert.equal(blocked.error.code,'WECHAT_FILE_SEND_PROVIDER_CHOOSER_UNQUALIFIED');
 const native=(await tools.get('wechat_native_voice_capability').fn({})).structuredContent;
 assert.equal(native.native_voice_send_qualified,false);
 assert.equal(native.native_voice_receive_qualified,false);
 const l=(await tools.get('wechat_cached_media_list').fn({limit:5})).structuredContent;
 assert.equal(l.state,'ACHIEVED');
 const get=(await tools.get('wechat_cached_media_get').fn({file_ref:l.files[0].file_ref}));
 assert.equal(get.structuredContent.state,'ACHIEVED');
 assert.equal(get.content[1].type,'resource_link');
 assert.match(get.content[1].uri,/^https:\/\/cf-onshape\.duckdns\.org\/mcp\/wechat-file\//);
});
test('Secure route requires unguessable download ID and TTL, not arbitrary path',()=>{
 const cb=routes.get('/mcp/wechat-file/:download_id');
 let statusCode=null,body=null;
 const res={status(code){statusCode=code;return this},json(x){body=x}};
 cb({params:{download_id:'../../etc/shadow'}},res);
 assert.equal(statusCode,404);
 assert.match(body.error,/not found|expired/);
});
test.after(()=>fs.rmSync(root,{recursive:true,force:true}));

test('Qualified future file sender cannot claim independently verified WeChat delivery',async()=>{
 const calls=[];
 const schema=new Proxy(function(){return schema},{get(){return()=>schema}});
 const z={enum:()=>schema,string:()=>schema,number:()=>schema,boolean:()=>schema};
 const registered=new Map();
 registerWeChatMediaTools({registerTool:(name,_spec,fn)=>registered.set(name,fn)},z,{
  cacheRoot:path.join(root,'wechat'),materialUpload:upload,
  stageMaterialDownload:stage,enableLiveFileSend:true,
  postJson:async (route,args)=>{
   calls.push({route,args});
   return {state:'ACKNOWLEDGED_UNVERIFIED',provider:'wechat',
    effect_may_have_occurred:true};
  }});
 const created=(await registered.get('wechat_file_upload')({action:'create',
  filename:'fixture.pdf',media_type:'application/pdf',
  size_bytes:source.pdf.length})).structuredContent;
 await registered.get('wechat_file_upload_chunk')({upload_id:created.upload_id,
  offset:0,data_base64:source.pdf.toString('base64')});
 const sent=(await registered.get('wechat_file_send')({target:'File Transfer',
  upload_id:created.upload_id,allow_mark_read:false})).structuredContent;
 assert.equal(sent.state,'ACKNOWLEDGED_UNVERIFIED');
 assert.equal(sent.provider_confirmed,false);
 assert.equal(sent.blind_retry_safe,false);
 assert.equal(calls.length,1);
 assert.equal(calls[0].route,'/file-send');
 assert.match(calls[0].args.path,
  /^\/var\/lib\/capability-fabric\/pcg\/run\/material-files\/[0-9a-f]{64}-fixture\.pdf$/);
 assert.equal(calls[0].args.allow_mark_read,false);
});
test('Uncertain post-dispatch transport cannot be reported as a safe failure or blindly repeated',async()=>{
 const schema=new Proxy(function(){return schema},{get(){return()=>schema}});
 const z={enum:()=>schema,string:()=>schema,number:()=>schema,boolean:()=>schema};
 const registered=new Map();
 registerWeChatMediaTools({registerTool:(name,_spec,fn)=>registered.set(name,fn)},z,{
  cacheRoot:path.join(root,'wechat'),materialUpload:upload,
  stageMaterialDownload:stage,enableLiveFileSend:true,
  postJson:async()=>{throw new Error('TRANSPORT_LOST_AFTER_SEND_STARTED')}});
 const created=(await registered.get('wechat_file_upload')({action:'create',
  filename:'fixture-unknown.txt',media_type:'text/plain',
  size_bytes:source.txt.length})).structuredContent;
 await registered.get('wechat_file_upload_chunk')({upload_id:created.upload_id,
  offset:0,data_base64:source.txt.toString('base64')});
 const result=(await registered.get('wechat_file_send')({target:'File Transfer',
  upload_id:created.upload_id})).structuredContent;
 assert.equal(result.state,'IN_DOUBT');
 assert.equal(result.blind_retry_safe,false);
 assert.equal(result.effect_may_have_occurred,true);
});
test('Multiple cached accounts are not silently merged into one owner identity',()=>{
 const alt=path.join(root,'wechat','wxid_otheraccount999999');
 fs.mkdirSync(alt,{recursive:true});
 assert.throws(()=>adapter.scan({limit:5}),
  e=>e?.code==='WECHAT_CACHE_ACCOUNT_NOT_UNIQUE');
 fs.rmSync(alt,{recursive:true,force:true});
});
