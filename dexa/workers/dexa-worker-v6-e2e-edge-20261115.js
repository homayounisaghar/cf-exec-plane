const VERSION = "DEXA_CLOUDFLARE_BRIDGE_V6_E2E_EDGE_20261115";
const UPSTREAM_ORIGIN = "https://cf-onshape.duckdns.org";
// Optional, nonblocking metadata-only edge trace. The same owner bearer is
// checked at the server; no token or body is logged. When the upstream is
// unreachable, console is the sole independent Cloudflare-side evidence.
const E2E_EDGE_VERSION='dexa.edge-trace.v1';
const E2E_ID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function e2eBeacon(request,url,ctx,phase,status,elapsedMs,errorCode='NONE'){
 if(!url.pathname.endsWith('/api/dexa/execute')||request.method!=='POST')return;
 const requestId=url.searchParams.get('trace');
 const bearer=request.headers.get('x-dexa-owner-token');
 if(!E2E_ID.test(requestId||'')||!/^[a-f0-9]{64}$/.test(bearer||''))return;
 const cfRay=request.headers.get('cf-ray')||'UNKNOWN';
 const safeRay=/^[a-f0-9]{12,20}-[A-Z]{3}$/.test(cfRay)?cfRay:'UNKNOWN';
 const payload={requestId,phase,route:'execute',workerHost:url.hostname,
   cfRay:safeRay,httpStatus:status===null?null:status,
   elapsedMs:Math.min(600000,Math.max(0,Math.round(elapsedMs))),errorCode};
 try{console.log('DEXA_E2E_EDGE '+JSON.stringify(payload));}catch{}
 // Important: waitUntil schedules the secondary receipt but NEVER delays or
 // changes the owner's original POST / origin response, and never resends it.
 try{ctx?.waitUntil?.(fetch(UPSTREAM_ORIGIN+'/dexa-superapp/api/dexa/edge-receipt',{
   method:'POST',headers:{'content-type':'application/json',
     'x-dexa-owner-token':bearer,'origin':UPSTREAM_ORIGIN,
     'sec-fetch-site':'same-origin'},body:JSON.stringify(payload),
   redirect:'manual'}).catch(()=>{}));}catch{}
}

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
const INBOUND_HEADERS = ["content-type","cache-control","content-security-policy","set-cookie","www-authenticate","referrer-policy","x-content-type-options","x-frame-options","permissions-policy"];

// DEXA 2026-11-15: retain existing Pocket/SW proxy while exposing the exact
// authenticated owner API routes on every account in the owner-controlled dynamic route registry.

