import test from "node:test";
import assert from "node:assert/strict";
import { acquireTelegramAudioMaterialDirect, DIRECT_TELEGRAM_ASR_MAX_BYTES } from "./pcg_telegram_asr_material.mjs";

const ref = { providerRef: "123456", mid: 42 };
const attachment = { slot: "document", media_kind: "voice", media_type: "audio/ogg" };
const content = Buffer.from("OGG-opus-test");
const direct = {
  outcome: "ACHIEVED",
  provider_state_checked: true,
  provider_state_unchanged: true,
  size_bytes: content.length,
  data_base64: content.toString("base64"),
  filename: "voice.ogg",
  media_type: "audio/ogg",
};
function mock({reply=direct, failAppend=false}={}){
 const calls = { downloads:0, created:0, append:0, abort:0, finalize:0 };
 const deps = {
  page: {}, messageRef:ref, attachment,
  downloadAttachment:async(_page,peerId,mid,slot,bound)=>{
   calls.downloads++;
   assert.equal(peerId,ref.providerRef);
   assert.equal(mid,ref.mid);
   assert.equal(slot,"document");
   assert.equal(bound,DIRECT_TELEGRAM_ASR_MAX_BYTES);
   if(reply instanceof Error)throw reply;
   return reply;
  },
  materialPlane:{createMaterialFileWriter({filename,mimeType,sizeBytes}){
   calls.created++;
   assert.equal(filename,"voice.ogg");
   assert.equal(mimeType,"audio/ogg");
   assert.equal(sizeBytes,content.length);
   return {
    append(data,offset){
     calls.append++;
     assert.deepEqual(data,content);
     assert.equal(offset,0);
     if(failAppend)throw Error("SIMULATED_MATERIAL_WRITE_FAILURE");
    },
    finalize(){calls.finalize++;return{file_handle:"file:"+"a".repeat(64),size_bytes:sizeBytes};},
    abort(){calls.abort++},
   };
  }},
 };
 return{deps,calls};
}
test("Direct Telegram audio gets into the same private material plane",async()=>{
 const {deps,calls}=mock();
 const item=await acquireTelegramAudioMaterialDirect(deps);
 assert.equal(item.size_bytes,content.length);
 assert.equal(calls.downloads,1);
 assert.equal(calls.append,1);
 assert.equal(calls.finalize,1);
 assert.equal(calls.abort,0);
});
test("No acquisition is admitted without verified unchanged provider state",async()=>{
 for(const reply of [
  {...direct,outcome:"IN_DOUBT"},
  {...direct,provider_state_checked:false},
  {...direct,provider_state_unchanged:false}
 ]){
  const {deps,calls}=mock({reply});
  await assert.rejects(acquireTelegramAudioMaterialDirect(deps),{code:"LOCAL_ASR_ACQUISITION_PROVIDER_STATE_UNVERIFIED"});
  assert.equal(calls.created,0);
 }
});
test("Mismatching bytes cannot create audio material",async()=>{
 const {deps,calls}=mock({reply:{...direct,size_bytes:content.length+1}});
 await assert.rejects(acquireTelegramAudioMaterialDirect(deps),{code:"LOCAL_ASR_ACQUISITION_PAYLOAD_SIZE_MISMATCH"});
 assert.equal(calls.created,0);
});
test("Reject non-audio input before any provider call",async()=>{
 const {deps,calls}=mock();
 deps.attachment={...attachment,media_kind:"file"};
 await assert.rejects(acquireTelegramAudioMaterialDirect(deps),{code:"LOCAL_ASR_AUDIO_SOURCE_INVALID"});
 assert.equal(calls.downloads,0);
});
test("Preserve bounded large-file fallback signal",async()=>{
 const e=Object.assign(Error("too large"),{code:"WEBK_DOWNLOAD_SIZE_OUT_OF_BOUNDS"});
 const {deps,calls}=mock({reply:e});
 await assert.rejects(acquireTelegramAudioMaterialDirect(deps),{code:e.code});
 assert.equal(calls.created,0);
});
test("Abort failed material write rather than retaining partial source",async()=>{
 const {deps,calls}=mock({failAppend:true});
 await assert.rejects(acquireTelegramAudioMaterialDirect(deps),/SIMULATED_MATERIAL_WRITE_FAILURE/);
 assert.equal(calls.abort,1);
 assert.equal(calls.finalize,0);
});
