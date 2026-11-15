import assert from 'node:assert/strict';
import test from 'node:test';
import {gzipSync} from 'node:zlib';
import worker from '../worker.mjs';

const PUBLIC='https://cf-mirror-bridge.mirkazem.workers.dev';
const ORIGIN='https://sample-mirror-origin.trycloudflare.com';
const CONFIG={
  MIRROR_UPSTREAM:ORIGIN,
  PUBLIC_ORIGIN:PUBLIC,
  MIRROR_EXPIRES_AT:String(Date.now()+180000),
};
const SESSION='cfm_auth='+'A'.repeat(43);
const TOKEN='B'.repeat(43);

async function withFetch(mock, fn){
  const original=globalThis.fetch;
  globalThis.fetch=mock;
  try{return await fn();}finally{globalThis.fetch=original;}
}
const req=(path,options={})=>new Request(PUBLIC+path,options);

test('missing or unsafe origin configuration refuses requests',async()=>{
  for(const val of ['', 'http://127.0.0.1:9222','https://localhost:1234','https://attacker.example']){
    const r=await worker.fetch(req('/'),{...CONFIG,MIRROR_UPSTREAM:val});
    assert.equal(r.status,503);
  }
  const r=await worker.fetch(req('/'),{...CONFIG,PUBLIC_ORIGIN:'https://evil.example'});
  assert.equal(r.status,503);
});

test('unexpected public host and expired source are rejected',async()=>{
  let r=await worker.fetch(new Request('https://untrusted.workers.dev/'),CONFIG);
  assert.equal(r.status,421);
  r=await worker.fetch(req('/'),{...CONFIG,MIRROR_EXPIRES_AT:String(Date.now()-10)});
  assert.equal(r.status,410);
});

test('health uses no origin request and reveals no credentials or source host',async()=>{
  const r=await withFetch(()=>{throw Error('no upstream fetch expected')},()=>worker.fetch(req('/__bridge-health'),CONFIG));
  assert.equal(r.status,200);
  const text=await r.text();
  assert(!text.includes(ORIGIN));
  assert(!text.includes('cookie'));
});

test('public login POST retains password body, CSRF and host-only Set-Cookie',async()=>{
  let captured;
  const loginBody='password=example&csrf=abcdef';
  const browserRequest=req('/login',{method:'POST',headers:{
    'origin':PUBLIC,
    'sec-fetch-site':'same-origin',
    'content-type':'application/x-www-form-urlencoded',
    'cookie':SESSION,
  },body:loginBody});
  const r=await withFetch(async (target,options)=>{
    captured={url:target,options};
    return new Response('',{status:303,headers:{
      'location':'/',
      'set-cookie':SESSION+'; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=800',
      'cache-control':'private',
    }});
  },()=>worker.fetch(browserRequest,CONFIG));
  assert.equal(r.status,303);
  assert.equal(r.headers.get('location'),PUBLIC+'/');
  assert(r.headers.get('set-cookie').includes('HttpOnly'));
  assert(r.headers.get('set-cookie').includes('SameSite=Strict'));
  assert.match(r.headers.get('cache-control'),/no-store/);
  assert.equal(captured.url,ORIGIN+'/login');
  assert.equal(captured.options.headers.get('origin'),ORIGIN);
  assert.equal(captured.options.headers.get('cookie'),SESSION);
  assert.equal(await new Response(captured.options.body).text(),loginBody);
  assert.equal(captured.options.redirect,'manual');
});

test('control POST forwards authenticated CSRF and origin, blocks hostile browser Origin',async()=>{
  let n=0;
  await withFetch(async (url,options)=>{
    n++;
    assert.equal(url,ORIGIN+'/move-rel');
    assert.equal(options.method,'POST');
    assert.equal(options.headers.get('x-cf-mirror-csrf'),TOKEN);
    assert.equal(options.headers.get('cookie'),SESSION);
    assert.equal(options.headers.get('origin'),ORIGIN);
    return Response.json({ok:true});
  },async()=>{
    const valid=req('/move-rel',{method:'POST',headers:{
      'origin':PUBLIC,'sec-fetch-site':'same-origin',
      'x-cf-mirror-csrf':TOKEN,'cookie':SESSION,
      'content-type':'application/json',
    },body:JSON.stringify({dx:12,dy:4})});
    assert.equal((await worker.fetch(valid,CONFIG)).status,200);
    const cross=req('/move-rel',{method:'POST',headers:{
      'origin':'https://evil.example','cookie':SESSION,
      'x-cf-mirror-csrf':TOKEN,
    },body:'{}'});
    assert.equal((await worker.fetch(cross,CONFIG)).status,403);
  });
  assert.equal(n,1);
});

test('missing Origin mobile POST remains gateway-CSRF protected, cross-site fetch is denied',async()=>{
  let n=0;
  await withFetch(async (_u,options)=>{
    n++;
    assert.equal(options.headers.get('origin'),null);
    assert.equal(options.headers.get('x-cf-mirror-csrf'),TOKEN);
    return Response.json({ok:true});
  },async()=>{
    assert.equal((await worker.fetch(req('/key',{method:'POST',headers:{
      'x-cf-mirror-csrf':TOKEN,'cookie':SESSION,
    },body:'{"key":"Escape"}'}),CONFIG)).status,200);
    assert.equal((await worker.fetch(req('/key',{method:'POST',headers:{
      'sec-fetch-site':'cross-site',
      'x-cf-mirror-csrf':TOKEN,'cookie':SESSION,
    },body:'{"key":"Escape"}'}),CONFIG)).status,403);
  });
  assert.equal(n,1);
});

