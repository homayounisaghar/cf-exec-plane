#!/usr/bin/env node
// cf-mirror: standard CF-server "mirroring" tool.
// Shows a hidden browser (Chrome DevTools/CDP port) or an X11 display (WeChat etc.)
// on a local web page with mouse + keyboard, real cursor feedback, size matched
// to the viewer window, default 1 s refresh. Stdlib only (Node >= 22).
import http from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const STATE = path.join(os.homedir(), '.cache', 'cf-mirror');
fs.mkdirSync(STATE, { recursive: true, mode: 0o700 });
const XRDP_DISPLAY = process.env.CF_MIRROR_DESKTOP || ':10';

function usage(code = 0) {
  console.log(`cf-mirror - mirror a hidden browser or X11 app to a local web page

  cf-mirror list                         show mirrorable browsers (CDP) and X displays
  cf-mirror start NAME --cdp PORT [--match TEXT]
  cf-mirror start NAME --x11 :N
        [--interval 1] [--port P] [--open] [--no-fit]
  cf-mirror status                       running mirrors + URLs
  cf-mirror stop NAME|all

  --interval  seconds between frames, or auto (default): 0.05 s, slows to 0.1/0.2 s when server CPU is busy
  --open      also open the mirror in the owner's remote desktop (${XRDP_DISPLAY})
  --no-fit    do not resize the browser viewport to the viewer window (CDP only)
  URL is http://127.0.0.1:PORT/ (local only).`);
  process.exit(code);
}

function args(a) {
  const o = { _: [] };
  for (let i = 0; i < a.length; i++) {
    if (a[i].startsWith('--')) {
      const k = a[i].slice(2);
      if (['open', 'no-fit', 'serve'].includes(k)) o[k] = true; else o[k] = a[++i];
    } else o._.push(a[i]);
  }
  return o;
}

const pidFile = n => path.join(STATE, `${n}.json`);
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
function running() {
  const r = [];
  for (const f of fs.readdirSync(STATE)) {
    if (!f.endsWith('.json')) continue;
    try { const j = JSON.parse(fs.readFileSync(path.join(STATE, f))); if (alive(j.pid)) r.push(j); else fs.unlinkSync(path.join(STATE, f)); } catch {}
  }
  return r;
}

async function getJSON(url, ms = 1500) {
  const c = new AbortController(); const t = setTimeout(() => c.abort(), ms);
  try { const r = await fetch(url, { signal: c.signal }); return await r.json(); } finally { clearTimeout(t); }
}

async function cdpPorts() {
  let ports = [];
  try {
    const out = execFileSync('ss', ['-ltnp'], { encoding: 'utf8' });
    for (const l of out.split('\n')) { const m = l.match(/127\.0\.0\.1:(\d+)\s.*"(chrome|chromium|node)/); if (m) ports.push(+m[1]); }
  } catch {}
  const res = [];
  await Promise.all([...new Set(ports)].map(async p => {
    try { const v = await getJSON(`http://127.0.0.1:${p}/json/version`, 800); if (v.webSocketDebuggerUrl) {
      const l = await getJSON(`http://127.0.0.1:${p}/json/list`, 800);
      for (const t of l) if (t.type === 'page') res.push({ port: p, title: t.title, url: t.url });
    } } catch {}
  }));
  return res.sort((a, b) => a.port - b.port);
}

async function list() {
  console.log('CDP browsers (use --cdp PORT):');
  for (const t of await cdpPorts()) console.log(`  ${t.port}  ${t.url.slice(0, 60)}  | ${t.title.slice(0, 40)}`);
  console.log('X11 displays (use --x11 :N):');
  for (const f of fs.readdirSync('/tmp/.X11-unix')) {
    const d = ':' + f.slice(1); let size = '';
    try { size = execFileSync('xdpyinfo', ['-display', d], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], env: xenv(d) }).match(/dimensions:\s+(\S+)/)?.[1] || ''; } catch { size = '(no access)'; }
    console.log(`  ${d}  ${size}${d === XRDP_DISPLAY ? '  (owner remote desktop)' : ''}`);
  }
  const r = running(); if (r.length) { console.log('Running mirrors:'); for (const j of r) console.log(`  ${j.name}  ${j.url}  (${j.source})`); }
}

