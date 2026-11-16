#!/usr/bin/env node
// Private, loopback-only multi-session gateway for CF Universal Mirror.
// This does NOT expose unprotected local mirrors. Each route resolves to one
// live, password-protected "web" mirror and remains bound to its exact PID/key.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';

const PORT=Number(process.env.CFM_BROKER_PORT||6266);
const PUBLIC=process.env.CFM_PUBLIC_ORIGIN||'https://cf-mirror-bridge.mirkazem-design.workers.dev';
const STATE=process.env.CFM_STATE_DIR||path.join(os.homedir(),'.cache/cf-mirror-universal');
const ROUTES=process.env.CFM_BROKER_ROUTES||path.join(STATE,'stable-routes');
const MAX_ROUTES=Math.min(12,Math.max(1,Number(process.env.CFM_MAX_ROUTES||4)||4));
const RE_TOKEN=/^[a-zA-Z0-9_-]{32}$/;
const ROUTE_PATH=/^\/m\/([a-zA-Z0-9_-]{32})(\/.*)?$/;
const PUBLIC_WS=PUBLIC.replace(/^https:/,'wss:');
const HOP=new Set(['connection','keep-alive','transfer-encoding','upgrade','proxy-connection','te','trailer']);
fs.mkdirSync(ROUTES,{recursive:true,mode:0o700});
function die(s){throw Error(s)}
function validOrigin(s){const u=new URL(s);if(u.origin!==s||u.protocol!=='https:'||u.pathname!=='/'||u.username||u.password)die('Invalid public origin');return s}
validOrigin(PUBLIC);
function alive(pid){try{process.kill(pid,0);return true}catch{return false}}
function data(name){
 if(!/^[a-zA-Z0-9_-]{1,45}$/.test(name))return null;
 try{return JSON.parse(fs.readFileSync(path.join(STATE,name+'.json'),'utf8'))}catch{return null}
}
function routeFile(token){return path.join(ROUTES,token+'.json')}
function current(token){
 if(!RE_TOKEN.test(token))return null;
 let entry;
 try{entry=JSON.parse(fs.readFileSync(routeFile(token),'utf8'))}catch{return null}
 const st=data(entry.name);
 if(!st||st.mode!=='web'||st.pid!==entry.pid||st.startupKey!==entry.startupKey||
   !Number.isSafeInteger(st.port)||st.port<1024||st.port>65535||!alive(st.pid)||
   !st.expiresAt||Date.now()>=st.expiresAt)return null;
 let u;
 try{u=new URL(st.url)}catch{return null}
 if(u.protocol!=='https:'||!u.hostname||u.username||u.password)return null;
 return {st,origin:u.origin};
}
function existing(){
 let a=0;
 for(const fn of fs.readdirSync(ROUTES)){
  if(!/^[a-zA-Z0-9_-]{32}\.json$/.test(fn))continue;
  const tok=fn.slice(0,-5);
  if(current(tok))a++;
  else try{fs.unlinkSync(routeFile(tok))}catch{}
 }
 return a;
}
function register(name){
 const st=data(name);
 if(!st||st.mode!=='web'||!Number.isInteger(st.port)||!st.expiresAt||Date.now()>=st.expiresAt||!alive(st.pid))
  die('Web mirror not active; only password-protected web sessions can be registered');
 if(existing()>=MAX_ROUTES)die('Maximum live stable mirror routes reached');
 const token=crypto.randomBytes(24).toString('base64url');
 const route={name:st.name,pid:st.pid,startupKey:st.startupKey};
 fs.writeFileSync(routeFile(token),JSON.stringify(route),{flag:'wx',mode:0o600});
 console.log(JSON.stringify({ok:true,name:st.name,stable_url:PUBLIC+'/m/'+token+'/',expires_at:new Date(st.expiresAt).toISOString(),route_token:token}));
}
const ROUTES_TO_REWRITE=[
  'api/','view/','view','login','shot.jpg','stream.mjpg','info','input-ws','mic-ws',
  'fit','type','key','move','down','up','dbl','wheel','move-rel',
  'press-rel','release-rel','click-rel','double-rel','scroll-rel',
  'drag','size','press','release','click','double','scroll','keydown','keyup'
].sort((a,b)=>b.length-a.length);
const pathRE=new RegExp('([\\x22\\x27=])/('+ROUTES_TO_REWRITE
 .filter(x=>x.endsWith('/')).join('|')+'|(?:'+
 ROUTES_TO_REWRITE.filter(x=>!x.endsWith('/')).join('|')+
 ')(?=[/?\\x22\\x27#]|$))','g');