test('MJPEG and JPEG are streamed rather than buffered or transcoded',async()=>{
  const frame=new Uint8Array([0xff,0xd8,0x00,0x21,0xff,0xd9]);
  let closed=0;
  const stream=new ReadableStream({start(controller){controller.enqueue(frame);controller.close();closed++}});
  const result=await withFetch(async(target)=> {
    assert.equal(target,ORIGIN+'/stream.mjpg?x=9');
    return new Response(stream,{headers:{
      'content-type':'multipart/x-mixed-replace; boundary=cfmframe',
      'cache-control':'no-store',
    }});
  },()=>worker.fetch(req('/stream.mjpg?x=9'),CONFIG));
  assert.equal(result.status,200);
  assert.equal(result.headers.get('content-type'),'multipart/x-mixed-replace; boundary=cfmframe');
  assert(result.body);
  assert.deepEqual(new Uint8Array(await result.arrayBuffer()),frame);
  assert.equal(closed,1);
  assert.match(result.headers.get('cache-control'),/no-transform/);
});

test('CSP self + exact worker WSS origin retains mic and iframe restrictions',async()=>{
  const upstreamCsp="default-src 'self'; img-src 'self' data: blob:; style-src 'self'; script-src 'self'; frame-src 'self'; connect-src 'self' wss://sample-mirror-origin.trycloudflare.com; form-action 'self'; frame-ancestors 'self'";
  const r=await withFetch(async()=>new Response('<html>mirror</html>',{headers:{
    'content-type':'text/html; charset=utf-8',
    'content-security-policy':upstreamCsp,
    'permissions-policy':'camera=(), microphone=(self), geolocation=()',
    'x-frame-options':'SAMEORIGIN',
  }}),()=>worker.fetch(req('/view/'),CONFIG));
  const csp=r.headers.get('content-security-policy');
  assert(csp.includes('wss://cf-mirror-bridge.mirkazem.workers.dev'));
  assert(!csp.includes('sample-mirror-origin.trycloudflare.com'));
  assert(csp.includes("frame-ancestors 'self'"));
  assert.equal(r.headers.get('permissions-policy'),'camera=(), microphone=(self), geolocation=()');
  assert.equal(r.headers.get('x-frame-options'),'SAMEORIGIN');
});

test('gzip HTTP responses keep their encoding and raw bytes intact',async()=>{
  const original=new TextEncoder().encode('Sensitive login content with UTF-8: سلام');
  const compressed=gzipSync(original);
  const result=await withFetch(async()=>new Response(compressed,{
    headers:{'content-type':'text/html; charset=utf-8','content-encoding':'gzip','content-length':String(compressed.length)}
  }),()=>worker.fetch(req('/'),CONFIG));
  assert.equal(result.headers.get('content-encoding'),'gzip');
  assert.equal(result.headers.get('content-length'),null);
  assert.deepEqual(Buffer.from(await result.arrayBuffer()),compressed);
});

test('both WebSocket routes relay 101 opaque without decoding client frames',async()=>{
  const forwarded=[];
  const sock={kind:'opaque-ws'};
  await withFetch(async (target,options)=>{
    forwarded.push({target,headers:options.headers});
    return {status:101,webSocket:sock};
  },async()=>{
    for(const [path,protocol] of [['/input-ws','cfm-input'],['/mic-ws','cfm-mic']]){
      const r=await worker.fetch(req(path,{headers:{
        'origin':PUBLIC,
        'upgrade':'websocket',
        'cookie':SESSION,
        'sec-websocket-protocol':protocol+', '+TOKEN,
      }}),CONFIG);
      assert.equal(r.status,101);
      assert.equal(r.webSocket,sock);
    }
  });
  assert.equal(forwarded.length,2);
  for(let i=0;i<2;i++){
    assert.equal(forwarded[i].target,ORIGIN+['/input-ws','/mic-ws'][i]);
    assert.equal(forwarded[i].headers.get('cookie'),SESSION);
    assert.equal(forwarded[i].headers.get('origin'),ORIGIN);
    assert.equal(forwarded[i].headers.get('upgrade'),'websocket');
    assert(forwarded[i].headers.get('sec-websocket-protocol').includes(TOKEN));
  }
});

test('WebSockets reject unauthenticated/CSRF-less/cross-origin/unknown route',async()=>{
  const baseHeaders={'origin':PUBLIC,'upgrade':'websocket','cookie':SESSION,
    'sec-websocket-protocol':'cfm-input, '+TOKEN};
  await withFetch(()=>{throw Error('Invalid request must not reach origin')},async()=>{
    assert.equal((await worker.fetch(req('/input-ws',{headers:{
      ...baseHeaders,cookie:'',
    }}),CONFIG)).status,401);
    assert.equal((await worker.fetch(req('/input-ws',{headers:{
      ...baseHeaders,'sec-websocket-protocol':'cfm-input',
    }}),CONFIG)).status,403);
    assert.equal((await worker.fetch(req('/input-ws',{headers:{
      ...baseHeaders,'origin':'https://evil.example',
    }}),CONFIG)).status,403);
    assert.equal((await worker.fetch(req('/private-ws',{headers:baseHeaders}),CONFIG)).status,404);
  });
});
