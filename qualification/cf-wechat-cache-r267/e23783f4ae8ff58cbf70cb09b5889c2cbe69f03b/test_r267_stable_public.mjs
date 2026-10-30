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
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'wx-r267-synthetic-'));
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
test('fresh upload wrapper in new MCP connection resolves old ref using current transport',async()=>{
 const f=fixture();
 try{
  const firstTransport=transport(),secondTransport=transport();
  const a=server();register(a,firstTransport,f.root);
  const ref=(await a.handler('wechat_cached_media_list')({kind:'all',limit:10})).structuredContent.files[0].file_ref;
  const b=server();register(b,secondTransport,f.root);
  const out=(await b.handler('wechat_cached_media_get')({file_ref:ref})).structuredContent;
  assert.equal(out.state,'ACHIEVED');
  assert.equal(secondTransport.records.size,1);
  assert.equal(firstTransport.records.size,0);
  const replay=(await a.handler('wechat_cached_media_get')({file_ref:ref})).structuredContent;
  assert.equal(replay.state,'FAILED');
  assert.equal(replay.error.code,'WECHAT_CACHE_REF_EXPIRED_OR_CHANGED');
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


test('different cache roots remain isolated even with the same material transport',async()=>{
 const first=fixture(),second=fixture(),u=transport();
 try{
  const a=server(),b=server();
  register(a,u,first.root);register(b,u,second.root);
  const ref=(await a.handler('wechat_cached_media_list')({kind:'file',limit:10})).structuredContent.files[0].file_ref;
  const wrong=(await b.handler('wechat_cached_media_get')({file_ref:ref})).structuredContent;
  assert.equal(wrong.state,'FAILED');
  assert.equal(wrong.error.code,'WECHAT_CACHE_REF_EXPIRED_OR_CHANGED');
  const right=(await a.handler('wechat_cached_media_get')({file_ref:ref})).structuredContent;
  assert.equal(right.state,'ACHIEVED');
 }finally{fs.rmSync(first.root,{recursive:true,force:true});fs.rmSync(second.root,{recursive:true,force:true})}
});

test('simultaneous requests cannot stage one opaque capability twice',async()=>{
 const f=fixture(),u1=transport(),u2=transport();
 try{
  const a=server(),b=server(); register(a,u1,f.root);register(b,u2,f.root);
  const ref=(await a.handler('wechat_cached_media_list')({kind:'file',limit:10})).structuredContent.files[0].file_ref;
  const [one,two]=await Promise.all([
   a.handler('wechat_cached_media_get')({file_ref:ref}),
   b.handler('wechat_cached_media_get')({file_ref:ref}),
  ]);
  const states=[one.structuredContent.state,two.structuredContent.state];
  assert.deepEqual(states.sort(),['ACHIEVED','FAILED']);
  assert.equal(u1.records.size+u2.records.size,1);
 }finally{fs.rmSync(f.root,{recursive:true,force:true})}
});

test('twenty-minute token expiry and pruning work with an externally shared ledger',async()=>{
 const f=fixture();
 try{
  const {createWeChatCachedMediaAdapter}=await import('./wechat_media_cache_adapter_v1.mjs');
  let current=1234567890000;
  const ledger=new Map();
  const adapter=createWeChatCachedMediaAdapter({root:f.root,materialUpload:transport(),
   stageMaterialDownload:async()=>({download_path:'/mcp/wechat-file/test'}),issued:ledger,now:()=>current});
  const ref=adapter.scan({kind:'file',limit:1}).files[0].file_ref;
  assert.equal(ledger.size,1);
  current+=20*60*1000;
  await assert.rejects(()=>adapter.acquire({file_ref:ref}),e=>e.code==='WECHAT_CACHE_REF_EXPIRED_OR_CHANGED');
  assert.equal(ledger.size,0);
  adapter.scan({kind:'file',limit:1});
  assert.equal(ledger.size,1);
 }finally{fs.rmSync(f.root,{recursive:true,force:true})}
});

test('bounded ledger fails closed without evicting unexpired issued refs',async()=>{
 const f=fixture();
 try{
  const {createWeChatCachedMediaAdapter}=await import('./wechat_media_cache_adapter_v1.mjs');
  const ledger=new Map();
  for(let i=0;i<4096;i++)ledger.set('opaque'+i,{expires:Date.now()+600000});
  const adapter=createWeChatCachedMediaAdapter({root:f.root,issued:ledger});
  assert.throws(()=>adapter.scan({kind:'file',limit:1}),e=>e.code==='WECHAT_CACHE_REF_CAPACITY_REACHED');
  assert.equal(ledger.size,4096);
 }finally{fs.rmSync(f.root,{recursive:true,force:true})}
});

test('failed staging consumes capability and forbids uncertain blind retry',async()=>{
 const f=fixture();
 try{
  const broken={...transport(),create:async()=>{throw Error('STAGING_TEMPORARILY_UNAVAILABLE')}};
  const s=server();register(s,broken,f.root);
  const ref=(await s.handler('wechat_cached_media_list')({kind:'file',limit:1})).structuredContent.files[0].file_ref;
  const first=(await s.handler('wechat_cached_media_get')({file_ref:ref})).structuredContent;
  assert.equal(first.state,'FAILED');
  const restored=server();register(restored,transport(),f.root);
  const again=(await restored.handler('wechat_cached_media_get')({file_ref:ref})).structuredContent;
  assert.equal(again.state,'FAILED');
  assert.equal(again.error.code,'WECHAT_CACHE_REF_EXPIRED_OR_CHANGED');
 }finally{fs.rmSync(f.root,{recursive:true,force:true})}
});


test('two calls sharing one upload object cannot both consume same ref',async()=>{
 const f=fixture(),u=transport();
 try{
  const a=server(),b=server();register(a,u,f.root);register(b,u,f.root);
  const ref=(await a.handler('wechat_cached_media_list')({kind:'file',limit:1})).structuredContent.files[0].file_ref;
  const [left,right]=await Promise.all([
   a.handler('wechat_cached_media_get')({file_ref:ref}),
   b.handler('wechat_cached_media_get')({file_ref:ref})]);
  assert.deepEqual([left.structuredContent.state,right.structuredContent.state].sort(),['ACHIEVED','FAILED']);
  assert.equal(u.records.size,1);
 }finally{fs.rmSync(f.root,{recursive:true,force:true})}
});
