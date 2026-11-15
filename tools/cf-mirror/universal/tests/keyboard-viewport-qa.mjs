import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const root=new URL('../',import.meta.url).pathname.replace(/\/$/,'');
const html=fs.readFileSync(root+'/surface.html','utf8');
const source=html.split('<script>')[1].split('</script>')[0];
const calls=[],nodes=new Map();
let visibleKeyboard=false;
const eventTarget=()=>{
 const handlers=new Map();
 return{
  addEventListener(name,fn){(handlers.get(name)||handlers.set(name,[]).get(name)).push(fn)},
  fire(name,props={}){for(const cb of handlers.get(name)||[])cb({preventDefault(){this.prevented=true},isTrusted:true,...props})},
 }
};
class Element{
 constructor(id){this.id=id;this.textContent='';this.value='';this.style={};this.handlers=new Map();this.classList={add(){},remove(){},toggle(){return true},contains(){return false}};this.clientWidth=id==='stage'?400:100;this.clientHeight=id==='stage'?760:100;this.selectionStart=0;this.selectionEnd=0;this.naturalWidth=1400;this.naturalHeight=860}
 addEventListener(name,fn){(this.handlers.get(name)||this.handlers.set(name,[]).get(name)).push(fn)}
 fire(name,props={}){for(const cb of this.handlers.get(name)||[])cb({target:this,preventDefault(){this.prevented=true},isTrusted:true,...props})}
 focus(){doc.activeElement=this;this.fire('focus')}
 blur(){doc.activeElement=null;this.fire('blur')}
 getBoundingClientRect(){return {left:0,top:42,width:this.clientWidth,height:this.clientHeight,right:this.clientWidth,bottom:42+this.clientHeight}}
 setAttribute(){}
 setPointerCapture(){}
 querySelectorAll(){return []}
 querySelector(){return new Element('sub')}
}
const doc={activeElement:null,getElementById(id){if(!nodes.has(id))nodes.set(id,new Element(id));return nodes.get(id)}};
let pointer={x:650,y:420},messages=[];
let keyboardHideCalls=0;
const ww={addEventListener(){},parent:{postMessage(...a){messages.push(a)}},location:{origin:'https://mirror.test'},isSecureContext:true};
const context=vm.createContext({
 document:doc,window:ww,navigator:{language:'fa-IR',virtualKeyboard:{hide(){keyboardHideCalls++}}},performance,setTimeout,clearTimeout,setInterval(){},clearInterval(){},requestAnimationFrame(){return 1},cancelAnimationFrame(){},ResizeObserver:class{constructor(fn){this.fn=fn}observe(){this.fn()}},Math,Number,JSON,Promise,
 fetch:async(url,opts)=>{
  const data=opts?.body?JSON.parse(opts.body):null;
  calls.push({url,data});
  if(url==='/info')return{ok:true,json:async()=>({kind:'x11',interval_s:.1,region:{x:20,y:20,w:1400,h:860},cursor:pointer})};
  if(url==='/move-rel'){pointer={x:pointer.x+data.dx,y:pointer.y+data.dy}};
  return{ok:true,json:async()=>({ok:true,cursorPos:pointer})};
 }
});
vm.runInContext(source,context);
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const k=doc.getElementById('keyboardToggle');
assert(!html.includes('id="nativeBar"')&&!html.includes('id="nativeInput"'));
assert(!html.includes('id="pointer-arrow"'));
assert(/interactive-widget=resizes-content/.test(html));
assert(/<div class="keyboard-control"/.test(html));
console.log('NO_BAR_NATIVE_POINTER_PRESENT');
k.focus();assert(messages.some(v=>v[0].kind==='cf-mirror-viewport-sync'));
console.log('FOCUS_REQUESTS_OUTER_RESIZE');
k.value='a';k.fire('input');k.value='ab';k.fire('input');await pause(22);
assert(calls.filter(x=>x.url==='/type').some(x=>x.data.s==='a'));
assert(calls.filter(x=>x.url==='/type').some(x=>x.data.s==='b'));
console.log('NORMAL_TYPING_PASS');
k.value='a';k.fire('beforeinput',{inputType:'deleteContentBackward'});k.fire('input');await pause(25);
assert(calls.some(x=>x.url==='/key'&&x.data.key==='Backspace'));
console.log('BACKSPACE_WITH_TEXT_PASS');
k.value='';k.fire('beforeinput',{inputType:'deleteContentBackward'});await pause(25);
assert(calls.filter(x=>x.url==='/key'&&x.data.key==='Backspace').length>=2);
console.log('BACKSPACE_EMPTY_INPUT_PASS');
k.value='copied';k.fire('input');await pause(14);
const clipboardBefore=calls.filter(x=>x.url==='/type').length;
k.fire('paste');
k.value='copied pasted';k.fire('beforeinput',{inputType:'insertFromPaste'});k.fire('input');await pause(22);
assert(calls.slice().filter(x=>x.url==='/type').length>clipboardBefore);
assert(calls.some(x=>x.url==='/type'&&x.data.s===' pasted'));
console.log('ANDROID_PASTE_PASS');
k.fire('keydown',{key:'a',ctrlKey:true,metaKey:false,altKey:false,shiftKey:false});
await pause(15);
assert(calls.some(x=>x.url==='/key'&&x.data.key==='a'&&x.data.ctrl===true));
k.value='Z';k.fire('input');await pause(15);
assert(calls.some(x=>x.url==='/type'&&x.data.s==='Z'));
console.log('CTRL_SELECT_ALL_AND_REPLACE_PASS');
k.fire('compositionstart');k.value='سلام';k.fire('input');k.fire('compositionend');k.fire('input');await pause(22);
assert(calls.filter(x=>x.url==='/type'&&x.data.s==='سلام').length===1);
console.log('IME_COMPOSITION_SINGLE_COMMIT_PASS');
k.fire('keydown',{key:'ArrowLeft',ctrlKey:false,metaKey:false,altKey:false,shiftKey:false});
k.fire('keydown',{key:'Escape',ctrlKey:false,metaKey:false,altKey:false,shiftKey:false});
await pause(15);
assert(calls.some(x=>x.url==='/key'&&x.data.key==='ArrowLeft'));
assert(calls.some(x=>x.url==='/key'&&x.data.key==='Escape'));
console.log('HARDWARE_SPECIAL_KEYS_PASS');
// The keyboard app is irrelevant: no keydown is needed for these IME events.
k.value='predict';k.fire('input');
k.value='prediction';k.fire('beforeinput',{inputType:'insertReplacementText'});k.fire('input');
await pause(28);
assert(calls.some(x=>x.url==='/type'&&x.data.s==='ion'),'IME suggestion replacement was not relayed');
k.value='';k.fire('input');await pause(16);
k.fire('beforeinput',{inputType:'deleteWordBackward'});await pause(14);
assert(calls.some(x=>x.url==='/key'&&x.data.key==='Backspace'&&x.data.ctrl===true),'IME word-delete without keydown failed');
console.log('VENDOR_NEUTRAL_IME_REPLACEMENT_AND_WORD_DELETE_PASS');
k.blur();assert(messages.length>=2);
// Keyboard icon toggles OFF when already focused, and stage touch clears stale
// focus after Android Back hides the keyboard without firing input blur.
k.focus();
assert.equal(doc.activeElement,k);
k.fire('pointerdown');
assert.notEqual(doc.activeElement,k);
assert(keyboardHideCalls>0,'tap-to-close must request Android keyboard hide');
const hideBefore=keyboardHideCalls;
k.fire('click');
assert.notEqual(doc.activeElement,k);
assert(keyboardHideCalls>hideBefore,'synthetic click after second tap must not refocus the IME');
console.log('SECOND_TAP_EXPLICITLY_HIDES_KEYBOARD_AND_SUPPRESSES_REFOCUS_PASS');
await pause(820);
k.focus();
k.fire('touchstart');
assert.notEqual(doc.activeElement,k);
console.log('TOUCHSTART_WITHOUT_POINTERDOWN_HIDES_KEYBOARD_PASS');
await pause(820);
k.focus();
const st=doc.getElementById('stage');
st.fire('pointerdown',{pointerType:'touch',pointerId:402,clientX:120,clientY:240});
assert.notEqual(doc.activeElement,k);
st.fire('pointerup',{pointerType:'touch',pointerId:402,clientX:120,clientY:240});
console.log('SCREEN_TOUCH_AFTER_KEYBOARD_HIDE_STAYS_OFF_PASS');
console.log('GESTURE_RELAY_TESTS_FINISHED');

