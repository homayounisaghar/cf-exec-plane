import { createHash } from "node:crypto";

export const ACQUISITION_DEFAULTS = Object.freeze({
  chunkBytes: 1024 * 1024,
  maxBytes: 2 * 1024 * 1024 * 1024,
  maxChunks: 4096,
  maxElapsedMs: 10 * 60 * 1000,
});

export class MediaAcquisitionError extends Error {
  constructor(code) {
    super(code);
    this.name = "MediaAcquisitionError";
    this.code = code;
  }
}

function fail(code) { throw new MediaAcquisitionError(code); }
function assertNumber(n, lower, upper, code) {
  if (!Number.isSafeInteger(n) || n < lower || n > upper) fail(code);
}
function sanitizedFilename(name) {
  const s = String(name || "attachment.bin").trim();
  if (!s || s.length > 128 || s === "." || s === ".." || /[\\/\u0000-\u001f\u007f]/u.test(s)) fail("MEDIA_FILENAME_INVALID");
  return s;
}
function sanitizedMime(s) {
  s = String(s || "application/octet-stream").trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9!#&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#&^_.+-]{0,63}$/.test(s)) fail("MEDIA_MIME_INVALID");
  return s;
}
function validateRef(ref) {
  if (!ref || typeof ref !== "object" || Array.isArray(ref)) fail("MEDIA_SOURCE_REF_INVALID");
  if (!/^[a-z][a-z0-9_-]{0,39}$/.test(ref.provider || "")) fail("MEDIA_SOURCE_PROVIDER_INVALID");
  if (typeof ref.handle !== "string" || ref.handle.length < 1 || ref.handle.length > 512) fail("MEDIA_SOURCE_HANDLE_INVALID");
  // Never interpret a provider reference as an arbitrary network URL or local path.
  if (/^(?:https?:|file:|\/|\.\.?\/)/i.test(ref.handle)) fail("MEDIA_SOURCE_HANDLE_UNSAFE");
}
function byteBuffer(data) {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof Uint8Array) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  fail("MEDIA_SOURCE_BYTES_INVALID");
}
function deadlineCheck(start, clock, limit) {
  if (clock() - start > limit) fail("MEDIA_ACQUISITION_TIMEOUT");
}

/**
 * In-process, consumer-independent acquisition. The existing PCG material
 * writer is an injected dependency, not a parallel store or protocol.
 *
 * adapter.resolve({source_ref, owner_context, authorization_context}) returns:
 * { filename, media_type, size_bytes, read(offset, length), finish?, abort?,
 *   expected_sha256?, source_provenance? }.
 * read() returns Buffer/Uint8Array or {bytes, offset, next_offset}.
 * Every adapter must authenticate its source, enforce provider restrictions,
 * and verify unchanged provider read/view state before finish() returns.
 */
