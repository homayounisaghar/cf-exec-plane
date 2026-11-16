#!/usr/bin/env node
// cf-mirror: standard CF-server "mirroring" tool.
// Shows a hidden browser (Chrome DevTools/CDP port) or an X11 display (WeChat etc.)
// on a local web page with mouse + keyboard, real cursor feedback, size matched
// to the viewer window, default 1 s refresh. Stdlib only (Node >= 22).
import http from 'node:http';
import {acceptWebSocket,rejectUpgrade} from './ws-wire.mjs';
import {Stream,CPU,autoRate} from './stream-manager.mjs';
import {MicBridge} from './mic-bridge.mjs';
import { spawn, execFileSync } from 'node:child_process';
import { parseFrameExtents, parseX11Geometry, parseXwininfoGeometry, frameRegion } from './x11-window-geometry.mjs';
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
  cf-mirror start NAME --x11 :N [--window-id X11_WINDOW_ID]
        [--interval 1] [--port P] [--open] [--no-fit]
  cf-mirror status                       running mirrors + URLs
  cf-mirror stop NAME|all

  --interval  seconds between frames, or auto (default): 0.05 s, slows to 0.1/0.2 s when server CPU is busy
  --open      also open the mirror in the owner's remote desktop (${XRDP_DISPLAY})
  --full      X11: show the whole screen instead of only the app windows
  --no-fit    do not resize the browser viewport to the viewer window (CDP only)
  URL is http://127.0.0.1:PORT/ (local only).`);
  process.exit(code);
}

