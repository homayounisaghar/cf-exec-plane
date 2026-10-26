import fs from "node:fs/promises";
import net from "node:net";
import http from "node:http";
import path from "node:path";
import crypto from "node:crypto";
import { chromium } from "playwright";
import WebSocket from "ws";
import { decodeToPcm16 } from "./pcg_ffmpeg_decode.mjs";
import { runFixed } from "./pcg_soniox_fixed_overlap.mjs";
import {FairSocketPool, runMultiFileBatch, MAX_FILES_PER_BATCH, GLOBAL_WS_LIMIT} from "./pcg_soniox_multifile.mjs";

const SOCKET_PATH = process.env.PCG_PERPLEXITY_ASR_SOCKET || "/run/pcg/perplexity-asr.sock";
const MATERIAL_ROOT = path.resolve(process.env.PCG_PERPLEXITY_ASR_MATERIAL_ROOT || "/run/pcg/material-files");
const STATE_ROOT = path.resolve(process.env.PCG_PERPLEXITY_ASR_STATE_ROOT || "/run/pcg/perplexity-asr-state");
const PROFILE_DIR = path.resolve(process.env.PCG_PERPLEXITY_PROFILE_DIR || "/profile");
const LOGIN_PORT = Number(process.env.PCG_PERPLEXITY_LOGIN_PORT || "8767");
const LOGIN_HTML_PATH = process.env.PCG_PERPLEXITY_LOGIN_HTML || "/release/pcg_perplexity_login.html";
const START_URL = "https://www.perplexity.ai/";
const MOBILE_BROWSER_UA = "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/30.0 Chrome/143.0.0.0 Mobile Safari/537.36";
const SONIOX_WS = "wss://stt-rt.soniox.com/transcribe-websocket";
const MAX_SOURCE_BYTES = 64 * 1024 * 1024;
const SAMPLE_RATE = 16000;
const AUDIO_CHUNK = 3200;
const SUPPORTED_SPEED_FACTORS = new Set([1, 2, 4, 8, 16]);
const DEFAULT_PARALLELISM = Number(process.env.PCG_SONIOX_PARALLELISM ?? 514);
const MAX_PARALLELISM = 514;
const JOB_RE = /^[0-9a-f]{64}$/;
const HANDLE_RE = /^pcgfile:([0-9a-f]{64})$/;
const SHA_RE = /^[0-9a-f]{64}$/;
const jobs = new Map();
const activeJobIds = new Set();
const pendingSingleJobs = [];
let credentialGate = Promise.resolve();
const globalSocketPool = new FairSocketPool({maxSockets:GLOBAL_WS_LIMIT,maxFiles:MAX_FILES_PER_BATCH});
const batchJobs = new Map();
let reservedBatchFiles = 0;
let context = null;
let authPage = null;
let attendedPage = null;
let browserState = "STARTING";
let browserError = null;

function nowMs(){ return Date.now(); }
function sleep(ms){ return new Promise((resolve)=>setTimeout(resolve, ms)); }
function jsonLine(value){ return JSON.stringify(value) + "\n"; }
function hash(value){ return crypto.createHash("sha256").update(value).digest("hex"); }

