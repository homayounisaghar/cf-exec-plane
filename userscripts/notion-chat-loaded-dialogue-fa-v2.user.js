// ==UserScript==
// @name         Notion AI - Export loaded chat text (manual scroll)
// @namespace    local.notion.chat-loaded-text
// @version      2.0.0
// @description  Export only Notion AI messages observed on this page, with verified speaker labels. No auto-scroll or history fetch.
// @match        https://app.notion.com/*
// @match        https://www.notion.so/*
// @match        https://notion.so/*
// @run-at       document-start
// @grant        none
// @inject-into  page
// @noframes
// ==/UserScript==

(() => {
  'use strict';
  const SINGLETON = '__vmNotionLoadedRoleSafeV2';
  if (window[SINGLETON]) return;
  window[SINGLETON] = true;
  const PANEL_ID = 'notion-manual-text-export-panel';
  const USER = '\u06a9\u0627\u0631\u0628\u0631';
  const ASSISTANT = '\u062f\u0633\u062a\u06cc\u0627\u0631 \u0647\u0648\u0634 \u0645\u0635\u0646\u0648\u0639\u06cc';
  const normalizeID = value => typeof value === 'string' ? value.toLowerCase().replace(/-/g, '') : '';
  const isID = value => /^[0-9a-f]{32}$/.test(value);
  const chatID = () => {
    const p = new URLSearchParams(location.search);
    if (!(/\/chat\/?$/.test(location.pathname) || p.get('wfv') === 'chat')) return '';
    const id = normalizeID(p.get('t') || '');
    return isID(id) ? id : '';
  };
  const recordsByThread = new Map();
  let activeID = '', domTurns = [], lastDOMWindow = [], seenGap = false;
  let panel, exportButton, resetButton, status, pending = false, watching = false;

  function ensureThread(id) {
    if (!recordsByThread.has(id)) recordsByThread.set(id, { order: [], rows: new Map(), title: '', seen: 0 });
    return recordsByThread.get(id);
  }
  function unwrap(value) {
    let v = value;
    for (let i = 0; i < 4 && v && typeof v === 'object'; i++) {
      if (v.step || v.parent_id || Array.isArray(v.messages) || v.role || (v.id && v.data)) break;
      if (!v.value || typeof v.value !== 'object') break;
      v = v.value;
    }
    return v;
  }
  function recordMap(data) {
    return data?.recordMap || data?.result?.recordMap || data?.data?.recordMap || {};
  }
  function fromRich(value) {
    if (typeof value === 'string') return value;
    if (!Array.isArray(value)) return '';
    return value.map(v => {
      if (typeof v === 'string') return v;
      if (Array.isArray(v)) return typeof v[0] === 'string' ? v[0] : '';
      if (v?.type === 'text' && typeof v.content === 'string') return v.content;
      return '';
    }).join('');
  }
  function normalized(text) {
    return String(text || '').replace(/\u00a0/g, ' ').replace(/\r\n?/g, '\n')
      .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  }
  function normalizeTurn(record) {
    const step = record?.step || {};
    const type = step.type || record?.role;
    if (type === 'user' || type === 'human') {
      const text = normalized(fromRich(step.value ?? record.content ?? record.text));
      return text ? { role: 'user', text } : null;
    }
    if (type === 'agent-inference' || type === 'assistant') {
      const contents = step.value ?? record.content;
      let text = '';
      if (typeof contents === 'string') text = contents;
      else if (Array.isArray(contents)) text = contents.filter(v => v && v.type === 'text' && typeof v.content === 'string')
        .map(v => v.content).join('\n\n');
      text = normalized(text.replace(/<lang\b[^>]*\/>/g, '')
        .replace(/<edit_reference\b[^>]*>[\s\S]*?<\/edit_reference>/g, ''));
      return text ? { role: 'assistant', text } : null;
    }
    // A system/status/tool record is NOT a user/assistant message. Never guess.
    return null;
  }
  function consume(data, expectedID) {
    if (!expectedID || expectedID !== chatID()) return;
    const rm = recordMap(data);
    const thread = ensureThread(expectedID);
    for (const [key, record] of Object.entries(rm.thread || {})) {
      const r = unwrap(record);
      if (normalizeID(key) !== expectedID && normalizeID(r?.id) !== expectedID) continue;
      const list = Array.isArray(r.messages) ? r.messages : r.data?.messages;
      if (Array.isArray(list)) {
        const order = list.map(x => normalizeID(typeof x === 'string' ? x : x?.id))
          .filter(isID);
        if (order.length >= thread.order.length && new Set(order).size === order.length) thread.order = order;
      }
      if (typeof r?.data?.title === 'string') thread.title = r.data.title;
    }
    for (const [key, record] of Object.entries(rm.thread_message || {})) {
      const id = normalizeID(key);
      if (!isID(id)) continue;
      const msg = unwrap(record);
      if (!msg || !(normalizeID(msg.parent_id || msg.thread_id) === expectedID || thread.order.includes(id))) continue;
      const turn = normalizeTurn(msg);
      if (!turn) continue;
      if (!thread.rows.has(id)) thread.seen++;
      thread.rows.set(id, { ...turn, id, time: Number(msg.created_time) || 0, seq: thread.rows.get(id)?.seq ?? thread.seen });
    }
    updateCounter();
  }

  // Observe the requests Notion itself already made. No new request is made.
  const previousFetch = window.fetch;
  if (typeof previousFetch === 'function') {
    window.fetch = function (...args) {
      const expected = chatID();
      let capture = false;
      try {
        const input = args[0];
        const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url, location.href);
        capture = !!expected && url.origin === location.origin &&
          /\/api\/v3\/syncRecordValues(?:SpaceInitial|Main)?$/.test(url.pathname);
      } catch { /* Normal fetch still proceeds. */ }
      const result = previousFetch.apply(this, args);
      if (capture) Promise.resolve(result).then(response => {
        if (response?.ok) response.clone().json().then(data => consume(data, expected)).catch(() => {});
      }).catch(() => {});
      return result;
    };
  }
  if (window.XMLHttpRequest) {
    const open = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method, url, ...args) {
      const expected = chatID();
      let capture = false;
      try {
        const parsed = new URL(url, location.href);
        capture = !!expected && parsed.origin === location.origin &&
          /\/api\/v3\/syncRecordValues(?:SpaceInitial|Main)?$/.test(parsed.pathname);
      } catch { /* Nothing */ }
      if (capture) this.addEventListener('load', () => {
        try {
          if (this.status < 200 || this.status >= 300) return;
          consume(this.responseType === 'json' ? this.response : JSON.parse(this.responseText), expected);
        } catch { /* Nothing */ }
      }, { once: true });
      return open.call(this, method, url, ...args);
    };
  }

  const BLOCKS = new Set(['P', 'DIV', 'SECTION', 'ARTICLE', 'LI', 'PRE', 'BLOCKQUOTE', 'UL', 'OL', 'TR', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6']);
  const IGNORED = 'script,style,noscript,svg,img,picture,video,audio,canvas,iframe,button,input,textarea,select,form,nav,aside,header,footer,time,[role="button"],[role="toolbar"],[aria-hidden="true"],[hidden],[contenteditable="true"],.sr-only,[class*="thinking"],[class*="reasoning"],[data-testid*="tool-result"],[data-testid*="attachment"],[data-testid*="message-actions"]';
  function readText(node) {
    if (node.nodeType === Node.TEXT_NODE) return node.nodeValue || '';
    if (node.nodeType !== Node.ELEMENT_NODE || node.matches(IGNORED)) return '';
    if (node.tagName === 'BR') return '\n';
    let text = '';
    for (const child of node.childNodes) text += readText(child);
    if (node.tagName === 'LI') return '\n- ' + text.trim() + '\n';
    if (node.tagName === 'TD' || node.tagName === 'TH') return text.trim() + '\t';
    return BLOCKS.has(node.tagName) ? '\n' + text + '\n' : text;
  }
  function shown(el) {
    if (!el?.isConnected || el.closest('#' + PANEL_ID + ',[aria-hidden="true"],[hidden]')) return false;
    const cs = getComputedStyle(el);
    return cs.display !== 'none' && cs.visibility !== 'hidden';
  }
  const SEMANTIC = '[data-message-author-role],[data-message-role],[data-role],[data-turn],[data-sender],[data-author],[data-testid*="user-message"],[data-testid*="assistant-message"],[data-testid*="human-message"],[data-testid*="agent-message"]';
  function explicitRole(node) {
    for (const attr of ['data-message-author-role', 'data-message-role', 'data-role', 'data-turn', 'data-sender', 'data-author']) {
      const v = node.getAttribute(attr);
      if (v === 'user' || v === 'human' || v === 'editor') return 'user';
      if (v === 'assistant' || v === 'notion-ai') return 'assistant';
    }
    const t = node.getAttribute('data-testid') || '';
    if (/^(?:user|human)[-_]message(?:$|[-_])/.test(t)) return 'user';
    if (/^(?:assistant|agent)[-_]message(?:$|[-_])/.test(t)) return 'assistant';
    return null;
  }
  function rootCandidates() {
    const preferred = [...document.querySelectorAll('[role="log"],[data-testid*="chat-scroll"],[data-testid*="chat-messages"],main,[role="main"]')]
      .filter(shown).filter(x => !x.closest('aside,nav'));
    if (preferred.length) return preferred;
    return [document.body];
  }
  function readDOM() {
    if (!chatID()) return [];
    let best = [];
    for (const root of rootCandidates()) {
      const found = [...root.querySelectorAll(SEMANTIC)]
        .filter(shown).map(el => ({ el, role: explicitRole(el) })).filter(x => x.role);
      // Use the innermost explicitly tagged message container per role. A parent
      // wrapping multiple messages must never be counted as one message.
      const picked = found.filter(x => !found.some(y => x !== y && x.el.contains(y.el)));
      const batch = [];
      for (const { el, role } of picked) {
        const source = el.querySelector('.markdown,.prose,[data-testid*="message-content"]') || el;
        const text = normalized(readText(source));
        if (!text) continue;
        const id = normalizeID(el.getAttribute('data-message-id') || el.getAttribute('data-record-id') ||
          el.getAttribute('data-turn-id') || el.closest('[data-record-id]')?.getAttribute('data-record-id') || '');
        batch.push({ role, text, id: isID(id) ? id : '', el });
      }
      batch.sort((a, b) => a.el === b.el ? 0 :
        ((a.el.compareDocumentPosition(b.el) & Node.DOCUMENT_POSITION_FOLLOWING) ? -1 : 1));
      if (batch.length > best.length) best = batch;
    }
    return best.map(({ role, text, id }) => ({ role, text, id }));
  }
  function same(a, b) {
    if (a.id && b.id) return a.id === b.id;
    return a.role === b.role && a.text === b.text;
  }
  function mergeWindows(base, incoming) {
    if (!incoming.length) return base;
    if (!base.length) return incoming.slice();
    const contains = (big, small) => {
      outer: for (let i = 0; i <= big.length - small.length; i++) {
        for (let j = 0; j < small.length; j++) if (!same(big[i+j], small[j])) continue outer;
        return true;
      } return false;
    };
    if (contains(base, incoming)) return base;
    if (contains(incoming, base)) return incoming.slice();
    const n = Math.min(base.length, incoming.length);
    for (let k = n; k > 0; k--) {
      if (base.slice(-k).every((t, i) => same(t, incoming[i]))) return base.concat(incoming.slice(k));
      if (incoming.slice(-k).every((t, i) => same(t, base[i]))) return incoming.slice(0, -k).concat(base);
    }
    seenGap = true;
    return base.concat(incoming);
  }
  function scan() {
    const id = chatID();
    if (!id) return;
    if (id !== activeID) {
      activeID = id; domTurns = []; lastDOMWindow = []; seenGap = false;
    }
    const incoming = readDOM();
    if (incoming.length) {
      domTurns = mergeWindows(domTurns, incoming);
      lastDOMWindow = incoming;
    }
    updateCounter();
  }
  function apiTurns() {
    const h = recordsByThread.get(chatID());
    if (!h) return [];
    if (h.order.length) {
      const ranked = h.order.map(id => h.rows.get(id)).filter(Boolean);
      // In case an observed message is still absent from the thread order.
      return ranked.concat([...h.rows.values()].filter(x => !h.order.includes(x.id))
        .sort((a, b) => a.seq - b.seq));
    }
    return [...h.rows.values()].sort((a, b) =>
      a.time && b.time && a.time !== b.time ? a.time - b.time : a.seq - b.seq);
  }
  function exportTurns() {
    scan();
    const typed = apiTurns();
    if (!typed.length) return domTurns.slice();
    if (!domTurns.length) return typed;
    // Network records and DOM can describe the same displayed message. De-dupe
    // only when identity OR both speaker and entire message text agree.
    const merged = typed.slice();
    for (const item of domTurns) {
      if (merged.some(x => same(x, item))) continue;
      merged.push(item);
    }
    return merged;
  }
  function statusText(value) { if (status) status.textContent = value; }
  function updateCounter() {
    if (!status || !chatID()) return;
    const canonical = apiTurns().length;
    statusText(canonical ? canonical + ' \u067e\u06cc\u0627\u0645 \u0628\u0627 \u0646\u0642\u0634 \u0645\u0639\u062a\u0628\u0631' :
      (domTurns.length ? domTurns.length + ' \u067e\u06cc\u0627\u0645 \u062f\u06cc\u062f\u0647\u200c\u0634\u062f\u0647' : '...'));
  }
  function download(turns) {
    const id = chatID();
    const title = (recordsByThread.get(id)?.title || document.title || 'Notion chat')
      .replace(/[\x00-\x1f\x7f<>:"/\\|?*]/g, '_').replace(/\s*[-|]\s*Notion.*$/i, '')
      .trim().slice(0, 80) || 'Notion-chat';
    const txt = turns.map(t => (t.role === 'user' ? USER : ASSISTANT) + ':\n\n' + t.text)
      .join('\n\n--------------------\n\n') + '\n';
    const url = URL.createObjectURL(new Blob(['\uFEFF' + txt], { type: 'text/plain;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = title + '-Notion-loaded-' + id.slice(0, 8) + '.txt';
    document.body.appendChild(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }
  function mount() {
    if (!document.body) return;
    const id = chatID();
    if (!panel) {
      panel = document.createElement('div'); panel.id = PANEL_ID; panel.dir = 'rtl';
      panel.style.cssText = 'position:fixed;bottom:16px;right:12px;z-index:2147483647;display:flex;align-items:center;gap:8px;padding:8px;border-radius:12px;background:#202020;color:#fff;box-shadow:0 3px 15px #0005;font:12px sans-serif;max-width:calc(100vw - 24px);';
      exportButton = document.createElement('button'); exportButton.type = 'button';
      exportButton.textContent = '\u062f\u0627\u0646\u0644\u0648\u062f \u0645\u062a\u0646 \u0628\u0627\u0631\u06af\u0630\u0627\u0631\u06cc\u200c\u0634\u062f\u0647';
      exportButton.style.cssText = 'border:0;border-radius:8px;padding:9px;background:white;color:#222;font:600 12px sans-serif;cursor:pointer;';
      resetButton = document.createElement('button'); resetButton.type = 'button';
      resetButton.textContent = '\u067e\u0627\u06a9\u200c\u06a9\u0631\u062f\u0646 \u062b\u0628\u062a';
      resetButton.style.cssText = 'border:1px solid #888;border-radius:8px;padding:7px;background:transparent;color:white;font:11px sans-serif;cursor:pointer;';
      status = document.createElement('span'); status.style.cssText = 'max-width:160px;overflow-wrap:anywhere;font:12px sans-serif;';
      exportButton.addEventListener('click', () => {
        if (pending) return;
        pending = true; exportButton.disabled = true;
        try {
          const before = chatID();
          if (!before) throw Error('Open a Notion AI chat first.');
          const turns = exportTurns();
          if (chatID() !== before) throw Error('Conversation changed during export.');
          if (!turns.length) throw Error('No messages with verified speaker roles were loaded. Reload this chat to capture the page data.');
          if (turns.length > 25000) throw Error('Too many loaded messages.');
          download(turns);
          statusText(turns.length + ' \u067e\u06cc\u0627\u0645 \u0630\u062e\u06cc\u0631\u0647 \u0634\u062f');
        } catch (e) {
          statusText(e.message || 'Export failed');
          console.warn('[Notion loaded role-safe]', e);
        } finally { pending = false; exportButton.disabled = false; }
      });
      resetButton.addEventListener('click', () => {
        const id = chatID();
        if (!id) return;
        recordsByThread.delete(id); domTurns = []; lastDOMWindow = []; seenGap = false;
        scan();
      });
      panel.append(exportButton, resetButton, status);
      document.body.appendChild(panel);
    }
    if (panel.parentElement !== document.body) document.body.appendChild(panel);
    panel.style.display = id ? 'flex' : 'none';
  }
  function schedule() {
    if (watching) return;
    watching = true;
    setTimeout(() => { watching = false; scan(); }, 300);
  }
  function start() {
    mount(); scan();
    new MutationObserver(mutations => {
      if (!mutations.every(m => panel && panel.contains(m.target))) schedule();
    }).observe(document.body, { childList: true, subtree: true, characterData: true });
    document.addEventListener('scroll', schedule, true);
    setInterval(() => { mount(); schedule(); }, 2500);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
})();