function xenv(d) {
  const e = { ...process.env, DISPLAY: d };
  const xa = { ':97': '/var/lib/capability-fabric/pcg/wechat/Xauthority', ':10': path.join(os.homedir(), '.Xauthority') }[d];
  if (xa && fs.existsSync(xa)) e.XAUTHORITY = xa; else delete e.XAUTHORITY;
  return e;
}

function freePort(start = 6100) {
  const used = new Set(running().map(j => j.port));
  return new Promise(res => {
    const tryP = p => { if (used.has(p)) return tryP(p + 1); const s = http.createServer(); s.once('error', () => tryP(p + 1)); s.listen(p, '127.0.0.1', () => s.close(() => res(p))); };
    tryP(start);
  });
}

async function start(o) {
  const name = o._[1]; if (!name || !/^[\w.-]{1,40}$/.test(name)) usage(2);
  if (!o.cdp && !o.x11) usage(2);
  const old = running().find(j => j.name === name); if (old) { console.log(JSON.stringify({ ok: true, already_running: true, ...old })); return; }
  const port = o.port ? +o.port : await freePort();
  const a = [process.argv[1], 'serve', name, '--port', String(port), '--interval', String(o.interval || 'auto')];
  if (o.cdp) a.push('--cdp', o.cdp); if (o.x11) a.push('--x11', o.x11); if (o.match) a.push('--match', o.match); if (o['no-fit']) a.push('--no-fit');
  const log = fs.openSync(path.join(STATE, `${name}.log`), 'a', 0o600);
  const ch = spawn(process.execPath, a, { detached: true, stdio: ['ignore', log, log] }); ch.unref();
  const url = `http://127.0.0.1:${port}/`;
  for (let i = 0; i < 40; i++) { await new Promise(r => setTimeout(r, 250)); try { const r = await fetch(url + 'health'); if (r.ok) break; } catch {} }
  let ok = false; try { ok = (await fetch(url + 'health')).ok; } catch {}
  const info = { name, pid: ch.pid, port, url, source: o.cdp ? `cdp:${o.cdp}` : `x11:${o.x11}`, interval_s: o.interval ? +o.interval : 'auto (0.05-0.2)', started: new Date().toISOString() };
  if (!ok) { console.log(JSON.stringify({ ok: false, error: 'mirror did not start', log: path.join(STATE, `${name}.log`) })); process.exit(1); }
  fs.writeFileSync(pidFile(name), JSON.stringify(info), { mode: 0o600 });
  let opened = false;
  if (o.open) { try { const b = spawn(fs.existsSync('/usr/bin/chromium-browser') ? '/usr/bin/chromium-browser' : 'xdg-open', fs.existsSync('/usr/bin/chromium-browser') ? ['--new-window', url] : [url], { detached: true, stdio: 'ignore', env: xenv(XRDP_DISPLAY) }); b.unref(); opened = true; } catch {} }
  console.log(JSON.stringify({ ok: true, ...info, opened_on_desktop: opened ? XRDP_DISPLAY : false }));
}

function stop(o) {
  const n = o._[1]; if (!n) usage(2); let c = 0;
  for (const j of running()) if (n === 'all' || j.name === n) { try { process.kill(j.pid, 'SIGTERM'); c++; } catch {} try { fs.unlinkSync(pidFile(j.name)); } catch {} }
  console.log(JSON.stringify({ ok: true, stopped: c }));
}

