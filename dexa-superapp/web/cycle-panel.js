(() => {
  'use strict';
  const SETTINGS = 'dexa-cycle-panel-settings-v1';
  const AGENT = '__dexaCycleAgent160';
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const norm = s => String(s || '').replace(/\s+/g, ' ').trim();
  const levels = ['Instant', 'Medium', 'High', 'Extra High'];
  const initial = {first: 'Instant', second: 'Instant', voice: false, wrapper: 'این مسئله رو حل کن:'};
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(SETTINGS) || '{}') || {}; } catch {}
  const state = {
    ...initial, ...saved, prompt: '', output: '', stage: 'READY',
    message: 'آمادهٔ دریافت پیام', error: '', running: false, cancelled: false, runId: ''
  };
  if (!levels.includes(state.first)) state.first = 'Instant';
  if (!levels.includes(state.second)) state.second = 'Instant';
  state.voice = state.voice === true;
  if (typeof state.wrapper !== 'string') state.wrapper = initial.wrapper;
  const priorSent = [null, null];
  const protectedSlots = new Set();
  let previousStage = '';

  function persist() {
    localStorage.setItem(SETTINGS, JSON.stringify({
      first: state.first, second: state.second, voice: state.voice, wrapper: state.wrapper
    }));
  }

  function stage(code, message, slot = 0, error = '') {
    state.stage = code; state.message = message; state.error = error;
    if (code !== previousStage) {
      previousStage = code;
      try { scriptStage(slot, 'CYCLE_' + code, error, undefined, state.runId); } catch {}
    }
    paint();
  }

  function paint() {
    const root = document.getElementById('dexaCyclePanel');
    if (!root) return;
    root.querySelector('[data-cycle-stage]').textContent = state.message +
      (state.error ? ' — ' + state.error : '');
    root.querySelector('[data-cycle-run]').disabled = state.running;
    root.querySelector('[data-cycle-cancel]').disabled = !state.running;
    root.querySelector('[data-cycle-output]').value = state.output;
    const answerLabel = root.querySelector('[data-cycle-answer-label]');
    answerLabel.textContent = state.voice ? 'متن پاسخ مرورگر دوم (همراه پخش صوتی)' : 'پاسخ متنی مرورگر دوم';
  }

  function mount() {
    const host = document.getElementById('boardContent');
    if (!host) return;
    if (host.querySelector('#dexaCyclePanel')) { paint(); return; }
    host.innerHTML =
      '<div id="dexaCyclePanel" class="cycle-panel">' +
      '<div class="card-head"><h3>چرخهٔ دو مرورگر</h3><span class="tag">هر دو مرورگر مخفی</span></div>' +
      '<p class="sub">پیام از همین پنل ارسال می‌شود. قبل از هر ارسال، تنظیمات همان مرورگر بررسی می‌شوند.</p>' +
      '<label class="cycle-label" for="cyclePrompt">پیام اصلی</label>' +
      '<textarea id="cyclePrompt" class="cycle-field" rows="5" placeholder="پرامپت خود را اینجا بنویسید..."></textarea>' +
      '<div class="cycle-grid">' +
      '<label class="cycle-label">ایفورت مرورگر اول<select id="cycleFirst"></select></label>' +
      '<label class="cycle-label">ایفورت مرورگر دوم<select id="cycleSecond"></select></label>' +
      '</div>' +
      '<label class="cycle-switch"><input id="cycleVoice" type="checkbox" role="switch">' +
      '<span>پاسخ مرورگر دوم با صدا خوانده شود</span></label>' +
      '<label class="cycle-label" for="cycleWrapper">رپرِ پاسخ مرورگر اول</label>' +
      '<textarea id="cycleWrapper" class="cycle-field" rows="3" placeholder="متن دلخواه پیش از پاسخ مرورگر اول"></textarea>' +
      '<div class="row cycle-actions"><button class="primary" data-cycle-run>ارسال و اجرای چرخه</button>' +
      '<button data-cycle-cancel type="button" class="danger">توقف ادامهٔ چرخه</button></div>' +
      '<div class="notice" data-cycle-stage aria-live="polite"></div>' +
      '<label class="cycle-label" data-cycle-answer-label for="cycleOutput">پاسخ متنی مرورگر دوم</label>' +
      '<textarea id="cycleOutput" data-cycle-output class="cycle-field cycle-output" rows="7" readonly placeholder="پاسخ نهایی اینجا ظاهر می‌شود."></textarea>' +
      '<p class="sub">در حالت صوتی، پاسخ پس از دریافت با دکمهٔ «خواندن با صدا» در مرورگر دوم پخش می‌شود. اگر کنترل مدل یا پخش صوتی با اطمینان پیدا نشود، چرخه متوقف می‌شود. گفتگوها حذف نمی‌شوند؛ پیش‌نویس‌های قبلی نیز محفوظ و بازیابی می‌شوند.</p>' +
      '</div>';
    const q = sel => host.querySelector(sel);
    for (const id of ['#cycleFirst', '#cycleSecond'])
      q(id).innerHTML = levels.map(x => '<option value="' + x + '">' +
        ({Instant:'اینستنت',Medium:'مدیوم',High:'های','Extra High':'اکسترا های'}[x]) +
        '</option>').join('');
    q('#cyclePrompt').value = state.prompt;
    q('#cycleWrapper').value = state.wrapper;
    q('#cycleFirst').value = state.first;
    q('#cycleSecond').value = state.second;
    q('#cycleVoice').checked = state.voice;
    q('#cyclePrompt').addEventListener('input', e => { state.prompt = e.target.value; });
    q('#cycleWrapper').addEventListener('input', e => { state.wrapper = e.target.value; persist(); });
    q('#cycleFirst').addEventListener('change', e => { state.first = e.target.value; persist(); });
    q('#cycleSecond').addEventListener('change', e => { state.second = e.target.value; persist(); });
    q('#cycleVoice').addEventListener('change', e => { state.voice = e.target.checked; persist(); paint(); });
    q('[data-cycle-run]').onclick = () => { run().catch(() => {}); };
    q('[data-cycle-cancel]').onclick = () => {
      state.cancelled = true;
      stage('CANCEL_REQUESTED', 'درخواست توقف ثبت شد؛ پیام ارسال‌شده بازگردانده نمی‌شود.');
    };
    paint();
  }

  // This is installed in the owner-authenticated ChatGPT WebView, never in a
  // server worker. It reads and operates on ordinary, owner-visible controls.
  // The dashboard only receives the two model answers it needs for the cycle.
  function installBrowserAgent() {
    const NAME = '__dexaCycleAgent160';
    if (location.hostname !== 'chatgpt.com') return {ok: false, error: 'NOT_CHATGPT'};
    if (window[NAME]?.revision === 'power-slider-draftsafe-v168') return {ok: true, reused: true};
    const norm = s => String(s || '').replace(/\s+/g, ' ').trim();
    const vis = e => !!e && e.getClientRects().length > 0 &&
      getComputedStyle(e).visibility !== 'hidden';
    const all = selector => [...document.querySelectorAll(selector)].filter(vis);
    const label = e => [
      e.getAttribute('aria-label'), e.getAttribute('data-testid'),
      e.getAttribute('title'), e.textContent
    ].filter(Boolean).join(' ').trim();
    const ctrl = () => all('button,[role="button"]');
    const voiceExits = () => ctrl().filter(e =>
      /(exit|end|close|leave).{0,25}(voice|conversation|call)|(voice|conversation|call).{0,25}(exit|end|close|leave)|پایان مکالمه|خروج از مکالمه/i.test(label(e)));
    const isVoice = () => voiceExits().length === 1 || (
      ctrl().some(e => /mute|unmute|microphone|میکروفون/i.test(label(e))) &&
      ctrl().some(e => /voice|مکالمه/i.test(label(e))));
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
    const erase = e => {
      e.focus();
      const sel = window.getSelection(), range = document.createRange();
      range.selectNodeContents(e); sel.removeAllRanges(); sel.addRange(range);
      document.execCommand('delete', false, null);
      return !norm(value(e));
    };
    const snapshot = () => {
      const e = editor();
      return {ok: true, path: location.pathname, editorReady: !!e,
        draftLength: e ? norm(value(e)).length : -1,
        modelReady: !!modelTrigger(), voiceActive: isVoice(),
        voiceExitCount: voiceExits().length,
        connecting: /\bconnecting(\.{0,3})?\b/i.test((document.body.innerText || '').slice(-1500)),
        audibleMedia: all('audio,video').some(m => !m.paused)};
    };

    // Verified on the owner's real hidden ChatGPT WebViews on 2026-11-06:
    // button[aria-label="Select ChatGPT model"] opens a five-position
    // [role="menuitem"][aria-label="Power"] keyboard slider, index 0..4.
    // We accept 0..3 only (Instant/Medium/High/Extra High); 4 is Pro.
    const POWER_LEVELS = ['Instant', 'Medium', 'High', 'Extra High', 'Pro'];
    const modelTrigger = () => {
      const a = all('button[aria-label="Select ChatGPT model"],' +
        '[data-testid="model-switcher-dropdown-button"],' +
        '[data-testid="model-picker-button"],[data-testid="model-selector-button"]');
      return a.length === 1 ? a[0] : null;
    };
    const powerPosition = () => {
      const controls = all('[role="menuitem"][aria-label="Power"][data-reasoning-slider]');
      if (controls.length !== 1)
        return {ok: false, error: 'POWER_CONTROL_COUNT_' + controls.length};
      const p = controls[0];
      const slider = p.querySelector('[role="slider"][aria-valuenow]');
      const label = p.closest('[role="group"]')?.querySelector('[role="status"]');
      if (!slider || !label) return {ok: false, error: 'POWER_STATUS_NOT_FOUND'};
      const index = Number(slider.getAttribute('aria-valuenow'));
      const min = Number(slider.getAttribute('aria-valuemin'));
      const max = Number(slider.getAttribute('aria-valuemax'));
      const level = POWER_LEVELS[index];
      const announced = (label.textContent || '').replace(/\s+/g, ' ').trim();
      if (!Number.isInteger(index) || min !== 0 || max !== 4 || !level ||
          announced !== level + ', ' + (index + 1) + ' of 5.')
        return {ok: false, error: 'POWER_POSITION_UNVERIFIED',
          index, announced, min, max};
      return {ok: true, index, level, announced};
    };
    const model = (action, target) => {
      const t = modelTrigger();
      if (!t) return {ok: false, error: 'MODEL_SELECTOR_NOT_FOUND'};
      const header = () => (t.innerText || t.textContent || '')
        .split('\n').map(x => x.trim()).filter(Boolean).at(-1) || '';
      if (action === 'open') {
        if (t.getAttribute('aria-expanded') !== 'true') t.click();
        return {ok: true, opened: true};
      }
      if (action === 'inspect') {
        if (t.getAttribute('aria-expanded') !== 'true')
          return {ok: false, error: 'MODEL_MENU_CLOSED'};
        const position = powerPosition();
        if (!position.ok) return position;
        return {...position, triggerLevel: header()};
      }
      if (action === 'step') {
        const position = powerPosition();
        if (!position.ok) return position;
        if (target !== 'right' && target !== 'left')
          return {ok: false, error: 'INVALID_POWER_DIRECTION'};
        const next = position.index + (target === 'right' ? 1 : -1);
        if (next < 0 || next > 4)
          return {ok: false, error: 'POWER_OUT_OF_RANGE'};
        const p = all('[role="menuitem"][aria-label="Power"][data-reasoning-slider]')[0];
        p.focus();
        const code = target === 'right' ? 39 : 37;
        const key = target === 'right' ? 'ArrowRight' : 'ArrowLeft';
        p.dispatchEvent(new KeyboardEvent('keydown', {
          key,code:key,keyCode:code,which:code,bubbles:true,cancelable:true
        }));
        return {ok: true, from: position.index, intended: next};
      }
      if (action === 'dismiss') {
        if (t.getAttribute('aria-expanded') === 'true') {
          // Owner device: clicking the model trigger again does NOT close the
          // Radix Power menu. Escape on its focused menuitem does (verified).
          const p = all('[role="menuitem"][aria-label="Power"][data-reasoning-slider]');
          if (p.length !== 1 || !p[0].closest('[role="menu"]'))
            return {ok: false, error: 'MODEL_MENU_ESCAPE_TARGET_NOT_UNIQUE'};
          p[0].focus();
          p[0].dispatchEvent(new KeyboardEvent('keydown', {
            key: 'Escape', code: 'Escape', keyCode: 27, which: 27,
            bubbles: true, cancelable: true
          }));
        }
        return {ok: true};
      }
      if (action === 'selected') return {ok: true, level: header(),
        expanded: t.getAttribute('aria-expanded') === 'true'};
      return {ok: false, error: 'INVALID_MODEL_ACTION'};
    };

    const voice = mode => {
      if (mode === 'text') {
        if (!isVoice()) return {ok: true, active: false};
        const exits = voiceExits();
        if (exits.length !== 1) return {ok: false, error: 'VOICE_EXIT_NOT_UNIQUE_' + exits.length};
        exits[0].click();
        return {ok: true, clicked: true};
      }
      if (mode === 'voice') {
        if (isVoice()) return {ok: true, active: true};
        const entries = ctrl().filter(e => /voice|گفتگوی صوتی|گفت‌وگوی صوتی/i.test(label(e)) &&
          !/read.aloud|voice-play|dictat|microphone|mute|stop|end|close|exit/i.test(label(e)));
        if (entries.length !== 1) return {ok: false, error: 'VOICE_ENTRY_NOT_UNIQUE_' + entries.length};
        entries[0].click();
        return {ok: true, clicked: true};
      }
      return {ok: false, error: 'INVALID_MODE'};
    };

    const compose = text => {
      if (location.pathname !== '/') return {ok: false, error: 'NOT_NEW_CHAT'};
      const e = editor();
      if (!e) return {ok: false, error: 'EDITOR_NOT_UNIQUE'};
      if (norm(value(e))) return {ok: false, error: 'UNSENT_DRAFT_PRESERVED'};
      e.focus();
      const sel = window.getSelection(), range = document.createRange();
      range.selectNodeContents(e); range.collapse(false);
      sel.removeAllRanges(); sel.addRange(range);
      const inserted = document.execCommand('insertText', false, text);
      return {ok: !!inserted && norm(value(e)) === norm(text),
        error: inserted ? 'COMPOSE_NOT_CONFIRMED' : 'COMPOSE_INSERT_FAILED'};
    };
    // Read-only receipt before the ONE allowed Send click. A changed React
    // composer cannot silently replace the intended message.
    const checkComposer = expected => {
      const e = editor(), text = e ? value(e) : '';
      return {ok: true, path: location.pathname, editorReady: !!e,
        draftLength: norm(text).length,
        matches: !!e && norm(text) === norm(expected),
        hasUser: all('[data-message-author-role="user"]').length > 0};
    };
    const send = expected => {
      const e = editor();
      if (location.pathname !== '/' || !e || norm(value(e)) !== norm(expected))
        return {ok: false, error: 'SEND_DRAFT_MISMATCH'};
      const btns = ctrl().filter(b => (
        /^(send-button|voice-send-button)$/i.test(b.getAttribute('data-testid') || '') ||
        /^(send|send message|send prompt|ارسال|ارسال پیام)$/i.test((b.getAttribute('aria-label') ||
          b.getAttribute('title') || '').trim())
      ) && !b.disabled && b.getAttribute('aria-disabled') !== 'true');
      if (btns.length !== 1) return {ok: false, error: 'SEND_BUTTON_COUNT_' + btns.length};
      btns[0].click();
      return {ok: true, clicked: true};
    };
    // Start exactly one local operation: compose, then click the original
    // Send control once it becomes enabled in THIS ChatGPT document.
    // A MutationObserver reports actual UI readiness, not a speculative delay.
    let sendJob = null;
    const sendStatus = () => sendJob ?
      {ok: true, stage: sendJob.stage, error: sendJob.error || ''} :
      {ok: true, stage: 'NONE'};
    const sendOnce = text => {
      if (sendJob && sendJob.stage === 'WAITING')
        return {ok: false, error: 'SEND_OPERATION_ALREADY_WAITING'};
      if (location.pathname !== '/')
        return {ok: false, error: 'NOT_NEW_CHAT'};
      const e = editor();
      if (!e) return {ok: false, error: 'EDITOR_NOT_UNIQUE'};
      if (norm(value(e))) return {ok: false, error: 'UNSENT_DRAFT_PRESERVED'};
      const composed = compose(text);
      if (!composed.ok && norm(value(editor())) !== norm(text))
        return composed;
      const job = {stage: 'WAITING', error: ''};
      sendJob = job;
      let observer = null, timeoutId = null;
      const finish = (stage, error = '') => {
        if (job.stage !== 'WAITING') return;
        job.stage = stage; job.error = error;
        if (observer) observer.disconnect();
        if (timeoutId) clearTimeout(timeoutId);
      };
      const attempt = () => {
        if (job.stage !== 'WAITING') return;
        if (location.pathname !== '/' || !editor()) {
          finish('FAILED', 'PAGE_CHANGED_BEFORE_SEND'); return;
        }
        if (norm(value(editor())) !== norm(text)) {
          finish('FAILED', 'COMPOSER_TEXT_CHANGED_BEFORE_SEND'); return;
        }
        const buttons = ctrl().filter(b => (
          /^(send-button|voice-send-button)$/i.test(b.getAttribute('data-testid') || '') ||
          /^(send|send message|send prompt|ارسال|ارسال پیام)$/i.test(
            (b.getAttribute('aria-label') || b.getAttribute('title') || '').trim())
        ) && !b.disabled && b.getAttribute('aria-disabled') !== 'true');
        if (!buttons.length) return;
        if (buttons.length !== 1) {
          finish('FAILED', 'SEND_BUTTON_NOT_UNIQUE'); return;
        }
        // The exact original send() performs its own last-second text check.
        const sent = send(text);
        finish(sent.ok && sent.clicked ? 'CLICKED' : 'FAILED',
          sent.ok ? '' : (sent.error || 'SEND_FAILED'));
      };
      observer = new MutationObserver(attempt);
      observer.observe(document.body, {
        childList: true, subtree: true, attributes: true, characterData: true
      });
      timeoutId = setTimeout(() => finish('FAILED', 'SEND_CONTROL_NOT_READY'), 5000);
      queueMicrotask(attempt);
      return {ok: true, started: true};
    };
    const receipt = expected => {
      const e = editor(), path = location.pathname;
      const users = all('[data-message-author-role="user"]');
      const target = norm(expected);
      const sent = path.startsWith('/c/') && (users.some(u => norm(u.innerText || u.textContent) === target) ||
        (document.body.innerText || '').includes('You said:') &&
        norm(document.body.innerText || '').includes(target.slice(0, 120)));
      if (!sent) return {ok: true, sent: false, path};
      if (!e) return {ok: true, sent: true, draftEmpty: false};
      let draft = norm(value(e));
      if (draft === target && !erase(e)) return {ok: false, error: 'SENT_DRAFT_CLEAR_FAILED'};
      draft = norm(value(e));
      return {ok: true, sent: true, path, draftEmpty: !draft,
        error: draft ? 'NEW_UNSENT_DRAFT_PRESERVED' : ''};
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
    const readAloud = action => {
      // A fresh second-browser chat contains one assistant turn. Its actual
      // per-message Read aloud button was verified on owner Android WebView.
      const buttons = all('button[aria-label="Read aloud"]')
        .filter(b => !b.disabled && b.getAttribute('aria-disabled') !== 'true');
      if (action === 'inspect')
        return {ok: true, ready: buttons.length === 1, count: buttons.length};
      if (action === 'start') {
        if (buttons.length !== 1)
          return {ok: false, error: 'READ_ALOUD_BUTTON_COUNT_' + buttons.length};
        buttons[0].click();
        return {ok: true, clicked: true};
      }
      return {ok: false, error: 'READ_ALOUD_ACTION_INVALID'};
    };

    // The user's unrelated unsent draft is never discarded. Store it under
    // chatgpt.com localStorage, and restore/verify it after this cycle. Text
    // never crosses the dashboard bridge; only lengths and receipts do.
    const draftEscrow = (action, slot) => {
      if (slot !== 0 && slot !== 1)
        return {ok: false, error: 'INVALID_DRAFT_SLOT'};
      const key = '__dexaCycleDraftEscrowV165_' + slot;
      let record = null;
      try {
        const raw = localStorage.getItem(key);
        record = raw ? JSON.parse(raw) : null;
      } catch { return {ok: false, error: 'DRAFT_BACKUP_CORRUPT'}; }
      if (record && (record.slot !== slot || record.path !== '/' ||
          typeof record.text !== 'string' || !record.text.length))
        return {ok: false, error: 'DRAFT_BACKUP_INVALID'};
      if (action === 'inspect')
        return {ok: true, pending: !!record, length: record?.text.length || 0};
      if (location.pathname !== '/')
        return {ok: false, error: 'DRAFT_REQUIRES_NEW_CHAT'};
      const e = editor();
      if (!e) return {ok: false, error: 'DRAFT_EDITOR_MISSING'};
      if (action === 'stash') {
        if (record) return {ok: false, error: 'DRAFT_BACKUP_ALREADY_PENDING'};
        const text = value(e);
        if (!norm(text)) return {ok: true, saved: false};
        if (text.length > 12000 || e.querySelector('img,figure,[data-testid*="file"],[data-testid*="attachment"]'))
          return {ok: false, error: 'RICH_OR_LARGE_DRAFT_PRESERVED'};
        const backup = {slot, path: '/', text, at: Date.now()};
        localStorage.setItem(key, JSON.stringify(backup));
        const readback = JSON.parse(localStorage.getItem(key) || 'null');
        if (!readback || readback.text !== text)
          return {ok: false, error: 'DRAFT_BACKUP_WRITE_UNVERIFIED'};
        if (!erase(e)) return {ok: false, error: 'DRAFT_ERASE_FAILED_BACKUP_SAFE'};
        return {ok: true, saved: true, length: text.length};
      }
      if (action === 'restore') {
        if (!record) return {ok: true, pending: false};
        const text = value(e);
        if (text === record.text)
          return {ok: true, already: true, length: record.text.length};
        if (norm(text))
          return {ok: false, error: 'DIFFERENT_DRAFT_PRESERVED_BACKUP_SAFE'};
        e.focus();
        const sel = window.getSelection(), range = document.createRange();
        range.selectNodeContents(e); range.collapse(false);
        sel.removeAllRanges(); sel.addRange(range);
        const inserted = document.execCommand('insertText', false, record.text);
        return {ok: !!inserted && value(e) === record.text,
          error: 'DRAFT_RESTORE_WRITE_UNVERIFIED', length: record.text.length};
      }
      if (action === 'verify' || action === 'commit') {
        if (!record) return {ok: false, error: 'DRAFT_BACKUP_MISSING_BEFORE_COMMIT'};
        if (value(e) !== record.text)
          return {ok: false, error: 'DRAFT_RESTORE_NOT_PERSISTENT_BACKUP_SAFE'};
        if (action === 'commit') localStorage.removeItem(key);
        return {ok: true, restored: action === 'commit', length: record.text.length};
      }
      return {ok: false, error: 'INVALID_DRAFT_ACTION'};
    };

    const clearRoot = expected => {
      if (location.pathname !== '/') return {ok: true, checked: false};
      if ((document.body.innerText || '').includes('You said:'))
        return {ok: true, checked: false};
      const e = editor();
      if (!e || norm(value(e)) !== norm(expected)) return {ok: true, checked: true};
      return {ok: erase(e), cleared: !norm(value(e))};
    };
    const guard = expected => {
      if (!location.pathname.startsWith('/c/') || !norm(expected))
        return {ok: false, error: 'GUARD_NOT_SENT_CHAT'};
      const key = '__dexaCycleRootDraftGuard160';
      const old = window[key];
      if (old?.timer) clearInterval(old.timer);
      const item = window[key] = {at: Date.now(), expected, cleared: 0};
      item.timer = setInterval(() => {
        if (Date.now() - item.at > 30 * 60 * 1000) {
          clearInterval(item.timer); item.timer = null; return;
        }
        const r = clearRoot(item.expected);
        if (r?.cleared) item.cleared++;
      }, 1000);
      return {ok: true};
    };

    window[NAME] = {revision: 'power-slider-draftsafe-v168', snapshot, model, voice, compose, checkComposer, send, sendOnce, sendStatus, receipt, answer, readAloud, draftEscrow, clearRoot, guard};
    return {ok: true, installed: true};
  }

  // Page loads can replace a ChatGPT document between native eval calls.
  // A missing helper must be a structured receipt, never a JS TypeError.
  // Retry only when the helper was absent BEFORE the requested action.
  const invokeOnce = (slot, method, ...args) => evalBatched(slot,
    '(()=>{const a=window[' + JSON.stringify(AGENT) + '];' +
    'if(!a || a.revision!=="power-slider-draftsafe-v168")' +
    'return {ok:false,error:"AGENT_MISSING",path:location.pathname};' +
    'const f=a[' + JSON.stringify(method) + '];' +
    'if(typeof f!=="function")return {ok:false,error:"AGENT_METHOD_MISSING"};' +
    'return f(' + args.map(x => JSON.stringify(x)).join(',') + ');})()',
    () => {}, false);
  const install = slot => evalBatched(slot,
    '(()=>{const r=(' + installBrowserAgent.toString() + ')();' +
    'const a=window[' + JSON.stringify(AGENT) + '];' +
    'return {ok:r?.ok===true && a?.revision==="power-slider-draftsafe-v168" && ' +
    'typeof a.snapshot==="function",error:r?.error||"AGENT_INSTALL_UNVERIFIED",' +
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
    // Initial ChatGPT hydration may replace the document just after loading.
    // Wait for a real readback; invoke will reinstall if that happened.
    const before = await until(async () => {
      try { return assertOk(await invoke(slot, 'snapshot'), 'FIRST_SNAPSHOT'); }
      catch { return null; }
    }, 20000, 'FIRST_CHAT_NOT_STABLE');
    if (before?.voiceActive) {
      assertOk(await invoke(slot, 'voice', 'text'), 'END_PREVIOUS_VOICE');
      await until(async () => !(await invoke(slot, 'snapshot')).voiceActive,
        15000, 'PREVIOUS_VOICE_STILL_ACTIVE');
    }
    await nativeCall('navigate', {slot, url: 'https://chatgpt.com/'});
    await until(async () => {
      try {
        const s = await invoke(slot, 'snapshot');
        return s.ok && s.path === '/' && s.editorReady ? s : null;
      } catch { return null; }
    }, 16000, 'NEW_CHAT_EDITOR_NOT_READY');
    // The composer appears earlier than the model selector on real phone.
    // Recheck after hydration instead of assuming a fixed delay is sufficient.
    await sleep(650);
    const s = assertOk(await invoke(slot, 'snapshot'), 'NEW_CHAT_SNAPSHOT');
    if (s.path !== '/' || !s.editorReady)
      throw Error('NEW_CHAT_EDITOR_DISAPPEARED');
    const pending = assertOk(await invoke(slot, 'draftEscrow', 'inspect', slot), 'DRAFT_BACKUP_INSPECT');
    if (pending.pending) {
      protectedSlots.add(slot);
      throw Error('PREVIOUS_DRAFT_BACKUP_NEEDS_RESTORATION_SLOT_' + (slot + 1));
    }
    if (s.draftLength) {
      if (priorSent[slot])
        assertOk(await invoke(slot, 'clearRoot', priorSent[slot]), 'ROOT_DRAFT_CLEANUP');
      const checked = assertOk(await invoke(slot, 'snapshot'), 'DRAFT_RECHECK');
      if (checked.draftLength) {
        protectedSlots.add(slot);
        assertOk(await invoke(slot, 'draftEscrow', 'stash', slot), 'SAVE_UNSENT_DRAFT');
        const cleared = assertOk(await invoke(slot, 'snapshot'), 'VERIFY_DRAFT_BACKUP');
        if (cleared.draftLength) throw Error('DRAFT_BACKUP_NOT_CLEARED');
      }
    }
  }

  // Recover local backups even after failed/cancelled runs. Do not use
  // active(): cancellation must never prevent restoring the owner's draft.
  async function restoreSavedDrafts() {
    const failures = [];
    for (const slot of protectedSlots) {
      try {
        const pending = assertOk(await invoke(slot, 'draftEscrow', 'inspect', slot), 'DRAFT_RESTORE_INSPECT');
        if (!pending.pending) continue;
        stage('RESTORING_DRAFT', 'بازگرداندن پیش‌نویس محفوظ مرورگر ' + (slot + 1) + '...', slot);
        await nativeCall('navigate', {slot, url: 'https://chatgpt.com/'});
        let ready = false;
        const end = Date.now() + 26000;
        while (Date.now() < end) {
          try {
            const view = await invoke(slot, 'snapshot');
            if (view.ok && view.path === '/' && view.editorReady) { ready = true; break; }
          } catch {}
          await sleep(650);
        }
        if (!ready) throw Error('DRAFT_RESTORE_CHAT_NOT_READY');
        await sleep(850);
        assertOk(await invoke(slot, 'draftEscrow', 'restore', slot), 'DRAFT_RESTORE_WRITE');
        await sleep(900);
        assertOk(await invoke(slot, 'draftEscrow', 'verify', slot), 'DRAFT_RESTORE_VERIFY');
        await sleep(1100);
        const committed = assertOk(await invoke(slot, 'draftEscrow', 'commit', slot), 'DRAFT_RESTORE_COMMIT');
        if (!committed.restored) throw Error('DRAFT_RESTORE_NOT_CONFIRMED');
        protectedSlots.delete(slot);
      } catch (error) {
        failures.push('SLOT_' + (slot + 1) + ':' + String(error?.message || error));
      }
    }
    return failures;
  }

  async function setEffort(slot, target) {
    if (!levels.includes(target)) throw Error('INVALID_EFFORT');
    const positions = {Instant: 0, Medium: 1, High: 2, 'Extra High': 3};
    const expected = positions[target];
    // The owner's real ChatGPT model trigger can transiently disappear for
    // many seconds. If the requested effort already appears on the exact
    // model button twice, there is no reason to open a fragile Radix menu.
    try {
      const before = assertOk(await invoke(slot, 'snapshot'), 'HEADER_PREFLIGHT');
      if (before.path === '/' && before.editorReady && before.modelReady) {
        const one = assertOk(await invoke(slot, 'model', 'selected'), 'HEADER_EFFORT_ONE');
        if (one.level === target && !one.expanded) {
          await sleep(750);
          const two = assertOk(await invoke(slot, 'model', 'selected'), 'HEADER_EFFORT_TWO');
          if (two.level === target && !two.expanded) return;
        }
      }
    } catch (error) {
      if (!/^(?:HEADER_EFFORT_(?:ONE|TWO):)?MODEL_SELECTOR_NOT_FOUND$/.test(
          String(error?.message || error))) throw error;
    }
    // Real phone: React can rehydrate after reporting that Open succeeded,
    // and close the menu before the next inspect. Retry only before any
    // slider step; never repeat an ambiguous changed setting or Send.
    let transientCount = 0;
    const transient = code => {
      transientCount++;
      if (transientCount === 1 || transientCount % 7 === 0)
        scriptStage(slot, 'CYCLE_MODEL_RETRY_' + code, '', undefined, state.runId);
      return null;
    };
    let view = await until(async () => {
      const s = assertOk(await invoke(slot, 'snapshot'), 'MODEL_READY_SNAPSHOT');
      if (s.path !== '/' || !s.editorReady || !s.modelReady)
        return transient('NOT_READY');
      try { assertOk(await invoke(slot, 'model', 'open'), 'MODEL_MENU'); }
      catch (error) {
        if (/^(?:MODEL_MENU:)?MODEL_SELECTOR_NOT_FOUND$/.test(
            String(error?.message || error))) return transient('OPEN_SELECTOR_MISSING');
        throw error;
      }
      await sleep(450);
      try { return assertOk(await invoke(slot, 'model', 'inspect'), 'MODEL_POWER'); }
      catch (error) {
        // The model trigger can disappear AFTER the safe Open operation,
        // while the WebView replaces the model header. The pre-change
        // inspection can then report MODEL_SELECTOR_NOT_FOUND. It is safe to
        // retry this whole preflight, but never any slider step or Send.
        if (/^(?:MODEL_POWER:)?(?:MODEL_SELECTOR_NOT_FOUND|MODEL_MENU_CLOSED|POWER_CONTROL_COUNT_0|POWER_STATUS_NOT_FOUND)$/.test(
            String(error?.message || error))) return transient('INSPECT_NOT_READY');
        throw error;
      }
    }, 18000, 'MODEL_POWER_NOT_STABLE', 700);
    if (view.index < 0 || view.index > 4 || view.level !==
        ['Instant','Medium','High','Extra High','Pro'][view.index])
      throw Error('MODEL_POWER_UNVERIFIED');
    for (let count = 0; count < 5 && view.index !== expected; count++) {
      active();
      const direction = view.index < expected ? 'right' : 'left';
      const prior = view.index;
      assertOk(await invoke(slot, 'model', 'step', direction), 'POWER_STEP');
      await sleep(350);
      view = assertOk(await invoke(slot, 'model', 'inspect'), 'POWER_READBACK');
      if (view.index !== prior + (direction === 'right' ? 1 : -1))
        throw Error('POWER_DID_NOT_CHANGE');
    }
    if (view.index !== expected || view.level !== target ||
        view.triggerLevel !== target)
      throw Error('EFFORT_NOT_VERIFIED_' + target.replace(/\s/g, '_'));
    assertOk(await invoke(slot, 'model', 'dismiss'), 'MODEL_DISMISS');
    await until(async () => {
      const selected = assertOk(await invoke(slot, 'model', 'selected'), 'MODEL_SELECTED');
      if (selected.level !== target)
        throw Error('EFFORT_NOT_PERSISTED_' + target.replace(/\s/g, '_'));
      return !selected.expanded ? selected : null;
    }, 9000, 'MODEL_MENU_NOT_DISMISSED', 450);
  }

  async function setVoice(slot, voice) {
    const mode = voice ? 'voice' : 'text';
    assertOk(await invoke(slot, 'voice', mode), 'SET_SECOND_MODE');
    await until(async () => {
      const s = await invoke(slot, 'snapshot');
      return s?.voiceActive === voice && (!voice || !s.connecting) ? true : null;
    }, voice ? 40000 : 15000, 'SECOND_MODE_NOT_READY');
    if (voice) await sleep(2700);
  }

  async function verifyEffortForSend(slot, target) {
    await until(async () => {
      const snap = assertOk(await invoke(slot, 'snapshot'), 'PRE_SEND_EFFORT_SNAPSHOT');
      if (snap.path !== '/' || !snap.editorReady) throw Error('PRE_SEND_PAGE_CHANGED');
      if (!snap.modelReady) return null;
      let chosen;
      try { chosen = assertOk(await invoke(slot, 'model', 'selected'), 'PRE_SEND_MODEL_SELECTED'); }
      catch (error) {
        if (String(error?.message || error) === 'MODEL_SELECTOR_NOT_FOUND') return null;
        throw error;
      }
      if (chosen.level !== target || chosen.expanded)
        throw Error('PRE_SEND_EFFORT_MISMATCH_' + target.replace(/\s/g, '_'));
      return true;
    }, 10000, 'PRE_SEND_EFFORT_NOT_AVAILABLE', 650);
  }

  async function submit(slot, text, effort) {
    active();
    await verifyEffortForSend(slot, effort);
    const before = assertOk(await invoke(slot, 'snapshot'), 'PRE_SEND_SNAPSHOT');
    if (before.path !== '/' || !before.editorReady || before.draftLength)
      throw Error('COMPOSER_NOT_EMPTY_SLOT_' + (slot + 1));
    assertOk(await invoke(slot, 'sendOnce', text), 'SEND_ONCE_SLOT_' + (slot + 1));
    const receipt = await until(async () => {
      const r = await invoke(slot, 'receipt', text);
      if (r?.ok === false) throw Error('SEND_RECEIPT:' + r.error);
      if (r?.sent && r?.draftEmpty) return r;
      const status = assertOk(await invoke(slot, 'sendStatus'), 'SEND_STATUS');
      if (status.stage === 'FAILED') throw Error(status.error);
      return null;
    }, 13000, 'SEND_NOT_CONFIRMED_SLOT_' + (slot + 1), 450);
    priorSent[slot] = text;
    assertOk(await invoke(slot, 'guard', text), 'ROOT_DRAFT_GUARD');
    return receipt;
  }

  async function waitAnswer(slot, timeout) {
    let prior = '', stableSince = 0, missingSince = 0;
    return until(async () => {
      const v = assertOk(await invoke(slot, 'answer'), 'READ_ANSWER');
      // After a confirmed Send, going back to home with no user turn is a
      // specific lost-conversation failure. Do not wait 180s for that.
      if (!v.hasUser || !v.path.startsWith('/c/')) {
        if (!missingSince) missingSince = Date.now();
        if (Date.now() - missingSince > 6500)
          throw Error('SENT_CONVERSATION_DISAPPEARED_SLOT_' + (slot + 1));
        prior = ''; stableSince = 0; return null;
      }
      missingSince = 0;
      if (!v.answer || v.busy || !v.completed) {
        prior = ''; stableSince = 0; return null;
      }
      if (v.answer !== prior) { prior = v.answer; stableSince = Date.now(); return null; }
      return Date.now() - stableSince >= 2000 ? v.answer : null;
    }, timeout, 'REPLY_NOT_CONFIRMED_SLOT_' + (slot + 1), 850);
  }

  async function run() {
    if (state.running) return;
    state.output = ''; state.error = ''; state.runId = crypto.randomUUID();
    const settings = {prompt: state.prompt.trim(), first: state.first,
      second: state.second, voice: state.voice, wrapper: state.wrapper};
    if (!settings.prompt) {
      stage('INPUT_REQUIRED', 'ابتدا پیام اصلی را بنویس.'); return;
    }
    if (!hostState || hostState.count < 2 || !window.DexaHost) {
      stage('HOST_REQUIRED', 'برای اجرا، داشبورد باید به دو مرورگر اندروید متصل باشد.'); return;
    }
    state.running = true; state.cancelled = false;
    protectedSlots.clear();
    try {
      const old = window.DexaAutoHandoff;
      if (old) {
        const status = old.read();
        if (status?.busy || ['TRANSFER','SENT'].includes(status?.stage))
          throw Error('PREVIOUS_AUTOMATIC_TRANSFER_BUSY');
        old.stop();
        if (old.read().enabled) throw Error('PREVIOUS_AUTOMATIC_TRANSFER_BUSY');
      }
      stage('FIRST_CHAT', 'مرورگر اول: ساخت چت تازه و بررسی کادر پیام...');
      await prepare(0);
      stage('FIRST_EFFORT', 'مرورگر اول: تنظیم و تأیید ایفورت «' + settings.first + '»...');
      await setEffort(0, settings.first);
      stage('FIRST_SEND', 'مرورگر اول: ارسال پیام اصلی...');
      await submit(0, settings.prompt, settings.first);
      if (state.prompt.trim() === settings.prompt) state.prompt = '';
      const input = document.getElementById('cyclePrompt');
      if (input && !state.prompt) input.value = '';
      stage('FIRST_REPLY', 'مرورگر اول: منتظر پاسخ کامل...');
      const firstAnswer = await waitAnswer(0, 90000);
      const wrapped = (settings.wrapper.trim() ? settings.wrapper.trim() + '\n\n' : '') + firstAnswer;
      stage('SECOND_CHAT', 'مرورگر دوم: آماده‌کردن چت تازه...');
      await prepare(1);
      stage('SECOND_EFFORT', 'مرورگر دوم: تنظیم و تأیید ایفورت «' + settings.second + '»...', 1);
      await setEffort(1, settings.second);
      stage('SECOND_MODE', settings.voice ?
        'مرورگر دوم: آماده‌سازی پاسخ صوتی پس از تولید متن...' : 'مرورگر دوم: تأیید حالت متنی...', 1);
      // ChatGPT Voice opens /c/local-chatgpt:... and cannot use the fresh
      // text-chat send contract. Submit as text first; play the exact reply.
      await setVoice(1, false);
      stage('SECOND_SEND', 'مرورگر دوم: ارسال رپر و پاسخ واقعی مرورگر اول...', 1);
      await submit(1, wrapped, settings.second);
      stage('SECOND_REPLY', 'مرورگر دوم: منتظر پاسخ کامل...', 1);
      const answer = await waitAnswer(1, 90000);
      state.output = answer;
      if (settings.voice) {
        stage('VOICE_PLAYBACK', 'مرورگر دوم: پیدا کردن کنترل خواندن پاسخ با صدا...', 1);
        await until(async () => {
          const r = assertOk(await invoke(1, 'readAloud', 'inspect'), 'VOICE_PLAYBACK_INSPECT');
          if (r.count > 1) throw Error('VOICE_PLAYBACK_AMBIGUOUS');
          return r.ready ? true : null;
        }, 22000, 'VOICE_PLAYBACK_CONTROL_NOT_READY', 750);
        const playback = assertOk(await invoke(1, 'readAloud', 'start'), 'VOICE_PLAYBACK_START');
        if (!playback.clicked) throw Error('VOICE_PLAYBACK_NOT_REQUESTED');
      }
      stage('DONE', settings.voice ?
        'چرخه کامل شد؛ فرمان خواندن پاسخ با صدا در مرورگر دوم اجرا شد. شنیدن صدا روی گوشی نیاز به تأیید دارد.' :
        'چرخهٔ کامل دو مرورگر با پاسخ متنی انجام شد.', 1);
    } catch (e) {
      const error = String(e?.message || e);
      stage('FAILED', 'چرخه در همین مرحله متوقف شد. پیام تکراری ارسال نمی‌شود.', 0, error.slice(0, 140));
    } finally {
      const previous = {stage: state.stage, message: state.message, error: state.error};
      const failures = await restoreSavedDrafts();
      if (failures.length)
        stage('DRAFT_RESTORE_PENDING',
          'پیش‌نویس اصلی به‌صورت محلی محفوظ مانده، ولی بازگردانی خودکار کامل نشد.',
          0, failures.join(';').slice(0, 140));
      else if (state.stage === 'RESTORING_DRAFT')
        stage(previous.stage, previous.message, 0, previous.error);
      state.running = false; paint();
    }
  }

  window.DexaCycle = {mount, read: () => ({
    stage: state.stage, running: state.running, error: state.error,
    outputLength: state.output.length, runId: state.runId
  })};
  if (typeof selectedBoard !== 'undefined' && selectedBoard === 'cycle') mount();
})();