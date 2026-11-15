/* CF Mirror Universal N-account Service Worker.
 * Identical on every independent Cloudflare account. Never forwards private
 * credentials cross-origin; navigating to a backup requires fresh login.
 * WebSocket and microphone traffic remain pinned to the selected origin.
 */
"use strict";
const REGISTRY="/__bridge-pool";
const CACHE_NAME="cf-mirror-worker-pool-v1";
const CACHE_KEY="/__cfm_pool_cached";
const HOP_PARAM="__cfm_hop";
const VERSION="cfm-n-account-ring-v1";
function validOrigin(raw){
  try{
    const u=new URL(raw);
    if(u.protocol!=="https:"||u.pathname!=="/"||u.search||u.hash||u.username||u.password||
       !/^[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev$/i.test(u.hostname))return null;
    return u.origin;
  }catch{return null;}
}
function cleanPool(raw){
  if(!raw||raw.schema!=="cf-mirror.worker-pool.v1"||!Array.isArray(raw.origins))
    return null;
  const origins=[...new Set(raw.origins.slice(0,32).map(validOrigin).filter(Boolean))];
  if(!origins.length)return null;
  const sourceKey=/^[0-9a-f]{16}$/.test(raw.sourceKey||"")?raw.sourceKey:null;
  return {origins,sourceKey};
}
async function getPool(){
  let storage;
  try{storage=await caches.open(CACHE_NAME)}catch{}
  try{
    const response=await fetch(REGISTRY,{cache:"no-store"});
    if(response.ok){
      const txt=await response.text();
      if(txt.length<=8192){
        const info=cleanPool(JSON.parse(txt));
        if(info){
          if(storage)try{await storage.put(CACHE_KEY,
             new Response(JSON.stringify({schema:"cf-mirror.worker-pool.v1",...info}),
             {headers:{"content-type":"application/json"}}))}catch{}
          return info;
        }
      }
    }
  }catch{}
  if(storage)try{
    const previous=await storage.match(CACHE_KEY);
    if(previous){const info=cleanPool(await previous.json());if(info)return info;}
  }catch{}
  return {origins:[self.location.origin],sourceKey:null};
}
function hopValue(url){
  const n=Number(url.searchParams.get(HOP_PARAM)||0);
  return Number.isSafeInteger(n)&&n>=0?Math.min(n,32):0;
}
async function healthy(origin,sourceKey){
  try{
    const timeout=AbortSignal.timeout(1800);
    const res=await fetch(origin+"/__bridge-health",
       {mode:"cors",cache:"no-store",signal:timeout,redirect:"error",credentials:"omit"});
    if(!res.ok)return false;
    const data=await res.json();
    return data?.ok===true&&data?.proxy==="cf-mirror-universal"&&
           data?.currentOrigin===origin&&
           (!sourceKey||data?.sourceKey===sourceKey);
  }catch{return false;}
}
async function nextOrigin(current,hop){
  const pool=await getPool();
  const origins=pool.origins.slice();
  if(!origins.includes(current))origins.push(current);
  const n=origins.length, at=origins.indexOf(current);
  // Every account is considered once; never bounce indefinitely.
  for(let step=hop+1;step<n;step++){
    const origin=origins[(at+step-hop)%n];
    if(origin===current)continue;
    if(await healthy(origin,pool.sourceKey))
      return {origin,hop:step,count:n};
  }
  return {origin:null,hop,count:n};
}
function nextUrl(next,hop){
  const out=new URL("/",next);
  out.searchParams.set("__cfm_entry","1");
  out.searchParams.set(HOP_PARAM,String(hop));
  return out.href;
}
async function isQuotaResponse(r){
  if(!r||r.status<400)return false;
  const type=(r.headers.get("content-type")||"").toLowerCase();
  if(!/text|html|json/.test(type))return false;
  try{
    const txt=(await r.clone().text()).slice(0,16000);
    return /(?:error\s*(?:code\s*)?[:#]?\s*1027|code\s*1027\b)/i.test(txt);
  }catch{return false;}
}
function exhausted(count){
  return new Response(
    "CF_MIRROR_WORKER_POOL_EXHAUSTED: all configured Cloudflare accounts were tried once; no mouse, microphone or POST was replayed.",
    {status:503,headers:{"content-type":"text/plain; charset=utf-8",
      "cache-control":"no-store","x-cfm-worker-pool-exhausted":String(count)}}
  );
}
self.addEventListener("install",event=>{
  event.waitUntil((async()=>{await self.skipWaiting();await getPool()})());
});
self.addEventListener("activate",event=>{event.waitUntil(self.clients.claim())});
self.addEventListener("message",event=>{
  if(event.data?.type!=="CFM_POOL_STATUS")return;
  const port=event.ports?.[0];if(!port)return;
  event.waitUntil((async()=>{
    const pool=await getPool();const cur=self.location.origin;
    const at=pool.origins.indexOf(cur);
    port.postMessage({type:"CFM_POOL_STATUS",version:VERSION,poolSize:pool.origins.length,
      currentOrigin:cur,nextOrigin:pool.origins.length>1?
      pool.origins[(Math.max(0,at)+1)%pool.origins.length]:null});
  })());
});
self.addEventListener("fetch",event=>{
  const req=event.request, url=new URL(req.url);
  if(url.origin!==self.location.origin||url.pathname==="/sw.js"||
     url.pathname===REGISTRY||url.pathname==="/__bridge-health"||
     url.pathname==="/shot.jpg"||url.pathname==="/stream.mjpg"||
     url.pathname==="/input-ws"||url.pathname==="/mic-ws")return;
  event.respondWith((async()=>{
    let r;
    try{r=await fetch(req)}catch{return Response.error()}
    if(!(await isQuotaResponse(r)))return r;
    const next=await nextOrigin(self.location.origin,hopValue(url));
    if(!next.origin)return exhausted(next.count);
    const urlNext=nextUrl(next.origin,next.hop);
    if(req.method==="GET"&&req.mode==="navigate"){
      return Response.redirect(urlNext,302);
    }
    const client=event.clientId?await self.clients.get(event.clientId):null;
    if(client)client.postMessage({type:"CFM_QUOTA_FAILOVER",url:urlNext,
       notice:"A new mirror login is required on the next account."});
    // POSTs and active microphone frames are never retried on another account.
    return new Response("CF_MIRROR_QUOTA_FAILOVER_NO_REQUEST_REPLAY",
       {status:503,headers:{"content-type":"text/plain; charset=utf-8",
         "cache-control":"no-store"}});
  })());
});
