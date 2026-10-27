// Dexa Stage 5. One bounded read-only public web capability family.
// Not a CF-server tool, not a planner/second model, and never a credentialed
// browser. Search uses the credentialed official Serper.dev API; up to
// two independently configured keys are attempted in order, never parallel.
// The URL reader pins a DNS-validated public IP for every HTTPS hop.
import {lookup as dnsLookup} from "node:dns/promises";
import fs from "node:fs";
import path from "node:path";
import https from "node:https";
import net from "node:net";
import {createHash,randomUUID} from "node:crypto";

export const DEXA_WEB_SEARCH_ID="web.search";
export const DEXA_WEB_READ_ID="web.read";
export const DEXA_WEB_SEARCH_ROUTE="dexa_web_search";
export const DEXA_WEB_READ_ROUTE="dexa_web_read";
export const DEXA_WEB_SCHEMA="dexa.web-source.v1";
const MAX_REDIRECTS=2,MAX_WIRE=180000,MAX_TEXT=24000,MAX_RESULT=5;
const MAX_TIMEOUT_MS=9000;
const SERPER_ENDPOINT="https://google.serper.dev/search";
const BRAVE_ENDPOINT="https://api.search.brave.com/res/v1/web/search";
// One owner-operated Node service: a simple per-invocation rotation is
// sufficient. Concurrent calls each reserve their slot before awaiting I/O.
let nextSerperKeySlot=0;
export function selectSerperKeyOrder(keys){
 if(!Array.isArray(keys)||!keys.length||keys.length>2)
  throw err("DEXA_WEB_SERPER_KEYS_INVALID");
 const offset=nextSerperKeySlot%keys.length;
 nextSerperKeySlot=(nextSerperKeySlot+1)%2;
 return keys.slice(offset).concat(keys.slice(0,offset));
}
const SECRET_DIR="/home/cfserver/.local/share/dexa-core-service-20261023";
const err=code=>Object.assign(new Error(code),{code});
const digest=x=>createHash("sha256").update(x).digest("hex");
const hostnameDenied=host=>{
 const value=String(host||"").toLowerCase().replace(/\.$/,"");
 return !value||value.length>240||!value.includes(".")||
  net.isIP(value)!==0||/(?:^|\.)(?:localhost|local|internal|lan|test|invalid|example|onion)$/.test(value)||
  value==="metadata.google.internal"||!(/^[a-z0-9.-]+$/.test(value));
};
export const DEXA_WEB_SEARCH_INPUT_SCHEMA=Object.freeze({
 type:"object",additionalProperties:false,required:["query"],
 properties:{
  query:{type:"string",minLength:3,maxLength:180},
  maxResults:{type:"integer",minimum:1,maximum:5}
 }
});
export const DEXA_WEB_READ_INPUT_SCHEMA=Object.freeze({
 type:"object",additionalProperties:false,required:["url"],
 properties:{
  url:{type:"string",minLength:12,maxLength:1400}
 }
});
function asIPv4(addr){
 const parts=addr.split(".").map(Number);
 if(parts.length!==4||parts.some(x=>!Number.isInteger(x)||x<0||x>255))
  return null;
 return parts;
}
export function isPublicIp(address){
 if(net.isIP(address)===4){
  const [a,b,c]=asIPv4(address)||[];
  if(a===undefined)return false;
  // IANA special/non-routable, multicast, benchmarking and documentation.
  if(a===0||a===10||a===127||a>=224||
    (a===100&&b>=64&&b<=127)||
    (a===169&&b===254)||
    (a===172&&b>=16&&b<=31)||
    (a===192&&(b===168||b===0||b===88&&c===99))||
    (a===198&&(b===18||b===19||b===51&&c===100))||
    (a===203&&b===0&&c===113))return false;
  return true;
 }
 if(net.isIP(address)!==6)return false;
 const ip=address.toLowerCase();
 // Conservatively allow only globally routed 2000::/3, never IPv4-mapped,
 // ULA, link local, documentation, Teredo or 6to4 tunneling.
 const first=parseInt(ip.split(":")[0],16);
 if(!Number.isInteger(first)||first<0x2000||first>0x3fff)return false;
 if(/^2001:0*db8(?::|$)/.test(ip)||/^2002(?::|$)/.test(ip)||
    /^2001:0{1,4}(?::|$)/.test(ip)||ip.includes("."))return false;
 return true;
}
export function verifiedPublicHttpsUrl(input){
 let url;
 try{url=new URL(input)}catch{throw err("DEXA_WEB_URL_INVALID")}
 if(url.protocol!=="https:"||url.username||url.password||
    (url.port&&url.port!=="443")||url.hash||url.href.length>1600||
    hostnameDenied(url.hostname)||url.pathname.length>1200||
    url.search.length>900)
  throw err("DEXA_WEB_URL_NOT_ALLOWED");
 return url;
}
const htmlDecode=x=>String(x||"").replace(/&(amp|lt|gt|quot|apos|nbsp|#\d+|#x[0-9a-f]+);/gi,(_,e)=>{
 const named={amp:"&",lt:"<",gt:">",quot:'"',apos:"'",nbsp:" "};
 if(named[e.toLowerCase()])return named[e.toLowerCase()];
 const n=e.slice(1).toLowerCase().startsWith("x")?
  parseInt(e.slice(2),16):parseInt(e.slice(1),10);
 return Number.isSafeInteger(n)&&n>31&&n<0x110000?String.fromCodePoint(n):"";
});
const removeMarkup=x=>htmlDecode(String(x||"")
 .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g,"$1")
 .replace(/<[^>]*>/g," ").replace(/\s+/g," ").trim());
