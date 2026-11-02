import test from 'node:test';
import assert from 'node:assert/strict';
import {ownerCatalogSnapshot,compatibleMessageReadAlternatives as complete}
 from './dexa_general_catalog_planner_v1.mjs';
import {prepareFastGeneralPlan as prepare}
 from './dexa_general_plan_cycle_v2.mjs';
const ids=ownerCatalogSnapshot().map(x=>x.id);
const search='tool.cf.wechat_message_search';
const reader='tool.cf.wechat_message_list';
const conversation='tool.cf.wechat_conversation_list';
test('catalog documented reader accompanies same-provider message search',()=>{
 assert.deepEqual(complete({selected:[search,conversation],allowed:ids}),[reader]);
 const p=prepare({goal:'What did the person say in this observed chat?',
  kataCapabilityIds:[search,conversation]});
 assert.ok(p.allowed.includes(reader));
 assert.ok(p.allowed.includes(conversation));
 assert.ok(p.prompt.length<145000);
});
test('no message search means no invented read operation',()=>{
 assert.deepEqual(complete({selected:[conversation],allowed:ids}),[]);
});
test('nonavailable reader stays excluded',()=>{
 assert.deepEqual(complete({selected:[search],allowed:ids.filter(x=>x!==reader)}),[]);
});
test('already selected reader not repeated',()=>{
 assert.deepEqual(complete({selected:[search,reader],allowed:ids}),[]);
});
