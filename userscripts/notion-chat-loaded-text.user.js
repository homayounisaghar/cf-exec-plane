// ==UserScript==
// @name         Notion AI - Export loaded chat text (manual scroll)
// @namespace    local.notion.chat-loaded-text
// @version      1.0.0
// @description  Capture text already rendered while you scroll Notion AI manually; export a partial TXT without fetching history or auto-scrolling.
// @match        https://app.notion.com/*
// @match        https://www.notion.so/*
// @match        https://notion.so/*
// @run-at       document-start
// @grant        none
// @sandbox      raw
// @noframes
// @updateURL    https://raw.githubusercontent.com/homayounisaghar/cf-exec-plane/main/userscripts/notion-chat-loaded-text.user.js
// @downloadURL  https://raw.githubusercontent.com/homayounisaghar/cf-exec-plane/main/userscripts/notion-chat-loaded-text.user.js
// ==/UserScript==

(() => {
  'use strict';
  const PANEL_ID = 'notion-manual-text-export-panel';
  const LIMIT_TURNS = 25000;
  const LIMIT_TEXT = 12000000;
  const rawFilter = /^(?:Thought|Thinking|Worked for\s+.+|Copy|Retry|Share|Ask Notion AI|Show more|Liked|Disliked|More actions|Notion AI|Start a new chat|History|Search)$/i;
  const skipMarkers = /(thought|thinking|reasoning|tool[-_ ]?result|attachment|file[-_ ]?preview|chat[-_ ]?actions|toolbar|message[-_ ]?actions|feedback|citation[-_ ]?tooltip|composer|prompt[-_ ]?input)/i;

  let panel, exportButton, clearButton, info;
  let currentThread = '', collected = [], rawLines = [];
  let structuredGaps = 0, rawGaps = 0, previousPosition = null, previousRoot = null;
  let scanning = false, scanScheduled = false, busy = false;

  function currentID() {
    const search = new URLSearchParams(location.search), id = search.get('t') || '';
    const isChat = /\/chat\/?$/.test(location.pathname) || search.get('wfv') === 'chat';
    return isChat && /^[a-f\d]{32}$|^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(id)
      ? id.replace(/-/g, '').toLowerCase() : '';
  }
  function reset(id) {
    currentThread=id; collected=[]; rawLines=[]; structuredGaps=0; rawGaps=0;
    previousPosition=null; previousRoot=null; showCount();
  }
  function rect(el) { try {return el?.getBoundingClientRect() || null;} catch {return null;} }
  function css(el) { try {return getComputedStyle(el);} catch {return {display:'',visibility:'',backgroundColor:'',borderTopLeftRadius:'0',overflowY:''};} }
  function hidden(el) {
    if (!el || el.nodeType !== 1) return false;
    if (el.hasAttribute('hidden') || el.getAttribute('aria-hidden') === 'true') return true;
    const c=css(el); return c.display === 'none' || c.visibility === 'hidden';
  }
  function forbidden(el) {
    if (!el || el.nodeType !== 1) return false;
    if (el.id === PANEL_ID || panel?.contains(el)) return true;
    if (/^(SCRIPT|STYLE|NOSCRIPT|SVG|IMG|CANVAS|VIDEO|AUDIO|INPUT|TEXTAREA|SELECT|OPTION|BUTTON|NAV|ASIDE|HEADER|FOOTER|FORM|TIME)$/.test(el.tagName)) return true;
    if (el.getAttribute('role') === 'button' || el.getAttribute('role') === 'toolbar' || el.isContentEditable) return true;
    const label=(el.getAttribute('aria-label') || '').toLowerCase();
    if (/^(copy|share|retry|close|download|search|menu|send|stop|scroll to bottom)$/i.test(label)) return true;
    const marker=[el.getAttribute('data-testid'),el.getAttribute('data-test-id'),el.getAttribute('data-cy'),typeof el.className==='string'?el.className:''].filter(Boolean).join(' ');
    if (skipMarkers.test(marker)) return true;
    if (el.tagName === 'DETAILS' && /thought|think|reason/i.test(el.querySelector('summary')?.textContent||'')) return true;
    return false;
  }
  function cleanText(element) {
    if (!element) return '';
    const parts=[], block=/^(?:P|DIV|SECTION|ARTICLE|H[1-6]|LI|BLOCKQUOTE|TR|PRE|UL|OL)$/;
    const walk=(node,depth)=>{
      if (depth>180 || parts.length>125000) return;
      if (node.nodeType===3) {parts.push(node.nodeValue||'');return;}
      if (node.nodeType!==1 || forbidden(node) || hidden(node)) return;
      const tag=node.tagName;
      if (tag==='BR'){parts.push('\n');return;}
      if (block.test(tag)) parts.push('\n');
      if (tag==='LI') parts.push('• ');
      for (const child of node.childNodes) walk(child,depth+1);
      if (block.test(tag)) parts.push('\n');
    };
    walk(element,0);
    return parts.join('').replace(/\u00a0/g,' ').replace(/[ \t]+\n/g,'\n')
      .replace(/\n[ \t]+/g,'\n').replace(/\n{3,}/g,'\n\n')
      .split('\n').map(s=>s.trim()).filter(s=>s && !rawFilter.test(s)).join('\n').trim();
  }
  function extractHint(el){
    const attrs=['data-message-author-role','data-message-role','data-role','data-turn','data-sender','data-author'];
    for(const attr of attrs){
      const s=String(el.getAttribute(attr)||'').toLowerCase().trim();
      if (/^(user|human|editor)$/.test(s)) return 'user';
      if (/^(assistant|agent|ai|model|notion-ai)$/.test(s)) return 'assistant';
    }
    const hint=[el.getAttribute('data-testid'),el.getAttribute('data-test-id'),el.getAttribute('data-cy'),typeof el.className==='string'?el.className:''].filter(Boolean).join(' ').toLowerCase();
    if (/(?:^|[\s_-])(?:user|human|prompt|question)(?:[\s_-]|$)/.test(hint) && /message|turn|bubble|query|chat/.test(hint)) return 'user';
    if (/(?:^|[\s_-])(?:assistant|agent|ai|model)(?:[\s_-]|$)/.test(hint) && /message|turn|response|chat|answer/.test(hint)) return 'assistant';
    return '';
  }
  function shouldConsider(el,root){
    if (!root.contains(el) || forbidden(el) || hidden(el)) return false;
    if (el.closest('nav,aside,header,footer,form,[contenteditable="true"],#'+PANEL_ID)) return false;
    const a=rect(el),b=rect(root);
    return !!(a && b && a.width>12 && a.height>6 && a.right>b.left+b.width*.04 && a.left<b.right-b.width*.04);
  }
  function assistantText(el){
    const selector='.markdown,.prose,[data-testid*="message-content"],[data-testid*="response-content"],[class*="markdown-body"]';
    const pref=[...el.querySelectorAll(selector)].filter(x=>!x.parentElement?.closest(selector));
    const chunks=pref.map(cleanText).filter(Boolean);
    return chunks.length?chunks.join('\n\n'):cleanText(el);
  }
  function semanticTurns(root){
    const selector='[data-message-author-role],[data-message-role],[data-role],[data-turn],[data-sender],[data-author],'+
      '[data-testid*="message"],[data-testid*="turn"],[data-testid*="response"],[data-testid*="query"],'+
      '[class*="user-message"],[class*="assistant-message"],[class*="agent-message"],'+
      '[class*="userMessage"],[class*="assistantMessage"]';
    const rows=[...root.querySelectorAll(selector)].filter(el=>shouldConsider(el,root))
      .map(el=>({el,role:extractHint(el)})).filter(x=>!!x.role);
    const top=rows.filter(x=>!rows.some(y=>x!==y && y.role===x.role && y.el.contains(x.el)));
    return top.map(x=>({role:x.role,text:x.role==='assistant'?assistantText(x.el):cleanText(x.el),el:x.el,confidence:'semantic'}))
      .filter(x=>x.text.length>0);
  }
  function userBubbleCandidates(root){
    const rr=rect(root);if(!rr)return [];
    const found=[],elems=root.querySelectorAll('div,article,section');
    for(let i=0;i<Math.min(45000,elems.length);i++){
      const el=elems[i];if(!shouldConsider(el,root))continue;
      const r=rect(el),style=css(el);
      if(!r || r.width<50 || r.height<18 || r.width>rr.width*.92 || r.height>4500)continue;
      if(parseFloat(style.borderTopLeftRadius||'0')<9)continue;
      if(/^(transparent|rgba\([^)]*,\s*0\s*\))$/.test(style.backgroundColor||''))continue;
      if(r.right<rr.right-rr.width*.19 || r.left<rr.left+rr.width*.07)continue;
      const text=cleanText(el);
      if(text.length<2 || text.length>120000)continue;
      found.push({el,text});
    }
    return found.filter(x=>!found.some(y=>x!==y && x.el.contains(y.el)));
  }
  function visualTurns(root){
    const bubbles=userBubbleCandidates(root);if(!bubbles.length)return [];
    let best=null;
    for(const bubble of bubbles.slice(0,16)){
      let child=bubble.el;
      for(let depth=0;depth<8 && child.parentElement && child.parentElement!==root;depth++){
        const parent=child.parentElement;
        if(parent.children.length>=2 && parent.children.length<500){
          const children=[...parent.children];
          const containing=children.filter(x=>bubbles.some(b=>x.contains(b.el)));
          const other=children.filter(x=>!containing.includes(x) && cleanText(x).length>12);
          const count=containing.length+other.length;
          if(containing.length && other.length && (!best||count>best.count))best={parent,count};
        }
        child=parent;
      }
    }
    if(!best)return bubbles.map(b=>({role:'user',text:b.text,el:b.el,confidence:'visual'}));
    return [...best.parent.children].map(el=>{
      if(!shouldConsider(el,root))return null;
      const bubble=bubbles.find(b=>el.contains(b.el));
      const role=bubble?'user':'assistant',text=bubble?bubble.text:assistantText(el);
      return text.length>1?{role,text,el,confidence:'visual'}:null;
    }).filter(Boolean);
  }
  function meaningfulRoot(){
    const primary=[...document.querySelectorAll('main,[role="main"],[data-testid*="chat-messages"],[data-testid*="chat-scroll"]')];
    const candidates=new Map(),all=document.querySelectorAll('body *');
    for(let i=0;i<Math.min(all.length,65000);i++){
      const el=all[i];
      if(panel?.contains(el)||el===panel)continue;
      const spill=el.scrollHeight-el.clientHeight;
      if(spill<80||el.clientHeight<110)continue;
      const r=rect(el);
      if(!r || r.width<Math.min(innerWidth*.34,130) || r.height<110 || r.bottom<70 || r.top>innerHeight-60)continue;
      const overflow=css(el).overflowY;
      if(!/auto|scroll|overlay/i.test(overflow)&&el!==document.scrollingElement)continue;
      let score=10+Math.min(10,spill/250);
      if(r.left<innerWidth*.65&&r.right>innerWidth*.45)score+=9;
      if(/chat|thread|transcript|message|scroll/i.test(typeof el.className==='string'?el.className:''))score+=9;
      if(el.closest('aside,nav,header,footer'))score-=40;
      candidates.set(el,score);
    }
    for(const el of primary)if(el&&!el.closest('aside,nav,header,footer'))candidates.set(el,(candidates.get(el)||0)+6);
    for(const x of [.43,.53,.63]){
      let el=document.elementFromPoint?.(innerWidth*x,innerHeight*.42);
      for(let depth=0;el&&depth<14;depth++,el=el.parentElement)
        if(candidates.has(el))candidates.set(el,candidates.get(el)+12-Math.min(8,depth));
    }
    const sorted=[...candidates.entries()].sort((a,b)=>b[1]-a[1]);
    const best=sorted[0]?.[0]||primary[0]||document.body;
    return best===document.documentElement||best===document.scrollingElement
      ? (document.querySelector('main')||document.body):best;
  }
  function turnKey(el){
    const attrs=['data-message-id','data-turn-id','data-chat-message-id','data-record-id'];
    for(let n=el,d=0;n&&d<4;n=n.parentElement,d++)
      for(const a of attrs){const v=n.getAttribute?.(a);if(v&&v.length>=6&&v.length<=120)return v;}
    return '';
  }
  function visibleTurns(root){
    const hasBoth=rows=>rows.some(x=>x.role==='user')&&rows.some(x=>x.role==='assistant');
    const semantic=semanticTurns(root);
    const visual=hasBoth(semantic)?[]:visualTurns(root);
    let turns=hasBoth(semantic)?semantic:hasBoth(visual)&&visual.length>=semantic.length?visual:
      semantic.length>=visual.length?semantic:visual;
    turns=turns.filter(x=>!turns.some(y=>y!==x&&y.el.contains(x.el)&&y.role===x.role));
    turns.sort((a,b)=>(a.el.compareDocumentPosition(b.el)&Node.DOCUMENT_POSITION_FOLLOWING)?-1:1);
    const base=rect(root),scroll=root===document.body?document.scrollingElement:root;
    return turns.map(t=>{
      const box=rect(t.el),anchor=box&&base?Math.round(box.top-base.top+(scroll?.scrollTop||0)):null;
      return {role:t.role,text:t.text,stableID:turnKey(t.el),anchor,confidence:t.confidence};
    });
  }
  function rawSnapshot(root){
    return cleanText(root).split(/\n+/).map(x=>x.trim())
      .filter(x=>x&&!rawFilter.test(x)).slice(0,30000);
  }
  function sameItem(a,b){
    if(a.stableID&&b.stableID)return a.stableID===b.stableID;
    if(a.role!==b.role||a.text!==b.text)return false;
    if(a.anchor!==null&&b.anchor!==null&&Math.abs(a.anchor-b.anchor)>40)return false;
    return true;
  }
  function mergeSequences(base,incoming,movingUp,equal,maximum){
    if(!incoming.length)return {result:base,gap:false};
    if(!base.length)return {result:incoming.slice(0,maximum),gap:false};
    const length=Math.min(base.length,incoming.length);
    const contained=(small,big)=>{
      if(small.length>big.length)return false;
      outer:for(let i=0;i<=big.length-small.length;i++){
        for(let j=0;j<small.length;j++)if(!equal(small[j],big[i+j]))continue outer;
        return true;
      }return false;
    };
    if(contained(incoming,base))return {result:base,gap:false};
    if(contained(base,incoming))return {result:incoming.slice(0,maximum),gap:false};
    let before=0,after=0;
    for(let k=length;k>=1;k--){
      if(!before&&incoming.slice(-k).every((x,i)=>equal(x,base[i])))before=k;
      if(!after&&base.slice(-k).every((x,i)=>equal(x,incoming[i])))after=k;
      if(before&&after)break;
    }
    if(before||after){
      if(before>after)return {result:incoming.slice(0,-before).concat(base).slice(0,maximum),gap:false};
      return {result:base.concat(incoming.slice(after)).slice(0,maximum),gap:false};
    }
    return {result:(movingUp?incoming.concat(base):base.concat(incoming)).slice(0,maximum),gap:true};
  }
  function directionOf(root){
    const scroller=root===document.body?document.scrollingElement:root;
    const pos=scroller?.scrollTop??window.scrollY??0;
    const up=previousRoot===root&&previousPosition!==null?pos<previousPosition-4:true;
    previousRoot=root;previousPosition=pos;return up;
  }
  function showCount(){
    if(!info)return;
    const label=collected.length?collected.length+' پیام ثبت‌شده':rawLines.length+' بخش متن دیده‌شده';
    if(info.textContent!==label)info.textContent=label;
  }
  function scan(){
    if(scanning||busy||!document.body)return;
    scanning=true;
    try{
      const id=currentID();if(!id)return;
      if(id!==currentThread)reset(id);
      const root=meaningfulRoot(),up=directionOf(root);
      const turns=visibleTurns(root),lines=rawSnapshot(root);
      if(turns.length){
        const merged=mergeSequences(collected,turns,up,sameItem,LIMIT_TURNS);
        collected=merged.result;if(merged.gap)structuredGaps++;
      }
      if(lines.length){
        const merged=mergeSequences(rawLines,lines,up,(a,b)=>a===b,LIMIT_TURNS);
        rawLines=merged.result;if(merged.gap)rawGaps++;
      }
      showCount();
    }catch(err){console.warn('[Notion manual TXT exporter] scan:',err?.message);}
    finally{scanning=false;}
  }
  function scheduleScan(wait=450){
    if(scanScheduled)return;
    scanScheduled=true;
    setTimeout(()=>{scanScheduled=false;scan();},wait);
  }
  function saveTXT(name,body){
    if(!body.trim()||body.length>LIMIT_TEXT)throw Error('متن خالی یا بیش از سقف ذخیره‌سازی است.');
    const url=URL.createObjectURL(new Blob(['\uFEFF',body],{type:'text/plain;charset=utf-8'}));
    const a=document.createElement('a');a.href=url;a.download=name;
    document.body.appendChild(a);a.click();a.remove();
    setTimeout(()=>URL.revokeObjectURL(url),60000);
  }
  function exportLoaded(){
    if(busy)return;
    scan();busy=true;exportButton.disabled=true;
    try{
      if(!currentID())throw Error('ابتدا یک چت نوشن را باز کن.');
      const title=document.title.replace(/[\x00-\x1f\x7f<>:"/\\|?*]/g,'_')
        .replace(/\s*[-|]\s*Notion.*$/i,'').trim().slice(0,65)||'Notion-chat';
      const date=new Date().toISOString().slice(0,10);
      const name=title+'-loaded-'+currentID().slice(0,8)+'-'+date+'.txt';
      const intro='خروجی محدود از چت نوشن\n'+
        'این فایل فقط از متن بارگذاری‌شده/مشاهده‌شده از زمان بازشدن همین صفحه ساخته شده؛ تاریخچهٔ کامل تأیید نشده است.\n\n';
      const both=collected.some(x=>x.role==='user')&&collected.some(x=>x.role==='assistant');
      let body;
      if(both&&collected.length>=2){
        body=intro+collected.map(t=>(t.role==='user'?'کاربر:':'دستیار هوش مصنوعی:')+'\n\n'+t.text).join('\n\n')+'\n';
        if(structuredGaps)body+='\n[یادداشت: ممکن است میان پنجره‌های بارگذاری‌شده فاصله وجود داشته باشد.]\n';
      }else if(rawLines.some(x=>x.length>=12)&&rawLines.length){
        body=intro+'[نقش فرستنده‌ها از ساختار این صفحه قابل تشخیص نبود؛ متن به همان ترتیب مشاهده‌شده آمده است.]\n\n'+rawLines.join('\n')+'\n';
        if(rawGaps)body+='\n[یادداشت: ممکن است میان پنجره‌های بارگذاری‌شده فاصله وجود داشته باشد.]\n';
      }else throw Error('هنوز متن قابل استخراج از گفتگو دیده نشده است.');
      saveTXT(name,body);
      if(info)info.textContent='TXT ذخیره شد ('+(both?collected.length+' پیام':rawLines.length+' بخش متن')+').';
    }catch(err){
      if(info)info.textContent=err?.message||'استخراج ناموفق بود.';
      console.warn('[Notion manual TXT exporter]',err);
    }finally{busy=false;exportButton.disabled=false;}
  }
  function mount(){
    const id=currentID();if(!document.body)return;
    if(!panel){
      panel=document.createElement('div');panel.id=PANEL_ID;
      panel.style.cssText='position:fixed;bottom:16px;right:12px;z-index:2147483647;display:flex;align-items:center;gap:8px;padding:8px;border-radius:12px;background:#202020;color:#fff;box-shadow:0 3px 15px #0005;font:12px system-ui,sans-serif;direction:rtl;max-width:calc(100vw - 24px);';
      exportButton=document.createElement('button');exportButton.textContent='خروجی متن لودشده';
      exportButton.style.cssText='border:0;border-radius:8px;padding:9px;background:white;color:#222;font:600 12px system-ui,sans-serif;white-space:nowrap;cursor:pointer;';
      exportButton.addEventListener('click',exportLoaded);
      clearButton=document.createElement('button');clearButton.textContent='پاک‌کردن ثبت';
      clearButton.title='فقط حافظهٔ همین اسکریپت پاک می‌شود؛ پیام‌های نوشن تغییر نمی‌کنند.';
      clearButton.style.cssText='border:1px solid #888;border-radius:8px;padding:7px;background:transparent;color:white;font:11px system-ui,sans-serif;cursor:pointer;';
      clearButton.addEventListener('click',()=>{reset(currentID());scan();});
      info=document.createElement('span');info.style.cssText='max-width:150px;overflow-wrap:anywhere;';
      panel.append(exportButton,clearButton,info);document.body.appendChild(panel);
    }
    if(panel.parentElement!==document.body)document.body.appendChild(panel);
    panel.style.display=id?'flex':'none';
    panel.style.bottom=document.querySelector('#notion-dialogue-txt-exporter')?'94px':'16px';
    if(!id){if(currentThread)reset('');return;}
    if(id!==currentThread)reset(id);
    scheduleScan(200);
  }
  function start(){
    mount();
    document.addEventListener('scroll',()=>scheduleScan(260),true);
    const obs=new MutationObserver(records=>{
      if(records.every(r=>panel&&panel.contains(r.target)))return;
      scheduleScan(420);
    });
    obs.observe(document.body,{childList:true,subtree:true,characterData:true});
    setInterval(()=>{mount();scan();},3300);
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',start,{once:true});
  else start();
})();