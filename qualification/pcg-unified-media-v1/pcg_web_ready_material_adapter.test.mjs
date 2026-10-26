import assert from "node:assert/strict";
import test from "node:test";
import { createUnifiedMediaAcquirer } from "./pcg_unified_media_acquisition.mjs";
import { createReadyMaterialAdapter } from "./pcg_web_ready_material_adapter.mjs";

test("owner-staged ChatGPT material is adopted without duplicating original bytes", async()=>{
 let writes=0;
 const acq=createUnifiedMediaAcquirer({
  adapters:{chatgpt:createReadyMaterialAdapter()},
  createMaterialFileWriter:()=>{writes++;throw Error("unexpected double staging");},
 });
 const out=await acq.acquire({
  source_ref:{provider:"chatgpt",handle:"pcgfile:"+"a".repeat(64),filename:"source.mp4",
    media_type:"video/mp4",size_bytes:9000,sha256_hex:"b".repeat(64)},
  owner_context:{owner:true},authorization_context:{verified_upload:true},
  transfer_limits:{max_bytes:64*1024*1024},
 });
 assert.equal(out.material_file_handle,"pcgfile:"+"a".repeat(64));
 assert.equal(out.sha256_hex,"b".repeat(64));
 assert.equal(out.source_provenance.provider,"chatgpt");
 assert.equal(writes,0);
});
test("source-bound owner admission is mandatory",async()=>{
 const a=createUnifiedMediaAcquirer({
  adapters:{chatgpt:createReadyMaterialAdapter()},
  createMaterialFileWriter:()=>{throw Error("never");},
 });
 const source_ref={provider:"chatgpt",handle:"pcgfile:"+"a".repeat(64),filename:"audio.ogg",
  media_type:"audio/ogg",size_bytes:10,sha256_hex:"b".repeat(64)};
 await assert.rejects(a.acquire({source_ref,owner_context:{},authorization_context:{}}),
  {code:"MEDIA_AUTH_CONTEXT_REQUIRED"});
 await assert.rejects(a.acquire({source_ref:{...source_ref,handle:"file:/tmp/secret"},owner_context:1,authorization_context:{verified_upload:true}}),
  {code:"MEDIA_MATERIAL_HANDLE_INVALID"});
});
