// Dexa catalog gateway: sole owner OAuth + typed CF provider tools, read/write.
// GH/RD cards lacking a physical runtime still fail closed without invented routes.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import {randomBytes,createHash,timingSafeEqual} from "node:crypto";
import {catalogCounts,catalogList,admitCatalogCall,catalogRoute,inputSchemaFor} from "./dexa_catalog_registry.mjs";
import {requirePhysicalEffectReceipt} from "./dexa_effect_contract_v1.mjs";
import {attachMcpMaterialLinks} from "./dexa_mcp_material_link_v1.mjs";
import {admitRootRequest,validateRootTicket,extractRootRequestId} from "./dexa_root_otp_policy.mjs";
import {classifyCatalogError,isCatalogTransientHttpStatus}
 from "./dexa_catalog_transport_contract.mjs";
import {DEXA_CATALOG_READS_PER_MINUTE,DEXA_CATALOG_ROLLING_WINDOW_MS,
 DEXA_CATALOG_MATERIAL_CHUNKS_PER_MINUTE}
 from "./dexa_catalog_rate_policy_v1.mjs";
process.umask(0o077);
const HOST="127.0.0.1",PORT=Number(process.env.DEXA_CATALOG_GATEWAY_PORT||9484);
if(!Number.isSafeInteger(PORT)||PORT<1024||PORT>65535)throw Error("CATALOG_PORT_INVALID");
const PRIVATE="/home/cfserver/.local/share/dexa-catalog-gateway-20261023";
const CLIENT_FILE=path.join(PRIVATE,"oauth-client.json");
const TOKEN_FILE=path.join(PRIVATE,"oauth-token.json");
const PENDING_FILE=path.join(PRIVATE,"oauth-pending.json");
const ROOT_TICKET=path.join(PRIVATE,"root-otp-ticket.json");
const RESOURCE="https://cf-onshape.duckdns.org/mcp/oauth";
const REGISTRATION="https://cf-onshape.duckdns.org/mcp/oauth/register";
const AUTH="https://cf-onshape.duckdns.org/mcp/oauth/authorize";
const TOKEN="https://cf-onshape.duckdns.org/mcp/oauth/token";
const REDIRECT="https://cf-onshape.duckdns.org/dexa-mobile/catalog/oauth/callback";
const MAX_BODY=3200000,MAX_REPLY=450000; // 1 MiB binary chunk encoded in bounded JSON, never model-visible
const INTERNAL_KEY=Buffer.from(fs.readFileSync(path.join(PRIVATE,"internal-key"),"utf8").trim(),"hex");
if(INTERNAL_KEY.length!==32)throw Error("CATALOG_INTERNAL_KEY_INVALID");
fs.mkdirSync(PRIVATE,{recursive:true,mode:0o700});fs.chmodSync(PRIVATE,0o700);
const readJSON=(file,otherwise={})=>{try{return JSON.parse(fs.readFileSync(file,"utf8"))}catch{return otherwise}};
function persist(file,value){
 const temp=file+"."+randomBytes(8).toString("hex")+".tmp";
 fs.writeFileSync(temp,JSON.stringify(value),{mode:0o600,flag:"wx"});
 fs.renameSync(temp,file);fs.chmodSync(file,0o600);
}
const shortError=(code,details={})=>Object.assign(new Error(code),{code,...details});
const safe=(e)=>String(e?.code||"CATALOG_BACKEND_ERROR").replace(/[^A-Z0-9_]/g,"").slice(0,80);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let tokenLock=Promise.resolve();
let registrationLock=null;
const jsonHeaders={"content-type":"application/json; charset=utf-8","cache-control":"no-store",
 "x-content-type-options":"nosniff","referrer-policy":"no-referrer","x-frame-options":"DENY"};
