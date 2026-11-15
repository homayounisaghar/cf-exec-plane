const VERSION = "DEXA_CLOUDFLARE_BRIDGE_V5_NATIVE_API_VPNFREE_20261115";
const UPSTREAM_ORIGIN = "https://cf-onshape.duckdns.org";
// IMPORTANT: Set this to the REAL independent Worker URL on account B AFTER it is deployed and owner-tested.
// Do not point to another Worker on the same account; quotas are per account.
// Null keeps A safe in single-account mode. A browser switch is impossible until B exists.
const ROUTE_POOL_SOURCE =
  "https://raw.githubusercontent.com/homayounisaghar/cf-exec-plane/main/dexa/workers/route-pool.json";
const SEED_ROUTE_POOL = ["https://dexa-cf-worker-canary-20261104.mirkazem.workers.dev", "https://dexa-cf-backup-20261104.mirkazem-design.workers.dev"];
let poolMemo=null;
let poolMemoExpires=0;
function normalizePool(candidate){
  if(!candidate||candidate.schema!=="dexa.worker-pool.v1"||
      !Array.isArray(candidate.origins))return null;
  const result=[];
  for(const input of candidate.origins){
    try{
      const u=new URL(input);
      if(u.protocol!=="https:"||u.pathname!=="/"||u.search||u.hash||
          u.username||u.password||!u.hostname.endsWith(".workers.dev"))continue;
      if(!result.includes(u.origin))result.push(u.origin);
    }catch{}
  }
  return result.length?result:null;
}
async function activePool(){
  if(poolMemo&&Date.now()<poolMemoExpires)return poolMemo.slice();
  try{
    const c=new AbortController();
    const timer=setTimeout(()=>c.abort(),3500);
    let response;
    try{response=await fetch(ROUTE_POOL_SOURCE,{
      signal:c.signal,headers:{"accept":"application/json"},
      cf:{cacheTtl:300,cacheEverything:true}});
    }finally{clearTimeout(timer)}
    if(response.ok){
      const text=await response.text();
      if(text.length<=32768){
        const pool=normalizePool(JSON.parse(text));
        if(pool){poolMemo=pool;poolMemoExpires=Date.now()+300000;return pool.slice();}
      }
    }
  }catch{}
  // If the registry is temporarily offline, keep previously loaded entries.
  if(poolMemo&&poolMemo.length)return poolMemo.slice();
  return SEED_ROUTE_POOL.slice();
}

