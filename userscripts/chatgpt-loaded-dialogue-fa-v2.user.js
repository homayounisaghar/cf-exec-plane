// ==UserScript==
// @name         ChatGPT - Export loaded dialogue (Persian)
// @namespace    local.chatgpt.loaded-dialogue-export
// @version      2.0.0
// @description  Export only ChatGPT turns actually mounted on this page since opening it, without fetching older history or scrolling.
// @match        https://chatgpt.com/*
// @run-at       document-start
// @grant        none
// @inject-into  page
// @noframes
// ==/UserScript==

(() => {
  'use strict';
  const KEY = '__vmChatgptLoadedRoleSafeV2';
  if (window[KEY]) return;
  window[KEY] = true;
  const PANEL_ID = 'vm-chatgpt-loaded-dialogue-export';
  const USER = '\u06a9\u0627\u0631\u0628\u0631';
  const ASSISTANT = '\u062f\u0633\u062a\u06cc\u0627\u0631 \u0647\u0648\u0634 \u0645\u0635\u0646\u0648\u0639\u06cc';
  const states = new Map();
  let panel, button, status, scheduled = false, exporting = false, serial = 0;
  const chatID = () => location.pathname.match(/(?:^|\/)c\/([a-zA-Z0-9_-]+)(?:\/|$)/)?.[1] || '';
  function state(id) {
    if (!states.has(id)) states.set(id, { items: new Map(), order: [], api: new Map(), lastWindow: [], gap: false });
    while (states.size > 4) states.delete(states.keys().next().value);
    return states.get(id);
  }
  const norm = s => String(s || '').replace(/\u00a0/g, ' ').replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  const fullID = s => typeof s === 'string' ? s.trim() : '';
  const own = (o,k) => Object.prototype.hasOwnProperty.call(o,k);

  // Observe only existing ChatGPT requests. No auth token, no new HTTP call,
  // no scroll, and no background history pagination are used.
  function historyEndpoint(input) {
    try {
      const u = new URL(typeof input === 'string' || input instanceof URL ? input : input.url, location.href);
      if (u.origin !== location.origin) return '';
      return u.pathname.match(/^\/backend-api\/conversations?\/([\w-]+)(?:\/messages)?\/?$/)?.[1] || '';
    } catch { return ''; }
  }
  function unwrap(obj) {
    for (const x of [obj, obj?.conversation, obj?.data?.conversation, obj?.data]) {
      if (x && typeof x === 'object' && (x.mapping || Array.isArray(x.messages) || Array.isArray(x.items))) return x;
    }
    return null;
  }
  function apiText(message) {
    const role = message?.author?.role ?? message?.role;
    if (role !== 'user' && role !== 'assistant') return null;
    if (message?.metadata?.is_visually_hidden_from_conversation) return null;
    const channel = message?.channel ?? message?.metadata?.channel;
    if (role === 'assistant' && channel && channel !== 'final' && channel !== 'complete') return null;
    const recipient = message?.recipient;
    if (role === 'assistant' && recipient && !['all','user','assistant'].includes(recipient)) return null;
    const content = message?.content ?? {};
    const parts = Array.isArray(content.parts) ? content.parts :
      typeof content.text === 'string' ? [content.text] : [];
    const text = norm(parts.map(p => {
      if (typeof p === 'string') return p;
      if (p && (p.type === 'text' || p.type === 'input_text' || p.content_type === 'text') && typeof p.text === 'string') return p.text;
      return '';
    }).filter(Boolean).join('\n\n'));
    return text ? { role, text } : null;
  }
  function consume(raw, id) {
    if (id !== chatID()) return;
    const page = unwrap(raw);
    if (!page) return;
    const store = state(id);
    const rows = page.mapping && !Array.isArray(page.mapping)
      ? Object.entries(page.mapping).map(([k, v]) => ({ id: k, message: v?.message }))
      : (page.messages || page.items || []).map(e => {
        const msg = own(e, 'message') ? e.message : e;
        return { id: fullID(e.id || msg?.id), message: msg };
      });
    for (const row of rows) {
      const text = apiText(row.message);
      if (row.id && text) store.api.set(row.id, text);
      if (row.message?.id && text) store.api.set(row.message.id, text);
    }
  }
  const oldFetch = window.fetch;
  if (typeof oldFetch === 'function') {
    window.fetch = function (...args) {
      const id = historyEndpoint(args[0]);
      const result = oldFetch.apply(this, args);
      if (id) Promise.resolve(result).then(response => {
        if (response?.ok) response.clone().json().then(data => consume(data, id)).catch(() => {});
      }).catch(() => {});
      return result;
    };
  }
  if (window.XMLHttpRequest) {
    const open = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method, url, ...rest) {
      const id = historyEndpoint(url);
      if (id) this.addEventListener('load', () => {
        try {
          if (this.status < 200 || this.status >= 300) return;
          consume(this.responseType === 'json' ? this.response : JSON.parse(this.responseText), id);
        } catch { /* No interference with the page. */ }
      }, { once: true });
      return open.call(this, method, url, ...rest);
    };
  }

  const IGNORE = [
    'script','style','noscript','svg','img','picture','video','audio','canvas','iframe',
    'button','input','textarea','select','form','nav','aside','header','footer',
    '[aria-hidden="true"]','[hidden]','[contenteditable="true"]','[role="button"]',
    '[role="toolbar"]','.sr-only','[class*="screen-reader"]',
    '[data-testid*="thinking"]','[data-testid*="reasoning"]','[data-testid*="attachment"]',
    '[data-testid*="file-chip"]','[data-testid*="image"]',
    '[data-testid*="feedback"]','[data-testid*="message-actions"]',
    '[data-testid*="copy"]','[data-testid*="tool"]'
  ].join(',');
  const BLOCKS = new Set(['P','DIV','SECTION','ARTICLE','LI','PRE','UL','OL','TR','BLOCKQUOTE','H1','H2','H3','H4','H5','H6']);
  function render(node) {
    if (node.nodeType === Node.TEXT_NODE) return node.nodeValue || '';
    if (node.nodeType !== Node.ELEMENT_NODE || node.matches(IGNORE)) return '';
    if (node.tagName === 'BR') return '\n';
    let s = '';
    for (const child of node.childNodes) s += render(child);
    if (node.tagName === 'LI') return '\n- ' + s.trim() + '\n';
    if (node.tagName === 'TD' || node.tagName === 'TH') return s.trim() + '\t';
    return BLOCKS.has(node.tagName) ? '\n' + s + '\n' : s;
  }
  function shown(el) {
    if (!el?.isConnected || el.closest('[role="presentation"],[aria-hidden="true"],[hidden],#' + PANEL_ID)) return false;
    for (let cur = el, n = 0; cur && cur !== document.body && n < 12; cur = cur.parentElement, n++) {
      const style = getComputedStyle(cur);
      if (style.display === 'none' || style.visibility === 'hidden') return false;
    }
    return true;
  }
  function relevantText(root, role) {
    const preferred = role === 'user'
      ? ['[data-user-message-bubble="true"]','.whitespace-pre-wrap','[data-testid="user-message"]','[data-testid="message-text"]']
      : ['.markdown','.prose','[data-testid="assistant-message"]','[data-testid="message-text"]'];
    for (const selector of preferred) {
      const elems = [...root.querySelectorAll(selector)].filter(shown);
      const outer = elems.filter(x => !elems.some(y => x !== y && y.contains(x)));
      const text = norm(outer.map(render).filter(Boolean).join('\n\n'));
      if (text) return text;
    }
    return norm(render(root));
  }
  function extractIDs(raw) {
    const s = typeof raw === 'string' ? raw : '';
    const pattern = /[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}|[a-f0-9]{32}/ig;
    return s.match(pattern) || [];
  }
  function identity(node, role, modern) {
    if (modern) {
      const searchIDs = extractIDs(node.getAttribute('data-chatgpt-search-message-ids') ||
        node.closest('[data-chatgpt-search-message-ids]')?.getAttribute('data-chatgpt-search-message-ids'));
      if (searchIDs.length) return searchIDs[0];
      if (role === 'user') {
        const turnID = node.closest('[data-turn-key]')?.getAttribute('data-turn-key');
        if (turnID && !turnID.startsWith('fallback-')) return turnID;
      }
    }
    const ownID = node.getAttribute('data-message-id') || node.querySelector('[data-message-id]')?.getAttribute('data-message-id');
    if (ownID) return ownID;
    return node.getAttribute('data-turn-id') || node.closest('[data-turn-id]')?.getAttribute('data-turn-id') || '';
  }
  function candidateBatch() {
    const timeline = [...document.querySelectorAll('[data-app-action-timeline-scroll][role="region"]')].find(shown);
    if (timeline) {
      const units = [...timeline.querySelectorAll('[data-content-search-unit-key$=":user"],[data-content-search-unit-key$=":assistant"]')]
        .filter(shown).filter(n => !n.parentElement?.closest('[data-content-search-unit-key$=":user"],[data-content-search-unit-key$=":assistant"]'));
      if (units.length) return units.map(node => ({
        el: node, role: node.getAttribute('data-content-search-unit-key').endsWith(':user') ? 'user' : 'assistant', modern: true
      }));
    }
    // Legacy ChatGPT markup, still useful on some profiles.
    const wrappers = [...document.querySelectorAll('section[data-turn="user"],section[data-turn="assistant"],article[data-turn="user"],article[data-turn="assistant"]')]
      .filter(shown).map(el => ({ el, role: el.getAttribute('data-turn'), modern: false }));
    if (wrappers.length) return wrappers;
    return [...document.querySelectorAll('[data-message-author-role="user"],[data-message-author-role="assistant"]')]
      .filter(shown).filter(el => !el.parentElement?.closest('[data-message-author-role="user"],[data-message-author-role="assistant"]'))
      .map(el => ({ el, role: el.getAttribute('data-message-author-role'), modern: false }));
  }
  function addOrdered(store, visible) {
    const keys = visible.map(e => e.key);
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      if (store.order.includes(key)) continue;
      let idx = -1;
      // The nearest earlier unit in the current mounted window is an anchor.
      for (let j = i-1; j >= 0; j--) {
        const p = store.order.indexOf(keys[j]);
        if (p >= 0) { idx = p + 1; break; }
      }
      if (idx < 0) {
        for (let j = i+1; j < keys.length; j++) {
          const p = store.order.indexOf(keys[j]);
          if (p >= 0) { idx = p; break; }
        }
      }
      if (idx < 0 && store.order.length) store.gap = true;
      store.order.splice(idx < 0 ? store.order.length : idx, 0, key);
    }
    store.lastWindow = keys;
  }
  function scan() {
    const id = chatID();
    if (!id) return;
    const store = state(id);
    const batch = [];
    for (const { el, role, modern } of candidateBatch()) {
      if (role !== 'user' && role !== 'assistant') continue;
      let text = relevantText(el, role);
      const mid = identity(el, role, modern);
      const api = mid ? store.api.get(mid) : null;
      // A contradictory explicit speaker is corruption, not a reason to relabel.
      if (api && api.role !== role) continue;
      if (!text && api) text = api.text;
      if (!text) continue;
      const key = mid ? 'id:' + mid : 'dom:' + (modern ? el.getAttribute('data-content-search-unit-key') || '' :
        el.getAttribute('data-testid') || '') + ':' + role + ':' + text;
      batch.push({ key, id: mid, role, text });
    }
    if (!batch.length) return;
    const unique = [];
    const seen = new Set();
    for (const item of batch) {
      if (seen.has(item.key)) continue;
      seen.add(item.key);
      const old = store.items.get(item.key);
      store.items.set(item.key, { ...item, seq: old?.seq ?? ++serial });
      unique.push(item);
    }
    addOrdered(store, unique);
    updateCounter();
  }
  function turns() {
    scan();
    const s = state(chatID());
    return s.order.map(key => s.items.get(key)).filter(Boolean);
  }
  function updateCounter() {
    if (!status || !chatID()) return;
    const count = state(chatID()).items.size;
    status.textContent = count ? count + ' \u067e\u06cc\u0627\u0645 \u0628\u0627\u0631\u06af\u0630\u0627\u0631\u06cc\u200c\u0634\u062f\u0647' : '...';
  }
  function download(list, id) {
    const title = (document.title || 'ChatGPT').replace(/\s*[-|]\s*ChatGPT.*$/i,'')
      .replace(/[\x00-\x1f\x7f<>:"/\\|?*]/g,'_').trim().slice(0,76) || 'ChatGPT';
    const text = list.map(item => `${item.role === 'user' ? USER : ASSISTANT}:\n\n${item.text}`)
      .join('\n\n--------------------\n\n') + '\n';
    const url = URL.createObjectURL(new Blob(['\uFEFF' + text], { type: 'text/plain;charset=utf-8' }));
    const link = document.createElement('a'); link.href = url;
    link.download = title + '-ChatGPT-loaded-' + id.slice(0,8) + '.txt';
    document.body.appendChild(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }
  function mount() {
    if (!document.body) return;
    if (!panel) {
      panel = document.createElement('div'); panel.id = PANEL_ID; panel.dir = 'rtl';
      panel.style.cssText = 'position:fixed;bottom:18px;right:18px;z-index:2147483647;display:flex;align-items:center;gap:8px;background:#222;color:#fff;border:1px solid #555;border-radius:11px;padding:9px;box-shadow:0 3px 16px #0005;max-width:390px;font:12px sans-serif;';
      button = document.createElement('button'); button.type = 'button';
      button.textContent = '\u062e\u0631\u0648\u062c\u06cc \u0645\u062a\u0646 \u0628\u0627\u0631\u06af\u0630\u0627\u0631\u06cc\u200c\u0634\u062f\u0647';
      button.style.cssText = 'background:#fff;color:#222;border:0;border-radius:7px;padding:8px 10px;cursor:pointer;font:600 12px sans-serif;';
      status = document.createElement('span'); status.style.cssText='overflow-wrap:anywhere;font:12px sans-serif;';
      button.addEventListener('click', () => {
        if (exporting || !chatID()) return;
        exporting = true; button.disabled = true;
        try {
          const before = chatID(), list = turns();
          if (chatID() !== before) throw Error('Conversation changed during export.');
          if (!list.length) throw Error('No loaded messages with explicit speaker roles found. Reload the conversation.');
          if (list.length > 25000) throw Error('Too many loaded messages.');
          download(list, before);
          status.textContent = list.length + ' \u067e\u06cc\u0627\u0645 \u0630\u062e\u06cc\u0631\u0647 \u0634\u062f';
        } catch (e) { status.textContent = e.message || 'Export failed.'; console.warn('[ChatGPT loaded role-safe]',e); }
        finally { exporting = false; button.disabled = false; }
      });
      panel.append(button, status); document.body.appendChild(panel);
    }
    if (panel.parentElement !== document.body) document.body.appendChild(panel);
    panel.style.display = chatID() ? 'flex' : 'none';
  }
  function schedule() {
    if (scheduled) return;
    scheduled = true;
    setTimeout(() => { scheduled = false; scan(); }, 300);
  }
  function start() {
    mount(); scan();
    new MutationObserver(list => {
      if (!list.every(m => panel && panel.contains(m.target))) schedule();
    }).observe(document.body, { childList:true, subtree:true, characterData:true });
    document.addEventListener('scroll', schedule, true);
    setInterval(() => { mount(); schedule(); }, 2400);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once:true });
  else start();
})();
