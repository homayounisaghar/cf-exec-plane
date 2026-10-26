import net from "node:net";
import fs from "node:fs";
import crypto from "node:crypto";
import {setTimeout as delay} from "node:timers/promises";

const [shortSha,shortSizeRaw,longSha,longSizeRaw]=process.argv.slice(2);
if(![shortSha,longSha].every(v=>/^[a-f0-9]{64}$/.test(v||"")))
 throw Error("BATCH20_SMOKE_SHA_INVALID");
const shortSize=Number(shortSizeRaw),longSize=Number(longSizeRaw);
if(![shortSize,longSize].every(n=>Number.isSafeInteger(n)&&n>0))
 throw Error("BATCH20_SMOKE_SIZE_INVALID");
const socketPath="/run/pcg/perplexity-asr.sock";
async function call(payload){
 return await new Promise((resolve,reject)=>{
  const s=net.createConnection({path:socketPath});
  let buffer="",done=false;
  const timeout=setTimeout(()=>finish(Error("BATCH20_ASR_SOCKET_TIMEOUT")),25000);
  function finish(err,value){
    if(done)return;done=true;clearTimeout(timeout);s.destroy();
    err?reject(err):resolve(value);
  }
  s.setEncoding("utf8");
  s.on("connect",()=>s.write(JSON.stringify(payload)+"\n"));
  s.on("data",chunk=>{
    buffer+=chunk;
    if(buffer.length>8*1024*1024)return finish(Error("BATCH20_ASR_RESPONSE_OVERSIZE"));
    const nl=buffer.indexOf("\n");
    if(nl<0)return;
    try{finish(null,JSON.parse(buffer.slice(0,nl)))}catch{finish(Error("BATCH20_INVALID_JSON"))}
  });
  s.on("error",finish);
 });
}
const files=[
 ...Array.from({length:17},(_,i)=>({
    client_id:"short-"+String(i+1).padStart(2,"0"),
    material_file_handle:"pcgfile:"+shortSha,
    filename:"batch20-short.ogg",size_bytes:shortSize,sha256_hex:shortSha,
    language:"fa",speed_factor:4,parallelism:514,
 })),
 ...Array.from({length:3},(_,i)=>({
    client_id:"long-"+String(i+1).padStart(2,"0"),
    material_file_handle:"pcgfile:"+longSha,
    filename:"batch20-long.ogg",size_bytes:longSize,sha256_hex:longSha,
    language:"fa",speed_factor:4,parallelism:514,
 })),
];
const started=Date.now();
const accepted=await call({op:"transcribe.batch.start",files});
if(accepted?.ok!==true || !/^[0-9a-f]{64}$/.test(accepted?.batch_id||""))
 throw Error("BATCH20_START_REJECTED "+String(accepted?.error||""));
const id=accepted.batch_id;
fs.writeFileSync("/run/pcg/r135-last-batch-id-private",id+"\n",{mode:0o600});
if(accepted.files_total!==20||new Set(accepted.files.map(f=>f.job_id)).size!==20)
 throw Error("BATCH20_DUPLICATE_OR_MISSING_IDS");
const deadline=Date.now()+250000;
let current=accepted,checks=0,peakObservedRunning=0,shortCompletedBeforeLongSecond=false;
while(["QUEUED","RUNNING"].includes(current.state) && Date.now()<deadline){
 await delay(700);
 current=await call({op:"transcribe.batch.status",batch_id:id});
 checks++;
 peakObservedRunning=Math.max(peakObservedRunning,current.files_running||0);
 const completedShort=current.files.filter(f=>f.client_id.startsWith("short-")&&f.state==="SUCCEEDED").length;
 const someLongInSecond=current.files.some(f=>f.client_id.startsWith("long-")&&f.second_batch_started_at_ms);
 if(completedShort===17&&!someLongInSecond)shortCompletedBeforeLongSecond=true;
 if(checks%15===0)console.log("BATCH20_E2E_PROGRESS "+JSON.stringify({
  elapsed_ms:Date.now()-started,files_succeeded:current.files_succeeded,
  files_running:current.files_running,global_peak_sockets:current.peak_global_websockets,
 }));
}
if(current.state!=="SUCCEEDED")throw Error("BATCH20_NOT_ALL_SUCCEEDED "+JSON.stringify({
  state:current.state,ok:current.ok,error:current.error,
  files_succeeded:current.files_succeeded,files_failed:current.files_failed,
  file_errors:current.files.filter(f=>f.state==="FAILED").map(f=>({client_id:f.client_id,error:f.error})).slice(0,5),
 }));
