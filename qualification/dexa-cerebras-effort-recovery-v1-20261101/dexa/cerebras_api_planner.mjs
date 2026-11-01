import fs from "node:fs";
import {createHash} from "node:crypto";
import {performance} from "node:perf_hooks";
import {canonicalizePlannerOutput} from "./dexa_planner_output_canonicalizer.mjs";

// One isolated adapter; Rana, Kata and the existing Firefox planner stay untouched.
// No fallbacks/retries on an ambiguous POST: the model may have received it.
const API_URL="https://api.cerebras.ai/v1/chat/completions";
const KEY_FILE_DEFAULT="/home/cfserver/.local/share/dexa-core-service-20261023/cerebras-api.env";
const TRANSPORT="CEREBRAS_API_HTTPS";
const MODELS=new Set(["gpt-oss-120b","qwen-3.8-27b"]);
const MAX_REPLY_CHARS=35000;

function failure(code){
 const e=new Error(code);e.code=code;e.stage="CEREBRAS_API";return e;
}
function loadSecret(file=KEY_FILE_DEFAULT){
 let stat,raw;
 try{stat=fs.statSync(file);raw=fs.readFileSync(file,"utf8")}
 catch{throw failure("CEREBRAS_API_KEY_MISSING")}
 if(!stat.isFile()||(stat.mode&0o077)!==0||stat.size>300)
  throw failure("CEREBRAS_API_KEY_PERMISSIONS");
 const match=/^CEREBRAS_API_KEY=(csk-[A-Za-z0-9]+)\s*$/m.exec(raw);
 if(!match||match[1].length<30)throw failure("CEREBRAS_API_KEY_INVALID");
 return match[1];
}
function configuredModel(env=process.env){
 const model=env.DEXA_CEREBRAS_API_MODEL||"gpt-oss-120b";
 if(!MODELS.has(model))throw failure("CEREBRAS_API_MODEL_UNSUPPORTED");
 return model;
}
export function cerebrasApiPlannerStatus({env=process.env,keyFile=KEY_FILE_DEFAULT}={}){
 let error=null,model=null;
 try{model=configuredModel(env);loadSecret(keyFile)}
 catch(e){error=e.code||"CEREBRAS_API_NOT_CONFIGURED"}
 return{
  enabled:true,provider:"Cerebras",browser:null,
  transport:TRANSPORT,phase:error?"NOT_READY":"READY",
  ready:!error,modelLabel:!error?model:null,
  lastErrorCode:error,checkedAt:new Date().toISOString(),
  // Key existence is a local readiness check; no network/prompt side effects.
  readinessSource:"LOCAL_SECRET_AND_MODEL_CONFIG"
 };
}
export function createCerebrasApiPlanner({
 fetchImpl=globalThis.fetch,readKey=loadSecret,env=process.env
}={}){
 if(typeof fetchImpl!=="function"||typeof readKey!=="function")
  throw failure("CEREBRAS_API_ADAPTER_INVALID");
 return async function requestRecipe(prompt,{
  missionId,timeoutMs=90000,onProgress=()=>{},responseFormat=null
 }={}){
  if(typeof missionId!=="string"||
     !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(missionId)||
     typeof prompt!=="string"||prompt.trim().length<3||prompt.length>150000)
   throw failure("CEREBRAS_API_INPUT_INVALID");
  const model=configuredModel(env);
  const key=readKey();
  const started=performance.now();
  const requestHash=createHash("sha256").update(prompt).digest("hex");
  // 2026-11-01: xhigh is model-documented but live Cerebras planning rejected
  // four consecutive requests before any tools. Restore last verified API value
  // medium until an upstream successful high-effort canary exists.
  // Keep the existing GPT budget unchanged and never retry ambiguous POSTs.
  const qwen=model==="qwen-3.8-27b";
  if(responseFormat!==null&&responseFormat!=="json_object")
   throw failure("CEREBRAS_API_RESPONSE_FORMAT_NOT_SUPPORTED");
  const request={model,stream:false,max_completion_tokens:qwen?16000:8500,
   ...(qwen?{reasoning_effort:"medium"}:{}),
   ...(responseFormat==="json_object"?
     {response_format:{type:"json_object"}}:{}),
   messages:[{role:"user",content:prompt}]};
  onProgress("درخواست رسپی به Cerebras API ارسال شد.");
  let response;
  try{
   response=await fetchImpl(API_URL,{
    method:"POST",
    headers:{"authorization":"Bearer "+key,
      "content-type":"application/json","accept":"application/json"},
    body:JSON.stringify(request),
    signal:AbortSignal.timeout(Math.min(150000,Math.max(8000,timeoutMs)))
   });
  }catch{
   // A POST might have reached the model; never resend it automatically.
   throw failure("CEREBRAS_API_SEND_IN_DOUBT");
  }
  if(!response?.ok){
   if(response?.status===401||response?.status===403)
    throw failure("CEREBRAS_API_AUTH_FAILED");
   if(response?.status===400)throw failure("CEREBRAS_API_BAD_REQUEST");
   if(response?.status===429)throw failure("CEREBRAS_API_RATE_LIMITED");
   if([500,502,503,504].includes(response?.status))
    throw failure("CEREBRAS_API_UPSTREAM_UNAVAILABLE");
   throw failure("CEREBRAS_API_UPSTREAM_REJECTED");
  }
  let data;
  try{data=await response.json()}
  catch{throw failure("CEREBRAS_API_REPLY_INVALID")}
  if(data?.choices?.[0]?.finish_reason==="length")
   throw failure("CEREBRAS_API_REPLY_TRUNCATED");
  const content=data?.choices?.[0]?.message?.content;
  if(typeof content!=="string")
   throw failure("CEREBRAS_API_REPLY_INVALID");
  const normalized=canonicalizePlannerOutput(content);
  if(normalized.text.length<2||normalized.text.length>MAX_REPLY_CHARS)
   throw failure("CEREBRAS_API_REPLY_INVALID");
  const elapsedMs=Math.round(performance.now()-started);
  const usage=data?.usage||{};
  const number=x=>Number.isSafeInteger(x)&&x>=0?x:null;
  onProgress("رسپی Cerebras API دریافت شد.");
  return{
   recipe:normalized.text,model,
   modelLabel:"Cerebras API · "+model,provider:"Cerebras",
   chatUrl:API_URL,transport:TRANSPORT,actualBrowserBridge:false,
   didSend:true,elapsedMs,responseMessageCount:1,cleanup:"NOT_APPLICABLE",
   transportTimings:{
    transport:TRANSPORT,elapsedMs,responseSource:"HTTPS_CHAT_COMPLETIONS",
    requestHash,model,
    promptTokens:number(usage.prompt_tokens),
    completionTokens:number(usage.completion_tokens),
    totalTokens:number(usage.total_tokens),
    modelReplyFenceCanonicalized:normalized.canonicalized
   }
  };
 };
}
export const requestCerebrasApiRecipe=createCerebrasApiPlanner();
export const CEREBRAS_API_TRANSPORT=TRANSPORT;
