import assert from "node:assert/strict";
import test from "node:test";
import { evaluateWeChatFileSendReceipt as check } from "./wechat_file_receipt_guard.mjs";
const expected = { target: "File Transfer", filename: "probe.txt", size_bytes: 55 };
const observed = { target: "File Transfer", selected_target: "File Transfer",
  direction: "out", send_clicks: 1, send_enabled_after: false,
  chooser_identity_verified: true, source_bytes_verified: true,
  source_size_bytes: 55, rows_before: [], rows_after: ["probe.txt 55B"] };
test("bounded outgoing UI receipt remains non-authoritative", () => {
  const x=check({expected,observed});
  assert.equal(x.state,"UI_OUTBOUND_OBSERVED");
  assert.equal(x.provider_confirmed,false);
  assert.equal(x.blind_retry_safe,false);
});
for(const [label, mutation] of [
  ["wrong recipient", {target:"Other"}],
  ["wrong selected chat", {selected_target:"Other"}],
  ["not outgoing", {direction:"in"}],
  ["duplicated dispatch", {send_clicks:2}],
  ["composer not reset", {send_enabled_after:true}],
  ["unverified chooser", {chooser_identity_verified:false}],
  ["unverified bytes", {source_bytes_verified:false}],
  ["wrong byte count", {source_size_bytes:56}],
  ["missing row", {rows_after:[]}],
  ["duplicate row", {rows_after:["probe.txt", "probe.txt"]}],
  ["preexisting row only", {rows_before:["probe.txt"],rows_after:["probe.txt"]}]
]) test(label+" must not count as verified",()=>{
  const x=check({expected,observed:{...observed,...mutation}});
  assert.equal(x.state,"IN_DOUBT");assert.equal(x.provider_confirmed,false);
});
