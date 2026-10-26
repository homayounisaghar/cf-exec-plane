// Private Telegram->material-plane adapter for the shared 1..20-file ASR.
// Uses the same provider-state-checked download already qualified by
// communication.attachment.download; never forwards audio to Telegram.
export const DIRECT_TELEGRAM_ASR_MAX_BYTES = 32 * 1024 * 1024;

function reject(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

export async function acquireTelegramAudioMaterialDirect({
  page, messageRef, attachment, downloadAttachment, materialPlane,
}) {
  if (!messageRef || !Number.isSafeInteger(messageRef.mid) ||
      typeof messageRef.providerRef !== "string" ||
      attachment?.slot !== "document" ||
      (attachment.media_kind !== "voice" && attachment.media_kind !== "audio") ||
      !String(attachment.media_type || "").startsWith("audio/"))
    reject("LOCAL_ASR_AUDIO_SOURCE_INVALID");
  const delivered = await downloadAttachment(
    page, messageRef.providerRef, messageRef.mid,
    "document", DIRECT_TELEGRAM_ASR_MAX_BYTES,
  );
  // The source acquisition is read-only: no change to Telegram's read state
  // may be ignored even if the audio bytes have already been downloaded.
  if (delivered?.outcome !== "ACHIEVED" ||
      delivered.provider_state_checked !== true ||
      delivered.provider_state_unchanged !== true)
    reject("LOCAL_ASR_ACQUISITION_PROVIDER_STATE_UNVERIFIED");
  const sizeBytes = delivered.size_bytes;
  const encoded = delivered.data_base64;
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 1 ||
      sizeBytes > DIRECT_TELEGRAM_ASR_MAX_BYTES ||
      typeof encoded !== "string" || encoded.length < 1)
    reject("LOCAL_ASR_ACQUISITION_PAYLOAD_INVALID");
  const mimeType = delivered.media_type || attachment.media_type;
  if (typeof mimeType !== "string" || !mimeType.startsWith("audio/"))
    reject("LOCAL_ASR_ACQUISITION_MEDIA_TYPE_INVALID");
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.length !== sizeBytes)
    reject("LOCAL_ASR_ACQUISITION_PAYLOAD_SIZE_MISMATCH");
  const writer = materialPlane.createMaterialFileWriter({
    filename: delivered.filename || ("voice-" + messageRef.mid + ".ogg"),
    mimeType,
    sizeBytes,
  });
  try {
    writer.append(bytes, 0);
    const item = writer.finalize();
    if (!item || typeof item.file_handle !== "string")
      reject("LOCAL_ASR_ACQUISITION_MATERIAL_INVALID");
    return item;
  } catch (error) {
    try { writer.abort(); } catch {}
    throw error;
  }
}
