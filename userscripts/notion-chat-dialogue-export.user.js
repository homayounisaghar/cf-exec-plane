// ==UserScript==
// @name         Notion AI - Export current chat as dialogue TXT
// @namespace    local.notion.chat-dialogue-export
// @version      1.4.0
// @description  Export Notion AI dialogue via read-only server history, with automated scroll-and-capture fallback.
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
  const VERSION = '1.4.0';
  const API_BASE = '/api/v3/';
  const SYNC_ROUTES = ['syncRecordValuesMain', 'syncRecordValuesSpaceInitial', 'syncRecordValues'];
  const idOf = value => typeof value === 'string' ? value.toLowerCase().replace(/-/g, '') : '';
  const validID = value => /^[a-f0-9]{32}$/.test(value);
  const dash = value => value.replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5');
  const nativeFetch = window.fetch.bind(window);
  const headerHints = new Map();
  const spaces = new Set();
  const diagnostics = [];
  const transcripts = new Map();
  let busy = false, panel, button, reportButton, statusText;
  let observedOrigin = location.origin;

  function currentID() {
    const p = new URLSearchParams(location.search);
    if (location.pathname.replace(/\/$/, '') !== '/chat' && p.get('wfv') !== 'chat') return '';
    const id = idOf(p.get('t'));
    return validID(id) ? id : '';
  }
  function checkID(id) {
    if (!id || id !== currentID()) throw Error('چت هنگام گرفتن خروجی تغییر کرده است.');
  }
  function logDiagnostic(event) {
    if (diagnostics.length < 150) diagnostics.push(event);
  }
  function showStatus(s) {
    if (statusText) statusText.textContent = s;
  }
  function mapOf(value) {
    return value?.recordMap ?? value?.result?.recordMap ?? value?.data?.recordMap ?? {};
  }
  function unwrap(value) {
    let v = value;
    for (let n = 0; n < 4 && v && typeof v === 'object'; n++) {
      if (Array.isArray(v.messages) || v.step || v.parent_id ||
          (v.id && (v.data || v.space_id || v.type))) break;
      if (!v.value || typeof v.value !== 'object') break;
      v = v.value;
    }
    return v;
  }
  function orderOf(thread) {
    const source = Array.isArray(thread?.messages) ? thread.messages :
      (Array.isArray(thread?.data?.messages) ? thread.data.messages : null);
    if (!source) return null;
    const ids = source.map(x => idOf(typeof x === 'string' ? x : x?.id));
    return ids.every(validID) && new Set(ids).size === ids.length ? ids : null;
  }
  function history(id) {
    if (!transcripts.has(id)) transcripts.set(id, { order: null, title: '', spaceId: '', records: new Map() });
    for (const key of transcripts.keys()) if (key !== id) transcripts.delete(key);
    return transcripts.get(id);
  }
  function consumeRecordMap(response, id) {
    if (id !== currentID()) return;
    const rm = mapOf(response), h = history(id);
    for (const [key, entry] of Object.entries(rm.thread || {})) {
      const v = unwrap(entry);
      if (idOf(key) !== id && idOf(v?.id) !== id) continue;
      const order = orderOf(v);
      if (order && (!h.order || order.length >= h.order.length)) h.order = order;
      if (typeof v?.data?.title === 'string') h.title = v.data.title;
      if (validID(idOf(v?.space_id))) { h.spaceId = idOf(v.space_id); spaces.add(h.spaceId); }
    }
    for (const [key, entry] of Object.entries(rm.thread_message || {})) {
      const mid = idOf(key), v = unwrap(entry);
      if (!validID(mid) || !v || (!v.step && !v.role)) continue;
      if (idOf(v.parent_id || v.thread_id) === id || h.order?.includes(mid)) h.records.set(mid, v);
    }
  }
  function observeHeaders(input, init) {
    try {
      const arg = typeof input === 'string' || input instanceof URL ? input : input.url;
      const url = new URL(arg, location.href);
      if (!['app.notion.com', 'www.notion.so', 'notion.so'].includes(url.hostname) ||
          !url.pathname.startsWith(API_BASE)) return null;
      observedOrigin = url.origin;
      const headers = new Headers(input?.headers || {});
      new Headers(init?.headers || {}).forEach((v, k) => headers.set(k, v));
      for (const name of ['x-notion-active-user-header', 'notion-client-version', 'x-notion-client-version', 'x-notion-space-id']) {
        if (headers.has(name)) headerHints.set(name, headers.get(name));
      }
      const spaceId = idOf(headers.get('x-notion-space-id'));
      if (validID(spaceId)) spaces.add(spaceId);
      return url;
    } catch { return null; }
  }
  // Passively watch Notion's original fetches, without changing their contents.
  window.fetch = function (input, init) {
    const url = observeHeaders(input, init), id = currentID();
    const observe = !!id && url && SYNC_ROUTES.some(route => url.pathname === API_BASE + route);
    const original = nativeFetch(input, init);
    if (!observe) return original;
    return original.then(response => {
      if (response.ok) {
        try { response.clone().json().then(json => consumeRecordMap(json, id)).catch(() => {}); }
        catch { /* Never interfere with Notion. */ }
      }
      return response;
    });
  };
  function headersFor(spaceId) {
    const result = { 'Content-Type': 'application/json', Accept: 'application/json',
      'notion-audit-log-platform': 'web' };
    for (const key of ['x-notion-active-user-header', 'notion-client-version', 'x-notion-client-version']) {
      if (headerHints.has(key)) result[key] = headerHints.get(key);
    }
    if (spaceId) result['x-notion-space-id'] = dash(spaceId);
    return result;
  }
  async function post(path, payload, id, spaceId) {
    checkID(id);
    const safeURL = observedOrigin + API_BASE + path;
    let response;
    try {
      response = await nativeFetch(safeURL, { method: 'POST', credentials: 'include', cache: 'no-store',
        headers: headersFor(spaceId), body: JSON.stringify(payload) });
    } catch (err) {
      logDiagnostic({ route: path, networkError: err?.name || 'NetworkError' });
      throw Error('خطا در اتصال به مسیر خواندن نوشن');
    }
    checkID(id);
    if (!response.ok) {
      logDiagnostic({ route: path, http: response.status });
      throw Error('پاسخ سرور: ' + response.status);
    }
    const data = await response.json();
    checkID(id);
    const rm = mapOf(data);
    logDiagnostic({ route: path, http: response.status, tables: Object.keys(rm).slice(0, 12),
      threadRecords: Object.keys(rm.thread || {}).length, messageRecords: Object.keys(rm.thread_message || {}).length });
    consumeRecordMap(data, id);
    return data;
  }
  async function sync(table, ids, id, spaceId, route = 'syncRecordValuesMain') {
    return post(route, { requests: ids.map(x => ({ pointer: {
      table, id: dash(x), ...(spaceId ? { spaceId: dash(spaceId) } : {}) }, version: -1 })) }, id, spaceId);
  }
  async function findSpace(id) {
    if (validID(history(id).spaceId)) return history(id).spaceId;
    try {
      const data = await post('loadUserContent', {}, id, '');
      for (const [key, entry] of Object.entries(mapOf(data).space || {})) {
        const sid = idOf(unwrap(entry)?.id || key);
        if (validID(sid)) spaces.add(sid);
      }
    } catch { /* Some sessions hide bootstrap, continue with observed headers. */ }
    for (const sid of [...spaces].slice(0, 20)) {
      checkID(id);
      try {
        const data = await post('getInferenceTranscriptsForUser', {
          threadParentPointer: { table: 'space', id: dash(sid), spaceId: dash(sid) }, limit: 100
        }, id, sid);
        const h = history(id);
        const ids = [...(data.threadIds || []), ...(data.transcripts || []).map(x => x.id)].map(idOf);
        logDiagnostic({ stage: 'thread-list', matched: ids.includes(id), count: ids.length, hasMore: !!data.hasMore });
        if (ids.includes(id)) {
          h.spaceId = sid;
          const meta = (data.transcripts || []).find(x => idOf(x.id) === id);
          if (meta?.title) h.title = meta.title;
          if (h.order?.length) return sid;
          return sid;
        }
      } catch { /* Attempt next workspace. */ }
    }
    return '';
  }
  function textRich(value) {
    if (typeof value === 'string') return value.trim();
    if (!Array.isArray(value)) return '';
    return value.map(a => typeof a === 'string' ? a : Array.isArray(a) ? String(a[0] || '') : '').join('').trim();
  }
  function fromStep(record) {
    const step = record?.step || {}, type = step.type || record?.role;
    if (type === 'user' || type === 'human') {
      const text = textRich(step.value ?? record.content);
      return text ? { role: 'user', text } : null;
    }
    if (type === 'agent-inference' || type === 'assistant') {
      const v = step.value ?? record.content;
      const text = (Array.isArray(v) ? v.filter(x => x?.type === 'text' && typeof x.content === 'string')
        .map(x => x.content).join('\n\n') : (typeof v === 'string' ? v : ''))
        .replace(/<lang\b[^>]*\/>/g, '').replace(/<edit_reference\b[^>]*>[\s\S]*?<\/edit_reference>/g, '').trim();
      return text ? { role: 'assistant', text } : null;
    }
    return null;
  }
  async function readAPI(id) {
    const h = history(id);
    h.order = null; h.records.clear();
    showStatus('در حال خواندن تاریخچه از سرور…');
    const sid = await findSpace(id);
    const candidates = [...new Set([sid, h.spaceId, ...spaces, ''])].filter(x => !x || validID(x)).slice(0, 12);
    let selectedRoute = '';
    for (const spaceId of candidates) {
      for (const route of SYNC_ROUTES) {
        if (h.order?.length) { selectedRoute ||= route; break; }
        try {
          await sync('thread', [id], id, spaceId, route);
          if (h.order?.length) { selectedRoute = route; if (spaceId) h.spaceId = spaceId; break; }
        } catch { /* Fallback to other verified read routes. */ }
      }
      if (h.order?.length) break;
    }
    if (!h.order?.length) throw Error('نوشن فهرست پیام‌های چت را در پاسخ سرور قرار نداد.');
    if (h.order.length > 20000) throw Error('فهرست پیام‌ها بیش از سقف ایمنی است.');
    const order = h.order.slice();
    const missing = () => order.filter(mid => !h.records.has(mid));
    for (const batchSize of [35, 10]) {
      const ids = missing();
      for (let i = 0; i < ids.length; i += batchSize) {
        checkID(id);
        showStatus('خواندن پیام از سرور: ' + (order.length - missing().length) + '/' + order.length);
        try { await sync('thread_message', ids.slice(i, i + batchSize), id, h.spaceId, selectedRoute); }
        catch { /* Try again in smaller batches. */ }
      }
      if (!missing().length) break;
    }
    if (missing().length) throw Error('چند رکورد پیام از سرور بازنگشت.');
    const latest = await sync('thread', [id], id, h.spaceId, selectedRoute);
    const entry = Object.entries(mapOf(latest).thread || {}).find(([key]) => idOf(key) === id);
    const finalOrder = orderOf(unwrap(entry?.[1]));
    if (!finalOrder || finalOrder.join(',') !== order.join(',')) throw Error('فهرست پیام‌ها هنگام استخراج تغییر کرده است.');
    const turns = order.map(mid => fromStep(h.records.get(mid))).filter(Boolean);
    if (!turns.some(x => x.role === 'user') || !turns.some(x => x.role === 'assistant'))
      throw Error('رکوردهای دریافت‌شده شامل هر دو طرف گفتگو نبودند.');
    return { title: h.title, turns, source: 'server', count: order.length };
  }

  // DOM fallback: crawl the *chat scroller*, not the page's sidebar. It scrolls
  // up to the stable beginning and then down, merging overlapping windows of
  // rendered turns (works when Notion virtualizes offscreen messages).
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  function rectOf(el) { try { return el.getBoundingClientRect(); } catch { return null; } }
  function visibleBox(el) {
    const r = rectOf(el);
    if (!r || r.width < 4 || r.height < 3 || r.bottom < 0 || r.top > innerHeight) return false;
    const style = getComputedStyle(el);
    return style.display !== 'none' && style.visibility !== 'hidden';
  }
  function scrollerCandidates() {
    const found = new Map(), all = document.querySelectorAll('body *');
    const maxScan = Math.min(all.length, 60000);
    for (let i = 0; i < maxScan; i++) {
      const el = all[i];
      if (el === panel || panel?.contains(el)) continue;
      if (el.scrollHeight - el.clientHeight < 120 || el.clientHeight < 130) continue;
      const r = rectOf(el);
      if (!r || r.width < Math.min(innerWidth * .38, 260) || r.height < 130 ||
          r.bottom < 100 || r.top > innerHeight - 100) continue;
      const css = getComputedStyle(el), overflow = css.overflowY;
      if (!/auto|scroll|overlay/i.test(overflow) && el.scrollTop < 2) continue;
      let score = (el.scrollTop > 40 ? 7 : 0) + Math.min(6, (el.scrollHeight - el.clientHeight) / 350);
      if (r.left < innerWidth * .75 && r.right > innerWidth * .36) score += 5;
      if (r.top < innerHeight * .55 && r.bottom > innerHeight * .5) score += 2;
      if (/scroller|scroll|chat|transcript|messages/i.test((el.className || '').toString())) score += 4;
      if (el.closest('aside, nav, #notion-dialogue-txt-exporter')) score -= 30;
      if (el.querySelector('[contenteditable="true"], textarea[placeholder*="Ask"]')) score += 2;
      found.set(el, score);
    }
    const root = document.scrollingElement;
    if (root?.scrollHeight - root?.clientHeight > 120) found.set(root, (found.get(root) || 0) + 6);
    for (const x of [.4, .5, .6]) {
      const from = document.elementFromPoint(innerWidth * x, innerHeight * .47);
      let parent = from;
      for (let n = 0; parent && n < 16; n++, parent = parent.parentElement) {
        if (found.has(parent)) found.set(parent, found.get(parent) + 12 - Math.min(n, 8));
      }
    }
    return [...found].sort((a, b) => b[1] - a[1]).map(([el]) => el);
  }
  function eligibleContent(el, root) {
    if (!root.contains(el) || el.closest('#notion-dialogue-txt-exporter,nav,aside,header,footer')) return false;
    if (el.closest('form,[contenteditable="true"]')) return false;
    const r = rectOf(el), base = rectOf(root);
    if (!r || !base || r.width < 18 || r.height < 10) return false;
    if (r.right <= base.left + base.width * .04 || r.left >= base.right - base.width * .04) return false;
    const css = getComputedStyle(el);
    return css.display !== 'none' && css.visibility !== 'hidden';
  }
  function roleOf(el) {
    const attrs = ['data-message-author-role', 'data-message-role', 'data-role', 'data-turn', 'data-sender', 'data-author', 'data-perf-row'];
    for (const attr of attrs) {
      const v = String(el.getAttribute?.(attr) || '').toLowerCase();
      if (/^(human|user|editor)$/.test(v)) return 'user';
      if (/^(assistant|ai|agent|model|notion-ai)$/.test(v)) return 'assistant';
    }
    const hint = [el.getAttribute?.('data-testid'), el.getAttribute?.('data-test-id'),
      el.getAttribute?.('data-cy'), el.className?.baseVal || el.className]
      .filter(x => typeof x === 'string').join(' ').toLowerCase();
    if (/(^|[\s_-])(user|human|prompt|question)([\s_-]|$)/.test(hint) &&
        /(message|turn|bubble|chat|query|row)/.test(hint)) return 'user';
    if (/(^|[\s_-])(assistant|agent|ai|model)([\s_-]|$)/.test(hint) &&
        /(message|turn|response|chat|answer|row)/.test(hint)) return 'assistant';
    return '';
  }
  function isUIElement(el) {
    const tag = el.tagName;
    if (/^(SCRIPT|STYLE|SVG|IMG|CANVAS|VIDEO|AUDIO|INPUT|TEXTAREA|BUTTON|NAV|FOOTER|FORM|TIME|NOSCRIPT)$/.test(tag)) return true;
    if (el.getAttribute('aria-hidden') === 'true' || el.getAttribute('role') === 'button' ||
        el.getAttribute('role') === 'toolbar' || el.hasAttribute('contenteditable')) return true;
    const label = (el.getAttribute('aria-label') || '').toLowerCase();
    const marker = [el.getAttribute('data-testid'), el.getAttribute('data-test-id'),
      el.className?.baseVal || el.className].filter(x => typeof x === 'string').join(' ').toLowerCase();
    if (/thinking|thought|reasoning|tool-result|attachment|file-preview|chat-actions|toolbar|message-actions|feedback|citation-tooltip/.test(marker)) return true;
    if (/thinking|thought|copy|feedback|share|retry|download|load more|tool calls/i.test(label)) return true;
    if (tag === 'DETAILS' && /thought|thinking|reason/i.test(el.querySelector('summary')?.textContent || '')) return true;
    return false;
  }
  function cleanTextNode(el) {
    const out = [];
    function visit(node) {
      if (node.nodeType === 3) { out.push(node.nodeValue); return; }
      if (node.nodeType !== 1 || isUIElement(node)) return;
      const tag = node.tagName;
      if (tag === 'BR') { out.push('\n'); return; }
      if (/^(P|DIV|SECTION|ARTICLE|H[1-6]|LI|BLOCKQUOTE|TR|PRE)$/.test(tag)) out.push('\n');
      if (tag === 'LI') out.push('• ');
      for (const child of node.childNodes) visit(child);
      if (/^(P|DIV|SECTION|ARTICLE|H[1-6]|LI|BLOCKQUOTE|TR|PRE)$/.test(tag)) out.push('\n');
    }
    visit(el);
    return out.join('')
      .replace(/\u00a0/g, ' ').replace(/[ \t]+\n/g, '\n')
      .replace(/\n[ \t]+/g, '\n').replace(/\n{3,}/g, '\n\n')
      .split('\n').map(line => line.trim())
      .filter(line => !/^(Thought|Thinking|Worked for\s+\d+.*|Copy|Retry|Share|Ask Notion AI|Show more|Liked|Disliked|More actions)$/i.test(line))
      .join('\n').trim();
  }
  function contentText(el, role) {
    if (role === 'assistant') {
      const preferred = [...el.querySelectorAll('.markdown,.prose,[data-testid*="message-content"],[data-testid*="response-content"],[class*="markdown-body"]')]
        .filter(x => !x.parentElement?.closest('.markdown,.prose,[data-testid*="message-content"],[data-testid*="response-content"]'));
      const chunks = preferred.map(cleanTextNode).filter(Boolean);
      if (chunks.length) return chunks.join('\n\n').trim();
    }
    return cleanTextNode(el);
  }
  function semanticTurns(root) {
    const sel = '[data-message-author-role],[data-message-role],[data-role],[data-turn],[data-sender],[data-author],[data-perf-row],'+
      '[data-testid*="message"],[data-testid*="turn"],[data-testid*="response"],[data-testid*="query"],'+
      '[class*="user-message"],[class*="assistant-message"],[class*="agent-message"],[class*="userMessage"],[class*="assistantMessage"]';
    const candidates = [...root.querySelectorAll(sel)]
      .filter(el => eligibleContent(el, root)).map(el => ({ el, role: roleOf(el) })).filter(x => x.role);
    const rows = candidates.filter(x => !candidates.some(y => y !== x && y.role === x.role && y.el.contains(x.el)));
    const turns = rows.map(({el,role}) => ({role, text:contentText(el,role), el, confidence:'semantic'}))
      .filter(x => x.text.length > 0);
    return turns;
  }
  function visualTurns(root) {
    // Fallback when role attributes are absent: identify right-aligned message
    // bubbles, then read conversation-row siblings in DOM order.
    const rootRect = rectOf(root);
    if (!rootRect) return [];
    const bubbles = [];
    for (const el of root.querySelectorAll('div,article,section')) {
      if (!eligibleContent(el, root) || el.querySelector('textarea,[contenteditable="true"]')) continue;
      const rect = rectOf(el), css = getComputedStyle(el), p = el.parentElement;
      if (!rect || !p || rect.width < 65 || rect.height < 20 || rect.width > rootRect.width * .88) continue;
      const radius = parseFloat(css.borderTopLeftRadius || '0');
      if (radius < 10 || !css.backgroundColor || /transparent|rgba\([^)]*,\s*0\s*\)/.test(css.backgroundColor)) continue;
      if (rect.right < rootRect.right - rootRect.width * .19 || rect.left < rootRect.left + rootRect.width * .1) continue;
      const content = cleanTextNode(el);
      if (content.length < 2 || content.length > 120000) continue;
      bubbles.push({ el, text: content });
    }
    const userBubbles = bubbles.filter(x => !bubbles.some(y => y !== x && x.el.contains(y.el)));
    if (!userBubbles.length) return [];
    // Find the closest ancestor whose children are separate chat turn rows.
    let best = null;
    for (const bubble of userBubbles.slice(0, 12)) {
      let row = bubble.el;
      for (let d = 0; d < 6 && row.parentElement && row.parentElement !== root; d++) {
        const parent = row.parentElement;
        if (parent.children.length >= 2 && parent.children.length <= 1000 &&
            parent.querySelectorAll('button,[role="button"]').length <= 1200) {
          const containsUser = [...parent.children].filter(child => userBubbles.some(b => child.contains(b.el)));
          const otherRows = [...parent.children].filter(child => !containsUser.includes(child) && cleanTextNode(child).length > 18);
          if (containsUser.length && otherRows.length) {
            const count = containsUser.length + otherRows.length;
            if (!best || count > best.count) best = { parent, count };
          }
        }
        row = parent;
      }
    }
    if (!best) return [];
    const rows = [...best.parent.children];
    return rows.map(el => {
      if (!eligibleContent(el, root)) return null;
      const bubble = userBubbles.find(b => el.contains(b.el));
      const role = bubble ? 'user' : 'assistant';
      const text = bubble ? bubble.text : contentText(el, role);
      return text.length > 1 ? { role, text, el, confidence:'visual' } : null;
    }).filter(Boolean);
  }
  function mountedTurns(root, scroller) {
    let semantic = semanticTurns(root);
    // If one role isn't represented, visual row grouping can complement it.
    if (!semantic.some(x => x.role === 'user') || !semantic.some(x => x.role === 'assistant')) {
      const visual = visualTurns(root);
      if (visual.length > semantic.length && visual.some(x => x.role === 'user') && visual.some(x => x.role === 'assistant'))
        semantic = visual;
    }
    const unique = [];
    for (const item of semantic) {
      if (unique.some(x => x.el.contains(item.el))) continue;
      unique.push(item);
    }
    unique.sort((a,b) => a.el.compareDocumentPosition(b.el) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1);
    const rootRect = rectOf(scroller);
    return unique.map(({role,text,confidence,el}) => {
      const stableID = ['data-message-id','data-turn-id','data-chat-message-id','data-record-id']
        .map(k => idOf(el.getAttribute(k))).find(validID) || '';
      const rect = rectOf(el);
      const anchorY = rect && rootRect ? Math.round(rect.top - rootRect.top + scroller.scrollTop) : null;
      return {role,text,confidence,stableID,anchorY};
    });
  }
  function sameTurn(a,b) {
    if (a.role !== b.role || a.text !== b.text) return false;
    if (a.stableID && b.stableID) return a.stableID === b.stableID;
    return a.anchorY != null && b.anchorY != null && Math.abs(a.anchorY - b.anchorY) <= 35;
  }
  function mergeWindow(collected, windowTurns) {
    if (!windowTurns.length) return { turns: collected, overlap: 0, empty: true };
    if (!collected.length) return { turns: windowTurns.slice(), overlap: 0, empty: false };
    let overlap = 0;
    for (let n = Math.min(collected.length, windowTurns.length); n > 0; n--) {
      if (collected.slice(-n).every((v,i) => sameTurn(v,windowTurns[i]))) { overlap = n; break; }
    }
    if (!overlap) {
      for (let i = 0; i + windowTurns.length <= collected.length; i++) {
        if (windowTurns.every((v,j) => sameTurn(v,collected[i+j])))
          return { turns: collected, overlap: windowTurns.length, empty: false };
      }
      return { turns: collected.concat(windowTurns), overlap: 0, empty: false, gap: true };
    }
    return { turns: collected.concat(windowTurns.slice(overlap)), overlap, empty: false };
  }
  function positionOf(scroller) { return scroller.scrollTop || 0; }
  function setPosition(scroller, pos) { scroller.scrollTop = Math.max(0, pos); }
  async function settle(id, ms = 350) { await sleep(ms); checkID(id); }
  async function readDOM(id) {
    showStatus('سرور فهرست پیام‌ها را نداد؛ در حال جستجوی صفحهٔ گفتگو…');
    const scrollers = scrollerCandidates();
    let lastError;
    for (const scroller of scrollers.slice(0, 4)) {
      const initialTop = positionOf(scroller);
      const oldOverflowAnchor = scroller.style.overflowAnchor;
      scroller.style.overflowAnchor = 'none';
      const root = scroller === document.scrollingElement ? document.body : scroller;
      let upperReached = false, lowerReached = false, windows = 0, gaps = 0;
      let collected = [];
      logDiagnostic({stage:'dom-scroller', documentScroller:scroller===document.scrollingElement,
        scrollHeight:scroller.scrollHeight, clientHeight:scroller.clientHeight, initialTop:Math.round(initialTop)});
      try {
        let oldTop = Infinity, stable = 0, moves = 0;
        for (; moves < 2000; moves++) {
          checkID(id);
          const top = positionOf(scroller);
          showStatus('پیمایش خودکار به ابتدای چت… ' + moves);
          const target = Math.max(0, top - Math.max(140, Math.floor(scroller.clientHeight * .72)));
          setPosition(scroller, target);
          await settle(id, top <= 2 ? 850 : 280);
          const now = positionOf(scroller);
          if (now <= 2 && oldTop <= 2) stable++;
          else stable = 0;
          oldTop = now;
          if (stable >= 3) { upperReached = true; break; }
          if (now >= top - 1 && top > 2) throw Error('محدودهٔ اسکرول انتخاب‌شده حرکت نکرد.');
        }
        if (!upperReached) throw Error('ابتدای چت در سقف پیمایش به دست نیامد.');
        setPosition(scroller, 0);
        await settle(id, 600);
        let atBottom = 0, previousPos = -1;
        for (let n = 0; n < 2600; n++) {
          checkID(id);
          const sample = mountedTurns(root,scroller);
          const merged = mergeWindow(collected, sample);
          if (merged.gap) gaps++;
          collected = merged.turns;
          windows++;
          const top = positionOf(scroller), maxTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
          if (n < 12) logDiagnostic({stage:'dom-window',step:n,top:Math.round(top),maxTop:Math.round(maxTop),found:sample.length,merged:collected.length,gap:!!merged.gap});
          showStatus('جمع‌آوری پیام‌های چت: ' + collected.length + ' مورد، ' + n + ' گام');
          if (top >= maxTop - 3 && maxTop >= 0) {
            atBottom++;
            if (atBottom >= 3) { lowerReached = true; break; }
            await settle(id, 700);
          } else {
            atBottom = 0;
            const delta = Math.max(80, Math.floor(scroller.clientHeight * .55));
            setPosition(scroller, Math.min(maxTop, top + delta));
            await settle(id, 280);
            if (Math.abs(positionOf(scroller) - top) < 1 && top === previousPos)
              throw Error('پیمایش به پایان گفتگو متوقف شد.');
            previousPos = top;
          }
        }
        const result = collected.map(x => ({role:x.role,text:x.text}));
        const known = result.some(x => x.role === 'user') && result.some(x => x.role === 'assistant');
        logDiagnostic({stage:'dom-crawl',scrollerCandidates:scrollers.length,topReached:upperReached,
          bottomReached:lowerReached,windows,turns:result.length,overlapGaps:gaps,
          roleCoverage:known,semanticCount:collected.filter(x => x.confidence === 'semantic').length,
          visualCount:collected.filter(x => x.confidence === 'visual').length});
        if (!lowerReached || !known || gaps > 0 || result.length < 2) {
          throw Error('تشخیص کامل و پیوستهٔ دیالوگ از صفحه ممکن نشد.');
        }
        return { title: history(id).title, turns: result, source: 'dom', count: windows };
      } catch (err) {
        lastError = err;
        logDiagnostic({stage:'dom-failure', reason: err.message?.slice(0,120),
          windows, turns:collected.length, overlapGaps:gaps, topReached:upperReached, bottomReached:lowerReached});
      } finally {
        // Return the owner to the same place in the chat, even on failure.
        try { setPosition(scroller, initialTop); } catch { /* no effect */ }
        scroller.style.overflowAnchor = oldOverflowAnchor;
      }
    }
    throw lastError || Error('محدودهٔ پیمایش چت پیدا نشد.');
  }
  function saveFile(name, text, mime) {
    const url = URL.createObjectURL(new Blob([text], {type: mime}));
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }
  function saveDialogue(id, result) {
    const title = result.title || document.title.replace(/\s*[-|]\s*Notion.*$/i,'').trim() || 'Notion AI chat';
    const name = title.replace(/[\x00-\x1f\x7f<>:"/\\|?*]/g, '_').replace(/\s+/g,' ').trim().slice(0,74) || 'Notion';
    const dialogue = result.turns.map(t => (t.role === 'user' ? 'کاربر' : 'دستیار هوش مصنوعی') + ':\n\n' + t.text).join('\n\n') + '\n';
    saveFile(name + '-' + id.slice(0,8) + '.txt', '\uFEFF' + dialogue, 'text/plain;charset=utf-8');
  }
  function saveDiagnostics() {
    // Only structural counts/statuses, no identifiers, message text, cookies or credentials.
    const report = { version: VERSION, containsMessageText: false, containsCredentials: false,
      host: location.hostname, events:diagnostics };
    saveFile('notion-export-diagnostics-v1.4.json', JSON.stringify(report, null, 2), 'application/json');
  }
  async function exportCurrent() {
    if (busy) return;
    const id = currentID();
    if (!id) return;
    busy = true; button.disabled = true;
    reportButton.style.display = 'none'; diagnostics.length = 0;
    try {
      let result;
      try { result = await readAPI(id); }
      catch (err) {
        logDiagnostic({stage:'api-fallback',reason:String(err.message || 'read failed').slice(0,100)});
        result = await readDOM(id);
      }
      checkID(id);
      saveDialogue(id, result);
      showStatus('ذخیره شد: ' + result.turns.length + ' پیام متنی (' +
        (result.source === 'server' ? 'از سرور' : 'پیمایش خودکار صفحه') + ').');
    } catch (err) {
      showStatus('خروجی قابل اعتماد ساخته نشد: ' + (err?.message || 'خطا'));
      reportButton.style.display = '';
      console.warn('[Notion chat dialogue export]', err);
    } finally { busy = false; button.disabled = false; }
  }
  function mount() {
    if (!document.body) return;
    if (!panel) {
      panel = document.createElement('div');
      panel.id = 'notion-dialogue-txt-exporter';
      panel.style.cssText = 'position:fixed;z-index:2147483647;bottom:12px;right:12px;max-width:min(94vw,450px);box-sizing:border-box;display:flex;gap:7px;flex-wrap:wrap;align-items:center;direction:rtl;background:#242424;color:#fff;border-radius:12px;padding:8px;box-shadow:0 3px 15px #0006;font:13px sans-serif;';
      button = document.createElement('button');
      button.textContent = 'خروجی گفتگو TXT';
      button.style.cssText = 'border:0;border-radius:8px;background:#fff;color:#222;font:600 13px sans-serif;padding:8px;cursor:pointer;';
      button.addEventListener('click', exportCurrent);
      reportButton = document.createElement('button');
      reportButton.textContent = 'گزارش خطا';
      reportButton.style.cssText = 'display:none;border:1px solid #777;border-radius:7px;background:#444;color:#fff;font:12px sans-serif;padding:8px;cursor:pointer;';
      reportButton.addEventListener('click', saveDiagnostics);
      statusText = document.createElement('span');
      statusText.style.cssText = 'font:12px sans-serif;overflow-wrap:anywhere;flex:1 1 110px;';
      statusText.textContent = 'آمادهٔ استخراج خودکار بدون اسکرول دستی';
      panel.append(button, reportButton, statusText);
    }
    if (panel.parentElement !== document.body) document.body.appendChild(panel);
    panel.style.display = currentID() ? 'flex' : 'none';
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, {once:true});
  else mount();
  setInterval(mount, 1500);
})();
