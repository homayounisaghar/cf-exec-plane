#!/usr/bin/env node
// CF universal mirror controller, using the existing cf-mirror CDP/X11 engine.
// Bound to loopback. Web sessions are accessible only through a per-session HTTPS
// Cloudflare Quick Tunnel + authenticated, expiring gateway. No domain allowlist.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';

const HOME=os.homedir(), ROOT=path.join(HOME,'.local/share/cf-mirror-universal');
const STATE=path.join(HOME,'.cache/cf-mirror-universal');
const ENGINE=path.join(ROOT,'runtime.mjs'), VIEW=path.join(ROOT,'viewer.html');
const TUNNEL=process.env.CF_MIRROR_CLOUDFLARED || path.join(HOME,'pocket-farsi-stream-mvp/cloudflared');
fs.mkdirSync(STATE,{recursive:true,mode:0o700});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const json=x=>JSON.stringify(x);
const out=x=>console.log(json(x));
const fail=(message,extra={})=>{out({ok:false,error:String(message),...extra});process.exitCode=1;};
const goodName=n=>/^[a-zA-Z0-9_-]{1,45}$/.test(n||'');
const statePath=n=>path.join(STATE,n+'.json');
const readState=n=>{try{return JSON.parse(fs.readFileSync(statePath(n),'utf8'));}catch{return null;}};
const alive=pid=>{try{process.kill(pid,0);return true;}catch{return false;}};
const baseHeaders={
 'cache-control':'no-store, no-cache, must-revalidate',
 'referrer-policy':'no-referrer',
 'x-content-type-options':'nosniff',
 'x-frame-options':'SAMEORIGIN',
 'content-security-policy':"default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; frame-src 'self'; connect-src 'self'; form-action 'self'; frame-ancestors 'self'",
 'permissions-policy':'camera=(), microphone=(), geolocation=()'
};
const reply=(res,status,body,type='application/json; charset=utf-8',extra={})=>{
 if(res.headersSent)return;
 res.writeHead(status,{...baseHeaders,'content-type':type,...extra});
 res.end(typeof body==='string'||Buffer.isBuffer(body)?body:json(body));
};
const text=(s,max=400)=>String(s||'').slice(0,max);
const clamp=(v,lo,hi)=>Math.max(lo,Math.min(hi,v));
const positivePort=p=>{const n=Number(p);if(!Number.isInteger(n)||n<1||n>65535)throw Error('Invalid TCP port');return n;};
async function getJson(url,timeout=1400,opt={}){
 const ac=new AbortController(), t=setTimeout(()=>ac.abort(),timeout);
 try{const r=await fetch(url,{signal:ac.signal,...opt});if(!r.ok)throw Error('HTTP '+r.status);return await r.json();}finally{clearTimeout(t);}
}
async function healthy(p){
 try{const r=await fetch('http://127.0.0.1:'+p+'/health',{signal:AbortSignal.timeout(700)});return r.ok;}catch{return false;}
}
async function freePort(start,excluded=[]){
 for(let i=start;i<start+200;i++){
  if(excluded.includes(i))continue;
  if(await new Promise(resolve=>{
    const s=http.createServer();
    s.once('error',()=>resolve(false));
    s.listen(i,'127.0.0.1',()=>s.close(()=>resolve(true)));
  }))return i;
 }
 throw Error('No available loopback port');
}
function xauth(display){
 const known={':10':path.join(HOME,'.Xauthority'),':97':'/var/lib/capability-fabric/pcg/wechat/Xauthority'};
 let file=known[display];
 if(!file){
  try{
   const lines=execFileSync('ps',['-ww','-eo','args'],{encoding:'utf8',timeout:1400}).split('\n');
   const line=lines.find(s=>/\b(?:Xvfb|Xorg|Xwayland)\b/.test(s)&&s.split(/\s+/).includes(display));
   file=line?.match(/(?:^|\s)-auth\s+(\S+)/)?.[1];
  }catch{}
 }
 return file&&fs.existsSync(file)?file:null;
}
function displayEnv(d){
 const e={...process.env,DISPLAY:d}, a=xauth(d);
 if(a)e.XAUTHORITY=a;else delete e.XAUTHORITY;
 return e;
}
async function discover(){
 let ports=[];
 try{
  const ls=execFileSync('ss',['-ltnp'],{encoding:'utf8',timeout:2000});
  for(const line of ls.split('\n')){
   const m=line.match(/127\.0\.0\.1:(\d+)\s/);
   if(m&&/"(?:chrome|chromium)"/.test(line))ports.push(Number(m[1]));
  }
 }catch{}
 const browsers=(await Promise.all([...new Set(ports)].map(async port=>{
  try{
   const version=await getJson('http://127.0.0.1:'+port+'/json/version',850);
   if(!version.webSocketDebuggerUrl)return null;
   const pages=(await getJson('http://127.0.0.1:'+port+'/json/list',850))
    .filter(t=>t.type==='page'&&!String(t.url).startsWith('devtools://'))
    .map(t=>({id:t.id,url:t.url,title:t.title,openerId:t.openerId||null}));
   return {port,pages};
  }catch{return null;}
 }))).filter(Boolean).sort((a,b)=>a.port-b.port);
 const displays=[];
 try{
  for(const f of fs.readdirSync('/tmp/.X11-unix')){
   if(!/^X\d+$/.test(f))continue;
   const display=':'+f.slice(1);
   try{
    const env=displayEnv(display);
    const info=execFileSync('xdpyinfo',['-display',display],{env,encoding:'utf8',timeout:2000,stdio:['ignore','pipe','ignore']});
    const size=info.match(/dimensions:\s+(\d+x\d+)/)?.[1]||'?';
    let titles=[];
    try{
     const wins=execFileSync('xdotool',['search','--onlyvisible','--name','.'],{env,encoding:'utf8',timeout:1200}).split('\n').filter(Boolean).slice(0,60);
     for(const id of wins){
      try{const t=execFileSync('xdotool',['getwindowname',id],{env,encoding:'utf8',timeout:500}).trim();if(t&&t.length>2&&!titles.includes(t))titles.push(t.slice(0,100));}catch{}
     }
    }catch{}
    displays.push({display,size,windows:titles.slice(0,20)});
   }catch{displays.push({display,accessible:false});}
  }
 }catch{}
 return {browsers,displays};
}
function parseArgs(a){
 const o={_:[]};
 const booleans=new Set(['full','no-fit','view-only','help']);
 for(let i=0;i<a.length;i++){
  if(a[i].startsWith('--')){
   const k=a[i].slice(2);if(booleans.has(k))o[k]=true;
   else {if(i+1>=a.length)throw Error('Missing value for --'+k);o[k]=a[++i];}
  }else o._.push(a[i]);
 }
 return o;
}
function ttlSecs(v){
 if(v===undefined)return 300;
 const s=String(v).trim(),m=s.match(/^(\d+)(s|m|h)?$/i);
 if(!m)throw Error('TTL must be seconds, 5m, 1h etc.');
 const n=Number(m[1])*({s:1,m:60,h:3600}[m[2]?.toLowerCase()||'s']);
 if(n<30||n>86400)throw Error('Web TTL must be 30s..24h');
 return n;
}
function intervalSec(v){
 if(!v||v==='auto')return 'auto';
 const n=Number(v);
 if(!Number.isFinite(n)||n<0.05||n>5)throw Error('--interval must be auto or 0.05..5 seconds');
 return String(n);
}
async function resolveSource(o,found){
 const app=text(o.app,140).toLowerCase();
 let port=null,display=null,selectedId=null;
 if(o.cdp){port=positivePort(o.cdp);}
 else if(o.x11){display=String(o.x11);if(!/^:\d+$/.test(display))throw Error('Invalid X11 DISPLAY');}
 else{
  const matches=found.browsers.filter(b=>app==='browser'||!app||b.pages.some(p=>(p.title+' '+p.url).toLowerCase().includes(app)));
  if(matches.length===1){
   port=matches[0].port;
   if(app&&app!=='browser')selectedId=matches[0].pages.find(p=>(p.title+' '+p.url).toLowerCase().includes(app))?.id||null;
  }else if(matches.length>1)throw Error('Ambiguous app/browser. Specify --cdp PORT. Candidates: '+matches.map(b=>b.port+' '+b.pages.map(p=>p.url.slice(0,55)).join(', ')).join(' | '));
  else if(app&&app!=='browser'){
   const dx=found.displays.filter(d=>d.accessible!==false&&d.windows.some(w=>w.toLowerCase().includes(app)));
   if(dx.length===1)display=dx[0].display;
   else throw Error('No unique matching browser or X11 app. Use list and --cdp PORT / --x11 :N');
  }else throw Error('No unique browser. Run list and select --cdp PORT or --x11 :N');
 }
 if(display){
  if(o.tab)throw Error('--tab is only for CDP browsers');
  const d=found.displays.find(d=>d.display===display);
  if(!d||d.accessible===false)throw Error('X11 display not accessible: '+display);
  return {kind:'x11',display,full:!!o.full};
 }
 const pages=(await getJson('http://127.0.0.1:'+port+'/json/list')).filter(t=>t.type==='page'&&!String(t.url).startsWith('devtools://'));
 if(!pages.length)throw Error('CDP browser has no page targets');
 if(o.tab){
  const needle=String(o.tab).toLowerCase();
  const exact=pages.find(t=>t.id.toLowerCase()===needle);
  const matches=exact?[exact]:pages.filter(t=>(t.title+' '+t.url).toLowerCase().includes(needle));
  if(matches.length!==1)throw Error('Tab selector must match exactly one page (matches='+matches.length+')');
  selectedId=matches[0].id;
 }
 if(!selectedId)selectedId=pages[0].id;
 return {kind:'cdp',port,selectedId,tabOnly:!!o.tab,noFit:!!o['no-fit']};
}
function writeState(st){
 const f=statePath(st.name), temp=f+'.'+process.pid+'.tmp';
 fs.writeFileSync(temp,json(st),{mode:0o600});
 fs.renameSync(temp,f);
}
async function startCLI(o){
 const name=o._[1]||('mirror-'+Date.now().toString(36));
 if(!goodName(name))throw Error('Mirror name must be 1..45 letters, digits, - or _');
 const old=readState(name);
 if(old&&alive(old.pid))throw Error('Mirror name already running. Use status or stop '+name);
 const found=await discover(),source=await resolveSource(o,found);
 const mode=o.mode||'local';
 if(!['local','web'].includes(mode))throw Error('--mode must be local or web');
 const expiresAt=mode==='web'?Date.now()+ttlSecs(o.ttl)*1000:(o.ttl?Date.now()+ttlSecs(o.ttl)*1000:null);
 const port=o.port?positivePort(o.port):await freePort(6200);
 const backendPort=await freePort(6400,[port]);
 const password=mode==='web'?String(o.password||crypto.randomBytes(18).toString('base64url')):null;
 if(mode==='web'&&password.length<8)throw Error('Web password must contain at least 8 characters');
 if(mode==='local'&&o.password)throw Error('Local mode is simple and passwordless; use --mode web for password access');
 const config={name,source,mode,expiresAt,port,backendPort,password,interval:intervalSec(o.interval),full:!!o.full,startupKey:crypto.randomBytes(12).toString('hex')};
 const logPath=path.join(STATE,name+'.log');
 const log=fs.openSync(logPath,'a',0o600);
 const child=spawn(process.execPath,[process.argv[1],'serve'],{detached:true,stdio:['pipe',log,log]});
 fs.closeSync(log);child.unref();child.stdin.end(json(config));
 let foundState=null;
 for(let i=0;i<200;i++){
  await sleep(200);
  const s=readState(name);
  if(s&&s.startupKey===config.startupKey){foundState=s;if(s.ready||s.error)break;}
  if(!alive(child.pid))break;
 }
 if(!foundState||!foundState.ready){
  try{process.kill(child.pid,'SIGTERM');}catch{}
  throw Error('Mirror startup failed: '+(foundState?.error||'see '+logPath));
 }
 const safe={ok:true,name,mode,source:foundState.source,url:foundState.url,local_url:'http://127.0.0.1:'+port+'/',expires_at:expiresAt?new Date(expiresAt).toISOString():null,interval:config.interval};
 if(mode==='web'){safe.password=password;safe.note='Password is shown once and is required to access the public URL.';}
 out(safe);
}
function statusCLI(){
 const a=[];
 for(const f of fs.readdirSync(STATE)){
  if(!f.endsWith('.json'))continue;
  const st=readState(f.slice(0,-5));
  if(!st)continue;
  a.push({name:st.name,mode:st.mode,active:alive(st.pid)&&(!st.expiresAt||Date.now()<st.expiresAt),url:st.url,source:st.source,expires_at:st.expiresAt?new Date(st.expiresAt).toISOString():null});
 }
 out({ok:true,sessions:a});
}
async function stopCLI(o){
 const name=o._[1];if(!name)throw Error('Specify mirror name or all');
 const a=name==='all'?fs.readdirSync(STATE).filter(s=>s.endsWith('.json')).map(s=>s.slice(0,-5)):[name];
 let stopped=0;
 for(const n of a){
  const s=readState(n);if(!s)continue;
  if(alive(s.pid)){try{process.kill(s.pid,'SIGTERM');stopped++;}catch{}}
  else{try{fs.unlinkSync(statePath(n));}catch{}}
 }
 out({ok:true,stopped});
}
async function screenshotCLI(o){
 const n=o._[1],s=readState(n);
 if(!s||!alive(s.pid))throw Error('Mirror not running');
 const dest=o.out||path.join(STATE,n+'-shot.jpg');
 const r=await fetch('http://127.0.0.1:'+s.backendPort+'/shot.jpg',{signal:AbortSignal.timeout(10000)});
 if(!r.ok)throw Error('Screenshot backend HTTP '+r.status);
 fs.writeFileSync(dest,Buffer.from(await r.arrayBuffer()),{mode:0o600});
 out({ok:true,path:dest,bytes:fs.statSync(dest).size});
}
function htmlEscape(x){
 return String(x).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}
