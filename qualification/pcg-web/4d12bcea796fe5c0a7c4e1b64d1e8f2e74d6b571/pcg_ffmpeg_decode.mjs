import { spawn } from "node:child_process";
import path from "node:path";

/**
 * Decode audio using a pinned native FFmpeg binary instead of Chromium.
 * One shared buffer is used by the existing immutable fixed-window segmenter.
 */
const SAMPLE_RATE=16000;
const MAX_PCM_BYTES=256*1024*1024;
const FFMPEG_TIMEOUT_MS=120000;
const DEFAULT_BIN=path.join(process.cwd(),"node_modules","@ffmpeg-installer","linux-arm64","ffmpeg");

export async function decodeToPcm16(file,{binary=process.env.PCG_ASR_FFMPEG_BIN||DEFAULT_BIN}={}){
  if(typeof file!=="string"||!file) throw Error("ASR_DECODE_SOURCE_INVALID");
  return await new Promise((resolve,reject)=>{
    const args=["-nostdin","-v","error","-threads","1","-i",file,
      "-vn","-ac","1","-ar",String(SAMPLE_RATE),"-f","s16le","-acodec","pcm_s16le","pipe:1"];
    const child=spawn(binary,args,{stdio:["ignore","pipe","pipe"]});
    const blocks=[];
    let bytes=0,stderr="",done=false,oversize=false,timedOut=false;
    const timeout=setTimeout(()=>{timedOut=true;try{child.kill("SIGKILL")}catch{}},FFMPEG_TIMEOUT_MS);
    function finish(err,buf){
      if(done)return;done=true;clearTimeout(timeout);
      err?reject(err):resolve(buf);
    }
    child.stdout.on("data",block=>{
      bytes+=block.length;
      if(bytes>MAX_PCM_BYTES){oversize=true;child.kill("SIGKILL");return}
      blocks.push(block);
    });
    child.stderr.on("data",block=>{stderr=(stderr+String(block)).slice(-1000)});
    child.on("error",e=>finish(Error("ASR_FFMPEG_START_FAILED: "+e.code)));
    child.on("close",code=>{
      if(timedOut)return finish(Error("ASR_FFMPEG_DECODE_TIMEOUT"));
      if(oversize)return finish(Error("ASR_PCM_DURATION_TOO_LONG"));
      if(code!==0)return finish(Error("ASR_FFMPEG_DECODE_FAILED: "+String(code)));
      if(bytes===0||bytes%2)return finish(Error("ASR_FFMPEG_EMPTY_OR_ODD_PCM"));
      finish(null,Buffer.concat(blocks,bytes));
    });
  });
}
