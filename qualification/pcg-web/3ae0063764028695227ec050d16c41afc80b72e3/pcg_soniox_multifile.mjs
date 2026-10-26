/**
 * Fair, bounded multi-file Soniox orchestration.
 * 20 independent documents, 514 global active WebSockets, 514 per file/batch.
 * Duplicate source bytes share PCM decoding, NEVER transcription job/results.
 */
import {runFixed} from "./pcg_soniox_fixed_overlap.mjs";

export const MAX_FILES_PER_BATCH=20;
export const GLOBAL_WS_LIMIT=514;

export class FairSocketPool {
  constructor({maxSockets=GLOBAL_WS_LIMIT,maxFiles=MAX_FILES_PER_BATCH}={}){
    if(!Number.isInteger(maxSockets)||maxSockets<1||maxSockets>514)throw Error("POOL_SOCKET_LIMIT_INVALID");
    if(!Number.isInteger(maxFiles)||maxFiles<1||maxFiles>20)throw Error("POOL_FILE_LIMIT_INVALID");
    this.maxSockets=maxSockets;this.maxFiles=maxFiles;
    this.jobs=new Map();
    this.live=0;this.peak=0;this.roundRobin=0;
    this.totalAcquisitions=0;this.totalReleases=0;
  }
  register(id){
    if(this.jobs.has(id))throw Error("POOL_DUPLICATE_JOB");
    if(this.jobs.size>=this.maxFiles)throw Error("POOL_FILE_LIMIT_EXCEEDED");
    this.jobs.set(id,{id,waiting:[],running:0,peak:0,completed:0,acquired:0});
    this.drain();
  }
  unregister(id){
    const job=this.jobs.get(id);
    if(!job)throw Error("POOL_UNKNOWN_JOB");
    if(job.running||job.waiting.length)throw Error("POOL_JOB_NOT_DRAINED");
    this.jobs.delete(id);
    this.drain();
  }
  async permit(id){
    const job=this.jobs.get(id);
    if(!job)throw Error("POOL_JOB_NOT_REGISTERED");
    await new Promise(resolve=>{job.waiting.push(resolve);this.drain();});
    let released=false;
    return ()=>{
      if(released)throw Error("POOL_DOUBLE_RELEASE");
      released=true;
      const j=this.jobs.get(id);
      if(!j)throw Error("POOL_JOB_UNREGISTERED_WITH_ACTIVE_SOCKET");
      j.running--;j.completed++;this.totalReleases++;this.live--;
      this.drain();
    };
  }
  drain(){
    if(this.live>=this.maxSockets||!this.jobs.size)return;
    const ids=Array.from(this.jobs.keys());
    let progress=true;
    while(this.live<this.maxSockets&&progress){
      progress=false;
      const base=Math.floor(this.maxSockets/ids.length);
      const extra=this.maxSockets%ids.length;
      const startIndex=this.roundRobin;
      for(let k=0;k<ids.length&&this.live<this.maxSockets;k++){
        const index=(startIndex+k)%ids.length;
        const job=this.jobs.get(ids[index]);
        if(!job)continue;
        const allowance=Math.max(1,base+(index<extra?1:0));
        if(job.waiting.length && job.running<allowance){
          const wake=job.waiting.shift();
          job.running++;job.acquired++;job.peak=Math.max(job.peak,job.running);
          this.live++;this.peak=Math.max(this.peak,this.live);
          this.totalAcquisitions++;
          this.roundRobin=(index+1)%ids.length;
          progress=true;wake();
        }
      }
    }
  }
  async withPermit(id,fn){
    const release=await this.permit(id);
    try{return await fn();}finally{release();}
  }
  snapshot(){
    return {max_sockets:this.maxSockets,active_sockets:this.live,peak_sockets:this.peak,
      registered_files:this.jobs.size,acquisitions:this.totalAcquisitions,
      releases:this.totalReleases,
      files:[...this.jobs.values()].map(j=>({id:j.id,running:j.running,peak:j.peak,waiting:j.waiting.length,completed:j.completed,acquired:j.acquired}))};
  }
}
/**
 * Call exactly once for a batch. The owner request is already validated.
 * Every entry must have a unique instance_id, even when source hashes repeat.
 * decodedPcm(sha, entry), getCredential(), transcribe(key, pcmChunk, segment, entry)
 * are injected so this module remains pure of Telegram/WhatsApp adapters.
 */
