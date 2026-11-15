import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const surface=fs.readFileSync(new URL('./surface.html',import.meta.url),'utf8');
const viewer=fs.readFileSync(new URL('./viewer.html',import.meta.url),'utf8');

test('fine desktop mouse pointer appears without changing touch-only behavior',()=>{
  assert.match(surface,/#stage\{[^\n]*cursor:none\}/);
  assert.match(surface,/@media \(any-hover: hover\) and \(any-pointer: fine\) \{ #stage \{ cursor: default; \} \}/);
  assert.match(surface,/function onPointerMove\(e\)/);
  assert.match(surface,/pointToSource\(e\.clientX,e\.clientY,true\)/);
});

test('running mirroring sessions get the cursor fix on iframe load, without backend restart',()=>{
  const match=viewer.match(/<script id="cfm-desktop-pointer-20261116">([\s\S]*?)<\/script>/);
  assert.ok(match,'live same-origin iframe compatibility shim absent');
  assert.doesNotThrow(()=>new Function(match[1]));
  assert.match(match[1],/iframe\.addEventListener\('load',applyDesktopPointer\)/);
  assert.match(match[1],/window\.matchMedia\('\(any-hover: hover\) and \(any-pointer: fine\)'\)/);
  assert.match(match[1],/stage\{cursor:default !important\}/);
  assert.match(match[1],/iframe\.contentDocument/);
});
