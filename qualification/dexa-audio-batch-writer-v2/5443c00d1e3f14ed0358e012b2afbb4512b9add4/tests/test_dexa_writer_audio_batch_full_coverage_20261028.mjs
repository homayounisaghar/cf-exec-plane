import test from "node:test";
import assert from "node:assert/strict";
import {writerEvidencePacket,prepareTextWriter} from "./dexa_text_writer_v1.mjs";
const lengths=[938,1116,1355,1395,1554,798,1680,702,2199,183,514];
const rows=lengths.map((length,i)=>({
 index:i,transcript_available:true,state:"SUCCEEDED",
 source_sha256:String(i).padStart(64,"0"),transcript:String.fromCharCode(97+i).repeat(length)
}));
test("all eleven real-shape audio lengths are included, not truncated to first 900 chars",()=>{
 const packet=writerEvidencePacket(rows);
 assert.equal(packet.sourceCount,11);
 assert.equal(packet.limitedCoverage,false);
 assert.equal(packet.records.length,19);
 assert.ok(packet.records.every(record=>record.truncated===false));
 for(let i=0;i<11;i++){
  const text=packet.records.filter(record=>record.fileIndex===i)
   .sort((a,b)=>a.segmentIndex-b.segmentIndex).map(r=>r.text).join("");
  assert.equal(text,rows[i].transcript);
 }
 const prepared=prepareTextWriter({ownerGoal:"Summarize 11 recordings.",args:{
  operation:"summarize",source:rows,instruction:"Summarize every audio"
 }});
 assert.equal(prepared.packet.limitedCoverage,false);
 assert.equal(prepared.packet.records.length,19);
});
test("20 short transcripts have full coverage, 21 rejected",()=>{
 const twenty=Array.from({length:20},(_,i)=>({state:"SUCCEEDED",transcript_available:true,
   source_sha256:"a".repeat(64),transcript:"message "+i}));
 const pkt=writerEvidencePacket(twenty);
 assert.equal(pkt.sourceCount,20); assert.equal(pkt.records.length,20);
 assert.ok(pkt.records.every(p=>p.fileIndex>=0&&p.fileIndex<20));
 assert.throws(()=>writerEvidencePacket([...twenty,twenty[0]]),/DX001_WRITER_SOURCE_TOO_MANY_RECORDS/);
});
test("audio failure or empty transcript cannot silently become a complete summary",()=>{
 for(const modified of [
  {...rows[0],transcript:""},
  {...rows[0],state:"FAILED"},
  {...rows[0],transcript_available:false},
  {...rows[0],error:{code:"FAILED"}}
 ])assert.throws(()=>writerEvidencePacket([modified,...rows.slice(1)]));
});
test("unrepresentable transcript volume fails explicitly rather than quietly truncating",()=>{
 assert.throws(()=>writerEvidencePacket([{
  state:"SUCCEEDED",transcript_available:true,
  source_sha256:"a".repeat(64),transcript:"x".repeat(18001)
 }]),/DX001_WRITER_TRANSCRIPT_FULL_COVERAGE_REQUIRED/);
});
test("legacy short and long single-string transcript paths remain unchanged",()=>{
 const small=writerEvidencePacket("Hello audio.");
 assert.equal(small.limitedCoverage,false);
 assert.equal(small.records[0].text,"Hello audio.");
 const big=writerEvidencePacket("a".repeat(1500));
 assert.equal(big.records.length,2);
 assert.equal(big.limitedCoverage,false);
});
