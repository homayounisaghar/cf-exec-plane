(() => {
  'use strict';
  const STORAGE = 'dexa-auto-handoff-once-v3';
  const POLL_MS = 2200;
  const STABLE_MS = 2800;
  const MAX_ANSWER = 50000;
  const WRAPPER = 'این مسئله رو حل کن:\n\n';
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const normalize = text => String(text || '').replace(/\s+/g, ' ').trim();

  let enabled = !localStorage.getItem(STORAGE);
  let busy = false;
  let sourceDocument = null;
  let baselineSeq = null;
  let candidate = null;
  let lastStage = '';
  let transferredAnswer = null;
  const state = {stage: 'BOOT', enabled, transferCount: 0, error: null, secondReply: null};

  const container = document.createElement('div');
  container.className = 'notice';
  container.style.margin = '12px 0';
  const label = document.createElement('strong');
  label.textContent = 'آزمون خودکار متنی: مرورگر ۱ ← مرورگر ۲';
  const statusLine = document.createElement('div');
  statusLine.style.margin = '6px 0';
  const help = document.createElement('small');
  help.textContent = 'فقط یک پاسخ تازه را منتقل می‌کند؛ پس از ارسال، پیش‌نویس هر مرورگر بررسی و پاک می‌شود. بدون صدا.';
  const controls = document.createElement('div');
  controls.className = 'row';
  controls.style.marginTop = '9px';
  const rearm = document.createElement('button');
  rearm.textContent = 'آماده‌کردن یک انتقال دیگر';
  const stop = document.createElement('button');
  stop.textContent = 'توقف';
  controls.append(rearm, stop);
  container.append(label, statusLine, help, controls);
  const kpis = document.querySelector('main .kpis');
  if (!kpis) return;
  kpis.insertAdjacentElement('afterend', container);

  function status(stage, message, code) {
    state.stage = stage;
    statusLine.textContent = message;
    if (lastStage !== stage) {
      lastStage = stage;
      try {
        if (typeof scriptStage === 'function')
          scriptStage(stage.startsWith('SECOND') || stage === 'SENT' ? 1 : 0,
            'AUTO_' + stage, code || '', undefined, 'dexa-auto-handoff');
      } catch {}
    }
  }

  function observeFirst() {
    const key = '__dexaAutoHandoffFirstV1';
    let tracker = window[key];
    if (!tracker) {
      tracker = {doc: Math.random().toString(36).slice(2), seq: 0, last: null};
      window[key] = tracker;
      function markSubmission() {
        const editor = document.querySelector('[contenteditable="true"][role="textbox"][aria-label="Ask ChatGPT"]');
        const input = editor && editor.innerText && editor.innerText.trim();
        if (!input) return;
        const now = Date.now();
        if (tracker.last && tracker.last.text === input && now - tracker.last.at < 1500) return;
        const existing = document.body.innerText || '';
        tracker.last = {seq: ++tracker.seq, at: now, text: input,
          baseAssistantCount: (existing.match(/ChatGPT said:/g) || []).length};
      }
      document.addEventListener('submit', e => {
        if (e.target && e.target.querySelector && e.target.querySelector('[contenteditable="true"]'))
          markSubmission();
      }, true);
      document.addEventListener('click', e => {
        const target = e.target && e.target.closest && e.target.closest('button[type="submit"][aria-label="Send"]');
        if (target) markSubmission();
      }, true);
      document.addEventListener('keydown', e => {
        if (e.key === 'Enter' && !e.shiftKey && !e.isComposing &&
            e.target && e.target.closest &&
            e.target.closest('[contenteditable="true"][role="textbox"]'))
          markSubmission();
      }, true);
    }
    const last = tracker.last;
    const common = {ok: location.hostname === 'chatgpt.com', doc: tracker.doc, seq: tracker.seq,
      path: location.pathname};
    if (!last) return {...common, hasSubmission: false};
    const page = document.body.innerText || '';
    const count = (page.match(/ChatGPT said:/g) || []).length;
    const endUser = page.lastIndexOf('You said:');
    const startAnswer = page.lastIndexOf('ChatGPT said:');
    const suffix = startAnswer >= 0 ? page.slice(startAnswer + 'ChatGPT said:'.length) : '';
    const completed = startAnswer > endUser && suffix.includes('Response complete');
    const answer = suffix
      .split('Is this conversation helpful so far?')[0]
      .split('ChatGPT can make mistakes.')[0]
      .split('Response complete')[0].trim();
    const fresh = count > last.baseAssistantCount && startAnswer > endUser;
    // A browser-1 submission is not allowed to leave its old draft behind.
    // Never touch a newer draft which differs from the submitted message.
    if (fresh && completed && last.text) {
      const editor = document.querySelector('[contenteditable="true"][role="textbox"][aria-label="Ask ChatGPT"]');
      const norm = x => String(x || '').replace(/\s+/g, ' ').trim();
      if (editor && norm(editor.innerText) === norm(last.text)) {
        editor.focus();
        const selection = window.getSelection(), range = document.createRange();
        range.selectNodeContents(editor);
        selection.removeAllRanges();
        selection.addRange(range);
        document.execCommand('delete', false, null);
      }
    }
    return {...common, hasSubmission: true, baseCount: last.baseAssistantCount,
      assistantCount: count, answer: fresh ? answer.slice(0, 50001) : '',
      completed: fresh && completed, promptLength: last.text.length};
  }

  function secondReady() {
    const editor = document.querySelector('[contenteditable="true"][role="textbox"][aria-label="Ask ChatGPT"]');
    return {ok: location.hostname === 'chatgpt.com', path: location.pathname,
      draftLength: editor ? (editor.innerText || '').trim().length : 0,
      editorReady: !!editor,
      audibleMedia: [...document.querySelectorAll('audio,video')].some(x => !x.paused),
      voiceActive: !!document.querySelector('[aria-label="End Voice"],[aria-label="Exit Voice"],[aria-label="Leave Voice"]')};
  }

  // Called only on a new-chat page or after a confirmed send. Unlike
  // editor.innerHTML='', execCommand participates in ProseMirror editing.
  function clearComposer(expected) {
    const norm = x => String(x || '').replace(/\s+/g, ' ').trim();
    if (location.hostname !== 'chatgpt.com' ||
        !(/^\/c\//.test(location.pathname) || location.pathname === '/'))
      return {ok: false, error: 'NOT_CHATGPT_COMPOSER'};
    if ([...document.querySelectorAll('audio,video')].some(x => !x.paused))
      return {ok: false, error: 'AUDIO_PLAYING'};
    const editor = document.querySelector('[contenteditable="true"][role="textbox"][aria-label="Ask ChatGPT"]');
    if (!editor) return {ok: false, error: 'EDITOR_MISSING'};
    const draft = norm(editor.innerText);
    if (!draft) return {ok: true, empty: true, changed: false};
    if (expected !== null && draft !== norm(expected))
      return {ok: false, error: 'DIFFERENT_UNSENT_DRAFT', draftLength: draft.length};
    editor.focus();
    const selection = window.getSelection(), range = document.createRange();
    range.selectNodeContents(editor);
    selection.removeAllRanges();
    selection.addRange(range);
    document.execCommand('delete', false, null);
    return {ok: !norm(editor.innerText), changed: true,
      error: norm(editor.innerText) ? 'DRAFT_STILL_PRESENT' : null};
  }

  function secondCompose(prompt) {
    const norm = x => String(x || '').replace(/\s+/g, ' ').trim();
    if (location.hostname !== 'chatgpt.com' || location.pathname !== '/')
      return {ok: false, error: 'NOT_BLANK_CHAT'};
    const editor = document.querySelector('[contenteditable="true"][role="textbox"][aria-label="Ask ChatGPT"]');
    if (!editor || norm(editor.innerText)) return {ok: false, error: 'COMPOSER_NOT_EMPTY'};
    editor.focus();
    const selection = window.getSelection(), range = document.createRange();
    range.selectNodeContents(editor);
    selection.removeAllRanges();
    selection.addRange(range);
    const inserted = document.execCommand('insertText', false, prompt);
    return {ok: !!inserted && norm(editor.innerText) === norm(prompt),
      length: editor.innerText.length};
  }

  function secondSend(expected) {
    const norm = x => String(x || '').replace(/\s+/g, ' ').trim();
    const editor = document.querySelector('[contenteditable="true"][role="textbox"][aria-label="Ask ChatGPT"]');
    if (location.hostname !== 'chatgpt.com' || location.pathname !== '/' ||
        !editor || norm(editor.innerText) !== norm(expected))
      return {ok: false, error: 'DRAFT_MISMATCH'};
    if ([...document.querySelectorAll('audio,video')].some(x => !x.paused))
      return {ok: false, error: 'AUDIO_PLAYING'};
    const buttons = [...document.querySelectorAll('button[type="submit"][aria-label="Send"]')]
      .filter(b => !b.disabled);
    if (buttons.length !== 1) return {ok: false, error: 'SEND_BUTTON_COUNT_' + buttons.length};
    buttons[0].click();
    return {ok: true, sent: true};
  }

  // After Send was clicked, only clear the editor when the new chat
  // actually contains the forwarded message, not merely because click returned.
  function secondPostSend(expected) {
    const page = document.body.innerText || '';
    const sent = location.hostname === 'chatgpt.com' &&
      location.pathname.startsWith('/c/') &&
      page.includes('You said:') && page.includes('این مسئله رو حل کن:');
    if (!sent) return {ok: false, awaitingSend: true};
    const norm = x => String(x || '').replace(/\s+/g, ' ').trim();
    const editor = document.querySelector('[contenteditable="true"][role="textbox"][aria-label="Ask ChatGPT"]');
    if (!editor) return {ok: false, error: 'EDITOR_MISSING'};
    const draft = norm(editor.innerText);
    if (!draft) return {ok: true, sendConfirmed: true, draftEmpty: true};
    if (draft !== norm(expected)) return {
      ok: false, sendConfirmed: true, error: 'NEW_UNSENT_DRAFT_PRESERVED'};
    editor.focus();
    const selection = window.getSelection(), range = document.createRange();
    range.selectNodeContents(editor);
    selection.removeAllRanges();
    selection.addRange(range);
    document.execCommand('delete', false, null);
    return {ok: !norm(editor.innerText), sendConfirmed: true,
      draftEmpty: !norm(editor.innerText)};
  }

  // Keep one short-lived, exact-match guard in WebView 2. The ChatGPT app
  // can rehydrate the previous new-chat draft when a sent chat is deleted.
  // Clearing the composer in /c/... alone does not clear this separate draft.
  function armNewChatDraftGuard(expected) {
    const norm = x => String(x || '').replace(/\s+/g, ' ').trim();
    if (location.hostname !== 'chatgpt.com' || !location.pathname.startsWith('/c/'))
      return {ok: false, error: 'NOT_SENT_CHAT'};
    const text = norm(expected);
    if (!text) return {ok: false, error: 'EMPTY_EXPECTED'};
    const key = '__dexaNewChatDraftGuardV3';
    const previous = window[key];
    if (previous && previous.timer) clearInterval(previous.timer);
    const guard = {startedAt: Date.now(), clearCount: 0, failedCount: 0,
      expectedLength: text.length, last: 'ARMED', timer: null};
    window[key] = guard;
    const inspect = () => {
      if (Date.now() - guard.startedAt > 30 * 60 * 1000) {
        clearInterval(guard.timer);
        guard.timer = null;
        guard.last = 'EXPIRED';
        return;
      }
      if (location.hostname !== 'chatgpt.com' || location.pathname !== '/') return;
      const editor = document.querySelector(
        '[contenteditable="true"][role="textbox"][aria-label="Ask ChatGPT"]');
      if (!editor || norm(editor.innerText) !== text) return;
      // Only the empty/new-chat route is allowed; preserve unrelated drafts.
      if ((document.body.innerText || '').includes('You said:')) return;
      editor.focus();
      const selection = window.getSelection(), range = document.createRange();
      range.selectNodeContents(editor);
      selection.removeAllRanges();
      selection.addRange(range);
      document.execCommand('delete', false, null);
      if (!norm(editor.innerText)) {
        guard.clearCount++;
        guard.last = 'CLEARED';
      } else {
        guard.failedCount++;
        guard.last = 'CLEAR_FAILED';
      }
    };
    guard.timer = setInterval(inspect, 1000);
    return {ok: true, installed: true};
  }

  function secondAnswer() {
    const page = document.body.innerText || '';
    const pos = page.lastIndexOf('ChatGPT said:');
    const suffix = pos >= 0 ? page.slice(pos + 'ChatGPT said:'.length) : '';
    const answer = suffix.split('Is this conversation helpful so far?')[0]
      .split('ChatGPT can make mistakes.')[0]
      .split('Response complete')[0].trim();
    return {ok: location.hostname === 'chatgpt.com', path: location.pathname,
      completed: pos >= 0 && suffix.includes('Response complete'),
      answer: answer.slice(0, 300), hasUser: page.includes('You said:'),
      audibleMedia: [...document.querySelectorAll('audio,video')].some(x => !x.paused)};
  }

  function execOn(slot, fn, ...args) {
    const expression = '(' + fn.toString() + ')(' + args.map(x => JSON.stringify(x)).join(',') + ')';
    return evalBatched(slot, expression, () => {}, false);
  }

  async function forward(answer) {
    localStorage.setItem(STORAGE, 'inflight');
    enabled = false;
    state.enabled = false;
    transferredAnswer = answer;
    status('TRANSFER', 'پاسخ تازهٔ مرورگر اول دریافت شد؛ آماده‌سازی چت متنی دوم...');
    try {
      if (!answer || answer.length > MAX_ANSWER)
        throw Error('ANSWER_LENGTH_UNSUPPORTED');
      const targetPrompt = WRAPPER + answer;
      let check = await execOn(1, secondReady);
      if (!check?.ok || check.voiceActive || check.audibleMedia)
        throw Error('SECOND_BROWSER_UNSAFE');
      if (check.path !== '/') {
        await nativeCall('navigate', {slot: 1, url: 'https://chatgpt.com/'});
        for (let i = 0; i < 30; i++) {
          await sleep(450);
          check = await execOn(1, secondReady);
          if (check?.ok && check.editorReady && check.path === '/') break;
        }
      }
      if (!check?.ok || !check.editorReady || check.path !== '/')
        throw Error('SECOND_NEW_CHAT_NOT_READY');
      // Wait through ChatGPT's initial draft hydration before editing the new chat.
      await sleep(550);
      check = await execOn(1, secondReady);
      if (!check?.ok || !check.editorReady || check.path !== '/')
        throw Error('SECOND_NEW_CHAT_NOT_READY');
      if (check.voiceActive || check.audibleMedia) throw Error('VOICE_OR_AUDIO_ACTIVE');
      // The new-chat editor can resurrect a stale draft from a previous send.
      // Clear only this new-chat composer, verify read-back, then compose.
      for (let i = 0; i < 4 && check.draftLength; i++) {
        const result = await execOn(1, clearComposer, null);
        if (!result?.ok) throw Error('SECOND_DRAFT_CLEAR_FAILED:' + String(result?.error || ''));
        await sleep(350);
        check = await execOn(1, secondReady);
      }
      if (check.draftLength) throw Error('SECOND_DRAFT_NOT_EMPTY');
      const prepared = await execOn(1, secondCompose, targetPrompt);
      if (!prepared?.ok) throw Error('SECOND_COMPOSE_FAILED:' + String(prepared?.error || ''));
      await sleep(500);
      const sent = await execOn(1, secondSend, targetPrompt);
      if (!sent?.ok || !sent.sent) throw Error('SECOND_SEND_FAILED:' + String(sent?.error || ''));
      // Do not declare success until the sent message appears in the new chat
      // and the composer is empty. Never erase a different, newly typed draft.
      let postSend = null;
      for (let i = 0; i < 24; i++) {
        await sleep(400);
        postSend = await execOn(1, secondPostSend, targetPrompt);
        if (postSend?.ok && postSend.sendConfirmed && postSend.draftEmpty) break;
        if (postSend?.error && !postSend.awaitingSend)
          throw Error('SECOND_POST_SEND:' + postSend.error);
      }
      if (!postSend?.ok || !postSend.sendConfirmed || !postSend.draftEmpty)
        throw Error('SECOND_DRAFT_NOT_CLEARED_AFTER_SEND');
      // The root (/) composer has separate draft persistence from the sent
      // /c/... composer. Guard root when the owner later deletes this chat.
      const guarded = await execOn(1, armNewChatDraftGuard, targetPrompt);
      if (!guarded?.ok) throw Error('SECOND_NEW_CHAT_GUARD_FAILED');
      localStorage.setItem(STORAGE, 'done');
      state.transferCount++;
      status('SENT', 'پاسخ مرورگر اول خودکار به چت دوم فرستاده شد؛ منتظر پاسخ چت دوم...');
      for (let i = 0; i < 45; i++) {
        await sleep(1700);
        const result = await execOn(1, secondAnswer);
        if (result?.completed && result.hasUser && result.path.startsWith('/c/') && result.answer) {
          const finalDraft = await execOn(1, secondPostSend, targetPrompt);
          if (!finalDraft?.ok || !finalDraft.draftEmpty)
            throw Error('SECOND_DRAFT_REAPPEARED');
          state.secondReply = result.answer;
          status('SECOND_REPLY', 'حلقهٔ متنی کامل شد؛ پاسخ مرورگر دوم: ' + result.answer.slice(0, 120));
          return;
        }
      }
      status('SECOND_PENDING', 'پیام به مرورگر دوم ارسال شد؛ پاسخ آن هنوز تأیید نشده است.');
    } catch (error) {
      state.error = String(error?.message || error);
      status('FAILED', 'انتقال متوقف شد: ' + state.error, state.error.slice(0, 80));
    }
  }

  async function tick() {
    if (busy || !enabled) return;
    if (!window.DexaHost || typeof evalBatched !== 'function' ||
        typeof hostState === 'undefined' || !hostState || hostState.count < 2) {
      status('WAIT_HOST', 'منتظر اتصال اندروید و دو مرورگر...');
      return;
    }
    busy = true;
    try {
      const observed = await execOn(0, observeFirst);
      if (!observed?.ok || !observed.doc) throw Error('FIRST_BROWSER_NOT_READY');
      if (sourceDocument !== observed.doc) {
        sourceDocument = observed.doc;
        baselineSeq = observed.seq;
        candidate = null;
        status('ARMED', 'آماده: حالا یک پرامپت تازه در مرورگر اول ارسال کن.');
        return;
      }
      if (observed.seq <= baselineSeq || !observed.hasSubmission) return;
      if (!observed.completed || !observed.answer) {
        candidate = null;
        status('WAIT_REPLY', 'پیام جدید در مرورگر اول ثبت شد؛ منتظر تکمیل پاسخ...');
        return;
      }
      if (observed.answer.length > MAX_ANSWER) throw Error('FIRST_ANSWER_TOO_LONG');
      const signature = observed.doc + ':' + observed.seq + ':' + observed.answer;
      if (!candidate || candidate.signature !== signature) {
        candidate = {signature, since: Date.now()};
        status('STABILIZING', 'پاسخ مرورگر اول دیده شد؛ بررسی پایداربودن متن...');
        return;
      }
      if (Date.now() - candidate.since >= STABLE_MS)
        await forward(observed.answer);
    } catch (error) {
      state.error = String(error?.message || error);
      status('WAIT_RETRY', 'در حال تلاش دوباره برای خواندن مرورگر اول: ' + state.error.slice(0, 100),
        state.error.slice(0, 80));
    } finally {
      busy = false;
    }
  }

  rearm.onclick = () => {
    if (busy) return;
    localStorage.removeItem(STORAGE);
    enabled = true;
    state.enabled = true;
    state.error = null;
    state.secondReply = null;
    sourceDocument = null;
    baselineSeq = null;
    candidate = null;
    status('REARMED', 'در حال آماده‌کردن یک انتقال تازه...');
    tick().catch(() => {});
  };
  stop.onclick = () => {
    if (busy) return;
    enabled = false;
    state.enabled = false;
    localStorage.setItem(STORAGE, 'done');
    status('STOPPED', 'انتقال خودکار خاموش است.');
  };
  window.DexaAutoHandoff = {
    read: () => ({...state, pending: !!candidate,
      sourceAnswerLength: transferredAnswer?.length || 0}),
    rearm: () => rearm.click(),
    stop: () => stop.click()
  };
  status(enabled ? 'INITIALIZING' : 'STOPPED',
    enabled ? 'در حال اتصال به مرورگر اول...' : 'تست یک‌باره مصرف شده؛ برای تکرار دکمهٔ آماده‌کردن را بزن.');
  setInterval(() => tick().catch(() => {}), POLL_MS);
  tick().catch(() => {});
})();
