
const VERSION = "DEXA_CLOUDFLARE_BRIDGE_V1";
const UPSTREAM_ORIGIN = "https://cf-onshape.duckdns.org";
// IMPORTANT: Set this to the REAL independent Worker URL on account B AFTER it is deployed and owner-tested.
// Do not point to another Worker on the same account; quotas are per account.
// Null keeps A safe in single-account mode. A browser switch is impossible until B exists.
const BACKUP_ORIGIN = "https://dexa-cf-backup-20261104.mirkazem-design.workers.dev";
const INSTALL_SCRIPT = "(function(){\n  \"use strict\";\n  var VERSION=\"DEXA_CLOUDFLARE_BRIDGE_V1\";\n  var sw=navigator.serviceWorker;\n  var badge=document.createElement(\"div\");\n  var lastProbe=0;\n  badge.id=\"dexa-failover-browser-status\";\n  badge.dir=\"rtl\";\n  badge.setAttribute(\"role\",\"status\");\n  badge.setAttribute(\"aria-live\",\"polite\");\n  badge.style.cssText=\"position:fixed;bottom:calc(10px + env(safe-area-inset-bottom));left:10px;z-index:2147483647;max-width:calc(100% - 20px);padding:7px 11px;border-radius:16px;direction:rtl;text-align:right;font:600 12px/1.6 system-ui,Tahoma,Arial,sans-serif;box-shadow:0 2px 10px #0002;pointer-events:none;box-sizing:border-box\";\n  document.body.appendChild(badge);\n  function display(label,kind){\n    badge.textContent=label;\n    badge.dataset.state=kind;\n    badge.style.background=kind===\"ready\"?\"#e6f6e9\":kind===\"pending\"?\"#fff4d6\":\"#fff0ed\";\n    badge.style.color=kind===\"ready\"?\"#136234\":kind===\"pending\"?\"#815600\":\"#a3201b\";\n    badge.style.border=\"1px solid \"+(kind===\"ready\"?\"#a2d8af\":kind===\"pending\"?\"#e9ce88\":\"#e9b4aa\");\n  }\n  display(\"در حال بررسی انتقال خودکار…\",\"pending\");\n  if(!sw || typeof MessageChannel!==\"function\"){\n    display(\"✕ انتقال خودکار در این مرورگر پشتیبانی نمی‌شود\",\"off\");\n    return;\n  }\n  sw.addEventListener(\"message\",function(event){\n    var data=event.data;\n    if(!data || data.type!==\"DEXA_QUOTA_FAILOVER\" || typeof data.url!==\"string\")return;\n    try{\n      var destination=new URL(data.url);\n      if(destination.protocol===\"https:\" && destination.origin!==location.origin)location.replace(destination.href);\n    }catch(_){}\n  });\n  function probe(){\n    var id=++lastProbe;\n    var controller=sw.controller;\n    if(!controller){\n      display(\"⏳ نصب در جریان است؛ اگر فعال نشد صفحه را تازه‌سازی کن\",\"pending\");\n      return;\n    }\n    display(\"در حال تأیید انتقال خودکار…\",\"pending\");\n    var channel=new MessageChannel();\n    var done=false;\n    var timeout=setTimeout(function(){\n      if(done)return;\n      done=true;\n      channel.port1.close();\n      if(id===lastProbe)display(\"⚠ وضعیت انتقال خودکار تأیید نشد\",\"off\");\n    },3500);\n    channel.port1.onmessage=function(event){\n      if(done)return;\n      done=true;\n      clearTimeout(timeout);\n      channel.port1.close();\n      if(id!==lastProbe)return;\n      var data=event.data;\n      if(data && data.type===\"DEXA_FAILOVER_STATUS\" && data.version===VERSION && data.backupReady===true){\n        display(\"✓ انتقال خودکار آماده است\",\"ready\");\n      }else{\n        display(\"✕ انتقال خودکار در این آدرس فعال نیست\",\"off\");\n      }\n    };\n    try{\n      controller.postMessage({type:\"DEXA_FAILOVER_STATUS_QUERY\"},[channel.port2]);\n    }catch(_){\n      if(!done){done=true;clearTimeout(timeout);channel.port1.close();}\n      if(id===lastProbe)display(\"✕ بررسی انتقال خودکار ممکن نیست\",\"off\");\n    }\n  }\n  sw.addEventListener(\"controllerchange\",probe);\n  probe();\n  sw.register(\"/sw.js\",{scope:\"/\",updateViaCache:\"none\"}).then(function(){\n    sw.ready.then(probe,function(){display(\"✕ سرویس‌ورکر فعال نشد\",\"off\");});\n  },function(){display(\"✕ نصب انتقال خودکار ناموفق بود\",\"off\");});\n})();";
const BOOT_HTML = "<!doctype html><html lang=\"fa\" dir=\"rtl\"><head><meta charset=\"utf-8\">\n<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><meta name=\"robots\" content=\"noindex,nofollow\">\n<title>دکسا | ورود امن</title>\n<style>body{font-family:system-ui,sans-serif;margin:0;padding:24px;background:#f3f7fc;color:#16263b;min-height:100svh;display:grid;place-items:center;box-sizing:border-box}main{max-width:430px;width:100%;background:white;border:1px solid #dde5f0;border-radius:20px;padding:25px;box-sizing:border-box}h1{font-size:1.5rem}p{line-height:2}a{display:block;background:#1766c9;color:#fff;padding:14px;border-radius:12px;text-align:center;text-decoration:none;font-weight:700}small{display:block;color:#53657a;margin-top:18px;line-height:1.8}</style></head>\n<body><main><h1>دکسا</h1><p>ارتباط امن با موتور اصلی دکسا روی هتزنر. ورود خصوصی لازم است.</p>\n<a href=\"/dexa-lite/\">بازکردن دکسا</a>\n<small>وقتی نشانگر پایین صفحه سبز شد، انتقال خودکار در همین مرورگر آماده است. در حساب پشتیبان شاید لازم باشد دوباره وارد شوی.</small>\n</main><script>@@INSTALL@@</script></body></html>";
const SW_SOURCE = "\"use strict\";\nconst BACKUP_ORIGIN = @@BACKUP_ORIGIN@@;\nself.addEventListener(\"install\", function(event){event.waitUntil(self.skipWaiting());});\nself.addEventListener(\"activate\", function(event){event.waitUntil(self.clients.claim());});\nfunction backupUrl(path) {\n  if (typeof BACKUP_ORIGIN !== \"string\") return null;\n  try {\n    const u = new URL(BACKUP_ORIGIN);\n    if (u.protocol !== \"https:\" || u.origin === self.location.origin || u.pathname !== \"/\" || u.search || u.hash) return null;\n    return new URL(path, u.origin).href;\n  } catch (_) { return null; }\n}\nasync function quotaResponse(response) {\n  if (!response || response.status < 400) return false;\n  const type = (response.headers.get(\"content-type\") || \"\").toLowerCase();\n  if (!/text|html|json/.test(type)) return false;\n  try {\n    const text = (await response.clone().text()).slice(0, 16000);\n    return /(?:error\\s*(?:code\\s*)?[:#]?\\s*1027|code\\s*1027\\b)/i.test(text);\n  } catch (_) { return false; }\n}\nself.addEventListener(\"fetch\", function(event) {\n  const req = event.request, url = new URL(req.url);\n  if (url.origin !== self.location.origin || url.pathname === \"/sw.js\") return;\n  event.respondWith((async function(){\n    let response;\n    try {\n      response = await fetch(req);\n    } catch (_) {\n      // Network ambiguity: never repeat mission writes or treat it as confirmed quota exhaustion.\n      return Response.error();\n    }\n    const backup = backupUrl(url.pathname + url.search);\n    if (!backup || !(await quotaResponse(response))) return response;\n    if (req.mode === \"navigate\" && req.method === \"GET\") {\n      return Response.redirect(backup, 302);\n    }\n    const client = event.clientId ? await self.clients.get(event.clientId) : null;\n    if (client) {\n      const landing = backupUrl(\"/dexa-lite/\");\n      if (landing) client.postMessage({type:\"DEXA_QUOTA_FAILOVER\",url:landing});\n    }\n    // Do NOT transparently retry POST. It might be a mission submission.\n    return new Response(\"DEXA_QUOTA_FAILOVER\",{status:503,headers:{\"content-type\":\"text/plain; charset=utf-8\",\"cache-control\":\"no-store\"}});\n  })());\n});";
const SW_STATUS_SOURCE = "\nself.addEventListener(\"message\",function(event){\n  if(!event.data || event.data.type!==\"DEXA_FAILOVER_STATUS_QUERY\")return;\n  const port=event.ports && event.ports[0];\n  if(!port)return;\n  port.postMessage({\n    type:\"DEXA_FAILOVER_STATUS\",\n    version:\"DEXA_CLOUDFLARE_BRIDGE_V1\",\n    backupReady:Boolean(backupUrl(\"/dexa-lite/\"))\n  });\n});\n";
const OUTBOUND_HEADERS = ["authorization","cookie","accept","content-type","x-dexa-web-form","x-dexa-submission-id","last-event-id"];
const INBOUND_HEADERS = ["content-type","cache-control","content-security-policy","set-cookie","www-authenticate","referrer-policy","x-content-type-options","x-frame-options","permissions-policy"];
function plain(code,text,type="text/plain; charset=utf-8") {
  return new Response(text,{status:code,headers:{"content-type":type,"cache-control":"no-store","x-content-type-options":"nosniff","referrer-policy":"no-referrer"}});
}
function allowed(path,method) {
  if(path==="/dexa-lite/"||path==="/dexa-lite")return method==="GET";
  if(path==="/dexa-lite/check"||path==="/dexa-lite/healthz")return method==="GET";
  if(["/api/planner/ready","/api/runtime/preflight","/api/form/challenge","/api/missions/live"].some(p=>path==="/dexa-lite"+p))return method==="GET";
  if(path==="/dexa-lite/api/missions")return method==="GET"||method==="POST";
  if(/^\/dexa-lite\/api\/missions\/[0-9a-f-]{36}(?:\/(?:status|live))?$/i.test(path))return method==="GET";
  if(/^\/dexa-lite\/api\/missions\/[0-9a-f-]{36}\/(?:control|followup)$/i.test(path))return method==="POST";
  return false;
}
function sameOriginPost(request,url) {
  if(request.headers.get("origin")!==url.origin)return false;
  const sec=request.headers.get("sec-fetch-site");
  return !sec||sec==="same-origin"||sec==="none";
}
async function proxy(request,url) {
  if(!allowed(url.pathname,request.method))return plain(404,"NOT_ALLOWED");
  if(request.method==="POST"&&!sameOriginPost(request,url))return plain(403,"ORIGIN_DENIED");
  const upstreamUrl=new URL(url.pathname+url.search,UPSTREAM_ORIGIN);
  const forwarded=new Headers();
  for(const key of OUTBOUND_HEADERS) {
    const value=request.headers.get(key);
    if(value!==null)forwarded.set(key,value);
  }
  if(request.method==="POST") {
    // The user's browser was checked for SAME-ORIGIN above. Rebind only that trusted origin
    // to the existing localhost-only gateway's original CSRF policy.
    forwarded.set("origin",UPSTREAM_ORIGIN);
    forwarded.set("sec-fetch-site","same-origin");
  }
  try {
    const options={method:request.method,headers:forwarded,redirect:"manual",signal:request.signal};
    if(request.method==="POST"){options.body=request.body;options.duplex="half";}
    const reply=await fetch(upstreamUrl.href,options);
    const rh=new Headers({"cache-control":"no-store","x-dexa-bridge":VERSION});
    for(const key of INBOUND_HEADERS) {
      const value=reply.headers.get(key);
      if(value!==null)rh.set(key,value);
    }
    if(reply.status>=300&&reply.status<400) {
      const location=reply.headers.get("location");
      if(location) {
        const dest=new URL(location,UPSTREAM_ORIGIN);
        if(dest.origin!==UPSTREAM_ORIGIN)return plain(502,"UNEXPECTED_REDIRECT_ORIGIN");
        rh.set("location",url.origin+dest.pathname+dest.search+dest.hash);
      }
    }
    if(reply.status===200&&(url.pathname==="/dexa-lite/"||url.pathname==="/dexa-lite")&&String(reply.headers.get("content-type")||"").includes("text/html")) {
      const html=await reply.text();
      if(html.length>900000||!html.includes("</body>"))return plain(502,"UNEXPECTED_UPSTREAM_HTML");
      const patched=html.replace("</body>","<script>"+INSTALL_SCRIPT+"</script></body>");
      rh.delete("content-length");
      return new Response(patched,{status:200,headers:rh});
    }
    // Streaming: forward SSE byte-for-byte. Never buffer mission responses or log private data.
    return new Response(reply.body,{status:reply.status,statusText:reply.statusText,headers:rh});
  } catch (_) {
    return plain(502,"UPSTREAM_UNAVAILABLE");
  }
}
export default {
  async fetch(request) {
    const url=new URL(request.url);
    if(request.method!=="GET"&&request.method!=="POST")return plain(405,"METHOD_NOT_ALLOWED");
    if(url.pathname==="/"&&request.method==="GET") {
      return plain(200,BOOT_HTML.replace("@@INSTALL@@",INSTALL_SCRIPT),"text/html; charset=utf-8");
    }
    if(url.pathname==="/sw.js"&&request.method==="GET") {
      const sw=SW_SOURCE.replace("@@BACKUP_ORIGIN@@",JSON.stringify(BACKUP_ORIGIN))+SW_STATUS_SOURCE;
      const response=plain(200,sw,"text/javascript; charset=utf-8");
      response.headers.set("service-worker-allowed","/");
      response.headers.set("cache-control","no-cache, no-store");
      return response;
    }
    if(url.pathname==="/bridge-health"&&request.method==="GET") {
      return Response.json({ok:true,version:VERSION,backupReady:typeof BACKUP_ORIGIN==="string"},{headers:{"cache-control":"no-store"}});
    }
    if(url.pathname.startsWith("/dexa-lite"))return proxy(request,url);
    return plain(404,"NOT_FOUND");
  }
};