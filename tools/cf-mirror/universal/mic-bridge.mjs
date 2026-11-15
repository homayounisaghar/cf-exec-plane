// Demand-driven phone microphone bridge for CF universal mirror.
// Does NOT record, persist, or transmit audio until a matching remote app
// actually opens a PulseAudio recording stream on the virtual microphone.
// No root operations, extra public ports or changes to PulseAudio defaults.
import fs from 'node:fs';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
const execFileAsync=promisify(execFile);
const PULSE_SERVER=process.env.CF_MIRROR_PULSE_SERVER||'unix:/run/user/'+process.getuid()+'/pulse/native';
const VIRTUAL_SOURCE=process.env.CF_MIRROR_MIC_SOURCE||'cf_wechat_preboot_mic';
const VIRTUAL_SINK=process.env.CF_MIRROR_MIC_SINK||'cf_wechat_preboot_sink';
const AUDIO_ENV={...process.env,PULSE_SERVER};

function matchesApp(pid,source){
 if(!Number.isSafeInteger(pid)||pid<2)return false;
 try{
  const env=fs.readFileSync('/proc/'+pid+'/environ','utf8').split('\0');
  if(source?.kind==='x11')return env.includes('DISPLAY='+source.display);
  if(source?.kind==='cdp'){
   // Check the app's process ancestry for the selected CDP port.
   let current=pid;
   for(let i=0;i<12&&current>1;i++){
    const args=fs.readFileSync('/proc/'+current+'/cmdline','utf8').replace(/\0/g,' ');
    if(args.includes('--remote-debugging-port='+source.port))return true;
    const st=fs.readFileSync('/proc/'+current+'/status','utf8');
    current=Number(st.match(/^PPid:\s+(\d+)/m)?.[1]||0);
   }
  }
 }catch{}
 return false;
}
async function pactlJson(subject,timeout=1400){
 const {stdout}=await execFileAsync('pactl',['--format=json','list',subject],{
  env:AUDIO_ENV,timeout,maxBuffer:256*1024
 });
 return JSON.parse(stdout);
}
export class MicBridge{
 constructor(source){
  this.source=source;this.ws=null;this.armed=false;this.active=false;
  this.timer=null;this.inPoll=false;this.ffmpeg=null;this.pacat=null;
  this.bytes=0;this.dropped=0;this.sourceIds=new Set();
  this.available=false;this.lastError='';this.armRevision=0;
 }
 send(message){if(this.ws?.open)this.ws.send(message);}
 async inspect(){
  try{
   const [sources,sinks]=await Promise.all([pactlJson('sources'),pactlJson('sinks')]);
   const match=sources.find(x=>x.name===VIRTUAL_SOURCE);
   const monitor=sources.find(x=>x.name===VIRTUAL_SINK+'.monitor');
   const sink=sinks.find(x=>x.name===VIRTUAL_SINK);
   this.available=!!(match&&monitor&&sink);
   this.sourceIds=new Set([match?.index,monitor?.index].filter(Number.isInteger));
   this.lastError=this.available?'':'Virtual PulseAudio microphone unavailable';
  }catch(e){this.available=false;this.lastError='PulseAudio connection unavailable';}
  return this.available;
 }
 status(){
  return{available:this.available,armed:this.armed,recording:this.active,
         source:this.available?VIRTUAL_SOURCE:null,bytes:this.bytes,dropped:this.dropped};
 }
 async setArmed(armed,sender=this.ws){
  const revision=++this.armRevision;
  if(!armed){
   this.armed=false;this.active=false;this.stopAudio();
   this.clearPoll();this.send({t:'standby-off'});return;
  }
  const available=await this.inspect();
  // Permission/sink preflight is async: the user may have disarmed or the
  // browser may have disconnected before it completes. Never re-arm a stale
  // connection (especially after pagehide/network loss).
  if(this.armRevision!==revision||this.ws!==sender||!sender?.open)return;
  if(!available){
   this.armed=false;this.send({t:'mic-error',message:this.lastError});return;
  }
  this.armed=true;
  this.send({t:'standby',source:VIRTUAL_SOURCE});
  this.poll();
  if(!this.timer){
   this.timer=setInterval(()=>this.poll(),360);
   this.timer.unref();
  }
 }
 async poll(){
  if(!this.armed||!this.ws?.open||this.inPoll)return;
  this.inPoll=true;
  const revision=this.armRevision;
  try{
   const outs=await pactlJson('source-outputs');
   // An OFF command or websocket disconnect can arrive during this async poll.
   // Never start capturing based on an obsolete remote app state.
   if(!this.armed||!this.ws?.open||this.armRevision!==revision)return;
   const requesting=outs.some(o=>{
    const props=o.properties||{};
    const pid=Number(props['application.process.id']||0);
    return this.sourceIds.has(o.source)&&o.driver!=='module-remap-source.c'&&
           matchesApp(pid,this.source);
   });
   if(requesting&&!this.active){
    this.active=true;
    this.startAudio();
    this.send({t:'capture-needed'});
   }else if(!requesting&&this.active){
    this.active=false;this.stopAudio();this.send({t:'capture-stop'});
   }
  }catch{
   if(this.active){this.active=false;this.stopAudio();this.send({t:'capture-stop'});}
   this.lastError='PulseAudio monitor temporarily unavailable';
  }finally{this.inPoll=false;}
 }
 startAudio(){
  this.stopAudio();
  const ff=spawn('ffmpeg',['-hide_banner','-loglevel','error','-f','webm','-i','pipe:0',
    '-f','s16le','-ar','48000','-ac','1','pipe:1'],{
     env:AUDIO_ENV,stdio:['pipe','pipe','ignore']
  });
  const pacat=spawn('pacat',['--playback','--raw','--rate=48000','--channels=1',
     '--format=s16le','--device='+VIRTUAL_SINK,'--latency-msec=80'],{
     env:AUDIO_ENV,stdio:['pipe','ignore','ignore']
  });
  // Audio goes to an existing PulseAudio null sink whose MONITOR is the
  // server's virtual mic. No browser or PCM data is written to disk.
  ff.stdout.pipe(pacat.stdin);
  this.ffmpeg=ff;this.pacat=pacat;
  for(const child of [ff,pacat]){
   child.on('error',()=>{if(this.active)this.send({t:'mic-error',message:'Audio codec or virtual sink failed'});});
  }
  pacat.stdin.on('error',()=>{});
  ff.stdin.on('error',()=>{});
 }
 pushAudio(data){
  if(!this.armed||!this.active||!this.ffmpeg?.stdin?.writable)return;
  if(data.length>128*1024||this.ffmpeg.stdin.writableLength>256*1024){
   this.dropped++;return;
  }
  this.bytes+=data.length;
  try{this.ffmpeg.stdin.write(data);}catch{this.dropped++;}
 }
 stopAudio(){
  for(const ch of [this.ffmpeg,this.pacat]){
   if(ch&&!ch.killed){try{ch.kill('SIGTERM');}catch{}}
  }
  this.ffmpeg=null;this.pacat=null;
 }
 clearPoll(){if(this.timer){clearInterval(this.timer);this.timer=null;}}
 attach(ws){
  if(this.ws&&this.ws!==ws)this.ws.close(1001);
  this.ws=ws;
  this.armRevision++;
  this.armed=false;this.active=false;
  this.clearPoll();this.stopAudio();
  this.send({t:'mic-connected',standby:true});
 }
 async message(txt,ws){
  if(this.ws!==ws)return;
  let j;try{j=JSON.parse(txt);}catch{ws.close(1003);return;}
  if(j?.t==='arm')await this.setArmed(j.enabled===true,ws);
  else if(j?.t==='client-audio-error'){
   this.lastError=String(j.message||'Phone microphone unavailable').slice(0,180);
   this.send({t:'mic-error',message:this.lastError});
  }else ws.close(1008);
 }
 disconnect(ws){
  if(this.ws!==ws)return;
  this.armRevision++;
  this.armed=false;this.active=false;this.clearPoll();this.stopAudio();this.ws=null;
 }
 shutdown(){this.disconnect(this.ws);}
}
