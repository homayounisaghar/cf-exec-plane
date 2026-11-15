/**
 * CF Mirror Universal — N-account Cloudflare Worker bridge.
 *
 * Identical code on every independent Cloudflare account.
 * Account-specific settings are environment variables, never source edits.
 * The owner-managed public GitHub registry adds future Workers without
 * touching existing deployments. Active authenticated voice/mouse sessions
 * stay pinned to one same-origin Worker; new visits rotate by time slot.
 * Service Worker falls forward on verified 1027 quota exhaustion.
 */
const VERSION = 'cfm-worker-n-ring-20261115-originfix1';
const REGISTRY_URL = 'https://raw.githubusercontent.com/homayounisaghar/cf-exec-plane/main/tools/cf-mirror/universal/cloudflare-worker/route-pool.json';
const SCHEMA = 'cf-mirror.worker-pool.v1';
const NO_STORE = 'no-store, private, max-age=0, no-transform';
const WS_PATHS = new Map([['/input-ws','cfm-input'],['/mic-ws','cfm-mic']]);
const FORWARD_HEADERS = [
  'accept','accept-language','cache-control','content-type','cookie',
  'if-modified-since','if-none-match','pragma','range','user-agent',
  'x-cf-mirror-csrf'
];
const SW_SOURCE = __INLINE_SERVICE_WORKER_SOURCE__;
const INSTALL_SCRIPT = __INLINE_SERVICE_WORKER_INSTALL__;
let lastPool = null;
let poolExpiresAt = 0;

