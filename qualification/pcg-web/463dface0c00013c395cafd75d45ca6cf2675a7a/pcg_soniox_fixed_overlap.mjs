// Fixed-time slicing and deterministic DP lexical merging; no VAD, no ASR timestamps.
import {mergeWordAligned} from './pcg_soniox_word_align_dp.mjs';
const SAMPLE_RATE = 16000;
const BYTES_PER_SAMPLE = 2;
const FIRST_END = 8.5;
const SECOND_START = 5.5;
const STEP_SECONDS = 7;
const NORMAL_DURATION = 10;
const MIN_TAIL_SECONDS = 5;
const MAX_CONCURRENT = 514;
/** Implements requested exact windows (seconds):
 * #1 [0,8.5], #2 [5.5,15.5], #3 [12.5,22.5], ...
 * Adjacent overlap = 3s. A final chunk <=5s is folded into its predecessor.
 * No silence / signal analysis or repositioning. Example: 23.5s -> [0,8.5], [5.5,15.5], [12.5,23.5].
 */
export function planFixed(pcm, {rate=SAMPLE_RATE,maxConcurrent=MAX_CONCURRENT}={}) {
 if(!Buffer.isBuffer(pcm) || !pcm.length || pcm.length%2)throw Error("Expected PCM16 buffer");
 if(!Number.isInteger(rate)||rate<=0)throw Error("Invalid sample rate");
 if(!Number.isInteger(maxConcurrent)||maxConcurrent<1||maxConcurrent>MAX_CONCURRENT)throw Error("maxConcurrent must be 1..514");
 const samples=pcm.length/BYTES_PER_SAMPLE, duration=samples/rate;
 let windows=[{start:0,end:Math.min(duration,FIRST_END)}];
 for(let start=SECOND_START;start<duration;start+=STEP_SECONDS) {
   let end=Math.min(duration,start+NORMAL_DURATION);
   // User's 23.5-second example explicitly merges a final 5-second chunk.
   if(end-start<=MIN_TAIL_SECONDS+1e-8) {
     windows[windows.length-1].end=duration;
     break;
   }
   windows.push({start,end});
   if(end>=duration)break;
 }
 const segments=windows.map((w,i)=>{
   const lo=Math.round(w.start*rate),hi=Math.min(samples,Math.round(w.end*rate));
   return {index:i+1,start_seconds:lo/rate,end_seconds:hi/rate,duration_seconds:(hi-lo)/rate,byte_start:lo*2,byte_end:hi*2,batch:Math.floor(i/maxConcurrent)+1};
 });
 if(segments[0].byte_start!==0||segments.at(-1).byte_end!==pcm.length)throw Error("Source coverage failure");
 for(let i=1;i<segments.length;i++)if(segments[i].byte_start>segments[i-1].byte_end)throw Error("Source audio gap");
 return {duration_seconds:duration,requested_max_concurrency:maxConcurrent,actual_parts:segments.length,batches:Math.ceil(segments.length/maxConcurrent),segments};
}
/** One shared credential, up to 256 concurrent WebSockets per batch.
 * Each next batch begins after the previous batch has finished.
 */
export async function runFixed(pcm,{maxConcurrent=MAX_CONCURRENT,getCredential,transcribeWithKey}={}) {
 if(typeof getCredential!=="function"||typeof transcribeWithKey!=="function")throw Error("Missing credential or Soniox transcriber");
 const plan=planFixed(pcm,{maxConcurrent});
 const apiKey=await getCredential();
 if(typeof apiKey!=="string"||!apiKey)throw Error("No Soniox credential");
 const results=[];
 const started=Date.now();
 for(let offset=0;offset<plan.segments.length;offset+=maxConcurrent){
   const batch=plan.segments.slice(offset,offset+maxConcurrent);
   const settled=await Promise.allSettled(batch.map(async seg=>{
     const raw=await transcribeWithKey(apiKey,pcm.subarray(seg.byte_start,seg.byte_end),seg);
     const text=typeof raw==="string"?raw:raw?.text;
     if(!String(text??"").trim())throw Error("Empty transcript");
     return {index:seg.index,text:String(text).trim()};
   }));
   const failures=settled.map((x,i)=>x.status==="rejected"?{index:batch[i].index,error:String(x.reason?.message??x.reason)}:null).filter(Boolean);
   if(failures.length) {
     const err=new Error("Soniox batch "+(1+Math.floor(offset/maxConcurrent))+" failed: "+JSON.stringify(failures));
     err.failures=failures;err.completed_parts=results.length+settled.filter(x=>x.status==="fulfilled").length;throw err;
   }
   results.push(...settled.map(x=>x.value));
 }
 const merged=mergeWordAligned(results,plan.segments);
 return {plan,parts:results,merged,workers_elapsed_ms:Date.now()-started};
}