// ---------------- server ----------------
const PAGE = (title, interval) => `<!doctype html><html><head><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1">
<title>${title} mirror</title><style>html,body{margin:0;height:100%;background:#1e1e1e;overflow:hidden}
#i{display:block;width:100%;height:100%;object-fit:contain;object-position:left top;outline:none;user-select:none;-webkit-user-drag:none}
#b{position:fixed;right:6px;bottom:6px;font:12px sans-serif;color:#aaa;background:#0008;padding:2px 6px;border-radius:4px}
#t{position:fixed;left:-1000px;top:0;opacity:0}</style></head><body>
<img id=i tabindex=0 alt="">
<textarea id=t autocomplete=off></textarea><div id=b>${title} · <span id=s>…</span></div>
<script>
const I=document.getElementById('i'),T=document.getElementById('t'),S=document.getElementById('s');let iv=${interval}*1000,busy=0,last=0,mv=0;
function P(u,b){return fetch(u,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(b||{})}).then(r=>r.json()).catch(()=>({}))}
function xy(e){const r=I.getBoundingClientRect(),nw=I.naturalWidth||r.width,nh=I.naturalHeight||r.height,s=Math.min(r.width/nw,r.height/nh);return{x:Math.round((e.clientX-r.left)/s),y:Math.round((e.clientY-r.top)/s)}}
let fr=0;function live(){I.src='/stream.mjpg?'+Date.now()}
I.onerror=()=>{S.textContent='reconnecting';setTimeout(live,1000)};I.onload=()=>{fr++};
function info(){fetch('/info').then(r=>r.json()).then(j=>{S.textContent='live '+j.interval_s+'s · '+j.quality+(j.auto?' · auto':'')+' · cpu '+j.cpu_pct+'%'}).catch(()=>{})}
setInterval(info,3000);info();live();
function soon(){}
function fit(){P('/fit',{w:Math.round(innerWidth),h:Math.round(innerHeight)}).then(soon)}
addEventListener('resize',()=>{clearTimeout(window._f);window._f=setTimeout(fit,400)});fit();
const mods=e=>({alt:e.altKey,ctrl:e.ctrlKey,meta:e.metaKey,shift:e.shiftKey});
I.addEventListener('mousemove',e=>{const n=Date.now();if(n-mv<120)return;mv=n;const p=xy(e);P('/move',p).then(r=>{if(r.cursor)I.style.cursor=r.cursor})});
I.addEventListener('mousedown',e=>{e.preventDefault();I.focus();P('/down',{...xy(e),button:e.button,...mods(e)})});
I.addEventListener('mouseup',e=>{e.preventDefault();P('/up',{...xy(e),button:e.button,...mods(e)}).then(soon)});
I.addEventListener('dblclick',e=>{e.preventDefault();P('/dbl',{...xy(e)}).then(soon)});
I.addEventListener('contextmenu',e=>e.preventDefault());
I.addEventListener('wheel',e=>{e.preventDefault();P('/wheel',{...xy(e),dx:e.deltaX,dy:e.deltaY}).then(soon)},{passive:false});
I.addEventListener('touchstart',()=>T.focus(),{passive:true});
function key(e){if(e.isComposing)return;const sp=e.key.length>1||e.ctrlKey||e.metaKey||e.altKey;if(!sp)return;e.preventDefault();P('/key',{key:e.key,code:e.code,...mods(e)}).then(soon)}
I.addEventListener('keydown',key);T.addEventListener('keydown',key);
document.addEventListener('paste',e=>{const s=e.clipboardData.getData('text');if(s){e.preventDefault();P('/type',{s}).then(soon)}});
T.addEventListener('input',()=>{const s=T.value;T.value='';if(s)P('/type',{s}).then(soon)});
I.addEventListener('keypress',e=>{if(e.ctrlKey||e.metaKey||e.altKey)return;e.preventDefault();P('/type',{s:e.key}).then(soon)});
I.focus();
</script></body></html>`;

