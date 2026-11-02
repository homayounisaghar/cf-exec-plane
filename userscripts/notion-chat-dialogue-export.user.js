// ==UserScript==
// @name         Notion AI - Export current chat as dialogue TXT
// @namespace    local.notion.chat-dialogue-export
// @version      1.3.0
// @description  Fetch Notion AI dialogue from verified server records without manual scrolling.
// @match        https://app.notion.com/*
// @match        https://www.notion.so/*
// @match        https://notion.so/*
// @run-at       document-start
// @grant        none
// @sandbox      raw
// @noframes
// @updateURL    https://raw.githubusercontent.com/homayounisaghar/cf-exec-plane/main/userscripts/notion-chat-dialogue-export.user.js
// @downloadURL  https://raw.githubusercontent.com/homayounisaghar/cf-exec-plane/main/userscripts/notion-chat-dialogue-export.user.js
// ==/UserScript==

(() => {
  'use strict';

  // Observed protocol: /api/v3/syncRecordValuesSpaceInitial returns a
  // recordMap with thread (ordered message IDs) and thread_message records.
  // Protocol reference: https://github.com/git-scarrow/notion-forge (MIT).
  // Only read-only same-origin Notion sync requests are made when the user
  // clicks Export; otherwise we passively observe Notion's own requests.
  // No tokens are persisted and no chat content is sent to third parties.
  const SYNC_PATH = '/api/v3/syncRecordValuesMain';
  const SYNC_ROUTES = [SYNC_PATH, '/api/v3/syncRecordValuesSpaceInitial', '/api/v3/syncRecordValues'];
  const LIST_ROUTE = '/api/v3/getInferenceTranscriptsForUser';
  const diagnostics = [];
  let matchedSpaceCount = 0;
  function trace(entry) {
    // Sanitized: only route, HTTP code and record counts; no messages, IDs or credentials.
    if (diagnostics.length < 160) diagnostics.push(entry);
  }
  const USER_ROUTE = '/api/v3/loadUserContent';
  const headerHints = {};
  const knownSpaces = new Set();
  const apiOrigins = new Set();
  let lastObservedAPIOrigin = '';
  const histories = new Map();
  const originalFetch = window.fetch.bind(window);
  const normalizeID = value => typeof value === 'string'
    ? value.toLowerCase().replace(/-/g, '') : '';
  const recordValue = entry => entry?.value?.value ?? entry?.value ?? entry;
  const refID = value => normalizeID(typeof value === 'string' ? value : value?.id);

  function currentID() {
    const isChat = location.pathname.replace(/\/$/, '') === '/chat' ||
      new URLSearchParams(location.search).get('wfv') === 'chat';
    const id = new URLSearchParams(location.search).get('t') || '';
    return isChat && /^[\da-f]{32}$|^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(id)
      ? normalizeID(id) : null;
  }

  function getHistory(id) {
    if (!histories.has(id)) histories.set(id, { order: null, title: '', spaceId: '', verified: false, records: new Map() });
    // Avoid retaining data from other chats after navigation.
    for (const key of histories.keys()) if (key !== id) histories.delete(key);
    return histories.get(id);
  }

  function recordMapOf(data) {
    return data?.recordMap ?? data?.result?.recordMap ?? data?.data?.recordMap ?? {};
  }
  function unwrapRecord(entry) {
    // Older and newer v3 record maps use one or two 'value' envelopes.
    let v = entry;
    for (let i = 0; i < 4 && v && typeof v === 'object'; i++) {
      if (Array.isArray(v.messages) || v.step || v.parent_id ||
          (v.id && (v.data || v.space_id || v.type))) break;
      if (!v.value || typeof v.value !== 'object') break;
      v = v.value;
    }
    return v;
  }
  function recordOrder(thread) {
    const raw = Array.isArray(thread?.messages) ? thread.messages :
      Array.isArray(thread?.data?.messages) ? thread.data.messages : null;
    if (!raw) return null;
    const ids = raw.map(refID);
    return ids.every(x => /^[a-f0-9]{32}$/.test(x)) ? ids : null;
  }
  function observeSync(payload, id) {
    if (!id || currentID() !== id) return;
    const rm = recordMapOf(payload);
    const history = getHistory(id);

    for (const [key, envelope] of Object.entries(rm.thread || {})) {
      const thread = unwrapRecord(envelope);
      if (!thread || (normalizeID(key) !== id && normalizeID(thread.id) !== id)) continue;
      const order = recordOrder(thread);
      if (order && (!history.order || order.length >= history.order.length)) history.order = order;
      if (typeof thread.data?.title === 'string') history.title = thread.data.title;
      if (typeof thread.space_id === 'string' && /^[a-f0-9-]{32,36}$/i.test(thread.space_id)) {
        history.spaceId = normalizeID(thread.space_id);
        knownSpaces.add(history.spaceId);
      }
    }

    for (const [key, envelope] of Object.entries(rm.thread_message || {})) {
      const msg = unwrapRecord(envelope);
      if (!msg || typeof msg !== 'object') continue;
      const msgID = normalizeID(key);
      if (!/^[a-f0-9]{32}$/.test(msgID)) continue;
      const belongs = normalizeID(msg.parent_id ?? msg.thread_id) === id ||
        history.order?.includes(msgID);
      if (!belongs || (!msg.step && typeof msg.role !== 'string')) continue;
      history.records.set(msgID, msg);
    }
    updateStatus();
  }

  function notionAPIURL(input) {
    try {
      const raw = typeof input === 'string' || input instanceof URL ? input : input?.url;
      const url = new URL(raw, location.href);
      return url.protocol === 'https:' &&
        ['app.notion.com', 'www.notion.so', 'notion.so'].includes(url.hostname) &&
        url.pathname.startsWith('/api/v3/') ? url : null;
    } catch { return null; }
  }

  function rememberHeaderHints(input, init) {
    const target = notionAPIURL(input);
    if (!target) return;
    apiOrigins.add(target.origin);
    lastObservedAPIOrigin = target.origin;
    try {
      const combined = new Headers(input?.headers || {});
      if (init?.headers) new Headers(init.headers).forEach((value, key) => combined.set(key, value));
      // Do not collect cookies, authorization, or session tokens.
      for (const name of ['x-notion-active-user-header', 'x-notion-client-version', 'notion-client-version', 'x-notion-space-id']) {
        if (combined.has(name)) headerHints[name] = combined.get(name);
        if (name === 'x-notion-space-id' && /^[a-f0-9-]{32,36}$/i.test(headerHints[name] || '')) knownSpaces.add(normalizeID(headerHints[name]));
      }
    } catch { /* Observation must not break Notion. */ }
  }

  function isSyncURL(input) {
    try {
      return SYNC_ROUTES.includes(notionAPIURL(input)?.pathname);
    } catch { return false; }
  }

  // Observe existing Notion fetches. The original request and response are
  // passed through unmodified; only a response clone is read asynchronously.
  window.fetch = function (input, init) {
    rememberHeaderHints(input, init);
    const id = currentID();
    const watch = !!id && isSyncURL(input);
    const result = originalFetch(input, init);
    if (!watch) return result;
    return result.then(response => {
      try {
        if (response.ok) response.clone().json()
          .then(json => observeSync(json, id))
          .catch(() => {});
      } catch { /* Observation must never break Notion. */ }
      return response;
    });
  };

  function dashedID(id) {
    return `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`;
  }

  function ensureCurrent(id) {
    if (currentID() !== id) throw Error('چت هنگام دریافت تاریخچه تغییر کرد.');
  }

  function readHeaders(spaceId) {
    const headers = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'notion-audit-log-platform': 'web'
    };
    for (const name of ['x-notion-active-user-header', 'notion-client-version', 'x-notion-client-version']) {
      if (headerHints[name]) headers[name] = headerHints[name];
    }
    // Ensure the workspace header always agrees with the requested pointer.
    if (spaceId) headers['x-notion-space-id'] = dashedID(spaceId);
    return headers;
  }

  async function postRead(route, body, id, spaceId, type) {
    ensureCurrent(id);
    let response;
    try {
      const target = (lastObservedAPIOrigin || location.origin) + route;
      response = await originalFetch(target, {
        method: 'POST', credentials: 'include', cache: 'no-store',
        headers: readHeaders(spaceId), body: JSON.stringify(body)
      });
    } catch (err) {
      trace({ type, route, network: String(err?.name || 'network_error') });
      throw Error('Network/CORS: ' + route);
    }
    ensureCurrent(id);
    if (!response.ok) {
      trace({ type, route, http: response.status });
      throw Error('HTTP ' + response.status + ' at ' + route);
    }
    let data;
    try { data = await response.json(); }
    catch {
      trace({ type, route, http: response.status, invalidJSON: true });
      throw Error('Invalid JSON at ' + route);
    }
    ensureCurrent(id);
    const rm = recordMapOf(data);
    trace({
      type, route, http: response.status,
      tables: Object.keys(rm).filter(x => !x.startsWith('__')).slice(0, 12),
      threadRecords: Object.keys(rm.thread || {}).filter(x => /^[a-f0-9-]{32,36}$/i.test(x)).length,
      messageRecords: Object.keys(rm.thread_message || {}).filter(x => /^[a-f0-9-]{32,36}$/i.test(x)).length,
      responseKeys: Object.keys(data || {}).slice(0, 12),
      errorCode: typeof data?.code === 'string' ? data.code.slice(0, 60) : undefined
    });
    if (data?.error && !(rm.thread || rm.thread_message)) {
      throw Error('Read returned error at ' + route);
    }
    return data;
  }

  async function readRecords(route, table, ids, id, spaceId, compact = false) {
    const requests = ids.map(rawID => ({
      pointer: {
        table, id: compact ? rawID : dashedID(rawID),
        ...(spaceId ? { spaceId: dashedID(spaceId) } : {})
      },
      version: -1
    }));
    const data = await postRead(route, { requests }, id, spaceId, table);
    observeSync(data, id);
    return data;
  }

  async function discoverSpaces(id) {
    const data = await postRead(USER_ROUTE, {}, id, '', 'user-content');
    for (const [key, entry] of Object.entries(recordMapOf(data).space || {})) {
      const space = unwrapRecord(entry);
      const sid = normalizeID(space?.id || key);
      if (/^[a-f0-9]{32}$/.test(sid)) knownSpaces.add(sid);
    }
    return [...knownSpaces].slice(0, 60);
  }

  async function checkListedThread(id, spaceId) {
    if (!spaceId) return false;
    const sid = dashedID(spaceId);
    const data = await postRead(LIST_ROUTE, {
      threadParentPointer: { table: 'space', id: sid, spaceId: sid },
      limit: 100
    }, id, spaceId, 'thread-list');
    const transcripts = Array.isArray(data?.transcripts) ? data.transcripts : [];
    const ids = [...(Array.isArray(data?.threadIds) ? data.threadIds : []),
      ...transcripts.map(t => t?.id)].map(normalizeID);
    const found = ids.includes(id);
    trace({ type: 'thread-list-match', match: found, count: ids.length,
      hasMore: data?.hasMore === true });
    if (found) {
      const h = getHistory(id);
      h.spaceId = spaceId;
      const match = transcripts.find(t => normalizeID(t?.id) === id);
      if (match && typeof match.title === 'string') h.title = match.title;
      matchedSpaceCount += 1;
    }
    return found;
  }

  function missingIDs(id) {
    const h = histories.get(id);
    return h?.order?.filter(msgID => !h.records.has(msgID)) || [];
  }

  async function loadFullHistory(id, status) {
    ensureCurrent(id);
    diagnostics.length = 0;
    matchedSpaceCount = 0;
    const history = getHistory(id);
    const preferredSpace = history.spaceId;
    history.order = null;
    history.records.clear();
    history.verified = false;
    history.route = '';
    status('در حال خواندن تاریخچهٔ کامل از سرور نوشن…');

    let lastError = null;
    const tried = new Set();
    const localSpaces = [preferredSpace, headerHints['x-notion-space-id'], ...knownSpaces]
      .map(normalizeID).filter(x => /^[a-f0-9]{32}$/.test(x));
    const spaces = [...new Set([...localSpaces, ''])];
    try {
      await discoverSpaces(id);
      for (const sid of knownSpaces) if (!spaces.includes(sid)) spaces.push(sid);
    } catch (err) {
      lastError = err;
    }
    // A real transcript-list hit is stronger evidence of the right workspace.
    const matched = new Set();
    for (const sid of spaces.filter(Boolean).slice(0, 30)) {
      ensureCurrent(id);
      try { if (await checkListedThread(id, sid)) { matched.add(sid); break; } }
      catch (err) { lastError = err; }
    }
    const sortedSpaces = [...matched, ...spaces.filter(sid => !matched.has(sid))].slice(0, 30);
    let found = false;
    let activeRoute = '';

    for (const sid of sortedSpaces) {
      if (found) break;
      for (const route of SYNC_ROUTES) {
        if (found) break;
        const key = route + '|' + sid;
        if (tried.has(key)) continue;
        tried.add(key);
        status('در حال بررسی مسیر تاریخچهٔ نوشن: ' + tried.size);
        try {
          const data = await readRecords(route, 'thread', [id], id, sid);
          const row = Object.entries(recordMapOf(data).thread || {})
            .find(([key]) => normalizeID(key) === id);
          const thread = unwrapRecord(row?.[1]);
          const order = recordOrder(thread);
          if (order && order.length) {
            history.order = order;
            history.verified = true;
            if (sid) history.spaceId = sid;
            else if (thread.space_id) history.spaceId = normalizeID(thread.space_id);
            history.route = route;
            activeRoute = route;
            found = true;
          }
        } catch (err) { lastError = err; }
      }
    }
    if (!found) {
      trace({ type: 'summary', spaceCandidates: spaces.length,
        listMatches: matchedSpaceCount, routeProbes: tried.size });
      throw Error('رکورد چت از مسیرهای خواندن نوشن برنگشت. «گزارش خطا» را بزن؛ فایل ناقص ذخیره نشد.');
    }

    const total = history.order.length;
    if (total > 20000 || new Set(history.order).size !== total)
      throw Error('فهرست پیام‌های نوشن نامعتبر یا بیش از حد بزرگ است.');
    const routes = [activeRoute, ...SYNC_ROUTES.filter(r => r !== activeRoute)];
    for (let pass = 0; pass < 2; pass++) {
      const ids = missingIDs(id);
      if (!ids.length) break;
      const size = pass === 0 ? 35 : 10;
      for (let i = 0; i < ids.length; i += size) {
        ensureCurrent(id);
        const batch = ids.slice(i, i + size);
        status('دریافت پیام‌ها: ' + (total - missingIDs(id).length) + '/' + total);
        for (const route of routes) {
          const remain = batch.filter(x => !history.records.has(x));
          if (!remain.length) break;
          try { await readRecords(route, 'thread_message', remain, id, history.spaceId); }
          catch (err) { lastError = err; }
        }
      }
    }
    if (missingIDs(id).length)
      throw Error(missingIDs(id).length + ' پیام از ' + total + ' پیام دریافت نشد. فایل ناقص ذخیره نشد.');

    const previous = history.order.join(',');
    const latest = await readRecords(activeRoute, 'thread', [id], id, history.spaceId);
    const finalRow = Object.entries(recordMapOf(latest).thread || {})
      .find(([key]) => normalizeID(key) === id);
    const finalOrder = recordOrder(unwrapRecord(finalRow?.[1]));
    if (!finalOrder || finalOrder.join(',') !== previous)
      throw Error('چت هنگام استخراج تغییر کرد؛ بعد از پایان پاسخ دوباره دکمه را بزن.');
    status('تمام پیام‌های فهرست‌شده از سرور دریافت شد.');
  }

  function textOfRichValue(value) {
    if (typeof value === 'string') return value.trim();
    if (!Array.isArray(value)) return '';
    return value.map(chunk => {
      if (typeof chunk === 'string') return chunk;
      if (!Array.isArray(chunk)) return '';
      const plain = typeof chunk[0] === 'string' ? chunk[0] : '';
      if (plain !== '\u2023') return plain;
      const mention = (Array.isArray(chunk[1]) ? chunk[1] : [])
        .find(a => Array.isArray(a) && ['p', 'u', 'a'].includes(a[0]) && a[1]);
      const category = { p: 'page', u: 'user', a: 'agent' };
      return mention ? `[${category[mention[0]]}:${mention[1]}]` : plain;
    }).join('').trim();
  }

  function displayTurn(msg) {
    const step = msg.step || {};
    const kind = step.type || msg.role;
    if (kind === 'user' || kind === 'human') {
      const text = textOfRichValue(step.value ?? msg.content);
      return text ? { role: 'user', text } : null;
    }
    if (kind !== 'agent-inference' && kind !== 'assistant') return null;
    const content = Array.isArray(step.value)
      ? step.value.filter(v => v?.type === 'text' && typeof v.content === 'string')
        .map(v => v.content)
      : typeof step.value === 'string' ? [step.value] :
        typeof msg.content === 'string' ? [msg.content] : [];
    const text = content.join('\n\n')
      .replace(/<lang\b[^>]*\/>/g, '')
      .replace(/<edit_reference\b[^>]*>[\s\S]*?<\/edit_reference>/g, '')
      .trim();
    return text ? { role: 'assistant', text } : null;
  }

  function readableHistory(id) {
    const history = histories.get(id);
    if (!history?.verified || !history?.order?.length) throw Error('تاریخچهٔ کامل از سرور نوشن تأیید نشده است.');
    const missing = history.order.filter(msgID => !history.records.has(msgID));
    if (missing.length) throw Error(`${missing.length} پیام از ${history.order.length} پیام هنوز دریافت نشده؛ خروجی ناقص ذخیره نشد.`);
    const turns = [];
    const seen = new Set();
    for (const msgID of history.order) {
      if (seen.has(msgID)) continue;
      seen.add(msgID);
      const msg = history.records.get(msgID);
      if (msg.parent_id && normalizeID(msg.parent_id) !== id) {
        throw Error('شناسهٔ یکی از پیام‌ها با چت باز مطابقت ندارد.');
      }
      const turn = displayTurn(msg);
      if (turn) turns.push(turn);
    }
    if (!turns.length) throw Error('پیام متنی با قالب شناخته‌شده پیدا نشد؛ فایل ذخیره نشد.');
    return { title: history.title, turns, indexed: history.order.length };
  }

  function saveDialogue(id, result) {
    const title = result.title || document.title.replace(/\s*[-|]\s*Notion.*$/i, '').trim() || 'Notion AI chat';
    const content = result.turns.map(t =>
      `${t.role === 'user' ? 'کاربر' : 'دستیار هوش مصنوعی'}:\n\n${t.text}`
    ).join('\n\n') + '\n';
    const blob = new Blob(['\uFEFF', content], { type: 'text/plain;charset=utf-8' });
    const blobURL = URL.createObjectURL(blob);
    const link = document.createElement('a');
    const safeTitle = title.replace(/[\x00-\x1f\x7f<>:"/\\|?*]/g, '_')
      .replace(/\s+/g, ' ').trim().slice(0, 75) || 'Notion-chat';
    link.href = blobURL;
    link.download = `${safeTitle}-${id.slice(0, 8)}.txt`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(blobURL), 60000);
  }

  let panel, button, diagnosticsButton, info;
  let busy = false;
  function downloadDiagnostics() {
    const report = {
      scriptVersion: '1.3.0',
      chatIdIncluded: false,
      messagesIncluded: false,
      credentialsIncluded: false,
      browserHost: location.hostname,
      events: diagnostics
    };
    const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json;charset=utf-8' });
    const href = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = href;
    link.download = 'notion-export-diagnostics.json';
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(href), 60000);
  }

  function updateStatus() {
    if (!info || busy) return;
    const id = currentID();
    const history = id && histories.get(id);
    if (!history?.order) {
      info.textContent = 'در انتظار دریافت تاریخچه…';
      return;
    }
    const present = history.order.filter(x => history.records.has(x)).length;
    info.textContent = 'تاریخچه: ' + present + '/' + history.order.length + ' رکورد';
  }

  function mount() {
    if (!document.body) return;
    if (!panel) {
      panel = document.createElement('div');
      panel.id = 'notion-dialogue-txt-exporter';
      panel.style.cssText = 'position:fixed;bottom:16px;right:16px;z-index:2147483647;display:flex;align-items:center;gap:8px;background:#262626;color:#fff;border-radius:12px;padding:8px 10px;box-shadow:0 3px 14px #0005;font:13px sans-serif;max-width:440px;direction:rtl;flex-wrap:wrap;';
      button = document.createElement('button');
      button.textContent = 'خروجی گفتگو TXT';
      button.style.cssText = 'background:#fff;color:#222;border:0;border-radius:7px;padding:7px 9px;cursor:pointer;font:600 13px sans-serif;white-space:nowrap;';
      diagnosticsButton = document.createElement('button');
      diagnosticsButton.textContent = 'گزارش خطا';
      diagnosticsButton.style.cssText = 'background:#444;color:#fff;border:1px solid #aaa;border-radius:7px;padding:6px;cursor:pointer;font:12px sans-serif;display:none;';
      diagnosticsButton.addEventListener('click', downloadDiagnostics);
      info = document.createElement('span');
      info.style.cssText = 'font:12px sans-serif;overflow-wrap:anywhere;flex:1 1 100px;';
      panel.append(button, diagnosticsButton, info);
      button.addEventListener('click', async () => {
        if (busy) return;
        const id = currentID();
        if (!id) return;
        busy = true;
        button.disabled = true;
        diagnosticsButton.style.display = 'none';
        try {
          await loadFullHistory(id, text => { info.textContent = text; });
          const result = readableHistory(id);
          ensureCurrent(id);
          saveDialogue(id, result);
          info.textContent = 'ذخیره شد: ' + result.turns.length + ' پیام متنی از ' + result.indexed + ' رکورد.';
        } catch (err) {
          info.textContent = err?.message || 'خواندن گفتگو ناموفق بود.';
          diagnosticsButton.style.display = 'inline-block';
          console.warn('[Notion dialogue export]', err);
        } finally {
          busy = false;
          button.disabled = false;
        }
      });
    }
    if (panel.parentElement !== document.body) document.body.appendChild(panel);
    panel.style.display = currentID() ? 'flex' : 'none';
    if (info.textContent === '') updateStatus();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, { once: true });
  else mount();
  setInterval(mount, 1200);
})();