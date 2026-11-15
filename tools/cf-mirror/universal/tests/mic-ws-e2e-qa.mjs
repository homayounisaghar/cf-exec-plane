import net from 'node:net';
import crypto from 'node:crypto';
import {spawn,execFileSync} from 'node:child_process';
const base='http://127.0.0.1:6200',port=6200;
const html=await(await fetch(base+'/view/')).text();
const token=html.match(/const CONTROL_CSRF='([^']+)'/)?.[1];if(!token)throw Error('Missing token');
const env={...process.env,PULSE_SERVER:'unix:/run/user/1000/pulse/native',DISPLAY:':124'};
const sourceOutputs=JSON.parse(execFileSync('pactl',['--format=json','list','source-outputs'],{env,encoding:'utf8'}));
if(sourceOutputs.some(x=>x.driver!=='module-remap-source.c'))throw Error('Other recorder active; refusing synthetic audio test');
const webm=execFileSync('ffmpeg',['-hide_banner','-loglevel','error','-f','lavfi','-i','sine=frequency=600:duration=3.0','-ac','1','-ar','48000','-c:a','libopus','-b:a','40k','-f','webm','pipe:1'],{maxBuffer:1<<20});
function frame(op,payload){
 const b=Buffer.isBuffer(payload)?payload:Buffer.from(JSON.stringify(payload));
 const hd=b.length<126?Buffer.from([0x80|op,0x80|b.length]):Buffer.from([0x80|op,0xfe,b.length>>8,b.length&255]);
 const mask=crypto.randomBytes(4),data=Buffer.from(b);
 for(let i=0;i<data.length;i++)data[i]^=mask[i%4];
 return Buffer.concat([hd,mask,data]);
}
let socket,recorder,pcmBytes=0,peak=0,events=[],audiosent=0,closed=false,started=false;
const delay=ms=>new Promise(r=>setTimeout(r,ms));
try{
 await new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>reject(Error('mic WS handshake timeout')),4500);
  socket=net.connect(port,'127.0.0.1');
  socket.on('error',reject);
  socket.on('connect',()=>{
   const key=crypto.randomBytes(16).toString('base64');
   socket.write('GET /mic-ws HTTP/1.1\r\nHost: 127.0.0.1:'+port+
    '\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: '+key+
    '\r\nSec-WebSocket-Version: 13\r\nOrigin: '+base+
    '\r\nSec-WebSocket-Protocol: cfm-mic, '+token+'\r\n\r\n');
  });
  let header=false,buf=Buffer.alloc(0);
  socket.on('data',chunk=>{
   buf=Buffer.concat([buf,chunk]);
   if(!header){const idx=buf.indexOf('\r\n\r\n');if(idx<0)return;
    const status=+buf.subarray(0,idx).toString().match(/HTTP\/1\.1 (\d+)/)?.[1];
    if(status!==101)return reject(Error('Mic WS rejected '+status));
    header=true;buf=buf.subarray(idx+4);clearTimeout(timer);resolve();
   }
   while(buf.length>=2){
    let len=buf[1]&127,off=2;
    if(len===126){if(buf.length<4)return;len=buf.readUInt16BE(2);off=4;}
    if(buf.length<off+len)return;
    const body=buf.subarray(off,off+len).toString();buf=buf.subarray(off+len);
    let m;try{m=JSON.parse(body)}catch{continue}
    events.push(m.t);
    if(m.t==='capture-needed')started=true;
   }
  });
 });
 socket.write(frame(1,{t:'arm',enabled:true}));
 for(let i=0;i<30&&!events.includes('standby');i++)await delay(70);
 if(!events.includes('standby'))throw Error('Never reached standby');
 console.log('ARMED_NO_PHONE_AUDIO',JSON.stringify((await(await fetch(base+'/info')).json()).microphone));
 recorder=spawn('parec',['-d','cf_wechat_preboot_mic','--raw','--format=s16le','--rate=48000','--channels=1','--latency-msec=30'],{env,stdio:['ignore','pipe','pipe']});
 recorder.stdout.on('data',b=>{pcmBytes+=b.length;for(let i=0;i+1<b.length;i+=2)peak=Math.max(peak,Math.abs(b.readInt16LE(i)));});
 for(let i=0;i<25&&!started;i++)await delay(100);
 if(!started)throw Error('Remote app recording demand not forwarded over WS');
 console.log('CAPTURE_NEEDED_SIGNAL_RECEIVED');
 for(let i=0;i<webm.length;i+=700){socket.write(frame(2,webm.subarray(i,i+700)));audiosent+=Math.min(700,webm.length-i);await delay(100);}
 await delay(500);
 console.log('PCM_DELIVERED',JSON.stringify({pcmBytes,peak,audiosent}));
 if(peak<100||pcmBytes<10000)throw Error('WS audio did not arrive at remote virtual mic');
 recorder.kill('SIGTERM');recorder=null;
 for(let i=0;i<25&&!events.includes('capture-stop');i++)await delay(90);
 if(!events.includes('capture-stop'))throw Error('Recorder stopped but capture-stop not sent');
 console.log('CAPTURE_STOP_SIGNAL_RECEIVED');
 socket.write(frame(1,{t:'arm',enabled:false}));
 await delay(180);
 socket.write(frame(8,Buffer.alloc(2)));socket.end();socket.destroy();closed=true;
 await delay(230);
 const info=(await(await fetch(base+'/info')).json()).microphone;
 console.log('AFTER_STOP',JSON.stringify(info));
 if(info.armed||info.recording)throw Error('Mic not disarmed');
 console.log('MIC_WS_SYNTHETIC_END_TO_END_PASS');
}catch(e){console.error('MIC_WS_E2E_FAILED',e.message);process.exitCode=1}
finally{recorder?.kill('SIGKILL');if(socket&&!closed){socket.destroy()}}
