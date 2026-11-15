import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker.mjs';

const PUBLIC='https://cf-mirror-bridge.mirkazem-design.workers.dev';
const UPSTREAM='https://browser-origin.trycloudflare.com';
const ENV={
  MIRROR_UPSTREAM:UPSTREAM,
  PUBLIC_ORIGIN:PUBLIC,
  MIRROR_EXPIRES_AT:String(Date.now()+120000)
};
const TOKEN='Q'.repeat(43);
const COOKIE='cfm_auth='+'R'.repeat(43);
const req=(p,o={})=>new Request(PUBLIC+p,o);
async function mockFetch(mock,fn){
 const old=globalThis.fetch;
 globalThis.fetch=mock;
 try{return await fn()}finally{globalThis.fetch=old}
}
const OK_HTML=new Response('<html><body>Private browser</body></html>',
 {headers:{'content-type':'text/html'}});
const LOGIN_OK=()=>new Response(null,{status:303,headers:{location:'/',
 'set-cookie':COOKIE+'; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=100'}});

test('Android post-login read-only GET navigation with Origin:null must not be denied',async()=>{
 let calls=0;
 await mockFetch(async url=>{
   assert.equal(url,UPSTREAM+'/');
   calls++;
   return OK_HTML.clone();
 },async()=>{
   const r=await worker.fetch(req('/',{headers:{
     'origin':'null','sec-fetch-site':'same-site','cookie':COOKIE
   }}),ENV);
   assert.equal(r.status,200);
   assert.match(await r.text(),/Private browser/);
 });
 assert.equal(calls,1);
});

test('login POST with exact Origin and legitimate same-site metadata is allowed',async()=>{
 await mockFetch(async (url,opt)=>{
   assert.equal(url,UPSTREAM+'/login');
   assert.equal(opt.method,'POST');
   assert.equal(opt.headers.get('origin'),UPSTREAM);
   assert.match(await new Response(opt.body).text(),/csrf=/);
   return LOGIN_OK();
 },async()=>{
   const r=await worker.fetch(req('/login',{method:'POST',headers:{
    'origin':PUBLIC,'sec-fetch-site':'same-site',
    'content-type':'application/x-www-form-urlencoded',
   },body:'csrf=abc&password=placeholder'}),ENV);
   assert.equal(r.status,303);
   assert.equal(r.headers.get('location'),PUBLIC+'/');
 });
});

test('privacy mobile login with null Origin requires same-origin site or Referer',async()=>{
 let calls=0;
 await mockFetch(async(url,opt)=>{
   calls++;assert.equal(url,UPSTREAM+'/login');
   // After the Worker validates the browser request, the gateway sees its
   // own expected origin; it still validates the hidden login CSRF token.
   assert.equal(opt.headers.get('origin'),UPSTREAM);
   return LOGIN_OK();
 },async()=>{
   const ok=await worker.fetch(req('/login',{method:'POST',headers:{
     'origin':'null','sec-fetch-site':'same-origin',
     'content-type':'application/x-www-form-urlencoded'
   },body:'csrf=test&password=placeholder'}),ENV);
   assert.equal(ok.status,303);

   const okRef=await worker.fetch(req('/login',{method:'POST',headers:{
     'origin':'null','referer':PUBLIC+'/login',
     'content-type':'application/x-www-form-urlencoded'
   },body:'csrf=test&password=placeholder'}),ENV);
   assert.equal(okRef.status,303);
 });
 assert.equal(calls,2);
});

test('cross-origin and metadata-only cross-site login attempts stay blocked',async()=>{
 await mockFetch(()=>{throw Error('Cross-origin login must not fetch upstream')},async()=>{
   for(const headers of [
     {'origin':'https://evil.example','sec-fetch-site':'same-origin'},
     {'origin':'null','sec-fetch-site':'cross-site'},
     {'sec-fetch-site':'cross-site'},
     {'origin':'https://evil.example','referer':PUBLIC+'/login'},
     {'origin':'null','sec-fetch-site':'none'}
   ]){
     const r=await worker.fetch(req('/login',{method:'POST',headers,
       body:'csrf=test&password=placeholder'}),ENV);
     assert.equal(r.status,403,JSON.stringify(headers));
     assert.match(await r.text(),/Origin denied/);
   }
 });
});

test('cross-origin mutating controls are still rejected even with claimed same-site',async()=>{
 await mockFetch(()=>{throw Error('Control must not reach upstream')},async()=>{
   for(const headers of [
     {'origin':'null','sec-fetch-site':'same-origin'},
     {'origin':'https://evil.example','sec-fetch-site':'same-origin'},
     {'origin':PUBLIC,'sec-fetch-site':'same-site'},
     {'origin':PUBLIC,'sec-fetch-site':'cross-site'}
   ]){
     const r=await worker.fetch(req('/move-rel',{method:'POST',headers,
       body:'{"dx":1}'}),ENV);
     assert.equal(r.status,403,JSON.stringify(headers));
   }
 });
});

test('WebSocket remains strictly same-origin and requires signed cookie+CSRF',async()=>{
 const h={'origin':PUBLIC,'upgrade':'websocket','cookie':COOKIE,
   'sec-websocket-protocol':'cfm-input, '+TOKEN,'sec-fetch-site':'same-origin'};
 await mockFetch(async (url,opt)=>{
   assert.equal(url,UPSTREAM+'/input-ws');
   assert.equal(opt.headers.get('origin'),UPSTREAM);
   return {status:101,webSocket:{ok:true}};
 },async()=>{
  for(const origin of ['null','https://evil.example']){
   const r=await worker.fetch(req('/input-ws',{headers:{...h,origin}}),ENV);
   assert.equal(r.status,403);
  }
  const ok=await worker.fetch(req('/input-ws',{headers:h}),ENV);
  assert.equal(ok.status,101);
 });
});
