(() => {
  'use strict';
  // Dexa owner-requested send-only cycle: no model, Voice or draft inspection.
  const AGENT = '__dexaCycleSendOnly165';
  const STORAGE = 'dexa-cycle-panel-settings-v1';
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(STORAGE) || '{}') || {}; } catch {}
  const state = {
    prompt: '', wrapper: typeof saved.wrapper === 'string' ? saved.wrapper : 'این مسئله رو حل کن:',
    output: '', stage: 'READY', message: 'آمادهٔ ارسال', error: '',
    running: false, cancelled: false, runId: ''
  };
  let lastStage = '';

  function stage(code, message, slot = 0, error = '') {
    state.stage = code;
    state.message = message;
    state.error = error;
    if (code !== lastStage) {
      lastStage = code;
      try { scriptStage(slot, 'CYCLE_' + code, error, undefined, state.runId); } catch {}
    }
    paint();
  }

  function paint() {
    const root = document.getElementById('dexaCyclePanel');
    if (!root) return;
    root.querySelector('[data-cycle-stage]').textContent =
      state.message + (state.error ? ' — ' + state.error : '');
    root.querySelector('[data-cycle-run]').disabled = state.running;
    root.querySelector('[data-cycle-cancel]').disabled = !state.running;
    root.querySelector('[data-cycle-output]').value = state.output;
  }

  function mount() {
    const host = document.getElementById('boardContent');
    if (!host) return;
    if (host.querySelector('#dexaCyclePanel')) { paint(); return; }
    host.innerHTML =
      '<div id="dexaCyclePanel" class="cycle-panel">' +
      '<div class="card-head"><h3>چرخهٔ سادهٔ دو مرورگر</h3><span class="tag">فقط ارسال متن</span></div>' +
      '<p class="sub">بدون بررسی مدل، صوت یا پیش‌نویس؛ قبل از اجرا هر دو کادر پیام را خودت دستی خالی کن.</p>' +
      '<label class="cycle-label" for="cyclePrompt">پیام اصلی برای مرورگر اول</label>' +
      '<textarea id="cyclePrompt" class="cycle-field" rows="5" placeholder="پیام را بنویس..."></textarea>' +
      '<label class="cycle-label" for="cycleWrapper">متن پیش از پاسخ مرورگر اول برای مرورگر دوم</label>' +
      '<textarea id="cycleWrapper" class="cycle-field" rows="3"></textarea>' +
      '<div class="row cycle-actions"><button class="primary" data-cycle-run>ارسال و اجرای چرخه</button>' +
      '<button data-cycle-cancel type="button" class="danger">توقف ادامهٔ چرخه</button></div>' +
      '<div class="notice" data-cycle-stage aria-live="polite"></div>' +
      '<label class="cycle-label" for="cycleOutput">پاسخ مرورگر دوم</label>' +
      '<textarea id="cycleOutput" data-cycle-output class="cycle-field cycle-output" rows="7" readonly></textarea>' +
      '<p class="sub">تنظیمات مدل و صدا دست‌نخورده می‌مانند. ارسال هر پیام فقط یک‌بار انجام می‌شود.</p>' +
      '</div>';
    const q = selector => host.querySelector(selector);
    q('#cyclePrompt').value = state.prompt;
    q('#cycleWrapper').value = state.wrapper;
    q('#cyclePrompt').addEventListener('input', e => { state.prompt = e.target.value; });
    q('#cycleWrapper').addEventListener('input', e => {
      state.wrapper = e.target.value;
      try { localStorage.setItem(STORAGE, JSON.stringify({wrapper:state.wrapper})); } catch {}
    });
    q('[data-cycle-run]').onclick = () => { run().catch(() => {}); };
    q('[data-cycle-cancel]').onclick = () => {
      state.cancelled = true;
      stage('CANCEL_REQUESTED', 'توقف ادامه ثبت شد؛ پیام‌های ارسال‌شده پس گرفته نمی‌شوند.');
    };
    paint();
  }

  // Reinstalls in the current page for EACH instruction, so navigation and
  // WebView rehydration cannot leave a stale agent behind.
  function installBrowserAgent() {
    const NAME = '__dexaCycleSendOnly165';
    if (location.hostname !== 'chatgpt.com')
      return {ok:false,error:'NOT_CHATGPT'};
    if (window[NAME]?.revision === 'send-only-165') return {ok:true};
    const visible = e => !!e && e.getClientRects().length > 0 &&
      getComputedStyle(e).visibility !== 'hidden';
    const all = selector => [...document.querySelectorAll(selector)].filter(visible);
    const editor = () => {
      const items = all('textarea,[contenteditable="true"],[role="textbox"]')
        .filter(e => !e.closest('[aria-hidden="true"]') && !e.disabled);
      if (items.length === 1) return items[0];
      const preferred = items.filter(e => /^(ask chatgpt|type|message)$/i.test(
        (e.getAttribute('aria-label') || e.getAttribute('placeholder') || '').trim()));
      return preferred.length === 1 ? preferred[0] : null;
    };
    const ready = () => ({ok:true,ready:location.pathname === '/' && !!editor()});
    const compose = text => {
      if (location.pathname !== '/') return {ok:false,error:'NOT_NEW_CHAT'};
      const e = editor();
      if (!e) return {ok:false,error:'EDITOR_NOT_FOUND'};
      e.focus();
      if (e.isContentEditable) {
        const selection = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(e);
        range.collapse(false);
        selection.removeAllRanges();
        selection.addRange(range);
        const inserted = document.execCommand('insertText',false,text);
        return {ok:!!inserted,error:'TYPE_FAILED'};
      }
      const start = e.value.length;
      e.setRangeText(text,start,start,'end');
      e.dispatchEvent(new Event('input',{bubbles:true}));
      return {ok:true};
    };
    const send = () => {
      if (location.pathname !== '/') return {ok:false,error:'NOT_NEW_CHAT'};
      const buttons = all('button,[role="button"]').filter(e =>
        !e.disabled && e.getAttribute('aria-disabled') !== 'true' &&
        (/^(send-button|voice-send-button)$/i.test(e.getAttribute('data-testid') || '') ||
         /^(send|send message|send prompt|ارسال|ارسال پیام)$/i.test(
           (e.getAttribute('aria-label') || e.getAttribute('title') || '').trim())));
      if (buttons.length !== 1)
        return {ok:false,error:'SEND_BUTTON_COUNT_' + buttons.length};
      buttons[0].click();
      return {ok:true,clicked:true};
    };
    const answer = () => {
      const page = document.body.innerText || '';
      const answers = all('[data-message-author-role="assistant"]');
      const last = answers.at(-1);
      const pos = page.lastIndexOf('ChatGPT said:');
      const suffix = pos >= 0 ? page.slice(pos + 'ChatGPT said:'.length) : '';
      const roleText = last ? (last.innerText || last.textContent || '').trim() : '';
      const text = roleText || suffix.split('Response complete')[0]
        .split('Is this conversation helpful so far?')[0]
        .split('ChatGPT can make mistakes.')[0].trim();
      const busy = !!document.querySelector(
        '[data-testid="stop-button"],button[aria-label*="Stop generating"],button[aria-label*="Stop response"]');
      const complete = suffix.includes('Response complete') || (answers.length > 0 && !busy);
      return {ok:true,path:location.pathname,completed:complete,busy,
        hasUser:all('[data-message-author-role="user"]').length > 0 ||
          page.includes('You said:'),
        answer:String(text).slice(0,120000)};
    };
    window[NAME] = {revision:'send-only-165',ready,compose,send,answer};
    return {ok:true};
  }

  async function invoke(slot,method,...args) {
    const source = '(()=>{const installed=(' + installBrowserAgent.toString() +
      ')();if(!installed.ok)return installed;const agent=window[' +
      JSON.stringify(AGENT) + '];return agent[' + JSON.stringify(method) +
      '](' + args.map(x=>JSON.stringify(x)).join(',') + ');})()';
    return evalBatched(slot,source,()=>{},false);
  }
  function active() {
    if (state.cancelled) throw Error('CYCLE_CANCELLED');
    if (!window.DexaHost || !hostState || hostState.count < 2)
      throw Error('TWO_BROWSERS_NOT_CONNECTED');
  }
  async function until(fn,timeout,code,interval=850) {
    const end=Date.now()+timeout;
    while (Date.now()<end) {
      active();
      const value=await fn();
      if (value) return value;
      await sleep(interval);
    }
    throw Error(code);
  }
  async function prepare(slot) {
    active();
    await nativeCall('navigate',{slot,url:'https://chatgpt.com/'});
    await until(async()=>{
      try {return (await invoke(slot,'ready'))?.ready;}
      catch {return false;}
    },35000,'CHAT_EDITOR_NOT_READY_SLOT_' + (slot+1),700);
  }
  async function submit(slot,text) {
    active();
    const result=await invoke(slot,'compose',text);
    if (!result?.ok) throw Error(result?.error || 'TYPE_FAILED');
    await sleep(500);
    active();
    // Intentionally one click, no send retry and no draft inspection.
    const sent=await invoke(slot,'send');
    if (!sent?.ok || !sent.clicked)
      throw Error(sent?.error || 'SEND_NOT_EXECUTED');
  }
  async function waitAnswer(slot) {
    let previous='',since=0;
    return until(async()=>{
      const value=await invoke(slot,'answer');
      if (!value?.ok || !value.hasUser || !value.path?.startsWith('/c/') ||
          !value.answer || value.busy || !value.completed) {
        previous='';since=0;return null;
      }
      if (value.answer!==previous) {
        previous=value.answer;since=Date.now();return null;
      }
      return Date.now()-since>=1800?value.answer:null;
    },180000,'ANSWER_NOT_READY_SLOT_'+(slot+1),1000);
  }
  async function run() {
    if (state.running) return;
    const prompt=state.prompt.trim(),wrapper=state.wrapper.trim();
    if (!prompt) { stage('INPUT_REQUIRED','متن پیام را وارد کن.');return; }
    if (!window.DexaHost || !hostState || hostState.count<2) {
      stage('HOST_REQUIRED','دو مرورگر باید به اندروید متصل باشند.');return;
    }
    state.running=true;state.cancelled=false;state.output='';state.error='';
    state.runId=crypto.randomUUID();
    try {
      const old=window.DexaAutoHandoff;
      if (old) {
        const status=old.read();
        if (status?.busy) throw Error('PREVIOUS_AUTOMATIC_TRANSFER_BUSY');
        old.stop();
        if (old.read()?.enabled) throw Error('PREVIOUS_AUTOMATIC_TRANSFER_BUSY');
      }
      stage('FIRST_CHAT','مرورگر اول: بازکردن چت تازه...');
      await prepare(0);
      stage('FIRST_SEND','مرورگر اول: ارسال پیام...');
      await submit(0,prompt);
      stage('FIRST_REPLY','مرورگر اول: دریافت پاسخ...');
      const first=await waitAnswer(0);
      const secondPrompt=(wrapper?wrapper+'\n\n':'')+first;
      stage('SECOND_CHAT','مرورگر دوم: بازکردن چت تازه...',1);
      await prepare(1);
      stage('SECOND_SEND','مرورگر دوم: ارسال پاسخ مرورگر اول...',1);
      await submit(1,secondPrompt);
      stage('SECOND_REPLY','مرورگر دوم: دریافت پاسخ نهایی...',1);
      state.output=await waitAnswer(1);
      stage('DONE','چرخهٔ متنی دو مرورگر انجام شد.',1);
    } catch(error) {
      stage('FAILED','چرخه متوقف شد؛ ارسال تکراری انجام نمی‌شود.',0,
        String(error?.message || error).slice(0,140));
    } finally {
      state.running=false;
      paint();
    }
  }
  window.DexaCycle={mount,read:()=>({
    stage:state.stage,running:state.running,error:state.error,
    outputLength:state.output.length,runId:state.runId
  })};
  if (typeof selectedBoard!=='undefined' && selectedBoard==='cycle') mount();
})();