export async function runMultiFileBatch(entries,{decodedPcm,getCredential,transcribe,
  maxSockets=GLOBAL_WS_LIMIT,pool=null,onFileState=()=>{},onPartStart=()=>{},onPartDone=()=>{},onProgress=()=>{}}={}){
  if(!Array.isArray(entries)||entries.length<1||entries.length>MAX_FILES_PER_BATCH)
    throw Error("ASR_BATCH_FILE_COUNT_INVALID");
  if(typeof decodedPcm!=="function"||typeof getCredential!=="function"||
     typeof transcribe!=="function")throw Error("ASR_BATCH_EXECUTOR_INVALID");
  const ids=new Set(entries.map(e=>e.instance_id));
  if(ids.size!==entries.length||[...ids].some(v=>typeof v!=="string"||!v))
    throw Error("ASR_BATCH_INSTANCE_IDS_INVALID");
  pool=pool||new FairSocketPool({maxSockets,maxFiles:MAX_FILES_PER_BATCH});
  if(pool.jobs.size+entries.length>MAX_FILES_PER_BATCH)throw Error("ASR_BATCH_ACTIVE_FILE_LIMIT_EXCEEDED");
  for(const e of entries)pool.register(e.instance_id);
  const decodeCache=new Map();
  // One short-lived credential per batch, shared by every file. Never expose it.
  let credentialPromise=null;
  const cred=()=>credentialPromise??(credentialPromise=Promise.resolve().then(getCredential));
  const decode=e=>{
    const key=e.sha256_hex;
    if(!decodeCache.has(key))decodeCache.set(key,Promise.resolve().then(()=>decodedPcm(e)));
    return decodeCache.get(key);
  };
  let peakConcurrentFiles=0,runningFiles=0,completedFiles=0;
  const perFile=entries.map(async e=>{
    runningFiles++;peakConcurrentFiles=Math.max(peakConcurrentFiles,runningFiles);
    onFileState(e,"RUNNING");
    let completedParts=0;
    try{
      const pcm=await decode(e);
      const result=await runFixed(pcm,{
        maxConcurrent:e.parallelism,
        getCredential:cred,
        transcribeWithKey:async(key,chunk,segment)=>{
          return pool.withPermit(e.instance_id,async()=>{
            onPartStart(e,{part:segment.index,batch:segment.batch});
            const reply=await transcribe(key,chunk,segment,e);
            completedParts++;
            onPartDone(e,{part:segment.index,batch:segment.batch,completed_parts:completedParts});
            return reply;
          });
        },
      });
      const value={instance_id:e.instance_id,ok:true,state:"SUCCEEDED",text:result.merged.text,
        parts_total:result.plan.actual_parts,batches_used:result.plan.batches,
        parallelism_used:Math.min(e.parallelism,result.plan.actual_parts),
        duration_seconds:result.plan.duration_seconds,unmatched_seams:result.merged.unmatched,
        merge_method:result.merged.method,completed_parts:completedParts,
        source_sha256:e.sha256_hex};
      onFileState(e,"SUCCEEDED",value);
      return value;
    }catch(error){
      const value={instance_id:e.instance_id,ok:false,state:"FAILED",error:String(error?.message||error).slice(0,240),
        completed_parts:completedParts,source_sha256:e.sha256_hex};
      onFileState(e,"FAILED",value);
      return value;
    }finally{
      runningFiles--;completedFiles++;
      pool.unregister(e.instance_id);
      onProgress({running_files:runningFiles,completed_files:completedFiles,peak_concurrent_files:peakConcurrentFiles});
    }
  });
  const results=await Promise.all(perFile);
  const socketStats=pool.snapshot();
  const failures=results.filter(r=>!r.ok).length;
  return {ok:failures===0,results,files_total:entries.length,files_succeeded:results.length-failures,
    files_failed:failures,peak_concurrent_files:peakConcurrentFiles,
    global_socket_peak:socketStats.peak_sockets,total_socket_acquisitions:socketStats.acquisitions};
}