const CORS_HEADERS = [
  "Accept", "Content-Type", "Authorization", "X-Dexa-Owner-Token",
  "X-Dexa-Device-Token", "X-Dexa-Timestamp", "X-Dexa-Nonce",
  "X-Dexa-Signature", "X-Dexa-Web-Form", "X-Dexa-Submission-Id",
  "Last-Event-ID"
].join(", ");
const OWNER_EXTRA_STATIC_GET = new Set([
  "/dexa-superapp/dexa-ui-observation.js",
  "/dexa-superapp/journey-review",
  "/dexa-superapp/journey-review.html",
  "/dexa-superapp/journey-review/cards.json"
]);
const OWNER_EXTRA_DEXA_GET = new Set([
  "cleanup/pending", "speech-dictionary", "planner-evidence",
  "turn-trace", "ui-observation"
]);
const OWNER_EXTRA_DEXA_POST = new Set([
  "speech-dictionary", "speech-preview", "turn-trace", "ui-observation"
]);
async function verifiedBrowserOrigin(request,url) {
  const origin=request.headers.get("origin");
  if(!origin)return null;
  if(origin===url.origin||origin===UPSTREAM_ORIGIN||
      SEED_ROUTE_POOL.includes(origin))return origin;
  // New Cloudflare accounts join the trusted browser origin set when they
  // appear in the owner-maintained route manifest. Never trust arbitrary
  // Internet domains, even if they have an owner token-shaped header.
  try{
    const check=new URL(origin);
    if(check.protocol!=="https:"||!check.hostname.endsWith(".workers.dev")||
       check.origin!==origin)return null;
    return (await activePool()).includes(origin)?origin:null;
  }catch{return null;}
}
async function crossOwnerPost(request, url) {
  const origin = await verifiedBrowserOrigin(request,url);
  if (!origin) return false;
  const sec = request.headers.get("sec-fetch-site");
  if (origin === url.origin)
    return !sec || sec === "same-origin" || sec === "none";
  return !sec || ["cross-site", "same-site", "same-origin", "none"].includes(sec);
}
async function corsResponse(response, request, url) {
  const origin = await verifiedBrowserOrigin(request,url);
  if (!origin || !url.pathname.startsWith("/dexa-superapp/"))
    return response;
  const headers = new Headers(response.headers);
  headers.set("access-control-allow-origin", origin);
  headers.append("vary", "Origin");
  return new Response(response.body, {
    status: response.status, statusText: response.statusText, headers
  });
}
async function ownerPreflight(request, url) {
  const origin = await verifiedBrowserOrigin(request,url);
  const method = request.headers.get("access-control-request-method");
  if (!origin) return plain(403, "ORIGIN_DENIED");
  if (!method || !["GET", "POST"].includes(method) ||
      !allowed(url.pathname, method))
    return plain(404, "NOT_ALLOWED");
  const requestedHeaders = String(
    request.headers.get("access-control-request-headers") || ""
  ).split(",").map(h => h.trim().toLowerCase()).filter(Boolean);
  const knownHeaders = new Set(CORS_HEADERS.toLowerCase().split(", "));
  if (requestedHeaders.some(h => !knownHeaders.has(h)))
    return plain(403, "CORS_HEADER_NOT_ALLOWED");
  return new Response(null, {
    status: 204,
    headers: {
      "access-control-allow-origin": origin,
      "access-control-allow-methods": "GET, POST, OPTIONS",
      "access-control-allow-headers": CORS_HEADERS,
      "access-control-max-age": "300",
      "cache-control": "no-store",
      "vary": "Origin, Access-Control-Request-Method, Access-Control-Request-Headers"
    }
  });
}

function plain(code,text,type="text/plain; charset=utf-8") {
  return new Response(text,{status:code,headers:{"content-type":type,"cache-control":"no-store","x-content-type-options":"nosniff","referrer-policy":"no-referrer"}});
  }
