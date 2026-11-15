(function(){
'use strict';
if(window.__cfmInputModeToggleV1)return;
const stageEl=document.getElementById('stage');
const bottom=document.getElementById('bottom');
if(!stageEl||!bottom||!document.getElementById('cursorToggle'))return;
window.__cfmInputModeToggleV1=true;
const modeTagEl=document.getElementById('modeTag');
const hintEl=document.getElementById('hint');
const cursorButton=document.getElementById('cursorToggle');
const helpEl=document.getElementById('help');
const isLocal=/^(127\.0\.0\.1|localhost|\[::1\])$/i.test(location.hostname);
const defaultMode=isLocal?'mouse':'touchpad';
const storeKey='cfm-input-mode-v1';
let saved=null;
try{saved=sessionStorage.getItem(storeKey);}catch(_){}
let inputMode=(saved==='mouse'||saved==='touchpad')?saved:defaultMode;
const button=document.createElement('button');
button.id='inputModeToggle';
button.type='button';
button.setAttribute('aria-controls','stage');
bottom.insertBefore(button,cursorButton);
const css=document.createElement('style');
css.id='cfm-input-mode-style';
css.textContent='#stage.cfm-mode-mouse{cursor:default!important}#stage.cfm-mode-touchpad{cursor:none!important}#bottom{overflow-x:auto;scrollbar-width:none}#bottom::-webkit-scrollbar{display:none}#inputModeToggle{min-width:74px;padding:7px 7px;font-size:12px;white-space:nowrap;flex-shrink:0}#inputModeToggle[aria-pressed="true"]{background:#1958a5;border-color:#72b1ff}';
(document.head||document.documentElement).appendChild(css);
let operations=Promise.resolve(),pendingAbsolute=null,absoluteQueued=false;
const operate=(url,payload)=>{
  operations=operations.catch(()=>{}).then(()=>postSafe(url,payload)).then(updateRemote);
  return operations;
};
function absoluteMove(p){
 if(!p)return;
 pendingAbsolute=p;
 if(absoluteQueued)return;
 absoluteQueued=true;
 operations=operations.catch(()=>{}).then(async()=>{
  const current=pendingAbsolute;
  pendingAbsolute=null;absoluteQueued=false;
  if(current)updateRemote(await postSafe('/move',current));
 });
}
let mouseDown=null,lastMousePoint=null;
let directTouch=null,usedMultiTouch=false,longPressTimer=null;
let tapTimer2=null,lastTapTime2=0,lastTapPos2=null;
function stopLong(){
 if(longPressTimer!==null){clearTimeout(longPressTimer);longPressTimer=null;}
}
function stopPendingTap(){
 if(tapTimer2!==null){clearTimeout(tapTimer2);tapTimer2=null;}
 lastTapTime2=0;lastTapPos2=null;
}
function sendAbsoluteClick(p,buttonCode=0){
 absoluteMove(p);
 operate('/down',{...p,button:buttonCode});
 operate('/up',{...p,button:buttonCode});
}
function finishPressed(){
 if(mouseDown!==null){
  operate('/release-rel',{button:mouseDown});
  mouseDown=null;
 }
 if(directTouch?.dragging){
  const p=directTouch.last||directTouch.start;
  if(p){absoluteMove(p);operate('/up',{...p,button:0});}
 }
 directTouch=null;
 stopLong();
}
function setInputMode(next,persist=true){
 if(next!=='touchpad'&&next!=='mouse')return;
 if(inputMode!==next)finishPressed();
 if(next==='mouse'){
  if(typeof cursorHintEnabled!=='undefined'&&cursorHintEnabled){
   cursorHintEnabled=false;
   document.getElementById('instantCursor').style.display='none';
   cursorButton.setAttribute('aria-pressed','false');
  }
 }
 inputMode=next;
 stageEl.classList.toggle('cfm-mode-mouse',next==='mouse');
 stageEl.classList.toggle('cfm-mode-touchpad',next==='touchpad');
 stageEl.setAttribute('aria-label',next==='mouse'?'Remote desktop direct mouse':'Remote desktop touchpad');
 button.textContent=next==='mouse'?'🖱 Mouse':'☝ Touchpad';
 button.setAttribute('aria-pressed',String(next==='mouse'));
 button.title='Input mode: '+(next==='mouse'?'Mouse (direct click)':'Touchpad (relative swipe)')+'. Click to switch.';
 button.setAttribute('aria-label',button.title);
 if(modeTagEl)modeTagEl.textContent=next==='mouse'?'Mouse':'Touchpad';
 if(hintEl)hintEl.textContent=next==='mouse'?
  'Mouse: point and click · touch: tap anywhere · drag to move':
  'Touchpad: swipe to move · tap to click · hold for right-click';
 if(helpEl){
  const heading=helpEl.querySelector('strong'),first=helpEl.querySelector('div');
  if(heading)heading.textContent=next==='mouse'?'Mouse controls':'Touchpad controls';
  if(first)first.textContent=next==='mouse'?
   'Mouse mode: pointer position maps directly onto the remote window. With a touchscreen, tap to click at the exact point or drag to drag. Two fingers retain pan/zoom.':
   'Touchpad mode: one-finger swipe moves the existing remote cursor relatively; tap clicks there. A physical mouse also moves the remote cursor relatively.';
 }
 cursorButton.disabled=next==='mouse';
 cursorButton.title=next==='mouse'?'Instant cursor ring is available in Touchpad mode':'Show or hide instant touchpad cursor';
 lastMousePoint=null;
 if(persist)try{sessionStorage.setItem(storeKey,next);}catch(_){}
}
button.addEventListener('click',()=>{stopPendingTap();setInputMode(inputMode==='mouse'?'touchpad':'mouse');});
setInputMode(inputMode,false);
// Capture physical mouse events before the original handlers. The original
// handlers use absolute input only, and do not move while dragging.
function mouseInput(e){
 if(e.pointerType!=='mouse')return;
 if(e.type==='pointermove'){
  if(inputMode==='mouse'){
   const t=performance.now();
   const p=pointToSource(e.clientX,e.clientY,true);
   if(p&&(!lastMousePoint||Math.abs(p.x-lastMousePoint.x)+Math.abs(p.y-lastMousePoint.y)>1)){
    if(!mouseInput.lastMoveAt||t-mouseInput.lastMoveAt>=45||e.buttons){
      lastMousePoint=p;
      mouseInput.lastMoveAt=t;
      absoluteMove(p);
    }
   }
  }else{
   const dx=Number.isFinite(e.movementX)?e.movementX:0;
   const dy=Number.isFinite(e.movementY)?e.movementY:0;
   if(dx||dy)moveRelativeScreen(dx,dy);
  }
 }else if(e.type==='pointerdown'){
  e.preventDefault();
  mouseDown=e.button;
  try{stageEl.setPointerCapture(e.pointerId);}catch(_){}
  if(inputMode==='mouse'){
   const p=pointToSource(e.clientX,e.clientY,true);
   if(p){absoluteMove(p);operate('/down',{...p,button:e.button,ctrl:e.ctrlKey,alt:e.altKey,shift:e.shiftKey,meta:e.metaKey});}
  }else operate('/press-rel',{button:e.button});
 }else if(e.type==='pointerup'){
  e.preventDefault();
  if(inputMode==='mouse'){
   const p=pointToSource(e.clientX,e.clientY,true);
   if(p){absoluteMove(p);operate('/up',{...p,button:e.button,ctrl:e.ctrlKey,alt:e.altKey,shift:e.shiftKey,meta:e.metaKey});}
   else operate('/release-rel',{button:e.button});
  }else operate('/release-rel',{button:e.button});
  mouseDown=null;
  try{stageEl.releasePointerCapture(e.pointerId);}catch(_){}
 }else if(e.type==='pointercancel'){
  if(mouseDown!==null)operate('/release-rel',{button:mouseDown});
  mouseDown=null;
 }
 e.stopImmediatePropagation();
}
for(const eventName of ['pointerdown','pointermove','pointerup','pointercancel'])
 stageEl.addEventListener(eventName,mouseInput,true);
function handleDirectTouch(kind,id,x,y,e){
 if(inputMode!=='mouse')return false;
 if(e){e.preventDefault();e.stopImmediatePropagation();}
 const p=pointToSource(x,y,true);
 if(kind==='start'){
  if(!p||usedMultiTouch)return true;
  directTouch={id,start:p,last:p,x,y,started:performance.now(),dragging:false,moved:0,longPressed:false};
  absoluteMove(p);
  stopLong();
  longPressTimer=setTimeout(()=>{
   if(!directTouch||directTouch.id!==id||directTouch.dragging||directTouch.moved>8||usedMultiTouch)return;
   directTouch.longPressed=true;
   sendAbsoluteClick(directTouch.last||p,2);
  },610);
 }else if(kind==='move'){
  if(!directTouch||directTouch.id!==id||!p||usedMultiTouch)return true;
  directTouch.moved=Math.max(directTouch.moved,Math.hypot(x-directTouch.x,y-directTouch.y));
  directTouch.last=p;
  if(directTouch.moved>9&&!directTouch.dragging&&!directTouch.longPressed){
   stopLong();
   directTouch.dragging=true;
   absoluteMove(directTouch.start);
   operate('/down',{...directTouch.start,button:0});
  }
  if(!directTouch.longPressed)absoluteMove(p);
 }else if(kind==='end'||kind==='cancel'){
  if(!directTouch||directTouch.id!==id)return true;
  const d=directTouch;
  directTouch=null;
  stopLong();
  if(d.dragging){
   const last=p||d.last||d.start;
   absoluteMove(last);operate('/up',{...last,button:0});
  }else if(kind==='end'&&!d.longPressed&&d.moved<=9){
   const last=p||d.last||d.start;
   const t=performance.now();
   if(tapTimer2!==null&&t-lastTapTime2<330&&lastTapPos2&&
      Math.hypot(last.x-lastTapPos2.x,last.y-lastTapPos2.y)<45){
    stopPendingTap();
    absoluteMove(last);
    operate('/dbl',{...last,button:0});
   }else{
    stopPendingTap();lastTapTime2=t;lastTapPos2=last;
    tapTimer2=setTimeout(()=>{
     tapTimer2=null;lastTapTime2=0;lastTapPos2=null;
     if(inputMode==='mouse')sendAbsoluteClick(last);
    },280);
   }
  }
 }
 return true;
}
// Android/iOS native Touch Events are the primary path, just as in the original
// mirror. In Mouse mode the direct path captures and suppresses touchpad events.
// In Touchpad mode the original relative swipe/pinch handlers remain unchanged.
const hasNativeTouch=typeof useNativeTouchEvents!=='undefined'&&useNativeTouchEvents;
if(hasNativeTouch){
 const syncMulti=evt=>{
  fingers.clear();
  for(const t of evt.touches)fingers.set(t.identifier,{x:t.clientX,y:t.clientY});
 };
 stageEl.addEventListener('touchstart',evt=>{
  if(inputMode!=='mouse')return;
  evt.preventDefault();evt.stopImmediatePropagation();
  if(evt.touches.length>=2){
   stopLong();
   if(directTouch?.dragging){const p=directTouch.last||directTouch.start;absoluteMove(p);operate('/up',{...p,button:0});}
   directTouch=null;usedMultiTouch=true;
   syncMulti(evt);
   if(fingers.size===2)beginPinch();
   return;
  }
  if(usedMultiTouch)return;
  for(const t of evt.changedTouches)handleDirectTouch('start',t.identifier,t.clientX,t.clientY);
 },{capture:true,passive:false});
 stageEl.addEventListener('touchmove',evt=>{
  if(inputMode!=='mouse')return;
  evt.preventDefault();evt.stopImmediatePropagation();
  if(usedMultiTouch){
   syncMulti(evt);
   if(fingers.size>=2)movePinch();
   return;
  }
  for(const t of evt.changedTouches)handleDirectTouch('move',t.identifier,t.clientX,t.clientY);
 },{capture:true,passive:false});
 for(const eventName of ['touchend','touchcancel']){
  stageEl.addEventListener(eventName,evt=>{
   if(inputMode!=='mouse')return;
   evt.preventDefault();evt.stopImmediatePropagation();
   if(usedMultiTouch){
    syncMulti(evt);
    if(evt.touches.length===0){
     usedMultiTouch=false;fingers.clear();pinch=null;suppressUntilAllUp=false;
    }
    return;
   }
   for(const t of evt.changedTouches)handleDirectTouch(eventName==='touchend'?'end':'cancel',t.identifier,t.clientX,t.clientY);
  },{capture:true,passive:false});
 }
}else{
 const touchPointers=new Map();
 for(const eventName of ['pointerdown','pointermove','pointerup','pointercancel']){
  stageEl.addEventListener(eventName,e=>{
   if(inputMode!=='mouse'||e.pointerType!=='touch')return;
   if(eventName==='pointerdown'){
    touchPointers.set(e.pointerId,{x:e.clientX,y:e.clientY});
    if(touchPointers.size>1){
     usedMultiTouch=true;
     directTouch=null;stopLong();
     fingers.clear();
     for(const [id,p] of touchPointers)fingers.set(id,p);
     if(fingers.size===2)beginPinch();
     e.preventDefault();e.stopImmediatePropagation();
    }else handleDirectTouch('start',e.pointerId,e.clientX,e.clientY,e);
   }else if(eventName==='pointermove'){
    if(usedMultiTouch){
     touchPointers.set(e.pointerId,{x:e.clientX,y:e.clientY});
     fingers.clear();
     for(const [id,p] of touchPointers)fingers.set(id,p);
     if(fingers.size>=2)movePinch();
     e.preventDefault();e.stopImmediatePropagation();
    }else handleDirectTouch('move',e.pointerId,e.clientX,e.clientY,e);
   }else{
    touchPointers.delete(e.pointerId);
    if(usedMultiTouch){
     if(touchPointers.size===0){usedMultiTouch=false;fingers.clear();pinch=null;suppressUntilAllUp=false;}
     e.preventDefault();e.stopImmediatePropagation();
    }else handleDirectTouch(eventName==='pointerup'?'end':'cancel',e.pointerId,e.clientX,e.clientY,e);
   }
  },true);
 }
}
window.addEventListener('pagehide',()=>{stopLong();stopPendingTap();},{once:true});
})();