// --- CDP backend ---
class CDP {
  constructor(port, match, fit) { this.port = port; this.match = match; this.fitOn = fit; this.id = 0; this.cb = new Map(); this.ws = null; this.fitted = false; }
  async connect() {
    if (this.ws && this.ws.readyState === 1) return;
    const l = await getJSON(`http://127.0.0.1:${this.port}/json/list`);
    const pages = l.filter(t => t.type === 'page' && !t.url.startsWith('devtools://'));
    const t = (this.match && pages.find(p => (p.url + ' ' + p.title).toLowerCase().includes(this.match.toLowerCase()))) || pages[0];
    if (!t) throw new Error('no page target');
    this.title = t.title;
    await new Promise((res, rej) => {
      const ws = new WebSocket(t.webSocketDebuggerUrl);
      ws.onopen = () => { this.ws = ws; res(); };
      ws.onerror = e => rej(new Error('ws error'));
      ws.onclose = () => { if (this.ws === ws) { this.ws = null; if (this.restream) setTimeout(() => this.restream?.(), 1000); } for (const [, c] of this.cb) c.rej(new Error('closed')); this.cb.clear(); };
      ws.onmessage = m => { const j = JSON.parse(m.data); if (j.method === 'Page.screencastFrame') { this.lastFrameAt = Date.now(); this.onFrame?.(j.params); return; } const c = this.cb.get(j.id); if (c) { this.cb.delete(j.id); j.error ? c.rej(new Error(j.error.message)) : c.res(j.result); } };
    });
  }
  async send(method, params = {}) {
    await this.connect();
    const id = ++this.id;
    return new Promise((res, rej) => { this.cb.set(id, { res, rej }); this.ws.send(JSON.stringify({ id, method, params })); setTimeout(() => { if (this.cb.delete(id)) rej(new Error('timeout ' + method)); }, 8000); });
  }
  async shot() { const r = await this.send('Page.captureScreenshot', { format: 'jpeg', quality: [85, 70, 55][this.level ?? 1] }); return Buffer.from(r.data, 'base64'); }
  startStream(cb) {
    let on = true; this.onFrame = m => { if (!on) return; cb(Buffer.from(m.data, 'base64')); const ack = () => this.ws?.send(JSON.stringify({ id: ++this.id, method: 'Page.screencastFrameAck', params: { sessionId: m.sessionId } })); setTimeout(ack, Math.max(0, (this.ackDelay || 50) - 20)); };
    const go = async () => { try { await this.send('Page.startScreencast', { format: 'jpeg', quality: [85, 70, 55][this.level ?? 1] }); cb(await this.shot()); } catch { if (on) setTimeout(go, 1000); } };
    this.restream = go; go();
    // keep a frame flowing even if the page is static (screencast only sends on change)
    const t = setInterval(async () => { if (on && this.idle()) try { cb(await this.shot()); } catch {} }, 3000);
    return () => { on = false; clearInterval(t); this.restream = null; this.send('Page.stopScreencast').catch(() => {}); };
  }
  idle() { return Date.now() - (this.lastFrameAt || 0) > 2500; }
  async fit(w, h) {
    if (!this.fitOn || !(w > 200 && h > 200)) return;
    this.fitted = true;
    await this.send('Emulation.setDeviceMetricsOverride', { width: Math.min(w, 2560), height: Math.min(h, 1600), deviceScaleFactor: 1, mobile: w < 600 });
  }
  async unfit() { if (this.fitted) try { await this.send('Emulation.clearDeviceMetricsOverride'); } catch {} }
  async cursor(x, y) {
    const r = await this.send('Runtime.evaluate', { returnByValue: true, expression:
      `(()=>{let e=document.elementFromPoint(${x},${y});while(e&&e.shadowRoot){const i=e.shadowRoot.elementFromPoint(${x},${y});if(!i||i===e)break;e=i}let c='default';for(let n=e;n&&n.nodeType===1;n=n.parentElement||n.getRootNode().host){const s=getComputedStyle(n).cursor;if(s&&s!=='auto'){c=s;break}if(n.matches('a[href],button,[role=button],[onclick],label,select,summary')){c='pointer';break}if(n.matches('input:not([type=button]):not([type=submit]):not([type=checkbox]):not([type=radio]),textarea,[contenteditable=""],[contenteditable=true]')){c='text';break}}return c})()` });
    return String(r.result?.value || 'default').split(',').pop().trim();
  }
  btn(b) { return ['left', 'middle', 'right'][b] || 'left'; }
  mod(o) { return (o.alt ? 1 : 0) | (o.ctrl ? 2 : 0) | (o.meta ? 4 : 0) | (o.shift ? 8 : 0); }
  async move(p) { await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y }); return { cursor: await this.cursor(p.x, p.y) }; }
  async down(p) { await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: this.btn(p.button), clickCount: 1, modifiers: this.mod(p) }); }
  async up(p) { await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: this.btn(p.button), clickCount: 1, modifiers: this.mod(p) }); }
  async dbl(p) { for (const type of ['mousePressed', 'mouseReleased']) await this.send('Input.dispatchMouseEvent', { type, x: p.x, y: p.y, button: 'left', clickCount: 2 }); }
  async wheel(p) { await this.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: p.x, y: p.y, deltaX: p.dx || 0, deltaY: p.dy || 0 }); }
  async type(s) { await this.send('Input.insertText', { text: s }); }
  async key(k) {
    const V = { Enter: 13, Backspace: 8, Tab: 9, Escape: 27, Delete: 46, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Home: 36, End: 35, PageUp: 33, PageDown: 34 };
    const vk = V[k.key] || (k.key.length === 1 ? k.key.toUpperCase().charCodeAt(0) : 0);
    const base = { key: k.key, code: k.code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers: this.mod(k) };
    const text = k.key === 'Enter' ? '\r' : undefined;
    await this.send('Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', ...base, ...(text ? { text, unmodifiedText: text } : {}) });
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
  }
}