async function atomicJson(file, value){
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = file + ".tmp-" + process.pid + "-" + crypto.randomBytes(4).toString("hex");
  await fs.writeFile(tmp, jsonLine(value), { mode: 0o600 });
  await fs.rename(tmp, file);
}
function publicJob(job, cacheHit=false){
  return {
    ok:true,
    job_id:job.job_id,
    state:job.state,
    cache_hit:Boolean(cacheHit),
    source_sha256:job.source_sha256,
    source_size_bytes:job.source_size_bytes,
    language_requested:job.language_requested,
    text:job.text || "",
    inference_ms:job.inference_ms ?? null,
    engine_id:"perplexity-session-soniox",
    engine_version:"stt-rt-v4",
    model_id:"soniox-stt-rt-v4",
    realization:"perplexity-browser-session",
    credential_mode:"perplexity-anonymous-session",
    whole_message:true,
    stream_speed_factor:job.stream_speed_factor || 4,
    parallelism_requested:job.parallelism_requested ?? 1,
    parallelism_used:job.parallelism_used ?? null,
    parts_total:job.parts_total ?? null,
    batches_used:job.batches_used ?? null,
    unmatched_seams:job.unmatched_seams ?? null,
    merge_method:job.merge_method || null,
    merge_review_required:job.merge_review_required ?? null,
    unresolved_boundaries:job.unresolved_boundaries || [],
    attended_login_available:true,
    started_at_ms:job.started_at_ms??null,
    completed_at_ms:job.completed_at_ms??null,
    peak_file_websockets:job.peak_file_websockets??null,
    error:job.error || null,
  };
}
async function validateMaterial(handle, filename, sizeBytes, sourceSha256){
  const m = HANDLE_RE.exec(String(handle || ""));
  if(!m) throw new Error("PERPLEXITY_ASR_MATERIAL_HANDLE_INVALID");
  if(typeof filename !== "string" || !filename || filename.length > 512 || filename.includes("/") || filename.includes("\\") || filename.includes("\0")) throw new Error("PERPLEXITY_ASR_FILENAME_INVALID");
  if(!Number.isSafeInteger(sizeBytes) || sizeBytes < 1 || sizeBytes > MAX_SOURCE_BYTES) throw new Error("PERPLEXITY_ASR_SOURCE_SIZE_INVALID");
  if(typeof sourceSha256 !== "string" || !SHA_RE.test(sourceSha256)) throw new Error("PERPLEXITY_ASR_SOURCE_DIGEST_INVALID");
  const file = path.resolve(MATERIAL_ROOT, m[1] + "-" + filename);
  if(path.dirname(file) !== MATERIAL_ROOT) throw new Error("PERPLEXITY_ASR_MATERIAL_PATH_INVALID");
  const st = await fs.stat(file);
  if(!st.isFile() || st.size !== sizeBytes) throw new Error("PERPLEXITY_ASR_SOURCE_SIZE_MISMATCH");
  const digest = crypto.createHash("sha256").update(await fs.readFile(file)).digest("hex");
  if(digest !== sourceSha256) throw new Error("PERPLEXITY_ASR_SOURCE_DIGEST_MISMATCH");
  return file;
}
async function ensureBrowser(){
  if(context && authPage && !authPage.isClosed() && browserState === "READY") return;
  browserState = "STARTING";
  browserError = null;
  try{
    await fs.mkdir(PROFILE_DIR, { recursive:true });
    context = await chromium.launchPersistentContext(PROFILE_DIR, {
      headless:true,
      userAgent:MOBILE_BROWSER_UA,
      viewport:{width:412,height:915},
      isMobile:true,
      locale:"fa-IR",
      args:["--no-sandbox","--disable-dev-shm-usage"],
    });
    authPage = context.pages()[0] || await context.newPage();
    attendedPage = authPage;
    context.on("page", (page) => {
      attendedPage = page;
      page.on("close", () => {
        if (attendedPage === page) attendedPage = authPage && !authPage.isClosed() ? authPage : null;
      });
    });
    // Mirror Android v1.49 exactly: never load the Perplexity SPA in the
    // credential broker. Use a tiny synthetic document at the Perplexity HTTPS
    // origin, then call the credential endpoint from that anonymous context.
    await prepareSyntheticBroker();
    browserState = "READY";
  }catch(err){
    browserState = "FAILED";
    browserError = String(err?.message || err).slice(0,240);
    throw Object.assign(new Error("PERPLEXITY_BROWSER_START_FAILED"), { cause:err });
  }
}
async function fetchCredentialFromPage(){
  return await authPage.evaluate(async()=>{
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    try{
      const r = await fetch("/rest/realtime/v1/transcription/soniox-api-key", {
        method:"POST",
        credentials:"include",
        headers:{"Accept":"application/json","Content-Type":"application/json"},
        body:JSON.stringify({source:"android",timezone,version:"2.97.0"}),
      });
      const raw = await r.text();
      let body = null;
      try{ body = JSON.parse(raw); }catch{}
      return {status:r.status, ok:r.ok, body, raw:raw.slice(0,300)};
    }catch(e){
      return {status:0, ok:false, error:String(e?.message || e)};
    }
  });
}

async function prepareSyntheticBroker(){
  const synthetic="<!doctype html><html><head><meta charset='utf-8'></head><body></body></html>";
  const handler=async(route)=>{
    if(route.request().resourceType()==="document"){
      await route.fulfill({status:200,contentType:"text/html; charset=utf-8",body:synthetic});
    }else{
      await route.continue();
    }
  };
  await context.route(START_URL,handler);
  try{
    await authPage.goto(START_URL,{waitUntil:"domcontentloaded",timeout:45000});
  }finally{
    await context.unroute(START_URL,handler);
  }
}

