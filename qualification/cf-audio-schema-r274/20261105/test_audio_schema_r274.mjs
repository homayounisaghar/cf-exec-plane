import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const path = process.env.CF_AUDIO_R274_CANDIDATE;
assert.ok(path, 'CF_AUDIO_R274_CANDIDATE required');
const src = readFileSync(path, 'utf8');
const start = src.indexOf('  server.registerTool("audio_transcribe", {');
const end = src.indexOf('  server.registerTool("telegram_screenshot", {', start);
assert.ok(start >= 0 && end > start, 'audio tool boundaries');
const block = src.slice(start, end);

test('audio_transcribe retains the structured 1-20-file contract', () => {
  assert.match(block, /files:\s*z\.array\(z\.object\(\{/);
  for (const name of ['client_file_id', 'file:', 'upload_id:', 'telegram_message_handle:', 'batch_id:']) {
    assert.ok(block.includes(name), name);
  }
  assert.match(block, /\.min\(1\)\.max\(20\)/);
  assert.doesNotMatch(block, /server\.registerTool\("audio_transcribe_batch"/);
  assert.doesNotMatch(block, /server\.registerTool\("telegram_transcribe"/);
});

test('structured files are not mislabeled as top-level native attachments', () => {
  assert.doesNotMatch(block, /openai\/fileParams/);
  assert.doesNotMatch(block, /_meta:\s*\{\s*"openai\/fileParams":\s*\["files"\]/);
});

test('global regression: fileParams never targets an array of objects', () => {
  const parts = src.split(/(?=  server\.registerTool\(")/);
  for (const part of parts) {
    const tool = part.match(/^  server\.registerTool\("([^"]+)"/)?.[1] ?? 'unknown';
    const annotation = part.match(/"openai\/fileParams"\s*:\s*\[([^\]]*)\]/);
    if (!annotation) continue;
    const params = [...annotation[1].matchAll(/"([^"]+)"/g)].map(m => m[1]);
    for (const param of params) {
      const re = new RegExp('\\b' + param.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*:\\s*z\\.array\\(z\\.object');
      assert.doesNotMatch(part, re, tool + ': ' + param + ' has incompatible fileParams annotation');
    }
  }
});