export function createUnifiedMediaAcquirer({
  adapters,
  createMaterialFileWriter,
  limits = {},
  now = () => Date.now(),
} = {}) {
  if (!adapters || typeof adapters !== "object") fail("MEDIA_ADAPTERS_REQUIRED");
  if (typeof createMaterialFileWriter !== "function") fail("MEDIA_WRITER_REQUIRED");
  const cfg = { ...ACQUISITION_DEFAULTS, ...limits };
  assertNumber(cfg.chunkBytes, 1, 16 * 1024 * 1024, "MEDIA_CHUNK_LIMIT_INVALID");
  assertNumber(cfg.maxBytes, 1, 2 * 1024 * 1024 * 1024, "MEDIA_SIZE_LIMIT_INVALID");
  assertNumber(cfg.maxChunks, 1, 100000, "MEDIA_CHUNK_COUNT_INVALID");
  assertNumber(cfg.maxElapsedMs, 1, 3600000, "MEDIA_TIMEOUT_LIMIT_INVALID");

  async function acquire({ source_ref, owner_context, authorization_context, transfer_limits = {} } = {}) {
    validateRef(source_ref);
    if (!owner_context || !authorization_context) fail("MEDIA_AUTH_CONTEXT_REQUIRED");
    const adapter = adapters[source_ref.provider];
    if (!adapter || (typeof adapter.resolve !== "function" && typeof adapter.adopt !== "function"))
      fail("MEDIA_PROVIDER_NOT_ADMITTED");
    const maxAllowed = transfer_limits.max_bytes == null ? cfg.maxBytes : transfer_limits.max_bytes;
    assertNumber(maxAllowed, 1, cfg.maxBytes, "MEDIA_SIZE_LIMIT_INVALID");
    // Already-verified owner uploads enter through the SAME private material
    // plane. Reuse the immutable bytes; do not make a wasteful second copy.
    // The real consumer revalidates digest/size before reading them.
    if (typeof adapter.adopt === "function") {
      const ready = await adapter.adopt({source_ref, owner_context, authorization_context});
      if (!ready || !/^pcgfile:[0-9a-f]{64}$/.test(ready.material_file_handle || ""))
        fail("MEDIA_MATERIAL_HANDLE_INVALID");
      assertNumber(ready.size_bytes, 1, maxAllowed, "MEDIA_SOURCE_SIZE_OUT_OF_BOUNDS");
      const filename = sanitizedFilename(ready.filename);
      const media_type = sanitizedMime(ready.media_type);
      if (!/^[0-9a-f]{64}$/.test(ready.sha256_hex || "")) fail("MEDIA_SOURCE_DIGEST_INVALID");
      return {
        material_file_handle: ready.material_file_handle,
        filename, media_type, size_bytes: ready.size_bytes,
        sha256_hex: ready.sha256_hex,
        source_provenance: {
          provider: source_ref.provider,
          ref_kind: ready.source_provenance?.ref_kind || "verified_material",
        },
        expires_at: Number.isSafeInteger(ready.expires_at) ? ready.expires_at : null,
      };
    }
    const started = now();
    let source;
    let writer;
    let material;
    let finished = false;
    try {
      source = await adapter.resolve({ source_ref, owner_context, authorization_context });
      if (!source || typeof source.read !== "function") fail("MEDIA_PROVIDER_STREAM_UNAVAILABLE");
      const size = source.size_bytes;
      assertNumber(size, 1, maxAllowed, "MEDIA_SOURCE_SIZE_OUT_OF_BOUNDS");
      const filename = sanitizedFilename(source.filename);
      const mediaType = sanitizedMime(source.media_type);
      // Every file, regardless of size, follows this exact ranged-read loop.
      const stride = Math.min(cfg.chunkBytes, size);
      if (Math.ceil(size / stride) > cfg.maxChunks) fail("MEDIA_CHUNK_COUNT_EXCEEDED");
      const expected = source.expected_sha256;
      if (expected != null && !/^[0-9a-f]{64}$/.test(expected)) fail("MEDIA_SOURCE_DIGEST_INVALID");
      writer = createMaterialFileWriter({ filename, mimeType: mediaType, sizeBytes: size });
      const digest = createHash("sha256");
      let offset = 0;
      while (offset < size) {
        deadlineCheck(started, now, cfg.maxElapsedMs);
        const limit = Math.min(stride, size - offset);
        const part = await source.read(offset, limit);
        const bytes = byteBuffer(part?.bytes ?? part);
        const declaredOffset = part?.offset ?? offset;
        const nextOffset = part?.next_offset ?? offset + bytes.length;
        if (declaredOffset !== offset || !bytes.length || bytes.length > limit ||
            nextOffset !== offset + bytes.length) fail("MEDIA_SOURCE_OFFSET_OR_CHUNK_INVALID");
        writer.append(bytes, offset);
        digest.update(bytes);
        offset += bytes.length;
      }
      const hash = digest.digest("hex");
      if (expected && hash !== expected) fail("MEDIA_SOURCE_DIGEST_MISMATCH");
      deadlineCheck(started, now, cfg.maxElapsedMs);
      if (typeof source.finish === "function") {
        const receipt = await source.finish();
        if (receipt?.provider_state_unchanged !== true) fail("MEDIA_SOURCE_STATE_IN_DOUBT");
      } else {
        // No adapter can silently opt out of provider read/view-state verification.
        fail("MEDIA_PROVIDER_RECONCILIATION_REQUIRED");
      }
      material = writer.finalize();
      finished = true;
      if (!material || material.size_bytes !== size || material.sha256_hex !== hash ||
          !/^pcgfile:[0-9a-f]{64}$/.test(material.file_handle || "")) fail("MEDIA_MATERIAL_FINALIZATION_INVALID");
      return {
        material_file_handle: material.file_handle,
        filename,
        media_type: mediaType,
        size_bytes: size,
        sha256_hex: hash,
        source_provenance: {
          provider: source_ref.provider,
          ref_kind: typeof source.source_provenance?.ref_kind === "string"
            ? source.source_provenance.ref_kind.slice(0, 64) : "provider_handle",
        },
        expires_at: Number.isSafeInteger(material.expires_at) ? material.expires_at : null,
      };
    } catch (error) {
      if (writer && !finished) {
        try { writer.abort(); } catch { /* first error wins */ }
      }
      if (finished && material && typeof writer.release === "function") {
        try { writer.release(); } catch { /* a finalized handle must not be reported successful */ }
      }
      throw error;
    } finally {
      if (source && !finished && typeof source.abort === "function") {
        try { await source.abort(); } catch { /* preserve primary error / IN_DOUBT */ }
      }
    }
  }

  return { acquire };
}
