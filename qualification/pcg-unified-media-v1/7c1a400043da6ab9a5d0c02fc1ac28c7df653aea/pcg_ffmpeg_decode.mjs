import { spawn } from "node:child_process";
import path from "node:path";

// Retain the qualified Soniox fixed-window input API. Keep compressed source
// bytes unchanged and decode only its first real audio track; no MP3/WAV file.
const SAMPLE_RATE=16000;
const MAX_PCM_BYTES=256*1024*1024;
const FFMPEG_TIMEOUT_MS=120000;
const DEFAULT_BIN=path.join(process.cwd(),"node_modules","@ffmpeg-installer","linux-arm64","ffmpeg");

function codedError(code) { return Object.assign(new Error(code),{code}); }

export async function decodeToPcm16(file,{binary=process.env.PCG_ASR_FFMPEG_BIN||DEFAULT_BIN}={}){
  if(typeof file!=="string"||!file)throw codedError("ASR_DECODE_SOURCE_INVALID");
  return await new Promise((resolve,reject)=>{
    const args=["-nostdin","-v","error","-threads","1","-i",file,
      "-map","0:a:0","-vn","-ac","1","-ar",String(SAMPLE_RATE),
      "-f","s16le","-acodec","pcm_s16le","pipe:1"];
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
      if(bytes>MAX_PCM_BYTES){oversize=true;try{child.kill("SIGKILL")}catch{};return;}
      blocks.push(block);
    });
    child.stderr.on("data",block=>{stderr=(stderr+String(block)).slice(-4000);});
    child.on("error",()=>finish(codedError("MEDIA_FFMPEG_START_FAILED")));
    child.on("close",code=>{
      if(timedOut)return finish(codedError("MEDIA_AUDIO_DECODE_TIMEOUT"));
      if(oversize)return finish(codedError("MEDIA_PCM_LIMIT_EXCEEDED"));
      if(code!==0){
        const noTrack=/stream map[^\n]*matches no streams|does not contain any stream|matches no streams|could not find codec parameters for stream.*audio/i.test(stderr);
        return finish(codedError(noTrack?"MEDIA_NO_AUDIO_TRACK":"MEDIA_AUDIO_DECODE_FAILED"));
      }
      if(bytes===0||bytes%2)return finish(codedError("MEDIA_AUDIO_EMPTY_OR_INVALID_PCM"));
      finish(null,Buffer.concat(blocks,bytes));
    });
  });
}
