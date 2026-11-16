import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';
import {spawn,execFileSync} from 'node:child_process';
import worker,{VERSION} from './worker.mjs';

const ORIGIN='https://cf-mirror-bridge.mirkazem-design.workers.dev';
const mkServer=(label)=>new Promise(resolve=>{
 const server=http.createServer((req,res)=>{
  if(req.url==='/login'&&req.method==='POST'){
   res.writeHead(303,{location:'/','set-cookie':'cfm_auth='+label+'sessioncookie; Path=/; HttpOnly; Secure; SameSite=Strict'});res.end();return;
  }
  if(req.url==='/shot.jpg'){
   const b=Buffer.from([0xff,0xd8,1,2,3,0xff,0xd9]);
   res.writeHead(200,{'content-type':'image/jpeg','content-length':b.length});res.end(b);return;
  }
  if(req.url==='/cookie-echo'){
   res.setHeader('content-type','application/json');
   res.end(JSON.stringify({label,cookie:req.headers.cookie,origin:req.headers.origin}));return;
  }
  res.writeHead(200,{'content-type':'text/html; charset=utf-8',
    'content-security-policy':"default-src 'self'; connect-src 'self' wss://old.trycloudflare.com; frame-src 'self'",
    'x-test-upstream':label});
  res.end('<h1>'+label+'</h1><form method="POST" action="/login"><iframe src="/view/"></iframe><a href="/shot.jpg"></a><script>fetch(\'/api/tabs\');let w=new URL(\'/input-ws\',window.location.origin);</script>');
 });
 server.on('upgrade',(req,socket)=>{
  if(req.url!=='/input-ws'||req.headers.origin!=='https://'+label+'.trycloudflare.com')
   return socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n');
  socket.write('WS_'+label);setTimeout(()=>socket.end(),30);
 });
 server.listen(0,'127.0.0.1',()=>resolve(server));
});
function bound(s){return s.address().port}
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'cfm-stable-tests-'));
const state=path.join(temp,'state'),routes=path.join(temp,'routes');
fs.mkdirSync(state);fs.mkdirSync(routes);
let a,b,br,brokerPort,tokenA,tokenB;const env={...process.env,CFM_STATE_DIR:state,CFM_BROKER_ROUTES:routes,CFM_PUBLIC_ORIGIN:ORIGIN};
function put(name,port){
 const val={name,mode:'web',port,pid:process.pid,startupKey:crypto.randomBytes(12).toString('hex'),
  url:'https://'+name+'.trycloudflare.com',expiresAt:Date.now()+300000};
 fs.writeFileSync(path.join(state,name+'.json'),JSON.stringify(val),{mode:0o600});return val;
}
function change(name,fun){
 const f=path.join(state,name+'.json');const st=JSON.parse(fs.readFileSync(f));
 fun(st);fs.writeFileSync(f,JSON.stringify(st));
}
function register(name){
 const r=execFileSync(process.execPath,[path.join(import.meta.dirname,'broker.mjs'),'register',name],{env,encoding:'utf8'});
 return JSON.parse(r).route_token;
}
async function setup(){
 a=await mkServer('a');b=await mkServer('b');put('a',bound(a));put('b',bound(b));
 tokenA=register('a');tokenB=register('b');
 assert.equal(tokenA.length,32);assert.notEqual(tokenA,tokenB);
 const tmp=net.createServer();await new Promise(resolve=>tmp.listen(0,'127.0.0.1',resolve));brokerPort=bound(tmp);await new Promise(resolve=>tmp.close(resolve));
 br=spawn(process.execPath,[path.join(import.meta.dirname,'broker.mjs'),'serve'],{env:{...env,CFM_BROKER_PORT:String(brokerPort)},stdio:['ignore','pipe','pipe']});
 await new Promise((resolve,reject)=>{
  let output='';
  const t=setTimeout(()=>reject(Error('broker startup timeout '+output)),3500);
  br.once('exit',code=>{clearTimeout(t);reject(Error('Broker exited '+code+' '+output))});
  br.stdout.on('data',c=>{output+=c;if(output.includes('CFM_STABLE_BROKER_READY')){clearTimeout(t);resolve()}});
  br.stderr.on('data',c=>{output+=c});
 });
}
function url(tok,p='/'){return 'http://127.0.0.1:'+brokerPort+'/m/'+tok+p}
const testOpts={concurrency:false};
test('preflight: start isolated routes',testOpts,async()=>{await setup();assert.ok(a&&b&&br&&brokerPort)});
test('parallel HTTP requests target distinct sessions',testOpts,async()=>{
 const [ra,rb]=await Promise.all([fetch(url(tokenA)),fetch(url(tokenB))]);
 assert.equal(ra.status,200);assert.equal(rb.status,200);
 const [pa,pb]=await Promise.all([ra.text(),rb.text()]);
 assert.match(pa,/<h1>a<\/h1>/);assert.match(pb,/<h1>b<\/h1>/);
 for(const [body,tok] of [[pa,tokenA],[pb,tokenB]]){
  assert.ok(body.includes('action="/m/'+tok+'/login"'));
  assert.ok(body.includes('src="/m/'+tok+'/view/"'));
  assert.ok(body.includes("fetch('/m/"+tok+"/api/tabs')"));
  assert.ok(body.includes("URL('/m/"+tok+"/input-ws'"));
 }
 assert.equal(ra.headers.get('x-test-upstream'),'a');assert.equal(rb.headers.get('x-test-upstream'),'b');
});
test('cookies and redirects scoped by session path',testOpts,async()=>{
 const [ra,rb]=await Promise.all([fetch(url(tokenA,'/login'),{method:'POST',body:'x',redirect:'manual'}),
  fetch(url(tokenB,'/login'),{method:'POST',body:'x',redirect:'manual'})]);
 assert.equal(ra.status,303);assert.equal(rb.status,303);
 assert.equal(ra.headers.get('location'),'/m/'+tokenA+'/');
 assert.equal(rb.headers.get('location'),'/m/'+tokenB+'/');
 assert.match(ra.headers.get('set-cookie'),new RegExp('Path=/m/'+tokenA+'/;'));
 assert.match(rb.headers.get('set-cookie'),new RegExp('Path=/m/'+tokenB+'/;'));
});
test('binary JPEG streamed independently',testOpts,async()=>{
 const [ra,rb]=await Promise.all([fetch(url(tokenA,'/shot.jpg')),fetch(url(tokenB,'/shot.jpg'))]);
 assert.equal(ra.headers.get('content-type'),'image/jpeg');
 assert.equal(rb.headers.get('content-type'),'image/jpeg');
 assert.deepEqual(Buffer.from(await ra.arrayBuffer()),Buffer.from([0xff,0xd8,1,2,3,0xff,0xd9]));
 assert.deepEqual(Buffer.from(await rb.arrayBuffer()),Buffer.from([0xff,0xd8,1,2,3,0xff,0xd9]));
});
test('CSP allowed WSS origin is stable worker host',testOpts,async()=>{
 const r=await fetch(url(tokenA));const csp=r.headers.get('content-security-policy');
 assert.match(csp,/wss:\/\/cf-mirror-bridge.mirkazem-design.workers.dev/);
 assert.doesNotMatch(csp,/old.trycloudflare.com/);
});
test('unknown token is blocked',testOpts,async()=>{
 const r=await fetch(url('a'.repeat(32)));assert.equal(r.status,410);
});
test('WS route isolation and Origin translation',testOpts,async()=>{
 const result=await new Promise((resolve,reject)=>{
  const s=net.connect({host:'127.0.0.1',port:brokerPort});let output='';
  const timer=setTimeout(()=>{s.destroy();reject(Error('ws handshake timeout '+output))},1500);
  s.on('connect',()=>{
   s.write('GET /m/'+tokenB+'/input-ws HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nOrigin: '+ORIGIN+'\r\nSec-WebSocket-Key: '+crypto.randomBytes(16).toString('base64')+'\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Protocol: cfm-input, signed-token\r\n\r\n');
  });
  s.on('data',x=>{output+=x.toString();if(output.includes('WS_b')){clearTimeout(timer);s.destroy();resolve(output)}});
  s.on('error',reject);
 });
 assert.match(result,/101 Switching Protocols/);
 assert.match(result,/WS_b/);
});
test('expiry invalidates one route without affecting the other',testOpts,async()=>{
 change('a',s=>{s.expiresAt=Date.now()-10});
 assert.equal((await fetch(url(tokenA))).status,410);
 assert.equal((await fetch(url(tokenB))).status,200);
});
test('worker rejects missing private binding',testOpts,async()=>{
 const r=await worker.fetch(new Request(ORIGIN+'/m/'+tokenB+'/'),{PUBLIC_ORIGIN:ORIGIN});
 assert.equal(r.status,503);
});
test('worker forwards scoped URL using only the VPC binding',testOpts,async()=>{
 const binding={async fetch(endpoint,opts){
  assert.ok(endpoint.includes('/m/'+tokenB+'/'));
  return fetch(url(tokenB),opts);
 }};
 const r=await worker.fetch(new Request(ORIGIN+'/m/'+tokenB+'/'),{PUBLIC_ORIGIN:ORIGIN,MIRROR_VPC:binding});
 assert.equal(r.status,200);assert.match(await r.text(),/<h1>b<\/h1>/);
});
test('worker origin and root isolation',testOpts,async()=>{
 assert.equal((await worker.fetch(new Request('https://evil.example/m/'+tokenB+'/'),{})).status,421);
 assert.equal((await worker.fetch(new Request(ORIGIN+'/'),{})).status,404);
 assert.equal((await worker.fetch(new Request(ORIGIN+'/__bridge-health'),{})).status,200);
});
test('clean shutdown',testOpts,async()=>{
 br.kill('SIGTERM');await Promise.all([new Promise(r=>a.close(r)),new Promise(r=>b.close(r))]);
 fs.rmSync(temp,{recursive:true,force:true});
});