function loginPage(){
 return '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Secure mirror access</title><style>body{font:16px system-ui;background:#151923;color:#eee;display:grid;place-items:center;min-height:100vh;margin:0}form{background:#262d3c;padding:25px;border-radius:16px;width:min(340px,85vw)}input,button{box-sizing:border-box;width:100%;padding:14px;margin-top:12px;border-radius:8px;font:inherit}button{background:#6c8cff;border:0;cursor:pointer}</style><form method="POST" action="/login"><h2>Private live mirror</h2><p>Enter the session password to continue.</p><input type="password" name="password" required autofocus autocomplete="off" placeholder="Session password"><button>Unlock mirror</button><small>Access ends automatically when the session expires.</small></form></html>';
}
async function bodyString(req,limit=65536){
 let s='';
 for await(const c of req){s+=c.toString('utf8');if(s.length>limit)throw Error('Request exceeds size limit');}
 return s;
}
function uniqueTabs(a){
 return a.filter(t=>t.type==='page'&&!String(t.url).startsWith('devtools://'));
}
async function serve(config){
 const c=config,sockets=new Set();
 let done=false,webUrl=null,backend=null,tunnel=null,server=null,selectedId=c.source.selectedId||null,changing=Promise.resolve();
 const salt=crypto.randomBytes(16),pwHash=c.mode==='web'?crypto.scryptSync(c.password,salt,32):null;
 c.password=undefined;
 const sessions=new Map(),bad=new Map();
 const gateOrigin=()=>{
  if(c.mode==='web')return webUrl;
  return 'http://127.0.0.1:'+c.port;
 };
 const isExpired=()=>c.expiresAt&&Date.now()>=c.expiresAt;
 const state=(extra={})=>({name:c.name,pid:process.pid,backendPort:c.backendPort,port:c.port,mode:c.mode,source:c.source,selectedId,url:c.mode==='web'?webUrl:'http://127.0.0.1:'+c.port+'/',expiresAt:c.expiresAt,startupKey:c.startupKey,...extra});
 const internal='http://127.0.0.1:'+c.backendPort;
 async function stopBackend(){
  if(!backend)return;
  const p=backend;backend=null;
  if(alive(p.pid)){
   try{p.kill('SIGTERM');}catch{}
   for(let i=0;i<35&&alive(p.pid);i++)await sleep(60);
   if(alive(p.pid))try{p.kill('SIGKILL');}catch{}
  }
 }
 async function startBackend(){
  const args=[ENGINE,'serve',c.name,'--port',String(c.backendPort),'--interval',c.interval];
  if(c.source.kind==='x11'){
   args.push('--x11',c.source.display);
   if(c.source.full)args.push('--full');
  }else{
   args.push('--cdp',String(c.source.port),'--target-id',selectedId);
   if(c.source.noFit)args.push('--no-fit');
  }
  const log=fs.openSync(path.join(STATE,c.name+'.backend.log'),'a',0o600);
  backend=spawn(process.execPath,args,{stdio:['ignore',log,log]});
  fs.closeSync(log);
  for(let i=0;i<65;i++){
   if(await healthy(c.backendPort))return;
   if(backend.exitCode!==null)break;
   await sleep(120);
  }
  throw Error('CDP/X11 mirror backend did not become healthy');
 }
 async function cleanup(){
  if(done)return;done=true;
  if(tunnel){try{process.kill(-tunnel.pid,'SIGTERM');}catch{try{tunnel.kill('SIGTERM');}catch{}}tunnel=null;}
  if(server)server.close();
  for(const s of sockets)try{s.destroy();}catch{}
  await stopBackend();
  try{const x=readState(c.name);if(x&&x.pid===process.pid)fs.unlinkSync(statePath(c.name));}catch{}
  setTimeout(()=>process.exit(0),100).unref();
 }
 process.once('SIGTERM',()=>{cleanup().catch(()=>process.exit(1));});
 process.once('SIGINT',()=>{cleanup().catch(()=>process.exit(1));});
 process.once('uncaughtException',e=>{console.error('fatal',e.message);cleanup().catch(()=>process.exit(1));});
 async function tabs(){
  if(c.source.kind!=='cdp')throw Error('Tab manager requires a CDP browser');
  return uniqueTabs(await getJson('http://127.0.0.1:'+c.source.port+'/json/list',2400));
 }
 async function select(id){
  const pages=await tabs();
  if(!pages.some(t=>t.id===id))throw Error('Target tab does not exist');
  if(selectedId===id)return;
  changing=changing.then(async()=>{
   await stopBackend();
   selectedId=id;
   await startBackend();
   writeState(state({ready:true}));
  });
  await changing;
 }
 async function createTab(){
  const obj=await getJson('http://127.0.0.1:'+c.source.port+'/json/new?about:blank',3000,{method:'PUT'});
  if(!obj.id)throw Error('Browser did not create a tab');
  await select(obj.id);
  return obj.id;
 }
 async function closeTab(id){
  const pages=await tabs();
  if(!pages.some(p=>p.id===id))throw Error('Tab does not exist');
  if(pages.length===1)await createTab();
  if(id===selectedId){
   const next=(await tabs()).find(p=>p.id!==id);
   if(next)await select(next.id);
  }
  await fetch('http://127.0.0.1:'+c.source.port+'/json/close/'+encodeURIComponent(id),{signal:AbortSignal.timeout(3000)});
 }
 async function cdpCommand(id,method,params={}){
  const targets=await getJson('http://127.0.0.1:'+c.source.port+'/json/list');
  const t=targets.find(x=>x.id===id);
  if(!t?.webSocketDebuggerUrl)throw Error('Browser target does not exist');
  const ws=new WebSocket(t.webSocketDebuggerUrl);
  return await new Promise((resolve,reject)=>{
   const timeout=setTimeout(()=>{ws.close();reject(Error('CDP command timed out'));},6500);
   ws.onopen=()=>ws.send(json({id:1,method,params}));
   ws.onerror=()=>{clearTimeout(timeout);reject(Error('Browser connection failed'));};
   ws.onmessage=ev=>{
    try{
     const m=JSON.parse(ev.data);
     if(m.id===1){clearTimeout(timeout);ws.close();m.error?reject(Error(m.error.message)):resolve(m.result);}
    }catch(e){clearTimeout(timeout);reject(e);}
   };
  });
 }
 async function navigate(id,url){
  if(typeof url!=='string'||!url.trim()||url.length>2048)throw Error('Invalid URL');
  let u=url.trim();
  if(!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(u))u='https://'+u;
  // Unrestricted browser navigation, including Google and third-party SSO.
  await cdpCommand(id,'Page.navigate',{url:u});
 }
 async function goBack(id){
  const h=await cdpCommand(id,'Page.getNavigationHistory');
  if(h.currentIndex>0)await cdpCommand(id,'Page.navigateToHistoryEntry',{entryId:h.entries[h.currentIndex-1].id});
  return {canGoBack:h.currentIndex>0};
 }

 function authCookie(req){
  const m=String(req.headers.cookie||'').match(/(?:^|;\s*)cfm_auth=([A-Za-z0-9_-]{24,100})(?:;|$)/);
  if(!m)return false;
  const exp=sessions.get(m[1]);return !!exp&&exp>Date.now()&&!isExpired();
 }
 const originOK=req=>req.headers.origin===gateOrigin();
 function proxy(req,res,url){
  const headers={};
  if(req.headers['content-type'])headers['content-type']=req.headers['content-type'];
  const p=http.request({host:'127.0.0.1',port:c.backendPort,path:url,method:req.method,headers},up=>{
   res.writeHead(up.statusCode||502,{...baseHeaders,...up.headers,'cache-control':'no-store'});
   up.pipe(res);
  });
  p.on('error',e=>reply(res,502,{ok:false,error:'Mirror backend unavailable'}));
  req.pipe(p);
 }
 async function handler(req,res){
  try{
   if(isExpired()){reply(res,410,'Mirror session expired','text/plain');await cleanup();return;}
   const u=new URL(req.url,'http://127.0.0.1:'+c.port), pathname=u.pathname;
   if(c.mode==='web'&&!authCookie(req)){
    if(req.method==='GET'&&(pathname==='/'||pathname==='/login'))return reply(res,200,loginPage(),'text/html; charset=utf-8');
    if(req.method==='POST'&&pathname==='/login'){
     if(!originOK(req))return reply(res,403,{ok:false,error:'Invalid origin'});
     const key=String(req.headers['cf-connecting-ip']||req.socket.remoteAddress||'unknown').slice(0,120);
     const x=bad.get(key)||{n:0,until:0};
     if(x.n>=8&&x.until>Date.now())return reply(res,429,'Too many login attempts; retry later','text/plain');
     const form=new URLSearchParams(await bodyString(req,4096));
     const pass=String(form.get('password')||'');
     const ph=crypto.scryptSync(pass,salt,32);
     if(!crypto.timingSafeEqual(ph,pwHash)){
      const n=x.until>Date.now()?x.n+1:1;bad.set(key,{n,until:Date.now()+600000});
      return reply(res,401,loginPage().replace('Enter the session password','Incorrect password. Try again'),'text/html; charset=utf-8');
     }
     bad.delete(key);
     const cookie=crypto.randomBytes(32).toString('base64url');
     sessions.set(cookie,c.expiresAt);
     res.writeHead(303,{...baseHeaders,location:'/', 'set-cookie':'cfm_auth='+cookie+'; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age='+Math.ceil((c.expiresAt-Date.now())/1000)});
     return res.end();
    }
    return reply(res,401,{ok:false,error:'Password required'});
   }
   if(req.method==='GET'&&(pathname==='/'||pathname==='/index.html')){
    const html=fs.readFileSync(VIEW,'utf8').replace('__BROWSER_MODE__',String(c.source.kind==='cdp'&&!c.source.tabOnly)).replace('__MIRROR_TITLE__',htmlEscape(c.name));
    return reply(res,200,html,'text/html; charset=utf-8');
   }
   if(req.method==='GET'&&pathname==='/api/tabs'){
    const a=(await tabs()).map(t=>({id:t.id,url:t.url,title:t.title,openerId:t.openerId||null}));
    return reply(res,200,{ok:true,tabs:a,selectedId});
   }
   if(req.method==='POST'&&pathname.startsWith('/api/')){
    if(!originOK(req))return reply(res,403,{ok:false,error:'Invalid origin'});
    if(c.source.kind!=='cdp'||c.source.tabOnly)return reply(res,400,{ok:false,error:'Tab controls unavailable for this mirror'});
    const b=JSON.parse(await bodyString(req,4096));
    if(pathname==='/api/select')await select(String(b.id||''));
    else if(pathname==='/api/new')await createTab();
    else if(pathname==='/api/close')await closeTab(String(b.id||''));
    else if(pathname==='/api/go')await navigate(selectedId,b.url);
    else if(pathname==='/api/back')await goBack(selectedId);
    else return reply(res,404,{ok:false,error:'Unknown action'});
    return reply(res,200,{ok:true,selectedId});
   }
   // No endpoint escapes the web session's authentication/expiry check.
   if(req.method==='POST'&&!originOK(req))return reply(res,403,{ok:false,error:'Invalid origin'});
   if(req.method==='GET'||req.method==='POST'){
    return proxy(req,res,pathname.startsWith('/view/')?pathname.slice(5)+u.search:pathname+u.search);
   }
   reply(res,405,{ok:false,error:'Method not allowed'});
  }catch(e){console.error('request failed:',e.message);reply(res,400,{ok:false,error:String(e.message||e)});}
 }
 try{
  await startBackend();
  server=http.createServer((req,res)=>handler(req,res));
  server.on('connection',sock=>{sockets.add(sock);sock.on('close',()=>sockets.delete(sock));});
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(c.port,'127.0.0.1',resolve);});
  if(c.mode==='web'){
   if(!fs.existsSync(TUNNEL))throw Error('cloudflared is not installed at '+TUNNEL);
   tunnel=spawn(TUNNEL,['tunnel','--no-autoupdate','--url','http://127.0.0.1:'+c.port,'--loglevel','info'],{detached:true,stdio:['ignore','pipe','pipe']});
   const m=/https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/;
   await new Promise((resolve,reject)=>{
    let finished=false,raw='';
    const timer=setTimeout(()=>{if(!finished){finished=true;reject(Error('Public tunnel did not return an HTTPS URL'));}},30000);
    const onData=d=>{
     raw=(raw+d.toString('utf8')).slice(-16000);
     const found=raw.match(m);
     if(found&&!finished){finished=true;clearTimeout(timer);webUrl=found[0];resolve();}
    };
    tunnel.stdout.on('data',onData);tunnel.stderr.on('data',onData);
    tunnel.once('error',e=>{if(!finished){finished=true;clearTimeout(timer);reject(e);}});
    tunnel.once('exit',(code)=>{if(!finished){finished=true;clearTimeout(timer);reject(Error('Cloudflared exited '+code));}});
   });
  }
  writeState(state({ready:true}));
  if(c.expiresAt)setTimeout(()=>{cleanup().catch(()=>process.exit(1));},Math.max(1,c.expiresAt-Date.now())).unref();
 }catch(e){
  try{writeState(state({error:String(e.message||e)}));}catch{}
  console.error('failed to start:',e.message);
  await cleanup();
  process.exitCode=1;
 }
}
function usage(){
 console.log('CF universal mirror - all browser CDP tabs and accessible X11 displays');
 console.log('  node cf-mirror-universal.mjs list');
 console.log('  node cf-mirror-universal.mjs start [NAME] --app telegram [--tab title]');
 console.log('  node cf-mirror-universal.mjs start [NAME] --cdp PORT [--tab id-or-title]');
 console.log('  node cf-mirror-universal.mjs start [NAME] --x11 :121 [--full]');
 console.log('  node cf-mirror-universal.mjs start [NAME] --cdp PORT --mode web --ttl 5m [--password VALUE]');
 console.log('  node cf-mirror-universal.mjs start [NAME] --cdp PORT --interval auto|0.1 [--no-fit]');
 console.log('  node cf-mirror-universal.mjs status | stop NAME|all | screenshot NAME [--out PATH]');
 console.log('Local: numeric http://127.0.0.1:PORT/; web: one-time password + expiring HTTPS URL.');
}
async function main(){
 const o=parseArgs(process.argv.slice(2)),cmd=o._[0];
 if(cmd==='serve'){
  const s=await new Promise((resolve,reject)=>{
   let a='';process.stdin.setEncoding('utf8');
   process.stdin.on('data',x=>{a+=x;if(a.length>100000)reject(Error('Configuration too large'));});
   process.stdin.on('end',()=>resolve(a));process.stdin.on('error',reject);
  });
  return serve(JSON.parse(s));
 }
 if(cmd==='list')return out({ok:true,...await discover()});
 if(cmd==='start')return await startCLI(o);
 if(cmd==='status')return statusCLI();
 if(cmd==='stop')return stopCLI(o);
 if(cmd==='screenshot')return await screenshotCLI(o);
 usage();
}
try{await main();}catch(e){fail(e.message||e);}
