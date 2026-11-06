import http from 'node:http';
import {createRemoteGateway} from './remote-gateway.mjs';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const dir=path.dirname(fileURLToPath(import.meta.url));
const html=fs.readFileSync(path.join(dir,'index.html'));
const toolbar=fs.readFileSync(path.join(dir,'toolbar.html'));
const theme=fs.readFileSync(path.join(dir,'theme.css'));
const themeClient=fs.readFileSync(path.join(dir,'theme-client.js'));
const autoHandoff=fs.readFileSync(path.join(dir,'auto-handoff.js'));
const cyclePanel=fs.readFileSync(path.join(dir,'cycle-panel.js'));
const port=Number(process.env.PORT||4000);
const recent=[];
const counts=new Map();
const started=Date.now();
const remoteGateway=createRemoteGateway();
function response(res,status,body,type='application/json; charset=utf-8'){
  res.writeHead(status,{'content-type':type,'cache-control':'no-store','x-content-type-options':'nosniff','x-frame-options':'DENY','access-control-allow-origin':'*'});
  res.end(body);
}
function json(res,status,obj){response(res,status,JSON.stringify(obj));}
const config={
  schema:'dexa-super-dashboard.v1',name:'داشبورد دکسا',build:'web-v1.6.3',
  browserHome:'https://chatgpt.com/',defaultBrowsers:2,maxBrowsers:8,maxDashboards:8,
  desiredBrowserCount:null,
  dashboards:[{id:'control',title:'کنترل دکسا',description:'مدیریت مرورگرها'},{id:'cycle',title:'ورودی و خروجی',description:'چرخهٔ دو مرورگر'},{id:'theme',title:'تم رنگی'},{id:'permissions',title:'دسترسی‌های اندروید'}],
  permissions: [
    {id:'android.permission.READ_SMS',label:'خواندن پیامک',group:'پیامک و تماس'},
    {id:'android.permission.RECEIVE_SMS',label:'دریافت پیامک',group:'پیامک و تماس'},
    {id:'android.permission.SEND_SMS',label:'ارسال پیامک',group:'پیامک و تماس'},
    {id:'android.permission.READ_CONTACTS',label:'خواندن مخاطبان',group:'پیامک و تماس'},
    {id:'android.permission.WRITE_CONTACTS',label:'ویرایش مخاطبان',group:'پیامک و تماس'},
    {id:'android.permission.READ_PHONE_STATE',label:'وضعیت تلفن',group:'پیامک و تماس'},
    {id:'android.permission.READ_PHONE_NUMBERS',label:'شمارهٔ تلفن',group:'پیامک و تماس'},
    {id:'android.permission.CALL_PHONE',label:'برقراری تماس',group:'پیامک و تماس'},
    {id:'android.permission.READ_CALL_LOG',label:'خواندن تاریخچهٔ تماس',group:'پیامک و تماس'},
    {id:'android.permission.WRITE_CALL_LOG',label:'ویرایش تاریخچهٔ تماس',group:'پیامک و تماس'},
    {id:'default_sms',label:'نقش برنامهٔ پیش‌فرض پیامک',group:'پیامک و تماس'},
    {id:'android.permission.CAMERA',label:'دوربین',group:'رسانه و صدا'},
    {id:'android.permission.RECORD_AUDIO',label:'میکروفون',group:'رسانه و صدا'},
    {id:'android.permission.READ_MEDIA_IMAGES',label:'خواندن تصاویر',group:'رسانه و صدا'},
    {id:'android.permission.READ_MEDIA_VIDEO',label:'خواندن ویدیوها',group:'رسانه و صدا'},
    {id:'android.permission.READ_MEDIA_AUDIO',label:'خواندن فایل‌های صوتی',group:'رسانه و صدا'},
    {id:'android.permission.READ_MEDIA_VISUAL_USER_SELECTED',label:'تصاویر انتخاب‌شده',group:'رسانه و صدا'},
    {id:'android.permission.ACCESS_MEDIA_LOCATION',label:'اطلاعات مکانی عکس‌ها',group:'رسانه و صدا'},
    {id:'android.permission.ACCESS_COARSE_LOCATION',label:'موقعیت تقریبی',group:'مکان و حسگر'},
    {id:'android.permission.ACCESS_FINE_LOCATION',label:'موقعیت دقیق',group:'مکان و حسگر'},
    {id:'background_location',label:'موقعیت در پس‌زمینه',group:'مکان و حسگر'},
    {id:'android.permission.ACTIVITY_RECOGNITION',label:'فعالیت حرکتی',group:'مکان و حسگر'},
    {id:'android.permission.BODY_SENSORS',label:'حسگرهای بدن',group:'مکان و حسگر'},
    {id:'android.permission.BLUETOOTH_CONNECT',label:'اتصال بلوتوث',group:'ارتباطات نزدیک'},
    {id:'android.permission.BLUETOOTH_SCAN',label:'اسکن بلوتوث',group:'ارتباطات نزدیک'},
    {id:'android.permission.BLUETOOTH_ADVERTISE',label:'انتشار بلوتوث',group:'ارتباطات نزدیک'},
    {id:'android.permission.NEARBY_WIFI_DEVICES',label:'دستگاه‌های وای‌فای نزدیک',group:'ارتباطات نزدیک'},
    {id:'android.permission.READ_CALENDAR',label:'خواندن تقویم',group:'اطلاعات و تقویم'},
    {id:'android.permission.WRITE_CALENDAR',label:'ویرایش تقویم',group:'اطلاعات و تقویم'},
    {id:'android.permission.POST_NOTIFICATIONS',label:'ارسال اعلان‌های خود برنامه',group:'اعلان‌ها'},
    {id:'notification_listener',label:'دسترسی به اعلان‌های گوشی',group:'اعلان‌ها'},
    {id:'dnd',label:'مدیریت مزاحم نشوید',group:'اعلان‌ها'},
    {id:'all_files',label:'مدیریت فایل‌های مشترک',group:'سیستم و فایل‌ها'},
    {id:'saf_tree',label:'دسترسی به پوشهٔ انتخابی',group:'سیستم و فایل‌ها'},
    {id:'overlay',label:'نمایش روی سایر برنامه‌ها',group:'سیستم و فایل‌ها'},
    {id:'usage_access',label:'آمار استفاده از برنامه‌ها',group:'سیستم و فایل‌ها'},
    {id:'write_settings',label:'تغییر تنظیمات سیستم',group:'سیستم و فایل‌ها'},
    {id:'accessibility',label:'سرویس دسترس‌پذیری',group:'سیستم و فایل‌ها'},
    {id:'exact_alarm',label:'زمان‌بندی دقیق',group:'سیستم و فایل‌ها'},
    {id:'install_packages',label:'مجوز نصب APK',group:'سیستم و فایل‌ها'},
    {id:'battery_exempt',label:'استثنا از بهینه‌سازی باتری',group:'سیستم و فایل‌ها'}
  ],

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
  if(url.pathname.startsWith('/api/remote/'))return remoteGateway(req,res,url);
  if(req.method==='GET' && url.pathname==='/api/health')return json(res,200,{ok:true,service:'dexa-super-dashboard',uptimeSeconds:Math.floor((Date.now()-started)/1000),eventsSeen:[...counts.values()].reduce((a,b)=>a+b,0),webVersion:config.build});
  if(req.method==='GET' && url.pathname==='/api/config')return json(res,200,config);
  if(req.method==='GET' && url.pathname==='/api/telemetry/summary')return json(res,200,{ok:true,total:recent.length,byEvent:Object.fromEntries(counts)});
  if(req.method==='GET' && url.pathname==='/theme.css')return response(res,200,theme,'text/css; charset=utf-8');
  if(req.method==='GET' && url.pathname==='/remote-client.js')return response(res,200,fs.readFileSync(path.join(dir,'remote-client.js')),'application/javascript; charset=utf-8');
  if(req.method==='GET' && url.pathname==='/theme-client.js')return response(res,200,themeClient,'application/javascript; charset=utf-8');
  if(req.method==='GET' && url.pathname==='/auto-handoff.js')return response(res,200,autoHandoff,'application/javascript; charset=utf-8');
  if(req.method==='GET' && url.pathname==='/cycle-panel.js')return response(res,200,cyclePanel,'application/javascript; charset=utf-8');
  if(req.method==='GET' && url.pathname==='/toolbar')return response(res,200,toolbar,'text/html; charset=utf-8');
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