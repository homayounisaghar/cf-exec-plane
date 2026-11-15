#!/usr/bin/env node
// Single-file Cloudflare dashboard bundle: the SW is part of worker.mjs.
// Future accounts use this same output unchanged. Add origins to the GitHub
// manifest instead of rebuilding deployments.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const here=path.dirname(fileURLToPath(import.meta.url));
const template=fs.readFileSync(path.join(here,'worker-template.mjs'),'utf8');
const sw=fs.readFileSync(path.join(here,'service-worker.min.js'),'utf8');
const install=fs.readFileSync(path.join(here,'sw-install.min.js'),'utf8');
for(const placeholder of ['__INLINE_SERVICE_WORKER_SOURCE__','__INLINE_SERVICE_WORKER_INSTALL__']){
  if(!template.includes(placeholder))throw Error('Missing placeholder '+placeholder);
}
// Keep the dashboard editor responsive: no multi-kilobyte string literals.
const splitString=src=>'[\n'+(src.match(/[\s\S]{1,110}/g)||[]).map(s=>'  '+JSON.stringify(s)).join(',\n')+'\n].join(\"\")';
const generated=template.replace('__INLINE_SERVICE_WORKER_SOURCE__',splitString(sw))
 .replace('__INLINE_SERVICE_WORKER_INSTALL__',splitString(install));
fs.writeFileSync(path.join(here,'worker.mjs'),generated);
console.log('WORKER_BUNDLE_OK',{bytes:Buffer.byteLength(generated),swBytes:Buffer.byteLength(sw)});
