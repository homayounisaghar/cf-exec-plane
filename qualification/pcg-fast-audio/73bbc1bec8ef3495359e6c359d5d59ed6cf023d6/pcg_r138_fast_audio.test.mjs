import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {Buffer} from "node:buffer";
import vm from "node:vm";

const source=fs.readFileSync(new URL("./pcg_web_semantic_ops.mjs",import.meta.url),"utf8");
const match=source.match(/  async function acquireTelegramAudioForBatch\(messageRef\)\{([\s\S]*?)\n  \}\n\n  async function audioTranscribeBatch\(req\)\{/);
assert.ok(match,"scoped ASR Telegram acquisition helper is present");
const fn="async function acquireTelegramAudioForBatch(messageRef){"+match[1]+"\n}";

function harness(downloadFn,fallbackFn){
 const observed={staged:[],aborted:0,fastCalls:0,fallbackCalls:0,largeFetches:0};
 const env={
   Buffer,
   pageNow:()=>({page:"private-mock"}),
   webKDownloadAttachment:async(...args)=>{observed.fastCalls++;return downloadFn(...args)},
   materialSendNow:()=>({createMaterialFileWriter:({filename,mimeType,sizeBytes})=>{
     const entry={filename,mimeType,sizeBytes};
     observed.staged.push(entry);
     return {
       append:(bytes,offset)=>{entry.bytes=bytes;entry.offset=offset},
       finalize:()=>({...entry,file_handle:"file:"+("a".repeat(64)),size_bytes:sizeBytes,sha256_hex:"b".repeat(64)}),
       abort:()=>{observed.aborted++},
     };
   }}),
   webKFetchMessage:async()=>{observed.largeFetches++;return {attachments:[{media_kind:"voice",media_type:"audio/ogg",slot:"document"}]};},
   acquireAudioMaterialForAsr:async(...args)=>{observed.fallbackCalls++;return fallbackFn?.(...args)||{file_handle:"file:"+("a".repeat(64)),size_bytes:9000000}},
 };
 return {observed,run:vm.runInNewContext("("+fn+")",env)};
}
const ref={providerRef:"123",mid:27};
test("short voice uses the already-qualified direct attachment and stages exactly its source bytes",async()=>{
 const raw=Buffer.from("fake-private-voice-bytes");
 const {run,observed}=harness(async()=>({
  outcome:"ACHIEVED",provider_state_unchanged:true,
  media_type:"audio/ogg",size_bytes:raw.length,filename:null,data_base64:raw.toString("base64")
 }));
 const x=await run(ref);
 assert.equal(observed.fastCalls,1);
 assert.equal(observed.largeFetches,0);
 assert.equal(observed.fallbackCalls,0);
 assert.equal(observed.staged.length,1);
 assert.deepEqual(Buffer.from(observed.staged[0].bytes),raw);
 assert.equal(observed.staged[0].offset,0);
 assert.equal(observed.staged[0].filename,"voice-27.ogg");
 assert.equal(x.size_bytes,raw.length);
});
test("wrong type never enters ASR",async()=>{
 const {run,observed}=harness(async()=>({
  outcome:"ACHIEVED",provider_state_unchanged:true,
  media_type:"image/jpeg",size_bytes:2,data_base64:"YWE="
 }));
 await assert.rejects(run(ref),e=>e.code==="ASR_BATCH_TELEGRAM_AUDIO_NOT_FOUND");
 assert.equal(observed.staged.length,0);
});
test("Telegram read-state reconciliation is mandatory",async()=>{
 const {run,observed}=harness(async()=>({
  outcome:"IN_DOUBT",provider_state_unchanged:false,
  media_type:"audio/ogg",size_bytes:2,data_base64:"YWE="
 }));
 await assert.rejects(run(ref),e=>e.code==="ASR_TELEGRAM_SOURCE_STATE_IN_DOUBT");
 assert.equal(observed.staged.length,0);
});
test("corrupt bytes are not admitted to ASR",async()=>{
 const {run,observed}=harness(async()=>({
  outcome:"ACHIEVED",provider_state_unchanged:true,
  media_type:"audio/ogg",size_bytes:13,data_base64:"YWE="
 }));
 await assert.rejects(run(ref),e=>e.code==="ASR_BATCH_SOURCE_BYTES_INVALID");
 assert.equal(observed.staged.length,0);
});
test("oversize files use existing proven chunked acquisition only",async()=>{
 const {run,observed}=harness(async()=>{
  const e=Error("WEBK_DOWNLOAD_SIZE_OUT_OF_BOUNDS");
  e.code="WEBK_DOWNLOAD_SIZE_OUT_OF_BOUNDS";
  throw e;
 });
 const x=await run(ref);
 assert.equal(observed.fastCalls,1);
 assert.equal(observed.largeFetches,1);
 assert.equal(observed.fallbackCalls,1);
 assert.equal(observed.staged.length,0);
 assert.equal(x.size_bytes,9000000);
});
test("a browser timeout is returned, never silently treated as an oversize source",async()=>{
 const {run,observed}=harness(async()=>{
  const e=Error("WEB_PROVIDER_EVALUATE_TIMEOUT");
  e.code="WEB_PROVIDER_EVALUATE_TIMEOUT";
  throw e;
 });
 await assert.rejects(run(ref),e=>e.code==="WEB_PROVIDER_EVALUATE_TIMEOUT");
 assert.equal(observed.largeFetches,0);
 assert.equal(observed.staged.length,0);
});
