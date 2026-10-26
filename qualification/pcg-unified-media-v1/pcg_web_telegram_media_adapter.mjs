import { MediaAcquisitionError } from "./pcg_unified_media_acquisition.mjs";

/**
 * Telegram WebK is a source adapter, NOT an ASR downloader. The only two
 * transfer strategies live behind the same read/finish contract.
 * All WebK calls are injected to keep this module pure-testable.
 */
export function createTelegramMediaAdapter({
  identity, getPage, webk, directLimitBytes = 8 * 1024 * 1024,
  maxBytes = 2 * 1024 * 1024 * 1024,
} = {}) {
  if (!identity?.providerMessageRefForHandle || typeof getPage !== "function" || !webk)
    throw new MediaAcquisitionError("MEDIA_TELEGRAM_ADAPTER_INVALID");
  const required = ["download", "prepareLarge", "readLarge", "finishLarge", "abortLarge"];
  if (required.some(k => typeof webk[k] !== "function"))
    throw new MediaAcquisitionError("MEDIA_TELEGRAM_WEBK_INCOMPLETE");

  async function resolve({source_ref, owner_context, authorization_context}) {
    if (!owner_context || !authorization_context)
      throw new MediaAcquisitionError("MEDIA_AUTH_CONTEXT_REQUIRED");
    const handle = source_ref?.handle;
    if (typeof handle !== "string" || !/^tgmsg:[0-9a-f-]{36}$/.test(handle))
      throw new MediaAcquisitionError("MEDIA_TELEGRAM_HANDLE_INVALID");
    const slot = source_ref?.slot || "document";
    if (!["document", "photo"].includes(slot))
      throw new MediaAcquisitionError("MEDIA_TELEGRAM_SLOT_UNSUPPORTED");
    const message = identity.providerMessageRefForHandle(handle);
    if (!message || !message.providerRef || !Number.isSafeInteger(message.mid))
      throw new MediaAcquisitionError("MEDIA_TELEGRAM_RESOLUTION_FAILED");
    const page = getPage();
    if (!page || page.isClosed?.())
      throw new MediaAcquisitionError("MEDIA_PROVIDER_SESSION_UNAVAILABLE");

    let direct = null;
    try {
      direct = await webk.download(page, message.providerRef, message.mid, slot, directLimitBytes);
    } catch (e) {
      if (e?.code !== "WEBK_DOWNLOAD_SIZE_OUT_OF_BOUNDS") throw e;
    }
    if (direct) {
      if (direct.outcome !== "ACHIEVED" || direct.provider_state_unchanged !== true)
        throw new MediaAcquisitionError("MEDIA_SOURCE_STATE_IN_DOUBT");
      const size = direct.size_bytes;
      if (!Number.isSafeInteger(size) || size < 1 || size > directLimitBytes || size > maxBytes)
        throw new MediaAcquisitionError("MEDIA_SOURCE_SIZE_OUT_OF_BOUNDS");
      // Bounded base64 decode is an unavoidable WebK v1 direct API boundary.
      const bytes = Buffer.from(direct.data_base64 || "", "base64");
      if (bytes.length !== size)
        throw new MediaAcquisitionError("MEDIA_TELEGRAM_SOURCE_SIZE_MISMATCH");
      return {
        filename: direct.filename || "attachment.bin",
        media_type: direct.media_type || "application/octet-stream",
        size_bytes: size,
        source_provenance: {ref_kind: "telegram_message"},
        async read(offset, length) {
          if (offset < 0 || length < 1 || offset >= size)
            throw new MediaAcquisitionError("MEDIA_TELEGRAM_RANGE_INVALID");
          const data = bytes.subarray(offset, Math.min(size, offset + length));
          return {bytes: data, offset, next_offset:offset + data.length};
        },
        async finish() { return {provider_state_unchanged:true}; },
      };
    }

    // Provider SDK supports ranged reads only for Telegram documents.
    if (slot !== "document")
      throw new MediaAcquisitionError("MEDIA_PROVIDER_RANGE_UNAVAILABLE");
    const prepared = await webk.prepareLarge(
      page, message.providerRef, message.mid, "document", maxBytes);
    if (!prepared || !Number.isSafeInteger(prepared.size_bytes) ||
        prepared.size_bytes < 1 || prepared.size_bytes > maxBytes)
      throw new MediaAcquisitionError("MEDIA_TELEGRAM_LARGE_SOURCE_INVALID");
    let closed = false;
    return {
      filename: prepared.filename || "attachment.bin",
      media_type: prepared.media_type || "application/octet-stream",
      size_bytes: prepared.size_bytes,
      source_provenance: {ref_kind: "telegram_message"},
      async read(offset, length) {
        if (closed) throw new MediaAcquisitionError("MEDIA_TELEGRAM_READER_CLOSED");
        // WebK ranged reader accepts 1-16 MiB transfer windows.
        const requested = Math.min(16 * 1024 * 1024, Math.max(1024 * 1024, length));
        const chunk = await webk.readLarge(page, prepared.token, offset, requested);
        const bytes = Buffer.from(chunk?.data_base64 || "", "base64");
        if (!bytes.length || bytes.length > length ||
            chunk.size_bytes !== bytes.length || chunk.offset !== offset + bytes.length)
          throw new MediaAcquisitionError("MEDIA_TELEGRAM_CHUNK_INVALID");
        return {bytes,offset,next_offset:offset+bytes.length};
      },
      async finish() {
        closed = true;
        const result = await webk.finishLarge(page, prepared.token);
        return {provider_state_unchanged:result?.outcome === "ACHIEVED" &&
          result?.provider_state_unchanged === true};
      },
      async abort() {
        if (closed) return;
        closed = true;
        await webk.abortLarge(page, prepared.token);
      },
    };
  }
  return { resolve };
}
