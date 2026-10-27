import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { createUnifiedMediaAcquirer } from "./pcg_unified_media_acquisition.mjs";

const sha = (b) => createHash("sha256").update(b).digest("hex");
const src = (b, opts={}) => ({
  filename:"test.mp4",media_type:"video/mp4",size_bytes:b.length,
  expected_sha256:opts.expected_sha256 ?? sha(b),
  read:async (offset,length)=>({bytes:b.subarray(offset,offset+length),offset,next_offset:offset+Math.min(length,b.length-offset)}),
  finish:async()=>({provider_state_unchanged:opts.unchanged??true}),
  abort:async()=>{},
});
function setup(buffer, overrides={}) {
  const seen={chunks:[],aborts:0,finals:0,handles:[]};
  const acquirer=createUnifiedMediaAcquirer({
    adapters:{ telegram:{resolve:async()=>overrides.source || src(buffer)} },
    createMaterialFileWriter:({sizeBytes})=>{
      let chunks=[],offset=0;
      return {
        append(bytes,at){assert.equal(at,offset);chunks.push(Buffer.from(bytes));offset+=bytes.length;seen.chunks.push(bytes.length);},
        finalize(){ assert.equal(offset,sizeBytes);seen.finals++;const b=Buffer.concat(chunks);return {file_handle:"pcgfile:"+"a".repeat(64),size_bytes:b.length,sha256_hex:sha(b)};},
        abort(){seen.aborts++;}
      };
    },
    limits:{directLimitBytes:8,chunkBytes:4,maxBytes:1024,maxElapsedMs:10000},
    ...overrides.config,
  });
  return { seen, acquire:()=>acquirer.acquire({
    source_ref:{provider:"telegram",handle:"tgmsg:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"},
    owner_context:{owner:true},authorization_context:{approved:true},
  })};
}
test("small and large files have identical result schema, complete SHA and exact offset",async()=>{
  for(const size of [7,24]){
    const b=Buffer.alloc(size,0x42),t=setup(b);
    const out=await t.acquire();
    assert.equal(out.size_bytes,size);assert.equal(out.sha256_hex,sha(b));
    assert.match(out.material_file_handle,/^pcgfile:/);
    assert.deepEqual(Object.keys(out),["material_file_handle","filename","media_type","size_bytes","sha256_hex","source_provenance","expires_at"]);
    assert.equal(t.seen.chunks.length,size<8?1:6);
    assert.equal(t.seen.finals,1);
  }
});
test("provider failure preserves no committed material",async()=>{
  const b=Buffer.alloc(16,5);
  const t=setup(b,{source:{...src(b),read:async()=>{throw Error("SOURCE_DOWN");}}});
  await assert.rejects(t.acquire(),/SOURCE_DOWN/);
  assert.equal(t.seen.aborts,1);assert.equal(t.seen.finals,0);
});
test("no read-state confirmation fails closed",async()=>{
  const b=Buffer.alloc(8),t=setup(b,{source:src(b,{unchanged:false})});
  await assert.rejects(t.acquire(),{code:"MEDIA_SOURCE_STATE_IN_DOUBT"});
  assert.equal(t.seen.aborts,1);
});
test("digest disagreement removes staged file",async()=>{
  const b=Buffer.alloc(8),t=setup(b,{source:src(b,{expected_sha256:"a".repeat(64)})});
  await assert.rejects(t.acquire(),{code:"MEDIA_SOURCE_DIGEST_MISMATCH"});
  assert.equal(t.seen.aborts,1);
});
test("reject arbitrary URL as source handle",async()=>{
  const t=setup(Buffer.alloc(5));
  const acquirer=createUnifiedMediaAcquirer({adapters:{},createMaterialFileWriter:()=>({})});
  await assert.rejects(acquirer.acquire({source_ref:{provider:"telegram",handle:"http://169.254.169.254"},owner_context:1,authorization_context:1}),{code:"MEDIA_SOURCE_HANDLE_UNSAFE"});
});
test("reject unadmitted provider, missing authorization, and invalid byte offsets",async()=>{
  const b=Buffer.alloc(8);
  const t=setup(b,{source:{...src(b),read:async()=>({offset:1,bytes:b,next_offset:9})}});
  await assert.rejects(t.acquire(),{code:"MEDIA_SOURCE_OFFSET_OR_CHUNK_INVALID"});
  assert.equal(t.seen.aborts,1);
  const a=createUnifiedMediaAcquirer({adapters:{},createMaterialFileWriter:()=>({})});
  await assert.rejects(a.acquire({source_ref:{provider:"wechat",handle:"opaque"},owner_context:1,authorization_context:1}),{code:"MEDIA_PROVIDER_NOT_ADMITTED"});
  await assert.rejects(a.acquire({source_ref:{provider:"wechat",handle:"opaque"}}),{code:"MEDIA_AUTH_CONTEXT_REQUIRED"});
});
test("bounded chunk count blocks disk writer before staging",async()=>{
 const b=Buffer.alloc(32); const t=setup(b,{config:{limits:{directLimitBytes:8,chunkBytes:4,maxBytes:64,maxChunks:2,maxElapsedMs:1000}}});
 await assert.rejects(t.acquire(),{code:"MEDIA_CHUNK_COUNT_EXCEEDED"});
 assert.equal(t.seen.chunks.length,0);
});