function reply(status, body, extra={}) {
  return new Response(body,{status,headers:{
    'content-type':'text/plain; charset=utf-8',
    'cache-control':NO_STORE,
    'x-content-type-options':'nosniff',
    'referrer-policy':'no-referrer',...extra
  }});
}
function validOrigin(raw){
  try{
    const u=new URL(raw);
    return u.protocol==='https:'&&u.pathname==='/'&&!u.search&&!u.hash&&
           !u.username&&!u.password&&!u.port&&
           /^[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev$/i.test(u.hostname)
      ?u.origin:null;
  }catch{return null;}
}
function normalizePool(candidate, current){
  if(!candidate||candidate.schema!==SCHEMA||!Array.isArray(candidate.origins))
    return null;
  const origins=[...new Set(candidate.origins.slice(0,32).map(validOrigin).filter(Boolean))];
  if(!origins.length)return null;
  if(!origins.includes(current))origins.push(current);
  const value=Number(candidate.rotationMinutes);
  const rotationMinutes=Number.isInteger(value)&&value>=5&&value<=1440?value:15;
  return {origins,rotationMinutes};
}
async function activePool(current){
  if(lastPool&&Date.now()<poolExpiresAt){
    const origins=lastPool.origins.slice();
    if(!origins.includes(current))origins.push(current);
    return {...lastPool,origins};
  }
  try{
    const res=await fetch(REGISTRY_URL,{
      headers:{'accept':'application/json'},signal:AbortSignal.timeout(2800),
      cf:{cacheTtl:300,cacheEverything:true}
    });
    if(res.ok){
      const data=await res.text();
      if(data.length<=8192){
        const pool=normalizePool(JSON.parse(data),current);
        if(pool){
          lastPool=pool;poolExpiresAt=Date.now()+300000;
          return {...pool,origins:pool.origins.slice()};
        }
      }
    }
  }catch{}
  if(lastPool){
    const origins=lastPool.origins.slice();
    if(!origins.includes(current))origins.push(current);
    return {...lastPool,origins};
  }
  return {origins:[current],rotationMinutes:15};
}
function configured(env,incoming){
  let upstream;
  try{upstream=new URL(env.MIRROR_UPSTREAM||'')}catch{return null}
  if(upstream.protocol!=='https:'||
     !/^[a-z0-9-]+\.trycloudflare\.com$/i.test(upstream.hostname)||
     upstream.pathname!=='/'||upstream.search||upstream.hash||upstream.port||
     upstream.username||upstream.password)return null;
  const current=validOrigin(incoming.origin);
  if(!current)return null;
  if(env.PUBLIC_ORIGIN&&env.PUBLIC_ORIGIN!==current)return null;
  const expiry=Number(env.MIRROR_EXPIRES_AT||0);
  if(env.MIRROR_EXPIRES_AT&&(!Number.isSafeInteger(expiry)||expiry<=0))return null;
  return {upstream,current,expiry};
}
async function sessionFingerprint(config){
  const raw=config.upstream.origin+'|'+config.expiry;
  const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(raw));
  return Array.from(new Uint8Array(bytes).slice(0,8),x=>x.toString(16).padStart(2,'0')).join('');
}
function validateBrowser(request,incoming,isWs){
  const origin=request.headers.get('origin');
  const site=request.headers.get('sec-fetch-site');
  const isPost=request.method==='POST';
  const sameOrigin=origin===incoming.origin;
  // Read-only GET/HEAD navigations after a 303 POST can carry Origin: null
  // in some Android/WebView browsers. They have no side effects, and the
  // protected mirror gateway still requires its HttpOnly session cookie.
  if(!isWs&&!isPost)return true;
  // The WebSocket must present an exact same-origin browser Origin AND
  // gateway-signed CSRF subprotocol (checked below and at the gateway).
  if(isWs)return sameOrigin&&(!site||site==='same-origin'||site==='none');
  // The password form carries a server-generated hidden CSRF token, which
  // the gateway verifies. Accept legitimate same-origin mobile form POSTs
  // even if Sec-Fetch-Site is reported as "same-site". Some Android
  // WebViews send Origin: null: require positive same-origin fetch metadata
  // or a same-origin Referer before accepting this special case.
  if(incoming.pathname==='/login'){
    if(sameOrigin)return site!=='cross-site';
    if(origin&&origin!=='null')return false;
    let referrerMatches=false;
    try{referrerMatches=new URL(request.headers.get('referer')||'').origin===incoming.origin}
    catch{}
    return site==='same-origin'||referrerMatches;
  }
  // Other mutating actions retain the strict Origin/Fetch-Site boundary;
  // the original gateway independently checks session-scoped HMAC CSRF.
  if(origin&&!sameOrigin)return false;
  if(site&&!['same-origin','none'].includes(site))return false;
  return true;
}
function outboundHeaders(request,config,isWs,pathname){
  const headers=new Headers();
  for(const key of FORWARD_HEADERS){
    const value=request.headers.get(key);
    if(value!==null)headers.set(key,value);
  }
  // Make HTML injection deterministic; leave MJPEG and JPEG content intact.
  if(['/', '/index.html','/view/','/view','/login'].includes(pathname))
    headers.set('accept-encoding','identity');
  if(request.headers.has('origin'))headers.set('origin',config.upstream.origin);
  if(isWs){
    headers.set('origin',config.upstream.origin);
    headers.set('upgrade','websocket');
    const protocols=request.headers.get('sec-websocket-protocol');
    if(protocols)headers.set('sec-websocket-protocol',protocols);
  }
  return headers;
}
function adjustedCsp(csp,current){
  if(!csp)return csp;
  const directive="connect-src 'self' "+current.replace(/^https:/,'wss:')+';';
  return /(?:^|;\s*)connect-src\s+[^;]*(?:;|$)/i.test(csp)
    ?csp.replace(/connect-src\s+[^;]*(?:;|$)/i,directive)
    :csp+'; '+directive;
}
function injectClient(html){
  // The login form and signed CSRF hidden inputs must remain unmodified.
  const script='<script>'+INSTALL_SCRIPT+'</script>';
  return /<\/body>/i.test(html)?html.replace(/<\/body>/i,script+'</body>'):html+script;
}
async function responseForBrowser(response,config,pathname){
  const headers=new Headers(response.headers);
  headers.set('cache-control',NO_STORE);
  headers.delete('content-length');
  headers.delete('transfer-encoding');
  headers.set('x-content-type-options','nosniff');
  headers.set('referrer-policy','no-referrer');
  const csp=headers.get('content-security-policy');
  if(csp)headers.set('content-security-policy',adjustedCsp(csp,config.current));
  const location=headers.get('location');
  if(location){
    try{
      const dest=new URL(location,config.upstream.origin);
      if(dest.origin===config.upstream.origin)
        headers.set('location',config.current+dest.pathname+dest.search+dest.hash);
    }catch{headers.delete('location')}
  }
  const htmlCandidate=['/','/index.html','/view/','/view','/login'].includes(pathname)&&
     response.status===200&&
     /^text\/html\b/i.test(headers.get('content-type')||'')&&
     !headers.has('content-encoding');
  if(htmlCandidate){
    const body=await response.text();
    // Only small login/viewer pages: MJPEG and binary responses NEVER buffer.
    if(body.length<450000){
      headers.delete('content-encoding');
      return new Response(injectClient(body),{
        status:response.status,statusText:response.statusText,headers
      });
    }
    // Do not try to reconstruct an unexpectedly huge HTML response.
    return reply(502,'Unexpectedly large mirror HTML');
  }
  return new Response(response.body,{
    status:response.status,statusText:response.statusText,headers,encodeBody:'manual'
  });
}
async function health(config) {
  return Response.json({
    ok:true,proxy:'cf-mirror-universal',version:VERSION,
    currentOrigin:config.current,sourceKey:await sessionFingerprint(config),
    expiresAt:config.expiry||null
  },{headers:{'cache-control':NO_STORE,'access-control-allow-origin':'*'}});
}
async function healthyCandidate(candidate,config,key){
  if(candidate===config.current)return true;
  try{
    const resp=await fetch(candidate+'/__bridge-health',{
      signal:AbortSignal.timeout(1700),redirect:'error',
      headers:{accept:'application/json'}
    });
    if(!resp.ok)return false;
    const j=await resp.json();
    return j?.ok===true&&j?.proxy==='cf-mirror-universal'&&
           j?.currentOrigin===candidate&&j?.sourceKey===key;
  }catch{return false}
}
async function initialRotation(request,incoming,config){
  const pool=await activePool(config.current);
  if(pool.origins.length<2)return null;
  const sourceKey=await sessionFingerprint(config);
  const chosen=Math.floor(Date.now()/(pool.rotationMinutes*60000))%pool.origins.length;
  // No bias to a fixed primary account; cycle on new login/session entry.
  // Verify the target is healthy, currently assigned to the SAME mirror.
  for(let i=0;i<pool.origins.length;i++){
    const candidate=pool.origins[(chosen+i)%pool.origins.length];
    if(candidate===config.current)return null;
    if(await healthyCandidate(candidate,config,sourceKey)){
      const target=new URL('/',candidate);
      target.searchParams.set('__cfm_entry','1');
      return Response.redirect(target.href,302);
    }
  }
  return null;
}
export default {
  async fetch(request,env){
    const incoming=new URL(request.url);
    if(env.PUBLIC_ORIGIN&&env.PUBLIC_ORIGIN!==incoming.origin)
      return reply(421,'Unexpected Worker hostname');
    const config=configured(env,incoming);
    if(!config)return reply(503,'Mirror Worker not configured for an active HTTPS source');
    if(config.expiry&&Date.now()>=config.expiry)return reply(410,'Mirror session expired');
    if(request.method==='GET'&&incoming.pathname==='/__bridge-health')
      return health(config);
    if(request.method==='GET'&&incoming.pathname==='/__bridge-pool'){
      const pool=await activePool(config.current);
      return Response.json({
        schema:SCHEMA,origins:pool.origins,rotationMinutes:pool.rotationMinutes,
        currentOrigin:config.current,sourceKey:await sessionFingerprint(config)
      },{headers:{'cache-control':NO_STORE,'access-control-allow-origin':'*'}});
    }
    if(request.method==='GET'&&incoming.pathname==='/sw.js'){
      return new Response(SW_SOURCE,{headers:{
        'content-type':'text/javascript; charset=utf-8',
        'service-worker-allowed':'/','cache-control':NO_STORE,
        'x-content-type-options':'nosniff'
      }});
    }
    const isWs=request.headers.get('upgrade')?.toLowerCase()==='websocket';
    if(!['GET','HEAD','POST'].includes(request.method))return reply(405,'Method not allowed');
    if(isWs&&(!WS_PATHS.has(incoming.pathname)||request.method!=='GET'))
      return reply(404,'WebSocket route not found');
    if(!validateBrowser(request,incoming,isWs))return reply(403,'Origin denied');
    if(isWs){
      const offered=(request.headers.get('sec-websocket-protocol')||'').split(',')
          .map(x=>x.trim());
      const protocol=WS_PATHS.get(incoming.pathname);
      if(!offered.includes(protocol)||!offered.some(x=>/^[A-Za-z0-9_-]{43}$/.test(x)))
        return reply(403,'WebSocket control token required');
      if(!/(?:^|;\s*)cfm_auth=[A-Za-z0-9_-]{24,100}(?:;|$)/.test(
            request.headers.get('cookie')||''))
        return reply(401,'Password required');
    }
    // Never rotate authenticated cookies, POSTs, streams or WebSockets.
    const cookie=request.headers.get('cookie')||'';
    if(!isWs&&request.method==='GET'&&incoming.pathname==='/'&&
        !/(?:^|;\s*)cfm_auth=/.test(cookie)&&
        !incoming.searchParams.has('__cfm_entry')&&
        !incoming.searchParams.has('__cfm_hop')){
      const redirect=await initialRotation(request,incoming,config);
      if(redirect)return redirect;
    }
    const target=new URL(config.upstream.origin);
    target.pathname=incoming.pathname;
    target.search=incoming.search;
    // The routing marker is client-only and must never influence gateway auth.
    target.searchParams.delete('__cfm_entry');
    target.searchParams.delete('__cfm_hop');
    const headers=outboundHeaders(request,config,isWs,incoming.pathname);
    try{
      if(isWs){
        const upstream=await fetch(target.href,{headers,redirect:'manual'});
        if(upstream.status===101&&upstream.webSocket)return upstream;
        return reply(502,'Mirror WebSocket backend unavailable');
      }
      const upstream=await fetch(target.href,{
        method:request.method,headers,
        body:request.method==='POST'?request.body:undefined,redirect:'manual'
      });
      return await responseForBrowser(upstream,config,incoming.pathname);
    }catch{
      return reply(502,'Mirror tunnel unavailable');
    }
  }
};