const outer=fs.readFileSync(root+'/viewer.html','utf8');
const outerJs=outer.split('<script>')[1].split('</script>')[0].replace('__BROWSER_MODE__','false').replace('__CONTROL_CSRF__','test-token');
const events=new Map();
const bodyStyle={vals:{},setProperty(n,v){this.vals[n]=v}};
const sentToFrame=[];
const iframe={contentWindow:{postMessage(...args){sentToFrame.push(args)}}};
const vv={height:790,offsetTop:0,addEventListener(n,fn){events.set('vv:'+n,fn)}};
const doc2={
 body:{style:bodyStyle},
 getElementById(id){if(id==='mirror')return iframe;return{style:{},addEventListener(){},value:'',replaceChildren(){},append(){}}}
};
const w2={innerHeight:820,visualViewport:vv,addEventListener(n,fn){events.set(n,fn)}};
vm.runInNewContext(outerJs,{document:doc2,window:w2,location:{origin:'https://mirror.test'},setTimeout(){},Math,Number,Promise,Date,fetch(){}});
assert.equal(bodyStyle.vals['--cf-view-height'],'790px');
vv.height=490;events.get('vv:resize')();assert.equal(bodyStyle.vals['--cf-view-height'],'490px');
events.get('message')({origin:'https://mirror.test',source:iframe.contentWindow,data:{kind:'cf-mirror-viewport-sync'}});
assert.equal(bodyStyle.vals['--cf-view-height'],'490px');
vv.height=790;events.get('vv:resize')();assert.equal(bodyStyle.vals['--cf-view-height'],'790px');
console.log('DOCKED_KEYBOARD_REDUCES_VIEWPORT_TO_490px_AND_RECENTERS');
console.log('FLOATING_OR_CLOSED_KEYBOARD_PRESERVES_790px');
// The parent must dismiss stale focused IME once an observed docked keyboard
// returns to the full-height viewport; it must not repeatedly dispatch.
events.get('message')({origin:'https://mirror.test',source:iframe.contentWindow,data:{kind:'cf-mirror-ime-focus'}});
vv.height=485;events.get('vv:resize')();
assert.equal(sentToFrame.length,0);
vv.height=790;events.get('vv:resize')();
assert.equal(sentToFrame.length,1);
assert.deepEqual(JSON.parse(JSON.stringify(sentToFrame[0][0])),{kind:'cf-mirror-ime-dismissed'});
events.get('vv:resize')();
assert.equal(sentToFrame.length,1);
console.log('DOCKED_ANDROID_BACK_AUTO_BLURS_STALE_IME_ONCE_PASS');
events.get('message')({origin:'https://mirror.test',source:iframe.contentWindow,data:{kind:'cf-mirror-ime-focus'}});
events.get('message')({origin:'https://mirror.test',source:iframe.contentWindow,data:{kind:'cf-mirror-ime-blur'}});
vv.height=485;events.get('vv:resize')();
vv.height=790;events.get('vv:resize')();
assert.equal(sentToFrame.length,1);
console.log('MANUAL_OFF_AND_FLOATING_KEYBOARD_NO_AUTO_REOPEN_PASS');
console.log('ALL_KEYBOARD_VIEWPORT_MOCKS_PASS');