async function credentialUnlocked(){
  await ensureBrowser();
  if(!String(authPage.url() || "").startsWith("https://www.perplexity.ai/")){
    await prepareSyntheticBroker();
  }

  let result = await fetchCredentialFromPage();
  if(result?.ok && result?.body?.api_key) return String(result.body.api_key);

  // Mirror the Android v1.49 hidden broker: a tiny same-origin synthetic page
  // reuses the anonymous Perplexity browser profile and performs only the
  // credential fetch, without loading the SPA or logging into an account.
  await prepareSyntheticBroker();
  result = await fetchCredentialFromPage();
  if(result?.ok && result?.body?.api_key) return String(result.body.api_key);

  if(result?.status === 401 || result?.status === 403) {
    throw new Error("PERPLEXITY_ANONYMOUS_CREDENTIAL_REJECTED_" + String(result.status));
  }
  throw new Error("PERPLEXITY_CREDENTIAL_FAILED_" + String(result?.status || "NETWORK"));
}
// The one anonymous browser page is shared. Serialize only the credential
// acquisition, never independent file decoding or Soniox WebSocket execution.
async function credential(){
  const request=credentialGate.then(()=>credentialUnlocked());
  credentialGate=request.then(()=>{},()=>{});
  return await request;
}
async function sonioxWholeMessage(apiKey, pcm, speedFactor = 4, withTokens = false){
  return await new Promise((resolve,reject)=>{
    const ws = new WebSocket(SONIOX_WS);
    let done=false;
    let finalTranscript="";
    const finalTokens=[];
    const finish=(err,value)=>{
      if(done) return;
      done=true;
      try{ ws.close(); }catch{}
      err ? reject(err) : resolve(value);
    };
    const timeout=setTimeout(()=>finish(new Error("PERPLEXITY_ASR_TIMEOUT")), Math.max(30000, Math.ceil(pcm.length/2/SAMPLE_RATE*1000)+30000));
    ws.on("open", async()=>{
      try{
        ws.send(JSON.stringify({
          api_key:apiKey,
          model:"stt-rt-v4",
          audio_format:"pcm_s16le",
          sample_rate:SAMPLE_RATE,
          num_channels:1,
          enable_endpoint_detection:false,
          language_hints:["fa"],
        }));
        const paceMs = Math.max(1, Math.round(100 / speedFactor));
        for(let offset=0; offset<pcm.length; offset+=AUDIO_CHUNK){
          ws.send(pcm.subarray(offset, Math.min(pcm.length, offset+AUDIO_CHUNK)));
          await sleep(paceMs);
        }
        ws.send("");
      }catch(err){
        clearTimeout(timeout);
        finish(err);
      }
    });
    ws.on("message",(data)=>{
      try{
        const o=JSON.parse(String(data));
        if(o?.error_code){ clearTimeout(timeout); finish(new Error("SONIOX_"+String(o.error_code))); return; }
        if(Array.isArray(o?.tokens)){
          for(const t of o.tokens){
            const tt=String(t?.text || "");
            if(!tt || /^<(end|fin)>$/i.test(tt.trim())) continue;
            if(t?.is_final === true){
              finalTranscript += tt;
              if(withTokens)finalTokens.push({text:tt,start_ms:Number.isFinite(t.start_ms)?t.start_ms:null,end_ms:Number.isFinite(t.end_ms)?t.end_ms:null});
            }
          }
        }
        if(o?.finished === true){
          clearTimeout(timeout);
          const text=finalTranscript.trim();
          if(!text){ finish(new Error("PERPLEXITY_ASR_EMPTY_TRANSCRIPT")); return; }
          finish(null,withTokens?{text,tokens:finalTokens}:text);
        }
      }catch{}
    });
    ws.on("error",(err)=>{ clearTimeout(timeout); finish(Object.assign(new Error("PERPLEXITY_SONIOX_SOCKET_FAILED"),{cause:err})); });
    ws.on("close",()=>{ if(!done){ clearTimeout(timeout); finish(new Error("PERPLEXITY_SONIOX_CLOSED")); } });
  });
}
function jobKey(sourceSha256, language, speedFactor, parallelism){
  return hash(JSON.stringify({source_sha256:sourceSha256,language:language||"fa",engine:"perplexity-session-soniox",model:"stt-rt-v4",whole_message:true,stream_speed_factor:speedFactor,parallelism}));
}
async function runJob(job){
  job.state="RUNNING";
  job.started_at_ms=nowMs();
  job.error=null;
  const started=Date.now();
  try{
    await atomicJson(path.join(STATE_ROOT,job.job_id+".json"),job);
    const pcm=await decodeToPcm16(job.source_path);
    const result=await runFixed(pcm,{
      maxConcurrent:job.parallelism_requested,
      getCredential:credential,
      transcribeWithKey:(apiKey,chunk)=>globalSocketPool.withPermit(job.job_id,
        ()=>sonioxWholeMessage(apiKey,chunk,job.stream_speed_factor || 4)),
    });
    job.text=result.merged.text;
    job.parallelism_used=Math.min(result.plan.actual_parts,job.parallelism_requested);
    job.parts_total=result.plan.actual_parts;
    job.batches_used=result.plan.batches;
    job.merge_method=result.merged.method;
    job.merge_review_required=result.merged.unmatched>0;
    job.unmatched_seams=result.merged.unmatched;
    job.unresolved_boundaries=result.merged.seams.filter(s=>s.needs_review).map(s=>s.left_part);
    job.state="SUCCEEDED"; job.inference_ms=Date.now()-started;
    job.completed_at_ms=nowMs(); job.error=null;
  }catch(err){
    job.state="FAILED";job.error=String(err?.message||err).slice(0,240);
    job.inference_ms=Date.now()-started;job.completed_at_ms=nowMs();
  }finally{
    job.peak_file_websockets=globalSocketPool.jobs.get(job.job_id)?.peak??0;
    globalSocketPool.unregister(job.job_id);
    activeJobIds.delete(job.job_id);
    await atomicJson(path.join(STATE_ROOT,job.job_id+".json"),job).catch(()=>{});
    pumpSingleJobs();
  }
}
function pumpSingleJobs(){
  while(pendingSingleJobs.length &&
        globalSocketPool.jobs.size+reservedBatchFiles<MAX_FILES_PER_BATCH){
    const job=pendingSingleJobs.shift();
    globalSocketPool.register(job.job_id);
    activeJobIds.add(job.job_id);
    runJob(job).catch(()=>{});
  }
}
function scheduleJob(job){
  pendingSingleJobs.push(job);
  pumpSingleJobs();
}
async function startJob(request){
  const language=String(request?.language || "fa").trim().toLowerCase();
  if(language !== "fa") throw new Error("PERPLEXITY_ASR_LANGUAGE_UNSUPPORTED");
  const sourceSha256=String(request?.sha256_hex || "").toLowerCase();
  const speedFactor=Number(request?.speed_factor ?? 4);
  if(!Number.isInteger(speedFactor) || !SUPPORTED_SPEED_FACTORS.has(speedFactor)) throw new Error("PERPLEXITY_ASR_SPEED_FACTOR_UNSUPPORTED");
  const parallelism=Number(request?.parallelism ?? DEFAULT_PARALLELISM);
  if(!Number.isInteger(parallelism) || parallelism<1 || parallelism>MAX_PARALLELISM) throw new Error("PERPLEXITY_ASR_PARALLELISM_INVALID");
  const file=await validateMaterial(request?.material_file_handle,request?.filename,request?.size_bytes,sourceSha256);
  const id=jobKey(sourceSha256,language,speedFactor,parallelism);
  const existing=jobs.get(id);
  if(existing) return publicJob(existing,existing.state==="SUCCEEDED");
  const persistedPath=path.join(STATE_ROOT,id+".json");
  try{
    const old=JSON.parse(await fs.readFile(persistedPath,"utf8"));
    if(old?.state==="SUCCEEDED" && old?.source_sha256===sourceSha256 && Number(old?.stream_speed_factor||4)===speedFactor && Number(old?.parallelism_requested||1)===parallelism){jobs.set(id,old);return publicJob(old,true);}
  }catch{}
  const job={job_id:id,state:"QUEUED",source_sha256:sourceSha256,source_size_bytes:request.size_bytes,source_path:file,source_filename:request.filename,language_requested:language,stream_speed_factor:speedFactor,parallelism_requested:parallelism,parallelism_used:null,parts_total:null,batches_used:null,merge_method:null,merge_review_required:null,unmatched_seams:null,unresolved_boundaries:[],text:"",inference_ms:null,error:null,created_at_ms:nowMs()};
  jobs.set(id,job); await atomicJson(persistedPath,job);
  scheduleJob(job);
  return publicJob(job);
}
async function statusJob(request){
  const id=String(request?.job_id || "").toLowerCase();
  if(!JOB_RE.test(id)) throw new Error("PERPLEXITY_ASR_JOB_ID_INVALID");
  let job=jobs.get(id);
  if(!job){
    try{ job=JSON.parse(await fs.readFile(path.join(STATE_ROOT,id+".json"),"utf8")); jobs.set(id,job); }catch{ throw new Error("PERPLEXITY_ASR_JOB_NOT_FOUND"); }
  }
  return publicJob(job, job.state==="SUCCEEDED");
}

