import vm from 'node:vm';
import fs from 'node:fs';
import assert from 'node:assert/strict';
const html=fs.readFileSync(new URL('../surface.html',import.meta.url),'utf8');
const js=html.split('<script>')[1].split('</script>')[0];
const calls=[],nodes=new Map();
class ClassList{
 constructor(){this.names=new Set();}
 add(x){this.names.add(x)}
 remove(x){this.names.delete(x)}
 contains(x){return this.names.has(x)}
 toggle(x){if(this.names.has(x)){this.names.delete(x);return false;}this.names.add(x);return true}
}
class Node{
 constructor(id){this.id=id;this.events=new Map();this.style={};this.classList=new ClassList();this.dataset={};this.textContent='';this.value='';this.naturalWidth=1400;this.naturalHeight=860;this.clientWidth=id==='stage'?390:0;this.clientHeight=id==='stage'?730:0;this.width=390;this.height=730;}
 addEventListener(name,fn){(this.events.get(name)||this.events.set(name,[]).get(name)).push(fn)}
 emit(name,data={}){for(const f of this.events.get(name)||[])f({...data,preventDefault(){},stopPropagation(){},target:this});}
 getBoundingClientRect(){return {left:0,top:42,width:this.clientWidth,height:this.clientHeight,right:this.clientWidth,bottom:42+this.clientHeight}}
 setAttribute(a,v){this[a]=v;}
 setPointerCapture(){}
 focus(){this.focused=true}
 blur(){this.focused=false}
 scrollIntoView(){}
 querySelectorAll(){return []}
 querySelector(){return new Node('special')}
}
const ids=['stage','surface','image','cursor','state','hud','hint','keys','help','modeTag','helpToggle','viewMode','reset','keysButton','fullscreen','typeToggle','nativeInput','dragToggle'];
for(const n of ids)nodes.set(n,new Node(n));
let cursor={x:700,y:430};
const document={getElementById:id=>{if(!nodes.has(id))nodes.set(id,new Node(id));return nodes.get(id)}};
let voiceSessions=0;
class FakeSpeechRecognition {
 start(){
  voiceSessions++;
  this.onstart?.();
  setTimeout(()=>{
   this.onresult?.({resultIndex:0,results:[{isFinal:true,0:{transcript:'سلام دنیا'}}]});
   this.onend?.();
  },12);
 }
 stop(){this.onend?.();}
}
const context=vm.createContext({
 document,navigator:{language:'fa-IR'},window:{addEventListener(){},SpeechRecognition:FakeSpeechRecognition,isSecureContext:true},setTimeout,clearTimeout,setInterval(){return 1},clearInterval(){},
 ResizeObserver:class{constructor(fn){this.fn=fn}observe(){this.fn()}},
 requestAnimationFrame(){return 1},cancelAnimationFrame(){},
 performance,Math,Number,JSON,Promise,
 fetch:async(url,options)=>{
  const data=options?.body?JSON.parse(options.body):null;
  calls.push({url,data});
  if(url==='/info')return {ok:true,json:async()=>({region:{x:20,y:20,w:1400,h:860},cursor,interval_s:.2,kind:'x11'})};
  if(url==='/move-rel'){cursor={x:Math.max(0,Math.min(1399,cursor.x+data.dx)),y:Math.max(0,Math.min(859,cursor.y+data.dy))};}
  return {ok:true,json:async()=>({ok:true,cursorPos:cursor})};
 }
});
vm.runInContext(js,context);
await new Promise(r=>setTimeout(r,20));
const stage=nodes.get('stage');
const center=vm.runInContext('pointToSource(195,407)',context);
assert(Math.abs(center.x-700)<=1&&Math.abs(center.y-430)<=1,'centered source calibration failed '+JSON.stringify(center));
console.log('CENTER_MAPPING',JSON.stringify(center));
function ev(type,id,x,y){stage.emit(type,{pointerType:'touch',pointerId:id,clientX:x,clientY:y})}
ev('pointerdown',1,120,320);ev('pointermove',1,175,320);ev('pointerup',1,175,320);
await new Promise(r=>setTimeout(r,50));
const delta=calls.filter(x=>x.url==='/move-rel').map(x=>x.data.dx);
assert(delta.length&&delta.some(x=>x>50),'relative movement not sent');
assert(!calls.some(x=>x.url==='/down'),'touch must not press on contact');
console.log('TRACKPAD_RELATIVE',JSON.stringify(delta));
ev('pointerdown',2,180,340);ev('pointerup',2,180,340);
await new Promise(r=>setTimeout(r,330));
assert(calls.some(x=>x.url==='/click-rel'&&x.data.button===0),'touch tap must left click at remote cursor');
console.log('TAP_AT_CURSOR',JSON.stringify(calls.filter(x=>x.url==='/click-rel')));
const taps=calls.filter(x=>x.url==='/click-rel').length;
ev('pointerdown',3,190,360);
await new Promise(r=>setTimeout(r,675));
ev('pointerup',3,190,360);
assert(calls.some(x=>x.url==='/click-rel'&&x.data.button===2),'hold must right click');
console.log('LONG_PRESS_RIGHT',JSON.stringify(calls.filter(x=>x.url==='/click-rel').slice(taps)));
ev('pointerdown',30,150,360);ev('pointerup',30,150,360);
await new Promise(r=>setTimeout(r,70));
ev('pointerdown',31,150,360);ev('pointerup',31,150,360);
await new Promise(r=>setTimeout(r,55));
assert(calls.some(x=>x.url==='/double-rel'),'double tap did not double-click');
console.log('DOUBLE_TAP_REMOTE',calls.filter(x=>x.url==='/double-rel').length);
const drag=nodes.get('dragToggle');drag.emit('click');await new Promise(r=>setTimeout(r,35));
assert(calls.some(x=>x.url==='/press-rel'),'drag press not sent');
drag.emit('click');await new Promise(r=>setTimeout(r,35));
assert(calls.some(x=>x.url==='/release-rel'),'drag release not sent');
console.log('DRAG_HOLD_AND_RELEASE',calls.filter(x=>x.url==='/press-rel'||x.url==='/release-rel').map(x=>x.url));
const prev=vm.runInContext('zoom',context);
ev('pointerdown',4,115,395);ev('pointerdown',5,260,395);
ev('pointermove',4,75,395);ev('pointermove',5,300,395);
const updated=vm.runInContext('zoom',context);
assert(updated>prev,'pinch zoom failed');
const panBefore=vm.runInContext('panX',context);
ev('pointermove',4,105,412);ev('pointermove',5,330,412);
const panAfter=vm.runInContext('panX',context);
assert(Math.abs(panAfter-panBefore)>1,'two-finger pan failed');
ev('pointerup',4,105,412);ev('pointerup',5,330,412);
console.log('PINCH_AND_PAN',JSON.stringify({previousZoom:prev,zoom:updated,panBefore,panAfter}));
vm.runInContext('zoom=1;panX=panY=0;render()',context);
const moveStart=calls.filter(x=>x.url==='/move-rel').length;
stage.emit('pointerdown',{pointerType:'mouse',clientX:195,clientY:407,button:0,ctrlKey:false,altKey:false,shiftKey:false,metaKey:false});
await new Promise(r=>setTimeout(r,20));
assert(calls.some(x=>x.url==='/down'),'desktop mouse down absent');
const mouseCall=calls.filter(x=>x.url==='/down').at(-1).data;
assert(Math.abs(mouseCall.x-700)<=1&&Math.abs(mouseCall.y-430)<=1,'desktop mouse calibration failed');
console.log('DESKTOP_MOUSE_CALIBRATED',JSON.stringify(mouseCall));
console.log('MOCK_GESTURE_TESTS_PASS');
assert(!html.includes('id="cursor"'),'ghost overlay still present');
const keyboardButton=nodes.get('keyboardToggle');
assert(!html.includes('id="nativeBar"')&&!html.includes('id="pointer-arrow"'),'No accessory bar or artificial pointer');
keyboardButton.value='hello';
keyboardButton.emit('input');
await new Promise(r=>setTimeout(r,25));
assert(calls.some(x=>x.url==='/type'&&x.data.s==='hello'),'Direct Android input failed');
keyboardButton.value='hell';
keyboardButton.emit('input');
await new Promise(r=>setTimeout(r,25));
assert(calls.some(x=>x.url==='/key'&&x.data.key==='Backspace'),'Backspace on direct input failed');
console.log('DIRECT_KEYBOARD_AND_BACKSPACE_PASS');
assert(voiceSessions===0,'microphone must not start automatically');
const voiceButton=nodes.get('micToggle');
voiceButton.emit('click');
await new Promise(r=>setTimeout(r,65));
assert(voiceSessions===1,'voice recognition did not start on tap');
assert(calls.some(x=>x.url==='/type'&&x.data.s==='سلام دنیا'),'final voice transcript not forwarded once');
assert(calls.filter(x=>x.url==='/type'&&x.data.s==='سلام دنیا').length===1,'final transcript sent twice');
assert(nodes.get('micToggle').attributes?.['aria-pressed']!=='true','mic still active');
console.log('SPEECH_RECOGNITION_FARSI_PASS');
console.log('ALL_GESTURE_AND_VOICE_MOCKS_PASS');