const INSTALL_SCRIPT = "(function(){\n  if (!(\"serviceWorker\" in navigator)) return;\n  navigator.serviceWorker.register(\"/sw.js\",{scope:\"/\",updateViaCache:\"none\"}).catch(function(){});\n  navigator.serviceWorker.addEventListener(\"message\",function(event){\n    var d=event.data;\n    if(!d||d.type!==\"DEXA_QUOTA_FAILOVER\"||typeof d.url!==\"string\")return;\n    try{\n      var target=new URL(d.url);\n      if(target.protocol!==\"https:\"||target.origin===location.origin||!target.hostname.endsWith(\".workers.dev\"))return;\n      location.replace(target.href);\n    }catch(_){}\n  });\n})();";
const BOOT_HTML = "<!doctype html><html lang=\"fa\" dir=\"rtl\"><head><meta charset=\"utf-8\">\n<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><meta name=\"robots\" content=\"noindex,nofollow\">\n<title>دکسا | ورود امن</title>\n<style>body{font-family:system-ui,sans-serif;margin:0;padding:24px;background:#f3f7fc;color:#16263b;min-height:100svh;display:grid;place-items:center;box-sizing:border-box}main{max-width:430px;width:100%;background:white;border:1px solid #dde5f0;border-radius:20px;padding:25px;box-sizing:border-box}h1{font-size:1.5rem}p{line-height:2}a{display:block;background:#1766c9;color:#fff;padding:14px;border-radius:12px;text-align:center;text-decoration:none;font-weight:700}small{display:block;color:#53657a;margin-top:18px;line-height:1.8}</style></head>\n<body><main><h1>دکسا</h1><p>ارتباط امن با موتور اصلی دکسا روی هتزنر. ورود خصوصی لازم است.</p>\n<a href=\"/dexa-lite/\">بازکردن دکسا</a>\n<small>برای سوئیچ خودکار در خطای ظرفیت، این صفحه را یک‌بار در حالت عادی باز کن تا قابلیت آفلاین مرورگر فعال شود. در حساب پشتیبان ممکن است لازم باشد دوباره وارد شوی.</small>\n</main><script>@@INSTALL@@</script></body></html>";
const SW_SOURCE = "/* Dexa generic N-account Service Worker. Identical in every Cloudflare account.\n   A consumed quota (HTTP 1027) can be observed by an already-installed SW;\n   a completely new browser at a fully exhausted account cannot run its\n   first SW, so native/app external entry selection is still necessary. */\n\"use strict\";\nconst FALLBACK_POOL = [\n  \"https://dexa-cf-worker-canary-20261104.mirkazem.workers.dev\",\n  \"https://dexa-cf-backup-20261104.mirkazem-design.workers.dev\"\n];\nconst REGISTRY = \"/bridge-pool\";\nconst CACHE_KEY = \"/__dexa_worker_pool_cached_v1\";\nconst ROUTE_PARAM = \"__dexa_step\";\nfunction validOrigin(raw){\n  try{\n    const u=new URL(raw);\n    if(u.protocol!==\"https:\"||u.pathname!==\"/\"||u.search||u.hash||u.username||u.password||\n       !u.hostname.endsWith(\".workers.dev\"))return null;\n    return u.origin;\n  }catch{return null;}\n}\nfunction cleanPool(raw){\n  const origins=raw&&Array.isArray(raw.origins)?raw.origins:[];\n  const normalized=[...new Set(origins.map(validOrigin).filter(Boolean))];\n  if(!normalized.length)return FALLBACK_POOL.slice();\n  return normalized;\n}\nasync function pool(){\n  const storage=await caches.open(\"dexa-worker-pool-v1\");\n  try{\n    const r=await fetch(REGISTRY,{cache:\"no-store\"});\n    if(r.ok){\n      const data=await r.json();\n      const origins=cleanPool(data);\n      if(Array.isArray(data.origins)&&origins.length){\n        await storage.put(CACHE_KEY,new Response(JSON.stringify({\n          schema:\"dexa.worker-pool.v1\",origins\n        }),{headers:{\"content-type\":\"application/json\"}}));\n      }\n      return origins;\n    }\n  }catch{}\n  try{\n    const cached=await storage.match(CACHE_KEY);\n    if(cached)return cleanPool(await cached.json());\n  }catch{}\n  return FALLBACK_POOL.slice();\n}\nasync function nextInRing(current,step){\n  const origins=await pool();\n  if(!origins.includes(current))origins.push(current);\n  const n=origins.length,at=origins.indexOf(current);\n  // Number of attempts derives ONLY from the current registry length. No\n  // fixed 2/3 count and no bounce loop when all accounts are unavailable.\n  if(n<=1||step>=n-1)return {next:null,poolSize:n,hop:step};\n  return {next:origins[(at+1)%n],poolSize:n,hop:step+1};\n}\nfunction hopValue(url){\n  const parsed=Number(url.searchParams.get(ROUTE_PARAM)||0);\n  return Number.isSafeInteger(parsed)&&parsed>=0?parsed:0;\n}\nfunction nextUrl(from,next,hop,pathOnly){\n  const target=new URL(pathOnly?\n    \"/dexa-superapp/\"+(from.searchParams.has(ROUTE_PARAM)?\"\":\"\"):\n    from.pathname+from.search, next);\n  // For POST, navigation is a fresh GET to dashboard, NOT replaying the POST.\n  if(pathOnly){target.pathname=\"/dexa-superapp/\";target.search=\"\";}\n  target.searchParams.set(ROUTE_PARAM,String(hop));\n  return target.href;\n}\nasync function quotaResponse(response){\n  if(!response||response.status<400)return false;\n  const type=(response.headers.get(\"content-type\")||\"\").toLowerCase();\n  if(!/text|html|json/.test(type))return false;\n  try{\n    const body=(await response.clone().text()).slice(0,16000);\n    return /(?:error\\s*(?:code\\s*)?[:#]?\\s*1027|code\\s*1027\\b)/i.test(body);\n  }catch{return false;}\n}\nfunction exhausted(n){\n  return new Response(\n    \"DEXA_WORKER_POOL_EXHAUSTED: Every configured account was checked once in this switch cycle; no POST was replayed.\",\n    {status:503,headers:{\"content-type\":\"text/plain; charset=utf-8\",\"cache-control\":\"no-store\",\n      \"x-dexa-worker-pool-exhausted\":String(n)}}\n  );\n}\nself.addEventListener(\"install\",event=>{\n  event.waitUntil((async()=>{await self.skipWaiting();await pool()})());\n});\nself.addEventListener(\"activate\",event=>{event.waitUntil(self.clients.claim())});\nself.addEventListener(\"message\",event=>{\n  if(!event.data||event.data.type!==\"DEXA_FAILOVER_STATUS_QUERY\")return;\n  const port=event.ports&&event.ports[0];if(!port)return;\n  event.waitUntil((async()=>{\n    const origins=await pool(),current=self.location.origin;\n    if(!origins.includes(current))origins.push(current);\n    port.postMessage({type:\"DEXA_FAILOVER_STATUS\",version:\"DEXA_N_ACCOUNT_RING_V1\",\n      backupReady:origins.length>1,poolSize:origins.length,\n      currentOrigin:current,nextOrigin:origins.length>1?\n      origins[(origins.indexOf(current)+1)%origins.length]:null});\n  })());\n});\nself.addEventListener(\"fetch\",event=>{\n  const req=event.request,url=new URL(req.url);\n  if(url.origin!==self.location.origin||url.pathname===\"/sw.js\"||\n      url.pathname===REGISTRY)return;\n  event.respondWith((async()=>{\n    let response;\n    try{response=await fetch(req)}\n    catch{\n      // DNS or uncertain network failure is NOT evidence of quota exhaustion.\n      // In particular, never replay a possibly committed owner POST.\n      return Response.error();\n    }\n    if(!(await quotaResponse(response)))return response;\n    const hop=hopValue(url),route=await nextInRing(self.location.origin,hop);\n    if(!route.next)return exhausted(route.poolSize);\n    if(req.mode===\"navigate\"&&req.method===\"GET\")\n      return Response.redirect(nextUrl(url,route.next,route.hop,false),302);\n    const client=event.clientId?await self.clients.get(event.clientId):null;\n    if(client){\n      const to=nextUrl(url,route.next,route.hop,true);\n      client.postMessage({type:\"DEXA_QUOTA_FAILOVER\",url:to,\n        switchedFrom:self.location.origin,poolSize:route.poolSize});\n    }\n    // A failed POST never gets retried automatically, even on a new account.\n    return new Response(\"DEXA_QUOTA_FAILOVER_NO_POST_REPLAY\",{\n      status:503,headers:{\"content-type\":\"text/plain; charset=utf-8\",\n        \"cache-control\":\"no-store\"}});\n  })());\n});\n";
const SW_STATUS_SOURCE = "";
const OUTBOUND_HEADERS = ["authorization","cookie","accept","content-type","x-dexa-web-form","x-dexa-submission-id","last-event-id","x-dexa-device-token","x-dexa-owner-token","x-dexa-timestamp","x-dexa-nonce","x-dexa-signature"];
const INBOUND_HEADERS = ["content-type","cache-control","content-securi
...cut...
                 rh.delete("content-length");
                                                                                                                                                                                        return new Response(patched,{status:200,headers:rh});
                                                                                                                                                                                            }
                                                                                                                                                                                                // For HTML only: install the same-origin Service Worker automatically.
    // Clear only the routing hop marker after the page is actually usable,
    // which begins a fresh rotation if another quota error occurs later.
    if(request.method==="GET"&&reply.status===200&&
       (url.pathname==="/dexa-superapp/"||url.pathname==="/dexa-superapp")&&
       String(reply.headers.get("content-type")||"").includes("text/html")){
      const html=await reply.text();
      const clearHop = '(function(){setTimeout(function(){try{'+
        'var u=new URL(location.href);if(u.searchParams.has("__dexa_step")){'+
        'u.searchParams.delete("__dexa_step");'+
        'history.replaceState(history.state,"",u.href);}}catch(_){}'+
        '},7000)})();';
      const scripts="<script>"+INSTALL_SCRIPT+"</script>"+
        "<script>"+clearHop+"</script>";
      const body=html.includes("</body>")?
        html.replace("</body>",scripts+"</body>"):html+scripts;
      rh.delete("content-length");
      return new Response(body,{status:reply.status,headers:rh});
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
                                                                                                                                                                                                                      if(request.method==="OPTIONS" && url.pathname.startsWith("/dexa-superapp/"))
                                                                                        return ownerPreflight(request,url);
                                                                                      if(request.method!=="GET"&&request.method!=="POST")return plain(405,"METHOD_NOT_ALLOWED");
                                                                                                                                                                                                                          if(url.pathname==="/"&&request.method==="GET") {
                                                                                                                                                                                                                                return plain(200,BOOT_HTML.replace("@@INSTALL@@",INSTALL_SCRIPT),"text/html; charset=utf-8");
                                                                                                                                                                                                                                    }
                                                                                                                                                                                                                                        if(url.pathname==="/sw.js"&&request.method==="GET") {
                                                                                                                                                                                                                                              const sw=SW_SOURCE+SW_STATUS_SOURCE;
                                                                                                                                                                                                                                                    const response=plain(200,sw,"text/javascript; charset=utf-8");
                                                                                                                                                                                                                                                          response.headers.set("service-worker-allowed","/");
                                                                                                                                                                                                                                                                response.headers.set("cache-control","no-cache, no-store");
                                                                                                                                                                                                                                                                      return response;
                                                                                                                                                                                                                                                                          }
                                                                                                                                                                                                                                                                              if(url.pathname==="/bridge-pool"&&request.method==="GET"){
    const origins=await activePool();
    if(!origins.includes(url.origin))origins.push(url.origin);
    return Response.json({schema:"dexa.worker-pool.v1",origins},{
      headers:{"cache-control":"public, max-age=120",
        "access-control-allow-origin":"*"}});
  }
  if(url.pathname==="/bridge-health"&&request.method==="GET") {
                                                                                                                                                                                                                                                                                    const origins=await activePool();
    if(!origins.includes(url.origin))origins.push(url.origin);
    return Response.json({ok:true,version:VERSION,
      backupReady:origins.length>1,poolSize:origins.length,currentOrigin:url.origin},
      {headers:{"cache-control":"no-store"}});
                                                                                                                                                                                                                                                                                        }
                                                                                                                                                                                                                                                                                            if(url.pathname.startsWith("/dexa-lite"))return proxy(request,url);
  if(url.pathname.startsWith("/dexa-superapp"))
    return await corsResponse(await proxy(request,url),request,url);
                                                                                                                                                                                                                                                                                                return plain(404,"NOT_FOUND");
                                                                                                                                                                                                                                                                                                  }
                                                                                                                                                                                                                                                                                                  };