function args(a) {
  const o = { _: [] };
  for (let i = 0; i < a.length; i++) {
    if (a[i].startsWith('--')) {
      const k = a[i].slice(2);
      if (['open', 'no-fit', 'serve', 'full'].includes(k)) o[k] = true; else o[k] = a[++i];
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
  let xa = { ':97': '/var/lib/capability-fabric/pcg/wechat/Xauthority', ':10': path.join(os.homedir(), '.Xauthority') }[d];
  if (!xa) {
    try {
      const lines = execFileSync('ps', ['-ww', '-eo', 'args'], { encoding: 'utf8', timeout: 1500 }).split('\n');
      const proc = lines.find(line => /\b(?:Xvfb|Xorg|Xwayland)\b/.test(line) && line.split(/\s+/).includes(d));
      xa = proc?.match(/(?:^|\s)-auth\s+(\S+)/)?.[1];
    } catch {}
  }
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
  if (o.cdp) a.push('--cdp', o.cdp); if (o.x11) a.push('--x11', o.x11); if (o['window-id']) a.push('--window-id', o['window-id']); if (o.match) a.push('--match', o.match); if (o['no-fit']) a.push('--no-fit'); if (o.full) a.push('--full');
  const log = fs.openSync(path.join(STATE, `${name}.log`), 'a', 0o600);
  const ch = spawn(process.execPath, a, { detached: true, stdio: ['ignore', log, log] }); ch.unref();
  const url = `http://127.0.0.1:${port}/`;
  for (let i = 0; i < 40; i++) { await new Promise(r => setTimeout(r, 250)); try { const r = await fetch(url + 'health'); if (r.ok) break; } catch {} }
  let ok = false; try { ok = (await fetch(url + 'health')).ok; } catch {}
  const info = { name, pid: ch.pid, port, url, source: o.cdp ? `cdp:${o.cdp}` : `x11:${o.x11}`, interval_s: o.interval ? +o.interval : 'auto (0.05-0.2)', started: new Date().toISOString() };
  if (!ok) { console.log(JSON.stringify({ ok: false, error: 'mirror did not start', log: path.join(STATE, `${name}.log`) })); process.exit(1); }
  fs.writeFileSync(pidFile(name), JSON.stringify(info), { mode: 0o600 });
  let opened = false;
  if (o.open) opened = await openOnDesktop(name, url, o.x11);
  console.log(JSON.stringify({ ok: true, ...info, opened_on_desktop: opened || false }));
}

// open the mirror as an app window (no tabs/address bar) on the owner's desktop,
// sized to the source's real pixel size (1:1, sharpest), capped to the desktop size
async function openOnDesktop(name, url, x11) {
  const env = xenv(XRDP_DISPLAY);
  const dim = d => { try { const m = execFileSync('xdpyinfo', ['-display', d], { encoding: 'utf8', env: xenv(d), stdio: ['ignore', 'pipe', 'ignore'] }).match(/dimensions:\s+(\d+)x(\d+)/); return m ? [+m[1], +m[2]] : null; } catch { return null; } };
  const desk = dim(XRDP_DISPLAY) || [1440, 1000];
  let src = [desk[0], Math.round(desk[0] * 0.7)];
  try { const j = await getJSON(url + 'info'); if (j.region) src = [j.region.w, j.region.h]; } catch {}
  // leave a margin on every side so the window is easy to move/resize; scale up small apps
  const M = 40, maxW = desk[0] - 2 * M, maxH = Math.min(desk[1] - 2 * M - 80, Math.round(desk[0] * 1.2));
  const k = Math.min(maxW / src[0], maxH / src[1], 1); // 1:1 = sharpest (no upscaling)
  const w = Math.round(src[0] * k), h = Math.round(src[1] * k);
  const px = Math.round((desk[0] - w) / 2), py = M + 40;
  const bin = fs.existsSync('/usr/bin/chromium-browser') ? '/usr/bin/chromium-browser' : null;
  try {
    const b = bin ? spawn(bin, [`--app=${url}`, `--window-size=${w},${h}`, `--window-position=${px},${py}`], { detached: true, stdio: 'ignore', env })
                  : spawn('xdg-open', [url], { detached: true, stdio: 'ignore', env });
    b.unref();
  } catch { return false; }
  // the browser may already be running and ignore size flags: fix size/position directly
  for (let i = 0; i < 40; i++) {
    await new Promise(r => setTimeout(r, 250));
    let ids = ''; try { ids = execFileSync('xdotool', ['search', '--name', `^${pretty(name)} mirror`], { encoding: 'utf8', env }).trim(); } catch {}
    if (ids) { for (const id of ids.split('\n')) { try { execFileSync('xdotool', ['windowsize', id, String(w), String(h)], { env }); execFileSync('xdotool', ['windowmove', id, String(px), String(py)], { env }); execFileSync('xdotool', ['windowactivate', id], { env }); } catch {} } return XRDP_DISPLAY; }
  }
  return XRDP_DISPLAY;
}

function stop(o) {
  const n = o._[1]; if (!n) usage(2); let c = 0;
  for (const j of running()) if (n === 'all' || j.name === n) { try { process.kill(j.pid, 'SIGTERM'); c++; } catch {} try { fs.unlinkSync(pidFile(j.name)); } catch {} }
  console.log(JSON.stringify({ ok: true, stopped: c }));
}

// display name for titles: wechat -> WeChat, tg -> Telegram, ...
function pretty(n) {
  const M = { wechat: 'WeChat', wc: 'WeChat', tg: 'Telegram', telegram: 'Telegram', whatsapp: 'WhatsApp', wa: 'WhatsApp', bale: 'Bale', snapp: 'Snapp', alibaba: 'Alibaba', 'alibaba-ir': 'Alibaba.ir', alibabair: 'Alibaba.ir', backblaze: 'Backblaze' };
  return M[n.toLowerCase()] || n.charAt(0).toUpperCase() + n.slice(1);
}

// ---------------- server ----------------
const SURFACE_HTML = fs.readFileSync(new URL('./surface.html', import.meta.url), 'utf8');
const PAGE = title => SURFACE_HTML.replaceAll('__MIRROR_NAME__', title);

// --- CDP backend ---
class CDP {
  constructor(port, match, fit, targetId) { this.port = port; this.match = match; this.fitOn = fit; this.targetId = targetId; this.id = 0; this.cb = new Map(); this.ws = null; this.fitted = false; this.pointer = { x: 640, y: 360 }; this.viewport = {w:1280,h:800}; }
  async connect() {
    if (this.ws && this.ws.readyState === 1) return;
    const l = await getJSON(`http://127.0.0.1:${this.port}/json/list`);
    const pages = l.filter(t => t.type === 'page' && !t.url.startsWith('devtools://'));
    const t = this.targetId ? pages.find(p => p.id === this.targetId) : this.match ? pages.find(p => (p.url + ' ' + p.title).toLowerCase().includes(this.match.toLowerCase())) : pages[0];
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
  async shot() { const r = await this.send('Page.captureScreenshot', { format: 'jpeg', quality: [92, 85, 70][this.level ?? 1] }); return Buffer.from(r.data, 'base64'); }
  startStream(cb) {
    let on = true; this.onFrame = m => { if (!on) return; cb(Buffer.from(m.data, 'base64')); const ack = () => this.ws?.send(JSON.stringify({ id: ++this.id, method: 'Page.screencastFrameAck', params: { sessionId: m.sessionId } })); setTimeout(ack, Math.max(0, (this.ackDelay || 50) - 20)); };
    const go = async () => { try { await this.send('Page.startScreencast', { format: 'jpeg', quality: [92, 85, 70][this.level ?? 1] }); cb(await this.shot()); } catch { if (on) setTimeout(go, 1000); } };
    this.restream = go; go();
    // keep a frame flowing even if the page is static (screencast only sends on change)
    const t = setInterval(async () => { if (on && this.idle()) try { cb(await this.shot()); } catch {} }, 3000);
    return () => { on = false; clearInterval(t); this.restream = null; this.send('Page.stopScreencast').catch(() => {}); };
  }
  idle() { return Date.now() - (this.lastFrameAt || 0) > 2500; }
  async fit(w, h) {
    if (!this.fitOn || !(w > 200 && h > 200)) return;
    this.fitted = true;
    this.viewport = {w:Math.min(w,2560),h:Math.min(h,1600)};
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
  async move(p) { this.pointer = {x:Math.round(p.x),y:Math.round(p.y)}; await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: this.pointer.x, y: this.pointer.y }); return { cursor: await this.cursor(this.pointer.x, this.pointer.y), cursorPos:this.pointer }; }
  async pointerPosition() { return this.pointer; }
  async moveRelative(p) {
    const dx = Math.max(-420,Math.min(420,Number(p.dx)||0)), dy = Math.max(-420,Math.min(420,Number(p.dy)||0));
    const x = Math.max(0,Math.min(this.viewport.w-1,Math.round(this.pointer.x+dx)));
    const y = Math.max(0,Math.min(this.viewport.h-1,Math.round(this.pointer.y+dy)));
    return await this.move({x,y});
  }
  async clickAtPointer(p) {const a={...this.pointer,button:Number(p.button)||0};await this.down(a);await this.up(a);return {cursorPos:this.pointer};}
  async pressAtPointer(p) {await this.down({...this.pointer,button:Number(p.button)||0});return {cursorPos:this.pointer};}
  async releaseAtPointer(p) {await this.up({...this.pointer,button:Number(p.button)||0});return {cursorPos:this.pointer};}
  async doubleAtPointer() {await this.dbl(this.pointer);return {cursorPos:this.pointer};}
  async scrollAtPointer(p) {await this.wheel({...this.pointer,dx:Number(p.dx)||0,dy:Number(p.dy)||0});return {cursorPos:this.pointer};}
  async down(p) { await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: this.btn(p.button), clickCount: 1, modifiers: this.mod(p) }); }
  async up(p) { await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: this.btn(p.button), clickCount: 1, modifiers: this.mod(p) }); }
  async dbl(p) { for (const type of ['mousePressed', 'mouseReleased']) await this.send('Input.dispatchMouseEvent', { type, x: p.x, y: p.y, button: 'left', clickCount: 2 }); }
  async wheel(p) { await this.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: p.x, y: p.y, deltaX: p.dx || 0, deltaY: p.dy || 0 }); }
  async type(s) { await this.send('Input.insertText', { text: s }); }
  async key(k) {
    const V = { PrintScreen:44, F5:116, Enter: 13, Backspace: 8, Tab: 9, Escape: 27, Delete: 46, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Home: 36, End: 35, PageUp: 33, PageDown: 34 };
    const vk = V[k.key] || (k.key.length === 1 ? k.key.toUpperCase().charCodeAt(0) : 0);
    const base = { key: k.key, code: k.code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers: this.mod(k) };
    const text = k.key === 'Enter' ? '\r' : undefined;
    await this.send('Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', ...base, ...(text ? { text, unmodifiedText: text } : {}) });
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
  }
}

