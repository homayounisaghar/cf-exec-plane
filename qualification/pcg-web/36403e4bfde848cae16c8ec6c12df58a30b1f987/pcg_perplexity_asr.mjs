import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import crypto from "node:crypto";
import { chromium } from "playwright";
import WebSocket from "ws";

const SOCKET_PATH = process.env.PCG_PERPLEXITY_ASR_SOCKET || "/run/pcg/perplexity-asr.sock";
const MATERIAL_ROOT = path.resolve(process.env.PCG_PERPLEXITY_ASR_MATERIAL_ROOT || "/run/pcg/material-files");
const STATE_ROOT = path.resolve(process.env.PCG_PERPLEXITY_ASR_STATE_ROOT || "/run/pcg/perplexity-asr-state");
const PROFILE_DIR = path.resolve(process.env.PCG_PERPLEXITY_PROFILE_DIR || "/profile");
const START_URL = "https://www.perplexity.ai/";
const SONIOX_WS = "wss://stt-rt.soniox.com/transcribe-websocket";
const MAX_SOURCE_BYTES = 64 * 1024 * 1024;
const SAMPLE_RATE = 16000;
const AUDIO_CHUNK = 3200;
const JOB_RE = /^[0-9a-f]{64}$/;
const HANDLE_RE = /^pcgfile:([0-9a-f]{64})$/;
const SHA_RE = /^[0-9a-f]{64}$/;
const jobs = new Map();
let activeJobId = null;
let context = null;
let authPage = null;
let decoderPage = null;
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
    whole_message:true,
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
  if(context && authPage && !authPage.isClosed() && decoderPage && !decoderPage.isClosed()) return;
  browserState = "STARTING";
  browserError = null;
  try{
    await fs.mkdir(PROFILE_DIR, { recursive:true });
    context = await chromium.launchPersistentContext(PROFILE_DIR, {
      headless:true,
      viewport:{width:1280,height:900},
      locale:"fa-IR",
      args:["--no-sandbox","--disable-dev-shm-usage"],
    });
    authPage = context.pages()[0] || await context.newPage();
    await authPage.goto(START_URL, { waitUntil:"domcontentloaded", timeout:45000 });
    decoderPage = await context.newPage();
    await decoderPage.goto("about:blank");
    browserState = "READY";
  }catch(err){
    browserState = "FAILED";
    browserError = String(err?.message || err).slice(0,240);
    throw Object.assign(new Error("PERPLEXITY_BROWSER_START_FAILED"), { cause:err });
  }
}
async function credential(){
  await ensureBrowser();
  if(!String(authPage.url() || "").startsWith("https://www.perplexity.ai/")){
    await authPage.goto(START_URL, { waitUntil:"domcontentloaded", timeout:45000 });
  }
  const result = await authPage.evaluate(async()=>{
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
  if(result?.ok && result?.body?.api_key) return String(result.body.api_key);
  if(result?.status === 401 || result?.status === 403) throw new Error("PERPLEXITY_AUTH_REQUIRED");
  throw new Error("PERPLEXITY_CREDENTIAL_FAILED_" + String(result?.status || "NETWORK"));
}
async function decodeToPcm16(file){
  await ensureBrowser();
  const bytes = await fs.readFile(file);
  const b64 = bytes.toString("base64");
  const pcmB64 = await decoderPage.evaluate(async({b64, sampleRate})=>{
    const raw = atob(b64);
    const src = new Uint8Array(raw.length);
    for(let i=0;i<raw.length;i++) src[i]=raw.charCodeAt(i);
    const ctx = new AudioContext();
    const decoded = await ctx.decodeAudioData(src.buffer.slice(0));
    await ctx.close();
    const frames = Math.max(1, Math.ceil(decoded.duration * sampleRate));
    const offline = new OfflineAudioContext(1, frames, sampleRate);
    const node = offline.createBufferSource();
    node.buffer = decoded;
    node.connect(offline.destination);
    node.start(0);
    const rendered = await offline.startRendering();
    const samples = rendered.getChannelData(0);
    const out = new Uint8Array(samples.length * 2);
    const view = new DataView(out.buffer);
    for(let i=0;i<samples.length;i++){
      const v = Math.max(-1, Math.min(1, samples[i]));
      view.setInt16(i*2, v < 0 ? Math.round(v*32768) : Math.round(v*32767), true);
    }
    let bin="";
    const step=0x8000;
    for(let i=0;i<out.length;i+=step) bin += String.fromCharCode(...out.subarray(i, i+step));
    return btoa(bin);
  }, {b64, sampleRate:SAMPLE_RATE});
  return Buffer.from(pcmB64, "base64");
}
async function sonioxWholeMessage(apiKey, pcm){
  return await new Promise((resolve,reject)=>{
    const ws = new WebSocket(SONIOX_WS);
    let done=false;
    let finalTranscript="";
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
        for(let offset=0; offset<pcm.length; offset+=AUDIO_CHUNK){
          ws.send(pcm.subarray(offset, Math.min(pcm.length, offset+AUDIO_CHUNK)));
          await sleep(100);
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
            if(t?.is_final === true) finalTranscript += tt;
          }
        }
        if(o?.finished === true){
          clearTimeout(timeout);
          const text=finalTranscript.trim();
          if(!text){ finish(new Error("PERPLEXITY_ASR_EMPTY_TRANSCRIPT")); return; }
          finish(null,text);
        }
      }catch{}
    });
    ws.on("error",(err)=>{ clearTimeout(timeout); finish(Object.assign(new Error("PERPLEXITY_SONIOX_SOCKET_FAILED"),{cause:err})); });
    ws.on("close",()=>{ if(!done){ clearTimeout(timeout); finish(new Error("PERPLEXITY_SONIOX_CLOSED")); } });
  });
}
function jobKey(sourceSha256, language){
  return hash(JSON.stringify({source_sha256:sourceSha256,language:language||"fa",engine:"perplexity-session-soniox",model:"stt-rt-v4",whole_message:true}));
}
async function runJob(job){
  activeJobId=job.job_id;
  job.state="RUNNING"; job.started_at_ms=nowMs(); job.error=null; await atomicJson(path.join(STATE_ROOT,job.job_id+".json"),job);
  const started=Date.now();
  try{
    const apiKey=await credential();
    const pcm=await decodeToPcm16(job.source_path);
    const text=await sonioxWholeMessage(apiKey, pcm);
    job.state="SUCCEEDED"; job.text=text; job.inference_ms=Date.now()-started; job.completed_at_ms=nowMs(); job.error=null;
  }catch(err){
    job.state="FAILED"; job.error=String(err?.message || err).slice(0,240); job.inference_ms=Date.now()-started; job.completed_at_ms=nowMs();
  }finally{
    await atomicJson(path.join(STATE_ROOT,job.job_id+".json"),job);
    activeJobId=null;
  }
}
async function startJob(request){
  const language=String(request?.language || "fa").trim().toLowerCase();
  if(language !== "fa") throw new Error("PERPLEXITY_ASR_LANGUAGE_UNSUPPORTED");
  const sourceSha256=String(request?.sha256_hex || "").toLowerCase();
  const file=await validateMaterial(request?.material_file_handle,request?.filename,request?.size_bytes,sourceSha256);
  const id=jobKey(sourceSha256,language);
  const existing=jobs.get(id);
  if(existing) return publicJob(existing, existing.state==="SUCCEEDED");
  const persistedPath=path.join(STATE_ROOT,id+".json");
  try{
    const old=JSON.parse(await fs.readFile(persistedPath,"utf8"));
    if(old?.state==="SUCCEEDED" && old?.source_sha256===sourceSha256){ jobs.set(id,old); return publicJob(old,true); }
  }catch{}
  const job={job_id:id,state:"QUEUED",source_sha256:sourceSha256,source_size_bytes:request.size_bytes,source_path:file,source_filename:request.filename,language_requested:language,text:"",inference_ms:null,error:null,created_at_ms:nowMs()};
  jobs.set(id,job); await atomicJson(persistedPath,job);
  runJob(job).catch(()=>{});
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
    active_job_id:activeJobId,
    jobs_known:jobs.size,
  };
}
async function dispatch(request){
  const op=String(request?.op || "");
  if(op==="health") return await health();
  if(op==="transcribe.start") return await startJob(request);
  if(op==="transcribe.status") return await statusJob(request);
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
ensureBrowser().catch(()=>{});
