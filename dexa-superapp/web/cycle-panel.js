(() => {
  'use strict';
  // Dexa owner-requested send-only cycle: no model, Voice or draft inspection.
  const AGENT = '__dexaCycleSendOnly166';
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
    const NAME = '__dexaCycleSendOnly166';
    if (location.hostname !== 'chatgpt.com')
      return {ok:false,error:'NOT_CHATGPT'};
    if (window[NAME]?.revision === 'send-only-v166') return {ok:true};
    const norm = s => String(s || '').replace(/\s+/g, ' ').trim();
    const visible = e => !!e && e.getClientRects().length > 0 &&
      getComputedStyle(e).visibility !== 'hidden';
    const all = selector => [...document.querySelectorAll(selector)].filter(visible);
    const editor = () => {
      const a = all('textarea,[contenteditable="true"],[role="textbox"]')
        .filter(e => !e.closest('[aria-hidden="true"]') && !e.disabled);
      if (a.length === 1) return a[0];
      const preferred = a.filter(e => /^(type|ask chatgpt|message)$/i.test(
        (e.getAttribute('aria-label') || e.getAttribute('placeholder') || '').trim()));
      return preferred.length === 1 ? preferred[0] : null;
    };
    const value = e => e ? (e.isContentEditable ?
      (e.innerText || e.textContent || '') : (e.value || '')) : '';
    const ctrl = () => all('button,[role="button"]');
    const ready = () => {
      const e = editor();
      return {ok: true, ready: location.pathname === '/' && !!e,
        path: location.pathname, editorReady: !!e};
    };
    const compose = text => {
      if (location.pathname !== '/') return {ok: false, error: 'NOT_NEW_CHAT'};
      const e = editor();
      if (!e) return {ok: false, error: 'EDITOR_NOT_UNIQUE'};
      e.focus();
      const sel = window.getSelection(), range = document.createRange();
      range.selectNodeContents(e); range.collapse(false);
      sel.removeAllRanges(); sel.addRange(range);
      const inserted = document.execCommand('insertText', false, text);
      return {ok: !!inserted && norm(value(e)) === norm(text),
        error: inserted ? 'COMPOSE_NOT_CONFIRMED' : 'COMPOSE_INSERT_FAILED'};
    };
    const send = expected => {
      const btns = ctrl().filter(b => (
        /^(send-button|voice-send-button)$/i.test(b.getAttribute('data-testid') || '') ||
        /^(send|send message|send prompt|ارسال|ارسال پیام)$/i.test((b.getAttribute('aria-label') ||
          b.getAttribute('title') || '').trim())
      ) && !b.disabled && b.getAttribute('aria-disabled') !== 'true');
      if (btns.length !== 1) return {ok: false, error: 'SEND_BUTTON_COUNT_' + btns.length};
      btns[0].click();
      return {ok: true, clicked: true};
    };
    const receipt = expected => {
      const e = editor(), path = location.pathname;
      const users = all('[data-message-author-role="user"]');
      const target = norm(expected);
      const sent = path.startsWith('/c/') && (users.some(u => norm(u.innerText || u.textContent) === target) ||
        (document.body.innerText || '').includes('You said:') &&
        norm(document.body.innerText || '').includes(target.slice(0, 120)));
      return {ok: true, sent, path};
    };
    const answer = () => {
      const page = document.body.innerText || '';
      const roleAnswers = all('[data-message-author-role="assistant"]');
      const last = roleAnswers.at(-1);
      const pos = page.lastIndexOf('ChatGPT said:');
      const suffix = pos >= 0 ? page.slice(pos + 'ChatGPT said:'.length) : '';
      const roleText = last ? (last.innerText || last.textContent || '').trim() : '';
      const text = roleText || suffix.split('Response complete')[0]
        .split('Is this conversation helpful so far?')[0]
        .split('ChatGPT can make mistakes.')[0].trim();
      const busy = !!document.querySelector(
        '[data-testid="stop-button"],button[aria-label*="Stop generating"],button[aria-label*="Stop response"]');
      const completed = suffix.includes('Response complete') || (roleAnswers.length > 0 && !busy);
      return {ok: true, path: location.pathname, completed, busy,
        hasUser: all('[data-message-author-role="user"]').length > 0 || page.includes('You said:'),
        answer: String(text).slice(0, 120000)};
    };
    window[NAME] = {revision:'send-only-v166',ready,compose,send,receipt,answer};
    return {ok:true};
  }

  const invokeOnce = (slot, method, ...args) => evalBatched(slot,
    '(()=>{const a=window[' + JSON.stringify(AGENT) + '];' +
    'if(!a || a.revision!=="send-only-v166")' +
    'return {ok:false,error:"AGENT_MISSING",path:location.pathname};' +
    'const f=a[' + JSON.stringify(method) + '];' +
    'if(typeof f!=="function")return {ok:false,error:"AGENT_METHOD_MISSING"};' +
    'return f(' + args.map(x => JSON.stringify(x)).join(',') + ');})()',
    () => {}, false);
  const install = slot => evalBatched(slot,
    '(()=>{const r=(' + installBrowserAgent.toString() + ')();' +
    'const a=window[' + JSON.stringify(AGENT) + '];' +
    'return {ok:r?.ok===true && a?.revision==="send-only-v166" && ' +
    'typeof a.ready==="function",error:r?.error||"AGENT_INSTALL_UNVERIFIED",' +
    'revision:a?.revision||null,path:location.pathname};})()', () => {}, false);
  async function invoke(slot, method, ...args) {
    // evalBatched throws when the page receipt has ok:false, so catch the
    // exact pre-action missing-agent code, never unrelated/ambiguous errors.
    try { return await invokeOnce(slot, method, ...args); }
    catch (error) {
      if (String(error?.message || error) !== 'AGENT_MISSING') throw error;
    }
    const installed = await install(slot);
    if (installed?.ok !== true)
      throw Error('AGENT_RECOVERY_FAILED:' + String(installed?.error || 'UNKNOWN'));
    try { return await invokeOnce(slot, method, ...args); }
    catch (error) {
      if (String(error?.message || error) === 'AGENT_MISSING')
        throw Error('AGENT_CONTEXT_CHANGED_AGAIN');
      throw error;
    }
  }

  function assertOk(result, code) {
    if (!result || result.ok !== true)
      throw Error(code + ':' + String(result?.error || 'NO_RECEIPT'));
    return result;
  }
  function active() {
    if (state.cancelled) throw Error('CYCLE_CANCELLED');
    if (!window.DexaHost || !hostState || hostState.count < 2)
      throw Error('TWO_BROWSERS_NOT_CONNECTED');
  }
  async function until(fn, timeout, code, delay = 600) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      active();
      const result = await fn();
      if (result) return result;
      await sleep(delay);
    }
    throw Error(code);
  }

  async function prepare(slot) {
    active();
    await nativeCall('navigate', {slot, url: 'https://chatgpt.com/'});
    await until(async () => {
      try {
        const s = await invoke(slot, 'ready');
        return s.ok && s.path === '/' && s.editorReady ? s : null;
      } catch { return null; }
    }, 35000, 'NEW_CHAT_EDITOR_NOT_READY');
    await sleep(650);
    const s = assertOk(await invoke(slot, 'ready'), 'NEW_CHAT_SNAPSHOT');
    if (s.path !== '/' || !s.editorReady)
      throw Error('NEW_CHAT_EDITOR_DISAPPEARED');
  }

  async function submit(slot, text) {
    active();
    assertOk(await invoke(slot, 'compose', text), 'COMPOSE_SLOT_' + (slot + 1));
    await sleep(350);
    assertOk(await invoke(slot, 'send', text), 'SEND_SLOT_' + (slot + 1));
    return await until(async () => {
      const r = await invoke(slot, 'receipt', text);
      if (r?.ok === false) throw Error('SEND_RECEIPT:' + r.error);
      return r?.sent ? r : null;
    }, 30000, 'SEND_NOT_CONFIRMED_SLOT_' + (slot + 1), 450);
  }
  async function waitAnswer(slot, timeout) {
    let prior = '', stableSince = 0;
    return until(async () => {
      const v = assertOk(await invoke(slot, 'answer'), 'READ_ANSWER');
      if (!v.hasUser || !v.path.startsWith('/c/') || !v.answer || v.busy || !v.completed) {
        prior = ''; stableSince = 0; return null;
      }
      if (v.answer !== prior) { prior = v.answer; stableSince = Date.now(); return null; }
      return Date.now() - stableSince >= 2500 ? v.answer : null;
    }, timeout, 'REPLY_NOT_CONFIRMED_SLOT_' + (slot + 1), 850);
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
      const first=await waitAnswer(0, 180000);
      const secondPrompt=(wrapper?wrapper+'\n\n':'')+first;
      stage('SECOND_CHAT','مرورگر دوم: بازکردن چت تازه...',1);
      await prepare(1);
      stage('SECOND_SEND','مرورگر دوم: ارسال پاسخ مرورگر اول...',1);
      await submit(1,secondPrompt);
      stage('SECOND_REPLY','مرورگر دوم: دریافت پاسخ نهایی...',1);
      state.output=await waitAnswer(1, 180000);
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
