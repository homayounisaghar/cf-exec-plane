import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import {fileURLToPath} from 'node:url';
import {webcrypto} from 'node:crypto';

const ROOT=path.dirname(fileURLToPath(import.meta.url));
const PRIMARY='https://cf-mirror-bridge.mirkazem-design.workers.dev';
const BACKUP='https://cf-mirror-bridge.mirkazem.workers.dev';
const UPSTREAM='https://remote-private.trycloudflare.com';
const TOKEN='C'.repeat(43);
const COOKIE='cfm_auth='+'Z'.repeat(43);
const env=()=>({
  MIRROR_UPSTREAM:UPSTREAM,
  PUBLIC_ORIGIN:PRIMARY,
  MIRROR_EXPIRES_AT:String(Date.now()+150000)
});
let moduleCounter=0;
async function freshWorker(){
  return (await import('../worker.mjs?fresh='+ ++moduleCounter)).default;
}
function manifest(origins,minutes=15){
  return {schema:'cf-mirror.worker-pool.v1',origins,rotationMinutes:minutes};
}
function request(path='/',options={}){
  return new Request(PRIMARY+path,options);
}
async function withMockFetch(mock,fn){
  const previous=globalThis.fetch;
  globalThis.fetch=mock;
  try{return await fn();}finally{globalThis.fetch=previous;}
}
const makeHtml=()=>new Response('<html><body>Session password</body></html>',{
  headers:{'content-type':'text/html; charset=utf-8',
    'content-security-policy':"default-src 'self'; script-src 'self' 'unsafe-inline'; connect-src 'self' wss://remote-private.trycloudflare.com"}
});

test('dynamic 2-account rotation assigns new logins to next healthy origin, not active cookies',async()=>{
  const worker=await freshWorker();
  const config=env();
  let sourceKey;
  const health=await worker.fetch(request('/__bridge-health'),config);
  assert.equal(health.status,200);
  sourceKey=(await health.json()).sourceKey;
  const callLog=[];
  const originalDate=Date.now;
  Date.now=()=>21*15*60000+3000; // time-slot 21 -> origin index 1
  try{
    const result=await withMockFetch(async (url,options)=>{
      const target=typeof url==='string'?url:url.url;callLog.push(target);
      if(target.includes('raw.githubusercontent.com')){
        assert.equal(options.headers.cookie,undefined);
        return Response.json(manifest([PRIMARY,BACKUP]));
      }
      if(target===BACKUP+'/__bridge-health'){
        return Response.json({ok:true,proxy:'cf-mirror-universal',
          currentOrigin:BACKUP,sourceKey});
      }
      if(target===UPSTREAM+'/')return makeHtml();
      throw Error('Unexpected fetch '+target);
    },async()=>{
      const first=await worker.fetch(request('/'),config);
      assert.equal(first.status,302);
      assert.equal(new URL(first.headers.get('location')).origin,BACKUP);
      assert.equal(new URL(first.headers.get('location')).searchParams.get('__cfm_entry'),'1');
      // An existing authenticated user's requests never rotate to another
      // origin; the session's host-only cookie stays pinned to original.
      const existing=await worker.fetch(request('/',{headers:{cookie:COOKIE}}),config);
      assert.equal(existing.status,200);
      assert((await existing.text()).includes('serviceWorker.register'));
      return first;
    });
    assert.equal(result.status,302);
    assert(callLog.includes(BACKUP+'/__bridge-health'));
  }finally{Date.now=originalDate}
});

test('a new Worker account is added by registry only; source is unchanged and ring has 7 slots',async()=>{
  const worker=await freshWorker(),config=env();
  const origins=Array.from({length:7},(_,i)=>
    'https://cf-mirror-bridge.account-'+i+'.workers.dev');
  origins[0]=PRIMARY;
  const key=(await (await worker.fetch(request('/__bridge-health'),config)).json()).sourceKey;
  const old=Date.now;
  Date.now=()=>6*15*60000+1000;
  try{
    const response=await withMockFetch(async (url)=>{
      const target=typeof url==='string'?url:url.url;
      if(target.includes('raw.githubusercontent.com'))return Response.json(manifest(origins));
      if(target===origins[6]+'/__bridge-health')
        return Response.json({ok:true,proxy:'cf-mirror-universal',currentOrigin:origins[6],sourceKey:key});
      if(target===UPSTREAM+'/')return makeHtml();
      throw Error('Unexpected '+target);
    },()=>worker.fetch(request('/'),config));
    assert.equal(response.status,302);
    assert.equal(new URL(response.headers.get('location')).origin,origins[6]);
  }finally{Date.now=old}
});