/** Fixed-schema 1..20 entrypoint. Never dedupe jobs by source digest: exact
 * duplicate audio submitted 17 times must create 17 independent transcripts.
 */
function publicBatch(b){
  return {ok:true,batch_id:b.batch_id,state:b.state,
    files_total:b.files.length,
    files_succeeded:b.files.filter(f=>f.state==="SUCCEEDED").length,
    files_failed:b.files.filter(f=>f.state==="FAILED").length,
    files_running:b.files.filter(f=>f.state==="RUNNING").length,
    max_files:MAX_FILES_PER_BATCH,max_global_websockets:GLOBAL_WS_LIMIT,
    peak_concurrent_files:b.peak_concurrent_files||0,
    peak_global_websockets:b.peak_global_websockets||0,
    peak_active_socket_files:b.peak_active_socket_files||0,
    created_at_ms:b.created_at_ms,
    completed_at_ms:b.completed_at_ms||null,
    error:b.error||null,
    files:b.files.map(f=>({
      index:f.index,client_id:f.client_id,job_id:f.job_id,
      state:f.state,source_sha256:f.source_sha256,
      completed_parts:f.completed_parts||0,active_segment_batch:f.active_segment_batch||null,
      second_batch_started_at_ms:f.second_batch_started_at_ms||null,
      started_at_ms:f.started_at_ms||null,completed_at_ms:f.completed_at_ms||null,
      parts_total:f.parts_total??null,batches_used:f.batches_used??null,
      segment_batches:f.segment_batches||[],
      first_socket_at_ms:f.first_socket_at_ms??null,
      last_socket_completed_at_ms:f.last_socket_completed_at_ms??null,
      peak_file_websockets:f.peak_file_websockets??0,
      parallelism_used:f.parallelism_used??null,
      unmatched_seams:f.unmatched_seams??null,
      merge_method:f.merge_method||null,
      text:f.state==="SUCCEEDED"?f.text:"",
      error:f.error||null,
    })),
  };
}
async function batchStart(request){
  const items=request?.files;
  if(!Array.isArray(items)||items.length<1||items.length>MAX_FILES_PER_BATCH)
    throw Error("PERPLEXITY_ASR_BATCH_FILE_COUNT_INVALID");
  if(reservedBatchFiles+globalSocketPool.jobs.size+items.length>MAX_FILES_PER_BATCH)
    throw Error("PERPLEXITY_ASR_BATCH_ACTIVE_FILE_LIMIT");
  const id=crypto.randomBytes(32).toString("hex");
  const entries=[];
  const files=[];
  const clientIds=new Set();
  for(let i=0;i<items.length;i++){
    const raw=items[i];
    if(!raw||typeof raw!=="object"||Array.isArray(raw))throw Error("PERPLEXITY_ASR_BATCH_FILE_INVALID");
    const label=String(raw.client_id||("file-"+String(i+1).padStart(2,"0")));
    if(!/^[a-zA-Z0-9_.-]{1,80}$/.test(label)||clientIds.has(label))
      throw Error("PERPLEXITY_ASR_BATCH_CLIENT_ID_INVALID");
    clientIds.add(label);
    const language=String(raw.language||"fa").trim().toLowerCase();
    const speedFactor=Number(raw.speed_factor??4);
    const parallelism=Number(raw.parallelism??DEFAULT_PARALLELISM);
    if(language!=="fa"||!SUPPORTED_SPEED_FACTORS.has(speedFactor)||!Number.isInteger(parallelism)||parallelism<1||parallelism>MAX_PARALLELISM)
      throw Error("PERPLEXITY_ASR_BATCH_OPTIONS_INVALID");
    const sha=String(raw.sha256_hex||"").toLowerCase();
    const source=await validateMaterial(raw.material_file_handle,raw.filename,raw.size_bytes,sha);
    const instanceId=hash("batch:"+id+":file:"+i);
    const entry={instance_id:instanceId,index:i+1,client_id:label,sha256_hex:sha,
      source_path:source,parallelism,stream_speed_factor:speedFactor};
    entries.push(entry);
    files.push({index:i+1,client_id:label,job_id:instanceId,source_sha256:sha,
      state:"QUEUED",completed_parts:0,text:"",active_segment_batch:null,
      segment_batches:[],peak_file_websockets:0});
  }
  // Reserve file slots BEFORE scheduling, so another batch can't race admission.
  reservedBatchFiles+=items.length;
  const batch={batch_id:id,state:"QUEUED",created_at_ms:nowMs(),files,error:null,
    peak_concurrent_files:0,peak_global_websockets:0,peak_active_socket_files:0};
  batchJobs.set(id,batch);
  const persistedPath=path.join(STATE_ROOT,"batch-"+id+".json");
  await atomicJson(persistedPath,batch);
  const byId=new Map(entries.map((entry,i)=>[entry.instance_id,files[i]]));
  const runner=async()=>{
    batch.state="RUNNING";batch.started_at_ms=nowMs();
    try{
      const result=await runMultiFileBatch(entries,{
        pool:globalSocketPool,
        decodedPcm:(entry)=>decodeToPcm16(entry.source_path),
        getCredential:credential,
        transcribe:(key,pcm,segment,entry)=>sonioxWholeMessage(key,pcm,entry.stream_speed_factor),
        onFileState:(entry,state,value)=>{
          const f=byId.get(entry.instance_id);
          f.state=state;
          if(state==="RUNNING")f.started_at_ms=nowMs();
          if(value){
            f.completed_at_ms=nowMs();
            Object.assign(f,{parts_total:value.parts_total,batches_used:value.batches_used,
              parallelism_used:value.parallelism_used,unmatched_seams:value.unmatched_seams,
              merge_method:value.merge_method,text:value.text||"",error:value.error||null,
              completed_parts:value.completed_parts,
              peak_file_websockets:value.peak_file_websockets??0});
          }
        },
        onPartStart:(entry,segment)=>{
          const f=byId.get(entry.instance_id);
          const at=nowMs();
          f.active_segment_batch=segment.batch;
          if(!f.first_socket_at_ms)f.first_socket_at_ms=at;
          let round=f.segment_batches.find(x=>x.batch===segment.batch);
          if(!round){
            round={batch:segment.batch,started_at_ms:at,last_completed_at_ms:null,
              parts_started:0,parts_completed:0,duration_ms:null};
            f.segment_batches.push(round);
          }
          round.parts_started++;
          if(segment.batch>1&&!f.second_batch_started_at_ms)
            f.second_batch_started_at_ms=at;
        },
        onPartDone:(entry,progress)=>{
          const f=byId.get(entry.instance_id);
          f.completed_parts=progress.completed_parts;
          f.last_socket_completed_at_ms=nowMs();
          const round=f.segment_batches.find(x=>x.batch===progress.batch);
          if(round){
            round.parts_completed++;
            round.last_completed_at_ms=nowMs();
            round.duration_ms=round.last_completed_at_ms-round.started_at_ms;
          }
        },
        onProgress:(metrics)=>{
          batch.peak_concurrent_files=Math.max(batch.peak_concurrent_files,metrics.peak_concurrent_files);
          batch.peak_global_websockets=Math.max(batch.peak_global_websockets,globalSocketPool.peak);
          batch.peak_active_socket_files=Math.max(batch.peak_active_socket_files,globalSocketPool.peakActiveSocketFiles);
        },
      });
      batch.state=result.ok?"SUCCEEDED":"PARTIAL_FAILURE";
      batch.peak_concurrent_files=result.peak_concurrent_files;
      batch.peak_global_websockets=result.global_socket_peak;
      batch.peak_active_socket_files=result.peak_active_socket_files;
    }catch(error){
      batch.state="FAILED";batch.error=String(error?.message||error).slice(0,240);
      for(const f of files)if(f.state==="QUEUED"||f.state==="RUNNING"){
        f.state="FAILED";f.error="ASR_BATCH_EXECUTION_FAILED";
      }
    }finally{
      batch.completed_at_ms=nowMs();
      reservedBatchFiles=Math.max(0,reservedBatchFiles-items.length);
      await atomicJson(persistedPath,batch).catch(()=>{});
      pumpSingleJobs();
    }
  };
  runner().catch(()=>{});
  return publicBatch(batch);
}
async function batchStatus(request){
  const id=String(request?.batch_id||"").toLowerCase();
  if(!JOB_RE.test(id))throw Error("PERPLEXITY_ASR_BATCH_ID_INVALID");
  let batch=batchJobs.get(id);
  if(!batch){
    try{batch=JSON.parse(await fs.readFile(path.join(STATE_ROOT,"batch-"+id+".json"),"utf8"));}
    catch{throw Error("PERPLEXITY_ASR_BATCH_NOT_FOUND");}
    if(batch.state==="QUEUED"||batch.state==="RUNNING"){
      batch.state="INTERRUPTED";batch.error="ASR_SERVICE_RESTARTED_DURING_BATCH";
    }
    batchJobs.set(id,batch);
  }
  return publicBatch(batch);
}

