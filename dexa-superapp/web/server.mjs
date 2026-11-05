import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const dir=path.dirname(fileURLToPath(import.meta.url));
const html=fs.readFileSync(path.join(dir,'index.html'));
const port=Number(process.env.PORT||4000);
const recent=[];
const counts=new Map();
const started=Date.now();
function response(res,status,body,type='application/json; charset=utf-8'){
  res.writeHead(status,{'content-type':type,'cache-control':'no-store','x-content-type-options':'nosniff','x-frame-options':'DENY','access-control-allow-origin':'*'});
  res.end(body);
}
function json(res,status,obj){response(res,status,JSON.stringify(obj));}
const config={
  schema:'dexa-super-dashboard.v1',name:'داشبورد دکسا',build:'web-v1.0.0',
  browserHome:'https://chatgpt.com/',defaultBrowsers:2,maxBrowsers:8,maxDashboards:8,
  actions:{
    observe:{label:'وضعیت صفحه',code:"(()=>({host:location.host,turnCount:document.querySelectorAll('[data-message-author-role]').length,voiceButtons:document.querySelectorAll('button[aria-label*=Voice],button[aria-label*=voice]').length}))()"},
    new_chat:{label:'گفت‌وگوی جدید',code:"(()=>{const a=[...document.querySelectorAll('a,button')].find(e=>{let t=((e.getAttribute('aria-label')||'')+' '+(e.textContent||'')).trim();return /new chat|چت جدید|گفتگوی جدید/i.test(t)});if(!a)return {ok:false,reason:'CONTROL_NOT_FOUND'};a.click();return {ok:true,action:'new_chat'}})()"},
    stop:{label:'توقف پاسخ',code:"(()=>{const b=[...document.querySelectorAll('button')].find(e=>/stop generating|stop response|توقف پاسخ/i.test(e.getAttribute('aria-label')||''));if(!b)return {ok:false,reason:'CONTROL_NOT_FOUND'};b.click();return {ok:true,action:'stop'}})()"}
  }
};
function cleanEvent(a){
  if(!a || typeof a!=='object')return null;
  const allowed=['id','session','device','build','event','slot','time','code','host','visible','count','pending','phase','ok','durationMs'];
  const o={};
  for(const k of allowed)if(Object.hasOwn(a,k)){
    const v=a[k];
    if(typeof v==='string')o[k]=v.slice(0,100);
    else if(typeof v==='boolean' || typeof v==='number')o[k]=v;
  }
  if(!/^[A-Z][A-Z0-9_]{2,55}$/.test(o.event||''))return null;
  return o;
}
const srv=http.createServer(async(req,res)=>{
  const url=new URL(req.url||'/', 'http://local');
  if(req.method==='GET' && url.pathname==='/api/health')return json(res,200,{ok:true,service:'dexa-super-dashboard',uptimeSeconds:Math.floor((Date.now()-started)/1000),eventsSeen:[...counts.values()].reduce((a,b)=>a+b,0),webVersion:config.build});
  if(req.method==='GET' && url.pathname==='/api/config')return json(res,200,config);
  if(req.method==='GET' && url.pathname==='/api/telemetry/summary')return json(res,200,{ok:true,total:recent.length,byEvent:Object.fromEntries(counts)});
  if(req.method==='GET' && (url.pathname==='/'||url.pathname==='/dashboard'))return response(res,200,html,'text/html; charset=utf-8');
  if(req.method==='POST' && url.pathname==='/api/telemetry'){
    let size=0,body='';
    try{for await(const chunk of req){size+=chunk.length;if(size>8192){json(res,413,{ok:false,reason:'TOO_LARGE'});return;}body+=chunk.toString('utf8');}}
    catch{json(res,400,{ok:false});return;}
    let raw;try{raw=JSON.parse(body)}catch{json(res,400,{ok:false,reason:'BAD_JSON'});return;}
    const event=cleanEvent(raw);
    if(!event)return json(res,422,{ok:false,reason:'INVALID_EVENT'});
    recent.push(event);if(recent.length>2000)recent.shift();
    counts.set(event.event,(counts.get(event.event)||0)+1);
    console.log('DXA_TELEM '+JSON.stringify(event));
    return json(res,202,{ok:true,id:event.id||null});
  }
  return json(res,404,{ok:false,reason:'NOT_FOUND'});
});
srv.listen(port,'0.0.0.0',()=>console.log('DXA_SUPER_DASHBOARD_READY port='+port));