// --- X11 backend ---
class X11 {
  constructor(d) { this.d = d; this.env = xenv(d); this.restartOnRate = true; }
  xdo(...a) { return new Promise(r => { const p = spawn('xdotool', a, { env: this.env, stdio: 'ignore' }); p.on('close', r); p.on('error', r); }); }
  shot() {
    return new Promise((res, rej) => {
      const p = spawn('ffmpeg', ['-loglevel', 'error', '-f', 'x11grab', '-draw_mouse', '1', '-i', this.d, '-frames:v', '1', '-q:v', '5', '-f', 'image2', '-vcodec', 'mjpeg', '-'], { env: this.env });
      const ch = []; p.stdout.on('data', c => ch.push(c)); p.on('close', c => c === 0 ? res(Buffer.concat(ch)) : rej(new Error('ffmpeg ' + c))); p.on('error', rej);
    });
  }
  async fit() {}
  async unfit() {}
  startStream(cb, fps) {
    const p = spawn('ffmpeg', ['-loglevel', 'error', '-f', 'x11grab', '-draw_mouse', '1', '-framerate', String(fps), '-i', this.d, '-q:v', String([3, 5, 8][this.level ?? 1]), '-f', 'image2pipe', '-vcodec', 'mjpeg', '-'], { env: this.env, stdio: ['ignore', 'pipe', 'ignore'] });
    let buf = Buffer.alloc(0);
    p.stdout.on('data', c => {
      buf = Buffer.concat([buf, c]);
      for (;;) { const s = buf.indexOf(Buffer.from([0xff, 0xd8])); if (s < 0) { buf = Buffer.alloc(0); break; }
        const e = buf.indexOf(Buffer.from([0xff, 0xd9]), s + 2); if (e < 0) { if (s) buf = buf.subarray(s); break; }
        cb(Buffer.from(buf.subarray(s, e + 2))); buf = buf.subarray(e + 2); }
    });
    return () => p.kill('SIGTERM');
  }
  btn(b) { return String({ 0: 1, 1: 2, 2: 3 }[b] || 1); }
  mods(o) { return [o.ctrl && 'ctrl', o.alt && 'alt', o.shift && 'shift', o.meta && 'super'].filter(Boolean); }
  async move(p) { await this.xdo('mousemove', String(p.x), String(p.y)); return { cursor: 'none' }; } // real cursor is drawn in the image
  async down(p) { const m = this.mods(p); for (const k of m) await this.xdo('keydown', k); await this.xdo('mousemove', String(p.x), String(p.y), 'mousedown', this.btn(p.button)); this._m = m; }
  async up(p) { await this.xdo('mousemove', String(p.x), String(p.y), 'mouseup', this.btn(p.button)); for (const k of this._m || []) await this.xdo('keyup', k); this._m = []; }
  async dbl(p) { await this.xdo('mousemove', String(p.x), String(p.y), 'click', '--repeat', '2', '1'); }
  async wheel(p) { const n = Math.min(10, Math.max(1, Math.round(Math.abs(p.dy || p.dx) / 60))); await this.xdo('mousemove', String(p.x), String(p.y), 'click', '--repeat', String(n), p.dy ? (p.dy > 0 ? '5' : '4') : (p.dx > 0 ? '7' : '6')); }
  async type(s) { await this.xdo('type', '--delay', '20', '--', s); }
  async key(k) {
    const M = { Enter: 'Return', Backspace: 'BackSpace', Escape: 'Escape', ArrowLeft: 'Left', ArrowRight: 'Right', ArrowUp: 'Up', ArrowDown: 'Down', PageUp: 'Prior', PageDown: 'Next' };
    let n = M[k.key] || (k.key.length === 1 ? k.key.toLowerCase() : k.key);
    if (['Control', 'Shift', 'Alt', 'Meta'].includes(k.key)) return;
    await this.xdo('key', [...this.mods(k), n].join('+'));
  }
}

