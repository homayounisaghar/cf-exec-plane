import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const root = new URL('./',import.meta.url);
const js = fs.readFileSync(new URL('input-mode-toggle-v1.js',root),'utf8');
const surface=fs.readFileSync(new URL('surface.html',root),'utf8');
const viewer=fs.readFileSync(new URL('viewer.html',root),'utf8');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));

function harness(hostname) {
 const elems=new Map(), requests=[], deltas=[];
 class Element{
  constructor(id){this.id=id;this.textContent='';this.title='';this.disabled=false;this.style={};this.attributes={};this.handlers={};
   this.classes=new Set();
   this.classList={toggle:(name,enable)=>{if(enable)this.classes.add(name);else this.classes.delete(name);}};
  }
  setAttribute(k,v){this.attributes[k]=v;}
  addEventListener(name,callback,options){(this.handlers[name]??=[]).push({callback,options});}
  insertBefore(child){elems.set(child.id,child);}
  appendChild(child){if(child.id)elems.set(child.id,child);}
  querySelector(name){return elems.get('help-'+name)||null;}
  setPointerCapture(){}
  releasePointerCapture(){}
 }
 for(const key of ['stage','bottom','cursorToggle','modeTag','hint','help','instantCursor'])
  elems.set(key,new Element(key));
 for(const k of ['strong','div'])elems.set('help-'+k,new Element(k));
 const document={
  getElementById:id=>elems.get(id)||null,
  createElement:tag=>new Element(tag),
  head:new Element('head'),documentElement:new Element('root')
 };
 const stored=new Map();
 const window={location:{hostname},addEventListener(){}};
 const context={
  window,document,location:window.location,sessionStorage:{getItem:k=>stored.get(k)||null,setItem:(k,v)=>stored.set(k,v)},
  performance:{now:()=>Date.now()},setTimeout,clearTimeout,requestAnimationFrame:cb=>setTimeout(cb,1),
  fingers:new Map(),pinch:null,suppressUntilAllUp:false,cursorHintEnabled:false,
  postSafe:async (url,payload)=>{requests.push({url,payload});return{ok:true};},
  updateRemote(){},pointToSource:(x,y)=>({x:Math.round(x),y:Math.round(y)}),
  moveRelativeScreen:(dx,dy)=>deltas.push({dx,dy}),beginPinch(){},movePinch(){},
  useNativeTouchEvents:true
 };
 vm.runInNewContext(js,context,{filename:'input-mode-toggle-v1.js'});
 const dispatch=(name,opts={})=>{
  const evt={
   type:name,pointerType:opts.pointerType||'mouse',pointerId:opts.pointerId||1,button:opts.button||0,
   clientX:opts.clientX??30,clientY:opts.clientY??50,movementX:opts.movementX??5,
   movementY:opts.movementY??4,buttons:opts.buttons??0,
   touches:opts.touches||[],changedTouches:opts.changedTouches||[],
   ctrlKey:false,altKey:false,shiftKey:false,metaKey:false,
   prevented:false,stopped:false,preventDefault(){this.prevented=true},
   stopImmediatePropagation(){this.stopped=true}
  };
  for(const h of elems.get('stage').handlers[name]||[])h.callback(evt);
  return evt;
 };
 const button=elems.get('inputModeToggle');
 const click=()=>{for(const h of button.handlers.click||[])h.callback();};
 return {elems,requests,deltas,dispatch,click,button,stored};
}

test('local defaults to Mouse, allows direct click-and-drag and live switch to Touchpad',async()=>{
 const t=harness('127.0.0.1');
 assert.equal(t.button.textContent,'🖱 Mouse');
 assert.equal(t.elems.get('modeTag').textContent,'Mouse');
 assert.equal(t.elems.get('stage').classes.has('cfm-mode-mouse'),true);
 t.dispatch('pointerdown',{clientX:41,clientY:52,button:0});
 t.dispatch('pointermove',{clientX:60,clientY:70,buttons:1});
 t.dispatch('pointerup',{clientX:63,clientY:72});
 await delay(60);
 assert(t.requests.some(x=>x.url==='/down'&&x.payload.x===41));
 assert(t.requests.some(x=>x.url==='/up'&&x.payload.x===63));
 assert(t.requests.some(x=>x.url==='/move'));
 t.click();
 assert.equal(t.button.textContent,'☝ Touchpad');
 assert.equal(t.stored.get('cfm-input-mode-v1'),'touchpad');
 t.dispatch('pointermove',{movementX:9,movementY:-4});
 assert.equal(t.deltas.at(-1).dx,9);
});

test('web defaults to Touchpad, but user can choose direct Mouse',()=>{
 const t=harness('testname.trycloudflare.com');
 assert.equal(t.button.textContent,'☝ Touchpad');
 assert.equal(t.elems.get('modeTag').textContent,'Touchpad');
 t.dispatch('pointermove',{movementX:7,movementY:3});
 assert.equal(t.deltas.at(-1).dx,7);
 t.click();
 assert.equal(t.button.textContent,'🖱 Mouse');
 assert.equal(t.elems.get('stage').classes.has('cfm-mode-mouse'),true);
});

test('Mouse-mode touch tap is direct, while Touchpad-mode native touch remains handled by existing relative gesture code',async()=>{
 const t=harness('127.0.0.1');
 const changed=[{identifier:1,clientX:120,clientY:90}];
 const start=t.dispatch('touchstart',{touches:changed,changedTouches:changed});
 const end=t.dispatch('touchend',{touches:[],changedTouches:changed});
 assert.equal(start.stopped,true);
 assert.equal(end.stopped,true);
 await delay(370);
 assert(t.requests.some(x=>x.url==='/down'&&x.payload.x===120));
 assert(t.requests.some(x=>x.url==='/up'&&x.payload.y===90));
 t.click();
 const before=t.requests.length;
 const native=t.dispatch('touchstart',{touches:changed,changedTouches:changed});
 assert.equal(native.stopped,false);
 assert.equal(native.prevented,false);
 assert.equal(t.requests.length,before);
});

test('deployed active-session shim and new-session script share exact controller',()=>{
 assert(surface.includes('<script id="cfm-input-mode-toggle-20261116">'));
 assert(viewer.includes('<script id="cfm-input-mode-loader-20261116">'));
 assert(viewer.includes('cfm-input-mode-toggle-live'));
 assert(viewer.includes('const installer='));
 assert(viewer.includes('127\\\\.0\\\\.0\\\\.1'));
});
