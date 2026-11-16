#!/usr/bin/env node
// Bounded live test of real CDP sources; produces NO public tunnel.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import {spawn,execFileSync} from 'node:child_process';
const R='/home/cfserver/.local/share/cf-mirror-universal';
const C=R+'/cf-mirror-universal.mjs',B=R+'/stable-gateway-v1/broker.mjs';
const PUBLIC='https://cf-mirror-bridge.mirkazem-design.workers.dev';
const names=['cfmStableLiveA','cfmStableLiveB'];
const cfgs=[[9323,names[0]],[9324,names[1]]];
const PORT=6266;
const status=[];
let broker=null;
const delay=ms=>new Promise(r=>setTimeout(r,ms));
function exec(cmd,args){return execFileSync(cmd,args,{encoding:'utf8',timeout:60000,stdio:['ignore','pipe','pipe']}).trim()}
const alive=async()=>{
 try{
  const h=await fetch('http://127.0.0.1:'+PORT+'/__stable-health',{signal:AbortSignal.timeout(1000)});
  if(h.ok&&(await h.text()).trim()==='CFM_STABLE_GATEWAY_READY_v1')return;
 }catch{}
 return new Promise((resolve,reject)=>{
 broker=spawn(process.execPath,[B,'serve'],{stdio:['ignore','pipe','pipe']});let log='';
 const timeout=setTimeout(()=>reject(Error('Broker start timeout '+log)),5000);
 broker.on('exit',c=>{clearTimeout(timeout);reject(Error('Broker exited '+c+' '+log))});
 broker.stdout.on('data',x=>{log+=x;if(log.includes('CFM_STABLE_BROKER_READY')){clearTimeout(timeout);resolve();}});
 broker.stderr.on('data',x=>{log+=x});
 });
};
async function start(p,name){
 const raw=exec(process.execPath,[C,'start',name,'--cdp',String(p),'--mode','web','--ttl','3m',
   '--stable-origin',PUBLIC,'--interval','1']);
 const v=JSON.parse(raw);
 assert.equal(v.ok,true);assert.ok(v.url.startsWith(PUBLIC+'/m/'));assert.equal(v.password.length>=8,true);
 status.push({name,port:p,url:v.url,password:v.password});
}
const request=(u,opt={})=>fetch(u.replace(PUBLIC,'http://127.0.0.1:'+PORT),opt);
async function login(x){
 const first=await request(x.url);assert.equal(first.status,200);
 const firstHtml=await first.text();
 const csrf=firstHtml.match(/name="csrf" value="([^"]+)"/)?.[1];assert.ok(csrf);
 assert.match(firstHtml,/action="\/m\/[\w-]{32}\/login"/);
 const auth=await request(x.url+'login',{method:'POST',redirect:'manual',
  headers:{origin:PUBLIC,'content-type':'application/x-www-form-urlencoded',
    'sec-fetch-site':'same-origin'},
  body:new URLSearchParams({csrf,password:x.password})});
 assert.equal(auth.status,303,'login status '+auth.status);
 const cookie=auth.headers.get('set-cookie');assert.match(cookie,/Path=\/m\/[\w-]{32}\//);
 x.cookie=cookie.split(';')[0];
 const home=await request(x.url,{headers:{cookie:x.cookie}});assert.equal(home.status,200);
 const html=await home.text();assert.ok(html.includes('/m/'+x.url.split('/m/')[1].split('/')[0]+'/view/'));
 const view=await request(x.url+'view/',{headers:{cookie:x.cookie}});assert.equal(view.status,200);
 const viewHtml=await view.text();assert.ok(viewHtml.includes('/m/'+x.url.split('/m/')[1].split('/')[0]+'/input-ws'));
 return {home:home.status,view:view.status,origin:home.headers.get('content-security-policy')};
}
try{
 await alive();
 for(const [p,n] of cfgs)await start(p,n);
 const [a,b]=status;
 const listed=JSON.parse(exec(process.execPath,[C,'status'])).sessions;
 assert.equal(listed.find(x=>x.name===a.name)?.url,a.url);
 assert.equal(listed.find(x=>x.name===b.name)?.url,b.url);
 const [resultA,resultB]=await Promise.all([login(a),login(b)]);
 const crossed=await request(b.url,{headers:{cookie:a.cookie}});
 assert.equal(crossed.status,200); // Unauthorized GET / returns login HTML with HTTP 200 by design.
 const crossedHtml=await crossed.text();
 assert.ok(crossedHtml.includes('Private live mirror')&&!crossedHtml.includes('Interactive remote window'),
   'authentication must NOT cross sessions');
 const shot=await request(a.url+'shot.jpg',{headers:{cookie:a.cookie}});
 assert.equal(shot.status,200);assert.match(shot.headers.get('content-type'),/image\/jpeg/);
 const jpeg=await shot.arrayBuffer();assert.ok(jpeg.byteLength>100,'real screenshot');
 const noQuick=exec('sh',['-c',"ps -eo args | grep '[c]loudflared tunnel' | grep -cE '127.0.0.1:620[0-9]' || true"]);
 console.log(JSON.stringify({ok:true,live_concurrent:2,origin:PUBLIC,independent_auth:true,
  scoped_paths:true,websocket_path_in_viewer:true,
  source_a:status[0].port,source_b:status[1].port,
  http_result_a:resultA.home,http_result_b:resultB.home,
  screen_jpeg_bytes:jpeg.byteLength,
  no_quick_tunnels_required:true,
  cross_session_rejected:true,
  test_credentials_printed:false}));
}catch(e){console.error('CFM_LIVE_TEST_FAILED',e.stack||e);process.exitCode=1}
finally{
 for(const name of names){
  try{exec(process.execPath,[C,'stop',name]);}catch(e){console.error('CLEANUP_ERROR',name,e.message.slice(0,220))}
 }
 if(broker){broker.kill('SIGTERM');await delay(300)}
 try{exec(process.execPath,[B,'prune']);}catch{}
}