function scopeHTML(html,prefix){
 return html.replace(pathRE,(_,q,p)=>q+prefix+'/'+p);
}
function fail(res,status,message){
 if(res.headersSent){res.destroy();return}
 res.writeHead(status,{'content-type':'text/plain; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'});
 res.end(message);
}
function requestInfo(url){
 let u;
 try{u=new URL(url,'http://127.0.0.1')}catch{return null}
 const match=u.pathname.match(ROUTE_PATH);
 if(!match)return null;
 const token=match[1],route=current(token);
 if(!route)return {expired:true};
 const suffix=(match[2]||'/')+u.search;
 return {token,route,suffix,prefix:'/m/'+token};
}
function headersFor(req,upstreamOrigin){
 const h={};
 const permitted=new Set(['accept','accept-language','content-type','cookie','user-agent','range',
  'if-modified-since','if-none-match','cache-control','x-cf-mirror-csrf',
  'sec-fetch-site','sec-fetch-mode','sec-fetch-dest','referer','cf-connecting-ip']);
 for(const [k,v] of Object.entries(req.headers)){
  if(permitted.has(k)&&typeof v==='string')h[k]=v;
 }
 if(req.headers.origin===PUBLIC)h.origin=upstreamOrigin;
 else if(req.headers.origin)h.origin=req.headers.origin; // fail closed in upstream control/CSRF checks
 delete h['accept-encoding']; // avoid gzipped HTML so path scoping stays reliable
 return h;
}
function responseHeaders(up,prefix,origin){
 const hdr={};
 for(const [key,value] of Object.entries(up.headers)){
  if(HOP.has(key)||key==='content-length'||key==='content-encoding')continue;
  if(key==='set-cookie'){
   const a=Array.isArray(value)?value:[value];
   const valid=a.filter(v=>/^cfm_auth=[a-zA-Z0-9_-]+;/i.test(v||''));
   if(valid.length)hdr['set-cookie']=valid.map(v=>v.replace(/;\s*Path=\/\s*(?=;|$)/i,'; Path='+prefix+'/'));
   continue;
  }
  if(key==='location'&&typeof value==='string'){
   hdr.location=value.startsWith('/')&&!value.startsWith('//')?prefix+value:value;
   continue;
  }
  if(key==='content-security-policy'){
   hdr[key]=String(value).replace(/connect-src\s+[^;]*/i,"connect-src 'self' "+PUBLIC_WS);
   continue;
  }
  hdr[key]=value;
 }
 hdr['cache-control']='no-store, private, max-age=0';
 hdr['referrer-policy']='no-referrer';
 hdr['x-content-type-options']='nosniff';
 return hdr;
}
function handler(req,res){
 if(req.url==='/__stable-health'){
  return fail(res,200,'CFM_STABLE_GATEWAY_READY_v1');
 }
 if(req.url==='/')return fail(res,404,'Private mirror: open the exact per-session URL');
 const info=requestInfo(req.url);
 if(!info)return fail(res,404,'Unknown route');
 if(info.expired)return fail(res,410,'Mirror unavailable or expired');
 const {route,token,suffix,prefix}=info;
 if(!['GET','HEAD','POST'].includes(req.method))return fail(res,405,'Method not allowed');
 const h=headersFor(req,route.origin);
 const upstream=http.request({hostname:'127.0.0.1',port:route.st.port,path:suffix,method:req.method,headers:h,timeout:15000},up=>{
  if(res.destroyed){up.destroy();return}
  const responseH=responseHeaders(up,prefix,route.origin);
  if(/text\/html/i.test(up.headers['content-type']||'')&&req.method!=='HEAD'){
   const chunks=[];let size=0;
   up.on('data',chunk=>{size+=chunk.length;if(size>750000){up.destroy();return fail(res,502,'Unexpected HTML size')}chunks.push(chunk)});
   up.on('end',()=>{if(res.destroyed||res.writableEnded)return;const html=scopeHTML(Buffer.concat(chunks).toString('utf8'),prefix);res.writeHead(up.statusCode||502,{...responseH,'content-length':Buffer.byteLength(html)});res.end(html)});
   return;
  }
  if(up.headers['content-length'])responseH['content-length']=up.headers['content-length'];
  if(up.headers['content-encoding'])responseH['content-encoding']=up.headers['content-encoding'];
  res.writeHead(up.statusCode||502,responseH);
  up.pipe(res);
 });
 upstream.on('timeout',()=>upstream.destroy(Error('timeout')));
 upstream.on('error',()=>{if(!res.writableEnded)fail(res,502,'Mirror backend unavailable')});
 req.on('aborted',()=>upstream.destroy());
 res.on('close',()=>upstream.destroy());
 req.pipe(upstream);
}
function upgrade(req,socket,head){
 const info=requestInfo(req.url);
 if(!info||info.expired||!['/input-ws','/mic-ws'].includes(info.suffix)||
  req.headers.origin!==PUBLIC){
  socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');return;
 }
 const {route,suffix}=info;
 const key=String(req.headers['sec-websocket-key']||'');
 const proto=String(req.headers['sec-websocket-protocol']||'');
 if(!/^[A-Za-z0-9+/]{22}==$/.test(key)||req.headers['sec-websocket-version']!=='13'||
   !proto.includes(suffix==='/mic-ws'?'cfm-mic':'cfm-input')){
  socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');return;
 }
 const upstream=net.connect({host:'127.0.0.1',port:route.st.port});
 upstream.once('connect',()=>{
  if(socket.destroyed){upstream.destroy();return;}
  const lines=['GET '+suffix+' HTTP/1.1','Host: 127.0.0.1:'+route.st.port,'Connection: Upgrade','Upgrade: websocket',
    'Origin: '+route.origin,'Sec-WebSocket-Key: '+key,'Sec-WebSocket-Version: 13','Sec-WebSocket-Protocol: '+proto];
  const cookies=String(req.headers.cookie||'').match(/(?:^|;\s*)cfm_auth=[A-Za-z0-9_-]+/);
  if(cookies)lines.push('Cookie: '+cookies[0].trim());
  upstream.write(lines.join('\r\n')+'\r\n\r\n');
  if(head?.length)upstream.write(head);
  socket.pipe(upstream);upstream.pipe(socket);
 });
 upstream.on('error',()=>socket.destroy());
 socket.on('error',()=>upstream.destroy());
 socket.on('close',()=>upstream.destroy());
}
const cli=process.argv[2]||'serve';
if(cli==='register'){register(process.argv[3]);}
else if(cli==='prune'){console.log(JSON.stringify({ok:true,active:existing()}));}
else if(cli==='serve'){
 if(!Number.isInteger(PORT)||PORT<1024||PORT>65535)die('Invalid port');
 const server=http.createServer(handler);
 server.on('upgrade',upgrade);
 server.listen(PORT,'127.0.0.1',()=>console.log('CFM_STABLE_BROKER_READY 127.0.0.1:'+PORT));
}else die('Usage: broker.mjs serve|register NAME|prune');
