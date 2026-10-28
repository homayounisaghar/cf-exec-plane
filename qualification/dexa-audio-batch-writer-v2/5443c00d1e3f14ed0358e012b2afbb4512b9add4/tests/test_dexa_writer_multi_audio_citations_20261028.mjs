import test from "node:test";
import assert from "node:assert/strict";
import {prepareTextWriter,verifyTextWriterReply,writerEvidencePacket,DEXA_TEXT_WRITER_SCHEMA} from "./dexa_text_writer_v1.mjs";
const makeFiles=(n,len=100)=>Array.from({length:n},(_,i)=>({
  state:"SUCCEEDED",transcript_available:true,source_sha256:"a".repeat(64),
  transcript:("verified file "+i+" says delivered. ").repeat(Math.ceil(len/32)).slice(0,len)
}));
const reply=(indices,status="COMPLETE")=>JSON.stringify({schema:DEXA_TEXT_WRITER_SCHEMA,status,
  text:"Summary of all verified audio sources.",evidence_indices:indices});
test("11 audio sources can cite 11 separate evidence rows, not just five",()=>{
 const source=makeFiles(11);
 const prepared=prepareTextWriter({args:{operation:"summarize",source},ownerGoal:"Summarize all eleven recordings"});
 const citations=source.map((_,i)=>prepared.packet.records.find(r=>r.fileIndex===i).index);
 assert.equal(citations.length,11);
 assert.match(prepared.prompt,/1–20 UNIQUE existing evidence record indices/);
 const v=verifyTextWriterReply(reply(citations),{prepared});
 assert.equal(v.status,"COMPLETE");
 assert.equal(v.evidence_indices.length,11);
 assert.equal(v.coverageLimited,false);
});
test("20 file summaries may cite all 20, 21 files cannot pass writer packet bounds",()=>{
 const source=makeFiles(20);
 const prepared=prepareTextWriter({args:{operation:"summarize",source},ownerGoal:"Summarize all twenty recordings"});
 const citations=Array.from({length:20},(_,i)=>i);
 assert.equal(verifyTextWriterReply(reply(citations),{prepared}).evidence_indices.length,20);
 assert.throws(()=>writerEvidencePacket(makeFiles(21)));
});
test("audio evidence beyond 20 citations and non-audio beyond five fail closed",()=>{
 const prepared=prepareTextWriter({args:{operation:"summarize",source:makeFiles(11)},ownerGoal:"Summarize eleven"});
 assert.throws(()=>verifyTextWriterReply(reply(Array.from({length:21},(_,i)=>i)),{prepared}),
  /DX001_WRITER_EVIDENCE_COUNT_LIMIT_EXCEEDED/);
 const generic=prepareTextWriter({args:{operation:"summarize",source:[{text:"first"},{text:"second"},{text:"third"},{text:"fourth"},{text:"fifth"},{text:"sixth"}]},
   ownerGoal:"Summarize all sources"});
 assert.throws(()=>verifyTextWriterReply(reply([0,1,2,3,4,5]),{prepared:generic}),
  /DX001_WRITER_EVIDENCE_COUNT_LIMIT_EXCEEDED/);
});
test("invalid status, malformed reply and fabricated citations remain rejected",()=>{
 const prepared=prepareTextWriter({args:{operation:"summarize",source:makeFiles(11)},ownerGoal:"Summarize eleven"});
 assert.throws(()=>verifyTextWriterReply(reply([0],"OTHER"),{prepared}),
  /DX001_WRITER_MODEL_CONTRACT_INVALID/);
 assert.throws(()=>verifyTextWriterReply(JSON.stringify({schema:DEXA_TEXT_WRITER_SCHEMA,status:"COMPLETE",text:"valid summary",
    evidence_indices:[0],invented:"extra"}),{prepared}),/DX001_WRITER_MODEL_CONTRACT_INVALID/);
 assert.throws(()=>verifyTextWriterReply(reply([999]),{prepared}),/DX001_WRITER_EVIDENCE_INDEX_INVALID/);
});
