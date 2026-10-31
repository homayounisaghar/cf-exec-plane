import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { registerWeChatMediaTools } from "./wechat-media-tools.mjs";

const chain = new Proxy({}, { get: () => () => chain });
const z = { enum: () => chain, string: () => chain, number: () => chain, boolean: () => chain };
function server() {
  const handlers = new Map();
  return { registerTool(n, d, cb) { handlers.set(n, cb); }, handler(n) { return handlers.get(n); } };
}
function fixture() {
  const bytes = Buffer.from("safe dry-run fixture\n");
  const sha = createHash("sha256").update(bytes).digest("hex");
  let marked = 0, cleaned = 0, staged = 0;
  const materialUpload = {
    create: async () => ({}), status: async () => ({}), delete: async () => ({}),
    append: async () => ({}), ready: async () => ({
      upload_id: "b".repeat(64), material_file_handle: "pcgfile:" + "a".repeat(64),
      filename: "probe.txt", size_bytes: bytes.length, sha256_hex: sha
    }),
    markSendStarted: async () => { marked++; }
  };
  const handoffFactory = ready => {
    staged++;
    return { path: "/tmp/wxeng/in/.cf-wechat-test/probe.txt", filename: ready.filename,
      size_bytes: ready.size_bytes, sha256_hex: sha, cleanup: () => { cleaned++; } };
  };
  const s = server();
  registerWeChatMediaTools(s, z, { materialUpload, handoffFactory,
    semanticUrl: "http://127.0.0.1:9337" });
  return { s, materialUpload, handoffFactory, counts: () => ({ marked, cleaned, staged }) };
}
async function withFetch(fn) {
  const prior = globalThis.fetch;
  try { return await fn(); } finally { globalThis.fetch = prior; }
}
test("dry run uses private handoff and helper but never reserves a send", async () => {
  await withFetch(async () => {
    const f = fixture(); let request;
    globalThis.fetch = async (url, options) => {
      request = { url, body: JSON.parse(options.body) };
      return { ok: true, text: async () => JSON.stringify({ ok: true, state: "DRY_RUN_READY" }) };
    };
    const out = (await f.s.handler("wechat_file_send")({
      target: "File Transfer", upload_id: "b".repeat(64), dry_run: true
    })).structuredContent;
    assert.equal(out.state, "DRY_RUN_READY");
    assert.equal(out.provider_send_performed, false);
    assert.equal(request.url, "http://127.0.0.1:9337/file-send");
    assert.equal(request.body.expected_sha256.length, 64);
    assert.equal(request.body.dry_run, true);
    assert.deepEqual(f.counts(), { marked: 0, cleaned: 1, staged: 1 });
  });
});
test("live send remains fail-closed until explicitly enabled", async () => {
  const f = fixture();
  const out = (await f.s.handler("wechat_file_send")({
    target: "File Transfer", upload_id: "b".repeat(64), dry_run: false
  })).structuredContent;
  assert.equal(out.state, "FAILED");
  assert.equal(out.error.code, "WECHAT_FILE_SEND_PROVIDER_VERIFICATION_GATE_CLOSED");
  assert.deepEqual(f.counts(), { marked: 0, cleaned: 0, staged: 0 });
});
test("enabled candidate reports UI observation, never provider confirmation", async () => {
  await withFetch(async () => {
    const f = fixture(); let marked = 0, cleaned = 0;
    const materialUpload = { ...f.materialUpload };
    materialUpload.markSendStarted = async () => { marked++; };
    const s = server();
    registerWeChatMediaTools(s, z, { materialUpload, handoffFactory: ready => ({
      path: "/tmp/wxeng/in/.cf-wechat-test/probe.txt", filename: ready.filename,
      size_bytes: ready.size_bytes, sha256_hex: ready.sha256_hex,
      cleanup: () => { cleaned++; }
    }), enableLiveFileSend: true });
    globalThis.fetch = async () => ({ ok: true, text: async () => JSON.stringify({
      ok: true, state: "UI_OUTBOUND_OBSERVED", direction: "out"
    }) });
    const out = (await s.handler("wechat_file_send")({
      target: "File Transfer", upload_id: "b".repeat(64), dry_run: false
    })).structuredContent;
    assert.equal(out.state, "UI_OUTBOUND_OBSERVED");
    assert.equal(out.provider_confirmed, false);
    assert.equal(out.provider_fresh, false);
    assert.equal(out.blind_retry_safe, false);
    assert.equal(marked, 1);
    assert.equal(cleaned, 1);
  });
});
test("ambiguous helper transport is IN_DOUBT and cleanup still runs", async () => {
  await withFetch(async () => {
    const f = fixture(); let marked = 0, cleaned = 0;
    const materialUpload = { ...f.materialUpload, markSendStarted: async () => { marked++; } };
    const s = server();
    registerWeChatMediaTools(s, z, { materialUpload, enableLiveFileSend: true,
      handoffFactory: ready => ({ path: "/tmp/wxeng/in/.cf-wechat-test/probe.txt",
        filename: ready.filename, size_bytes: ready.size_bytes,
        sha256_hex: ready.sha256_hex, cleanup: () => { cleaned++; } }) });
    globalThis.fetch = async () => { throw new Error("transport lost after dispatch"); };
    const out = (await s.handler("wechat_file_send")({
      target: "File Transfer", upload_id: "b".repeat(64), dry_run: false
    })).structuredContent;
    assert.equal(out.state, "IN_DOUBT");
    assert.equal(out.blind_retry_safe, false);
    assert.equal(marked, 1);
    assert.equal(cleaned, 1);
  });
});
test("arbitrary recipients and read-state effects are rejected", async () => {
  const f = fixture();
  const other = (await f.s.handler("wechat_file_send")({
    target: "Other", upload_id: "b".repeat(64), dry_run: true
  })).structuredContent;
  const read = (await f.s.handler("wechat_file_send")({
    target: "File Transfer", upload_id: "b".repeat(64), dry_run: true, allow_mark_read: true
  })).structuredContent;
  assert.equal(other.error.code, "WECHAT_FILE_SEND_SELF_CHAT_ONLY");
  assert.equal(read.error.code, "WECHAT_FILE_SEND_READ_EFFECT_NOT_ALLOWED");
  assert.deepEqual(f.counts(), { marked: 0, cleaned: 0, staged: 0 });
});
