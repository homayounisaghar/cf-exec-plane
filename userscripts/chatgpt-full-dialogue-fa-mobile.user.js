// ==UserScript==
// @name         ChatGPT - Export current chat as text
// @namespace    local.chatgpt.export-text
// @version      1.3.0
// @description  Export the full selected ChatGPT conversation as a Persian dialogue TXT without scrolling (modern paginated history and legacy fallback).
// @match        https://chatgpt.com/*
// @run-at       document-start
// @grant        none
// @inject-into  page
// @noframes
// @updateURL    https://raw.githubusercontent.com/homayounisaghar/cf-exec-plane/main/userscripts/chatgpt-full-dialogue-fa-mobile.user.js
// @downloadURL  https://raw.githubusercontent.com/homayounisaghar/cf-exec-plane/main/userscripts/chatgpt-full-dialogue-fa-mobile.user.js
// ==/UserScript==

(() => {
  'use strict';

  // Same name and namespace as the original mobile exporter: install as an update.
  const BTN_ID = 'vm-chatgpt-full-export-button-v13';
  const nativeFetch = window.fetch.bind(window);
  const knownHeaders = new Map();
  const HEADER_NAMES = ['authorization', 'chatgpt-account-id', 'openai-organization',
    'openai-project', 'oai-device-id'];
  const pageSizes = [100, 25, 10];
  const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  const chatID = () => location.pathname.match(/(?:^|\/)c\/([a-zA-Z0-9_-]+)(?:\/|$)/)?.[1] || '';
  const id = x => x == null || x === '' ? '' : String(x);
  const normalize = x => String(x || '').replace(/\r\n?/g, '\n').trim();
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

  function chatRequestID(input) {
    try {
      const raw = typeof input === 'string' || input instanceof URL ? input : input.url;
      const u = new URL(raw, location.origin);
      if (u.origin !== location.origin) return '';
      return u.pathname.match(/^\/backend-api\/conversations?\/([a-zA-Z0-9_-]+)(?:\/messages)?\/?$/)?.[1] || '';
    } catch { return ''; }
  }

  function captureHeaders(targetID, headers) {
    if (!targetID || !headers) return;
    try {
      const found = knownHeaders.get(targetID) || {};
      new Headers(headers).forEach((value, name) => {
        if (HEADER_NAMES.includes(name)) found[name] = value;
      });
      knownHeaders.set(targetID, found);
      while (knownHeaders.size > 4) knownHeaders.delete(knownHeaders.keys().next().value);
    } catch { /* Never interrupt the ChatGPT page. */ }
  }

  // Observe the site's own request headers; never change a site's request or URL.
  window.fetch = function (input, init) {
    try {
      const targetID = chatRequestID(input);
      if (targetID) {
        const h = new Headers(input?.headers || {});
        if (init?.headers) new Headers(init.headers).forEach((v, k) => h.set(k, v));
        captureHeaders(targetID, h);
      }
    } catch { /* Ignore observation failures. */ }
    return nativeFetch(input, init);
  };

  if (window.XMLHttpRequest) {
    const originalOpen = XMLHttpRequest.prototype.open;
    const originalHeader = XMLHttpRequest.prototype.setRequestHeader;
    const contexts = new WeakMap();
    XMLHttpRequest.prototype.open = function (method, url, ...args) {
      try { contexts.set(this, { targetID: chatRequestID(url), headers: {} }); } catch { /* ignore */ }
      return originalOpen.call(this, method, url, ...args);
    };
    XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
      const ctx = contexts.get(this);
      if (ctx?.targetID && HEADER_NAMES.includes(String(name).toLowerCase())) {
        ctx.headers[name] = value;
        captureHeaders(ctx.targetID, ctx.headers);
      }
      return originalHeader.call(this, name, value);
    };
  }

  function errorForResponse(response, label) {
    const status = response.status;
    const retryAfter = response.headers?.get('retry-after') || '';
    let message = `${label}: HTTP ${status}`;
    if (status === 429) message += retryAfter ? ` (بعد از ${retryAfter} ثانیه دوباره امتحان کن)` : ' (محدودیت درخواست؛ بعداً امتحان کن)';
    if (status === 401 || status === 403) message += ' (نشست کاربری یا مجوز دسترسی را بررسی کن)';
    const err = Error(message);
    err.status = status;
    return err;
  }

  async function json(path, headers, label) {
    let response;
    try {
      response = await nativeFetch(path, { method: 'GET', credentials: 'include',
        cache: 'no-store', headers });
    } catch (cause) {
      const error = Error(`${label}: اتصال برقرار نشد`);
      error.cause = cause;
      throw error;
    }
    if (!response.ok) throw errorForResponse(response, label);
    try { return await response.json(); }
    catch { throw Error(`${label}: پاسخ JSON معتبر نبود`); }
  }

  async function authHeaders(conversationID) {
    const headers = { Accept: 'application/json', ...(knownHeaders.get(conversationID) || {}) };
    if (!headers.authorization) {
      // A failed session read needn't stop a valid browser-cookie/session request.
      try {
        const session = await json('/api/auth/session', { Accept: 'application/json' }, 'دریافت نشست');
        const token = session?.accessToken || session?.access_token;
        if (token) headers.authorization = `Bearer ${token}`;
      } catch { /* Try the same-origin conversation endpoint with observed headers/cookies. */ }
    }
    return headers;
  }

  function unbox(raw) {
    for (const candidate of [raw, raw?.conversation, raw?.data?.conversation, raw?.data]) {
      if (candidate && typeof candidate === 'object' &&
          (candidate.mapping && !Array.isArray(candidate.mapping) ||
            Array.isArray(candidate.messages) || Array.isArray(candidate.items))) return candidate;
    }
    throw Error('قالب تاریخچهٔ دریافتی شناخته نشد؛ فایل ناقص ذخیره نمی‌شود.');
  }

  function isPartial(page) {
    return page?.partial === true || page?.is_partial === true || page?.truncated === true ||
      page?.is_truncated === true || page?.is_complete === false;
  }

  function messageText(message) {
    const role = message?.author?.role ?? message?.role;
    if (role !== 'user' && role !== 'assistant') return null;
    if (message?.metadata?.is_visually_hidden_from_conversation === true) return null;
    const channel = message?.channel ?? message?.metadata?.channel;
    if (role === 'assistant' && channel && channel !== 'final' && channel !== 'complete') return null;
    const recipient = message?.recipient;
    if (role === 'assistant' && recipient && !['all', 'user', 'assistant'].includes(recipient)) return null;
    const content = message?.content ?? {};
    const parts = Array.isArray(content.parts) ? content.parts :
      typeof content.text === 'string' ? [content.text] : [];
    const text = normalize(parts.map(part => {
      if (typeof part === 'string') return part;
      if (part && ['text', 'input_text'].includes(part.type || part.content_type) && typeof part.text === 'string') return part.text;
      if (part && part.content_type === 'text' && typeof part.text === 'string') return part.text;
      return '';
    }).filter(Boolean).join('\n\n'));
    return text ? { role, text } : null;
  }

  function rowOf(item) {
    const msg = own(item || {}, 'message') ? item.message : item;
    const key = id(item?.id || msg?.id);
    if (!key) throw Error('یک پیام بدون شناسه دریافت شد؛ خروجی کامل قابل تأیید نیست.');
    return { key, message: msg };
  }

  function legacyPath(page) {
    const mapping = page.mapping;
    const currentNode = id(page.current_node || page.current_node_id);
    if (!mapping || typeof mapping !== 'object' || !currentNode || !own(mapping, currentNode))
      throw Error('شاخهٔ فعال تاریخچه قابل تأیید نیست.');
    const nodes = [], seen = new Set();
    let cursor = currentNode;
    while (cursor) {
      if (seen.has(cursor)) throw Error('حلقه در شاخهٔ گفتگو شناسایی شد.');
      seen.add(cursor);
      const node = mapping[cursor];
      if (!node || !own(node, 'parent')) throw Error('بخشی از شاخهٔ قدیمی گفتگو موجود نیست.');
      nodes.push(node?.message || null);
      cursor = id(node.parent);
    }
    return nodes.reverse().map(messageText).filter(Boolean);
  }

  function flatPageInfo(page) {
    const p = page.page_info || page.pagination;
    if (!p || typeof p.has_previous_page !== 'boolean')
      throw Error('سرور کامل‌بودن فهرست صفحه‌بندی‌شده را مشخص نکرد؛ خروجی ناقص ذخیره نمی‌شود.');
    return { more: p.has_previous_page, before: id(p.start_cursor) };
  }

  function checkCurrent(conversationID) {
    if (chatID() !== conversationID) throw Error('گفتگو هنگام خروجی‌گرفتن تغییر کرده است.');
  }

  function modernURL(conversationID, size, before = '') {
    const q = new URLSearchParams({ include_has_versions: 'true', num_turns: String(size) });
    if (before) q.set('before', before);
    return `/backend-api/conversations/${encodeURIComponent(conversationID)}?${q}`;
  }

  async function getModernPage(conversationID, headers, before, preferredSize, stage) {
    // Try smaller response pages if the backend cannot serve a larger one.
    const sizes = pageSizes.filter(s => s <= preferredSize);
    let last;
    for (const size of sizes) {
      checkCurrent(conversationID);
      try {
        const raw = await json(modernURL(conversationID, size, before), headers, stage);
        const page = unbox(raw);
        return { page, size };
      } catch (error) {
        last = error;
        // Never hammer a rate-limited session, or retry auth/permission failures.
        if (error.status === 429 || error.status === 401 || error.status === 403) throw error;
        if (![400, 404, 405, 422, 500, 502, 503, 504].includes(error.status)) throw error;
        if (size !== sizes[sizes.length - 1]) await delay(450);
      }
    }
    throw last;
  }

  async function fullHistory(conversationID, status) {
    const headers = await authHeaders(conversationID);
    checkCurrent(conversationID);
    let first, size = 100;
    try {
      ({ page: first, size } = await getModernPage(conversationID, headers, '', size, 'دریافت گفتگو'));
    } catch (modernError) {
      // Some old accounts still accept the legacy mapping endpoint.
      if ([429, 401, 403].includes(modernError.status)) throw modernError;
      try {
        status('در حال امتحان مسیر قدیمی تاریخچه…');
        const old = unbox(await json(`/backend-api/conversation/${encodeURIComponent(conversationID)}`,
          headers, 'مسیر قدیمی'));
        if (!old.mapping || isPartial(old)) throw Error('مسیر قدیمی تاریخچهٔ کامل را برنگرداند.');
        return { turns: legacyPath(old), title: old.title || document.title, pages: 1 };
      } catch (legacyError) {
        throw Error(`${modernError.message}؛ مسیر جایگزین هم ناموفق بود (${legacyError.message}).`);
      }
    }

    if (isPartial(first)) throw Error('سرور صفحهٔ ناقص برگرداند؛ فایلی ذخیره نشد.');
    if (first.mapping) return { turns: legacyPath(first), title: first.title || document.title, pages: 1 };
    if (!Array.isArray(first.messages) && !Array.isArray(first.items))
      throw Error('فهرست پیام‌های سرور در قالب جدید پیدا نشد.');
    let info = flatPageInfo(first);
    const allPages = [(first.messages || first.items).map(rowOf)];
    const used = new Set();
    let pageNumber = 1;
    while (info.more) {
      checkCurrent(conversationID);
      if (!info.before || used.has(info.before))
        throw Error('نشانهٔ ادامهٔ صفحه‌ها تکراری یا خالی است؛ خروجی ناقص ذخیره نشد.');
      if (pageNumber >= 2000) throw Error('سقف ایمنی تعداد صفحه‌ها رسید؛ خروجی ناقص ذخیره نشد.');
      used.add(info.before);
      status(`دریافت صفحهٔ قدیمی‌تر ${pageNumber + 1}…`);
      await delay(120);
      const found = await getModernPage(conversationID, headers, info.before, size, `صفحهٔ ${pageNumber + 1}`);
      size = found.size;
      const older = found.page;
      if (isPartial(older)) throw Error('یکی از صفحه‌ها ناقص بود؛ فایلی ذخیره نشد.');
      if (!Array.isArray(older.messages) && !Array.isArray(older.items))
        throw Error('یک صفحه فاقد فهرست پیام‌ها بود؛ خروجی ناقص ذخیره نشد.');
      const rows = (older.messages || older.items).map(rowOf);
      if (!rows.length) throw Error('یک صفحهٔ قدیمی خالی بود؛ خروجی ناقص ذخیره نشد.');
      allPages.unshift(rows);
      info = flatPageInfo(older);
      pageNumber++;
    }
    checkCurrent(conversationID);
    const unique = new Map();
    for (const rows of allPages) {
      for (const row of rows) {
        if (unique.has(row.key)) {
          const a = messageText(unique.get(row.key).message);
          const b = messageText(row.message);
          if (JSON.stringify(a) !== JSON.stringify(b))
            throw Error('محتوای یک پیام هنگام خروجی تغییر کرد؛ دوباره امتحان کن.');
        } else unique.set(row.key, row);
      }
    }
    return {
      turns: [...unique.values()].map(x => messageText(x.message)).filter(Boolean),
      title: first.title || document.title,
      pages: pageNumber
    };
  }

  function saveText(full, conversationID) {
    if (!full.turns.length) throw Error('هیچ پیام متنی از کاربر یا دستیار پیدا نشد.');
    const text = full.turns.map(t =>
      `--------------------\n${t.role === 'user' ? 'کاربر' : 'دستیار هوش مصنوعی'}:\n\n${t.text}\n`)
      .join('\n');
    const blob = new Blob(['\uFEFF' + text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const title = (full.title || 'ChatGPT conversation').replace(/\s*[-|]\s*ChatGPT.*$/i, '')
      .replace(/[\x00-\x1f\x7f<>:"/\\|?*]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 80) || 'ChatGPT';
    const link = document.createElement('a');
    link.download = `${title}-${conversationID.slice(0, 8)}.txt`;
    link.href = url;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    return full.turns.length;
  }

  let panel, button, info, busy = false;
  function mount() {
    if (!document.body) return;
    if (!panel) {
      panel = document.createElement('div');
      panel.id = BTN_ID;
      panel.style.cssText = 'position:fixed;bottom:16px;right:16px;z-index:2147483647;display:flex;align-items:center;gap:8px;background:#262626;color:white;border-radius:12px;padding:7px 10px;box-shadow:0 3px 14px #0005;font:13px sans-serif;max-width:360px;';
      button = document.createElement('button');
      button.textContent = 'Export chat TXT';
      button.style.cssText = 'background:white;color:#222;border:0;border-radius:7px;padding:7px 9px;cursor:pointer;font:600 13px sans-serif;';
      info = document.createElement('span');
      info.style.cssText = 'font:12px sans-serif;overflow-wrap:anywhere;';
      panel.append(button, info);
      button.addEventListener('click', async () => {
        if (busy) return;
        const conversationID = chatID();
        if (!conversationID) return;
        busy = true;
        button.disabled = true;
        info.textContent = 'در حال دریافت کل گفتگو…';
        try {
          if (document.querySelector('[data-testid="stop-button"]'))
            throw Error('ابتدا منتظر پایان پاسخ دستیار بمان.');
          const full = await fullHistory(conversationID, s => { info.textContent = s; });
          checkCurrent(conversationID);
          const count = saveText(full, conversationID);
          info.textContent = `${count} پیام ذخیره شد (${full.pages} صفحه).`;
        } catch (error) {
          info.textContent = error.message || 'خروجی ناموفق بود.';
          console.warn('[ChatGPT full TXT export]', error);
        } finally {
          busy = false;
          button.disabled = false;
        }
      });
    }
    if (panel.parentElement !== document.body) document.body.appendChild(panel);
    panel.style.display = chatID() ? 'flex' : 'none';
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, { once: true });
  else mount();
  setInterval(mount, 2000);
})();
