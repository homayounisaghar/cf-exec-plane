// Minimal RFC6455 text WebSocket server (Node stdlib only).
// Used strictly on CF mirror's loopback-bound HTTP servers.
// Small messages, bounded buffer, required masking, ping/pong and close.
import crypto from 'node:crypto';
const GUID='258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
export function rejectUpgrade(socket,status=403){
 if(socket.destroyed)return;
 const reasons={400:'Bad Request',401:'Unauthorized',403:'Forbidden',404:'Not Found',410:'Gone',426:'Upgrade Required',502:'Bad Gateway'};
 const label=reasons[status]||'Forbidden';
 socket.end('HTTP/1.1 '+status+' '+label+'\r\nConnection: close\r\nContent-Type: text/plain\r\nContent-Length: 0\r\n\r\n');
}
function makeFrame(op,payload){
 const b=Buffer.isBuffer(payload)?payload:Buffer.from(String(payload||''));
 const l=b.length;
 if(l>65535)throw Error('oversized websocket send');
 const hd=l<126?Buffer.from([0x80|op,l]):Buffer.from([0x80|op,126,l>>8,l&255]);
 return Buffer.concat([hd,b]);
}
export function acceptWebSocket(req,socket,head={length:0},{protocol='cfm-input',onText=()=>{},onBinary=null,onClose=()=>{},maxFrameBytes=8192}={}){
 if(socket.destroyed)return null;
 const key=String(req.headers['sec-websocket-key']||'');
 if(String(req.headers.upgrade||'').toLowerCase()!=='websocket'||
    String(req.headers['sec-websocket-version']||'')!=='13'||
    !/^[A-Za-z0-9+/]{22}==$/.test(key)||
    Buffer.from(key,'base64').length!==16){rejectUpgrade(socket,400);return null;}
 const accept=crypto.createHash('sha1').update(key+GUID).digest('base64');
 socket.setNoDelay(true);
 socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: '+accept+'\r\n'+(protocol?'Sec-WebSocket-Protocol: '+protocol+'\r\n':'')+'\r\n');
 let closed=false,buf=Buffer.alloc(0),closeNotified=false;
 const notifyClose=()=>{if(closeNotified)return;closeNotified=true;try{onClose();}catch{}};
 const obj={
  send(data){
   if(closed||socket.destroyed||socket.writableLength>64*1024)return false;
   try{return socket.write(makeFrame(1,typeof data==='string'?data:JSON.stringify(data)));}catch{return false;}
  },
  close(code=1000){
   if(closed)return;
   closed=true;
   try{const payload=Buffer.alloc(2);payload.writeUInt16BE(code);socket.write(makeFrame(8,payload));}catch{}
   socket.end();
   setTimeout(()=>{if(!socket.destroyed)socket.destroy();},400).unref();
  },
  get bufferedAmount(){return socket.writableLength;},
  get open(){return !closed&&!socket.destroyed;}
 };
 socket.on('end',()=>{
  // Upgraded HTTP sockets can remain in CLOSE-WAIT after the phone disconnects.
  // Treat the peer FIN as a security-relevant disconnect immediately, not
  // just a transport half-close (especially for armed microphone sessions).
  closed=true;notifyClose();socket.destroy();
 });
 socket.on('close',()=>{closed=true;notifyClose();});
 socket.on('error',()=>{if(!closed)obj.close(1011);else notifyClose();});
 socket.on('data',chunk=>{
  if(closed)return;
  buf=Buffer.concat([buf,chunk]);
  if(buf.length>Math.max(32768,maxFrameBytes+64)){obj.close(1009);return;}
  while(buf.length>=2&&!closed){
   const b0=buf[0],b1=buf[1],op=b0&15,masked=!!(b1&128),fin=!!(b0&128);
   let length=b1&127,off=2;
   if(!fin||(b0&0x70)!==0||!masked||op===0){obj.close(1002);return;}
   if(length===126){
    if(buf.length<4)return;
    length=buf.readUInt16BE(2);off=4;
   }else if(length===127){
     if(buf.length<10)return;
     const lenBig=buf.readBigUInt64BE(2);
     if(lenBig>BigInt(maxFrameBytes)){obj.close(1009);return;}
     length=Number(lenBig);off=10;
   }
   if(length>maxFrameBytes){obj.close(1009);return;}
   if(buf.length<off+4+length)return;
   const mask=buf.subarray(off,off+4);
   const payload=Buffer.from(buf.subarray(off+4,off+4+length));
   buf=buf.subarray(off+4+length);
   for(let i=0;i<payload.length;i++)payload[i]^=mask[i&3];
   if(op===8){obj.close(1000);return;}
   if(op===9){socket.write(makeFrame(10,payload));continue;}
   if(op===10)continue;
   if(op===2){
    if(!onBinary){obj.close(1003);return;}
    try{onBinary(payload,obj);}catch{obj.close(1011);return;}
    continue;
   }
   if(op!==1){obj.close(1003);return;}
   if(payload.length>1024){obj.close(1009);return;}
   try{onText(payload.toString('utf8'),obj);}catch{obj.close(1003);return;}
  }
 });
 if(head?.length)socket.emit('data',head);
 return obj;
}