function attendedBrowserPage(){
  if(attendedPage && !attendedPage.isClosed()) return attendedPage;
  if(authPage && !authPage.isClosed()) return authPage;
  const pages=context?.pages?.() || [];
  return pages.find((p)=>!p.isClosed()) || null;
}
async function readHttpJson(req, maxBytes=65536){
  return await new Promise((resolve,reject)=>{
    let raw="";
    req.setEncoding("utf8");
    req.on("data",(chunk)=>{
      raw+=chunk;
      if(raw.length>maxBytes) reject(new Error("LOGIN_REQUEST_TOO_LARGE"));
    });
    req.on("end",()=>{
      try{ resolve(raw ? JSON.parse(raw) : {}); }catch{ reject(new Error("LOGIN_REQUEST_INVALID")); }
    });
    req.on("error",reject);
  });
}
function sendHttp(res,status,body,type="application/json; charset=utf-8"){
  res.writeHead(status,{"Content-Type":type,"Cache-Control":"no-store","X-Content-Type-Options":"nosniff"});
  res.end(body);
}
async function attendedLoginHandler(req,res){
  try{
    await ensureBrowser();
    const url=new URL(req.url || "/", "http://127.0.0.1");
    if(req.method==="GET" && url.pathname==="/"){
      const html=await fs.readFile(LOGIN_HTML_PATH,"utf8");
      sendHttp(res,200,html,"text/html; charset=utf-8");
      return;
    }
    if(req.method==="GET" && url.pathname==="/shot"){
      const page=attendedBrowserPage();
      if(!page){ sendHttp(res,503,"no page","text/plain; charset=utf-8"); return; }
      const png=await page.screenshot({type:"png"});
      res.writeHead(200,{"Content-Type":"image/png","Cache-Control":"no-store","X-Content-Type-Options":"nosniff"});
      res.end(png);
      return;
    }
    if(req.method==="GET" && url.pathname==="/state"){
      const page=attendedBrowserPage();
      if(!page){ sendHttp(res,503,JSON.stringify({ok:false,error:"NO_PAGE"})); return; }
      let title="";
      try{ title=await page.title(); }catch{}
      sendHttp(res,200,JSON.stringify({ok:true,url:page.url(),title}));
      return;
    }
    if(req.method==="POST"){
      const page=attendedBrowserPage();
      if(!page){ sendHttp(res,503,JSON.stringify({ok:false,error:"NO_PAGE"})); return; }
      const body=await readHttpJson(req);
      if(url.pathname==="/click"){
        const x=Number(body.x), y=Number(body.y);
        if(!Number.isFinite(x)||!Number.isFinite(y)) throw new Error("LOGIN_CLICK_INVALID");
        await page.mouse.click(Math.max(0,Math.min(1279,x)),Math.max(0,Math.min(899,y)));
      }else if(url.pathname==="/type"){
        const value=String(body.text || "");
        if(!value || value.length>4096) throw new Error("LOGIN_TEXT_INVALID");
        await page.keyboard.insertText(value);
      }else if(url.pathname==="/key"){
        const key=String(body.key || "");
        const allowed=new Set(["Enter","Tab","Backspace","Escape","ArrowUp","ArrowDown","ArrowLeft","ArrowRight"]);
        if(!allowed.has(key)) throw new Error("LOGIN_KEY_INVALID");
        await page.keyboard.press(key);
      }else if(url.pathname==="/scroll"){
        const dy=Math.max(-2000,Math.min(2000,Number(body.dy)||0));
        await page.mouse.wheel(0,dy);
      }else if(url.pathname==="/reload"){
        await page.reload({waitUntil:"domcontentloaded",timeout:45000});
      }else if(url.pathname==="/back"){
        await page.goBack({waitUntil:"domcontentloaded",timeout:45000}).catch(()=>{});
      }else if(url.pathname==="/home"){
        attendedPage=authPage;
        await authPage.goto(START_URL,{waitUntil:"domcontentloaded",timeout:45000});
      }else{
        sendHttp(res,404,JSON.stringify({ok:false,error:"NOT_FOUND"}));
        return;
      }
      sendHttp(res,200,JSON.stringify({ok:true}));
      return;
    }
    sendHttp(res,404,JSON.stringify({ok:false,error:"NOT_FOUND"}));
  }catch(err){
    sendHttp(res,500,JSON.stringify({ok:false,error:String(err?.message || err).slice(0,200)}));
  }
}

