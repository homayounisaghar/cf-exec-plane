import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {parseFrameExtents,parseX11Geometry,parseWindowClass,frameRegion} from './x11-window-geometry.mjs';
const root=new URL('./',import.meta.url);
const controller=readFileSync(new URL('cf-mirror-universal.mjs',root),'utf8');
const engine=readFileSync(new URL('runtime.mjs',root),'utf8');
const adapter=readFileSync(new URL('cf-mirror-mcp-tools.mjs',root),'utf8');

test('Xfwm4 EWMH outer frame extents are parsed in left,right,top,bottom order',()=>{
 const e=parseFrameExtents('_NET_FRAME_EXTENTS(CARDINAL) = 5, 5, 29, 5');
 assert.deepEqual(e,{left:5,right:5,top:29,bottom:5});
 assert.equal(parseFrameExtents('_NET_FRAME_EXTENTS: not found.'),null);
 assert.equal(parseFrameExtents('_NET_FRAME_EXTENTS(CARDINAL) = 5, 5, 9999, 5'),null);
});

test('terminal client 818x483 expands to complete decorated frame at 311,1280',()=>{
 const client=parseX11Geometry('WINDOW=50362571\nX=316\nY=1309\nWIDTH=818\nHEIGHT=483\nSCREEN=0\n');
 assert.deepEqual(client,{x:316,y:1309,w:818,h:483});
 const rect=frameRegion(client,parseFrameExtents('_NET_FRAME_EXTENTS(CARDINAL) = 5, 5, 29, 5'),1440,2992);
 assert.deepEqual(rect,{x:311,y:1280,w:828,h:518});
});

test('undecorated WeChat Xvfb remains client-sized with even x11grab geometry',()=>{
 assert.deepEqual(frameRegion({x:261,y:167,w:912,h:666},null,1440,1000),
  {x:261,y:167,w:912,h:666});
});

test('offscreen and partial X11 windows clip to the display and retain even dimensions',()=>{
 const r=frameRegion({x:-3,y:-2,w:111,h:83},{left:5,right:5,top:29,bottom:5},1440,1000);
 assert.deepEqual(r,{x:0,y:0,w:114,h:86});
 const right=frameRegion({x:1435,y:990,w:17,h:18},null,1440,1000);
 assert.deepEqual(right,{x:1435,y:990,w:4,h:10});
 assert.throws(()=>frameRegion({x:1600,y:1,w:20,h:20},null,1440,1000),/OFF_SCREEN/);
});

test('X11 WM_CLASS works when a native application lacks a descriptive title',()=>{
 assert.equal(parseWindowClass('WM_CLASS(STRING) = "xfce4-terminal", "Xfce4-terminal"'),'Xfce4-terminal');
 assert.equal(parseWindowClass('WM_CLASS: not found.'),'');
});

test('controller pins exact visible X11 window id and maintains legacy display-only and CDP code paths',()=>{
 assert(controller.includes('window_details:windowDetails.slice(0,80)'));
 assert(controller.includes('source.windowId=pinned.id'));
 assert(controller.includes("args.push('--window-id',String(c.source.windowId))"));
 assert(controller.includes("if(!selectedId)selectedId=pages[0].id"));
 assert(engine.includes("new X11(o.x11, !!o.full, o['window-id']||null)"));
 assert(engine.includes("PINNED_X11_WINDOW_NOT_VISIBLE"));
 assert(engine.includes("if(be.windowId){stream.stopSrc();process.exit(1);}"));
});

test('native connector exposes and forwards the exact window selectors',()=>{
 assert(adapter.includes('window_id:z.number().int().min(1).max(4294967295).optional()'));
 assert(adapter.includes("if(input.window_id)cmd.push('--window-id',String(input.window_id))"));
 assert(adapter.includes("if(input.window)cmd.push('--window',input.window)"));
});
