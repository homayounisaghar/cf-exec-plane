/**
 * CF Universal Mirror / Stable Gateway v1
 * One stable *.workers.dev hostname, parallel isolated /m/<random-id>/ sessions.
 * Binding MIRROR_VPC must be a VPC HTTP Service scoped ONLY to the loopback
 * broker port 6266 on the authorized CF host. Never bind to CDP/X11 ports.
 *
 * This Worker does not authenticate by itself. All sessions are independently
 * password-protected by their pre-existing mirror gateway; paths are unguessable.
 * Authentication and expiry checks are enforced by each gateway on every request.
 */
export const VERSION='cfm-stable-multisession-v1';
export const DEFAULT_ORIGIN='https://cf-mirror-bridge.mirkazem-design.workers.dev';
const ROUTE=/^\/m\/[a-zA-Z0-9_-]{32}(?:\/.*)?$/;
const PRIVATE='http://mirror-broker.internal:6266';
function result(status,text){return new Response(text,{
 status,headers:{'content-type':'text/plain; charset=utf-8',
   'cache-control':'no-store, private, max-age=0','x-content-type-options':'nosniff',
   'referrer-policy':'no-referrer'}
});}
export default {
 async fetch(req,env){
  const url=new URL(req.url);
  const publicOrigin=env?.PUBLIC_ORIGIN||DEFAULT_ORIGIN;
  if(url.origin!==publicOrigin)return result(421,'Wrong host');
  if(req.method==='GET'&&url.pathname==='/__bridge-health'){
    let private_reachable=false;
    if(env?.MIRROR_VPC){
      try{
        const check=await env.MIRROR_VPC.fetch(PRIVATE+'/__stable-health',{
          method:'GET',signal:AbortSignal.timeout(2500),redirect:'manual'
        });
        private_reachable=check.status===200&&
          (await check.text()).trim()==='CFM_STABLE_GATEWAY_READY_v1';
      }catch{}
    }
    return Response.json({ok:true,version:VERSION,private_binding_ready:!!env?.MIRROR_VPC,
       private_reachable,stable_origin:publicOrigin},{headers:{'cache-control':'no-store'}});
  }
  if(!ROUTE.test(url.pathname))return result(404,'Open the session-specific mirror link');
  if(!['GET','POST','HEAD'].includes(req.method))return result(405,'Method not allowed');
  if(!env?.MIRROR_VPC)return result(503,'Private tunnel binding not configured');
  const endpoint=PRIVATE+url.pathname+url.search;
  const headers=new Headers(req.headers);
  for(const h of ['cf-worker','cf-ew-via','x-forwarded-host','x-forwarded-proto'])headers.delete(h);
  const opts={method:req.method,headers,redirect:'manual'};
  if(req.method==='POST')opts.body=req.body;
  try{
   const up=await env.MIRROR_VPC.fetch(endpoint,opts);
   if(up.status===101&&up.webSocket)return up; // preserves WSS handshake
   const responseHeaders=new Headers(up.headers);
   responseHeaders.set('cache-control','no-store, private, max-age=0');
   responseHeaders.set('x-content-type-options','nosniff');
   responseHeaders.delete('access-control-allow-origin');
   return new Response(req.method==='HEAD'?null:up.body,{
      status:up.status,headers:responseHeaders
   });
  }catch(e){
   return result(502,'Private mirror tunnel temporarily unavailable');
  }
 }
};