async function health(){
  try{ await ensureBrowser(); }catch{}
  return {
    ok:true,
    state:browserState,
    browser_error:browserError,
    engine_id:"perplexity-session-soniox",
    model_id:"soniox-stt-rt-v4",
    whole_message:true,
    endpoint_detection:false,
    supported_speed_factors:[1,2,4,8,16],
    default_parallelism:DEFAULT_PARALLELISM,
    audio_decoder:"native_ffmpeg_arm64",
    browser_audio_decode:false,
    parallelism_range:[1,MAX_PARALLELISM],
    default_stream_speed_factor:4,
    active_job_id:activeJobIds.values().next().value||null,
    active_job_ids:[...activeJobIds],
    pending_single_jobs:pendingSingleJobs.length,
    max_files_per_batch:MAX_FILES_PER_BATCH,
    global_socket_limit:GLOBAL_WS_LIMIT,
    global_socket_active:globalSocketPool.live,
    global_socket_peak:globalSocketPool.peak,
    batches_known:batchJobs.size,
    batch_files_reserved:reservedBatchFiles,
    jobs_known:jobs.size,
    attended_login_port:LOGIN_PORT,
  };
}
async function dispatch(request){
  const op=String(request?.op || "");
  if(op==="health") return await health();
  if(op==="transcribe.start") return await startJob(request);
  if(op==="transcribe.status") return await statusJob(request);
  if(op==="transcribe.batch.start") return await batchStart(request);
  if(op==="transcribe.batch.status") return await batchStatus(request);
  throw new Error("PERPLEXITY_ASR_OPERATION_UNSUPPORTED");
}
await fs.mkdir(STATE_ROOT,{recursive:true});
await fs.mkdir(path.dirname(SOCKET_PATH),{recursive:true});
try{ await fs.unlink(SOCKET_PATH); }catch{}
const server=net.createServer((socket)=>{
  socket.setEncoding("utf8");
  socket.setTimeout(15000);
  let buf="";
  socket.on("data",async(chunk)=>{
    buf+=chunk;
    if(buf.length>1024*1024){ socket.end(jsonLine({ok:false,error:"PERPLEXITY_ASR_REQUEST_TOO_LARGE"})); return; }
    const nl=buf.indexOf("\n");
    if(nl<0) return;
    const line=buf.slice(0,nl); buf="";
    try{ socket.end(jsonLine(await dispatch(JSON.parse(line)))); }
    catch(err){ socket.end(jsonLine({ok:false,error:String(err?.message || err).slice(0,240)})); }
  });
});
server.listen(SOCKET_PATH,()=>fs.chmod(SOCKET_PATH,0o660).catch(()=>{}));
const loginServer=http.createServer((req,res)=>{ attendedLoginHandler(req,res).catch((err)=>sendHttp(res,500,JSON.stringify({ok:false,error:String(err?.message || err).slice(0,200)}))); });
loginServer.listen(LOGIN_PORT,"0.0.0.0");
ensureBrowser().catch(()=>{});
