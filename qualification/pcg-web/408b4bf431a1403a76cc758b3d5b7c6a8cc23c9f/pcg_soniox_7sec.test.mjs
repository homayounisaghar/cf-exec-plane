import test from 'node:test';
import assert from 'node:assert/strict';
import {planFixed,runFixed} from './pcg_soniox_fixed_overlap.mjs';
import {mergeWordAligned} from './pcg_soniox_word_align_dp.mjs';

const pcm=secs=>Buffer.alloc(Math.floor(secs*16000)*2);
const ranges=plan=>plan.segments.map(s=>[s.start_seconds,s.end_seconds]);

test('Exact fixed 7-second hop and 3-second overlap',()=>{
 const p=planFixed(pcm(38));
 assert.deepEqual(ranges(p).slice(0,4),[[0,8.5],[5.5,15.5],[12.5,22.5],[19.5,29.5]]);
 assert.equal(p.actual_parts,5);
 assert.ok(p.segments.every(s=>s.duration_seconds>5));
});
test('Short last chunk <=5 seconds is merged into previous',()=>{
 const p=planFixed(pcm(23.5));
 assert.deepEqual(ranges(p),[[0,8.5],[5.5,15.5],[12.5,23.5]]);
 const p2=planFixed(pcm(24.5));
 assert.deepEqual(ranges(p2),[[0,8.5],[5.5,15.5],[12.5,24.5]]);
});
test('389.3535s input makes 56 parts with full coverage',()=>{
 const p=planFixed(pcm(389.3535));
 assert.equal(p.actual_parts,56);
 assert.deepEqual(ranges(p).slice(0,3),[[0,8.5],[5.5,15.5],[12.5,22.5]]);
 assert.deepEqual(ranges(p).at(-1),[383.5,389.3535]);
 assert.ok(p.segments.every((s,i)=>!i||s.start_seconds<=p.segments[i-1].end_seconds));
});
test('An exact one-hour file fits in a single 514-connection batch',()=>{
 const x=planFixed(pcm(3600));
 assert.equal(x.actual_parts,514);
 assert.equal(x.batches,1);
 assert.deepEqual(ranges(x).at(-1),[3589.5,3600]);
});
test('A file longer than one hour uses a second batch after 514',()=>{
 const x=planFixed(pcm(3604));
 assert.equal(x.actual_parts,515);
 assert.equal(x.batches,2);
 assert.equal(x.segments[513].batch,1);
 assert.equal(x.segments[514].batch,2);
});
test('Only one credential and strictly sequential batches for 515 parts',async()=>{
 let credentials=0,active=0,peak=0,finishedFirst=0,prematureSecond=false;
 const result=await runFixed(pcm(3604),{
   maxConcurrent:514,
   getCredential:async()=>{credentials++;return 'test-only-placeholder'},
   transcribeWithKey:async(_key,_chunk,s)=>{
     if(s.batch===2 && finishedFirst<514)prematureSecond=true;
     active++;peak=Math.max(peak,active);
     await new Promise(resolve=>setTimeout(resolve,1));
     active--;
     if(s.batch===1)finishedFirst++;
     return {text:'بخش '+s.index+' نمونه صوت'};
   },
 });
 assert.equal(credentials,1);
 assert.equal(peak,514);
 assert.equal(finishedFirst,514);
 assert.equal(prematureSecond,false);
 assert.equal(result.plan.actual_parts,515);
 assert.equal(result.plan.batches,2);
});
test('Classical DP deduplicates fuzzy overlap without a language model',()=>{
 const parts=[{text:'امروز رفتیم یه جورایی اصلاً به اون مرحله'},{text:'یه جورایی اصلا به اون مرحله‌ای که باید می‌رسیدیم نرسیدیم'}];
 const segments=[{start_seconds:0,end_seconds:8.5,duration_seconds:8.5},{start_seconds:5.5,end_seconds:15.5,duration_seconds:10}];
 const result=mergeWordAligned(parts,segments);
 assert.equal(result.unmatched,0);
 assert.equal(result.seams[0].method,'classical_word_dp');
 assert.equal(result.seams[0].status,'aligned');
 assert.ok(result.text.includes('باید می‌رسیدیم'));
 assert.ok(!result.text.includes('مرحله یه جورایی'));
});