export function readSerperKeySlots({dir=SECRET_DIR}={}){
 const found=[];
 for(const slot of [1,2]){
  const name=slot===1?"serper-api.env":"serper-api-2.env";
  const nameKey=slot===1?"SERPER_API_KEY":"SERPER_API_KEY_2";
  const file=path.join(dir,name);
  let stat;
  try{stat=fs.lstatSync(file)}catch(error){
   if(error?.code==="ENOENT")continue;
   throw err("DEXA_WEB_SERPER_SECRET_UNAVAILABLE");
  }
  if(!stat.isFile()||(stat.mode&0o077)!==0||stat.size<18||
     stat.size>400||typeof process.getuid==="function"&&
     stat.uid!==process.getuid())
   throw err("DEXA_WEB_SERPER_SECRET_PERMISSIONS");
  let contents;
  try{contents=fs.readFileSync(file,"utf8")}catch{
   throw err("DEXA_WEB_SERPER_SECRET_UNAVAILABLE");
  }
  const match=contents.match(new RegExp("^"+nameKey+"=([^\\r\\n]{8,350})\\r?\\n?$"));
  if(!match||/[\x00-\x20\x7f]/.test(match[1]))
   throw err("DEXA_WEB_SERPER_SECRET_INVALID");
  if(found.some(existing=>existing.key===match[1]))
   throw err("DEXA_WEB_SERPER_DUPLICATE_KEYS");
  found.push({slot,key:match[1]});
 }
 if(found.length===0)throw err("DEXA_WEB_SERPER_KEY_NOT_CONFIGURED");
 return found;
}
function onlyKnownAbsolutePublicationDate(date){
 if(typeof date!=="string"||date.length>80)return null;
 // Relative dates ("2 hours ago") have no durable publication timestamp.
 if(!/\b20\d\d\b/.test(date))return null;
 const d=Date.parse(date);
 return Number.isFinite(d)&&d<=Date.now()+86400000?
  new Date(d).toISOString():null;
}
export function parseVerifiedSerperOrganic(payload,{
 limit=5,observedAt=new Date().toISOString()}={}){
 if(!payload||typeof payload!=="object"||Array.isArray(payload)||
    !Array.isArray(payload.organic)||limit<1||limit>MAX_RESULT)
  throw err("DEXA_WEB_SERPER_RESPONSE_INVALID");
 const records=[],seen=new Set();
 for(const item of payload.organic.slice(0,30)){
  if(!item||typeof item!=="object"||typeof item.link!=="string"||
     typeof item.title!=="string")continue;
  let url;
  try{url=verifiedPublicHttpsUrl(item.link)}catch{continue}
  const title=item.title.replace(/\s+/g," ").trim().slice(0,260);
  if(!title||seen.has(url.href))continue;
  seen.add(url.href);
  records.push({
   title,url:url.href,
   snippet:typeof item.snippet==="string"?
    item.snippet.replace(/\s+/g," ").trim().slice(0,720):"",
   publishedAt:onlyKnownAbsolutePublicationDate(item.date),
   observedAt,sourceTrust:"UNTRUSTED_PUBLIC_WEB_SNIPPET"
  });
  if(records.length===limit)break;
 }
 return records;
}
export function readBraveSearchKey({dir=SECRET_DIR}={}){
 const file=path.join(dir,"brave-search-api.env");
 let stat;
 try{stat=fs.lstatSync(file)}catch(error){
  if(error?.code==="ENOENT")throw err("DEXA_WEB_BRAVE_KEY_NOT_CONFIGURED");
  throw err("DEXA_WEB_BRAVE_SECRET_UNAVAILABLE");
 }
 if(!stat.isFile()||(stat.mode&0o077)!==0||stat.size<25||
    stat.size>500||typeof process.getuid==="function"&&
    stat.uid!==process.getuid())
  throw err("DEXA_WEB_BRAVE_SECRET_PERMISSIONS");
 let value;
 try{value=fs.readFileSync(file,"utf8")}catch{
  throw err("DEXA_WEB_BRAVE_SECRET_UNAVAILABLE");
 }
 const match=value.match(/^BRAVE_SEARCH_API_KEY=([^\r\n]{8,450})\r?\n?$/);
 if(!match||/[\x00-\x20\x7f]/.test(match[1]))
  throw err("DEXA_WEB_BRAVE_SECRET_INVALID");
 return match[1];
}
export function parseVerifiedBraveWeb(payload,{
 limit=5,observedAt=new Date().toISOString()}={}){
 const items=payload?.web?.results;
 if(!Array.isArray(items)||limit<1||limit>MAX_RESULT)
  throw err("DEXA_WEB_BRAVE_RESPONSE_INVALID");
 const records=[],seen=new Set();
 for(const item of items.slice(0,30)){
  if(!item||typeof item!=="object"||typeof item.url!=="string"||
     typeof item.title!=="string")continue;
  let url;
  try{url=verifiedPublicHttpsUrl(item.url)}catch{continue}
  const title=item.title.replace(/\s+/g," ").trim().slice(0,260);
  if(!title||seen.has(url.href))continue;
  seen.add(url.href);
  records.push({
   title,url:url.href,
   snippet:typeof item.description==="string"?
    item.description.replace(/<[^>]*>/g," ").replace(/\s+/g," ").trim().slice(0,720):"",
   publishedAt:onlyKnownAbsolutePublicationDate(item.age),
   observedAt,sourceTrust:"UNTRUSTED_PUBLIC_WEB_SNIPPET"
  });
  if(records.length===limit)break;
 }
 return records;
}
function normalizeContentType(v){
 return String(v||"").split(";")[0].trim().toLowerCase();
}
function normalizeText(payload,contentType){
 if(contentType==="application/json"){
  const raw=payload.toString("utf8");
  try{JSON.parse(raw)}catch{throw err("DEXA_WEB_JSON_INVALID")}
  return raw.replace(/[\u0000-\u001f]/g," ").slice(0,MAX_TEXT);
 }
 if(["text/html","application/xhtml+xml"].includes(contentType)){
  let html=payload.toString("utf8");
  html=html.replace(/<!--[\s\S]*?-->/g," ")
    .replace(/<(script|style|noscript|svg|iframe|form)\b[^>]*>[\s\S]*?<\/\1\s*>/gi," ")
    .replace(/<\s*(br|\/p|\/article|\/section|\/h[1-6]|\/li)\b[^>]*>/gi,"\n")
    .replace(/<[^>]+>/g," ");
  return htmlDecode(html).replace(/[ \t]+/g," ").replace(/\n\s*\n+/g,"\n").trim().slice(0,MAX_TEXT);
 }
 if(["text/plain","application/xml","text/xml","application/rss+xml"].includes(contentType))
  return removeMarkup(payload.toString("utf8")).slice(0,MAX_TEXT);
 throw err("DEXA_WEB_CONTENT_TYPE_REJECTED");
}
async function liveFetchHttps(url,{timeoutMs=MAX_TIMEOUT_MS,maxBytes=MAX_WIRE,
 resolveDns=dnsLookup,method="GET",requestHeaders=null,body=null}={}){
 if(method!=="GET"&&method!=="POST")throw err("DEXA_WEB_METHOD_REJECTED");
 if(body!==null&&(!Buffer.isBuffer(body)||body.length>2048))
  throw err("DEXA_WEB_REQUEST_BODY_INVALID");
 const records=await resolveDns(url.hostname,{all:true,verbatim:true});
 if(!Array.isArray(records)||!records.length||
    records.length>24||records.some(x=>!isPublicIp(x.address)||x.family!==net.isIP(x.address)))
   throw err("DEXA_WEB_PUBLIC_DNS_REQUIRED");
 const address=records.find(x=>x.family===4)||records[0];
 return new Promise((resolve,reject)=>{
  const req=https.request(url,{
   method,timeout:timeoutMs,agent:false,rejectUnauthorized:true,
   maxHeaderSize:16384,
   lookup:(_host,options,callback)=>options.all?
    callback(null,[{address:address.address,family:address.family}]):
    callback(null,address.address,address.family),
   headers:{"user-agent":"DexaPublicRead/1.0 (bounded-source-reader)",
    accept:"text/html,text/plain,application/json,application/rss+xml,application/xml",
    "accept-encoding":"identity","cache-control":"no-cache",
    ...(requestHeaders||{})}
  },res=>{
   const headers=res.headers;
   let bytes=0;const chunks=[];
   res.on("data",chunk=>{
    bytes+=chunk.length;
    if(bytes>maxBytes){req.destroy(err("DEXA_WEB_RESPONSE_TOO_LARGE"));return}
    chunks.push(chunk);
   });
   res.on("end",()=>resolve({
    status:res.statusCode,headers,buffer:Buffer.concat(chunks)
   }));
  });
  req.on("timeout",()=>req.destroy(err("DEXA_WEB_TIMEOUT")));
  req.on("error",e=>reject(e.code?.startsWith("DEXA_WEB_")?e:err("DEXA_WEB_NETWORK_FAILURE")));
  if(body)req.write(body);
  req.end();
 });
}
export async function boundedPublicGet(input,{transport=liveFetchHttps,
 now=()=>new Date().toISOString(),maxBytes=MAX_WIRE}={}){
 let url=verifiedPublicHttpsUrl(input);
 if(typeof transport!=="function")throw err("DEXA_WEB_TRANSPORT_INVALID");
 const visited=new Set();
 for(let n=0;n<=MAX_REDIRECTS;n++){
  if(visited.has(url.href))throw err("DEXA_WEB_REDIRECT_CYCLE");
  visited.add(url.href);
  const res=await transport(url,{maxBytes,timeoutMs:MAX_TIMEOUT_MS});
  if(!Number.isSafeInteger(res?.status)||!res.headers||!Buffer.isBuffer(res.buffer)||
     res.buffer.length>maxBytes)throw err("DEXA_WEB_TRANSPORT_RESULT_INVALID");
  if([301,302,303,307,308].includes(res.status)){
   if(n===MAX_REDIRECTS)throw err("DEXA_WEB_REDIRECT_LIMIT");
   const location=res.headers.location;
   if(typeof location!=="string"||location.length>1400)
    throw err("DEXA_WEB_REDIRECT_INVALID");
   url=verifiedPublicHttpsUrl(new URL(location,url).href);
   continue;
  }
  if(res.status!==200)throw err("DEXA_WEB_UPSTREAM_HTTP_STATUS");
  const type=normalizeContentType(res.headers["content-type"]);
  if(!["text/html","application/xhtml+xml","text/plain","application/json",
       "application/rss+xml","application/xml","text/xml"].includes(type))
    throw err("DEXA_WEB_CONTENT_TYPE_REJECTED");
  const encoding=String(res.headers["content-encoding"]||"identity");
  if(encoding!=="identity")throw err("DEXA_WEB_COMPRESSED_RESPONSE_REJECTED");
  return Object.freeze({url:url.href,contentType:type,body:res.buffer,
   readAt:now(),byteLength:res.buffer.length,
   redirectCount:n,bodyDigest:digest(res.buffer),
   lastModified:typeof res.headers["last-modified"]==="string"?
    res.headers["last-modified"].slice(0,120):null});
 }
 throw err("DEXA_WEB_REDIRECT_LIMIT");
}
// Serper is the *only* admitted search provider; public Brave site
// scraping and the previously empty Bing RSS feed are not fake fallbacks.
// Failover occurs only on explicit key/quota status (bounded at two requests).
export async function executeSerperSearch(query,{
 limit=5,now=()=>new Date().toISOString(),
 keyReader=readSerperKeySlots,post=liveFetchHttps
}={}){
 if(typeof query!=="string"||query.length<3||query.length>180||
    /\p{C}/u.test(query)||query.trim().length<3||
    !Number.isSafeInteger(limit)||limit<1||limit>MAX_RESULT)
  throw err("DEXA_WEB_QUERY_INVALID");
 const keys=selectSerperKeyOrder(keyReader());
 const queryText=query.trim();
 const persian=/[\u0600-\u06ff]/u.test(queryText);
 const payload=Buffer.from(JSON.stringify({
  q:queryText,num:limit,hl:persian?"fa":"en",
  gl:persian?"ir":"us"
 }),"utf8");
 const endpoint=verifiedPublicHttpsUrl(SERPER_ENDPOINT);
 for(let i=0;i<keys.length;i++){
  const slot=keys[i];
  if(!slot||![1,2].includes(slot.slot)||typeof slot.key!=="string"||
     !slot.key||/[\r\n]/.test(slot.key))
   throw err("DEXA_WEB_SERPER_KEYS_INVALID");
  const response=await post(endpoint,{
   method:"POST",maxBytes:MAX_WIRE,timeoutMs:MAX_TIMEOUT_MS,
   requestHeaders:{"x-api-key":slot.key,
    "content-type":"application/json","accept":"application/json",
    "content-length":String(payload.length)},
   body:payload
  });
  if(!response||!Number.isSafeInteger(response.status)||
     !Buffer.isBuffer(response.buffer)||response.buffer.length>MAX_WIRE||
     !response.headers)throw err("DEXA_WEB_SERPER_RESPONSE_INVALID");
  if([401,402,403,429].includes(response.status)){
   // Distinct second key may have its own independent quota.
   if(i+1<keys.length)continue;
   throw err("DEXA_WEB_SERPER_KEYS_UNAVAILABLE");
  }
  // Avoid replaying possibly chargeable search on generic 5xx/timeouts.
  if(response.status!==200)throw err("DEXA_WEB_SERPER_UPSTREAM_HTTP");
  if(normalizeContentType(response.headers["content-type"])!=="application/json")
   throw err("DEXA_WEB_SERPER_CONTENT_TYPE_INVALID");
  if(String(response.headers["content-encoding"]||"identity")!=="identity")
   throw err("DEXA_WEB_COMPRESSED_RESPONSE_REJECTED");
  let data;
  try{data=JSON.parse(response.buffer.toString("utf8"))}catch{
   throw err("DEXA_WEB_SERPER_JSON_INVALID");
  }
  const readAt=now();
  const results=parseVerifiedSerperOrganic(data,{limit,observedAt:readAt});
  if(!results.length)throw err("DEXA_WEB_NO_VERIFIABLE_SEARCH_RESULTS");
  return Object.freeze({results,readAt,bodyDigest:digest(response.buffer),
   sourceUrl:SERPER_ENDPOINT,provider:"serper.google-search",
   credentialSlot:slot.slot,configuredKeySlots:keys.length});
 }
 throw err("DEXA_WEB_SERPER_KEYS_UNAVAILABLE");
}
export async function executeBraveSearch(query,{
 limit=5,now=()=>new Date().toISOString(),
 keyReader=readBraveSearchKey,request=liveFetchHttps
}={}){
 if(typeof query!=="string"||query.length<3||query.length>180||
    /\p{C}/u.test(query)||query.trim().length<3||
    !Number.isSafeInteger(limit)||limit<1||limit>MAX_RESULT)
  throw err("DEXA_WEB_QUERY_INVALID");
 const token=keyReader();
 if(typeof token!=="string"||token.length<8||/[\r\n]/.test(token))
  throw err("DEXA_WEB_BRAVE_SECRET_INVALID");
 const url=verifiedPublicHttpsUrl(BRAVE_ENDPOINT+"?"+new URLSearchParams({
  q:query.trim(),count:String(limit)
 }).toString());
 const response=await request(url,{
  method:"GET",maxBytes:MAX_WIRE,timeoutMs:MAX_TIMEOUT_MS,
  requestHeaders:{"x-subscription-token":token,
   "accept":"application/json","accept-encoding":"identity"}
 });
 if(!response||!Number.isSafeInteger(response.status)||
    !Buffer.isBuffer(response.buffer)||response.buffer.length>MAX_WIRE||
    !response.headers)throw err("DEXA_WEB_BRAVE_RESPONSE_INVALID");
 if([401,402,403,429].includes(response.status))
  throw err("DEXA_WEB_BRAVE_UNAVAILABLE");
 if(response.status!==200)throw err("DEXA_WEB_BRAVE_UPSTREAM_HTTP");
 if(normalizeContentType(response.headers["content-type"])!=="application/json")
  throw err("DEXA_WEB_BRAVE_CONTENT_TYPE_INVALID");
 if(String(response.headers["content-encoding"]||"identity")!=="identity")
  throw err("DEXA_WEB_COMPRESSED_RESPONSE_REJECTED");
 let data;
 try{data=JSON.parse(response.buffer.toString("utf8"))}catch{
  throw err("DEXA_WEB_BRAVE_JSON_INVALID");
 }
 const readAt=now(),results=parseVerifiedBraveWeb(data,{limit,observedAt:readAt});
 if(!results.length)throw err("DEXA_WEB_NO_VERIFIABLE_SEARCH_RESULTS");
 return Object.freeze({
  results,readAt,bodyDigest:digest(response.buffer),
  sourceUrl:BRAVE_ENDPOINT,provider:"brave.search-api",
  credentialSlot:null,configuredKeySlots:null
 });
}
// The first provider is always Serper. Two independent owner keys are
// rotated to distribute ordinary requests, with one additional key only for
// explicit quota/auth failures. Brave is a distinct official API fallback;
// never use the rate-limited public search website as an automated loophole.
export async function executeResilientWebSearch(query,{
 limit=5,now=()=>new Date().toISOString(),
 serperKeyReader=readSerperKeySlots,serperPost=liveFetchHttps,
 braveKeyReader=readBraveSearchKey,braveGet=liveFetchHttps,
 // Explicit owner-controlled gate. The default is DISABLED even if a
 // Brave credential were later placed on disk.
 braveBackupEnabled=process.env.DEXA_BRAVE_SEARCH_BACKUP_ENABLED==="1"
}={}){
 try{
  return await executeSerperSearch(query,{limit,now,
   keyReader:serperKeyReader,post:serperPost});
 }catch(primary){
  const code=String(primary?.code||"");
  if(["DEXA_WEB_QUERY_INVALID","DEXA_WEB_SERPER_SECRET_PERMISSIONS",
   "DEXA_WEB_SERPER_SECRET_INVALID","DEXA_WEB_SERPER_DUPLICATE_KEYS",
   "DEXA_WEB_SERPER_KEYS_INVALID"].includes(code))throw primary;
  // Until BOTH an explicit operator opt-in and the separate Brave key are
  // configured, fail closed with the Serper cause. Never inspect a Brave
  // credential and never make a Brave HTTP call while disabled.
  if(braveBackupEnabled!==true)throw primary;
  try{
   const secondary=await executeBraveSearch(query,{limit,now,
    keyReader:braveKeyReader,request:braveGet});
   return Object.freeze({...secondary,
    fallbackFrom:"serper.google-search",
    primaryFailureCode:code||"DEXA_WEB_SERPER_UNKNOWN_FAILURE"});
  }catch(second){
   if(second?.code==="DEXA_WEB_BRAVE_KEY_NOT_CONFIGURED")
    throw Object.assign(err("DEXA_WEB_BRAVE_KEY_NOT_CONFIGURED"),
     {primaryFailureCode:code});
   throw Object.assign(err("DEXA_WEB_SEARCH_ALL_PROVIDERS_FAILED"),
    {primaryFailureCode:code,
     secondaryFailureCode:String(second?.code||"DEXA_WEB_BRAVE_UNKNOWN_FAILURE")});
  }
 }
}
export async function executeDexaWebRead({capabilityId,args},{
 get=boundedPublicGet,now=()=>new Date().toISOString(),
 serperPost=liveFetchHttps,serperKeyReader=readSerperKeySlots,
 braveGet=liveFetchHttps,braveKeyReader=readBraveSearchKey,
 braveBackupEnabled=process.env.DEXA_BRAVE_SEARCH_BACKUP_ENABLED==="1"
}={}){
 if(!args||typeof args!=="object"||Array.isArray(args))
  throw err("DEXA_WEB_ARGS_INVALID");
 const started=Date.now();
 if(capabilityId===DEXA_WEB_SEARCH_ID){
  if(typeof args.query!=="string"||args.query.length<3||args.query.length>180||
     /\p{C}/u.test(args.query)||args.query.trim().length<3||
     !Number.isSafeInteger(args.maxResults??5)||(args.maxResults??5)<1||
     (args.maxResults??5)>MAX_RESULT)
   throw err("DEXA_WEB_QUERY_INVALID");
  const response=await executeResilientWebSearch(args.query,{
   limit:args.maxResults??5,now,
   serperKeyReader,serperPost,braveKeyReader,braveGet,
   braveBackupEnabled
  });
  return {result:{
   schema:DEXA_WEB_SCHEMA,provider:response.provider,operation:"search",
   query:args.query.trim(),results:response.results,readAt:response.readAt,
   contentDigest:response.bodyDigest,sourceUrl:response.sourceUrl,
   sourceTrust:"UNTRUSTED_PUBLIC_SEARCH",sourceVerification:"SOURCE_VERIFIED",
   receiptId:randomUUID(),resultCount:response.results.length,
   credentialSlot:response.credentialSlot,
   configuredKeySlots:response.configuredKeySlots,
   fallbackFrom:response.fallbackFrom||null,
   primaryFailureCode:response.primaryFailureCode||null
  },providerTool:"DEXA.INTERNAL.dexa_web_search",
   durationMs:Date.now()-started};
 }
 if(capabilityId===DEXA_WEB_READ_ID){
  const url=verifiedPublicHttpsUrl(args.url);
  const response=await get(url.href,{maxBytes:MAX_WIRE});
  const text=normalizeText(response.body,response.contentType);
  if(text.length<10)throw err("DEXA_WEB_PAGE_EMPTY");
  const published=Date.parse(response.lastModified||"");
  return {result:{
   schema:DEXA_WEB_SCHEMA,provider:"public.https",operation:"read",
   url:response.url,text,
   readAt:response.readAt,publishedAt:Number.isFinite(published)?
    new Date(published).toISOString():null,
   originalDigest:response.bodyDigest,contentDigest:digest(text),
   contentType:response.contentType,byteLength:response.byteLength,
   truncated:text.length>=MAX_TEXT,
   sourceTrust:"UNTRUSTED_PUBLIC_WEB_CONTENT",
   sourceVerification:"SOURCE_VERIFIED",receiptId:randomUUID()
  },providerTool:"DEXA.INTERNAL.dexa_web_read",
   durationMs:Date.now()-started};
 }
 throw err("DEXA_WEB_UNKNOWN_CAPABILITY");
}