// one shared live stream (multipart MJPEG), source runs only while a viewer is connected
class Stream {
  constructor(be, interval) { this.be = be; this.ms = interval * 1000; this.clients = new Set(); this.last = 0; this.pending = null; this.timer = null; }
  add(res) {
    res.writeHead(200, { 'content-type': 'multipart/x-mixed-replace; boundary=cfmframe', 'cache-control': 'no-store', connection: 'close' });
    this.clients.add(res);
    res.on('close', () => { this.clients.delete(res); if (!this.clients.size) this.stopSrc(); });
    if (this.lastFrame) this.write(res, this.lastFrame);
    if (!this.src) this.src = this.be.startStream(f => this.frame(f), Math.max(1, Math.round(1000 / this.ms)));
  }
  write(res, f) { res.write(`--cfmframe\r\nContent-Type: image/jpeg\r\nContent-Length: ${f.length}\r\n\r\n`); res.write(f); res.write('\r\n'); }
  frame(f) { // throttle to interval
    this.pending = f; const now = Date.now(), wait = this.last + this.ms - now;
    if (wait <= 0) this.flush(); else if (!this.timer) this.timer = setTimeout(() => { this.timer = null; this.flush(); }, wait);
  }
  flush() { const f = this.pending; if (!f) return; this.pending = null; this.last = Date.now(); this.lastFrame = f; for (const r of this.clients) this.write(r, f); }
  stopSrc() { if (this.src) { try { this.src(); } catch {} this.src = null; } }
  setRate(sec) { if (Math.abs(sec * 1000 - this.ms) < 1) return; this.ms = sec * 1000; console.log(new Date().toISOString(), 'rate', sec, 'cpu', CPU.pct);
    if (this.src) { this.stopSrc(); this.src = this.be.startStream(f => this.frame(f), Math.round(1000 / this.ms)); }
    this.be.ackDelay = this.ms; }
}

