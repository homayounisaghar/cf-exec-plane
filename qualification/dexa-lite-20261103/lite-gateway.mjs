import http from "node:http";
import fs from "node:fs";
import {createHash,timingSafeEqual} from "node:crypto";
const PREFIX="/dexa-lite",PORT=9518,HOST="127.0.0.1";
const PUBLIC_ORIGIN="https://cf-onshape.duckdns.org";
const BASE="/home/cfserver/.local/share/dexa-mobile-gateway-20261023";
const {username,passwordSha256}=JSON.parse(fs.readFileSync(BASE+"/credentials.json","utf8"));
const EXPECTED=Buffer.from(passwordSha256,"hex");
const CSS=fs.readFileSync("/home/cfserver/.local/share/dexa-lite-20261103/lite.css","utf8");
const FORWARDED_HEADERS=["accept","content-type","content-length",
 "x-dexa-web-form","x-dexa-submission-id","last-event-id"];
const COMMON_HEADERS={"cache-control":"no-store","x-content-type-options":"nosniff",
 "referrer-policy":"no-referrer","x-frame-options":"DENY",
 "permissions-policy":"camera=(), microphone=(), geolocation=(), payment=(), usb=()"};
const CSP="default-src 'self'; object-src 'none'; frame-ancestors 'none'; connect-src 'self'; img-src 'self' data:; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; base-uri 'self'; form-action 'self'";
const httpAgent=new http.Agent({keepAlive:true,maxSockets:80,maxFreeSockets:20,keepAliveMsecs:15000});
function basicValid(raw){
 if(typeof raw!=="string"||!raw.startsWith("Basic ")||raw.length>250)return false;
 let decoded;
 try{decoded=Buffer.from(raw.slice(6),"base64").toString("utf8")}catch{return false}
 const sep=decoded.indexOf(":");
 if(sep<1||sep>60||decoded.slice(0,sep)!==username)return false;
 const password=decoded.slice(sep+1);
 if(password.length<6||password.length>140)return false;
 const actual=createHash("sha256").update(password).digest();
 return actual.length===EXPECTED.length&&timingSafeEqual(actual,EXPECTED);
}
function send(res,status,content,type="application/json; charset=utf-8",extra={}){
 const buffer=Buffer.isBuffer(content)?content:Buffer.from(content);
 res.writeHead(status,{...COMMON_HEADERS,"content-security-policy":CSP,
  "content-type":type,"content-length":buffer.length,...extra});
 res.end(buffer);
}
function fail(res,status,code,headers={}){
 send(res,status,JSON.stringify({error:code}),"application/json; charset=utf-8",headers);
}
function checkOrigin(req){
 const origin=req.headers.origin;
 if(origin!==PUBLIC_ORIGIN&&origin!=="http://127.0.0.1:9518")return false;
 return req.headers["sec-fetch-site"]===undefined||
  ["same-origin","none"].includes(req.headers["sec-fetch-site"]);
}
function allowed(route,method){
 if(route==="/"&&method==="GET")return true;
 if(route==="/healthz"&&method==="GET")return true;
 if(route==="/api/planner/ready"&&method==="GET")return true;
 if(route==="/api/runtime/preflight"&&method==="GET")return true;
 if(route==="/api/form/challenge"&&method==="GET")return true;
 if(route==="/api/missions"&&["GET","POST"].includes(method))return true;
 if(route==="/api/missions/live"&&method==="GET")return true;
 if(/^\/api\/missions\/[0-9a-f-]{36}$/i.test(route)&&method==="GET")return true;
 if(/^\/api\/missions\/[0-9a-f-]{36}\/live$/i.test(route)&&method==="GET")return true;
 // Owner-authenticated, journal-only mission status; no control writes.
 if(/^\/api\/missions\/[0-9a-f-]{36}\/status$/i.test(route)&&method==="GET")return true;
 // Stage 4: exact owner control POST only. The existing Basic gate and
 // public-origin check run BEFORE this route; the Dexa main reusable
 // owner-form token, controlVersion CAS and typed Rana checks run AFTER.
 if(/^\/api\/missions\/[0-9a-f-]{36}\/control$/i.test(route)&&method==="POST")return true;
 if(/^\/api\/missions\/[0-9a-f-]{36}\/followup$/i.test(route)&&method==="POST")return true;
 return false;
}
function rewriteHTML(html){
 let out=html.replaceAll('"/api/','"'+PREFIX+'/api/')
  .replaceAll('"/healthz"','"'+PREFIX+'/healthz"');
 const oldTelegram=/<label style="display:flex;align-items:center;gap:9px;margin-top:8px">\s*<input id="telegramMvpMode"[^>]*>\s*<span>تلگرام \(فقط‌خواندنی\)<\/span>\s*<\/label>/u;
 if(!oldTelegram.test(out))throw new Error("LITE_TELEGRAM_LABEL_LAYOUT_CHANGED");
 out=out.replace(oldTelegram,'<input id="telegramMvpMode" type="checkbox" hidden>');
 if(!out.includes('<option value="5">۵ عدد</option>')||
    !out.includes('<option value="15" selected>۱۵ عدد</option>'))
    throw new Error("LITE_HISTORY_LAYOUT_CHANGED");
 out=out.replace('<option value="5">۵ عدد</option>',
                 '<option value="5" selected>۵ عدد</option>')
  .replace('<option value="15" selected>۱۵ عدد</option>',
           '<option value="15">۱۵ عدد</option>');
 const meta='<meta name="apple-mobile-web-app-capable" content="yes">'+
  '<meta name="apple-mobile-web-app-title" content="دکسا آزمایشی">'+
  '<meta name="theme-color" content="#13243a">'+
  '<style>'+CSS+'</style>';
 if(!out.includes("</head>"))throw new Error("LITE_HTML_HEAD_MISSING");
 const draftScript='<script>(function(){'+
  'const k="dexa.lite.draft.v1";const t=document.getElementById("taskText");'+
  'if(!t)return;try{const x=sessionStorage.getItem(k);if(x&&!t.value){'+
  't.value=x;t.dispatchEvent(new Event("input",{bubbles:true}));}}catch{}'+
  't.addEventListener("input",()=>{try{sessionStorage.setItem(k,t.value);}catch{}});'+
  '})();</script>';
 return out.replace("<title>دکسا | اجرای مأموریت</title>",
                    "<title>دکسا | نسخه ساده آزمایشی</title>")
   .replace("</head>",meta+"</head>")
   .replace("</body>",draftScript+"</body>");
}
function rewriteCookie(setCookie){
 if(!setCookie||!setCookie.startsWith("dexa_web_form="))return null;
 return setCookie.replace(/;\s*Path=\/(?:;|$)/i,"; Path="+PREFIX+"/;")
  .replace(/;\s*Max-Age=\d+/i,"; Max-Age=43200")+"; Secure";
}
function proxy(req,res,route,search){
 const started=performance.now();
 const headers={host:"127.0.0.1:9471"};
 for(const key of FORWARDED_HEADERS){
  if(typeof req.headers[key]==="string")headers[key]=req.headers[key];
 }
 const cookie=String(req.headers.cookie||"").split(";")
  .map(x=>x.trim()).find(x=>/^dexa_web_form=[A-Za-z0-9_-]{43}$/.test(x));
 if(cookie)headers.cookie=cookie;
 if(req.method==="POST"){
  headers.origin="http://127.0.0.1:9471";
  headers["sec-fetch-site"]="same-origin";
  headers["sec-fetch-mode"]="cors";
  headers["sec-fetch-dest"]="empty";
 }
 const upstream=http.request({
  hostname:"127.0.0.1",port:9471,path:route+search,method:req.method,
  headers,agent:httpAgent,timeout:120000
 },reply=>{
  const eventStream=String(reply.headers["content-type"]||"").includes("text/event-stream");
  // An event stream is long-lived; never force a 120-second reconnect cycle.
  // Security, authenticated proxying and cleanup still apply normally.
  if(eventStream)upstream.setTimeout(0);
  if(route==="/"&&!eventStream){
   const chunks=[];let size=0;
   reply.on("data",part=>{
    size+=part.length;
    if(size>850000){upstream.destroy(Error("HTML_TOO_LARGE"));return}
    chunks.push(part);
   });
   reply.once("end",()=>{
    try{
     const html=rewriteHTML(Buffer.concat(chunks).toString("utf8"));
     const extra={"server-timing":"dexa_upstream;dur="+(performance.now()-started).toFixed(2)};
     const cookieString=reply.headers["set-cookie"]?.[0];
     const cookieRewrite=rewriteCookie(cookieString);
     if(cookieRewrite)extra["set-cookie"]=cookieRewrite;
     send(res,reply.statusCode||200,html,"text/html; charset=utf-8",extra);
    }catch{fail(res,502,"HTML_REWRITE_FAILED")}
   });return;
  }
  const forward={...COMMON_HEADERS,"content-security-policy":CSP,
   "content-type":reply.headers["content-type"]||"application/json; charset=utf-8",
   "server-timing":"dexa_upstream;dur="+(performance.now()-started).toFixed(2)};
  if(eventStream){
   forward["cache-control"]="no-store, no-transform";
   forward["x-accel-buffering"]="no";
  }
  const cookieString=reply.headers["set-cookie"]?.[0];
  const scoped=rewriteCookie(cookieString);
  if(scoped)forward["set-cookie"]=scoped;
  if(reply.headers["content-length"])forward["content-length"]=reply.headers["content-length"];
  res.writeHead(reply.statusCode||502,forward);
  reply.pipe(res);
 });
 upstream.on("timeout",()=>upstream.destroy(Error("UPSTREAM_TIMEOUT")));
 upstream.on("error",()=>{
  if(!res.headersSent)fail(res,502,"DEXA_UPSTREAM_UNAVAILABLE");
  else res.destroy();
 });
 req.on("aborted",()=>upstream.destroy());
 res.on("close",()=>{if(!res.writableEnded)upstream.destroy()});
 if(req.method==="POST"){
  let bytes=0;
  req.on("data",part=>{bytes+=part.length;if(bytes>14000)upstream.destroy(Error("REQUEST_TOO_LARGE"))});
 }
 req.pipe(upstream);
}
const server=http.createServer((req,res)=>{
 if(req.socket.remoteAddress!=="127.0.0.1"&&req.socket.remoteAddress!=="::1"){
  fail(res,403,"LOOPBACK_ONLY");return;
 }
 const hostname=String(req.headers.host||"");
 if(hostname!=="cf-onshape.duckdns.org"&&hostname!=="127.0.0.1:9518"){
  fail(res,403,"HOST_NOT_ALLOWED");return;
 }
 if(req.method==="GET"&&req.url==="/_local-health"&&hostname==="127.0.0.1:9518"){
  send(res,200,JSON.stringify({ok:true,role:"dexa-lite-gateway",
   upstream:"http://127.0.0.1:9471",localhostOnly:true}));return;
 }
 let url;
 try{url=new URL(req.url,"http://127.0.0.1:9518")}
 catch{fail(res,400,"INVALID_REQUEST_URL");return}
 if(url.pathname!==PREFIX&&url.pathname!==PREFIX+"/"&&!url.pathname.startsWith(PREFIX+"/")){
  fail(res,404,"NOT_FOUND");return;
 }
 if(req.method==="GET"&&url.pathname===PREFIX+"/check"){
  return send(res,200,'<!doctype html><html lang="fa" dir="rtl"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'+
  '<title>بررسی اتصال دکسا</title><style>body{font:16px Tahoma,Arial,sans-serif;background:#f5f7fa;color:#18293e;margin:0;padding:28px 16px;line-height:2}main{max-width:560px;margin:auto;background:white;border-radius:16px;padding:24px;border:1px solid #dce3ea}a{color:#164c7e}</style>'+
  '<main><h1>مسیر ارتباطی دکسا در دسترس است</h1><p>اگر این صفحه بدون فیلترشکن باز شده، دامنه و اتصال امن این مسیر از شبکهٔ فعلی شما قابل دسترسی است. اجرای مأموریت هنوز باید جداگانه آزمایش شود.</p><a href="/dexa-lite/">ورود به نسخهٔ آزمایشی</a></main></html>',
  "text/html; charset=utf-8");
 }
 if(!basicValid(req.headers.authorization)){
  fail(res,401,"AUTH_REQUIRED",{
   "www-authenticate":'Basic realm="Dexa Mobile Private", charset="UTF-8"'});
  return;
 }
 const route=url.pathname===PREFIX?"/":url.pathname.slice(PREFIX.length);
 // Readiness is driven only by the authorized userscript polling /bridge/*.
 if(!allowed(route,req.method)){
  fail(res,404,"ROUTE_NOT_ALLOWED");return;
 }
 if(req.method==="POST"&&!checkOrigin(req)){
  fail(res,403,"MOBILE_ORIGIN_DENIED");return;
 }
 proxy(req,res,route,url.search);
});
server.headersTimeout=12000;server.requestTimeout=20000;server.keepAliveTimeout=70000;
server.listen(PORT,HOST,()=>console.log(JSON.stringify({
 liteGatewayReady:true,listener:"127.0.0.1:"+PORT,publicPath:PREFIX+"/",
 upstream:"127.0.0.1:9471",auth:"PASSWORD_SHA256_BASIC",noCredentialsLogged:true})));
