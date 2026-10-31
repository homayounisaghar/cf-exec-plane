import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { createWeChatFileHandoff } from "./wechat-media-tools.mjs";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wx-handoff-test-"));
  const material = path.join(root, "material");
  const handoff = path.join(root, "in");
  fs.mkdirSync(material, { mode: 0o700 });
  fs.mkdirSync(handoff, { mode: 0o700 });
  const bytes = Buffer.from("benign qualification bytes\n");
  const handle = "a".repeat(64);
  const filename = "probe.txt";
  const source = path.join(material, handle + "-" + filename);
  fs.writeFileSync(source, bytes, { mode: 0o600 });
  const ready = { upload_id: "b".repeat(64), material_file_handle: "pcgfile:" + handle,
    filename, size_bytes: bytes.length, sha256_hex: createHash("sha256").update(bytes).digest("hex") };
  return { root, material, handoff, source, bytes, ready };
}
function run(f, ready = f.ready) {
  return createWeChatFileHandoff(ready, { materialRoot: f.material,
    containerRoot: f.handoff, hostRoot: f.handoff,
    uid: process.getuid(), gid: process.getgid(), requireRoot: false });
}

test("copies exact bytes to private owner-readable handoff and cleans it", () => {
  const f = fixture();
  try {
    const out = run(f);
    assert.equal(out.size_bytes, f.bytes.length);
    assert.equal(fs.readFileSync(out.path).compare(f.bytes), 0);
    assert.equal(fs.statSync(out.path).uid, process.getuid());
    assert.equal(fs.statSync(out.path).gid, process.getgid());
    assert.equal(fs.statSync(out.path).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.dirname(out.path)).mode & 0o777, 0o700);
    out.cleanup();
    assert.equal(fs.existsSync(out.path), false);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});
test("rejects invalid handle and path-like filename", () => {
  for (const patch of [{ material_file_handle: "pcgfile:../x" }, { filename: "../escape" }]) {
    const f = fixture();
    try { assert.throws(() => run(f, { ...f.ready, ...patch })); }
    finally { fs.rmSync(f.root, { recursive: true, force: true }); }
  }
});
test("rejects a source hash mismatch", () => {
  const f = fixture();
  try { assert.throws(() => run(f, { ...f.ready, sha256_hex: "f".repeat(64) }),
    /WECHAT_MATERIAL_SOURCE_HASH_MISMATCH/); }
  finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});
test("rejects a missing source digest", () => {
  const f = fixture();
  try {
    const { sha256_hex, ...without } = f.ready;
    assert.throws(() => run(f, without), /WECHAT_MATERIAL_SHA_REQUIRED/);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});
test("rejects a source size mismatch", () => {
  const f = fixture();
  try { assert.throws(() => run(f, { ...f.ready, size_bytes: 1 }),
    /WECHAT_MATERIAL_SOURCE_INVALID/); }
  finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});
test("rejects a symlinked material source", () => {
  const f = fixture();
  try {
    const real = f.source + ".real";
    fs.renameSync(f.source, real);
    fs.symlinkSync(real, f.source);
    assert.throws(() => run(f), /WECHAT_MATERIAL_SOURCE_INVALID/);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});
test("rejects a public handoff root", () => {
  const f = fixture();
  try {
    fs.chmodSync(f.handoff, 0o755);
    assert.throws(() => run(f), /WECHAT_HANDOFF_ROOT_NOT_PRIVATE/);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});
test("rejects files above the initial 64 MiB qualification bound", () => {
  const f = fixture();
  try { assert.throws(() => run(f, { ...f.ready, size_bytes: 64 * 1024 * 1024 + 1 }),
    /WECHAT_FILE_SIZE_OUT_OF_SCOPE/); }
  finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});
