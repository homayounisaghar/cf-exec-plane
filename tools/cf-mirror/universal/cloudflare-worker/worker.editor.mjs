const R="cfm-worker-n-ring-20261115",O="https://raw.githubusercontent.com/homayounisaghar/cf-exec-plane/main/tools/cf-mirror/universal/cloudflare\
-worker/route-pool.json",d="cf-mirror.worker-pool.v1",f="no-store, private, max-age=0, no-transform",m=new Map([["/input-ws","cfm-input"],["/mic-\
ws","cfm-mic"]]),E=["accept","accept-language","cache-control","content-type","cookie","if-modified-since","if-none-match","pragma","range","user\
-agent","x-cf-mirror-csrf"],x=['"use strict";const REGISTRY="/__bridge-pool",CACHE_NAME="cf-mirror-worker-pool-v1",CACHE_KEY="/__cfm_pool_cach','\
ed",HOP_PARAM="__cfm_hop",VERSION="cfm-n-account-ring-v1";function validOrigin(t){try{const e=new URL(t);retur','n e.protocol!=="https:"||e.pathn\
ame!=="/"||e.search||e.hash||e.username||e.password||!/^[a-z0-9-]+\\.[a-z0-9-]+','\\.workers\\.dev$/i.test(e.hostname)?null:e.origin}catch{return n\
ull}}function cleanPool(t){if(!t||t.schema!=="c','f-mirror.worker-pool.v1"||!Array.isArray(t.origins))return null;const e=[...new Set(t.origins.s\
lice(0,32).map(','validOrigin).filter(Boolean))];if(!e.length)return null;const n=/^[0-9a-f]{16}$/.test(t.sourceKey||"")?t.sourc',"eKey:null;retu\
rn{origins:e,sourceKey:n}}async function getPool(){let t;try{t=await caches.open(CACHE_NAME)}cat",'ch{}try{const e=await fetch(REGISTRY,{cache:"n\
o-store"});if(e.ok){const n=await e.text();if(n.length<=8192){co','nst r=cleanPool(JSON.parse(n));if(r){if(t)try{await t.put(CACHE_KEY,new Respon\
se(JSON.stringify({schema:"cf-mi','rror.worker-pool.v1",...r}),{headers:{"content-type":"application/json"}}))}catch{}return r}}}}catch{}if(t)try',
"{const e=await t.match(CACHE_KEY);if(e){const n=cleanPool(await e.json());if(n)return n}}catch{}return{origins",":[self.location.origin],sourceK\
ey:null}}function hopValue(t){const e=Number(t.searchParams.get(HOP_PARAM)||0);","return Number.isSafeInteger(e)&&e>=0?Math.min(e,32):0}async fun\
ction healthy(t,e){try{const n=AbortSignal.time",'out(1800),r=await fetch(t+"/__bridge-health",{mode:"cors",cache:"no-store",signal:n,redirect:"e\
rror",credentia','ls:"omit"});if(!r.ok)return!1;const o=await r.json();return o?.ok===!0&&o?.proxy==="cf-mirror-universal"&&o?.c',"urrentOrigin==\
=t&&(!e||o?.sourceKey===e)}catch{return!1}}async function nextOrigin(t,e){const n=await getPool(","),r=n.origins.slice();r.includes(t)||r.push(t)\
;const o=r.length,i=r.indexOf(t);for(let s=e+1;s<o;s++){const a=","r[(i+s-e)%o];if(a!==t&&await healthy(a,n.sourceKey))return{origin:a,hop:s,coun\
t:o}}return{origin:null,hop:e,co",'unt:o}}function nextUrl(t,e){const n=new URL("/",t);return n.searchParams.set("__cfm_entry","1"),n.searchParam',
"s.set(HOP_PARAM,String(e)),n.href}async function isQuotaResponse(t){if(!t||t.status<400)return!1;const e=(t.he",'aders.get("content-type")||"").\
toLowerCase();if(!/text|html|json/.test(e))return!1;try{const n=(await t.clone(',").text()).slice(0,16e3);return/(?:error\\s*(?:code\\s*)?[:#]?\\s*1\
027|code\\s*1027\\b)/i.test(n)}catch{return!1}}fu",'nction exhausted(t){return new Response("CF_MIRROR_WORKER_POOL_EXHAUSTED: all configured Clou\
dflare accounts w','ere tried once; no mouse, microphone or POST was replayed.",{status:503,headers:{"content-type":"text/plain; c','harset=utf-8\
","cache-control":"no-store","x-cfm-worker-pool-exhausted":String(t)}})}self.addEventListener("ins','tall",t=>{t.waitUntil((async()=>{await self.\
skipWaiting(),await getPool()})())}),self.addEventListener("activa','te",t=>{t.waitUntil(self.clients.claim())}),self.addEventListener("message",\
t=>{if(t.data?.type!=="CFM_POOL_ST','ATUS")return;const e=t.ports?.[0];e&&t.waitUntil((async()=>{const n=await getPool(),r=self.location.origin,o\
=n','.origins.indexOf(r);e.postMessage({type:"CFM_POOL_STATUS",version:VERSION,poolSize:n.origins.length,currentOri',"gin:r,nextOrigin:n.origins.\
length>1?n.origins[(Math.max(0,o)+1)%n.origins.length]:null})})())}),self.addEventL",'istener("fetch",t=>{const e=t.request,n=new URL(e.url);n.or\
igin!==self.location.origin||n.pathname==="/sw.js"|','|n.pathname===REGISTRY||n.pathname==="/__bridge-health"||n.pathname==="/shot.jpg"||n.pathna\
me==="/stream.mjpg"','||n.pathname==="/input-ws"||n.pathname==="/mic-ws"||t.respondWith((async()=>{let r;try{r=await fetch(e)}catch{',"return Res\
ponse.error()}if(!await isQuotaResponse(r))return r;const o=await nextOrigin(self.location.origin,ho",'pValue(n));if(!o.origin)return exhausted(o\
.count);const i=nextUrl(o.origin,o.hop);if(e.method==="GET"&&e.mode=','=="navigate")return Response.redirect(i,302);const s=t.clientId?await self\
.clients.get(t.clientId):null;return',' s&&s.postMessage({type:"CFM_QUOTA_FAILOVER",url:i,notice:"A new mirror login is required on the next acco\
unt.','"}),new Response("CF_MIRROR_QUOTA_FAILOVER_NO_REQUEST_REPLAY",{status:503,headers:{"content-type":"text/plain;',` charset=utf-8","cache-co\
ntrol":"no-store"}})})())});
`].join(""),S=['(function(){"use strict";"serviceWorker"in navigator&&(navigator.serviceWorker.register("/sw.js",{scope:"/",up','dateViaCache:"no\
ne"}).catch(function(){}),navigator.serviceWorker.addEventListener("message",function(e){var r','=e.data;if(!(!r||r.type!=="CFM_QUOTA_FAILOVER"||\
typeof r.url!="string"))try{var t=new URL(r.url);if(t.protocol','!=="https:"||!t.hostname.endsWith(".workers.dev")||t.origin===location.origin||t\
.pathname!=="/")return;locatio','n.replace(t.href)}catch{}})),location.search.indexOf("__cfm_")>=0&&setTimeout(function(){try{var e=new URL(loc',
'ation.href);if(!e.searchParams.has("__cfm_entry")&&!e.searchParams.has("__cfm_hop"))return;e.searchParams.dele','te("__cfm_entry"),e.searchParam\
s.delete("__cfm_hop"),history.replaceState(history.state,"",e.href)}catch{}},8e',`3)})();
`].join("");let u=null,w=0;function l(e,r,n={}){return new Response(r,{status:e,headers:{"content-type":"text/plain; charset=utf-8","cache-contro\
l":f,"x-content-type-options":"nosniff","referrer-policy":"no-referrer",...n}})}function y(e){try{const r=new URL(e);return r.protocol==="https:"&&
r.pathname==="/"&&!r.search&&!r.hash&&!r.username&&!r.password&&!r.port&&/^[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev$/i.test(r.hostname)?r.origin:null}catch{
return null}}function P(e,r){if(!e||e.schema!==d||!Array.isArray(e.origins))return null;const n=[...new Set(e.origins.slice(0,32).map(y).filter(Boolean))];
if(!n.length)return null;n.includes(r)||n.push(r);const t=Number(e.rotationMinutes),o=Number.isInteger(t)&&t>=5&&t<=1440?t:15;return{origins:n,rotationMinutes:o}}
async function _(e){if(u&&Date.now()<w){const r=u.origins.slice();return r.includes(e)||r.push(e),{...u,origins:r}}try{const r=await fetch(O,{headers:{
accept:"application/json"},signal:AbortSignal.timeout(2800),cf:{cacheTtl:300,cacheEverything:!0}});if(r.ok){const n=await r.text();if(n.length<=8192){
const t=P(JSON.parse(n),e);if(t)return u=t,w=Date.now()+3e5,{...t,origins:t.origins.slice()}}}}catch{}if(u){const r=u.origins.slice();return r.includes(
e)||r.push(e),{...u,origins:r}}return{origins:[e],rotationMinutes:15}}function A(e,r){let n;try{n=new URL(e.MIRROR_UPSTREAM||"")}catch{return null}
if(n.protocol!=="https:"||!/^[a-z0-9-]+\.trycloudflare\.com$/i.test(n.hostname)||n.pathname!=="/"||n.search||n.hash||n.port||n.username||n.password)
return null;const t=y(r.origin);if(!t||e.PUBLIC_ORIGIN&&e.PUBLIC_ORIGIN!==t)return null;const o=Number(e.MIRROR_EXPIRES_AT||0);return e.MIRROR_EXPIRES_AT&&
(!Number.isSafeInteger(o)||o<=0)?null:{upstream:n,current:t,expiry:o}}async function g(e){const r=e.upstream.origin+"|"+e.expiry,n=await crypto.subtle.
digest("SHA-256",new TextEncoder().encode(r));return Array.from(new Uint8Array(n).slice(0,8),t=>t.toString(16).padStart(2,"0")).join("")}function v(e,r,n){
const t=e.headers.get("origin"),o=e.headers.get("sec-fetch-site"),a=e.method==="POST",i=t===r.origin;if(!n&&!a)return!0;if(n)return i&&(!o||o==="\
same-origin"||o==="none");if(r.pathname==="/login"){if(i)return o!=="cross-site";if(t&&t!=="null")return!1;let s=!1;try{s=new URL(e.headers.get("\
referer")||"").origin===r.origin}catch{}return o==="same-origin"||s}return!(t&&!i||o&&!["same-origin","none"].includes(o))}function T(e,r,n,t){const o=new Headers;
for(const a of E){const i=e.headers.get(a);i!==null&&o.set(a,i)}if(["/","/index.html","/view/","/view","/login"].includes(t)&&o.set("accept-encod\
ing","identity"),e.headers.has("origin")&&o.set("origin",r.upstream.origin),n){o.set("origin",r.upstream.origin),o.set("upgrade","websocket");const a=e.
headers.get("sec-websocket-protocol");a&&o.set("sec-websocket-protocol",a)}return o}function b(e,r){if(!e)return e;const n="connect-src 'self' "+
r.replace(/^https:/,"wss:")+";";return/(?:^|;\s*)connect-src\s+[^;]*(?:;|$)/i.test(e)?e.replace(/connect-src\s+[^;]*(?:;|$)/i,n):e+"; "+n}function k(e){
const r="<script>"+S+"<\/script>";return/<\/body>/i.test(e)?e.replace(/<\/body>/i,r+"</body>"):e+r}async function I(e,r,n){const t=new Headers(e.
headers);t.set("cache-control",f),t.delete("content-length"),t.delete("transfer-encoding"),t.set("x-content-type-options","nosniff"),t.set("refer\
rer-policy","no-referrer");const o=t.get("content-security-policy");o&&t.set("content-security-policy",b(o,r.current));const a=t.get("location");
if(a)try{const s=new URL(a,r.upstream.origin);s.origin===r.upstream.origin&&t.set("location",r.current+s.pathname+s.search+s.hash)}catch{t.delete(
"location")}if(["/","/index.html","/view/","/view","/login"].includes(n)&&e.status===200&&/^text\/html\b/i.test(t.get("content-type")||"")&&!t.has(
"content-encoding")){const s=await e.text();return s.length<45e4?(t.delete("content-encoding"),new Response(k(s),{status:e.status,statusText:e.statusText,
headers:t})):l(502,"Unexpectedly large mirror HTML")}return new Response(e.body,{status:e.status,statusText:e.statusText,headers:t,encodeBody:"ma\
nual"})}async function M(e){return Response.json({ok:!0,proxy:"cf-mirror-universal",version:R,currentOrigin:e.current,sourceKey:await g(e),expiresAt:e.
expiry||null},{headers:{"cache-control":f,"access-control-allow-origin":"*"}})}async function L(e,r,n){if(e===r.current)return!0;try{const t=await fetch(
e+"/__bridge-health",{signal:AbortSignal.timeout(1700),redirect:"error",headers:{accept:"application/json"}});if(!t.ok)return!1;const o=await t.json();
return o?.ok===!0&&o?.proxy==="cf-mirror-universal"&&o?.currentOrigin===e&&o?.sourceKey===n}catch{return!1}}async function U(e,r,n){const t=await _(
n.current);if(t.origins.length<2)return null;const o=await g(n),a=Math.floor(Date.now()/(t.rotationMinutes*6e4))%t.origins.length;for(let i=0;i<t.
origins.length;i++){const s=t.origins[(a+i)%t.origins.length];if(s===n.current)return null;if(await L(s,n,o)){const c=new URL("/",s);return c.searchParams.
set("__cfm_entry","1"),Response.redirect(c.href,302)}}return null}var C={async fetch(e,r){const n=new URL(e.url);if(r.PUBLIC_ORIGIN&&r.PUBLIC_ORIGIN!==
n.origin)return l(421,"Unexpected Worker hostname");const t=A(r,n);if(!t)return l(503,"Mirror Worker not configured for an active HTTPS source");
if(t.expiry&&Date.now()>=t.expiry)return l(410,"Mirror session expired");if(e.method==="GET"&&n.pathname==="/__bridge-health")return M(t);if(e.method===
"GET"&&n.pathname==="/__bridge-pool"){const c=await _(t.current);return Response.json({schema:d,origins:c.origins,rotationMinutes:c.rotationMinutes,
currentOrigin:t.current,sourceKey:await g(t)},{headers:{"cache-control":f,"access-control-allow-origin":"*"}})}if(e.method==="GET"&&n.pathname===
"/sw.js")return new Response(x,{headers:{"content-type":"text/javascript; charset=utf-8","service-worker-allowed":"/","cache-control":f,"x-conten\
t-type-options":"nosniff"}});const o=e.headers.get("upgrade")?.toLowerCase()==="websocket";if(!["GET","HEAD","POST"].includes(e.method))return l(
405,"Method not allowed");if(o&&(!m.has(n.pathname)||e.method!=="GET"))return l(404,"WebSocket route not found");if(!v(e,n,o))return l(403,"Origi\
n denied");if(o){const c=(e.headers.get("sec-websocket-protocol")||"").split(",").map(p=>p.trim()),h=m.get(n.pathname);if(!c.includes(h)||!c.some(
p=>/^[A-Za-z0-9_-]{43}$/.test(p)))return l(403,"WebSocket control token required");if(!/(?:^|;\s*)cfm_auth=[A-Za-z0-9_-]{24,100}(?:;|$)/.test(e.headers.
get("cookie")||""))return l(401,"Password required")}const a=e.headers.get("cookie")||"";if(!o&&e.method==="GET"&&n.pathname==="/"&&!/(?:^|;\s*)cfm_auth=/.
test(a)&&!n.searchParams.has("__cfm_entry")&&!n.searchParams.has("__cfm_hop")){const c=await U(e,n,t);if(c)return c}const i=new URL(t.upstream.origin);
i.pathname=n.pathname,i.search=n.search,i.searchParams.delete("__cfm_entry"),i.searchParams.delete("__cfm_hop");const s=T(e,t,o,n.pathname);try{if(o){
const h=await fetch(i.href,{headers:s,redirect:"manual"});return h.status===101&&h.webSocket?h:l(502,"Mirror WebSocket backend unavailable")}const c=await fetch(
i.href,{method:e.method,headers:s,body:e.method==="POST"?e.body:void 0,redirect:"manual"});return await I(c,t,n.pathname)}catch{return l(502,"Mir\
ror tunnel unavailable")}}};export{C as default};