// Only the explicitly shipped, same-origin Pocket 0.1.7 assets.
// This adds static GET reads ONLY. No API/auth/proxy/POST policy changes.
const POCKET_STATIC_GET_PATHS = new Set([
  "/dexa-superapp/voice-interactions.js", 
  "/dexa-superapp/persian-tts.js", 
  "/dexa-superapp/persian-tts/worker.js", 
  "/dexa-superapp/persian-tts/text.js", 
  "/dexa-superapp/persian-tts/natural_chunker.mjs", 
  "/dexa-superapp/persian-tts/longest_chunker.mjs", 
  "/dexa-superapp/persian-tts/prosody_chunker.mjs", 
  "/dexa-superapp/persian-tts/pause_settings.mjs", 
  "/dexa-superapp/persian-tts/chunk_diagnostics.mjs", 
  "/dexa-superapp/persian-tts/vendor/ort.webgpu.min.mjs", 
  "/dexa-superapp/persian-tts/vendor/ort-wasm-simd-threaded.mjs", 
  "/dexa-superapp/persian-tts/vendor/ort-wasm-simd-threaded.wasm", 
  "/dexa-superapp/persian-tts/vendor/ort-wasm-simd-threaded.jsep.mjs", 
  "/dexa-superapp/persian-tts/vendor/ort-wasm-simd-threaded.jsep.wasm", 
  "/dexa-superapp/persian-tts/vendor/ort-wasm-simd-threaded.asyncify.mjs", 
  "/dexa-superapp/persian-tts/vendor/ort-wasm-simd-threaded.asyncify.wasm", 
]);
  function allowed(path,method) {
    if(method==="GET" && (POCKET_STATIC_GET_PATHS.has(path) ||
      OWNER_EXTRA_STATIC_GET.has(path) ||
      /^\/dexa-superapp\/android-v(?:1[7-9]|2[0-9]|3[0-6])\.apk$/.test(path)))
      return true;
    if(path==="/dexa-superapp/" || path==="/dexa-superapp")return method==="GET";
    if(/^\/dexa-superapp\/(?:theme\.css|theme-client\.js|auto-handoff\.js|remote-client\.js|cycle-panel\.js|toolbar)$/.test(path))return method==="GET";
    if(["/dexa-superapp/api/health","/dexa-superapp/api/config","/dexa-superapp/api/telemetry/summary"].includes(path))return method==="GET";
    if(path==="/dexa-superapp/api/telemetry")return method==="POST";
    // Owner-paired Rana APIs are exact-route proxied under the same trusted
    // Cloudflare origin. No alternate direct Hetzner fetch is needed.
    if(path.startsWith("/dexa-superapp/api/dexa/")){
      const route=path.slice("/dexa-superapp/api/dexa/".length);
      // Native Android kernel owner API v32+; this is a narrow route
      // allowlist. The upstream still enforces owner token + exact-origin
      // checks; no Worker ever grants owner trust or signs a device receipt.
      const androidGet=new Set(["android/inventory","android/status"]);
      const androidPost=new Set(["android/trust","android/submit"]);
      if(method==="GET"&&androidGet.has(route))return true;
      if(method==="POST"&&androidPost.has(route))return true;
      if(method==="GET" && OWNER_EXTRA_DEXA_GET.has(route))return true;
      if(method==="POST" && OWNER_EXTRA_DEXA_POST.has(route))return true;
      const get=new Set(["pair/status","status","result","improvements","delivery",
        "catalog/reference","catalog/status","timing","causal-report","cleanup","history",
        "improvements/export","cleanup/pending"]);
      const post=new Set(["pair","pair/invite","catalog/sync","execute",
        "improvements","delivery","turns","timing","cleanup","delivery/observe"]);
      return method==="GET"?get.has(route):method==="POST"&&post.has(route);
    }
    if(path==="/dexa-superapp/tickets-panel.js"||
       path==="/dexa-superapp/tickets"||
       path==="/dexa-superapp/android-v19.apk")return method==="GET";
    if(["/dexa-superapp/api/remote/device/next",
        "/dexa-superapp/api/remote/device/android-next"].includes(path))
      return method==="GET";
    if(["/dexa-superapp/api/remote/device/register",
        "/dexa-superapp/api/remote/device/disable",
        "/dexa-superapp/api/remote/device/report",
        "/dexa-superapp/api/remote/device/android-inventory",
        "/dexa-superapp/api/remote/device/android-report"].includes(path))
      return method==="POST";
    if(path==="/dexa-superapp/api/remote/admin/devices"||path==="/dexa-superapp/api/remote/admin/runs")return method==="GET";
    if(path==="/dexa-superapp/api/remote/admin/submit")return method==="POST";
    if(path==="/dexa-lite/"||path==="/dexa-lite")return method==="GET";
      if(path==="/dexa-lite/check"||path==="/dexa-lite/healthz")return method==="GET";
        if(["/api/planner/ready","/api/runtime/preflight","/api/form/challenge","/api/missions/live"].some(p=>path==="/dexa-lite"+p))return method==="GET";
          if(path==="/dexa-lite/api/missions")return method==="GET"||method==="POST";
            if(/^\/dexa-lite\/api\/missions\/[0-9a-f-]{36}(?:\/(?:status|live))?$/i.test(path))return method==="GET";
              if(/^\/dexa-lite\/api\/missions\/[0-9a-f-]{36}\/(?:control|followup)$/i.test(path))return method==="POST";
                return false;
                }
                async function sameOriginPost(request,url) {
                  return await crossOwnerPost(request,url);
                      }
                      async function proxy(request,url,ctx) {
                        if(!allowed(url.pathname,request.method))return plain(404,"NOT_ALLOWED");
                            if(request.method==="POST"&&!(await sameOriginPost(request,url))&&url.pathname!=="/dexa-superapp/api/telemetry"&&url.pathname!=="/dexa-superapp/api/remote/admin/submit")return plain(403,"ORIGIN_DENIED");
                            if(url.pathname.startsWith("/dexa-superapp/api/dexa/")){
  const route=url.pathname.slice("/dexa-superapp/api/dexa/".length);
  // Only device pairing is public. All private Rana data requires an
  // owner token even before the upstream's independent cryptographic check.
  if(!["pair","pair/status","pair/invite"].includes(route)&&
     !/^[a-f0-9]{64}$/.test(request.headers.get("x-dexa-owner-token")||""))
    return plain(401,"OWNER_TOKEN_REQUIRED");
}

                            const e2eStarted=Date.now();
                            e2eBeacon(request,url,ctx,'EDGE_REQUEST_RECEIVED',null,0);
                            const upstreamUrl=new URL(url.pathname+url.search,UPSTREAM_ORIGIN);
                              const forwarded=new Headers();
                                for(const key of OUTBOUND_HEADERS) {
                                    const value=request.headers.get(key);
                                        if(value!==null)forwarded.set(key,value);
                                          }
                                            if(request.method==="POST") {
                                                // The owner's browser origin was checked above. Rebind to the verified upstream
                                                    // to the existing localhost-only gateway's original CSRF policy.
                                                        forwarded.set("origin",UPSTREAM_ORIGIN);
                                                            forwarded.set("sec-fetch-site","same-origin");
                                                              }
                                                                try {
                                                                    const options={method:request.method,headers:forwarded,redirect:"manual",signal:request.signal};
                                                                        if(request.method==="POST"){options.body=request.body;options.duplex="half";}
                                                                            const reply=await fetch(upstreamUrl.href,options);
                                                                            e2eBeacon(request,url,ctx,'EDGE_ORIGIN_RESPONSE',reply.status,Date.now()-e2eStarted);
                                                                                const rh=new Headers({"cache-control":"no-store","x-dexa-bridge":VERSION});
                                                                                if(url.pathname.endsWith('/api/dexa/execute')){
                                                                                  rh.set('x-dexa-edge-version',E2E_EDGE_VERSION);
                                                                                  rh.set('x-dexa-edge-ray',request.headers.get('cf-ray')||'UNKNOWN');
                                                                                }
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
                                                                                                                                                                                                          e2eBeacon(request,url,ctx,'EDGE_ORIGIN_FETCH_EXCEPTION',null,Date.now()-e2eStarted,'UPSTREAM_FETCH_THROWN');
                                                                                                                                                                                                          return plain(502,"UPSTREAM_UNAVAILABLE");
                                                                                                                                                                                                            }
                                                                                                                                                                                                            }
                                                                                                                                                                                                            export default {
                                                                                                                                                                                                              async fetch(request,env,ctx) {
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
                                                                                                                                                                                                                                                                                            if(url.pathname.startsWith("/dexa-lite"))return proxy(request,url,ctx);
  if(url.pathname.startsWith("/dexa-superapp"))
    return await corsResponse(await proxy(request,url,ctx),request,url);
                                                                                                                                                                                                                                                                                                return plain(404,"NOT_FOUND");
                                                                                                                                                                                                                                                                                                  }
                                                                                                                                                                                                                                                                                                  };