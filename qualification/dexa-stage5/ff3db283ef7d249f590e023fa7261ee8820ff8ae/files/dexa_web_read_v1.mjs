// Dexa Stage 5. One bounded read-only public web capability family.
// Not a CF-server tool, not a planner/second model, and never a credentialed
// browser. Search uses a physically observed public RSS endpoint. The URL
// reader pins a DNS-validated public IP for every HTTPS hop, including redirects.
import {lookup as dnsLookup} from "node:dns/promises";
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
const extract=(item,key)=>{
 const tag=key.replace(/[^A-Za-z0-9_-]/g,"");
 const match=String(item).match(new RegExp("<"+tag+"(?:\\s[^>]*)?>([\\s\\S]*?)<\\/"+tag+">","i"));
 return match?removeMarkup(match[1]):"";
};
export function parseVerifiedRss(body,{limit=5,observedAt=new Date().toISOString()}={}){
 if(typeof body!=="string"||body.length>MAX_WIRE||limit<1||limit>MAX_RESULT||
    !/<rss\b/i.test(body)||!/<channel\b/i.test(body))
  throw err("DEXA_WEB_SEARCH_FORMAT_INVALID");
 const items=(body.match(/<item(?:\s[^>]*)?>[\s\S]*?<\/item>/gi)||[]).slice(0,20);
 const records=[],seen=new Set();
 for(const item of items){
  const urlText=extract(item,"link");
  let url;
  try{url=verifiedPublicHttpsUrl(urlText)}catch{continue}
  const title=extract(item,"title").slice(0,260);
  if(!title||seen.has(url.href))continue;
  seen.add(url.href);
  const time=extract(item,"pubDate");
  const publishedAt=time&&Number.isFinite(Date.parse(time))?
   new Date(Date.parse(time)).toISOString():null;
  records.push({
   title,url:url.href,snippet:extract(item,"description").slice(0,720),
   publishedAt,observedAt,
   sourceTrust:"UNTRUSTED_PUBLIC_WEB_SNIPPET"
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
 resolveDns=dnsLookup}={}){
 const records=await resolveDns(url.hostname,{all:true,verbatim:true});
 if(!Array.isArray(records)||!records.length||
    records.length>24||records.some(x=>!isPublicIp(x.address)||x.family!==net.isIP(x.address)))
   throw err("DEXA_WEB_PUBLIC_DNS_REQUIRED");
 const address=records.find(x=>x.family===4)||records[0];
 return new Promise((resolve,reject)=>{
  const req=https.request(url,{
   method:"GET",timeout:timeoutMs,agent:false,rejectUnauthorized:true,
   maxHeaderSize:16384,
   lookup:(_host,options,callback)=>options.all?
    callback(null,[{address:address.address,family:address.family}]):
    callback(null,address.address,address.family),
   headers:{"user-agent":"DexaPublicRead/1.0 (bounded-source-reader)",
    accept:"text/html,text/plain,application/json,application/rss+xml,application/xml",
    "accept-encoding":"identity","cache-control":"no-cache"}
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
export async function executeDexaWebRead({capabilityId,args},
 {get=boundedPublicGet,now=()=>new Date().toISOString()}={}){
 if(!args||typeof args!=="object"||Array.isArray(args))
  throw err("DEXA_WEB_ARGS_INVALID");
 const started=Date.now();
 const time=now();
 if(capabilityId===DEXA_WEB_SEARCH_ID){
  if(typeof args.query!=="string"||args.query.length<3||args.query.length>180||
     /\p{C}/u.test(args.query)||args.query.trim().length<3||
     !Number.isSafeInteger(args.maxResults??5)||(args.maxResults??5)<1||
     (args.maxResults??5)>MAX_RESULT)
   throw err("DEXA_WEB_QUERY_INVALID");
  const source="https://www.bing.com/search?format=rss&q="+encodeURIComponent(args.query.trim());
  const response=await get(source,{maxBytes:MAX_WIRE});
  if(response.contentType!=="application/rss+xml"&&
     response.contentType!=="text/xml"&&response.contentType!=="application/xml")
   throw err("DEXA_WEB_SEARCH_MIME_INVALID");
  const results=parseVerifiedRss(response.body.toString("utf8"),{
   limit:args.maxResults??5,observedAt:response.readAt});
  if(!results.length)throw err("DEXA_WEB_NO_VERIFIABLE_SEARCH_RESULTS");
  return {result:{
   schema:DEXA_WEB_SCHEMA,provider:"bing.public-rss",operation:"search",
   query:args.query.trim(),results,readAt:response.readAt,
   contentDigest:response.bodyDigest,sourceUrl:response.url,
   sourceTrust:"UNTRUSTED_PUBLIC_SEARCH",sourceVerification:"SOURCE_VERIFIED",
   receiptId:randomUUID(),resultCount:results.length
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
