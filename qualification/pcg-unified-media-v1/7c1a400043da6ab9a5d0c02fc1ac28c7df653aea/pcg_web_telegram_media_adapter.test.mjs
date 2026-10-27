import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { createTelegramMediaAdapter } from "./pcg_web_telegram_media_adapter.mjs";
import { createUnifiedMediaAcquirer } from "./pcg_unified_media_acquisition.mjs";
const sha = b => createHash("sha256").update(b).digest("hex");
const handle = "tgmsg:11111111-2222-3333-4444-555555555555";
const ref = {provider:"telegram",handle};
const identity = {providerMessageRefForHandle:h=> h===handle?{providerRef:"known-peer",mid:12}:null};
function fixture(bytes,{large=false,unchanged=true,media_type="video/mp4",failRead=false}={}){
 let prepared=0,finished=0,aborted=0,direct=0,reads=[],chunks=[],committed=0;
 const webk={
  async download(){direct++;if(large)throw Object.assign(Error("large"),{code:"WEBK_DOWNLOAD_SIZE_OUT_OF_BOUNDS"});
   return {outcome:unchanged?"ACHIEVED":"IN_DOUBT",provider_state_unchanged:unchanged,
    data_base64:bytes.toString("base64"),size_bytes:bytes.length,
    media_type,filename:"sample.mp4"};},
  async fetchMessage(){return {attachments:[{slot:"document",media_type,filename:"sample.mp4"}]};},
  async prepareLarge(){prepared++;return {token:"f".repeat(32),size_bytes:bytes.length,filename:"sample.mp4",media_type};},
  async readLarge(_page,_token,offset,requested){
   reads.push([offset,requested]);if(failRead)throw Error("provider lost connection");
   const end=Math.min(bytes.length,offset+requested);
   return {offset:end,size_bytes:end-offset,data_base64:bytes.subarray(offset,end).toString("base64")};},
  async finishLarge(){finished++;return {outcome:unchanged?"ACHIEVED":"IN_DOUBT",provider_state_unchanged:unchanged};},
  async abortLarge(){aborted++;return true;},
 };
 const adapter=createTelegramMediaAdapter({identity,getPage:()=>({}),webk,directLimitBytes:8*1024*1024,maxBytes:32*1024*1024});
 const sink={
   createMaterialFileWriter({sizeBytes}){let off=0;const blocks=[];
    return {
      append(chunk,expected){assert.equal(expected,off);off+=chunk.length;blocks.push(Buffer.from(chunk));chunks.push(chunk.length);},
      finalize(){assert.equal(off,sizeBytes);const all=Buffer.concat(blocks);assert.deepEqual(all,bytes);committed++;
        return {file_handle:"pcgfile:"+"a".repeat(64),size_bytes:off,sha256_hex:sha(all)};},
      abort(){aborted++;}
    };
   }
 };
 const acq=createUnifiedMediaAcquirer({adapters:{telegram:adapter},...sink,
   limits:{directLimitBytes:8*1024*1024,chunkBytes:4*1024*1024,maxBytes:32*1024*1024,maxChunks:128,maxElapsedMs:30000}});
 const acquire=()=>acq.acquire({source_ref:ref,owner_context:{owner:"authorized"},authorization_context:{purpose:"TRANSCRIPTION_ONLY"}});
 return {acquire,stats:()=>({prepared,finished,aborted,direct,reads,chunks,committed})};
}
test("exact small Telegram video is staged using the one common material writer",async()=>{
 const buf=Buffer.alloc(7,0x88), f=fixture(buf);
 const out=await f.acquire();
 assert.equal(out.media_type,"video/mp4");
 assert.equal(out.sha256_hex,sha(buf));
 assert.deepEqual(f.stats().chunks,[7]);
 assert.equal(f.stats().finished,0);
});
test("large Telegram document uses ranged WebK under same material result",async()=>{
 const buf=Buffer.alloc(9*1024*1024+22,0x13),f=fixture(buf,{large:true});
 const out=await f.acquire();
 assert.equal(out.size_bytes,9*1024*1024+22);
 assert.equal(out.sha256_hex,sha(buf));
 assert.deepEqual(f.stats().chunks,[4*1024*1024,4*1024*1024,1024*1024+22]);
 assert.equal(f.stats().prepared,1);
 assert.equal(f.stats().finished,1);
 assert.equal(f.stats().aborted,0);
});
test("large read disconnection aborts only partial material, never commits",async()=>{
 const f=fixture(Buffer.alloc(9*1024*1024),{large:true,failRead:true});
 await assert.rejects(f.acquire(),/provider lost connection/);
 assert.equal(f.stats().committed,0);
 assert.ok(f.stats().aborted>=2);
});
test("provider read/view state in doubt is terminal and material aborts",async()=>{
 for (const large of [false,true]) {
  const f=fixture(Buffer.alloc(large?9*1024*1024+20:6),{large,unchanged:false});
  await assert.rejects(f.acquire(),{code:"MEDIA_SOURCE_STATE_IN_DOUBT"});
  assert.equal(f.stats().committed,0);
 }
});
test("provider-independent content and exact identity required",async()=>{
 const a=createTelegramMediaAdapter({identity,getPage:()=>({}),webk:{
   download:async()=>({}),fetchMessage:async()=>({}),prepareLarge:async()=>({}),
   readLarge:async()=>({}),finishLarge:async()=>({}),abortLarge:async()=>({}),
 }});
 await assert.rejects(a.resolve({source_ref:{handle:"https://x"},owner_context:{},authorization_context:{}}),
   {code:"MEDIA_TELEGRAM_HANDLE_INVALID"});
});
