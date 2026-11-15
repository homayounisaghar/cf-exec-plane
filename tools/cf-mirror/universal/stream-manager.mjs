// Adaptive, fresh-frame MJPEG stream for CF mirror.
// No external packages. Backpressure prevents stale-frame buildup.
import fs from 'node:fs';
export const CPU={pct:0,prev:null,memPct:1,loopLag:0};
function sample(){
  const a=fs.readFileSync('/proc/stat','utf8').split('\n')[0].trim().split(/\s+/).slice(1).map(Number);
  const idle=a[3]+(a[4]||0),tot=a.reduce((x,y)=>x+y,0);
  if(CPU.prev){const dt=tot-CPU.prev.tot,di=idle-CPU.prev.idle;if(dt>0)CPU.pct=Math.round(100*(1-di/dt));}
  CPU.prev={tot,idle};
  try{
    const mem=fs.readFileSync('/proc/meminfo','utf8');
    const total=Number(mem.match(/MemTotal:\s+(\d+)/)?.[1]);
    const available=Number(mem.match(/MemAvailable:\s+(\d+)/)?.[1]);
    if(total&&available)CPU.memPct=available/total;
  }catch{}
}
export class Stream{
 constructor(be,interval){
  this.be=be;this.ms=interval*1000;this.clients=new Set();this.last=0;
  this.pending=null;this.timer=null;this.interactiveUntil=0;
  this.frames=0;this.dropped=0;this.clientDrops=0;
 }
 add(res){
  res.writeHead(200,{'content-type':'multipart/x-mixed-replace; boundary=cfmframe',
    'cache-control':'no-store, no-cache, must-revalidate',connection:'close','x-accel-buffering':'no'});
  this.clients.add(res);
  res.on('close',()=>{this.clients.delete(res);if(!this.clients.size)this.stopSrc();});
  if(this.lastFrame)this.write(res,this.lastFrame);
  if(!this.src)this.src=this.be.startStream(f=>this.frame(f),Math.max(1,Math.round(1000/this.ms)));
 }
 write(res,frame){
  if(res.destroyed||res.writableEnded)return;
  // Never enqueue a new frame behind a backlog of old images.
  if(res.writableLength>Math.max(192*1024,frame.length*2)){this.clientDrops++;return;}
  const h=Buffer.from('--cfmframe\r\nContent-Type: image/jpeg\r\nContent-Length: '+frame.length+'\r\n\r\n');
  res.write(Buffer.concat([h,frame,Buffer.from('\r\n')]));
 }
 frame(frame){
  if(this.pending)this.dropped++;
  this.pending=frame;
  const now=Date.now();
  if(now<this.interactiveUntil){if(this.timer){clearTimeout(this.timer);this.timer=null;}this.flush();return;}
  const wait=this.last+this.ms-now;
  if(wait<=0)this.flush();
  else if(!this.timer)this.timer=setTimeout(()=>{this.timer=null;this.flush();},wait);
 }
 flush(){
  if(!this.pending)return;
  const f=this.pending;this.pending=null;this.last=Date.now();
  this.lastFrame=f;this.frames++;
  for(const client of this.clients)this.write(client,f);
 }
 noteInput(){
  // Pending frame can predate the cursor move. Wait for the next capture,
  // then deliver it immediately instead of waiting for the next throttle slot.
  this.pending=null;
  if(this.timer){clearTimeout(this.timer);this.timer=null;}
  this.last=0;
  this.interactiveUntil=Date.now()+400;
 }
 stopSrc(){
  if(this.src){try{this.src();}catch{}this.src=null;}
  if(this.timer){clearTimeout(this.timer);this.timer=null;}
  this.pending=null;
 }
 setRate(sec){
  if(Math.abs(sec*1000-this.ms)<1)return;
  this.ms=sec*1000;
  console.log(new Date().toISOString(),'rate',sec,'cpu',CPU.pct,'memAvailablePct',CPU.memPct.toFixed(3),'slowDrops',this.clientDrops);
  if(this.src){this.stopSrc();this.src=this.be.startStream(f=>this.frame(f),Math.max(1,Math.round(1000/this.ms)));}
  this.be.ackDelay=this.ms;
 }
}
export function autoRate(stream){
 // 15fps green; 10fps normal / RAM pressure; 5fps under heavy load.
 const L=[0.0667,0.1,0.2];let i=1,calm=0,previousDrops=0;
 stream.be.level=i;sample();
 let previous=Date.now();
 const tick=setInterval(()=>{
  const now=Date.now();CPU.loopLag=Math.max(0,now-previous-3000);previous=now;
  sample();
  const recentDrops=stream.clientDrops-previousDrops;previousDrops=stream.clientDrops;
  const severe=CPU.pct>=80||CPU.loopLag>120||recentDrops>12||CPU.memPct<0.025;
  const moderate=CPU.pct>=52||CPU.loopLag>45||recentDrops>2||CPU.memPct<0.12;
  const target=severe?2:moderate?1:0;
  if(target>i){i=target;calm=0;stream.be.level=i;stream.setRate(L[i]);}
  else if(target<i&&++calm>=5){i--;calm=0;stream.be.level=i;stream.setRate(L[i]);}
  else if(target===i)calm=0;
 },3000);
 tick.unref();
}