function json(res,status,data){
 const b=Buffer.from(JSON.stringify(data));
 res.writeHead(status,{...jsonHeaders,"content-length":b.length});res.end(b);
}
function html(res,status,body){
 const b=Buffer.from("<!doctype html><html lang='fa' dir='rtl'><head><meta charset='utf-8'><meta name='viewport' content='width=device-width, initial-scale=1'><title>اتصال دکسا</title></head><body style='font:18px/2 system-ui;max-width:600px;margin:45px auto;padding:20px'><h2>اتصال کاتالوگ دکسا</h2><p>"+body+"</p><p><a href='/dexa-mobile/'>بازگشت به دکسا</a></p></body></html>");
 res.writeHead(status,{...jsonHeaders,"content-type":"text/html; charset=utf-8","content-length":b.length,
  "content-security-policy":"default-src 'none'; style-src 'unsafe-inline'"});res.end(b);
}
async function readBody(req){
 let size=0,parts=[];
 for await(const part of req){
  size+=part.length;
  if(size>MAX_BODY)throw shortError("CATALOG_REQUEST_TOO_LARGE");
  parts.push(part);
 }
 let obj;
 try{obj=JSON.parse(Buffer.concat(parts).toString("utf8"))}catch{throw shortError("CATALOG_BAD_JSON")}
 if(!obj||typeof obj!=="object"||Array.isArray(obj))throw shortError("CATALOG_BAD_OBJECT");
 return obj;
}
async function boundedText(res,max=MAX_REPLY){
 if(!res.ok)throw shortError(
  isCatalogTransientHttpStatus(res.status)?
   "CATALOG_UPSTREAM_HTTP_TRANSIENT":"CATALOG_UPSTREAM_HTTP_REJECTED",
  {upstreamStatus:res.status});
 const parts=[];let size=0;
 for await(const chunk of res.body){
  size+=chunk.byteLength;
  if(size>max){try{await res.body.cancel()}catch{};throw shortError("CATALOG_RESPONSE_TOO_LARGE")}
  parts.push(Buffer.from(chunk));
 }
 return Buffer.concat(parts).toString("utf8");
}
async function registerClient(){
 const existing=readJSON(CLIENT_FILE);
 if(typeof existing.client_id==="string"&&existing.client_id.length>=8)return existing;
 if(registrationLock)return registrationLock;
 registrationLock=(async()=>{
  const response=await fetch(REGISTRATION,{
   method:"POST",headers:{"content-type":"application/json","accept":"application/json"},
   body:JSON.stringify({client_name:"Dexa Personal Owner Catalog",
    redirect_uris:[REDIRECT],grant_types:["authorization_code","refresh_token"],
    response_types:["code"],token_endpoint_auth_method:"none"}),
   signal:AbortSignal.timeout(12000)
  });
  if(!response.ok)throw shortError("CATALOG_OAUTH_REGISTRATION_FAILED",{upstreamStatus:response.status});
  const data=JSON.parse(await boundedText(response,30000));
  if(typeof data.client_id!=="string"||!data.client_id)throw shortError("CATALOG_OAUTH_NO_CLIENT_ID");
  persist(CLIENT_FILE,{client_id:data.client_id,redirect_uris:[REDIRECT],createdAt:new Date().toISOString()});
  return readJSON(CLIENT_FILE);
 })().finally(()=>{registrationLock=null});
 return registrationLock;
}
const form=entries=>new URLSearchParams(entries).toString();
async function tokenRequest(entries){
 const response=await fetch(TOKEN,{method:"POST",
  headers:{"content-type":"application/x-www-form-urlencoded","accept":"application/json"},
  body:form(entries),signal:AbortSignal.timeout(14000)});
 if(!response.ok)throw shortError("CATALOG_OAUTH_TOKEN_FAILED",{upstreamStatus:response.status});
 const tokens=JSON.parse(await boundedText(response,50000));
 if(typeof tokens.access_token!=="string"||!tokens.access_token)throw shortError("CATALOG_OAUTH_EMPTY_TOKEN");
 return tokens;
}
async function beginOauth(){
 const client=await registerClient();
 const verifier=randomBytes(48).toString("base64url");
 const state=randomBytes(32).toString("base64url");
 const challenge=createHash("sha256").update(verifier).digest("base64url");
 persist(PENDING_FILE,{state,verifier,createdAt:Date.now()});
 const q=new URLSearchParams({response_type:"code",client_id:client.client_id,
  redirect_uri:REDIRECT,code_challenge:challenge,code_challenge_method:"S256",
  state,scope:"cf:execute",resource:RESOURCE});
 return AUTH+"?"+q.toString();
}
async function finishOauth(url){
 const pending=readJSON(PENDING_FILE);
 const state=url.searchParams.get("state"),code=url.searchParams.get("code");
 if(!pending.state||!state||pending.state!==state||
    Date.now()-Number(pending.createdAt)>600000||!code)
   throw shortError("CATALOG_OAUTH_STATE_MISMATCH");
 fs.rmSync(PENDING_FILE,{force:true});
 const client=readJSON(CLIENT_FILE);
 if(!client.client_id)throw shortError("CATALOG_OAUTH_CLIENT_MISSING");
 const tokens=await tokenRequest({grant_type:"authorization_code",code,
  redirect_uri:REDIRECT,client_id:client.client_id,
  code_verifier:pending.verifier,resource:RESOURCE});
 tokens.expires_at=Date.now()+Math.max(15,Number(tokens.expires_in||3600)-45)*1000;
 persist(TOKEN_FILE,tokens);
 return true;
}
async function usableToken(){
 const tok=readJSON(TOKEN_FILE);
 if(tok.access_token&&tok.expires_at>Date.now()+20000)return tok.access_token;
 if(!tok.refresh_token)throw shortError("CATALOG_OAUTH_NOT_CONNECTED");
 const client=readJSON(CLIENT_FILE);
 const refreshed=await tokenRequest({grant_type:"refresh_token",
  refresh_token:tok.refresh_token,client_id:client.client_id,resource:RESOURCE});
 refreshed.refresh_token ||= tok.refresh_token;
 refreshed.expires_at=Date.now()+Math.max(15,Number(refreshed.expires_in||3600)-45)*1000;
 persist(TOKEN_FILE,refreshed);
 return refreshed.access_token;
}
function parseMcpReply(raw,contentType){
 let obj;
 if(contentType.includes("text/event-stream")){
  for(const line of raw.split("\n"))if(line.startsWith("data:")){
   try{obj=JSON.parse(line.slice(5).trim())}catch{}
  }
 }else{
  try{obj=JSON.parse(raw)}catch{throw shortError("CATALOG_UPSTREAM_JSON_INVALID")}
 }
 if(!obj)throw shortError("CATALOG_UPSTREAM_EMPTY");
 if(obj.error)throw shortError("CATALOG_UPSTREAM_MCP_ERROR");
 const result=obj.result||obj;
 if(result.isError)throw shortError("CATALOG_UPSTREAM_TOOL_ERROR");
 if(result.structuredContent)
  return attachMcpMaterialLinks(result.structuredContent,result.content);
 const texts=(result.content||[]).filter(v=>v.type==="text"&&typeof v.text==="string").map(v=>v.text);
 if(texts.length){
  const joined=texts.join("\n");
  try{return JSON.parse(joined)}catch{return {text:joined}}
 }
 const media=(result.content||[]).filter(v=>v.type==="image"||v.type==="audio").map(v=>({type:v.type,mimeType:v.mimeType,bytes:(v.data||"").length}));
 return media.length?{media,notice:"Media content omitted from JSON. Download support requires a separate approved adapter."}:
  {ok:true,empty:true};
}
async function callOwnerRootTool(tool,args){
 const permitted=new Set(["server_admin_request","server_admin_approve","server_admin_cancel","server_admin_output"]);
 if(!permitted.has(tool))throw shortError("ROOT_TOOL_NOT_ALLOWED");
 const admission=admitCatalogCall({capabilityId:"tool.cf."+tool,args,readOnlyOnly:false});
 if(admission.tool!==tool)throw shortError("ROOT_SCHEMA_TOOL_MISMATCH");
 const access=await usableToken();
 const query={jsonrpc:"2.0",id:randomBytes(4).readUInt32BE(),method:"tools/call",params:{name:tool,arguments:admission.args}};
 const response=await fetch(RESOURCE,{method:"POST",
  headers:{"authorization":"Bearer "+access,"content-type":"application/json",
   "accept":"application/json, text/event-stream","mcp-protocol-version":"2025-03-26"},
  body:JSON.stringify(query),signal:AbortSignal.timeout(45000)});
 const body=await boundedText(response,MAX_REPLY);
 return parseMcpReply(body,response.headers.get("content-type")||"");
}
function rootTicket(){return readJSON(ROOT_TICKET)}
function rootSummary(ticket){
 return {requestId:ticket.requestId||null,status:ticket.status||"NONE",
  issuedAt:ticket.issuedAt?new Date(ticket.issuedAt).toISOString():null,
  attempts:ticket.attempts||0,reason:ticket.reason||null};
}
let otpBusy=false;
async function rootRequest(payload){
 if(otpBusy)throw shortError("ROOT_OTP_BUSY");
 const args=admitRootRequest(payload);
 const previous=rootTicket();
 if(["SENDING","WAITING_FOR_CODE","IN_DOUBT","APPROVAL_SUBMITTED_IN_DOUBT"].includes(previous.status)&&
   Date.now()-Number(previous.issuedAt||0)<600000)
  throw shortError("ROOT_PREVIOUS_TICKET_ACTIVE");
 const existingToken=readJSON(TOKEN_FILE);
 if(!existingToken.access_token&&!existingToken.refresh_token)throw shortError("CATALOG_OAUTH_NOT_CONNECTED");
 otpBusy=true;
 const ticket={status:"SENDING",requestId:null,issuedAt:Date.now(),attempts:0,
  reason:args.reason,commandHash:createHash("sha256").update(args.command).digest("hex")};
 persist(ROOT_TICKET,ticket);
 try{
  const result=await callOwnerRootTool("server_admin_request",args);
  const requestId=extractRootRequestId(result);
  persist(ROOT_TICKET,{...ticket,status:"WAITING_FOR_CODE",requestId});
  return {ok:true,requestId,status:"WAITING_FOR_CODE",
   message:"ROOT_OTP_SENT_TO_TELEGRAM_SAVED_MESSAGES",expiresInSeconds:600};
 }catch(error){
  persist(ROOT_TICKET,{...ticket,status:"IN_DOUBT",error:safe(error)});
  throw shortError("ROOT_REQUEST_IN_DOUBT_DO_NOT_REPEAT");
 }finally{otpBusy=false}
}
async function rootApprove(payload){
 if(otpBusy)throw shortError("ROOT_OTP_BUSY");
 const ticket=rootTicket();
 const args=validateRootTicket(ticket,payload.requestId,{requireCode:true,code:payload.code});
 otpBusy=true;
 persist(ROOT_TICKET,{...ticket,status:"APPROVAL_SUBMITTED_IN_DOUBT",attempts:(ticket.attempts||0)+1});
 try{
  const result=await callOwnerRootTool("server_admin_approve",args);
  persist(ROOT_TICKET,{...ticket,status:"APPROVED",approvedAt:Date.now(),
    attempts:(ticket.attempts||0)+1});
  return {ok:true,requestId:args.request_id,status:"APPROVED",result};
 }catch{
  persist(ROOT_TICKET,{...ticket,status:"IN_DOUBT",attempts:(ticket.attempts||0)+1});
  throw shortError("ROOT_APPROVAL_IN_DOUBT_CHECK_STATUS_DO_NOT_RETRY");
 }finally{otpBusy=false}
}
async function rootCancel(payload){
 if(otpBusy)throw shortError("ROOT_OTP_BUSY");
 const ticket=rootTicket();
 const args=validateRootTicket(ticket,payload.requestId);
 otpBusy=true;
 try{
  const result=await callOwnerRootTool("server_admin_cancel",args);
  persist(ROOT_TICKET,{...ticket,status:"CANCELLED",cancelledAt:Date.now()});
  return {ok:true,requestId:args.request_id,status:"CANCELLED",result};
 }finally{otpBusy=false}
}
async function rootOutput(payload){
 const ticket=rootTicket();
 const id=String(payload?.requestId||"");
 if(!/^[0-9a-f]{16}$/.test(id)||id!==ticket.requestId)throw shortError("ROOT_TICKET_NOT_MATCHED");
 if(!["APPROVED","IN_DOUBT","APPROVAL_SUBMITTED_IN_DOUBT"].includes(ticket.status))
  throw shortError("ROOT_OUTPUT_ONLY_AFTER_APPROVAL");
 return {ok:true,requestId:id,result:await callOwnerRootTool("server_admin_output",{request_id:id})};
}
let inflight=0;
const callTimestamps=[],materialChunkTimestamps=[];
async function executeCatalogOperation(payload){
 if(inflight>=1)throw shortError("CATALOG_EXECUTOR_BUSY");
 const admitted=admitCatalogCall({...payload,readOnlyOnly:false});
 const bulkChunk=Number(inputSchemaFor(admitted.capabilityId)?.properties?.data_base64?.maxLength||0)>=100000;
 const timeline=bulkChunk?materialChunkTimestamps:callTimestamps;
 const limit=bulkChunk?DEXA_CATALOG_MATERIAL_CHUNKS_PER_MINUTE:DEXA_CATALOG_READS_PER_MINUTE;
 const now=Date.now();
 while(timeline.length&&now-timeline[0]>DEXA_CATALOG_ROLLING_WINDOW_MS)timeline.shift();
 if(timeline.length>=limit)throw shortError("CATALOG_RATE_LIMIT");
 inflight++;timeline.push(now);
 const start=performance.now();
 let stage="OAUTH_TOKEN";
 try{
  const access=await usableToken();
  const req={jsonrpc:"2.0",id:randomBytes(4).readUInt32BE(),method:"tools/call",
   params:{name:admitted.tool,arguments:admitted.args}};
  stage="MCP_DISPATCH";
  const upstream=await fetch(RESOURCE,{method:"POST",
   headers:{"authorization":"Bearer "+access,"content-type":"application/json",
    "accept":"application/json, text/event-stream","mcp-protocol-version":"2025-03-26"},
   body:JSON.stringify(req),signal:AbortSignal.timeout(
    admitted.tool==='wechat_file_send'?90000:40000)});
  stage="MCP_HTTP_STATUS";
  if(!upstream.ok)throw shortError(
   isCatalogTransientHttpStatus(upstream.status)?
    "CATALOG_UPSTREAM_HTTP_TRANSIENT":"CATALOG_UPSTREAM_HTTP_REJECTED",
   {upstreamStatus:upstream.status});
  stage="MCP_RESPONSE_BODY";
  const raw=await boundedText(upstream);
  stage="MCP_RESPONSE_PARSE";
  const result=parseMcpReply(raw,upstream.headers.get("content-type")||"");
  const route=catalogRoute(admitted.capabilityId);
  let effectProof=null;
  if(!admitted.readOnly){
   try{effectProof=requirePhysicalEffectReceipt({
    capabilityId:admitted.capabilityId,route,response:result,
    requestArgs:admitted.args});
   }catch{
    // Log shape only, NEVER private content or tool arguments.
    console.log(JSON.stringify({event:"dexa_effect_receipt_shape_rejected",
     capabilityId:admitted.capabilityId,
     rootKeys:result&&typeof result==="object"?Object.keys(result).slice(0,12):[],
     providerState:typeof result?.state==="string"?result.state:null,
     providerTool:typeof result?.tool==="string"?result.tool:null,
     nestedKeys:result?.result&&typeof result.result==="object"?Object.keys(result.result).slice(0,12):[],
     nestedState:typeof result?.result?.state==="string"?result.result.state:null,
     nestedStatus:typeof result?.result?.status==="string"?result.result.status:null}));
    throw shortError("CATALOG_EFFECT_RESULT_UNVERIFIED")
   }
  }
  const response={ok:true,capabilityId:admitted.capabilityId,tool:admitted.tool,
   mode:"OWNER_AUTHENTICATED_CATALOG_OPERATION",readOnly:admitted.readOnly,
   effectClass:admitted.effectClass,effectProof,
   durationMs:Math.round(performance.now()-start),result};
  console.log(JSON.stringify({event:"dexa_catalog_operation",capabilityId:admitted.capabilityId,
   status:"SUCCEEDED",durationMs:response.durationMs}));
  return response;
 }catch(e){
  const classified=classifyCatalogError(e,stage);
  // No raw exception, token, arguments or provider body crosses this boundary.
  console.log(JSON.stringify({event:"dexa_catalog_operation",capabilityId:admitted.capabilityId,
   status:"FAILED",...classified}));
  throw shortError(classified.code,classified);
 }finally{inflight--}
}
const serve=http.createServer(async(req,res)=>{
 if(req.socket.remoteAddress!=="127.0.0.1"&&req.socket.remoteAddress!=="::1")
  return json(res,403,{error:"CATALOG_LOOPBACK_ONLY"});
 if(req.headers.host!=="127.0.0.1:"+PORT)
  return json(res,403,{error:"CATALOG_HOST_DENIED"});
 const key=String(req.headers["x-dexa-catalog-internal-key"]||"");
 if(!/^[0-9a-f]{64}$/i.test(key)||!timingSafeEqual(Buffer.from(key,"hex"),INTERNAL_KEY))
  return json(res,403,{error:"CATALOG_INTERNAL_AUTH_REQUIRED"});
 let url;
 try{url=new URL(req.url,"http://127.0.0.1:9484")}catch{return json(res,400,{error:"INVALID_URL"})}
 try{
  if(req.method==="GET"&&url.pathname==="/catalog/status"){
   const tok=readJSON(TOKEN_FILE);
   return json(res,200,{ok:true,counts:catalogCounts(),
    oauthConnected:Boolean(tok.refresh_token||tok.access_token),
    activeCalls:inflight,
    liveScope:"ALL_BOUND_CF_TOOLS_OWNER_AUTHENTICATED",
    writes:"ENABLED_WITH_EXISTING_OWNER_OAUTH_AND_TYPED_RANA_RECEIPTS",
    otherConnectors:"GH_RD_NOT_BOUND",
    originalDexaTelegramReadOnly:true});
  }
  if(req.method==="GET"&&url.pathname==="/catalog/capabilities"){
   const tok=readJSON(TOKEN_FILE);
   const rows=catalogList({oauthConnected:Boolean(tok.refresh_token||tok.access_token)});
   return json(res,200,{ok:true,capabilities:rows});
  }
  if(req.method==="POST"&&url.pathname==="/catalog/oauth/start"){
   const destination=await beginOauth();
   return json(res,200,{ok:true,authorizeUrl:destination});
  }
  if(req.method==="GET"&&url.pathname==="/catalog/oauth/callback"){
   await finishOauth(url);
   return html(res,200,"اتصال کاتالوگ CF برقرار شد. ابزارهای دارای اتصال، از جمله ارسال و نوشتن، تحت حساب مالک قابل اجرا هستند.");
  }
  if(req.method==="POST"&&url.pathname==="/catalog/preview"){
   const payload=await readBody(req);
   const route=catalogRoute(payload.capabilityId);
   if(!route)return json(res,404,{error:"CATALOG_CAPABILITY_UNKNOWN"});
   const admitted=admitCatalogCall({...payload,readOnlyOnly:false});
   const t=readJSON(TOKEN_FILE);
   const oauthConnected=Boolean(t.refresh_token||t.access_token);
   return json(res,200,{ok:true,capabilityId:route.id,tool:admitted.tool,
    readOnly:admitted.readOnly,requiresOwnerApproval:false,
    executableNow:oauthConnected,
    reason:oauthConnected?"AUTHENTICATED_BOUND_EXECUTOR_READY":"CATALOG_OAUTH_CONNECTION_REQUIRED"});
  }
  if(req.method==="GET"&&url.pathname==="/catalog/root/status"){
   return json(res,200,{ok:true,ticket:rootSummary(rootTicket()),
    delivery:"TELEGRAM_SAVED_MESSAGES",codeFormat:"6_DIGITS",maxLifetimeSeconds:600});
  }
  if(req.method==="POST"&&url.pathname==="/catalog/root/request"){
   return json(res,200,await rootRequest(await readBody(req)));
  }
  if(req.method==="POST"&&url.pathname==="/catalog/root/approve"){
   return json(res,200,await rootApprove(await readBody(req)));
  }
  if(req.method==="POST"&&url.pathname==="/catalog/root/cancel"){
   return json(res,200,await rootCancel(await readBody(req)));
  }
  if(req.method==="POST"&&url.pathname==="/catalog/root/output"){
   return json(res,200,await rootOutput(await readBody(req)));
  }
  if(req.method==="POST"&&url.pathname==="/catalog/execute"){
   const payload=await readBody(req);
   const data=await executeCatalogOperation(payload);
   return json(res,200,data);
  }
  return json(res,404,{error:"CATALOG_ROUTE_NOT_FOUND"});
 }catch(e){
  const failure=classifyCatalogError(e,e?.stage||"ADMISSION");
  return json(res,e?.code==="CATALOG_RATE_LIMIT"?429:
    failure.retryable?503:400,{
     error:failure.code,stage:failure.stage,retryable:failure.retryable,
     ...(failure.upstreamStatus?{upstreamStatus:failure.upstreamStatus}:{}),
     ...(e?.issues?{schemaIssues:e.issues}:{})
    });
 }
});
serve.headersTimeout=13000;serve.requestTimeout=50000;serve.keepAliveTimeout=15000;
serve.listen(PORT,HOST,()=>console.log(JSON.stringify({event:"dexa_catalog_gateway_ready",
 host:HOST,port:PORT,catalog:292,boundCfCapabilities:188,writesRequireApproval:false})));
