import vm from 'node:vm';
import fs from 'node:fs';
import assert from 'node:assert/strict';
const html=fs.readFileSync(new URL('../surface.html',import.meta.url),'utf8');
const js=html.split('<script>')[1].split('</script>')[0];
const nodes=new Map(),windowHandlers=new Map(),sockets=[];
let mediaRequests=0,stopped=0,mediaStarts=0;
class El {
 constructor(id){this.id=id;this.style={};this.textContent='';this.value='';this.handlers=new Map();this.dataset={};this.naturalWidth=1400;this.naturalHeight=860;this.clientWidth=id==='stage'?390:0;this.clientHeight=id==='stage'?730:0;const set=new Set();this.classList={add(x){set.add(x)},remove(x){set.delete(x)},contains(x){return set.has(x)},toggle(x){if(set.has(x)){set.delete(x);return false;}set.add(x);return true}};}
 addEventListener(name,fn){const x=this.handlers.get(name)||[];x.push(fn);this.handlers.set(name,x);}
 click(){for(const fn of this.handlers.get('click')||[])fn({target:this,currentTarget:this,preventDefault(){}});}
 setAttribute(a,v){this[a]=v;}
 focus(){}
 blur(){}
 setPointerCapture(){}
 getBoundingClientRect(){return{left:0,top:42,width:this.clientWidth,height:this.clientHeight,right:this.clientWidth,bottom:42+this.clientHeight}}
 querySelectorAll(){return []}
 querySelector(){return new El('sub')}
}
const document={activeElement:null,getElementById(n){if(!nodes.has(n))nodes.set(n,new El(n));return nodes.get(n)}};
class FakeWS{
 constructor(url,protocols){this.url=url;this.protocols=protocols;this.readyState=0;this.sent=[];this.bufferedAmount=0;sockets.push(this);}
 send(v){this.sent.push(v)}
 close(){this.readyState=3;this.onclose?.()}
 trigger(m){this.onmessage?.({data:JSON.stringify(m)})}
}
FakeWS.OPEN=1;FakeWS.CONNECTING=0;
class FakeRecorder{
 static isTypeSupported(mime){return mime==='audio/webm;codecs=opus'}
 constructor(stream,opts){this.stream=stream;this.opts=opts;this.state='inactive';FakeRecorder.last=this;}
 start(ms){assert.equal(ms,100);this.state='recording';mediaStarts++}
 stop(){this.state='inactive';}
}
const window={
 location:{origin:'https://example.test',hostname:'example.test',protocol:'https:'},
 WebSocket:FakeWS,MediaRecorder:FakeRecorder,isSecureContext:true,
 addEventListener(n,fn){windowHandlers.set(n,fn)},
 parent:{postMessage(){}}
};
const track={stop(){stopped++},addEventListener(){}};
const navigator={language:'fa-IR',mediaDevices:{async getUserMedia(){mediaRequests++;return{getTracks(){return[track]},getAudioTracks(){return[track]}}}}};
const context=vm.createContext({
 window,navigator,document,URL,Math,Number,JSON,Promise,
 performance,setTimeout,clearTimeout,setInterval(){},clearInterval(){},
 ResizeObserver:class{constructor(f){this.fn=f}observe(){}},
 requestAnimationFrame(){return 1},cancelAnimationFrame(){},
 fetch:async()=>({ok:true,json:async()=>({kind:'x11',region:{w:1400,h:860},cursor:{x:700,y:430},interval_s:.1})})
});
vm.runInContext(js,context);
const pause=t=>new Promise(r=>setTimeout(r,t));
await pause(20);
const toggle=document.getElementById('micToggle');
assert.equal(mediaRequests,0);
assert.equal(sockets.filter(s=>s.url.endsWith('/mic-ws')).length,0);
toggle.click();
const sock=sockets.find(s=>s.url.endsWith('/mic-ws'));
assert(sock);
assert.equal(mediaRequests,0);
assert.equal(vm.runInContext('micArmed',context),true);
assert.equal(vm.runInContext('micRecording',context),false);
console.log('STANDBY_BUTTON_DOES_NOT_TOUCH_ANDROID_MIC');
sock.readyState=1;sock.onopen?.();
assert(sock.sent.some(s=>typeof s==='string'&&JSON.parse(s).t==='arm'));
sock.trigger({t:'standby'});
await pause(10);
assert.equal(mediaRequests,0);
console.log('STANDBY_WS_CONNECTION_NO_AUDIO_PASS');
sock.trigger({t:'capture-needed'});
await pause(60);
assert.equal(mediaRequests,1);
assert.equal(mediaStarts,1);
assert.equal(vm.runInContext('micRecording',context),true);
console.log('REMOTE_APP_REQUEST_OPENS_MIC_PASS');
const recorder=FakeRecorder.last;
recorder.ondataavailable?.({data:{size:1800,async arrayBuffer(){return new ArrayBuffer(1800)}}});
await pause(30);
assert(sock.sent.some(s=>s instanceof ArrayBuffer));
console.log('LIVE_CAPTURE_SENDS_ENCODED_AUDIO_ONLY_ON_DEMAND');
sock.trigger({t:'capture-stop'});
await pause(20);
assert.equal(stopped,1);
assert.equal(vm.runInContext('micRecording',context),false);
assert.equal(vm.runInContext('micArmed',context),true);
console.log('REMOTE_APP_STOP_RELEASES_PHONE_MIC_BUT_STANDBY_REMAINS');
toggle.click();
assert.equal(vm.runInContext('micArmed',context),false);
assert.equal(stopped,1);
console.log('MANUAL_DISARM_WITHOUT_EXTRA_MIC_CAPTURE_PASS');
console.log('MIC_STANDBY_FRONTEND_MOCKS_PASS');
