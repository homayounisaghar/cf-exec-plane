import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { decodeToPcm16 } from "./pcg_ffmpeg_decode.mjs";

const ffmpeg=process.env.TEST_FFMPEG_BIN || "ffmpeg";
function run(args){const x=spawnSync(ffmpeg,["-hide_banner","-loglevel","error","-nostdin","-y",...args],{timeout:25000});assert.equal(x.status,0, String(x.stderr));}
const dir=fs.mkdtempSync(path.join(os.tmpdir(),"pcg-video-qa-"));
process.on("exit",()=>fs.rmSync(dir,{recursive:true,force:true}));
function file(name){return path.join(dir,name);}

test("MP4 with AAC soundtrack produces first audio track as 16kHz mono PCM, not a WAV/MP3 intermediate",async()=>{
 const p=file("with-audio.mp4");
 run(["-f","lavfi","-i","color=c=black:s=64x64:r=5:d=2","-f","lavfi","-i","sine=frequency=440:sample_rate=44100:duration=2",
   "-shortest","-c:v","mpeg4","-c:a","aac",p]);
 const pcm=await decodeToPcm16(p,{binary:ffmpeg});
 assert.equal(pcm.length%2,0);
 assert.ok(pcm.length>60000 && pcm.length<68000,pcm.length);
 assert.equal(pcm.subarray(0,4).toString("ascii")==="RIFF",false);
 assert.ok(!fs.existsSync(file("with-audio.wav")));
});
test("a video lacking audio tracks returns explicit MEDIA_NO_AUDIO_TRACK",async()=>{
 const p=file("silent.mp4");
 run(["-f","lavfi","-i","color=c=black:s=64x64:r=5:d=1","-c:v","mpeg4",p]);
 await assert.rejects(decodeToPcm16(p,{binary:ffmpeg}),{code:"MEDIA_NO_AUDIO_TRACK"});
});
test("corrupted source returns MEDIA_AUDIO_DECODE_FAILED, not a fabricated transcript",async()=>{
 const p=file("corrupt.mp4");fs.writeFileSync(p,"not a media file");
 await assert.rejects(decodeToPcm16(p,{binary:ffmpeg}),{code:"MEDIA_AUDIO_DECODE_FAILED"});
});
test("WAV, MP3, Opus OGG and WebM audio share same PCM decoder",async()=>{
 const formats=[["speech.wav","pcm_s16le"],["speech.mp3","libmp3lame"],["speech.ogg","libopus"],["speech.webm","libopus"]];
 for(const [name,codec] of formats){
  const p=file(name);run(["-f","lavfi","-i","sine=frequency=540:duration=1","-c:a",codec,p]);
  const pcm=await decodeToPcm16(p,{binary:ffmpeg});
  assert.ok(pcm.length>25000 && pcm.length<38000,`${name}: ${pcm.length}`);
 }
});
