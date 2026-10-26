import net from "node:net";
import {setTimeout as delay} from "node:timers/promises";

const [sha,filename,sizeString]=process.argv.slice(2);
if(!/^[a-f0-9]{64}$/.test(sha||"") || filename!=="r133-smoke.ogg" ||
   !Number.isSafeInteger(Number(sizeString)) || Number(sizeString)<1)
  throw Error("SMOKE_INPUT_INVALID");

const socketPath="/run/pcg/perplexity-asr.sock";
async function call(payload){
  return await new Promise((resolve,reject)=>{
    const s=net.createConnection({path:socketPath});
    let buffer="",finished=false;
    const timeout=setTimeout(()=>done(Error("ASR_SMOKE_SOCKET_TIMEOUT")),5000);
    function done(err,value){
      if(finished)return;finished=true;clearTimeout(timeout);s.destroy();
      err?reject(err):resolve(value);
    }
    s.on("connect",()=>s.write(JSON.stringify(payload)+"\n"));
    s.on("data",chunk=>{
      buffer+=String(chunk);
      if(buffer.length>4*1024*1024)return done(Error("ASR_SMOKE_RESPONSE_OVERSIZE"));
      const nl=buffer.indexOf("\n");
      if(nl<0)return;
      try{done(null,JSON.parse(buffer.slice(0,nl)))}catch{done(Error("ASR_SMOKE_BAD_JSON"))}
    });
    s.on("error",done);
  });
}
const t=Date.now();
let job=await call({op:"transcribe.start",material_file_handle:"pcgfile:"+sha,
  filename,size_bytes:Number(sizeString),sha256_hex:sha,language:"fa",speed_factor:4});
if(job?.ok!==true)throw Error("ASR_SMOKE_START_REJECTED "+String(job?.error||""));
const id=job.job_id;
if(!/^[a-f0-9]{64}$/.test(id||""))throw Error("ASR_SMOKE_NO_JOB_ID");
const deadline=Date.now()+110000;
while(["QUEUED","RUNNING"].includes(job.state) && Date.now()<deadline){
  await delay(450);
  job=await call({op:"transcribe.status",job_id:id});
}
if(job?.state!=="SUCCEEDED")
  throw Error("ASR_SMOKE_FAILED "+String(job?.state)+" "+String(job?.error||"").slice(0,220));
if(typeof job.text!=="string" || job.text.trim().length<50 ||
   Number(job.parts_total)<2 || job.merge_method!=="classical_word_dp" ||
   Number(job.parallelism_used)<2 || job.parallelism_requested!==514)
  throw Error("ASR_SMOKE_INVALID_RESULT_SHAPE");
console.log("PCG_R133_REAL_ASR_E2E_PASS "+JSON.stringify({
  text_chars:job.text.length,parts:job.parts_total,parallelism:job.parallelism_used,
  batches:job.batches_used,merge_method:job.merge_method,
  decode:"native_ffmpeg_arm64",elapsed_ms:Date.now()-t
}));