test('wrong-upstream Worker is never selected; a missing pool safely uses current origin',async()=>{
  const worker=await freshWorker(),config=env();
  const old=Date.now;Date.now=()=>21*15*60000+1000;
  try{
    const response=await withMockFetch(async url=>{
      const target=typeof url==='string'?url:url.url;
      if(target.includes('raw.githubusercontent.com'))return Response.json(manifest([PRIMARY,BACKUP]));
      if(target===BACKUP+'/__bridge-health')
        return Response.json({ok:true,proxy:'cf-mirror-universal',currentOrigin:BACKUP,sourceKey:'0'.repeat(16)});
      if(target===UPSTREAM+'/')return makeHtml();
      throw Error('Unexpected '+target);
    },()=>worker.fetch(request('/'),config));
    assert.equal(response.status,200);
    assert((await response.text()).includes('Session password'));
  }finally{Date.now=old}
});

test('pool endpoint has no secret data, versioned schema, and CORS for SW preflight',async()=>{
  const worker=await freshWorker(),config=env();
  const r=await withMockFetch(async url=>{
    assert(String(url).includes('raw.githubusercontent.com'));
    return Response.json(manifest([PRIMARY,BACKUP]));
  },()=>worker.fetch(request('/__bridge-pool'),config));
  const body=await r.json();
  assert.equal(body.schema,'cf-mirror.worker-pool.v1');
  assert.equal(body.origins.length,2);
  assert.equal(r.headers.get('access-control-allow-origin'),'*');
  assert(!JSON.stringify(body).includes(UPSTREAM));
  assert(!JSON.stringify(body).includes(COOKIE));
});

test('SW catches quota 1027, selects verified next Worker, and bounds one complete N-account cycle',async()=>{
  const js=fs.readFileSync(path.join(ROOT,'../service-worker.js'),'utf8');
  async function runCase(pool,hop,method='GET'){
    const handlers={},messages=[],requests=[],store=new Map();
    const key='1234567890abcdef';
    const caches={open:async()=>({
      put:async(k,res)=>{store.set(k,res.clone());},
      match:async k=>store.get(k)?.clone()||null
    })};
    const clients={claim:async()=>{},get:async()=>({postMessage:msg=>messages.push(msg)})};
    const self={location:{origin:pool[0]},addEventListener:(k,f)=>handlers[k]=f,clients,skipWaiting:async()=>{}};
    const fetch=async (input)=>{
      const url=typeof input==='string'?input:input.url;
      requests.push(url);
      if(url==='/__bridge-pool')return Response.json({
        schema:'cf-mirror.worker-pool.v1',origins:pool,sourceKey:key
      });
      if(url===pool[1]+'/__bridge-health')return Response.json({
        ok:true,proxy:'cf-mirror-universal',
        currentOrigin:pool[1],sourceKey:key
      },{headers:{'access-control-allow-origin':'*'}});
      return new Response('Error 1027: Worker exceeded free tier daily request limit',
        {status:503,headers:{'content-type':'text/html'}});
    };
    const globals={self,fetch,caches,URL,Response,Request,Headers,AbortSignal,
      setTimeout,clearTimeout,console};
    vm.runInNewContext(js,globals,{timeout:3000});
    const url=new URL('/',pool[0]);if(hop)url.searchParams.set('__cfm_hop',String(hop));
    const event={request:{url:url.href,method,mode:method==='GET'?'navigate':'same-origin'},
      clientId:'client-1',respondWith:p=>event.reply=p};
    handlers.fetch(event);
    const res=await event.reply;
    return {res,messages,requests};
  }
  const n=7,pool=Array.from({length:n},(_,i)=>
    'https://cf-mirror-bridge.account-'+i+'.workers.dev');
  const a=await runCase(pool,0);
  assert.equal(a.res.status,302);
  assert.equal(new URL(a.res.headers.get('location')).origin,pool[1]);
  assert.equal(new URL(a.res.headers.get('location')).searchParams.get('__cfm_hop'),'1');
  const end=await runCase(pool,n-1);
  assert.equal(end.res.status,503);
  assert.match(await end.res.text(),/POOL_EXHAUSTED/);
  const post=await runCase(pool,0,'POST');
  assert.equal(post.res.status,503);
  assert.equal(post.messages.length,1);
  assert.equal(post.messages[0].type,'CFM_QUOTA_FAILOVER');
  // No POST replay anywhere else in the account ring.
  assert(post.requests.every(x=>!x.includes('/move-rel')));
});

test('SW and installation script are same-origin, versioned, and never expose backend ports',async()=>{
  const worker=await freshWorker(),config=env();
  const r=await worker.fetch(request('/sw.js'),config);
  assert.equal(r.status,200);
  assert.match(r.headers.get('content-type'),/javascript/);
  assert.equal(r.headers.get('service-worker-allowed'),'/');
  const source=await r.text();
  assert(source.includes('CFM_QUOTA_FAILOVER'));
  assert(source.includes('/__bridge-pool'));
  assert(!source.includes('127.0.0.1:9325'));
});
