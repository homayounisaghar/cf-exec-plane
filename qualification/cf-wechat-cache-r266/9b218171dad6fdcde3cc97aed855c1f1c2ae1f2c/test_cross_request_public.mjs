import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {registerWeChatMediaTools} from './wechat-media-tools.mjs';

const chain = new Proxy({}, {get:()=>()=>chain});
const z={enum:()=>chain,string:()=>chain,number:()=>chain,boolean:()=>chain};
function server(){
 const handlers=new Map();
 return {
  registerTool(name,desc,callback){assert(!handlers.has(name));handlers.set(name,callback)},
  handler(name){const h=handlers.get(name);assert.equal(typeof h,'function',name);return h}
 };
}
function transport(){
 const records=new Map();
 let count=0;
 return {
  records,
  create:async({filename,media_type,size_bytes})=>{
   const upload_id=(++count).toString(16).padStart(64,'0');
   records.set(upload_id,{filename,media_type,size_bytes,parts:[],offset:0});
   return {upload_id};
  },
  append:async(id,at,{data_base64})=>{
   const rec=records.get(id);assert(rec);
   assert.equal(at,rec.offset);
   const part=Buffer.from(data_base64,'base64');
   rec.parts.push(part);rec.offset+=part.length;
   return {offset:rec.offset};
  },
  ready:async id=>{
   const rec=records.get(id);assert(rec);
   const bytes=Buffer.concat(rec.parts);
   assert.equal(bytes.length,rec.size_bytes);
   return {
    upload_id:id,filename:rec.filename,mime_type:rec.media_type,
    size_bytes:rec.size_bytes,
    sha256_hex:createHash('sha256').update(bytes).digest('hex')
   };
  },
  delete:async id=>{records.delete(id);return {deleted:true}},
  status:async id=>({exists:records.has(id)}),
  markSendStarted:()=>true
 };
}
function fixture(){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'wx-r266-synthetic-'));
 const directory=path.join(root,'wxid_testing_12345','msg','file','2026');
 fs.mkdirSync(directory,{recursive:true});
 const content=Buffer.from('Synthetic, private-free local sample for MCP tests.');
 const filename=path.join(directory,'sample.txt');
 fs.writeFileSync(filename,content,{mode:0o600});
 return {root,filename,content};
}
function register(s,materialUpload,cacheRoot){
 registerWeChatMediaTools(s,z,{cacheRoot,materialUpload,
  stageMaterialDownload:async()=>({
   download_path:'/mcp/wechat-file/test-ephemeral',expires_after_seconds:600
  })
 });
}
test('opaque file ref survives independent MCP server registrations and is one-shot',async()=>{
 const f=fixture(),u=transport();
 try{
  const s1=server(); register(s1,u,f.root);
  const list=(await s1.handler('wechat_cached_media_list')({kind:'file',limit:10})).structuredContent;
  assert.equal(list.state,'ACHIEVED');
  assert.equal(list.files.length,1);
  const ref=list.files[0].file_ref;
  assert.match(ref,/^wechatcache:[0-9a-f]{48}$/);
  const s2=server(); register(s2,u,f.root);
  const obtained=(await s2.handler('wechat_cached_media_get')({file_ref:ref})).structuredContent;
  assert.equal(obtained.state,'ACHIEVED');
  assert.equal(obtained.size_bytes,f.content.length);
  assert.equal(obtained.sha256_hex,createHash('sha256').update(f.content).digest('hex'));
  assert.equal(obtained.message_attribution_verified,false);
  assert.equal(obtained.no_wechat_navigation,true);
  const again=(await s1.handler('wechat_cached_media_get')({file_ref:ref})).structuredContent;
  assert.equal(again.state,'FAILED');
  assert.equal(again.error.code,'WECHAT_CACHE_REF_EXPIRED_OR_CHANGED');
 }finally{fs.rmSync(f.root,{recursive:true,force:true})}
});
test('refs cannot jump to a different transport or source root',async()=>{
 const f=fixture();
 try{
  const u1=transport(),u2=transport();
  const a=server();register(a,u1,f.root);
  const ref=(await a.handler('wechat_cached_media_list')({kind:'all',limit:10})).structuredContent.files[0].file_ref;
  const b=server();register(b,u2,f.root);
  const out=(await b.handler('wechat_cached_media_get')({file_ref:ref})).structuredContent;
  assert.equal(out.state,'FAILED');
  assert.equal(out.error.code,'WECHAT_CACHE_REF_EXPIRED_OR_CHANGED');
 }finally{fs.rmSync(f.root,{recursive:true,force:true})}
});
test('stale or modified local bytes reject before material transport',async()=>{
 const f=fixture(),u=transport();
 try{
  const a=server();register(a,u,f.root);
  const ref=(await a.handler('wechat_cached_media_list')({kind:'file',limit:10})).structuredContent.files[0].file_ref;
  fs.appendFileSync(f.filename,'bad mutation');
  const b=server();register(b,u,f.root);
  const out=(await b.handler('wechat_cached_media_get')({file_ref:ref})).structuredContent;
  assert.equal(out.state,'FAILED');
  assert.equal(out.error.code,'WECHAT_CACHE_REF_EXPIRED_OR_CHANGED');
  assert.equal(u.records.size,0);
 }finally{fs.rmSync(f.root,{recursive:true,force:true})}
});
