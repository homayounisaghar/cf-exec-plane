import test from 'node:test';
import assert from 'node:assert/strict';
import {catalogCounts,catalogList,inputSchemaFor} from './dexa_catalog_registry.mjs';
import {ownerCatalogSnapshot,buildGeneralCapabilitySelectionPrompt}
 from './dexa_general_catalog_planner_v1.mjs';

test('owner snapshot stays consistent with live Kata card count after a tool is retired',()=>{
 const counts=catalogCounts();
 const snapshot=ownerCatalogSnapshot();
 assert.equal(counts.catalog,291);
 assert.equal(counts.cfMapped,187);
 assert.equal(counts.internalCapabilities,1);
 assert.equal(snapshot.length,counts.catalog+counts.internalCapabilities);
 assert.equal(snapshot.length,catalogList({oauthConnected:false}).length);
 assert.equal(new Set(snapshot.map(x=>x.id)).size,snapshot.length);
 assert.equal(snapshot.filter(x=>x.physicalRoute?.startsWith('CF.')).length,counts.cfMapped);
 assert.equal(snapshot.filter(x=>x.id==='tool.cf.audio_transcribe').length,1);
 assert.equal(snapshot.some(x=>x.id==='tool.cf.telegram_transcribe'),false);
});
test('real discovery input no longer fails before calling model when Kata updates',()=>{
 const r=buildGeneralCapabilitySelectionPrompt({
  goal:'پیام صوتی تلگرام را با یک ابزار مشترک به متن تبدیل کن'});
 assert.ok(r.prompt.includes('291 external capability cards'));
 assert.ok(!r.prompt.includes('all 292 external capability cards'));
 assert.ok(r.allowed.includes('tool.cf.audio_transcribe'));
 assert.ok(!r.allowed.includes('tool.cf.telegram_transcribe'));
 assert.equal(inputSchemaFor('tool.cf.audio_transcribe').properties.files.maxItems,20);
 assert.equal(r.catalogFingerprint.length,64);
});
