import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
const f=new URL('../surface.html',import.meta.url);
const html=fs.readFileSync(f,'utf8');
const source=html.split('<script>')[1].split('</script>')[0];
class Classes{
 constructor(){this.set=new Set()}
 add(v){this.set.add(v)}
 remove(v){this.set.delete(v)}
 contains(v){return this.set.has(v)}
 toggle(v){if(this.contains(v)){this.remove(v);return false}this.add(v);return true}
}
class El{
 constructor(name){
  this.name=name;this.style={};this.classList=new Classes();this.handlers={};
  this.clientWidth=name==='stage'?390:0;this.clientHeight=name==='stage'?720:0;
  this.naturalWidth=1400;this.naturalHeight=860;this.textContent='';this.value='';
 }
 addEventListener(n,cb){(this.handlers[n]??=[]).push(cb)}
 fire(n,props={}){
  for(const cb of this.handlers[n]||[])cb({...props,preventDefault(){},target:this})
 }
 getBoundingClientRect(){return {left:0,top:42,width:this.clientWidth,height:this.clientHeight,right:this.clientWidth,bottom:this.clientHeight+42}}
 setPointerCapture(){}
 setAttribute(){}
 focus(){}
 blur(){}
 scrollIntoView(){}
 querySelector(){return new El('stub')}
 querySelectorAll(){return []}
}
const nodes=new Map(),document={getElementById(n){if(!nodes.has(n))nodes.set(n,new El(n));return nodes.get(n)}};
const calls=[];
let pointer={x:650,y:420};
const context=vm.createContext({
 document,
 window:{ontouchstart:null,TouchEvent:class{},SpeechRecognition:undefined,webkitSpeechRecognition:undefined,isSecureContext:true,addEventListener(){}},
 navigator:{language:'en-US'},performance,Math,Number,JSON,Promise,setTimeout,clearTimeout,
 setInterval(){},clearInterval(){},requestAnimationFrame(){return 1},cancelAnimationFrame(){},
 ResizeObserver:class{constructor(f){this.f=f}observe(){this.f()}},
 fetch:async(url,options)=>{
   const payload=options?.body?JSON.parse(options.body):null;
   calls.push({url,payload});
   if(url==='/info')return{ok:true,json:async()=>({kind:'x11',region:{x:20,y:20,w:1400,h:860},cursor:pointer,interval_s:.1})};
   if(url==='/move-rel')pointer={x:Math.max(0,Math.min(1399,pointer.x+payload.dx)),y:Math.max(0,Math.min(859,pointer.y+payload.dy))};
   return{ok:true,json:async()=>({ok:true,cursorPos:pointer})};
 }
});
vm.runInContext(source,context);
await new Promise(r=>setTimeout(r,15));
assert.equal(vm.runInContext('useNativeTouchEvents',context),true);
const stage=nodes.get('stage');
const point=(id,x,y)=>({identifier:id,clientX:x,clientY:y});
function touch(event,list){stage.fire(event,{changedTouches:list,touches:list})}
assert(!html.includes('id="pointer-arrow"')&&!html.includes('id="cursor"'));
const runtime=fs.readFileSync(new URL('../runtime.mjs',import.meta.url),'utf8');
assert(runtime.includes("'-draw_mouse', '1', '-framerate'"),'Native X11 mouse cursor is missing from MJPEG');
stage.fire('pointerdown',{pointerType:'touch',pointerId:7,clientX:100,clientY:240});
stage.fire('pointermove',{pointerType:'touch',pointerId:7,clientX:170,clientY:250});
assert(!calls.some(x=>x.url==='/move-rel'),'pointer events must not duplicate native touch path');
touch('touchstart',[point(7,100,240)]);
touch('touchmove',[point(7,170,250)]);
touch('touchend',[point(7,170,250)]);
await new Promise(r=>setTimeout(r,80));
const moves=calls.filter(x=>x.url==='/move-rel');
assert(moves.length>=1,'native touchmove did not send /move-rel');
assert(moves[0].payload.dx>70,'relative movement was lost');
console.log('NATIVE_TOUCH_WITH_CANCELLED_POINTER_EVENTS_OK',JSON.stringify({moves:moves.length,dx:moves[0].payload.dx}));
console.log('NATIVE_X11_CURSOR_NO_ARTIFICIAL_OVERLAY_PASS');
console.log('MOBILE_TOUCH_EVENT_RECOVERY_PASS');