if(current.files.length!==20||current.files_succeeded!==20||current.files_failed!==0)
 throw Error("BATCH20_RESULT_COUNT_INVALID");
const shorts=current.files.filter(f=>f.client_id.startsWith("short-"));
const longs=current.files.filter(f=>f.client_id.startsWith("long-"));
if(shorts.length!==17||longs.length!==3)throw Error("BATCH20_GROUP_COUNT_INVALID");
if(current.peak_concurrent_files!==20||peakObservedRunning<2)
 throw Error("BATCH20_FILES_NOT_STARTED_CONCURRENTLY");
if(!(current.peak_global_websockets>0&&current.peak_global_websockets<=514))
 throw Error("BATCH20_GLOBAL_SOCKET_LIMIT_BROKEN");
for(const f of shorts){
 if(f.state!=="SUCCEEDED"||f.batches_used!==1||f.parts_total!==56||
  f.source_sha256!==shortSha||typeof f.text!=="string"||f.text.length<100||
  f.merge_method!=="classical_word_dp"||f.second_batch_started_at_ms)
  throw Error("BATCH20_SHORT_RESULT_INVALID "+f.client_id);
}
for(const f of longs){
 if(f.state!=="SUCCEEDED"||f.batches_used!==2||f.parts_total!==556||
  f.source_sha256!==longSha||typeof f.text!=="string"||f.text.length<1000||
  f.merge_method!=="classical_word_dp"||!f.second_batch_started_at_ms)
  throw Error("BATCH20_LONG_RESULT_INVALID "+f.client_id);
}
const shortCharMax=Math.max(...shorts.map(x=>x.text.length));
const longCharMin=Math.min(...longs.map(x=>x.text.length));
if(longCharMin<shortCharMax*4)throw Error("BATCH20_TRANSCRIPTS_CROSS_CONTAMINATED_OR_TRUNCATED");
const hashes=current.files.map(f=>({
 client_id:f.client_id,job_id:f.job_id,text_sha256:crypto.createHash("sha256").update(f.text).digest("hex"),
 text_characters:f.text.length,parts:f.parts_total,batches:f.batches_used,
}));
console.log("PCG_R135_REAL_20FILE_E2E_PASS "+JSON.stringify({
 source:"17_short_389sec_plus_3_long_3893sec",
 files:20,files_succeeded:20,files_failed:0,
 short_files:17,long_files:3,short_parts_each:56,long_parts_each:556,
 total_parts:17*56+3*556,
 observed_peak_files:current.peak_concurrent_files,
 global_socket_peak:current.peak_global_websockets,
 max_global_sockets:514,
 all_file_ids_unique:new Set(current.files.map(f=>f.job_id)).size===20,
 all_file_results_separate:hashes.length===20,
 second_batch_long_files:longs.filter(f=>!!f.second_batch_started_at_ms).length,
 second_batch_short_files:shorts.filter(f=>!!f.second_batch_started_at_ms).length,
 wall_ms:Date.now()-started,checks,
 short_text_min_chars:Math.min(...shorts.map(f=>f.text.length)),
 long_text_min_chars:longCharMin,
 }));
// Store only fingerprints and lengths in logs, not transcripts/audio.
