import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {captureDualMemory,dualMemoryForPrompt} from './dexa_dual_memory_v1.mjs';
const scope='a'.repeat(64);
const ctx=(seq)=>({schema:'dexa.previous-user-message.v1',scopeHash:scope,sequence:seq});
const make=(reply,state='SUCCEEDED_VERIFIED')=>({
 id:randomUUID(),text:'لیست چتهای اخیر ویچت را بده',displayedReplyExact:reply,context:ctx(1),state
});
test('all ten latest displayed chat names survive bounded note extraction',()=>{
 const response=Array.from({length:10},(_,i)=>'• Chat-'+(i+1)+(i===9?' & LATE':'')).join(String.fromCharCode(10));
 const snap=captureDualMemory({context:ctx(2),missions:[make(response)],windowN:15});
 const summary=dualMemoryForPrompt(snap).exchangeSummaries.at(-1);
 assert.ok(summary.reply.includes('Chat-10 & LATE'));
 assert.equal(summary.status,'SUCCEEDED_VERIFIED');
 assert.ok(summary.replyRefId);
 assert.ok(snap.promptBytes<24*1024);
});
test('nonlist and unverified list do not expand private memory notes',()=>{
 const response=Array.from({length:10},(_,i)=>'• Chat-'+i+'X'.repeat(25)).join(String.fromCharCode(10));
 const failed=captureDualMemory({context:ctx(2),missions:[make(response,'FAILED')]});
 assert.ok(!failed.summaries.at(-1).reply.includes('Chat-9'));
 const plain=captureDualMemory({context:ctx(2),missions:[make('A'.repeat(350))]});
 assert.ok(plain.summaries.at(-1).reply.length<200);
});
test('oversized displayed lists remain bounded and cannot overrun budget',()=>{
 const response=Array.from({length:15},(_,i)=>'• Chat-'+i+'X'.repeat(170)).join(String.fromCharCode(10));
 const snap=captureDualMemory({context:ctx(2),missions:[make(response)]});
 assert.ok(snap.summaries.at(-1).reply.length<200);
 assert.ok(snap.promptBytes<24*1024);
});