// --- X11 backend ---
class X11 {
  constructor(d, full, windowId=null) {
    this.d=d;this.env=xenv(d);this.restartOnRate=true;this.full=full;
    this.windowId=windowId===null?null:String(windowId);
    this.off=[0,0];this.region=this.findRegion();this.readRootPointer();
  }
  // Select the largest visible app window, not the union of every desktop window.
  // Popups layered inside the window remain visible. --full is the explicit desktop mode.
  findRegion() {
    let sw=1440,sh=1000;
    try{
      const m=execFileSync('xdpyinfo',['-display',this.d],{encoding:'utf8',env:this.env,stdio:['ignore','pipe','ignore'],timeout:1200}).match(/dimensions:\s+(\d+)x(\d+)/);
      if(m){sw=+m[1];sh=+m[2];}
    }catch{}
    const fullR={x:0,y:0,w:sw-(sw%2),h:sh-(sh%2)};
    if(this.full)return fullR;
    const visibleIds=[];
    try{
      const stdout=execFileSync('xdotool',['search','--onlyvisible','--name','.'],{encoding:'utf8',env:this.env,timeout:2200,stdio:['ignore','pipe','ignore']});
      visibleIds.push(...stdout.split('\n').filter(id=>/^\d+$/.test(id)).slice(0,80));
      // Some native windows have WM_CLASS but no descriptive title.
      if(this.windowId&&!visibleIds.includes(this.windowId)){
        try{
          const byClass=execFileSync('xdotool',['search','--onlyvisible','--class','.'],{encoding:'utf8',env:this.env,timeout:1200,stdio:['ignore','pipe','ignore']});
          visibleIds.push(...byClass.split('\n').filter(id=>/^\d+$/.test(id)).slice(0,80));
        }catch{}
      }
    }catch{}
    if(this.windowId&&!visibleIds.includes(this.windowId))
      throw Error('PINNED_X11_WINDOW_NOT_VISIBLE: '+this.windowId+' on '+this.d);
    const wins=[];
    for(const id of (this.windowId?[this.windowId]:visibleIds)){
      let title='';
      try{
        title=execFileSync('xdotool',['getwindowname',id],{encoding:'utf8',env:this.env,timeout:550,stdio:['ignore','pipe','ignore']}).trim();
      }catch{}
      if(!this.windowId&&/^(desktop|xfce4-panel|xfwm4|wrapper-2\.0)$/i.test(title))continue;
      let raw='';
      try{
        raw=execFileSync('xdotool',['getwindowgeometry','--shell',id],{encoding:'utf8',env:this.env,timeout:850,stdio:['ignore','pipe','ignore']});
      }catch{}
      const g=parseX11Geometry(raw);
      if(!g)continue;
      const win={id,...g,title};
      if(g.w>=120&&g.h>=100&&g.x<sw&&g.y<sh&&g.x+g.w>0&&g.y+g.h>0)wins.push(win);
    }
    if(!wins.length){
      if(this.windowId)throw Error('PINNED_X11_WINDOW_HAS_NO_VISIBLE_GEOMETRY: '+this.windowId);
      if(this.region)return this.region;
      throw Error('NO_VISIBLE_X11_APPLICATION: launch a GUI app or use --full to mirror desktop');
    }
    // Legacy X11-only selection still chooses the largest visible app window.
    // App/window selector mirrors instead stay pinned to their exact X11 ID.
    if(!this.windowId)wins.sort((a,b)=>b.w*b.h-a.w*a.h);
    const win=wins[0];
    let extents=null;
    try{
      const prop=execFileSync('xprop',['-id',String(win.id),'_NET_FRAME_EXTENTS'],
        {encoding:'utf8',env:this.env,timeout:900,stdio:['ignore','pipe','ignore']});
      extents=parseFrameExtents(prop);
    }catch{}
    // xdotool getwindowgeometry --shell can report coordinates shifted by
    // the frame extents, even though its width/height are client dimensions.
    // xwininfo -id returns true ABSOLUTE CLIENT root coordinates instead.
    // Example Xfwm4: xdotool 316,1309; xwininfo 311,1280;
    // _NET_FRAME_EXTENTS 5,5,29,5 => outer frame at 306,1251.
    let client=null;
    try{
      const exact=execFileSync('xwininfo',['-id',String(win.id)],
        {encoding:'utf8',env:this.env,timeout:900,stdio:['ignore','pipe','ignore']});
      client=parseXwininfoGeometry(exact);
    }catch{}
    if(!client||client.w!==win.w||client.h!==win.h){
      // Fallback for hosts without xwininfo: undo the decoration shift
      // first, then frameRegion subtracts the actual outer frame extents.
      client={...win,x:win.x-(extents?.left||0),y:win.y-(extents?.top||0)};
    }
    // Undecorated WeChat/Xvfb has no extents; its coordinates are unchanged.
    return frameRegion(client,extents,sw,sh);
  }
  P(p) {
    const r=this.region;
    const x=Math.max(r.x,Math.min(r.x+r.w-1,Math.round(Number(p.x||0)+r.x)));
    const y=Math.max(r.y,Math.min(r.y+r.h-1,Math.round(Number(p.y||0)+r.y)));
    this.pointer={x,y};
    return [String(x),String(y)];
  }
  readRootPointer() {
    try{
      const s=execFileSync('xdotool',['getmouselocation','--shell'],{env:this.env,encoding:'utf8',timeout:600,stdio:['ignore','pipe','ignore']});
      const x=Number((s.match(/(?:^|\n)X=(-?\d+)/)||[])[1]),y=Number((s.match(/(?:^|\n)Y=(-?\d+)/)||[])[1]);
      if(Number.isFinite(x)&&Number.isFinite(y))this.pointer={x,y};
    }catch{}
    if(!this.pointer)this.pointer={x:this.region.x+Math.floor(this.region.w/2),y:this.region.y+Math.floor(this.region.h/2)};
    return this.pointer;
  }
  async pointerPosition() {
    const p=this.readRootPointer(),r=this.region;
    return {x:Math.max(0,Math.min(r.w-1,p.x-r.x)),y:Math.max(0,Math.min(r.h-1,p.y-r.y))};
  }
  async moveRelative(p) {
    if(!this.pointer)this.readRootPointer();
    const r=this.region;
    this.fractionX=(this.fractionX||0)+Math.max(-420,Math.min(420,Number(p.dx)||0));
    this.fractionY=(this.fractionY||0)+Math.max(-420,Math.min(420,Number(p.dy)||0));
    const dx=Math.trunc(this.fractionX),dy=Math.trunc(this.fractionY);
    this.fractionX-=dx;this.fractionY-=dy;
    const x=Math.max(r.x,Math.min(r.x+r.w-1,this.pointer.x+dx));
    const y=Math.max(r.y,Math.min(r.y+r.h-1,this.pointer.y+dy));
    this.pointer={x,y};
    if(dx||dy)await this.xdo('mousemove',String(x),String(y));
    return {cursorPos:{x:x-r.x,y:y-r.y}};
  }
  async clickAtPointer(p) {await this.xdo('click',this.btn(p.button));return {cursorPos:await this.pointerPosition()};}
  async pressAtPointer(p) {await this.xdo('mousedown',this.btn(p.button));return {cursorPos:await this.pointerPosition()};}
  async releaseAtPointer(p) {await this.xdo('mouseup',this.btn(p.button));return {cursorPos:await this.pointerPosition()};}
  async doubleAtPointer() {await this.xdo('click','--repeat','2','--delay','80','1');return {cursorPos:await this.pointerPosition()};}
  async scrollAtPointer(p) {
    const dy=Math.max(-600,Math.min(600,Number(p.dy)||0)),dx=Math.max(-600,Math.min(600,Number(p.dx)||0));
    const amt=dy||dx;
    if(Math.abs(amt)<8)return {cursorPos:await this.pointerPosition()};
    const n=Math.min(8,Math.max(1,Math.round(Math.abs(amt)/90)));
    const button=dy?(dy>0?'5':'4'):(dx>0?'7':'6');
    await this.xdo('click','--repeat',String(n),'--delay','18',button);
    return {cursorPos:await this.pointerPosition()};
  }
  xdo(...a) { return new Promise(r => { const p = spawn('xdotool', a, { env: this.env, stdio: 'ignore' }); p.on('close', r); p.on('error', r); }); }
  captureScaleArgs() {
    // Private full-desktop X11 :124 only: emit about half the source pixels.
    // Keep logical desktop dimensions unchanged for mouse/touch coordinates.
    const r=this.region;
    return this.full && this.d===':124' && r.w===1440 && r.h===900
      ? ['-vf','scale=1024:640:flags=bicubic'] : [];
  }
  shot() {
    return new Promise((res, rej) => {
      const r = this.region;
      const p = spawn('ffmpeg', ['-loglevel', 'error', '-f', 'x11grab', '-draw_mouse', '1', '-video_size', `${r.w}x${r.h}`, '-i', `${this.d}+${r.x},${r.y}`, ...this.captureScaleArgs(), '-frames:v', '1', '-q:v', '6', '-f', 'image2', '-vcodec', 'mjpeg', '-'], { env: this.env });
      const ch = []; p.stdout.on('data', c => ch.push(c)); p.on('close', c => c === 0 ? res(Buffer.concat(ch)) : rej(new Error('ffmpeg ' + c))); p.on('error', rej);
    });
  }
  async fit() {}
  async unfit() {}
  startStream(cb, fps) {
    const r = this.region;
    const p = spawn('ffmpeg', ['-loglevel', 'error', '-f', 'x11grab', '-draw_mouse', '1', '-framerate', String(fps), '-video_size', `${r.w}x${r.h}`, '-i', `${this.d}+${r.x},${r.y}`, ...this.captureScaleArgs(), '-q:v', String([2, 3, 5][this.level ?? 1]), '-f', 'image2pipe', '-vcodec', 'mjpeg', '-'], { env: this.env, stdio: ['ignore', 'pipe', 'ignore'] });
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
  async move(p) { await this.xdo('mousemove', ...this.P(p)); return { cursor: 'none', cursorPos:await this.pointerPosition() }; } // X11 frame draws the real cursor
  async down(p) { const m = this.mods(p); for (const k of m) await this.xdo('keydown', k); await this.xdo('mousemove', ...this.P(p), 'mousedown', this.btn(p.button)); this._m = m; }
  async up(p) { await this.xdo('mousemove', ...this.P(p), 'mouseup', this.btn(p.button)); for (const k of this._m || []) await this.xdo('keyup', k); this._m = []; }
  async dbl(p) { await this.xdo('mousemove', ...this.P(p), 'click', '--repeat', '2', '1'); }
  async wheel(p) { const n = Math.min(10, Math.max(1, Math.round(Math.abs(p.dy || p.dx) / 60))); await this.xdo('mousemove', ...this.P(p), 'click', '--repeat', String(n), p.dy ? (p.dy > 0 ? '5' : '4') : (p.dx > 0 ? '7' : '6')); }
  async type(s) {
    const value=String(s||'').slice(0,5000);
    if(!value)return;
    if(!/[^\x00-\x7f]/.test(value))return await this.xdo('type','--delay','14','--',value);
    // XTest cannot reliably inject Persian/Unicode via keysyms. On this same
    // isolated X11 display, put UTF-8 text into CLIPBOARD briefly and paste it.
    // This is only invoked by an authenticated /type action; no transcript is logged.
    const clip=spawn('xclip',['-quiet','-selection','clipboard','-loops','10'],{env:this.env,stdio:['pipe','ignore','ignore']});
    clip.on('error',()=>{});
    clip.stdin.on('error',()=>{});
    clip.stdin.end(value,'utf8');
    await new Promise(resolve=>setTimeout(resolve,120));
    await this.xdo('key','ctrl+v');
    setTimeout(()=>{try{clip.kill('SIGTERM');}catch{}},1300).unref();
  }
  async key(k) {
    const M = { PrintScreen:'Print', F5:'F5', Delete:'Delete', Home:'Home', End:'End', Tab:'Tab', Enter: 'Return', Backspace: 'BackSpace', Escape: 'Escape', ArrowLeft: 'Left', ArrowRight: 'Right', ArrowUp: 'Up', ArrowDown: 'Down', PageUp: 'Prior', PageDown: 'Next' };
    let n = M[k.key] || (k.key.length === 1 ? k.key.toLowerCase() : k.key);
    if (['Control', 'Shift', 'Alt', 'Meta'].includes(k.key)) return;
    await this.xdo('key', [...this.mods(k), n].join('+'));
  }
}

async function serve(o) {
  const name = o._[1], auto = !o.interval || o.interval === 'auto';
  const interval = auto ? 0.1 : Math.max(0.05, +o.interval);
  const be = o.cdp ? new CDP(+o.cdp, o.match, !o['no-fit'], o['target-id']) : new X11(o.x11, !!o.full, o['window-id']||null);
  const stream = new Stream(be, interval);
  const mic=new MicBridge(o.x11?{kind:'x11',display:o.x11}:{kind:'cdp',port:Number(o.cdp)});
  mic.inspect().catch(()=>{});
  if (auto) autoRate(stream);
  if (be.findRegion) setInterval(() => {
    let next;
    try{next=be.findRegion();}
    catch(e){
      console.error('X11_WINDOW_REGION_LOST:',String(e.message||e));
      // Never show content from a different window if the pinned one closes.
      if(be.windowId){stream.stopSrc();process.exit(1);}
      return;
    }
    const current=be.region;
    if(next.x!==current.x||next.y!==current.y||next.w!==current.w||next.h!==current.h){
      be.region=next;
      if(stream.src){stream.stopSrc();stream.src=be.startStream(f=>stream.frame(f),Math.round(1000/stream.ms));}
    }
  },2000);
  const quit = async () => { stream.stopSrc(); mic.shutdown(); await be.unfit(); process.exit(0); };
  process.on('SIGTERM', quit); process.on('SIGINT', quit);
  const server=http.createServer(async (req, res) => {
    const out = (code, body, ct = 'application/json') => { res.writeHead(code, { 'content-type': ct, 'cache-control': 'no-store' }); res.end(body); };
    try {
      const u = req.url.split('?')[0];
      if (req.method === 'GET' && u === '/health') return out(200, '{"ok":true}');
      if (req.method === 'GET' && u === '/info') return out(200, JSON.stringify({ kind:be instanceof CDP?'cdp':'x11', region: be.region || null, cursor: await be.pointerPosition(), interval_s: stream.ms / 1000, auto, cpu_pct: CPU.pct, mem_available_pct:Math.round(CPU.memPct*100),loop_lag_ms:CPU.loopLag,network_dropped_frames:stream.clientDrops,microphone:mic.status(),quality: ['high', 'medium', 'low'][be.level ?? 1] }));
      if (req.method === 'GET' && u === '/shot.jpg') return out(200, await be.shot(), 'image/jpeg');
      if (req.method === 'GET' && u === '/stream.mjpg') return stream.add(res);
      if (req.method === 'GET' && u === '/') return out(200, PAGE(pretty(name).replace(/[<>&"]/g, ''), interval), 'text/html; charset=utf-8');
      if (req.method !== 'POST') return out(404, '{}');
      let b = ''; for await (const c of req) b += c; const p = b ? JSON.parse(b) : {};
      const f = { '/move-rel': () => be.moveRelative(p), '/click-rel':()=>be.clickAtPointer(p), '/double-rel':()=>be.doubleAtPointer(), '/press-rel':()=>be.pressAtPointer(p), '/release-rel':()=>be.releaseAtPointer(p), '/scroll-rel':()=>be.scrollAtPointer(p), '/move': () => be.move(p), '/down': () => be.down(p), '/up': () => be.up(p), '/dbl': () => be.dbl(p), '/wheel': () => be.wheel(p), '/type': () => be.type(String(p.s || '')), '/key': () => be.key(p), '/fit': () => be.fit(p.w, p.h) }[u];
      if (!f) return out(404, '{}');
      const r = await f(); out(200, JSON.stringify({ ok: true, ...(r || {}) }));
    } catch (e) { out(500, JSON.stringify({ ok: false, error: String(e.message || e) })); }
  });
  server.on('upgrade',(req,socket,head)=>{
    if(req.url?.split('?')[0]==='/mic-ws'){
      let client=null;
      client=acceptWebSocket(req,socket,head,{
        protocol:'cfm-mic',maxFrameBytes:128*1024,
        onText:(txt,ws)=>mic.message(txt,ws).catch(()=>mic.send({t:'mic-error',message:'Microphone routing failed'})),
        onBinary:(data)=>mic.pushAudio(data),
        onClose:()=>mic.disconnect(client)
      });
      if(client)mic.attach(client);
      return;
    }
    if(req.url?.split('?')[0]!=='/input-ws'){rejectUpgrade(socket,404);return;}
    let pendingX=0,pendingY=0,lastSeq=0,pumping=false,scheduled=false;
    let ws;
    const schedule=()=>{
      if(scheduled||pumping||!ws?.open)return;
      scheduled=true;
      setImmediate(async()=>{
        scheduled=false;
        if(pumping||!ws?.open)return;
        pumping=true;
        try{
          while(ws.open&&(Math.abs(pendingX)>.01||Math.abs(pendingY)>.01)){
            const dx=Math.max(-420,Math.min(420,pendingX));
            const dy=Math.max(-420,Math.min(420,pendingY));
            const seq=lastSeq;
            pendingX-=dx;pendingY-=dy;
            const r=await be.moveRelative({dx,dy});
            stream.noteInput();
            // Ack after all accumulated deltas have been applied.
            if(Math.abs(pendingX)<.01&&Math.abs(pendingY)<.01)ws.send({t:'ack',s:seq,c:r?.cursorPos||null});
          }
        }catch{ws.send({t:'err',message:'Mouse input unavailable'});}
        finally{pumping=false;if(ws?.open&&(Math.abs(pendingX)>.01||Math.abs(pendingY)>.01))schedule();}
      });
    };
    ws=acceptWebSocket(req,socket,head,{
      onText(txt){
        let j;
        try{j=JSON.parse(txt);}catch{ws.close(1003);return;}
        if(j?.t!=='m'||!Number.isFinite(j.x)||!Number.isFinite(j.y)||!Number.isSafeInteger(j.s)||
           j.s<0||Math.abs(j.x)>420||Math.abs(j.y)>420){ws.close(1008);return;}
        // Every relative delta is accumulated. No motion is discarded.
        pendingX=Math.max(-10000,Math.min(10000,pendingX+j.x));
        pendingY=Math.max(-10000,Math.min(10000,pendingY+j.y));
        lastSeq=Math.max(lastSeq,j.s);
        schedule();
      }
    });
    if(ws)ws.send({t:'ready',interval:stream.ms/1000});
  });
  server.listen(+o.port,'127.0.0.1',()=>console.log('serving '+name+' on 127.0.0.1:'+o.port));
}

const o = args(process.argv.slice(2));
const cmd = o._[0];
if (cmd === 'list') await list();
else if (cmd === 'start') await start(o);
else if (cmd === 'serve') await serve(o);
else if (cmd === 'stop') stop(o);
else if (cmd === 'status') console.log(JSON.stringify(running(), null, 1));
else usage(cmd ? 2 : 0);
