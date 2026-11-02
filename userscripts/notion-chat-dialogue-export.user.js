// ==UserScript==
// @name         Notion AI - Export current chat as dialogue TXT
// @namespace    local.notion.chat-dialogue-export
// @version      1.1.0
// @description  Export text-only user/assistant turns from the current Notion AI chat, verifying every indexed message was captured.
// @match        https://app.notion.com/*
// @match        https://www.notion.so/*
// @match        https://notion.so/*
// @run-at       document-start
// @grant        none
// @sandbox      raw
// @noframes
// ==/UserScript==

(() => {
  'use strict';

  // Observed protocol: /api/v3/syncRecordValuesSpaceInitial returns a
  // recordMap with thread (ordered message IDs) and thread_message records.
  // Protocol reference: https://github.com/git-scarrow/notion-forge (MIT).
  // Only read-only same-origin Notion sync requests are made when the user
  // clicks Export; otherwise we passively observe Notion's own requests.
  // No tokens are persisted and no chat content is sent to third parties.
  const SYNC_PATH = '/api/v3/syncRecordValuesSpaceInitial';
  const SYNC_ALTERNATE = '/api/v3/syncRecordValues';
  const headerHints = {};
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
    if (!histories.has(id)) histories.set(id, { order: null, title: '', records: new Map() });
    // Avoid retaining data from other chats after navigation.
    for (const key of histories.keys()) if (key !== id) histories.delete(key);
    return histories.get(id);
  }

  function observeSync(payload, id) {
    if (!id || currentID() !== id) return;
    const rm = payload?.recordMap;
    if (!rm || typeof rm !== 'object') return;
    const history = getHistory(id);

    for (const [key, envelope] of Object.entries(rm.thread || {})) {
      const thread = recordValue(envelope);
      if (!thread || (normalizeID(key) !== id && normalizeID(thread.id) !== id)) continue;
      if (Array.isArray(thread.messages)) {
        const order = thread.messages.map(refID).filter(Boolean);
        // Prefer a more complete order if responses arrive out of order.
        if (!history.order || order.length >= history.order.length) history.order = order;
      }
      if (typeof thread.data?.title === 'string') history.title = thread.data.title;
    }

    for (const [key, envelope] of Object.entries(rm.thread_message || {})) {
      const msg = recordValue(envelope);
      if (!msg || typeof msg !== 'object') continue;
      const msgID = normalizeID(key);
      if (!msgID) continue;
      const belongs = normalizeID(msg.parent_id ?? msg.thread_id) === id ||
        history.order?.includes(msgID);
      if (!belongs) continue;
      // Repeated sync records may contain updated message text.
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
    if (!notionAPIURL(input)) return;
    try {
      const combined = new Headers(input?.headers || {});
      if (init?.headers) new Headers(init.headers).forEach((value, key) => combined.set(key, value));
      // Do not collect cookies, authorization, or session tokens.
      for (const name of ['x-notion-active-user-header', 'x-notion-client-version']) {
        if (combined.has(name)) headerHints[name] = combined.get(name);
      }
    } catch { /* Observation must not break Notion. */ }
  }

  function isSyncURL(input) {
    try {
      return notionAPIURL(input)?.pathname === SYNC_PATH;
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

  async function readRecords(route, table, ids, id) {
    ensureCurrent(id);
    const requests = ids.map(rawID => ({
      pointer: { table, id: dashedID(rawID) }, version: -1
    }));
    const response = await originalFetch(route, {
      method: 'POST',
      credentials: 'include',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...headerHints },
      body: JSON.stringify({ requests })
    });
    if (!response.ok) throw Error(`دریافت رکوردهای نوشن ناموفق بود (HTTP ${response.status}).`);
    const data = await response.json();
    ensureCurrent(id);
    observeSync(data, id);
    return data;
  }

  function missingIDs(id) {
    const h = histories.get(id);
    return h?.order?.filter(msgID => !h.records.has(msgID)) || [];
  }

  async function loadFullHistory(id, status) {
    ensureCurrent(id);
    status('در حال خواندن فهرست پیام‌ها…');
    const routes = [SYNC_PATH, SYNC_ALTERNATE];
    let activeRoute = null;
    let lastError = null;

    // The Notion sync protocol accepts versioned pointers to named tables.
    // A known original sync route is tried first; fall back to the other
    // observed read-only route if the first does not return this thread.
    for (const route of routes) {
      try {
        await readRecords(route, 'thread', [id], id);
        if (histories.get(id)?.order?.length) {
          activeRoute = route;
          break;
        }
      } catch (err) {
        lastError = err;
      }
    }
    if (!activeRoute) {
      // The passive observer might already have a complete thread.
      if (histories.get(id)?.order?.length) return;
      throw lastError || Error('نوشن فهرست پیام‌های این چت را برنگرداند.');
    }

    const ids = missingIDs(id);
    if (ids.length > 20000) throw Error('تعداد پیام‌ها بیش از سقف ایمنی دریافت است.');
    const batchSize = 40;
    for (let start = 0; start < ids.length; start += batchSize) {
      ensureCurrent(id);
      const batch = ids.slice(start, start + batchSize);
      status(`در حال دریافت پیام‌ها: ${Math.min(start + batchSize, ids.length)}/${ids.length}`);
      for (const route of [activeRoute, ...routes.filter(x => x !== activeRoute)]) {
        const remaining = batch.filter(x => !histories.get(id)?.records.has(x));
        if (!remaining.length) break;
        try { await readRecords(route, 'thread_message', remaining, id); }
        catch (err) { lastError = err; }
      }
    }
    if (missingIDs(id).length && lastError) console.info('[Notion TXT export] read attempt:', lastError.message);
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
    if (!history?.order?.length) throw Error('تاریخچهٔ این چت هنوز دریافت نشده؛ صفحه را بازخوانی و چت را دوباره باز کنید.');
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

  let panel, button, info;
  let busy = false;
  function updateStatus() {
    if (!info || busy) return;
    const id = currentID();
    const history = id && histories.get(id);
    if (!history?.order) {
      info.textContent = 'در انتظار تاریخچهٔ چت…';
      return;
    }
    const present = history.order.filter(x => history.records.has(x)).length;
    info.textContent = `تاریخچه: ${present}/${history.order.length} پیام`;
  }

  function mount() {
    if (!document.body) return;
    if (!panel) {
      panel = document.createElement('div');
      panel.id = 'notion-dialogue-txt-exporter';
      panel.style.cssText = 'position:fixed;bottom:16px;right:16px;z-index:2147483647;display:flex;align-items:center;gap:8px;background:#262626;color:#fff;border-radius:12px;padding:8px 10px;box-shadow:0 3px 14px #0005;font:13px sans-serif;max-width:440px;direction:rtl;';
      button = document.createElement('button');
      button.textContent = 'خروجی گفتگو TXT';
      button.style.cssText = 'background:#fff;color:#222;border:0;border-radius:7px;padding:7px 9px;cursor:pointer;font:600 13px sans-serif;white-space:nowrap;';
      info = document.createElement('span');
      info.style.cssText = 'font:12px sans-serif;overflow-wrap:anywhere;';
      panel.append(button, info);
      button.addEventListener('click', async () => {
        if (busy) return;
        const id = currentID();
        if (!id) return;
        busy = true;
        button.disabled = true;
        try {
          // Try direct same-origin reads first, even if Notion served its UI
          // from the local cache. Never save unless indexed records are complete.
          try { await loadFullHistory(id, text => { info.textContent = text; }); }
          catch (readError) { console.info('[Notion TXT export] direct read:', readError.message); }
          const result = readableHistory(id);
          if (currentID() !== id) throw Error('چت هنگام گرفتن خروجی تغییر کرد.');
          saveDialogue(id, result);
          info.textContent = `ذخیره شد: ${result.turns.length} پیام متنی از ${result.indexed} رکورد.`;
        } catch (err) {
          info.textContent = err.message || 'دریافت خروجی ممکن نشد.';
          console.warn('[Notion chat TXT export]', err);
        } finally {
          busy = false;
          button.disabled = false;
        }
      });
    }
    if (panel.parentElement !== document.body) document.body.appendChild(panel);
    panel.style.display = currentID() ? 'flex' : 'none';
    // Do not overwrite a success/error message on the same page immediately.
    if (info.textContent === '') updateStatus();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, { once: true });
  else mount();
  setInterval(mount, 1200);
})();