// whole-server CPU use (all programs, not only mirrors), sampled every 3 s
const CPU = { pct: 0, prev: null };
function cpuSample() {
  const a = fs.readFileSync('/proc/stat', 'utf8').split('\n')[0].trim().split(/\s+/).slice(1).map(Number);
  const idle = a[3] + (a[4] || 0), tot = a.reduce((x, y) => x + y, 0);
  if (CPU.prev) { const dt = tot - CPU.prev.tot, di = idle - CPU.prev.idle; if (dt > 0) CPU.pct = Math.round(100 * (1 - di / dt)); }
  CPU.prev = { tot, idle };
}
// auto mode: 0.05 s normally; busy server -> 0.1 s -> 0.2 s; back up only after ~15 s calm
function autoRate(stream) {
  const L = [0.05, 0.1, 0.2]; let i = 0, calm = 0;
  stream.be.level = 0;
  cpuSample();
  setInterval(() => {
    cpuSample();
    if (CPU.pct >= 75 && i < L.length - 1) { i++; calm = 0; stream.be.level = i; stream.setRate(L[i]); }
    else if (CPU.pct < 50 && i > 0) { if (++calm >= 5) { i--; calm = 0; stream.be.level = i; stream.setRate(L[i]); } }
    else calm = 0;
  }, 3000);
}

async function serve(o) {
  const name = o._[1], auto = !o.interval || o.interval === 'auto';
  const interval = auto ? 0.05 : Math.max(0.05, +o.interval);
  const be = o.cdp ? new CDP(+o.cdp, o.match, !o['no-fit']) : new X11(o.x11);
  const stream = new Stream(be, interval);
  if (auto) autoRate(stream);
  const quit = async () => { stream.stopSrc(); await be.unfit(); process.exit(0); };
  process.on('SIGTERM', quit); process.on('SIGINT', quit);
  http.createServer(async (req, res) => {
    const out = (code, body, ct = 'application/json') => { res.writeHead(code, { 'content-type': ct, 'cache-control': 'no-store' }); res.end(body); };
    try {
      const u = req.url.split('?')[0];
      if (req.method === 'GET' && u === '/health') return out(200, '{"ok":true}');
      if (req.method === 'GET' && u === '/info') return out(200, JSON.stringify({ interval_s: stream.ms / 1000, auto, cpu_pct: CPU.pct, quality: ['high', 'medium', 'low'][be.level ?? 1] }));
      if (req.method === 'GET' && u === '/shot.jpg') return out(200, await be.shot(), 'image/jpeg');
      if (req.method === 'GET' && u === '/stream.mjpg') return stream.add(res);
      if (req.method === 'GET' && u === '/') return out(200, PAGE(name.replace(/[<>&"]/g, ''), interval), 'text/html; charset=utf-8');
      if (req.method !== 'POST') return out(404, '{}');
      let b = ''; for await (const c of req) b += c; const p = b ? JSON.parse(b) : {};
      const f = { '/move': () => be.move(p), '/down': () => be.down(p), '/up': () => be.up(p), '/dbl': () => be.dbl(p), '/wheel': () => be.wheel(p), '/type': () => be.type(String(p.s || '')), '/key': () => be.key(p), '/fit': () => be.fit(p.w, p.h) }[u];
      if (!f) return out(404, '{}');
      const r = await f(); out(200, JSON.stringify({ ok: true, ...(r || {}) }));
    } catch (e) { out(500, JSON.stringify({ ok: false, error: String(e.message || e) })); }
  }).listen(+o.port, '127.0.0.1', () => console.log(`serving ${name} on 127.0.0.1:${o.port}`));
}

const o = args(process.argv.slice(2));
const cmd = o._[0];
if (cmd === 'list') await list();
else if (cmd === 'start') await start(o);
else if (cmd === 'serve') await serve(o);
else if (cmd === 'stop') stop(o);
else if (cmd === 'status') console.log(JSON.stringify(running(), null, 1));
else usage(cmd ? 2 : 0);
