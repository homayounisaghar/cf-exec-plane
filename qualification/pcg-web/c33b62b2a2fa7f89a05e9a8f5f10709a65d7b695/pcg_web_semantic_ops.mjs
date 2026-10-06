import { createHash, randomUUID } from "node:crypto";
import { createConversationIdentity } from "./pcg_web_identity.mjs";
import { createComposerFoundation } from "./pcg_web_composer.mjs";
import { createPrivateFileBroker } from "./pcg_web_file_broker.mjs";
import { transcodeAudioToMp3, transcodeAudioToOggOpus } from "./pcg_web_audio.mjs";
import { convertMaterialAudioToOggOpus } from "./pcg_web_audio_transform_client.mjs";
import { getLocalAsrJob, startLocalAsrJob } from "./pcg_web_asr_client.mjs";
import { getPerplexityAsrJob, startPerplexityAsrJob } from "./pcg_web_perplexity_asr_client.mjs";
import {
  locateVisibleConversationRowByHandle,
  protectedConversationTitle,
  unreadConversationRefs,
  visibleConversationEntries,
  withConversationSearch,
} from "./pcg_web_primitives.mjs";
import { summarizeGaps } from "./pcg_web_gap_ledger.mjs";
import { probeProviderModel } from "./pcg_web_provider_model.mjs";
import { webKAbortLargeAttachmentDownload, webKDownloadAttachment, webKFetchMessage, webKFinishLargeAttachmentDownload, webKGetMessageReactionState, webKListMessageReplies, webKListMessages, webKMarkConversationRead, webKOpenMessageMedia, webKPrepareLargeAttachmentDownload, webKReadLargeAttachmentDownloadChunk, webKSearchMessages, webKSetMessageReaction, webKTranscribeMessage } from "./pcg_web_webk_bridge.mjs";
import { webKListConversationStructure, webKListTopics, webKSearchContacts, webKSearchConversations, webKSetConversationMute, webKSetConversationPin, webKSetConversationUnreadMark, webKTopicReadSnapshot } from "./pcg_web_structure.mjs";

function semanticEnvelope(operation, state, observation = {}, sideEffects = [], protectedProviderData = null, error = null) {
  const out = {
    ok: state === "ACHIEVED",
    state,
    operation,
    provider: "telegram",
    realization: "web-ui",
    observation,
    side_effects: sideEffects,
  };
  if (protectedProviderData !== null) out.protected_provider_data = protectedProviderData;
  if (error) out.error = error;
  return out;
}

export function createSemanticOperations({ getPage, detectPhase, handleRegistryFile, downloadBrokerRoot, getMaterialSend = null }) {
  const identity = createConversationIdentity(handleRegistryFile);
  const composer = createComposerFoundation(identity);
  const downloadBroker = createPrivateFileBroker(downloadBrokerRoot, { maxFileBytes: 32 * 1024 * 1024 });
  const largeAttachmentDownloads = new Map();
  const transcriptionJobsByMessage = new Map();
  const perplexityTranscriptionJobsByMessage = new Map();

  function pageNow() {
    const page = getPage();
    if (!page || page.isClosed()) {
      const err = new Error("BROWSER_CLOSED");
      err.code = "BROWSER_CLOSED";
      throw err;
    }
    return page;
  }

  function materialSendNow() {
    const bridge = typeof getMaterialSend === "function" ? getMaterialSend() : null;
    if (!bridge) {
      const err = new Error("MATERIAL_SEND_BRIDGE_UNAVAILABLE");
      err.code = "MATERIAL_SEND_BRIDGE_UNAVAILABLE";
      throw err;
    }
    return bridge;
  }

  function newRandomSendId() {
    const high = BigInt(Date.now());
    const low = BigInt(Math.floor(Math.random() * 1000000));
    return (high * 1000000n + low).toString();
  }

  function sendTextArgument(args, { allowEmpty = false } = {}) {
    for (const key of ["text", "message", "body", "content"]) {
      const value = args?.[key];
      if (typeof value === "string" && (allowEmpty || value.trim())) return value;
    }
    return null;
  }

  function conversationHandleArgument(args) {
    for (const key of ["conversation_handle", "handle", "conversation", "chat_handle", "target_conversation_handle", "destination_conversation_handle", "to_conversation_handle"]) {
      const value = args?.[key];
      if (typeof value === "string" && value.trim()) return value.trim();
    }
    return null;
  }

  function trimmedArgument(args, keys) {
    for (const key of keys) {
      const value = args?.[key];
      if (typeof value === "string" && value.trim()) return value.trim();
    }
    return null;
  }

  function sha256Hex(value) {
    return createHash("sha256").update(value, "utf8").digest("hex");
  }

  // Generic material-operation engine.
  //
  // Every provider-visible write follows the same shape: resolve and verify the
  // target, dispatch exactly once under a correlation id, then read the result
  // back from the provider until it is confirmed or rejected. Families differ
  // only in which inputs they require and which bridge calls they use, so they
  // are declared as data below instead of hand-written per operation.
  const MATERIAL_FAMILIES = {
    "communication.message.send": {
      requires: ["conversation", "text"],
      sideEffect: "provider_visible_message_created",
      check: (bridge, page, c) => bridge.checkTarget(page, c.conversationHandle),
      dispatch: (bridge, page, c) => bridge.dispatchText(page, c),
      observe: (bridge, page, c) => bridge.observeText(page, c),
    },
    "communication.message.reply": {
      requires: ["conversation", "text", "source_message"],
      sideEffect: "provider_visible_message_created",
      check: (bridge, page, c) => bridge.checkReplyTarget(page, c.conversationHandle, c.sourceMessageHandle),
      dispatch: (bridge, page, c) => bridge.dispatchReplyText(page, c),
      observe: (bridge, page, c) => bridge.observeReplyText(page, c),
    },
    "communication.message.edit": {
      requires: ["conversation", "text", "message"],
      sideEffect: "provider_visible_message_changed",
      check: (bridge, page, c) => bridge.checkEditTarget(page, c.conversationHandle, c.messageHandle),
      dispatch: (bridge, page, c) => bridge.dispatchEditText(page, c),
      observe: (bridge, page, c) => bridge.observeEditText(page, c),
    },
    "communication.message.delete": {
      requires: ["conversation", "message", "scope", "irreversible_confirmation"],
      sideEffect: "provider_visible_message_removed",
      check: (bridge, page, c) => bridge.checkDeleteTarget(page, c.conversationHandle, c.messageHandle, c.scope),
      dispatch: (bridge, page, c) => bridge.dispatchDeleteMessage(page, c),
      observe: (bridge, page, c) => bridge.observeDeleteMessage(page, c),
    },
    "communication.message.forward-native": {
      requires: ["conversation", "source_conversation", "source_message"],
      sideEffect: "provider_visible_message_created",
      check: (bridge, page, c) => bridge.checkForwardTarget(page, c.sourceConversationHandle, c.sourceMessageHandle, c.conversationHandle),
      dispatch: (bridge, page, c) => bridge.dispatchForwardNative(page, c),
      observe: (bridge, page, c) => bridge.observeForwardNative(page, c),
    },
    "communication.message.relay": {
      requires: ["conversation", "source_conversation", "source_message", "relay_purpose", "source_digest"],
      sideEffect: "provider_visible_message_created",
      check: (bridge, page, c) => bridge.checkRelayTarget(page, c.sourceConversationHandle, c.sourceMessageHandle, c.conversationHandle),
      dispatch: (bridge, page, c) => bridge.dispatchRelayText(page, c),
      observe: (bridge, page, c) => bridge.observeRelayText(page, c),
    },
  };

  // A provider call that never answers leaves work pending inside the page.
  // Abandoning our own await is not enough: the next calls queue behind the
  // pending one and the session stays stalled until the page is reloaded. So a
  // stall is a recoverable condition with a declared recovery, and a retry is
  // allowed only where no effect can have been attempted yet.
  const STALL_CODES = new Set(["WEB_PROVIDER_EVALUATE_TIMEOUT", "PROVIDER_PRIMITIVE_TIMEOUT"]);

  async function recoverStalledPage() {
    try {
      const page = pageNow();
      await page.reload({ waitUntil: "domcontentloaded", timeout: 60000 });
      const deadline = Date.now() + 60000;
      while (Date.now() < deadline) {
        if ((await detectPhase()) === "READY") return true;
        await page.waitForTimeout(1000);
      }
    } catch {}
    return false;
  }

  async function materialOperation(operation, req) {
    const startedAt = Date.now();
    const family = MATERIAL_FAMILIES[operation];
    if (!family) {
      return semanticEnvelope(operation, "UNSUPPORTED", {}, [], null, "UNSUPPORTED_SEMANTIC_OPERATION");
    }
    const args = req?.args && typeof req.args === "object" && !Array.isArray(req.args) ? req.args : {};
    const needs = new Set(family.requires);

    let conversationHandle = conversationHandleArgument(args);
    let sourceConversationHandle = trimmedArgument(args, ["source_conversation_handle", "from_conversation_handle", "source_chat_handle", "from_chat_handle"])
      || (needs.has("source_conversation") ? null : conversationHandle);
    const messageHandle = trimmedArgument(args, ["message_handle", "target_message_handle", "msg_handle"]);
    const sourceMessageHandle = trimmedArgument(args, ["source_message_handle", "message_handle", "reply_to_message_handle", "source_msg_handle"]);

    const boundConversationForMessage = (handle) => {
      if (!handle) return null;
      try {
        const ref = identity.providerMessageRefForHandle(handle);
        return identity.opaqueConversationHandle(ref.providerRef);
      } catch {
        return null;
      }
    };
    if (!conversationHandle) {
      const bound = boundConversationForMessage(messageHandle || (operation === "communication.message.reply" ? sourceMessageHandle : null));
      if (bound) conversationHandle = bound;
    }
    if (needs.has("source_conversation") && !sourceConversationHandle) {
      const bound = boundConversationForMessage(sourceMessageHandle);
      if (bound) sourceConversationHandle = bound;
    }
    const text = sendTextArgument(args, { allowEmpty: operation === "communication.message.edit" });
    const scope = trimmedArgument(args, ["scope", "deletion_scope"]) || "SELF_ONLY";
    const purpose = trimmedArgument(args, ["relay_purpose"]) || "TRANSPORT_RELAY";
    const sourceText = typeof args.source_text === "string" && args.source_text ? args.source_text : null;
    const sourceContentSha256 = trimmedArgument(args, ["source_content_sha256"])
      || (sourceText ? sha256Hex(sourceText) : null);

    if (needs.has("conversation") && !conversationHandle) {
      return teachingEnvelope(operation, "CONVERSATION_HANDLE_REQUIRED", "Pass the target conversation as conversation_handle (aliases: chat_handle, target_conversation_handle). Handles come from communication.conversation.list or communication.conversation.search.");
    }
    if (needs.has("source_conversation") && !sourceConversationHandle) {
      return teachingEnvelope(operation, "SOURCE_CONVERSATION_HANDLE_REQUIRED", "Pass the conversation the message is taken from as source_conversation_handle (alias: from_conversation_handle).");
    }
    if (needs.has("message") && !messageHandle) {
      return teachingEnvelope(operation, "MESSAGE_HANDLE_REQUIRED", "Pass the target message as message_handle (alias: target_message_handle). Handles come from communication.message.list or communication.message.fetch.");
    }
    if (needs.has("source_message") && !sourceMessageHandle) {
      return teachingEnvelope(operation, "SOURCE_MESSAGE_HANDLE_REQUIRED", "Pass the message being replied to, forwarded or relayed as source_message_handle (aliases: message_handle, reply_to_message_handle).");
    }
    if (needs.has("text")) {
      if (text === null) {
        const guidance = operation === "communication.message.edit"
          ? "Pass text (aliases: message_text, body, content). For edit, an empty string is valid and removes an existing media caption; maximum length is 4096 characters."
          : "Pass the message body as text (aliases: message_text, body, content). It must be non-empty and at most 4096 characters.";
        return teachingEnvelope(operation, "MESSAGE_TEXT_REQUIRED", guidance);
      }
      if (text.length > 4096) return teachingEnvelope(operation, "MESSAGE_TEXT_TOO_LONG", "The message body exceeds the provider limit of 4096 characters. Split it into several sends.");
    }
    if (needs.has("scope") && scope !== "SELF_ONLY" && scope !== "FOR_EVERYONE") {
      return teachingEnvelope(operation, "DELETION_SCOPE_UNSUPPORTED", "Pass scope as exactly \"SELF_ONLY\" (removes the message only for you) or \"FOR_EVERYONE\" (removes it for all participants, when the provider still allows it).");
    }
    if (needs.has("irreversible_confirmation") && args.confirm_irreversible !== true) {
      return teachingEnvelope(operation, "IRREVERSIBLE_CONFIRMATION_REQUIRED", "This effect cannot be undone, so it needs explicit per-call consent. If the user has already asked for it, retry the same call once with confirm_irreversible: true added to the arguments; nothing else needs to change.");
    }
    if (needs.has("relay_purpose") && purpose !== "TRANSPORT_RELAY") {
      return teachingEnvelope(operation, "RELAY_PURPOSE_UNSUPPORTED", "Pass relay_purpose as exactly \"TRANSPORT_RELAY\"; no other relay purpose is admitted.");
    }
    if (needs.has("source_digest") && !/^[0-9a-f]{64}$/.test(sourceContentSha256 || "")) {
      return teachingEnvelope(operation, "SOURCE_CONTENT_DIGEST_REQUIRED", "Relay requires proof that the relayed body is the one that was read: pass source_text, or source_content_sha256 as 64 lowercase hex characters.");
    }

    const phase = await detectPhase();
    if (phase !== "READY") {
      return semanticEnvelope(operation, "FAILED", { connection_state: phase }, [], null, "SESSION_NOT_READY");
    }

    const bridge = materialSendNow();
    const page = pageNow();
    const attemptId = trimmedArgument(args, ["attempt_id"]) || `semantic-${randomUUID()}`;
    const context = {
      attemptId,
      conversationHandle,
      sourceConversationHandle,
      messageHandle,
      sourceMessageHandle,
      text,
      payloadSha256: typeof text === "string" ? sha256Hex(text) : null,
      randomId: newRandomSendId(),
      scope,
      purpose,
      sourceContentSha256,
    };

    let pageRecovered = false;
    try {
      try {
        await family.check(bridge, page, context);
      } catch (err) {
        if (!STALL_CODES.has(err?.code)) throw err;
        pageRecovered = await recoverStalledPage();
        if (!pageRecovered) {
          return semanticEnvelope(operation, "FAILED", { conversation_handle: conversationHandle, attempt_id: attemptId, page_recovered: false }, [], null, err.code);
        }
        // The precondition check has no provider-visible effect, so one retry
        // after a proven recovery cannot duplicate anything.
        await family.check(bridge, pageNow(), context);
      }
      const dispatched = await family.dispatch(bridge, page, context);

      // Fast-path a result that dispatch already proved with authoritative
      // provider readback. Running observe again after success was a second
      // full provider round-trip with no extra assurance.
      let observed = dispatched?.provider_confirmed === true
        ? { ...dispatched, state: "SUCCEEDED" }
        : (dispatched?.provider_rejected === true ? { ...dispatched, state: "FAILED" } : null);
      if (observed === null) {
        // Reconcile only genuinely unresolved effects. Never redispatch a
        // material effect from this loop.
        const READBACK_BACKOFF_MS = [100, 150, 250, 400, 600, 800, 1000, 1200, 1500, 1500, 1500];
        for (let attempt = 0; attempt <= READBACK_BACKOFF_MS.length; attempt += 1) {
          observed = await family.observe(bridge, page, context);
          if (observed?.state === "SUCCEEDED" || observed?.state === "FAILED") break;
          if (attempt === READBACK_BACKOFF_MS.length) break;
          await page.waitForTimeout(READBACK_BACKOFF_MS[attempt]);
        }
      }

      const providerState = observed?.state || dispatched?.ack_state || "UNKNOWN";
      const state = observed?.state === "SUCCEEDED"
        ? "ACHIEVED"
        : (observed?.state === "FAILED" ? "FAILED" : "UNKNOWN");
      const observation = {
        page_recovered: pageRecovered,
        conversation_handle: conversationHandle,
        attempt_id: attemptId,
        delivery_state: providerState,
        provider_confirmed: observed?.provider_confirmed === true,
        provider_rejected: observed?.provider_rejected === true,
        provider_error_code: observed?.provider_error_code ?? null,
        final_message_known: observed?.final_message_known === true,
        final_message_count: observed?.final_message_count ?? 0,
        // Surface the created message as a usable handle, not just a count.
        created_message_handle: Number.isSafeInteger(observed?.final_message_id)
          ? identity.opaqueMessageHandle(identity.providerRefForHandle(conversationHandle), observed.final_message_id)
          : null,
        created_message_handles: Array.isArray(observed?.final_message_ids)
          ? observed.final_message_ids
            .filter((value) => Number.isSafeInteger(value))
            .map((value) => identity.opaqueMessageHandle(identity.providerRefForHandle(conversationHandle), value))
          : [],
        text_length: typeof text === "string" ? text.length : 0,
        text_sha256: context.payloadSha256,
        provider_content_model_visible: false,
        elapsed_ms: Date.now() - startedAt,
      };
      if (needs.has("message")) observation.message_handle = messageHandle;
      if (needs.has("source_message")) observation.source_message_handle = sourceMessageHandle;
      if (needs.has("source_conversation")) observation.source_conversation_handle = sourceConversationHandle;
      if (needs.has("scope")) observation.deletion_scope = scope;
      if (needs.has("relay_purpose")) observation.relay_purpose = purpose;
      return semanticEnvelope(
        operation,
        state,
        observation,
        state === "ACHIEVED" ? [family.sideEffect] : [],
        null,
        state === "ACHIEVED" ? null : (state === "FAILED" ? "PROVIDER_REJECTED_MESSAGE" : "MESSAGE_DELIVERY_UNCONFIRMED"),
      );
    } catch (err) {
      // After dispatch an effect may already exist, so the page is recovered
      // but the operation is never silently retried.
      let recoveredAfterEffect = pageRecovered;
      if (STALL_CODES.has(err?.code)) recoveredAfterEffect = await recoverStalledPage();
      return semanticEnvelope(
        operation,
        STALL_CODES.has(err?.code) ? "IN_DOUBT" : "FAILED",
        { conversation_handle: conversationHandle, attempt_id: attemptId, page_recovered: recoveredAfterEffect },
        STALL_CODES.has(err?.code) ? ["effect_may_have_been_applied"] : [],
        null,
        err?.code || "MATERIAL_OPERATION_FAILED",
      );
    }
  }

  async function audioVoicePrepare(req) {
    const operation = "communication.audio.voice.prepare";
    if (!downloadPurposeAllowed(req.purpose)) {
      return semanticEnvelope(operation, "FAILED", {}, [], null, "DATA_USE_PURPOSE_NOT_ALLOWED");
    }
    const phase = await detectPhase();
    if (phase !== "READY") {
      return semanticEnvelope(operation, "FAILED", { connection_state: phase }, [], null, "SESSION_NOT_READY");
    }

    const materialHandle = typeof req.args?.material_file_handle === "string"
      ? req.args.material_file_handle.trim()
      : "";
    const filename = typeof req.args?.filename === "string" && req.args.filename.trim()
      ? req.args.filename.trim().slice(0, 128)
      : "audio";
    const mediaType = typeof req.args?.media_type === "string" && req.args.media_type.trim()
      ? req.args.media_type.trim().toLowerCase()
      : "application/octet-stream";

    if (!(mediaType.startsWith("audio/") || mediaType === "application/octet-stream")) {
      return teachingEnvelope(operation, "OWNER_AUDIO_MEDIA_TYPE_INVALID", "media_type must describe an audio file.");
    }

    if (materialHandle) {
      const sizeBytes = Number(req.args?.size_bytes);
      const sha256Hex = typeof req.args?.sha256_hex === "string" ? req.args.sha256_hex.trim().toLowerCase() : "";
      if (!/^pcgfile:[0-9a-f]{64}$/.test(materialHandle)) {
        return teachingEnvelope(operation, "OWNER_AUDIO_MATERIAL_HANDLE_INVALID", "Pass the exact pcgfile: material handle.");
      }
      if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 1 || sizeBytes > 2 * 1024 * 1024 * 1024) {
        return teachingEnvelope(operation, "OWNER_AUDIO_SIZE_INVALID", "Material audio size must be between 1 byte and 2 GiB.");
      }
      if (!/^[0-9a-f]{64}$/.test(sha256Hex)) {
        return teachingEnvelope(operation, "OWNER_AUDIO_DIGEST_INVALID", "Pass the exact material SHA-256.");
      }

      let converted;
      try {
        converted = await convertMaterialAudioToOggOpus({
          materialFileHandle: materialHandle,
          filename,
          sizeBytes,
          sha256Hex,
        });
      } catch (err) {
        return semanticEnvelope(
          operation,
          "FAILED",
          {
            source_size_bytes: sizeBytes,
            input_mode: "material_file",
            provider_content_model_visible: false,
          },
          [],
          null,
          err?.code || "OWNER_AUDIO_OGG_CONVERSION_FAILED",
        );
      }

      const materialFile = {
        file_handle: converted.material_file_handle,
        filename: converted.filename,
        media_type: converted.media_type,
        size_bytes: converted.size_bytes,
        sha256_hex: converted.sha256_hex,
      };
      return semanticEnvelope(
        operation,
        "ACHIEVED",
        {
          converted: true,
          input_mode: "material_file",
          source_media_type: mediaType,
          source_size_bytes: sizeBytes,
          output_media_type: converted.media_type,
          output_size_bytes: converted.size_bytes,
          duration_seconds: converted.duration_seconds,
          sample_rate: converted.sample_rate,
          audio_channels: converted.channels,
          bitrate_bps: converted.bitrate_bps,
          material_file_handle: converted.material_file_handle,
          transform_engine: converted.engine || "pyav-libopus-file",
          provider_content_model_visible: false,
        },
        ["local_audio_transcoded", "local_file_acquired"],
        {
          purpose: req.purpose,
          model_visible: false,
          source: {
            file_handle: materialHandle,
            filename,
            media_type: mediaType,
            size_bytes: sizeBytes,
            sha256_hex: sha256Hex,
          },
          material_file: materialFile,
          duration_seconds: converted.duration_seconds,
        },
      );
    }

    const dataBase64 = typeof req.args?.data_base64 === "string" ? req.args.data_base64 : "";
    if (!dataBase64 || dataBase64.length > 5_800_000 || !/^[A-Za-z0-9+/]*={0,2}$/.test(dataBase64)) {
      return teachingEnvelope(
        operation,
        "OWNER_AUDIO_SOURCE_REQUIRED",
        "Pass material_file_handle + filename + media_type + size_bytes + sha256_hex. The legacy base64 path remains temporarily bounded to 4 MiB during connector cutover."
      );
    }

    let sourceBytes;
    try { sourceBytes = Buffer.from(dataBase64, "base64"); } catch {}
    if (!sourceBytes || sourceBytes.length < 1 || sourceBytes.length > 4 * 1024 * 1024) {
      return teachingEnvelope(operation, "OWNER_AUDIO_SIZE_INVALID", "Legacy base64 audio input must be between 1 byte and 4 MiB.");
    }

    let converted;
    try {
      converted = await transcodeAudioToOggOpus(pageNow(), dataBase64, {
        sourceFilename: filename,
        maxDurationSeconds: 1800,
        bitrateBps: 128000,
      });
    } catch (err) {
      return semanticEnvelope(
        operation,
        "FAILED",
        { source_size_bytes: sourceBytes.length, input_mode: "legacy_base64", provider_content_model_visible: false },
        [],
        null,
        err?.code || "OWNER_AUDIO_OGG_CONVERSION_FAILED",
      );
    }

    let lease;
    let materialFile;
    try {
      lease = downloadBroker.importBase64(converted.data_base64, {
        expectedSizeBytes: converted.size_bytes,
        filename: converted.filename,
        mediaType: converted.media_type,
      });
      materialFile = materialSendNow().stageMaterialFile({
        dataBase64: converted.data_base64,
        filename: converted.filename,
        mimeType: converted.media_type,
        sizeBytes: converted.size_bytes,
        payloadSha256: lease.sha256_hex,
      });
    } catch (err) {
      return semanticEnvelope(
        operation,
        "FAILED",
        { converted: true, input_mode: "legacy_base64", provider_content_model_visible: false },
        ["local_audio_transcoded"],
        null,
        err?.code || "OWNER_AUDIO_MATERIAL_STAGING_FAILED",
      );
    }

    return semanticEnvelope(
      operation,
      "ACHIEVED",
      {
        converted: true,
        input_mode: "legacy_base64",
        source_media_type: mediaType,
        source_size_bytes: sourceBytes.length,
        output_media_type: converted.media_type,
        output_size_bytes: converted.size_bytes,
        duration_seconds: converted.duration_seconds,
        sample_rate: converted.sample_rate,
        audio_channels: converted.channels,
        bitrate_bps: converted.bitrate_bps,
        material_file_handle: materialFile.file_handle,
        provider_content_model_visible: false,
      },
      ["local_audio_transcoded", "local_file_acquired"],
      {
        purpose: req.purpose,
        model_visible: false,
        source: {
          filename,
          media_type: mediaType,
          size_bytes: sourceBytes.length,
          sha256_hex: converted.source_sha256_hex,
        },
        voice_file: {
          file_handle: lease.file_handle,
          filename: converted.filename,
          media_type: converted.media_type,
          size_bytes: converted.size_bytes,
          sha256_hex: lease.sha256_hex,
          expires_at: lease.expires_at,
        },
        material_file: materialFile,
        duration_seconds: converted.duration_seconds,
      },
    );
  }

  async function messageSendMaterial(req) {
    const operation = "communication.message.send";
    const args = req?.args && typeof req.args === "object" && !Array.isArray(req.args) ? req.args : {};
    const conversationHandle = conversationHandleArgument(args);
    const fileHandle = trimmedArgument(args, ["material_file_handle", "file_handle"]);
    const filename = trimmedArgument(args, ["filename", "file_name"]);
    const mimeType = trimmedArgument(args, ["media_type", "mime_type"]);
    const payloadSha256 = trimmedArgument(args, ["sha256_hex", "payload_sha256"]);
    const sizeBytes = args.size_bytes;
    const caption = typeof args.caption === "string" ? args.caption : "";
    const captionSha256 = caption ? sha256Hex(caption) : null;
    const voiceMessage = args.voice_message === true;
    const durationSeconds = args.duration_seconds;

    if (!conversationHandle) return teachingEnvelope(operation, "CONVERSATION_HANDLE_REQUIRED", "Pass the exact target conversation handle.");
    if (!fileHandle || !/^pcgfile:[0-9a-f]{64}$/.test(fileHandle)) return teachingEnvelope(operation, "MATERIAL_FILE_HANDLE_REQUIRED", "Pass the opaque material_file_handle returned by a prepared attachment download.");
    if (!filename || !mimeType || !Number.isSafeInteger(sizeBytes) || !/^[0-9a-f]{64}$/.test(payloadSha256 || "")) {
      return teachingEnvelope(operation, "MATERIAL_FILE_METADATA_REQUIRED", "Pass filename, media_type, size_bytes and sha256_hex from the prepared material_file object.");
    }
    if (caption.length > 1024) return teachingEnvelope(operation, "ATTACHMENT_CAPTION_TOO_LONG", "Attachment caption must be at most 1024 characters.");
    if (voiceMessage && (!Number.isFinite(durationSeconds) || durationSeconds <= 0 || durationSeconds > 3600)) {
      return teachingEnvelope(operation, "VOICE_DURATION_REQUIRED", "Native voice upload requires duration_seconds from the source voice metadata.");
    }

    const phase = await detectPhase();
    if (phase !== "READY") return semanticEnvelope(operation, "FAILED", { connection_state: phase }, [], null, "SESSION_NOT_READY");

    const bridge = materialSendNow();
    const page = pageNow();
    const attemptId = trimmedArgument(args, ["attempt_id"]) || `semantic-${randomUUID()}`;
    const randomId = newRandomSendId();
    try {
      await bridge.checkTarget(page, conversationHandle);
      const dispatched = await bridge.dispatchAttachment(page, {
        attemptId,
        conversationHandle,
        randomId,
        fileHandle,
        filename,
        mimeType,
        sizeBytes,
        payloadSha256,
        caption,
        captionSha256,
        voiceMessage,
        durationSeconds,
      });
      let final = dispatched;
      if (dispatched?.provider_confirmed !== true && dispatched?.provider_rejected !== true) {
        final = await bridge.observeAttachment(page, {
          attemptId,
          conversationHandle,
          filename,
          mimeType,
          sizeBytes,
          payloadSha256,
          caption,
          captionSha256,
          voiceMessage,
          durationSeconds,
        });
      }
      const achieved = final?.provider_confirmed === true || final?.state === "SUCCEEDED";
      const failed = final?.provider_rejected === true || final?.state === "FAILED";
      const state = achieved ? "ACHIEVED" : (failed ? "FAILED" : "IN_DOUBT");
      let createdMessageHandle = null;
      if (Number.isSafeInteger(final?.final_message_id)) {
        try {
          const providerRef = identity.providerRefForHandle(conversationHandle);
          createdMessageHandle = identity.opaqueMessageHandle(providerRef, final.final_message_id);
        } catch {}
      }
      return semanticEnvelope(
        operation,
        state,
        {
          conversation_handle: conversationHandle,
          attempt_id: attemptId,
          created_message_handle: createdMessageHandle,
          attachment_confirmed: final?.attachment_confirmed === true,
          voice_message: voiceMessage,
          voice_message_confirmed: final?.voice_message_confirmed === true,
          provider_content_model_visible: false,
        },
        achieved ? ["provider_visible_message_created"] : (state === "IN_DOUBT" ? ["provider_visible_message_may_have_been_created"] : []),
        null,
        achieved ? null : (failed ? "PROVIDER_REJECTED_ATTACHMENT" : "ATTACHMENT_DELIVERY_UNCONFIRMED"),
      );
    } catch (err) {
      return semanticEnvelope(operation, "FAILED", { conversation_handle: conversationHandle, attempt_id: attemptId }, [], null, err?.code || "MATERIAL_ATTACHMENT_SEND_FAILED");
    }
  }

  async function messageSend(req) {
    const args = req?.args && typeof req.args === "object" && !Array.isArray(req.args) ? req.args : {};
    if (typeof args.material_file_handle === "string" || typeof args.file_handle === "string") {
      return messageSendMaterial(req);
    }
    return materialOperation("communication.message.send", req);
  }

  async function messageReply(req) {
    return materialOperation("communication.message.reply", req);
  }

  async function messageEdit(req) {
    return materialOperation("communication.message.edit", req);
  }

  async function messageDelete(req) {
    return materialOperation("communication.message.delete", req);
  }

  async function messageForwardNative(req) {
    return materialOperation("communication.message.forward-native", req);
  }

  async function messageRelay(req) {
    return materialOperation("communication.message.relay", req);
  }

  const ARGUMENT_ALIASES = {
    conversation_handle: ["conversation_handle", "conversation", "chat_handle", "chat", "peer_handle", "dialog_handle"],
    message_handle: ["message_handle", "message", "msg_handle", "target_message_handle", "message_id_handle"],
    emoji: ["emoji", "reaction", "reaction_emoji", "emoticon", "value"],
    remove: ["remove", "unreact", "clear", "remove_reaction", "reaction_remove"],
    topic_handle: ["topic_handle", "topic", "thread_handle", "thread"],
    limit: ["limit", "count", "max", "max_results"],
    cursor: ["cursor", "page_cursor", "next_cursor", "offset_cursor"],
  };

  const REACTION_REMOVAL_WORDS = new Set(["none", "remove", "clear", "empty", "null", "-", "\u062d\u0630\u0641", "\u0647\u06cc\u0686"]);

  function pickArg(args, key) {
    const names = ARGUMENT_ALIASES[key] || [key];
    if (!args || typeof args !== "object") return undefined;
    for (const name of names) {
      if (Object.prototype.hasOwnProperty.call(args, name) && args[name] !== undefined) return args[name];
    }
    return undefined;
  }

  function acceptedArgumentNames(keys) {
    const accepted = {};
    for (const key of keys) accepted[key] = ARGUMENT_ALIASES[key] || [key];
    return accepted;
  }

  function nearestOperations(operation, limit = 5) {
    const wanted = new Set(String(operation || "").toLowerCase().split(/[^a-z0-9]+/u).filter(Boolean));
    return capabilities()
      .map((entry) => {
        const tokens = new Set(entry.operation.toLowerCase().split(/[^a-z0-9]+/u).filter(Boolean));
        let score = 0;
        for (const token of wanted) if (tokens.has(token)) score += 1;
        return { operation: entry.operation, support: entry.support, score };
      })
      .sort((a, b) => b.score - a.score || a.operation.localeCompare(b.operation))
      .slice(0, limit)
      .map(({ operation: name, support }) => ({ operation: name, support }));
  }

  function teachingEnvelope(operation, code, detail, extra = {}) {
    return semanticEnvelope(
      operation,
      extra.state === "UNSUPPORTED" ? "UNSUPPORTED" : "FAILED",
      {
        guidance_detail: detail,
        nearest_operations: nearestOperations(operation),
        ...(extra.accepted_arguments ? { accepted_arguments: extra.accepted_arguments } : {}),
        ...(extra.observation || {}),
      },
      [],
      null,
      code,
    );
  }

  function capabilities() {
    return [
      {
        operation: "communication.session.status",
        support: "IMPLEMENTED",
        side_effect_class: "none",
        provider_content: "NONE",
      },
      {
        operation: "communication.session.screenshot",
        support: "IMPLEMENTED_CURRENT_VIEWPORT_LOCAL_ACQUISITION",
        side_effect_class: "local-acquisition",
        provider_content: "PROTECTED_ONLY",
      },
      {
        // Reads the server-side record of requests that could not be
        // satisfied, so the next release is planned from evidence rather
        // than from remembered chat transcripts.
        operation: "diagnostics.capability_gap.list",
        support: "IMPLEMENTED_BOUNDED_400",
        side_effect_class: "none",
        provider_content: "NONE",
      },
      {
        operation: "communication.conversation.list",
        support: "IMPLEMENTED_BOUNDED",
        side_effect_class: "none",
        provider_content: "PROTECTED_ONLY",
      },
      {
        operation: "communication.conversation.search",
        support: "IMPLEMENTED_BOUNDED_50",
        side_effect_class: "none",
        provider_content: "PROTECTED_ONLY",
      },
      {
        operation: "communication.contact.search",
        support: "IMPLEMENTED_BOUNDED_50_PROVIDER",
        side_effect_class: "none",
        provider_content: "PROTECTED_ONLY",
      },
      {
        operation: "communication.topic.list",
        support: "IMPLEMENTED_BOUNDED_HIDDEN",
        side_effect_class: "none",
        provider_content: "PROTECTED_ONLY",
      },
      {
        operation: "communication.message.list",
        support: "IMPLEMENTED_PAGINATED_100",
        side_effect_class: "none",
        provider_content: "PROTECTED_ONLY",
      },
      {
        operation: "communication.message.fetch",
        support: "IMPLEMENTED_EXACT",
        side_effect_class: "none",
        provider_content: "PROTECTED_ONLY",
      },
      {
        operation: "communication.message.replies",
        support: "IMPLEMENTED_EXACT_BOUNDED_100_PROVIDER_THREAD",
        side_effect_class: "none",
        provider_content: "PROTECTED_ONLY",
      },
      {
        operation: "communication.message.transcribe",
        support: "IMPLEMENTED_EXACT_INDEPENDENT_LOCAL_ASR_WITH_OPTIONAL_PROVIDER_NATIVE_AND_PERPLEXITY_SESSION_BENCHMARK",
        side_effect_class: "none",
        provider_content: "PROTECTED_ONLY",
      },
      {
        operation: "communication.audio.transcribe",
        support: "IMPLEMENTED_DIRECT_OWNER_AUDIO_PERPLEXITY_SONIOX",
        side_effect_class: "none",
        provider_content: "PROTECTED_ONLY",
      },
      {
        operation: "communication.message.search",
        support: "IMPLEMENTED_BOUNDED_50_PROVIDER_GLOBAL_OR_SCOPED",
        side_effect_class: "none",
        provider_content: "PROTECTED_ONLY",
      },
      {
        operation: "communication.message.reaction.get",
        support: "IMPLEMENTED_EXACT_AUTHORITATIVE",
        side_effect_class: "none",
        provider_content: "PROTECTED_ONLY",
      },
      {
        operation: "communication.conversation.pin.set",
        support: "IMPLEMENTED_EXACT_HIDDEN_DESIRED_STATE",
        side_effect_class: "provider-synced-state",
        provider_content: "NONE",
      },
      {
        operation: "communication.notification.set",
        support: "IMPLEMENTED_EXACT_CONVERSATION_MUTE_DESIRED_STATE",
        side_effect_class: "provider-synced-state",
        provider_content: "NONE",
      },
      {
        operation: "communication.conversation.mark_read",
        support: "IMPLEMENTED_COUNT_REQUIRED_FAIL_CLOSED",
        side_effect_class: "provider-visible-read",
        provider_content: "NONE",
      },
      {
        operation: "communication.conversation.mark_unread",
        support: "IMPLEMENTED_EXACT_DESIRED_STATE",
        side_effect_class: "provider-synced-state",
        provider_content: "NONE",
      },
      {
        operation: "communication.message.open_media",
        support: "IMPLEMENTED_EXACT_HIDDEN_BOUNDED",
        side_effect_class: "provider-visible-view",
        provider_content: "NONE",
      },
      {
        operation: "communication.attachment.download",
        support: "IMPLEMENTED_EXACT_HIDDEN_BOUNDED_PORTABLE_MP3",
        side_effect_class: "local-acquisition",
        provider_content: "PROTECTED_ONLY",
      },
      {
        operation: "communication.audio.voice.prepare",
        support: "IMPLEMENTED_BOUNDED_OWNER_AUDIO_TO_OGG_OPUS_MATERIAL",
        side_effect_class: "local-acquisition",
        provider_content: "NONE",
      },
      {
        operation: "communication.message.send",
        support: "IMPLEMENTED_EXACT_HIDDEN_TEXT_ATTACHMENT_CAPTION_PHOTO_ALBUM_BROKERED_VOICE",
        side_effect_class: "material-external",
        provider_content: "NONE",
      },
      {
        operation: "communication.message.reply",
        support: "IMPLEMENTED_EXACT_HIDDEN_TEXT_AND_PRACTICAL_ATTACHMENT_CAPTION",
        side_effect_class: "material-external",
        provider_content: "NONE",
      },
      {
        operation: "communication.message.edit",
        support: "IMPLEMENTED_EXACT_HIDDEN_TEXT_ONLY",
        side_effect_class: "material-external",
        provider_content: "NONE",
      },
      {
        operation: "communication.message.delete",
        support: "IMPLEMENTED_EXACT_HIDDEN_SELF_ONLY_QUALIFIED_FOR_EVERYONE_PENDING_LIVE",
        side_effect_class: "destructive-external",
        provider_content: "NONE",
      },
      {
        operation: "communication.message.forward-native",
        support: "IMPLEMENTED_EXACT_HIDDEN_NATIVE",
        side_effect_class: "material-external",
        provider_content: "NONE",
      },
      {
        operation: "communication.message.relay",
        support: "IMPLEMENTED_EXACT_HIDDEN_TEXT_ONLY",
        side_effect_class: "material-external",
        provider_content: "PROTECTED_INTERNAL",
      },
      {
        operation: "communication.message.react",
        support: "IMPLEMENTED_EXACT_HIDDEN_STANDARD_EMOJI",
        side_effect_class: "provider-synced-state",
        provider_content: "NONE",
      },
    ];
  }

  // The data-use purpose is a property of the capability, not a choice of the
  // caller: a read of protected provider content is PROTECTED_DISPLAY whoever
  // asks. Deriving it here, once, is what keeps a caller from having to guess a
  // constant it cannot know — and from being told "not available" when the
  // capability exists and only the purpose string was wrong.
  const INGRESS_OPERATION_ALIASES = {
    "communication.conversation.get": "communication.message.list",
    "communication.conversation.read": "communication.message.list",
    "communication.conversation.messages": "communication.message.list",
    "communication.conversation.history": "communication.message.list",
    "communication.messages.list": "communication.message.list",
    "communication.message.read": "communication.message.list",
    "communication.message.history": "communication.message.list",
    "communication.message.get": "communication.message.fetch",
    "communication.messages.get": "communication.message.fetch",
    "communication.message.reply.list": "communication.message.replies",
    "communication.message.replies.list": "communication.message.replies",
    "communication.message.transcription": "communication.message.transcribe",
    "communication.message.reaction.get_current": "communication.message.reaction.get",
    "communication.message.reaction.current": "communication.message.reaction.get",
    "communication.message.forward": "communication.message.forward-native",
    "communication.message.forward_native": "communication.message.forward-native",
    "communication.conversation.pin": "communication.conversation.pin.set",
    "communication.conversation.unpin": "communication.conversation.pin.set",
    "communication.conversation.mute": "communication.notification.set",
    "communication.conversation.unmute": "communication.notification.set",
    "communication.conversation.mark_as_read": "communication.conversation.mark_read",
    "communication.conversation.mark_as_unread": "communication.conversation.mark_unread",
    "communication.message.reaction": "communication.message.react",
    "communication.message.react.set": "communication.message.react",
    "communication.chat.list": "communication.conversation.list",
    "communication.chat.search": "communication.conversation.search",
    "communication.contact.find": "communication.contact.search",
    "communication.contacts.search": "communication.contact.search",
    "communication.message.find": "communication.message.search",
    "communication.messages.search": "communication.message.search",
  };

  function purposeFor(operation) {
    if (typeof operation === "string" && INGRESS_OPERATION_ALIASES[operation]) {
      operation = INGRESS_OPERATION_ALIASES[operation];
    }
    const entry = capabilities().find((item) => item.operation === operation);
    if (!entry) return null;
    if (typeof entry.support !== "string" || !entry.support.startsWith("IMPLEMENTED")) return null;
    if (entry.side_effect_class === "local-acquisition") return "LOCAL_DOWNLOAD";
    if (entry.side_effect_class === "none" || entry.provider_content === "PROTECTED_ONLY") return "PROTECTED_DISPLAY";
    return "MATERIAL_EXTERNAL";
  }

  function semanticPurposeAllowed(value) {
    return value === "PROTECTED_DISPLAY";
  }

  function downloadPurposeAllowed(value) {
    return value === "LOCAL_DOWNLOAD";
  }

  function boundedSearchQuery(value) {
    if (typeof value !== "string") return null;
    const query = value.trim();
    if (query.length < 1 || query.length > 128 || /[\u0000-\u001f\u007f]/u.test(query)) return null;
    return query;
  }

  async function sessionScreenshot(req) {
    const startedAt = Date.now();
    const operation = "communication.session.screenshot";
    if (!downloadPurposeAllowed(req.purpose)) {
      return semanticEnvelope(operation, "FAILED", {}, [], null, "DATA_USE_PURPOSE_NOT_ALLOWED");
    }
    const phase = await detectPhase();
    if (phase !== "READY") {
      return semanticEnvelope(operation, "FAILED", { connection_state: phase }, [], null, "SESSION_NOT_READY");
    }

    const format = req.args?.format === "png" ? "png" : "jpeg";
    const qualityRaw = req.args?.quality ?? 80;
    if (!Number.isInteger(qualityRaw) || qualityRaw < 40 || qualityRaw > 95) {
      return semanticEnvelope(operation, "FAILED", {}, [], null, "INVALID_SCREENSHOT_QUALITY");
    }

    const page = pageNow();
    const beforeUrl = page.url();
    let bytes;
    try {
      bytes = await page.screenshot({
        type: format,
        ...(format === "jpeg" ? { quality: qualityRaw } : {}),
        fullPage: false,
        animations: "disabled",
      });
    } catch (err) {
      return semanticEnvelope(operation, "FAILED", { provider_content_model_visible: false }, [], null, err?.code || "TELEGRAM_SCREENSHOT_CAPTURE_FAILED");
    }
    if (!Buffer.isBuffer(bytes) || bytes.length < 1 || bytes.length > downloadBroker.maxFileBytes) {
      return semanticEnvelope(operation, "FAILED", { provider_content_model_visible: false }, [], null, "TELEGRAM_SCREENSHOT_BOUNDS_INVALID");
    }

    const mimeType = format === "png" ? "image/png" : "image/jpeg";
    const extension = format === "png" ? "png" : "jpg";
    let lease;
    try {
      lease = downloadBroker.importBase64(bytes.toString("base64"), {
        expectedSizeBytes: bytes.length,
        filename: "telegram-session-" + new Date().toISOString().replace(/[:.]/g, "-") + "." + extension,
        mediaType: mimeType,
      });
    } catch (err) {
      return semanticEnvelope(operation, "FAILED", { provider_content_model_visible: false }, [], null, err?.code || "LOCAL_FILE_BROKER_IMPORT_FAILED");
    }

    const afterUrl = page.url();
    const viewport = page.viewportSize();
    const navigationUnchanged = afterUrl === beforeUrl;
    const observation = {
      connection_state: phase,
      logged_in: true,
      current_viewport: true,
      navigation_unchanged: navigationUnchanged,
      file_handle: lease.file_handle,
      ttl_seconds: lease.ttl_seconds,
      mime_type: lease.media_type,
      size_bytes: lease.size_bytes,
      viewport_width: Number.isSafeInteger(viewport?.width) ? viewport.width : null,
      viewport_height: Number.isSafeInteger(viewport?.height) ? viewport.height : null,
      provider_content_model_visible: false,
      elapsed_ms: Date.now() - startedAt,
    };
    const protectedProviderData = {
      purpose: req.purpose,
      model_visible: false,
      screenshot: {
        filename: lease.filename,
        media_type: lease.media_type,
        size_bytes: lease.size_bytes,
        sha256_hex: lease.sha256_hex,
      },
      local_file: {
        file_handle: lease.file_handle,
        expires_at: lease.expires_at,
      },
    };

    if (!navigationUnchanged) {
      return semanticEnvelope(
        operation,
        "IN_DOUBT",
        observation,
        ["local_file_acquired", "telegram_page_navigation_changed_during_capture"],
        protectedProviderData,
        "SCREENSHOT_NAVIGATION_CHANGED",
      );
    }
    return semanticEnvelope(operation, "ACHIEVED", observation, ["local_file_acquired"], protectedProviderData);
  }

  async function sessionStatus() {
    const phase = await detectPhase();
    // Self-check of the provider model itself. It touches no message and no
    // provider content; it only verifies that the manager proxy is
    // asynchronous as assumed and that a server message id regenerates the
    // client id it came from. A false here is an adapter defect in our code,
    // not a provider outage, and it is what makes a whole class of silent
    // failures visible before an owner ever hits it.
    let providerModel = null;
    if (phase === "READY") {
      try {
        providerModel = await probeProviderModel(pageNow());
      } catch (err) {
        providerModel = { version: null, error: err?.code || "PROVIDER_MODEL_PROBE_FAILED" };
      }
    }
    const modelHealthy = providerModel === null
      ? null
      : providerModel.async_managers === true && providerModel.id_round_trip === true;
    return semanticEnvelope(
      "communication.session.status",
      "ACHIEVED",
      {
        connection_state: phase,
        logged_in: phase === "READY",
        provider_model: providerModel,
        provider_model_healthy: modelHealthy,
        // Distinct from the model self-check: this one says whether the
        // provider itself currently answers. Writes are impossible without it.
        provider_transport_healthy: providerModel && providerModel.transport
          ? providerModel.transport.healthy
          : null,
        provider_content_model_visible: false,
      },
    );
  }

  async function conversationList(req) {
    const operation = "communication.conversation.list";
    if (!semanticPurposeAllowed(req.purpose)) {
      return semanticEnvelope(operation, "FAILED", {}, [], null, "DATA_USE_PURPOSE_NOT_ALLOWED");
    }
    const phase = await detectPhase();
    if (phase !== "READY") {
      return semanticEnvelope(operation, "FAILED", { connection_state: phase }, [], null, "SESSION_NOT_READY");
    }
    const rawLimit = pickArg(req.args, "limit") ?? 20;
    if (!Number.isInteger(rawLimit) || rawLimit < 1 || rawLimit > 50) {
      return semanticEnvelope(operation, "FAILED", {}, [], null, "INVALID_LIMIT");
    }

    // Provider-side dialog metadata only. No chat open, click, read-history or navigation.
    let structure;
    try {
      structure = await webKListConversationStructure(pageNow(), rawLimit);
    } catch (err) {
      return semanticEnvelope(operation, "FAILED", { provider_content_model_visible: false }, [], null, err?.code || "WEBK_CONVERSATION_STRUCTURE_FAILED");
    }
    const entries = structure.entries.map((item) => ({
      handle: identity.opaqueConversationHandle(item.provider_ref),
      name: item.name,
      type: identity.protectedConversationType(item.provider_ref),
      peer_kind: item.peer_kind ?? null,
      pinned: item.pinned === true,
      sponsored: item.sponsored === true,
      proxy_sponsor: item.proxy_sponsor === true,
      sponsor_kind: item.sponsor_kind ?? null,
      is_forum: item.is_forum === true,
      forum_kind: item.forum_kind ?? null,
      list_section: item.list_section,
      unread_count: Number.isSafeInteger(item.unread_count) ? item.unread_count : 0,
      unread_mark: item.unread_mark === true,
      has_unread: item.has_unread === true,
    }));
    const sponsoredHandles = entries.filter((item) => item.sponsored).map((item) => item.handle);
    const proxySponsorHandles = entries.filter((item) => item.proxy_sponsor).map((item) => item.handle);
    const pinnedHandles = entries.filter((item) => item.pinned).map((item) => item.handle);
    const normalHandles = entries.filter((item) => item.list_section === "normal").map((item) => item.handle);
    const forumHandles = entries.filter((item) => item.is_forum).map((item) => item.handle);
    return semanticEnvelope(
      operation,
      "ACHIEVED",
      {
        count: entries.length,
        handles: entries.map((item) => item.handle),
        sponsored_handles: sponsoredHandles,
        proxy_sponsor_handles: proxySponsorHandles,
        pinned_handles: pinnedHandles,
        normal_handles: normalHandles,
        forum_handles: forumHandles,
        sponsored_count: sponsoredHandles.length,
        proxy_sponsor_count: proxySponsorHandles.length,
        pinned_count: pinnedHandles.length,
        normal_count: normalHandles.length,
        forum_count: forumHandles.length,
        unread_handles: entries.filter((item) => item.has_unread).map((item) => item.handle),
        unread_conversation_count: entries.filter((item) => item.has_unread).length,
        unread_message_count: entries.reduce((sum, item) => sum + (Number.isSafeInteger(item.unread_count) ? item.unread_count : 0), 0),
        promo_fetch_state: structure.promo_fetch_state,
        bounded: true,
        provider_content_model_visible: false,
      },
      [],
      {
        purpose: req.purpose,
        model_visible: false,
        conversations: entries,
      },
    );
  }

  async function conversationSearch(req) {
    const startedAt = Date.now();
    const operation = "communication.conversation.search";
    if (!semanticPurposeAllowed(req.purpose)) {
      return semanticEnvelope(operation, "FAILED", {}, [], null, "DATA_USE_PURPOSE_NOT_ALLOWED");
    }
    const phase = await detectPhase();
    if (phase !== "READY") {
      return semanticEnvelope(operation, "FAILED", { connection_state: phase }, [], null, "SESSION_NOT_READY");
    }

    const query = boundedSearchQuery(req.args?.query);
    if (!query) return semanticEnvelope(operation, "FAILED", {}, [], null, "INVALID_QUERY");
    const rawLimit = pickArg(req.args, "limit") ?? 20;
    if (!Number.isInteger(rawLimit) || rawLimit < 1 || rawLimit > 50) {
      return semanticEnvelope(operation, "FAILED", {}, [], null, "INVALID_LIMIT");
    }

    let searched;
    try {
      searched = await webKSearchConversations(pageNow(), query, rawLimit);
    } catch (err) {
      return semanticEnvelope(operation, "FAILED", { provider_content_model_visible: false }, [], null, err?.code || "WEBK_CONVERSATION_SEARCH_FAILED");
    }
    const rawEntries = Array.isArray(searched?.entries) ? searched.entries : [];
    const entries = rawEntries.slice(0, rawLimit).map((item, index) => ({
      rank: index + 1,
      handle: identity.opaqueConversationHandle(item.provider_ref),
      name: item.name,
      type: item.peer_kind === "user" || item.peer_kind === "bot" ? "user" : "chat",
      peer_kind: item.peer_kind,
      pinned: item.pinned === true,
      sponsored: false,
      proxy_sponsor: false,
      sponsor_kind: null,
      is_forum: item.is_forum === true,
      forum_kind: item.forum_kind ?? null,
      list_section: item.list_section ?? (item.pinned ? "pinned" : "normal"),
      unread_count: Number.isSafeInteger(item.unread_count) ? item.unread_count : 0,
      unread_mark: item.unread_mark === true,
      has_unread: item.has_unread === true,
    }));

    return semanticEnvelope(
      operation,
      "ACHIEVED",
      {
        query,
        count: entries.length,
        handles: entries.map((item) => item.handle),
        ordering: "provider_search_order",
        bounded: true,
        navigation_unchanged: true,
        provider_content_model_visible: false,
        elapsed_ms: Date.now() - startedAt,
      },
      [],
      { purpose: req.purpose, model_visible: false, conversations: entries },
    );
  }

  async function contactSearch(req) {
    const startedAt = Date.now();
    const operation = "communication.contact.search";
    if (!semanticPurposeAllowed(req.purpose)) {
      return semanticEnvelope(operation, "FAILED", {}, [], null, "DATA_USE_PURPOSE_NOT_ALLOWED");
    }
    const phase = await detectPhase();
    if (phase !== "READY") {
      return semanticEnvelope(operation, "FAILED", { connection_state: phase }, [], null, "SESSION_NOT_READY");
    }
    const query = boundedSearchQuery(req.args?.query);
    if (!query) return semanticEnvelope(operation, "FAILED", {}, [], null, "INVALID_QUERY");
    const rawLimit = pickArg(req.args, "limit") ?? 20;
    if (!Number.isInteger(rawLimit) || rawLimit < 1 || rawLimit > 50) {
      return semanticEnvelope(operation, "FAILED", {}, [], null, "INVALID_LIMIT");
    }

    let searched;
    try {
      searched = await webKSearchContacts(pageNow(), query, rawLimit);
    } catch (err) {
      return semanticEnvelope(operation, "FAILED", { provider_content_model_visible: false }, [], null, err?.code || "WEBK_CONTACT_SEARCH_FAILED");
    }
    const rawEntries = Array.isArray(searched?.entries) ? searched.entries : [];
    const entries = rawEntries.slice(0, rawLimit).map((item, index) => ({
      rank: index + 1,
      handle: identity.opaqueConversationHandle(item.provider_ref),
      name: item.name,
      username: item.username ?? null,
      mutual: item.mutual === true,
      peer_kind: item.peer_kind === "bot" ? "bot" : "user",
    }));

    return semanticEnvelope(
      operation,
      "ACHIEVED",
      {
        query,
        count: entries.length,
        handles: entries.map((item) => item.handle),
        ordering: "contact_provider_order",
        bounded: true,
        navigation_unchanged: true,
        provider_content_model_visible: false,
        elapsed_ms: Date.now() - startedAt,
      },
      [],
      { purpose: req.purpose, model_visible: false, contacts: entries },
    );
  }

  async function topicList(req) {
    const operation = "communication.topic.list";
    if (!semanticPurposeAllowed(req.purpose)) {
      return semanticEnvelope(operation, "FAILED", {}, [], null, "DATA_USE_PURPOSE_NOT_ALLOWED");
    }
    const phase = await detectPhase();
    if (phase !== "READY") {
      return semanticEnvelope(operation, "FAILED", { connection_state: phase }, [], null, "SESSION_NOT_READY");
    }
    const conversationHandle = pickArg(req.args, "conversation_handle");
    let providerRef;
    try {
      providerRef = identity.providerRefForHandle(conversationHandle);
    } catch (err) {
      return teachingEnvelope(operation, err?.code || "INVALID_CONVERSATION_HANDLE", "A handle was not accepted. Conversation handles look like tgchat:<uuid>, topic handles tgtopic:<uuid> and message handles tgmsg:<uuid>; they are minted by the list and search operations and must be passed verbatim. A chat or person name is never a handle. Argument names are tolerant: conversation_handle / chat_handle / conversation, message_handle / message, topic_handle / topic.");
    }
    const rawLimit = pickArg(req.args, "limit") ?? 50;
    const offsetIndex = req.args?.offset_index ?? 0;
    if (!Number.isInteger(rawLimit) || rawLimit < 1 || rawLimit > 100) {
      return semanticEnvelope(operation, "FAILED", {}, [], null, "INVALID_LIMIT");
    }
    if (!Number.isInteger(offsetIndex) || offsetIndex < 0 || offsetIndex > 100000) {
      return semanticEnvelope(operation, "FAILED", {}, [], null, "INVALID_OFFSET");
    }

    const page = pageNow();
    const beforeUrl = page.url();
    let listed;
    try {
      listed = await webKListTopics(page, providerRef, rawLimit, offsetIndex);
    } catch (err) {
      return semanticEnvelope(operation, "FAILED", { provider_content_model_visible: false }, [], null, err?.code || "WEBK_TOPIC_LIST_FAILED");
    }
    if (page.url() !== beforeUrl) {
      return semanticEnvelope(operation, "FAILED", { provider_content_model_visible: false }, [], null, "TOPIC_LIST_NAVIGATION_CHANGED");
    }
    const topics = listed.topics.map((topic) => ({
      handle: identity.opaqueTopicHandle(providerRef, topic.topic_id),
      title: topic.title,
      pinned: topic.pinned === true,
      closed: topic.closed === true,
      unread_count: topic.unread_count,
    }));
    return semanticEnvelope(
      operation,
      "ACHIEVED",
      {
        conversation_handle: conversationHandle,
        count: topics.length,
        handles: topics.map((item) => item.handle),
        forum_kind: listed.forum_kind,
        offset_index: offsetIndex,
        next_offset_index: listed.next_offset_index,
        pagination_supported: true,
        navigation_unchanged: true,
        provider_content_model_visible: false,
      },
      [],
      {
        purpose: req.purpose,
        model_visible: false,
        conversation_handle: conversationHandle,
        topics,
      },
    );
  }

  function protectedMessageEntry(providerRef, message) {
    return {
      handle: identity.opaqueMessageHandle(providerRef, message.mid),
      kind: message.kind,
      sender_name: message.sender_name ?? null,
      sender_id: message.sender_id ?? null,
      text: message.text,
      date: message.date,
      outgoing: message.outgoing,
      media_type: message.media_type,
      media_open_kind: message.media_open_kind,
      media_unread: message.media_unread,
      attachments: (message.attachments ?? []).map((attachment) => ({
        handle: identity.opaqueAttachmentHandle(providerRef, message.mid, attachment.slot),
        media_kind: attachment.media_kind ?? null,
        media_type: attachment.media_type,
        size_bytes: attachment.size_bytes,
        filename: attachment.filename,
        duration_seconds: attachment.duration_seconds ?? null,
        title: attachment.title ?? null,
        performer: attachment.performer ?? null,
        sticker_emoji: attachment.sticker_emoji ?? null,
        sticker_format: attachment.sticker_format ?? null,
        animated: attachment.animated === true,
        has_preview: attachment.has_preview === true,
        width: Number.isSafeInteger(attachment.width) ? attachment.width : null,
        height: Number.isSafeInteger(attachment.height) ? attachment.height : null,
      })),
      service_action: message.service_action,
      reply_count: Number.isSafeInteger(message.reply_count) ? message.reply_count : 0,
      has_replies: message.has_replies === true,
      direct_to_target: message.direct_to_target === true ? true : (message.direct_to_target === false ? false : null),
      has_reactions: message.has_reactions === true,
      reaction_total_count: Number.isSafeInteger(message.reaction_total_count) ? message.reaction_total_count : 0,
      reaction_distinct_count: Number.isSafeInteger(message.reaction_distinct_count) ? message.reaction_distinct_count : 0,
      reaction_counts: Array.isArray(message.reaction_counts) ? message.reaction_counts : [],
    };
  }

  async function messageList(req) {
    const operation = "communication.message.list";
    if (!semanticPurposeAllowed(req.purpose)) {
      return semanticEnvelope(operation, "FAILED", {}, [], null, "DATA_USE_PURPOSE_NOT_ALLOWED");
    }
    const phase = await detectPhase();
    if (phase !== "READY") {
      return semanticEnvelope(operation, "FAILED", { connection_state: phase }, [], null, "SESSION_NOT_READY");
    }
    const conversationHandle = pickArg(req.args, "conversation_handle");
    let providerRef;
    try {
      providerRef = identity.providerRefForHandle(conversationHandle);
    } catch (err) {
      return teachingEnvelope(operation, err?.code || "INVALID_CONVERSATION_HANDLE", "A handle was not accepted. Conversation handles look like tgchat:<uuid>, topic handles tgtopic:<uuid> and message handles tgmsg:<uuid>; they are minted by the list and search operations and must be passed verbatim. A chat or person name is never a handle. Argument names are tolerant: conversation_handle / chat_handle / conversation, message_handle / message, topic_handle / topic.");
    }
    const rawLimit = pickArg(req.args, "limit") ?? 20;
    if (!Number.isInteger(rawLimit) || rawLimit < 1 || rawLimit > 100) {
      return semanticEnvelope(operation, "FAILED", {}, [], null, "INVALID_LIMIT");
    }
    const topicHandle = pickArg(req.args, "topic_handle") ?? null;
    let threadId = null;
    if (topicHandle !== null) {
      try {
        const topicRef = identity.providerTopicRefForHandle(topicHandle);
        if (topicRef.providerRef !== providerRef) {
          return semanticEnvelope(operation, "FAILED", {}, [], null, "TOPIC_CONVERSATION_MISMATCH");
        }
        threadId = topicRef.topicId;
      } catch (err) {
        return teachingEnvelope(operation, err?.code || "INVALID_TOPIC_HANDLE", "A handle was not accepted. Conversation handles look like tgchat:<uuid>, topic handles tgtopic:<uuid> and message handles tgmsg:<uuid>; they are minted by the list and search operations and must be passed verbatim. A chat or person name is never a handle. Argument names are tolerant: conversation_handle / chat_handle / conversation, message_handle / message, topic_handle / topic.");
      }
    }

    const beforeMessageHandle = req.args?.before_message_handle ?? null;
    let offsetMid = null;
    if (beforeMessageHandle !== null) {
      try {
        const beforeRef = identity.providerMessageRefForHandle(beforeMessageHandle);
        if (beforeRef.providerRef !== providerRef) {
          return semanticEnvelope(operation, "FAILED", {}, [], null, "MESSAGE_CONVERSATION_MISMATCH");
        }
        offsetMid = beforeRef.mid;
      } catch (err) {
        return teachingEnvelope(operation, err?.code || "INVALID_MESSAGE_CURSOR", "A handle was not accepted. Conversation handles look like tgchat:<uuid>, topic handles tgtopic:<uuid> and message handles tgmsg:<uuid>; they are minted by the list and search operations and must be passed verbatim. A chat or person name is never a handle. Argument names are tolerant: conversation_handle / chat_handle / conversation, message_handle / message, topic_handle / topic.");
      }
    }

    const page = pageNow();
    const beforeUrl = page.url();
    let messages;
    try {
      messages = await webKListMessages(page, providerRef, rawLimit, offsetMid, threadId);
    } catch (err) {
      return semanticEnvelope(operation, "FAILED", { provider_content_model_visible: false }, [], null, err?.code || "WEBK_HISTORY_FETCH_FAILED");
    }
    if (page.url() !== beforeUrl) {
      return semanticEnvelope(operation, "FAILED", { provider_content_model_visible: false }, [], null, "MESSAGE_RETRIEVAL_NAVIGATION_CHANGED");
    }

    const entries = messages.slice(0, rawLimit).map((message) => protectedMessageEntry(providerRef, message));
    return semanticEnvelope(
      operation,
      "ACHIEVED",
      {
        conversation_handle: conversationHandle,
        topic_handle: topicHandle,
        count: entries.length,
        handles: entries.map((item) => item.handle),
        bounded: true,
        pagination_supported: true,
        before_message_handle: beforeMessageHandle,
        next_before_message_handle: entries.length === rawLimit ? entries.at(-1)?.handle ?? null : null,
        navigation_unchanged: true,
        provider_content_model_visible: false,
      },
      [],
      {
        purpose: req.purpose,
        model_visible: false,
        conversation_handle: conversationHandle,
        topic_handle: topicHandle,
        messages: entries,
      },
    );
  }

  async function messageSearch(req) {
    const startedAt = Date.now();
    const operation = "communication.message.search";
    if (!semanticPurposeAllowed(req.purpose)) {
      return semanticEnvelope(operation, "FAILED", {}, [], null, "DATA_USE_PURPOSE_NOT_ALLOWED");
    }
    const phase = await detectPhase();
    if (phase !== "READY") {
      return semanticEnvelope(operation, "FAILED", { connection_state: phase }, [], null, "SESSION_NOT_READY");
    }
    const query = boundedSearchQuery(req.args?.query);
    if (!query) return semanticEnvelope(operation, "FAILED", {}, [], null, "INVALID_QUERY");
    const rawLimit = pickArg(req.args, "limit") ?? 20;
    if (!Number.isInteger(rawLimit) || rawLimit < 1 || rawLimit > 50) {
      return semanticEnvelope(operation, "FAILED", {}, [], null, "INVALID_LIMIT");
    }

    const conversationHandle = conversationHandleArgument(req.args);
    let providerRef = null;
    if (conversationHandle) {
      try {
        providerRef = identity.providerRefForHandle(conversationHandle);
      } catch (err) {
        return teachingEnvelope(operation, err?.code || "INVALID_CONVERSATION_HANDLE", "For scoped message search, pass an exact tgchat: handle. Omit conversation_handle for global Telegram search.");
      }
    }

    let searched;
    try {
      searched = await webKSearchMessages(pageNow(), providerRef, query, rawLimit);
    } catch (err) {
      return semanticEnvelope(operation, "FAILED", {
        query,
        scope: providerRef === null ? "GLOBAL" : "CONVERSATION",
        provider_content_model_visible: false,
        elapsed_ms: Date.now() - startedAt,
      }, [], null, err?.code || (providerRef === null ? "WEBK_GLOBAL_MESSAGE_SEARCH_FAILED" : "WEBK_MESSAGE_SEARCH_FAILED"));
    }

    const results = searched.slice(0, rawLimit).map((item, index) => {
      const resultConversationHandle = identity.opaqueConversationHandle(item.provider_ref);
      const message = protectedMessageEntry(item.provider_ref, item.message);
      return {
        rank: index + 1,
        conversation_handle: resultConversationHandle,
        conversation_name: item.conversation_name ?? null,
        message_handle: message.handle,
        sender_name: message.sender_name,
        sender_id: message.sender_id,
        text: message.text,
        date: message.date,
        outgoing: message.outgoing,
        media_type: message.media_type,
        attachments: message.attachments,
        reply_count: message.reply_count,
        has_replies: message.has_replies,
        has_reactions: message.has_reactions,
        reaction_total_count: message.reaction_total_count,
        reaction_counts: message.reaction_counts,
      };
    });

    const groups = [];
    const byHandle = new Map();
    for (const result of results) {
      let group = byHandle.get(result.conversation_handle);
      if (!group) {
        group = {
          rank: groups.length + 1,
          conversation_handle: result.conversation_handle,
          conversation_name: result.conversation_name,
          first_result_rank: result.rank,
          match_count: 0,
          message_handles: [],
        };
        byHandle.set(result.conversation_handle, group);
        groups.push(group);
      }
      group.match_count += 1;
      group.message_handles.push(result.message_handle);
    }

    return semanticEnvelope(
      operation,
      "ACHIEVED",
      {
        query,
        scope: providerRef === null ? "GLOBAL" : "CONVERSATION",
        conversation_handle: conversationHandle ?? null,
        count: results.length,
        handles: results.map((item) => item.message_handle),
        conversation_count: groups.length,
        ordering: "telegram_provider_search_order",
        continuation_ready: true,
        bounded: true,
        navigation_unchanged: true,
        provider_content_model_visible: false,
        elapsed_ms: Date.now() - startedAt,
      },
      [],
      {
        purpose: req.purpose,
        model_visible: false,
        results,
        conversation_groups: groups,
      },
    );
  }

  async function messageFetch(req) {
    const operation = "communication.message.fetch";
    if (!semanticPurposeAllowed(req.purpose)) {
      return semanticEnvelope(operation, "FAILED", {}, [], null, "DATA_USE_PURPOSE_NOT_ALLOWED");
    }
    const phase = await detectPhase();
    if (phase !== "READY") {
      return semanticEnvelope(operation, "FAILED", { connection_state: phase }, [], null, "SESSION_NOT_READY");
    }

    let conversationHandle = pickArg(req.args, "conversation_handle");
    let messageHandle = pickArg(req.args, "message_handle");
    let providerRef;
    let messageRef;
    // "Mark this chat read" is the whole request a human makes; the newest
    // message is a fact the runtime can look up, so it must not be an argument
    // the caller has to discover first.
    let markReadBoundary = messageHandle ? "caller" : null;
    if (!messageHandle) {
      try {
        const latest = await latestMessageHandle(conversationHandle);
        if (latest) {
          messageHandle = latest;
          markReadBoundary = "latest_message";
        }
      } catch {}
      if (!messageHandle) {
        return teachingEnvelope(operation, "MARK_READ_BOUNDARY_UNRESOLVED", "The conversation has no readable message to mark as read. Pass message_handle explicitly (handles come from communication.message.list) or retry once the conversation has at least one message.");
      }
    }
    try {
      messageRef = identity.providerMessageRefForHandle(messageHandle);
      if (conversationHandle) {
        providerRef = identity.providerRefForHandle(conversationHandle);
        if (messageRef.providerRef !== providerRef) {
          return semanticEnvelope(operation, "FAILED", {}, [], null, "MESSAGE_CONVERSATION_MISMATCH");
        }
      } else {
        providerRef = messageRef.providerRef;
        conversationHandle = identity.opaqueConversationHandle(providerRef);
      }
    } catch (err) {
      return teachingEnvelope(operation, err?.code || "INVALID_MESSAGE_HANDLE", "Pass an exact tgmsg: message_handle. conversation_handle is optional because the message handle already binds its source conversation.");
    }

    const page = pageNow();
    const beforeUrl = page.url();
    let message;
    try {
      message = await webKFetchMessage(page, providerRef, messageRef.mid);
    } catch (err) {
      return semanticEnvelope(operation, "FAILED", { provider_content_model_visible: false }, [], null, err?.code || "WEBK_MESSAGE_FETCH_FAILED");
    }
    if (page.url() !== beforeUrl) {
      return semanticEnvelope(operation, "FAILED", { provider_content_model_visible: false }, [], null, "MESSAGE_RETRIEVAL_NAVIGATION_CHANGED");
    }

    const entry = protectedMessageEntry(providerRef, message);
    if (entry.handle !== messageHandle) {
      return semanticEnvelope(operation, "FAILED", {}, [], null, "MESSAGE_HANDLE_DRIFT");
    }

    return semanticEnvelope(
      operation,
      "ACHIEVED",
      {
        conversation_handle: conversationHandle,
        message_handle: messageHandle,
        navigation_unchanged: true,
        provider_content_model_visible: false,
      },
      [],
      {
        purpose: req.purpose,
        model_visible: false,
        conversation_handle: conversationHandle,
        message: entry,
      },
    );
  }

  async function messageReplies(req) {
    const startedAt = Date.now();
    const operation = "communication.message.replies";
    if (!semanticPurposeAllowed(req.purpose)) {
      return semanticEnvelope(operation, "FAILED", {}, [], null, "DATA_USE_PURPOSE_NOT_ALLOWED");
    }
    const phase = await detectPhase();
    if (phase !== "READY") {
      return semanticEnvelope(operation, "FAILED", { connection_state: phase }, [], null, "SESSION_NOT_READY");
    }
    const messageHandle = pickArg(req.args, "message_handle");
    const rawLimit = pickArg(req.args, "limit") ?? 50;
    if (!Number.isInteger(rawLimit) || rawLimit < 1 || rawLimit > 100) {
      return semanticEnvelope(operation, "FAILED", {}, [], null, "INVALID_LIMIT");
    }
    let messageRef;
    try {
      messageRef = identity.providerMessageRefForHandle(messageHandle);
    } catch (err) {
      return teachingEnvelope(operation, err?.code || "INVALID_MESSAGE_HANDLE", "Pass the exact tgmsg: handle of the message whose Telegram reply thread should be read.");
    }

    let result;
    try {
      result = await webKListMessageReplies(pageNow(), messageRef.providerRef, messageRef.mid, rawLimit);
    } catch (err) {
      return semanticEnvelope(operation, "FAILED", {
        message_handle: messageHandle,
        provider_content_model_visible: false,
        elapsed_ms: Date.now() - startedAt,
      }, [], null, err?.code || "WEBK_REPLY_FETCH_FAILED");
    }

    const replies = result.replies.map((message) => protectedMessageEntry(messageRef.providerRef, message));
    return semanticEnvelope(
      operation,
      "ACHIEVED",
      {
        message_handle: messageHandle,
        reply_count: Number.isSafeInteger(result.reply_count) ? result.reply_count : replies.length,
        returned_count: replies.length,
        handles: replies.map((item) => item.handle),
        bounded: true,
        ordering: "telegram_provider_reply_order",
        continuation_ready: true,
        provider_content_model_visible: false,
        elapsed_ms: Date.now() - startedAt,
      },
      [],
      {
        purpose: req.purpose,
        model_visible: false,
        message_handle: messageHandle,
        replies,
      },
    );
  }

  async function acquireAudioMaterialForAsr(messageRef, attachment) {
    const page = pageNow();
    const prepared = await webKPrepareLargeAttachmentDownload(
      page,
      messageRef.providerRef,
      messageRef.mid,
      attachment.slot,
      2 * 1024 * 1024 * 1024,
    );
    const writer = materialSendNow().createMaterialFileWriter({
      filename: prepared.filename || ("voice-" + messageRef.mid + ".ogg"),
      mimeType: prepared.media_type || attachment.media_type || "application/octet-stream",
      sizeBytes: prepared.size_bytes,
    });
    let offset = 0;
    let finished = false;
    try {
      while (offset < prepared.size_bytes) {
        const chunk = await webKReadLargeAttachmentDownloadChunk(
          page,
          prepared.token,
          offset,
          8 * 1024 * 1024,
        );
        const bytes = Buffer.from(chunk.data_base64 || "", "base64");
        if (!bytes.length || bytes.length !== chunk.size_bytes || chunk.offset <= offset) {
          const err = new Error("LOCAL_ASR_ACQUISITION_CHUNK_INVALID");
          err.code = "LOCAL_ASR_ACQUISITION_CHUNK_INVALID";
          throw err;
        }
        writer.append(bytes, offset);
        offset = chunk.offset;
      }

      const reconciliation = await webKFinishLargeAttachmentDownload(page, prepared.token);
      finished = true;
      if (reconciliation.outcome !== "ACHIEVED" || reconciliation.provider_state_unchanged !== true) {
        const err = new Error(reconciliation.error || "LOCAL_ASR_ACQUISITION_PROVIDER_STATE_CHANGED");
        err.code = reconciliation.error || "LOCAL_ASR_ACQUISITION_PROVIDER_STATE_CHANGED";
        throw err;
      }
      return writer.finalize();
    } catch (err) {
      try { writer.abort(); } catch {}
      if (!finished) {
        try { await webKAbortLargeAttachmentDownload(page, prepared.token); } catch {}
      }
      throw err;
    }
  }

  async function pollLocalAsrJob(jobId, maxWaitMs = 7000) {
    let current = await getLocalAsrJob(jobId);
    const deadline = Date.now() + Math.max(0, maxWaitMs);
    while ((current.state === "QUEUED" || current.state === "RUNNING") && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 300));
      current = await getLocalAsrJob(jobId);
    }
    return current;
  }

  async function pollPerplexityAsrJob(jobId, maxWaitMs = 12000) {
    let current = await getPerplexityAsrJob(jobId);
    const deadline = Date.now() + Math.max(0, maxWaitMs);
    while ((current.state === "QUEUED" || current.state === "RUNNING") && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 300));
      current = await getPerplexityAsrJob(jobId);
    }
    return current;
  }

  function perplexityAsrEnvelope(operation, req, messageHandle, attachment, job, startedAt) {
    const state = String(job?.state || "");
    const common = {
      message_handle: messageHandle,
      media_kind: attachment?.media_kind || null,
      transcription_mode: "perplexity",
      transcription_pending: state === "QUEUED" || state === "RUNNING",
      transcript_available: state === "SUCCEEDED" && typeof job?.text === "string" && job.text.trim().length > 0,
      source_media_type: attachment?.media_type || null,
      source_size_bytes: Number.isSafeInteger(job?.source_size_bytes) ? job.source_size_bytes : null,
      source_sha256: typeof job?.source_sha256 === "string" ? job.source_sha256 : null,
      asr_engine: job?.engine_id || null,
      asr_engine_version: job?.engine_version || null,
      asr_model: job?.model_id || null,
      asr_inference_ms: Number.isFinite(job?.inference_ms) ? job.inference_ms : null,
      asr_cache_hit: job?.cache_hit === true,
      asr_job_id: job?.job_id || null,
      whole_message: job?.whole_message === true,
      stream_speed_factor: Number.isInteger(job?.stream_speed_factor) ? job.stream_speed_factor : 1,
      attended_login_available: job?.attended_login_available === true,
      provider_content_model_visible: false,
      elapsed_ms: Date.now() - startedAt,
    };
    if (state === "FAILED") {
      return semanticEnvelope(
        operation,
        "FAILED",
        common,
        [],
        {
          purpose: req.purpose,
          model_visible: false,
          message_handle: messageHandle,
          asr_job_id: job?.job_id || null,
          asr_error: typeof job?.error === "string" ? job.error : null,
        },
        "PERPLEXITY_ASR_JOB_FAILED",
      );
    }
    return semanticEnvelope(
      operation,
      "ACHIEVED",
      common,
      [],
      {
        purpose: req.purpose,
        model_visible: false,
        message_handle: messageHandle,
        transcript: state === "SUCCEEDED" && typeof job?.text === "string" ? job.text : "",
        language: "fa",
        asr_job_id: job?.job_id || null,
        asr_engine: job?.engine_id || null,
        asr_model: job?.model_id || null,
        whole_message: job?.whole_message === true,
        stream_speed_factor: Number.isInteger(job?.stream_speed_factor) ? job.stream_speed_factor : 1,
        source_sha256: typeof job?.source_sha256 === "string" ? job.source_sha256 : null,
      },
    );
  }

  function localAsrEnvelope(operation, req, messageHandle, attachment, job, startedAt) {
    const state = String(job?.state || "");
    const common = {
      message_handle: messageHandle,
      media_kind: attachment?.media_kind || null,
      transcription_mode: "independent",
      transcription_pending: state === "QUEUED" || state === "RUNNING",
      transcript_available: state === "SUCCEEDED" && typeof job?.text === "string" && job.text.trim().length > 0,
      source_media_type: attachment?.media_type || null,
      source_size_bytes: Number.isSafeInteger(job?.source_size_bytes) ? job.source_size_bytes : null,
      source_sha256: typeof job?.source_sha256 === "string" ? job.source_sha256 : null,
      duration_seconds: Number.isFinite(job?.duration_seconds) ? job.duration_seconds : null,
      asr_engine: job?.engine_id || null,
      asr_engine_version: job?.engine_version || null,
      asr_model: job?.model_id || null,
      asr_model_revision: job?.model_revision || null,
      asr_inference_ms: Number.isFinite(job?.inference_ms) ? job.inference_ms : null,
      asr_cache_hit: job?.cache_hit === true,
      asr_job_id: job?.job_id || null,
      provider_content_model_visible: false,
      elapsed_ms: Date.now() - startedAt,
    };

    if (state === "FAILED") {
      return semanticEnvelope(
        operation,
        "FAILED",
        common,
        [],
        {
          purpose: req.purpose,
          model_visible: false,
          message_handle: messageHandle,
          asr_job_id: job?.job_id || null,
          asr_error: typeof job?.error === "string" ? job.error : null,
        },
        "LOCAL_ASR_JOB_FAILED",
      );
    }

    return semanticEnvelope(
      operation,
      "ACHIEVED",
      common,
      [],
      {
        purpose: req.purpose,
        model_visible: false,
        message_handle: messageHandle,
        transcript: state === "SUCCEEDED" && typeof job?.text === "string" ? job.text : "",
        language: job?.language_detected || job?.language_requested || null,
        language_probability: Number.isFinite(job?.language_probability) ? job.language_probability : null,
        segments: Array.isArray(job?.segments) ? job.segments : [],
        asr_job_id: job?.job_id || null,
        asr_engine: job?.engine_id || null,
        asr_model: job?.model_id || null,
        source_sha256: typeof job?.source_sha256 === "string" ? job.source_sha256 : null,
      },
    );
  }

  async function messageTranscribe(req) {
    const startedAt = Date.now();
    const operation = "communication.message.transcribe";
    if (!semanticPurposeAllowed(req.purpose)) {
      return semanticEnvelope(operation, "FAILED", {}, [], null, "DATA_USE_PURPOSE_NOT_ALLOWED");
    }
    const phase = await detectPhase();
    if (phase !== "READY") {
      return semanticEnvelope(operation, "FAILED", { connection_state: phase }, [], null, "SESSION_NOT_READY");
    }
    const messageHandle = pickArg(req.args, "message_handle");
    let messageRef;
    try {
      messageRef = identity.providerMessageRefForHandle(messageHandle);
    } catch (err) {
      return teachingEnvelope(operation, err?.code || "INVALID_MESSAGE_HANDLE", "Pass the exact tgmsg: handle of a Telegram voice or audio message.");
    }

    const modeRaw = typeof req.args?.mode === "string" ? req.args.mode.trim().toLowerCase() : "independent";
    const mode = req.args?.provider_native === true ? "provider" : modeRaw;
    if (mode !== "independent" && mode !== "provider" && mode !== "perplexity") {
      return teachingEnvelope(operation, "TRANSCRIPTION_MODE_UNSUPPORTED", "mode must be independent, provider, or perplexity.");
    }

    if (mode === "provider") {
      let transcript;
      try {
        transcript = await webKTranscribeMessage(pageNow(), messageRef.providerRef, messageRef.mid);
      } catch (err) {
        return semanticEnvelope(operation, "FAILED", {
          message_handle: messageHandle,
          transcription_mode: "provider",
          provider_content_model_visible: false,
          elapsed_ms: Date.now() - startedAt,
        }, [], null, err?.code || "WEBK_TRANSCRIPTION_FAILED");
      }
      return semanticEnvelope(
        operation,
        transcript.pending === true && !String(transcript.text || "").trim() ? "IN_DOUBT" : "ACHIEVED",
        {
          message_handle: messageHandle,
          media_kind: transcript.media_kind,
          transcription_mode: "provider",
          transcription_pending: transcript.pending === true,
          transcript_available: typeof transcript.text === "string" && transcript.text.trim().length > 0,
          provider_content_model_visible: false,
          elapsed_ms: Date.now() - startedAt,
        },
        [],
        {
          purpose: req.purpose,
          model_visible: false,
          message_handle: messageHandle,
          transcript: transcript.text || "",
          transcription_id: transcript.transcription_id,
          trial_remains_num: transcript.trial_remains_num,
          trial_remains_until_date: transcript.trial_remains_until_date,
        },
        transcript.pending === true && !String(transcript.text || "").trim() ? "TRANSCRIPTION_PENDING" : null,
      );
    }

    const language = typeof req.args?.language === "string" && req.args.language.trim()
      ? req.args.language.trim().toLowerCase()
      : (mode === "perplexity" ? "fa" : null);
    if (language !== null && !/^[a-z]{2,3}$/.test(language)) {
      return teachingEnvelope(operation, "LOCAL_ASR_LANGUAGE_INVALID", "language must be a two- or three-letter language code such as fa or en.");
    }
    if (mode === "perplexity" && language !== "fa") {
      return teachingEnvelope(operation, "PERPLEXITY_ASR_LANGUAGE_UNSUPPORTED", "The Perplexity browser benchmark is currently qualified only for Persian (fa).");
    }
    const speedFactor = mode === "perplexity"
      ? Number(req.args?.speed_factor ?? 4)
      : 1;
    if (mode === "perplexity" && (!Number.isInteger(speedFactor) || ![1, 2, 4, 8].includes(speedFactor))) {
      return teachingEnvelope(operation, "PERPLEXITY_ASR_SPEED_FACTOR_UNSUPPORTED", "speed_factor must be one of 1, 2, 4, or 8.");
    }

    const cacheKey = messageHandle + "|" + mode + "|" + (language || "auto") + "|" + speedFactor;
    const jobMap = mode === "perplexity" ? perplexityTranscriptionJobsByMessage : transcriptionJobsByMessage;
    const cached = jobMap.get(cacheKey);
    if (cached?.job_id) {
      try {
        const job = mode === "perplexity"
          ? await pollPerplexityAsrJob(cached.job_id, 12000)
          : await pollLocalAsrJob(cached.job_id, 7000);
        return mode === "perplexity"
          ? perplexityAsrEnvelope(operation, req, messageHandle, cached.attachment, job, startedAt)
          : localAsrEnvelope(operation, req, messageHandle, cached.attachment, job, startedAt);
      } catch (err) {
        const missing = mode === "perplexity"
          ? (err?.code === "PERPLEXITY_ASR_JOB_NOT_FOUND")
          : (err?.code === "ASR_JOB_NOT_FOUND" || err?.code === "LOCAL_ASR_JOB_NOT_FOUND");
        if (!missing) {
          return semanticEnvelope(operation, "FAILED", {
            message_handle: messageHandle,
            transcription_mode: mode,
            provider_content_model_visible: false,
            elapsed_ms: Date.now() - startedAt,
          }, [], null, err?.code || (mode === "perplexity" ? "PERPLEXITY_ASR_RUNTIME_FAILED" : "LOCAL_ASR_RUNTIME_FAILED"));
        }
        jobMap.delete(cacheKey);
      }
    }

    let message;
    try {
      message = await webKFetchMessage(pageNow(), messageRef.providerRef, messageRef.mid);
    } catch (err) {
      return semanticEnvelope(operation, "FAILED", {
        message_handle: messageHandle,
        transcription_mode: "independent",
        provider_content_model_visible: false,
        elapsed_ms: Date.now() - startedAt,
      }, [], null, err?.code || "WEBK_MESSAGE_FETCH_FAILED");
    }

    const attachments = Array.isArray(message?.attachments) ? message.attachments : [];
    const attachment = attachments.find((item) =>
      (item?.media_kind === "voice" || item?.media_kind === "audio")
      && typeof item?.media_type === "string"
      && item.media_type.startsWith("audio/")
    );
    if (!attachment) {
      return semanticEnvelope(operation, "FAILED", {
        message_handle: messageHandle,
        transcription_mode: "independent",
        provider_content_model_visible: false,
        elapsed_ms: Date.now() - startedAt,
      }, [], null, "LOCAL_ASR_AUDIO_ATTACHMENT_REQUIRED");
    }

    let material;
    try {
      material = await acquireAudioMaterialForAsr(messageRef, attachment);
    } catch (err) {
      return semanticEnvelope(operation, "FAILED", {
        message_handle: messageHandle,
        media_kind: attachment.media_kind,
        transcription_mode: "independent",
        provider_content_model_visible: false,
        elapsed_ms: Date.now() - startedAt,
      }, [], null, err?.code || "LOCAL_ASR_AUDIO_ACQUISITION_FAILED");
    }

    let job;
    try {
      if (mode === "perplexity") {
        job = await startPerplexityAsrJob({
          materialFileHandle: material.file_handle,
          filename: material.filename,
          sizeBytes: material.size_bytes,
          sha256Hex: material.sha256_hex,
          language: "fa",
          speedFactor,
        });
      } else {
        job = await startLocalAsrJob({
          materialFileHandle: material.file_handle,
          filename: material.filename,
          sizeBytes: material.size_bytes,
          sha256Hex: material.sha256_hex,
          language,
        });
      }
      jobMap.set(cacheKey, {
        job_id: job.job_id,
        attachment: {
          media_kind: attachment.media_kind,
          media_type: attachment.media_type,
        },
      });
      if (job.state === "QUEUED" || job.state === "RUNNING") {
        job = mode === "perplexity"
          ? await pollPerplexityAsrJob(job.job_id, 12000)
          : await pollLocalAsrJob(job.job_id, 7000);
      }
    } catch (err) {
      return semanticEnvelope(operation, "FAILED", {
        message_handle: messageHandle,
        media_kind: attachment.media_kind,
        transcription_mode: mode,
        source_media_type: attachment.media_type,
        source_size_bytes: material.size_bytes,
        source_sha256: material.sha256_hex,
        provider_content_model_visible: false,
        elapsed_ms: Date.now() - startedAt,
      }, [], null, err?.code || (mode === "perplexity" ? "PERPLEXITY_ASR_RUNTIME_FAILED" : "LOCAL_ASR_RUNTIME_FAILED"));
    }

    return mode === "perplexity"
      ? perplexityAsrEnvelope(operation, req, messageHandle, attachment, job, startedAt)
      : localAsrEnvelope(operation, req, messageHandle, attachment, job, startedAt);
  }

  async function audioTranscribe(req) {
    const startedAt = Date.now();
    const operation = "communication.audio.transcribe";
    if (!semanticPurposeAllowed(req.purpose)) {
      return semanticEnvelope(operation, "FAILED", {}, [], null, "DATA_USE_PURPOSE_NOT_ALLOWED");
    }

    const materialFileHandle = typeof req.args?.material_file_handle === "string"
      ? req.args.material_file_handle.trim().toLowerCase()
      : "";
    const filename = typeof req.args?.filename === "string" ? req.args.filename.trim() : "";
    const mediaType = typeof req.args?.media_type === "string" ? req.args.media_type.trim().toLowerCase() : "";
    const sizeBytes = Number(req.args?.size_bytes);
    const sha256Hex = typeof req.args?.sha256_hex === "string" ? req.args.sha256_hex.trim().toLowerCase() : "";
    const language = typeof req.args?.language === "string" && req.args.language.trim()
      ? req.args.language.trim().toLowerCase()
      : "fa";
    const speedFactor = Number(req.args?.speed_factor ?? 4);

    if (!/^pcgfile:[0-9a-f]{64}$/.test(materialFileHandle)) {
      return teachingEnvelope(operation, "PERPLEXITY_ASR_MATERIAL_HANDLE_INVALID", "Pass one completed private material_file_handle.");
    }
    if (!filename || filename.length > 512 || /[\\/\u0000-\u001f\u007f]/u.test(filename)) {
      return teachingEnvelope(operation, "PERPLEXITY_ASR_FILENAME_INVALID", "filename must be one safe leaf name.");
    }
    if (!mediaType || mediaType.length > 128) {
      return teachingEnvelope(operation, "PERPLEXITY_ASR_MEDIA_TYPE_INVALID", "Pass the staged source media_type.");
    }
    if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 1 || sizeBytes > 64 * 1024 * 1024) {
      return teachingEnvelope(operation, "PERPLEXITY_ASR_SOURCE_SIZE_INVALID", "Direct transcription accepts sources up to 64 MiB.");
    }
    if (!/^[0-9a-f]{64}$/.test(sha256Hex)) {
      return teachingEnvelope(operation, "PERPLEXITY_ASR_SOURCE_DIGEST_INVALID", "sha256_hex must be the exact SHA-256 of the staged source.");
    }
    if (language !== "fa") {
      return teachingEnvelope(operation, "PERPLEXITY_ASR_LANGUAGE_UNSUPPORTED", "The anonymous Perplexity/Soniox path is currently qualified only for Persian (fa).");
    }
    if (!Number.isInteger(speedFactor) || ![1, 2, 4, 8].includes(speedFactor)) {
      return teachingEnvelope(operation, "PERPLEXITY_ASR_SPEED_FACTOR_UNSUPPORTED", "speed_factor must be one of 1, 2, 4, or 8.");
    }

    let job;
    try {
      job = await startPerplexityAsrJob({
        materialFileHandle,
        filename,
        sizeBytes,
        sha256Hex,
        language,
        speedFactor,
      });
      if (job.state === "QUEUED" || job.state === "RUNNING") {
        job = await pollPerplexityAsrJob(job.job_id, 60000);
      }
    } catch (err) {
      const failed = semanticEnvelope(operation, "FAILED", {
        transcription_mode: "perplexity",
        source_filename: filename,
        source_media_type: mediaType,
        source_size_bytes: sizeBytes,
        source_sha256: sha256Hex,
        stream_speed_factor: speedFactor,
        provider_content_model_visible: false,
        elapsed_ms: Date.now() - startedAt,
      }, [], null, err?.code || "PERPLEXITY_ASR_RUNTIME_FAILED");
      failed.provider = "perplexity";
      failed.realization = "anonymous-session-soniox";
      return failed;
    }

    const state = String(job?.state || "");
    const common = {
      transcription_mode: "perplexity",
      transcription_pending: state === "QUEUED" || state === "RUNNING",
      transcript_available: state === "SUCCEEDED" && typeof job?.text === "string" && job.text.trim().length > 0,
      source_filename: filename,
      source_media_type: mediaType,
      source_size_bytes: Number.isSafeInteger(job?.source_size_bytes) ? job.source_size_bytes : sizeBytes,
      source_sha256: typeof job?.source_sha256 === "string" ? job.source_sha256 : sha256Hex,
      asr_engine: job?.engine_id || null,
      asr_engine_version: job?.engine_version || null,
      asr_model: job?.model_id || null,
      asr_inference_ms: Number.isFinite(job?.inference_ms) ? job.inference_ms : null,
      asr_cache_hit: job?.cache_hit === true,
      asr_job_id: job?.job_id || null,
      whole_message: job?.whole_message === true,
      stream_speed_factor: Number.isInteger(job?.stream_speed_factor) ? job.stream_speed_factor : speedFactor,
      provider_content_model_visible: false,
      elapsed_ms: Date.now() - startedAt,
    };

    let out;
    if (state === "FAILED") {
      out = semanticEnvelope(
        operation,
        "FAILED",
        common,
        [],
        {
          purpose: req.purpose,
          model_visible: false,
          asr_job_id: job?.job_id || null,
          asr_error: typeof job?.error === "string" ? job.error : null,
        },
        "PERPLEXITY_ASR_JOB_FAILED",
      );
    } else {
      out = semanticEnvelope(
        operation,
        "ACHIEVED",
        common,
        [],
        {
          purpose: req.purpose,
          model_visible: false,
          transcript: state === "SUCCEEDED" && typeof job?.text === "string" ? job.text : "",
          language: "fa",
          asr_job_id: job?.job_id || null,
          asr_engine: job?.engine_id || null,
          asr_model: job?.model_id || null,
          whole_message: job?.whole_message === true,
          stream_speed_factor: Number.isInteger(job?.stream_speed_factor) ? job.stream_speed_factor : speedFactor,
          source_sha256: typeof job?.source_sha256 === "string" ? job.source_sha256 : sha256Hex,
        },
      );
    }
    out.provider = "perplexity";
    out.realization = "anonymous-session-soniox";
    return out;
  }

  async function messageReactionGet(req) {
    const startedAt = Date.now();
    const operation = "communication.message.reaction.get";
    if (!semanticPurposeAllowed(req.purpose)) {
      return semanticEnvelope(operation, "FAILED", {}, [], null, "DATA_USE_PURPOSE_NOT_ALLOWED");
    }
    const phase = await detectPhase();
    if (phase !== "READY") {
      return semanticEnvelope(operation, "FAILED", { connection_state: phase }, [], null, "SESSION_NOT_READY");
    }

    const messageHandle = pickArg(req.args, "message_handle");
    if (typeof messageHandle !== "string" || !messageHandle) {
      return teachingEnvelope(operation, "MESSAGE_HANDLE_REQUIRED", "Pass the exact tgmsg: message_handle. An exact message handle already binds its conversation.");
    }
    let messageRef;
    try {
      messageRef = identity.providerMessageRefForHandle(messageHandle);
    } catch (err) {
      return teachingEnvelope(operation, err?.code || "INVALID_MESSAGE_HANDLE", "Pass an exact tgmsg: message_handle returned by message list/search or a write result.");
    }

    let state;
    try {
      state = await webKGetMessageReactionState(pageNow(), messageRef.providerRef, messageRef.mid);
    } catch (err) {
      return semanticEnvelope(operation, "FAILED", {
        message_handle: messageHandle,
        reaction_state_readable: false,
        provider_content_model_visible: false,
        elapsed_ms: Date.now() - startedAt,
      }, [], null, err?.code || "WEBK_REACTION_STATE_UNREADABLE");
    }

    return semanticEnvelope(
      operation,
      "ACHIEVED",
      {
        message_handle: messageHandle,
        reaction_state_readable: true,
        has_my_reaction: state.has_my_reaction === true,
        my_reaction_count: (state.selected_emojis?.length || 0) + (state.selected_custom_emoji_count || 0),
        has_reactions: state.has_reactions === true,
        reaction_total_count: Number.isSafeInteger(state.reaction_total_count) ? state.reaction_total_count : 0,
        reaction_distinct_count: Number.isSafeInteger(state.reaction_distinct_count) ? state.reaction_distinct_count : 0,
        reaction_list_visible: state.reaction_list_visible === true,
        provider_content_model_visible: false,
        elapsed_ms: Date.now() - startedAt,
      },
      [],
      {
        purpose: req.purpose,
        model_visible: false,
        message_handle: messageHandle,
        my_reaction_emojis: Array.isArray(state.selected_emojis) ? state.selected_emojis : [],
        my_custom_emoji_reaction_count: Number.isSafeInteger(state.selected_custom_emoji_count) ? state.selected_custom_emoji_count : 0,
        reaction_counts: Array.isArray(state.reaction_counts) ? state.reaction_counts : [],
      },
    );
  }

  async function conversationPinSet(req) {
    const operation = "communication.conversation.pin.set";
    const phase = await detectPhase();
    if (phase !== "READY") {
      return semanticEnvelope(operation, "FAILED", { connection_state: phase }, [], null, "SESSION_NOT_READY");
    }

    const conversationHandle = pickArg(req.args, "conversation_handle");
    const pinned = req.args?.pinned;
    if (typeof pinned !== "boolean") {
      return semanticEnvelope(operation, "FAILED", {}, [], null, "INVALID_PIN_STATE");
    }

    let providerRef;
    try {
      providerRef = identity.providerRefForHandle(conversationHandle);
    } catch (err) {
      return teachingEnvelope(operation, err?.code || "INVALID_CONVERSATION_PIN_TARGET", "A handle was not accepted. Conversation handles look like tgchat:<uuid>, topic handles tgtopic:<uuid> and message handles tgmsg:<uuid>; they are minted by the list and search operations and must be passed verbatim. A chat or person name is never a handle. Argument names are tolerant: conversation_handle / chat_handle / conversation, message_handle / message, topic_handle / topic.");
    }

    const page = pageNow();
    const beforeUrl = page.url();
    let effect;
    try {
      effect = await webKSetConversationPin(page, providerRef, pinned);
    } catch (err) {
      return semanticEnvelope(operation, "FAILED", { provider_content_model_visible: false }, [], null, err?.code || "WEBK_CONVERSATION_PIN_FAILED");
    }

    const navigationUnchanged = page.url() === beforeUrl;
    const changed = effect.before !== effect.after && effect.after === pinned;
    const observation = {
      conversation_handle: conversationHandle,
      desired_pinned: pinned,
      provider_pinned_before: effect.before ?? null,
      provider_pinned_after: effect.after ?? null,
      effect_attempted: effect.effect_attempted === true,
      effect_invocation_acknowledged: effect.effect_invocation_acknowledged === true,
      provider_confirmed: effect.provider_confirmed === true,
      navigation_unchanged: navigationUnchanged,
      provider_content_model_visible: false,
    };

    if (effect.outcome === "IN_DOUBT" || !navigationUnchanged) {
      return semanticEnvelope(
        operation,
        "IN_DOUBT",
        observation,
        effect.effect_attempted ? ["provider_conversation_pin_state_may_have_changed"] : [],
        null,
        effect.error || (!navigationUnchanged ? "CONVERSATION_PIN_NAVIGATION_CHANGED" : "CONVERSATION_PIN_IN_DOUBT"),
      );
    }

    if (effect.outcome === "FAILED") {
      return semanticEnvelope(operation, "FAILED", observation, [], null, effect.error || "CONVERSATION_PIN_REJECTED");
    }

    return semanticEnvelope(
      operation,
      "ACHIEVED",
      observation,
      changed ? ["provider_conversation_pin_state_changed"] : [],
    );
  }

  async function notificationSet(req) {
    const operation = "communication.notification.set";
    const phase = await detectPhase();
    if (phase !== "READY") {
      return semanticEnvelope(operation, "FAILED", { connection_state: phase }, [], null, "SESSION_NOT_READY");
    }
    const conversationHandle = pickArg(req.args, "conversation_handle");
    const muted = req.args?.muted;
    if (typeof muted !== "boolean") {
      return teachingEnvelope(operation, "INVALID_NOTIFICATION_MUTE_STATE", "For per-conversation mute/unmute, pass conversation_handle and muted as a boolean.", { accepted_arguments: ["conversation_handle", "muted"] });
    }
    let providerRef;
    try { providerRef = identity.providerRefForHandle(conversationHandle); }
    catch (err) {
      return teachingEnvelope(operation, err?.code || "INVALID_NOTIFICATION_TARGET", "conversation_handle must be an exact tgchat:<uuid> handle minted by conversation list/search.", { accepted_arguments: ["conversation_handle", "muted"] });
    }
    const page = pageNow();
    const beforeUrl = page.url();
    let effect;
    try { effect = await webKSetConversationMute(page, providerRef, muted); }
    catch (err) {
      return semanticEnvelope(operation, "FAILED", { provider_content_model_visible: false }, [], null, err?.code || "WEBK_NOTIFICATION_MUTE_FAILED");
    }
    const navigationUnchanged = page.url() === beforeUrl;
    const changed = effect.before?.muted !== effect.after?.muted && effect.after?.muted === muted;
    const observation = {
      conversation_handle: conversationHandle,
      desired_muted: muted,
      provider_muted_before: effect.before?.muted ?? null,
      provider_muted_after: effect.after?.muted ?? null,
      provider_mute_until_before: effect.before?.mute_until ?? null,
      provider_mute_until_after: effect.after?.mute_until ?? null,
      effect_attempted: effect.effect_attempted === true,
      effect_invocation_acknowledged: effect.effect_invocation_acknowledged === true,
      provider_confirmed: effect.provider_confirmed === true,
      navigation_unchanged: navigationUnchanged,
      provider_content_model_visible: false,
    };
    if (effect.outcome === "FAILED") return semanticEnvelope(operation, "FAILED", observation, [], null, effect.error || "NOTIFICATION_MUTE_REJECTED");
    if (effect.outcome === "IN_DOUBT" || !navigationUnchanged) {
      return semanticEnvelope(operation, "IN_DOUBT", observation, effect.effect_attempted ? ["provider_notification_state_may_have_changed"] : [], null, effect.error || (!navigationUnchanged ? "NOTIFICATION_NAVIGATION_CHANGED" : "NOTIFICATION_MUTE_IN_DOUBT"));
    }
    return semanticEnvelope(operation, "ACHIEVED", observation, changed ? ["provider_notification_state_changed"] : []);
  }

  async function conversationMarkUnread(req) {
    const operation = "communication.conversation.mark_unread";
    const phase = await detectPhase();
    if (phase !== "READY") {
      return semanticEnvelope(operation, "FAILED", { connection_state: phase }, [], null, "SESSION_NOT_READY");
    }

    const conversationHandle = pickArg(req.args, "conversation_handle");
    const requestedState = req.args?.marked_unread ?? req.args?.unread;
    const markedUnread = requestedState === undefined ? true : requestedState;
    if (typeof markedUnread !== "boolean") {
      return teachingEnvelope(
        operation,
        "INVALID_MARK_UNREAD_STATE",
        "Pass conversation_handle and optionally marked_unread as a boolean. Omitted marked_unread means true.",
        { accepted_arguments: ["conversation_handle", "marked_unread"] },
      );
    }

    let providerRef;
    try { providerRef = identity.providerRefForHandle(conversationHandle); }
    catch (err) {
      return teachingEnvelope(
        operation,
        err?.code || "INVALID_MARK_UNREAD_TARGET",
        "conversation_handle must be an exact tgchat:<uuid> handle minted by conversation list/search.",
        { accepted_arguments: ["conversation_handle", "marked_unread"] },
      );
    }

    const page = pageNow();
    const beforeUrl = page.url();
    let effect;
    try { effect = await webKSetConversationUnreadMark(page, providerRef, markedUnread); }
    catch (err) {
      return semanticEnvelope(
        operation,
        "FAILED",
        { desired_unread_mark: markedUnread, effect_attempted: false, provider_confirmed: false, provider_content_model_visible: false },
        [],
        null,
        err?.code || "WEBK_MARK_UNREAD_FAILED",
      );
    }

    const navigationUnchanged = page.url() === beforeUrl;
    const changed = effect.before?.unread_mark !== effect.after?.unread_mark
      && effect.after?.unread_mark === markedUnread;
    const observation = {
      conversation_handle: conversationHandle,
      desired_unread_mark: markedUnread,
      provider_unread_mark_before: effect.before?.unread_mark ?? null,
      provider_unread_mark_after: effect.after?.unread_mark ?? null,
      provider_unread_count_before: effect.before?.unread_count ?? null,
      provider_unread_count_after: effect.after?.unread_count ?? null,
      provider_read_inbox_max_id_before: effect.before?.read_inbox_max_id ?? null,
      provider_read_inbox_max_id_after: effect.after?.read_inbox_max_id ?? null,
      effect_attempted: effect.effect_attempted === true,
      effect_invocation_acknowledged: effect.effect_invocation_acknowledged === true,
      provider_confirmed: effect.provider_confirmed === true,
      navigation_unchanged: navigationUnchanged,
      provider_content_model_visible: false,
    };

    if (effect.outcome === "FAILED") {
      return semanticEnvelope(operation, "FAILED", observation, [], null, effect.error || "WEBK_MARK_UNREAD_FAILED");
    }
    if (effect.outcome === "IN_DOUBT" || !navigationUnchanged) {
      return semanticEnvelope(
        operation,
        "IN_DOUBT",
        observation,
        effect.effect_attempted ? ["provider_unread_mark_may_have_changed"] : [],
        null,
        effect.error || (!navigationUnchanged ? "MARK_UNREAD_NAVIGATION_CHANGED" : "MARK_UNREAD_IN_DOUBT"),
      );
    }

    return semanticEnvelope(
      operation,
      "ACHIEVED",
      observation,
      changed ? ["provider_unread_mark_changed"] : [],
    );
  }

  // The newest message in a conversation is a fact the runtime can read for
  // itself. Capabilities must not require the caller to supply information the
  // runtime already has.
  async function latestMessageHandle(conversationHandle) {
    const providerRef = identity.providerRefForHandle(conversationHandle);
    const messages = await webKListMessages(pageNow(), providerRef, 1, null, null);
    const newest = Array.isArray(messages) ? messages[0] : null;
    if (!newest) return null;
    const entry = protectedMessageEntry(providerRef, newest);
    return entry?.handle || null;
  }

  async function conversationMarkRead(req) {
    const operation = "communication.conversation.mark_read";
    const conversationHandle = pickArg(req.args, "conversation_handle");
    const count = pickArg(req.args, "count");

    if (count === undefined || count === null) {
      return teachingEnvelope(
        operation,
        "MARK_READ_COUNT_REQUIRED",
        "count is mandatory. Pass the exact number of currently unread messages to mark read. To mark all unread messages, first read the current unread_count and pass that integer as count. Missing count never implies latest/all.",
        { accepted_arguments: ["conversation_handle", "count"] },
      );
    }
    if (!Number.isInteger(count) || count < 1 || count > 10000) {
      return teachingEnvelope(
        operation,
        "MARK_READ_COUNT_INVALID",
        "count must be an integer from 1 through 10000. The operation has no default and never treats an invalid count as all.",
        { accepted_arguments: ["conversation_handle", "count"] },
      );
    }
    if (pickArg(req.args, "message_handle") !== undefined) {
      return teachingEnvelope(
        operation,
        "MARK_READ_MESSAGE_BOUNDARY_NOT_ALLOWED",
        "message_handle is not accepted for mark_read. Use count so the runtime can prove the exact cumulative read boundary from current provider state.",
        { accepted_arguments: ["conversation_handle", "count"] },
      );
    }

    const phase = await detectPhase();
    if (phase !== "READY") {
      return semanticEnvelope(operation, "FAILED", { connection_state: phase }, [], null, "SESSION_NOT_READY");
    }

    let providerRef;
    try {
      providerRef = identity.providerRefForHandle(conversationHandle);
    } catch (err) {
      return teachingEnvelope(
        operation,
        err?.code || "INVALID_MARK_READ_TARGET",
        "conversation_handle must be an exact tgchat:<uuid> handle minted by conversation list/search. count is always required.",
        { accepted_arguments: ["conversation_handle", "count"] },
      );
    }

    const page = pageNow();
    const beforeUrl = page.url();
    let effect;
    try {
      effect = await webKMarkConversationRead(page, providerRef, count);
    } catch (err) {
      return semanticEnvelope(
        operation,
        "FAILED",
        {
          requested_count: count,
          effect_attempted: false,
          provider_confirmed: false,
          provider_content_model_visible: false,
        },
        [],
        null,
        err?.code || "WEBK_MARK_READ_FAILED",
      );
    }

    const navigationUnchanged = page.url() === beforeUrl;
    const boundaryHandle = Number.isSafeInteger(effect.boundary_mid)
      ? identity.opaqueMessageHandle(providerRef, effect.boundary_mid)
      : null;
    const observation = {
      conversation_handle: conversationHandle,
      requested_count: count,
      message_handle: boundaryHandle,
      mark_read_boundary: boundaryHandle ? "runtime_count_resolved" : null,
      provider_observation_before: effect.before ?? null,
      provider_observation_after: effect.after ?? null,
      expected_unread_count: effect.expected_unread_count ?? null,
      effect_attempted: effect.effect_attempted === true,
      effect_invocation_acknowledged: effect.effect_invocation_acknowledged === true,
      provider_confirmed: effect.provider_confirmed === true,
      navigation_unchanged: navigationUnchanged,
      provider_content_model_visible: false,
    };

    if (effect.outcome === "FAILED") {
      return semanticEnvelope(operation, "FAILED", observation, [], null, effect.error || "WEBK_MARK_READ_FAILED");
    }
    if (effect.outcome === "IN_DOUBT" || !navigationUnchanged) {
      return semanticEnvelope(
        operation,
        "IN_DOUBT",
        observation,
        effect.effect_attempted ? ["provider_read_state_may_have_changed"] : [],
        null,
        effect.error || (!navigationUnchanged ? "MARK_READ_NAVIGATION_CHANGED" : "MARK_READ_IN_DOUBT"),
      );
    }

    return semanticEnvelope(
      operation,
      "ACHIEVED",
      observation,
      effect.effect_attempted ? ["provider_read_state_changed"] : [],
    );
  }

  async function messageOpenMedia(req) {
    const operation = "communication.message.open_media";
    const phase = await detectPhase();
    if (phase !== "READY") {
      return semanticEnvelope(operation, "FAILED", { connection_state: phase }, [], null, "SESSION_NOT_READY");
    }

    const conversationHandle = pickArg(req.args, "conversation_handle");
    let messageHandle = pickArg(req.args, "message_handle");
    let providerRef;
    let messageRef;
    // "Mark this chat read" is the whole request a human makes; the newest
    // message is a fact the runtime can look up, so it must not be an argument
    // the caller has to discover first.
    let markReadBoundary = messageHandle ? "caller" : null;
    if (!messageHandle) {
      try {
        const latest = await latestMessageHandle(conversationHandle);
        if (latest) {
          messageHandle = latest;
          markReadBoundary = "latest_message";
        }
      } catch {}
      if (!messageHandle) {
        return teachingEnvelope(operation, "MARK_READ_BOUNDARY_UNRESOLVED", "The conversation has no readable message to mark as read. Pass message_handle explicitly (handles come from communication.message.list) or retry once the conversation has at least one message.");
      }
    }
    try {
      providerRef = identity.providerRefForHandle(conversationHandle);
      messageRef = identity.providerMessageRefForHandle(messageHandle);
    } catch (err) {
      return teachingEnvelope(operation, err?.code || "INVALID_OPEN_MEDIA_TARGET", "A handle was not accepted. Conversation handles look like tgchat:<uuid>, topic handles tgtopic:<uuid> and message handles tgmsg:<uuid>; they are minted by the list and search operations and must be passed verbatim. A chat or person name is never a handle. Argument names are tolerant: conversation_handle / chat_handle / conversation, message_handle / message, topic_handle / topic.");
    }
    if (messageRef.providerRef !== providerRef) {
      return semanticEnvelope(operation, "FAILED", {}, [], null, "MESSAGE_CONVERSATION_MISMATCH");
    }

    const page = pageNow();
    const beforeUrl = page.url();
    let effect;
    try {
      effect = await webKOpenMessageMedia(page, providerRef, messageRef.mid);
    } catch (err) {
      return semanticEnvelope(operation, "FAILED", { provider_content_model_visible: false }, [], null, err?.code || "WEBK_OPEN_MEDIA_FAILED");
    }

    const navigationUnchanged = page.url() === beforeUrl;
    const observation = {
      conversation_handle: conversationHandle,
      message_handle: messageHandle,
      media_kind: effect.after?.media_kind ?? effect.before?.media_kind ?? null,
      provider_observation_before: effect.before ?? null,
      provider_observation_after: effect.after ?? null,
      effect_attempted: effect.effect_attempted === true,
      effect_invocation_acknowledged: effect.effect_invocation_acknowledged === true,
      provider_confirmed: effect.provider_confirmed === true,
      navigation_unchanged: navigationUnchanged,
      provider_content_model_visible: false,
    };

    if (effect.outcome === "IN_DOUBT" || !navigationUnchanged) {
      return semanticEnvelope(
        operation,
        "IN_DOUBT",
        observation,
        effect.effect_attempted ? ["provider_media_view_state_may_have_changed"] : [],
        null,
        effect.error || (!navigationUnchanged ? "OPEN_MEDIA_NAVIGATION_CHANGED" : "OPEN_MEDIA_IN_DOUBT"),
      );
    }

    return semanticEnvelope(
      operation,
      "ACHIEVED",
      observation,
      effect.effect_attempted ? ["provider_media_view_state_changed"] : [],
    );
  }

  async function messageReact(req) {
    const startedAt = Date.now();
    const operation = "communication.message.react";
    const phase = await detectPhase();
    if (phase !== "READY") {
      return semanticEnvelope(operation, "FAILED", { connection_state: phase }, [], null, "SESSION_NOT_READY");
    }

    let conversationHandle = pickArg(req.args, "conversation_handle");
    const messageHandle = pickArg(req.args, "message_handle");
    if ((!conversationHandle || typeof conversationHandle !== "string") && typeof messageHandle === "string" && messageHandle) {
      try {
        const bound = identity.providerMessageRefForHandle(messageHandle);
        conversationHandle = identity.opaqueConversationHandle(bound.providerRef);
      } catch {}
    }
    const rawEmoji = pickArg(req.args, "emoji");
    const removeArg = pickArg(req.args, "remove");
    const accepted = acceptedArgumentNames(["conversation_handle", "message_handle", "emoji", "remove"]);
    const remove = removeArg === true
      || removeArg === "true"
      || rawEmoji === null
      || rawEmoji === ""
      || (typeof rawEmoji === "string" && REACTION_REMOVAL_WORDS.has(rawEmoji.trim().toLowerCase()));
    const emoji = remove ? "" : rawEmoji;
    if (!remove && (typeof emoji !== "string" || !emoji || emoji.length > 16 || /[\u0000-\u001f\u007f]/u.test(emoji))) {
      return teachingEnvelope(
        operation,
        "INVALID_REACTION_EMOJI",
        rawEmoji === undefined
          ? "No reaction emoji argument was supplied. Pass one short emoji string under any accepted name, or pass remove:true (or an empty emoji) to clear your own reaction."
          : "The reaction emoji must be a single short emoji string of at most 16 characters. To clear your own reaction pass remove:true or an empty emoji.",
        { accepted_arguments: accepted },
      );
    }
    if (typeof conversationHandle !== "string" || !conversationHandle || typeof messageHandle !== "string" || !messageHandle) {
      return teachingEnvelope(
        operation,
        "INVALID_REACTION_TARGET",
        "A message handle is required. Pass message_handle from communication.message.list or a created_message_handle returned by a write; conversation_handle is optional because the exact message handle already binds its conversation.",
        { accepted_arguments: accepted },
      );
    }

    let providerRef;
    let messageRef;
    try {
      providerRef = identity.providerRefForHandle(conversationHandle);
      messageRef = identity.providerMessageRefForHandle(messageHandle);
    } catch (err) {
      return teachingEnvelope(
        operation,
        err?.code || "INVALID_REACTION_TARGET",
        "The conversation or message handle was not accepted. A conversation handle looks like tgchat:<uuid> and a message handle like tgmsg:<uuid>; both come from the list operations and cannot be a chat name.",
        { accepted_arguments: accepted },
      );
    }
    if (messageRef.providerRef !== providerRef) {
      return semanticEnvelope(operation, "FAILED", {}, [], null, "MESSAGE_CONVERSATION_MISMATCH");
    }

    const page = pageNow();
    const beforeUrl = page.url();
    let effect;
    try {
      effect = await webKSetMessageReaction(page, providerRef, messageRef.mid, emoji, remove);
    } catch (err) {
      return teachingEnvelope(
        operation,
        err?.code || "WEBK_REACTION_FAILED",
        String(err?.code || "").startsWith("PROVIDER_PRIMITIVE")
          ? "This is a defect in our provider adapter, not a provider limitation or an argument mistake. Do not retry with different arguments; the adapter must be fixed. Read communication.session.status for the provider-model self-check."
          : "The provider rejected the reaction attempt. Verify the message handle with communication.message.list before retrying once.",
        { observation: { provider_content_model_visible: false } },
      );
    }

    const navigationUnchanged = page.url() === beforeUrl;
    const observation = {
      conversation_handle: conversationHandle,
      message_handle: messageHandle,
      reaction: remove ? null : emoji,
      reaction_removal_requested: remove,
      reaction_removed: remove && effect.provider_confirmed === true,
      reaction_state_readable: effect.reaction_state_readable === true,
      selected_before: effect.selected_before === true,
      selected_after: effect.selected_after === true,
      effect_attempted: effect.effect_attempted === true,
      effect_invocation_acknowledged: effect.effect_invocation_acknowledged === true,
      provider_confirmed: effect.provider_confirmed === true,
      effect_attempt_count: Number.isSafeInteger(effect.effect_attempt_count) ? effect.effect_attempt_count : (effect.effect_attempted ? 1 : 0),
      reconciled_retry: effect.reconciled_retry === true,
      navigation_unchanged: navigationUnchanged,
      provider_content_model_visible: false,
      elapsed_ms: Date.now() - startedAt,
    };

    if (effect.outcome === "IN_DOUBT" || !navigationUnchanged) {
      return semanticEnvelope(
        operation,
        "IN_DOUBT",
        observation,
        effect.effect_attempted ? ["provider_reaction_state_may_have_changed"] : [],
        null,
        effect.error || (!navigationUnchanged ? "REACTION_NAVIGATION_CHANGED" : "REACTION_IN_DOUBT"),
      );
    }

    return semanticEnvelope(
      operation,
      "ACHIEVED",
      observation,
      effect.effect_attempted ? ["provider_reaction_state_changed"] : [],
    );
  }


  function newLargeDownloadSessionHandle() {
    return "tgdl:" + createHash("sha256")
      .update(randomUUID() + "|" + Date.now() + "|" + process.hrtime.bigint().toString(), "utf8")
      .digest("hex");
  }

  async function advanceLargeAttachmentDownload(sessionHandle) {
    const operation = "communication.attachment.download";
    const session = largeAttachmentDownloads.get(sessionHandle);
    if (!session) return semanticEnvelope(operation, "FAILED", { provider_content_model_visible: false }, [], null, "LARGE_DOWNLOAD_SESSION_NOT_FOUND");

    if (Date.now() - session.created_at_ms > 20 * 60 * 1000) {
      try { session.writer.abort(); } catch {}
      try { await webKAbortLargeAttachmentDownload(pageNow(), session.provider_token); } catch {}
      largeAttachmentDownloads.delete(sessionHandle);
      return semanticEnvelope(operation, "FAILED", { provider_content_model_visible: false }, [], null, "LARGE_DOWNLOAD_SESSION_EXPIRED");
    }

    let chunk;
    try {
      chunk = await webKReadLargeAttachmentDownloadChunk(pageNow(), session.provider_token, session.offset, 8 * 1024 * 1024);
      const bytes = Buffer.from(chunk.data_base64 || "", "base64");
      if (!bytes.length || bytes.length !== chunk.size_bytes) {
        const err = new Error("LARGE_DOWNLOAD_CHUNK_INVALID");
        err.code = "LARGE_DOWNLOAD_CHUNK_INVALID";
        throw err;
      }
      session.writer.append(bytes, session.offset);
      session.offset = chunk.offset;
    } catch (err) {
      return semanticEnvelope(
        operation,
        "FAILED",
        { download_session_handle: sessionHandle, download_offset: session.offset, size_bytes: session.size_bytes, provider_content_model_visible: false },
        ["local_file_partial"],
        { purpose: session.purpose, model_visible: false, download_session_handle: sessionHandle },
        err?.code || "LARGE_DOWNLOAD_CHUNK_FAILED",
      );
    }

    const baseObservation = {
      conversation_handle: session.conversation_handle,
      message_handle: session.message_handle,
      attachment_handle: session.attachment_handle,
      download_session_handle: sessionHandle,
      download_offset: session.offset,
      size_bytes: session.size_bytes,
      download_complete: session.offset === session.size_bytes,
      prepared_for_send: session.offset === session.size_bytes,
      provider_content_model_visible: false,
    };

    if (session.offset < session.size_bytes) {
      return semanticEnvelope(
        operation,
        "ACHIEVED",
        baseObservation,
        ["local_file_partial"],
        {
          purpose: session.purpose,
          model_visible: false,
          download_session_handle: sessionHandle,
          attachment: {
            handle: session.attachment_handle,
            message_handle: session.message_handle,
            filename: session.filename,
            media_type: session.media_type,
            size_bytes: session.size_bytes,
            converted: false,
          },
        },
      );
    }

    let finish;
    try {
      finish = await webKFinishLargeAttachmentDownload(pageNow(), session.provider_token);
    } catch (err) {
      try { session.writer.abort(); } catch {}
      largeAttachmentDownloads.delete(sessionHandle);
      return semanticEnvelope(operation, "FAILED", baseObservation, ["local_file_partial"], null, err?.code || "LARGE_DOWNLOAD_RECONCILIATION_FAILED");
    }

    if (finish.outcome !== "ACHIEVED" || finish.provider_state_unchanged !== true) {
      try { session.writer.abort(); } catch {}
      largeAttachmentDownloads.delete(sessionHandle);
      return semanticEnvelope(
        operation,
        "IN_DOUBT",
        { ...baseObservation, provider_state_checked: finish.provider_state_checked === true, provider_state_unchanged: finish.provider_state_unchanged === true },
        ["local_file_acquired", "provider_read_or_view_state_may_have_changed"],
        null,
        finish.error || "LARGE_DOWNLOAD_PROVIDER_STATE_IN_DOUBT",
      );
    }

    let materialFile;
    try {
      materialFile = session.writer.finalize();
    } catch (err) {
      try { session.writer.abort(); } catch {}
      largeAttachmentDownloads.delete(sessionHandle);
      return semanticEnvelope(operation, "FAILED", baseObservation, ["local_file_partial"], null, err?.code || "MATERIAL_FILE_STAGING_FAILED");
    }
    largeAttachmentDownloads.delete(sessionHandle);

    return semanticEnvelope(
      operation,
      "ACHIEVED",
      {
        ...baseObservation,
        local_file_acquired: true,
        download_complete: true,
        prepared_for_send: true,
        material_file_handle: materialFile.file_handle,
        provider_restriction_checked: true,
        provider_state_checked: true,
        provider_state_unchanged: true,
      },
      ["local_file_acquired"],
      {
        purpose: session.purpose,
        model_visible: false,
        attachment: {
          handle: session.attachment_handle,
          message_handle: session.message_handle,
          filename: session.filename,
          media_type: session.media_type,
          size_bytes: session.size_bytes,
          sha256_hex: materialFile.sha256_hex,
          converted: false,
        },
        material_file: materialFile,
      },
    );
  }

  async function attachmentDownload(req) {
    const operation = "communication.attachment.download";
    if (!downloadPurposeAllowed(req.purpose)) {
      return semanticEnvelope(operation, "FAILED", {}, [], null, "DATA_USE_PURPOSE_NOT_ALLOWED");
    }
    const phase = await detectPhase();
    if (phase !== "READY") {
      return semanticEnvelope(operation, "FAILED", { connection_state: phase }, [], null, "SESSION_NOT_READY");
    }

    const resumeSessionHandle = typeof req.args?.download_session_handle === "string"
      ? req.args.download_session_handle.trim()
      : "";
    if (resumeSessionHandle) return advanceLargeAttachmentDownload(resumeSessionHandle);

    let conversationHandle = pickArg(req.args, "conversation_handle");
    const messageHandle = pickArg(req.args, "message_handle");
    const attachmentHandle = req.args?.attachment_handle;
    let providerRef;
    let messageRef;
    let attachmentRef;
    try {
      messageRef = identity.providerMessageRefForHandle(messageHandle);
      attachmentRef = identity.providerAttachmentRefForHandle(attachmentHandle);
      if (conversationHandle) {
        providerRef = identity.providerRefForHandle(conversationHandle);
        if (messageRef.providerRef !== providerRef) {
          return semanticEnvelope(operation, "FAILED", {}, [], null, "MESSAGE_CONVERSATION_MISMATCH");
        }
      } else {
        providerRef = messageRef.providerRef;
        conversationHandle = identity.opaqueConversationHandle(providerRef);
      }
    } catch (err) {
      return teachingEnvelope(operation, err?.code || "INVALID_DOWNLOAD_TARGET", "Pass exact tgmsg: and tgatt: handles. conversation_handle is optional because the message handle binds its source conversation.");
    }
    if (attachmentRef.providerRef !== providerRef || attachmentRef.mid !== messageRef.mid) {
      return semanticEnvelope(operation, "FAILED", {}, [], null, "ATTACHMENT_MESSAGE_MISMATCH");
    }

    const portableFormat = typeof req.args?.portable_format === "string"
      ? req.args.portable_format.trim().toLowerCase()
      : "original";
    if (portableFormat !== "original" && portableFormat !== "mp3") {
      return teachingEnvelope(operation, "PORTABLE_FORMAT_UNSUPPORTED", "portable_format must be exactly original or mp3.");
    }

    const page = pageNow();
    const beforeUrl = page.url();
    let effect;
    try {
      effect = await webKDownloadAttachment(
        page,
        providerRef,
        messageRef.mid,
        attachmentRef.slot,
        downloadBroker.maxFileBytes,
      );
    } catch (err) {
      if (err?.code === "WEBK_DOWNLOAD_SIZE_OUT_OF_BOUNDS"
          && req.args?.prepare_for_send === true
          && portableFormat === "original") {
        try {
          const prepared = await webKPrepareLargeAttachmentDownload(page, providerRef, messageRef.mid, attachmentRef.slot, 2 * 1024 * 1024 * 1024);
          const writer = materialSendNow().createMaterialFileWriter({
            filename: prepared.filename || "attachment.bin",
            mimeType: prepared.media_type || "application/octet-stream",
            sizeBytes: prepared.size_bytes,
          });
          const sessionHandle = newLargeDownloadSessionHandle();
          largeAttachmentDownloads.set(sessionHandle, {
            created_at_ms: Date.now(),
            purpose: req.purpose,
            provider_token: prepared.token,
            writer,
            offset: 0,
            size_bytes: prepared.size_bytes,
            filename: prepared.filename || "attachment.bin",
            media_type: prepared.media_type || "application/octet-stream",
            conversation_handle: conversationHandle,
            message_handle: messageHandle,
            attachment_handle: attachmentHandle,
          });
          return await advanceLargeAttachmentDownload(sessionHandle);
        } catch (largeErr) {
          return semanticEnvelope(operation, "FAILED", { provider_content_model_visible: false }, [], null, largeErr?.code || "WEBK_LARGE_DOWNLOAD_FAILED");
        }
      }
      return semanticEnvelope(operation, "FAILED", { provider_content_model_visible: false }, [], null, err?.code || "WEBK_DOWNLOAD_FAILED");
    }

    let lease;
    try {
      lease = downloadBroker.importBase64(effect.data_base64, {
        expectedSizeBytes: effect.size_bytes,
        filename: effect.filename ?? null,
        mediaType: effect.media_type ?? null,
      });
    } catch (err) {
      return semanticEnvelope(operation, "FAILED", { provider_content_model_visible: false }, [], null, err?.code || "LOCAL_FILE_BROKER_IMPORT_FAILED");
    }

    let previewLease = null;
    if (typeof effect.preview_data_base64 === "string" && effect.preview_data_base64) {
      try {
        previewLease = downloadBroker.importBase64(effect.preview_data_base64, {
          expectedSizeBytes: effect.preview_size_bytes,
          filename: "telegram-preview.jpg",
          mediaType: effect.preview_media_type || "image/jpeg",
        });
      } catch {}
    }

    let deliveredLease = lease;
    let conversion = null;
    if (portableFormat === "mp3") {
      if (typeof effect.media_type !== "string" || !effect.media_type.startsWith("audio/")) {
        return semanticEnvelope(
          operation,
          "FAILED",
          { source_file_handle: lease.file_handle, provider_content_model_visible: false },
          ["local_file_acquired"],
          {
            purpose: req.purpose,
            model_visible: false,
            original_local_file: { file_handle: lease.file_handle, expires_at: lease.expires_at },
          },
          "PORTABLE_AUDIO_SOURCE_REQUIRED",
        );
      }
      try {
        conversion = await transcodeAudioToMp3(page, effect.data_base64, {
          sourceFilename: effect.filename ?? null,
          bitrateKbps: 96,
        });
        deliveredLease = downloadBroker.importBase64(conversion.data_base64, {
          expectedSizeBytes: conversion.size_bytes,
          filename: conversion.filename,
          mediaType: conversion.media_type,
        });
      } catch (err) {
        return semanticEnvelope(
          operation,
          "FAILED",
          { source_file_handle: lease.file_handle, provider_content_model_visible: false },
          ["local_file_acquired"],
          {
            purpose: req.purpose,
            model_visible: false,
            original_local_file: { file_handle: lease.file_handle, expires_at: lease.expires_at },
          },
          err?.code || "PORTABLE_AUDIO_CONVERSION_FAILED",
        );
      }
    }

    let materialFile = null;
    if (req.args?.prepare_for_send === true) {
      try {
        const exported = downloadBroker.exportBase64(deliveredLease.file_handle);
        const fallbackFilename = deliveredLease.media_type === "audio/ogg"
          ? "voice.ogg"
          : (deliveredLease.media_type === "audio/mpeg" ? "audio.mp3" : "attachment.bin");
        materialFile = materialSendNow().stageMaterialFile({
          dataBase64: exported.data_base64,
          filename: deliveredLease.filename || fallbackFilename,
          mimeType: deliveredLease.media_type || "application/octet-stream",
          sizeBytes: exported.size_bytes,
          payloadSha256: exported.sha256_hex,
        });
      } catch (err) {
        return semanticEnvelope(
          operation,
          "FAILED",
          { source_file_handle: deliveredLease.file_handle, provider_content_model_visible: false },
          ["local_file_acquired", ...(conversion ? ["local_file_transcoded"] : [])],
          {
            purpose: req.purpose,
            model_visible: false,
            local_file: { file_handle: deliveredLease.file_handle, expires_at: deliveredLease.expires_at },
            original_local_file: { file_handle: lease.file_handle, expires_at: lease.expires_at },
          },
          err?.code || "MATERIAL_FILE_STAGING_FAILED",
        );
      }
    }

    const navigationUnchanged = page.url() === beforeUrl;
    const observation = {
      conversation_handle: conversationHandle,
      message_handle: messageHandle,
      attachment_handle: attachmentHandle,
      file_handle: deliveredLease.file_handle,
      source_file_handle: lease.file_handle,
      local_file_acquired: true,
      portable_format: portableFormat,
      converted: conversion !== null,
      prepared_for_send: materialFile !== null,
      material_file_handle: materialFile?.file_handle ?? null,
      file_handle_opaque: deliveredLease.file_handle.startsWith("file:"),
      ttl_seconds: deliveredLease.ttl_seconds,
      bounded_size: deliveredLease.size_bytes <= downloadBroker.maxFileBytes,
      duration_seconds: conversion?.duration_seconds ?? null,
      sample_rate: conversion?.sample_rate ?? null,
      audio_channels: conversion?.channels ?? null,
      bitrate_kbps: conversion?.bitrate_kbps ?? null,
      preview_available: previewLease !== null,
      preview_media_type: previewLease?.media_type ?? null,
      preview_size_bytes: previewLease?.size_bytes ?? null,
      provider_restriction_checked: effect.provider_restriction_checked === true,
      provider_state_checked: effect.provider_state_checked === true,
      provider_state_unchanged: effect.provider_state_unchanged === true,
      provider_observation_before: effect.before ?? null,
      provider_observation_after: effect.after ?? null,
      navigation_unchanged: navigationUnchanged,
      provider_content_model_visible: false,
    };

    const protectedProviderData = {
      purpose: req.purpose,
      model_visible: false,
      attachment: {
        handle: attachmentHandle,
        message_handle: messageHandle,
        filename: deliveredLease.filename,
        media_type: deliveredLease.media_type,
        size_bytes: deliveredLease.size_bytes,
        sha256_hex: deliveredLease.sha256_hex,
        converted: conversion !== null,
        source_filename: lease.filename,
        source_media_type: lease.media_type,
        source_size_bytes: lease.size_bytes,
        source_sha256_hex: lease.sha256_hex,
      },
      local_file: {
        file_handle: deliveredLease.file_handle,
        expires_at: deliveredLease.expires_at,
      },
      original_local_file: {
        file_handle: lease.file_handle,
        expires_at: lease.expires_at,
      },
      ...(previewLease ? {
        preview: {
          filename: previewLease.filename,
          media_type: previewLease.media_type,
          size_bytes: previewLease.size_bytes,
          sha256_hex: previewLease.sha256_hex,
        },
        preview_local_file: {
          file_handle: previewLease.file_handle,
          expires_at: previewLease.expires_at,
        },
      } : {}),
      ...(materialFile ? { material_file: materialFile } : {}),
    };

    if (effect.outcome === "IN_DOUBT" || !navigationUnchanged) {
      return semanticEnvelope(
        operation,
        "IN_DOUBT",
        observation,
        ["local_file_acquired", "provider_read_or_view_state_may_have_changed"],
        protectedProviderData,
        effect.error || (!navigationUnchanged ? "DOWNLOAD_NAVIGATION_CHANGED" : "DOWNLOAD_PROVIDER_STATE_IN_DOUBT"),
      );
    }

    return semanticEnvelope(
      operation,
      "ACHIEVED",
      observation,
      ["local_file_acquired", ...(conversion ? ["local_file_transcoded"] : [])],
      protectedProviderData,
    );
  }

  async function qualifyConversationListNoRead() {
    const operation = "qualification.conversation.list.no_mark_read";
    const phase = await detectPhase();
    if (phase !== "READY") {
      return semanticEnvelope(operation, "FAILED", { connection_state: phase }, [], null, "SESSION_NOT_READY");
    }

    const page = pageNow();
    const before = await unreadConversationRefs(page);
    if (!before.length) {
      return semanticEnvelope(
        operation,
        "QUALIFICATION_REQUIRED",
        { canary_present: false, provider_content_model_visible: false },
        [],
        null,
        "NO_VISIBLE_UNREAD_CANARY",
      );
    }

    const providerRef = before[0];
    const handle = identity.opaqueConversationHandle(providerRef);
    const listed = await conversationList({ purpose: "PROTECTED_DISPLAY", args: { limit: 50 } });
    if (listed.state !== "ACHIEVED") {
      return semanticEnvelope(
        operation,
        "FAILED",
        {
          canary_present: true,
          canary_handle: handle,
          list_state: listed.state,
          provider_content_model_visible: false,
        },
        [],
        null,
        "CONVERSATION_LIST_QUALIFICATION_CALL_FAILED",
      );
    }

    await page.waitForTimeout(900);
    const after = await unreadConversationRefs(page);
    const unreadPreserved = after.includes(providerRef);
    return semanticEnvelope(
      operation,
      unreadPreserved ? "ACHIEVED" : "FAILED",
      {
        canary_present: true,
        canary_handle: handle,
        unread_before: true,
        unread_after: unreadPreserved,
        list_state: listed.state,
        provider_content_model_visible: false,
      },
      [],
      null,
      unreadPreserved ? null : "UNREAD_CANARY_CHANGED",
    );
  }

  async function qualifyConversationStructure() {
    const operation = "qualification.conversation.structure.sections";
    const listed = await conversationList({ purpose: "PROTECTED_DISPLAY", args: { limit: 50 } });
    if (listed.state !== "ACHIEVED") {
      return semanticEnvelope(operation, "FAILED", { provider_content_model_visible: false }, [], null, listed.error || "CONVERSATION_STRUCTURE_LIST_FAILED");
    }
    const entries = listed.protected_provider_data?.conversations;
    if (!Array.isArray(entries)) {
      return semanticEnvelope(operation, "FAILED", { provider_content_model_visible: false }, [], null, "CONVERSATION_STRUCTURE_PROTECTED_DATA_INVALID");
    }
    const rank = { proxy_sponsor: 0, sponsored: 0, pinned: 1, normal: 2 };
    let previous = -1;
    let ordered = true;
    let complete = true;
    for (const item of entries) {
      const current = rank[item?.list_section];
      if (!Number.isInteger(current)) complete = false;
      else if (current < previous) ordered = false;
      else previous = current;
      if (typeof item?.pinned !== "boolean"
          || typeof item?.sponsored !== "boolean"
          || typeof item?.proxy_sponsor !== "boolean"
          || typeof item?.is_forum !== "boolean") complete = false;
      if (item?.proxy_sponsor === true && (item?.sponsored !== true || item?.list_section !== "proxy_sponsor")) complete = false;
      if (item?.pinned === true && item?.list_section !== "pinned") complete = false;
    }
    const achieved = ordered && complete;
    return semanticEnvelope(
      operation,
      achieved ? "ACHIEVED" : "FAILED",
      {
        count: entries.length,
        classification_complete: complete,
        section_order_valid: ordered,
        sponsored_count: listed.observation?.sponsored_count ?? 0,
        proxy_sponsor_count: listed.observation?.proxy_sponsor_count ?? 0,
        pinned_count: listed.observation?.pinned_count ?? 0,
        normal_count: listed.observation?.normal_count ?? 0,
        forum_count: listed.observation?.forum_count ?? 0,
        promo_fetch_state: listed.observation?.promo_fetch_state ?? "UNKNOWN",
        provider_content_model_visible: false,
      },
      [],
      null,
      achieved ? null : "CONVERSATION_STRUCTURE_CLASSIFICATION_FAILED",
    );
  }

  async function qualifyTopicRetrievalNoRead() {
    const operation = "qualification.topic.list_messages.no_mark_read_or_navigation";
    const phase = await detectPhase();
    if (phase !== "READY") {
      return semanticEnvelope(operation, "FAILED", { connection_state: phase }, [], null, "SESSION_NOT_READY");
    }
    const page = pageNow();
    const beforeUrl = page.url();
    const conversations = await conversationList({ purpose: "PROTECTED_DISPLAY", args: { limit: 50 } });
    const items = conversations.protected_provider_data?.conversations;
    const forums = Array.isArray(items) ? items.filter((item) => item?.is_forum === true) : [];
    if (!forums.length) {
      return semanticEnvelope(
        operation,
        "QUALIFICATION_REQUIRED",
        { canary_present: false, forum_candidate_count: 0, provider_content_model_visible: false },
        [],
        null,
        "NO_FORUM_CONVERSATION_CANARY",
      );
    }

    let firstUnexpectedError = null;
    for (const forum of forums) {
      const listed = await topicList({
        purpose: "PROTECTED_DISPLAY",
        args: { conversation_handle: forum.handle, limit: 50, offset_index: 0 },
      });
      if (listed.state !== "ACHIEVED") {
        firstUnexpectedError ??= listed.error || "TOPIC_LIST_FAILED";
        continue;
      }
      const topics = listed.protected_provider_data?.topics;
      if (!Array.isArray(topics) || !topics.length) continue;
      for (const topic of topics) {
        let providerRef;
        let topicRef;
        try {
          providerRef = identity.providerRefForHandle(forum.handle);
          topicRef = identity.providerTopicRefForHandle(topic.handle);
        } catch (err) {
          firstUnexpectedError ??= err?.code || "TOPIC_HANDLE_RESOLUTION_FAILED";
          continue;
        }
        let before;
        try { before = await webKTopicReadSnapshot(page, providerRef, topicRef.topicId); }
        catch (err) {
          firstUnexpectedError ??= err?.code || "TOPIC_SNAPSHOT_FAILED";
          continue;
        }
        const messages = await messageList({
          purpose: "PROTECTED_DISPLAY",
          args: { conversation_handle: forum.handle, topic_handle: topic.handle, limit: 5 },
        });
        if (messages.state !== "ACHIEVED") {
          firstUnexpectedError ??= messages.error || "TOPIC_MESSAGE_LIST_FAILED";
          continue;
        }
        let after;
        try { after = await webKTopicReadSnapshot(page, providerRef, topicRef.topicId); }
        catch (err) {
          firstUnexpectedError ??= err?.code || "TOPIC_POST_SNAPSHOT_FAILED";
          continue;
        }
        const readCursorUnchanged = before.read_inbox_max_id === after.read_inbox_max_id;
        const navigationUnchanged = page.url() === beforeUrl;
        const achieved = readCursorUnchanged && navigationUnchanged
          && messages.observation?.provider_content_model_visible === false;
        return semanticEnvelope(
          operation,
          achieved ? "ACHIEVED" : "FAILED",
          {
            canary_present: true,
            forum_candidate_count: forums.length,
            topic_count: topics.length,
            topic_handle: topic.handle,
            topic_scoped_message_count: messages.observation?.count ?? 0,
            read_cursor_unchanged: readCursorUnchanged,
            navigation_unchanged: navigationUnchanged,
            provider_content_model_visible: false,
          },
          [],
          null,
          achieved ? null : "TOPIC_RETRIEVAL_SIDE_EFFECT_DETECTED",
        );
      }
    }

    return semanticEnvelope(
      operation,
      firstUnexpectedError ? "FAILED" : "QUALIFICATION_REQUIRED",
      {
        canary_present: false,
        forum_candidate_count: forums.length,
        provider_content_model_visible: false,
      },
      [],
      null,
      firstUnexpectedError || "NO_FORUM_TOPIC_CANARY",
    );
  }

  async function qualifyConversationSearchNoRead() {
    const operation = "qualification.conversation.search.no_mark_read_or_navigation";
    const phase = await detectPhase();
    if (phase !== "READY") {
      return semanticEnvelope(operation, "FAILED", { connection_state: phase }, [], null, "SESSION_NOT_READY");
    }

    const page = pageNow();
    const beforeUrl = page.url();
    const before = await unreadConversationRefs(page);
    if (!before.length) {
      return semanticEnvelope(
        operation,
        "QUALIFICATION_REQUIRED",
        { canary_present: false, provider_content_model_visible: false },
        [],
        null,
        "NO_VISIBLE_UNREAD_CANARY",
      );
    }

    const providerRef = before[0];
    const handle = identity.opaqueConversationHandle(providerRef);
    const located = await locateVisibleConversationRowByHandle(page, identity, handle);
    if (!located) {
      return semanticEnvelope(operation, "FAILED", { canary_present: true }, [], null, "CANARY_SELECTION_NOT_RESOLVED");
    }
    const title = await protectedConversationTitle(located.row);
    const query = boundedSearchQuery(title.slice(0, 96));
    if (!query) {
      return semanticEnvelope(
        operation,
        "QUALIFICATION_REQUIRED",
        { canary_present: true, provider_content_model_visible: false },
        [],
        null,
        "CANARY_QUERY_UNUSABLE",
      );
    }

    const searched = await conversationSearch({
      purpose: "PROTECTED_DISPLAY",
      args: { query, limit: 20 },
    });
    if (searched.state !== "ACHIEVED") {
      return semanticEnvelope(
        operation,
        "FAILED",
        {
          canary_present: true,
          canary_handle: handle,
          search_state: searched.state,
          provider_content_model_visible: false,
        },
        [],
        null,
        "CONVERSATION_SEARCH_QUALIFICATION_CALL_FAILED",
      );
    }

    await page.waitForTimeout(900);
    const after = await unreadConversationRefs(page);
    const unreadPreserved = after.includes(providerRef);
    const foundCanary = searched.observation?.handles?.includes(handle) === true;
    const navigationUnchanged = searched.observation?.navigation_unchanged === true && page.url() === beforeUrl;
    const selectionResolved = searched.observation?.selection_resolved === true;
    const achieved = unreadPreserved && foundCanary && navigationUnchanged && selectionResolved;
    let error = null;
    if (!unreadPreserved) error = "UNREAD_CANARY_CHANGED";
    else if (!foundCanary) error = "SEARCH_CANARY_NOT_FOUND";
    else if (!navigationUnchanged) error = "SEARCH_NAVIGATION_CHANGED";
    else if (!selectionResolved) error = "SEARCH_SELECTION_NOT_RESOLVED";

    return semanticEnvelope(
      operation,
      achieved ? "ACHIEVED" : "FAILED",
      {
        canary_present: true,
        canary_handle: handle,
        unread_before: true,
        unread_after: unreadPreserved,
        search_state: searched.state,
        search_count: searched.observation?.count ?? 0,
        canary_found: foundCanary,
        navigation_unchanged: navigationUnchanged,
        selection_resolved: selectionResolved,
        provider_content_model_visible: false,
      },
      [],
      null,
      error,
    );
  }

  async function qualifyMessageRetrievalNoRead() {
    const operation = "qualification.message.list_fetch.no_mark_read_or_media_open";
    const phase = await detectPhase();
    if (phase !== "READY") {
      return semanticEnvelope(operation, "FAILED", { connection_state: phase }, [], null, "SESSION_NOT_READY");
    }

    const page = pageNow();
    const beforeUrl = page.url();
    const before = await unreadConversationRefs(page);
    if (!before.length) {
      return semanticEnvelope(
        operation,
        "QUALIFICATION_REQUIRED",
        { canary_present: false, provider_content_model_visible: false },
        [],
        null,
        "NO_VISIBLE_UNREAD_CANARY",
      );
    }

    const providerRef = before[0];
    const conversationHandle = identity.opaqueConversationHandle(providerRef);
    const listed = await messageList({
      purpose: "PROTECTED_DISPLAY",
      args: { conversation_handle: conversationHandle, limit: 10 },
    });
    if (listed.state !== "ACHIEVED" || !listed.observation?.handles?.length) {
      return semanticEnvelope(
        operation,
        "FAILED",
        {
          canary_present: true,
          canary_handle: conversationHandle,
          list_state: listed.state,
          provider_content_model_visible: false,
        },
        [],
        null,
        "MESSAGE_LIST_QUALIFICATION_FAILED",
      );
    }

    const messageHandle = listed.observation.handles[0];
    const fetched = await messageFetch({
      purpose: "PROTECTED_DISPLAY",
      args: { conversation_handle: conversationHandle, message_handle: messageHandle },
    });
    if (fetched.state !== "ACHIEVED") {
      return semanticEnvelope(
        operation,
        "FAILED",
        {
          canary_present: true,
          canary_handle: conversationHandle,
          list_state: listed.state,
          fetch_state: fetched.state,
          provider_content_model_visible: false,
        },
        [],
        null,
        "MESSAGE_FETCH_QUALIFICATION_FAILED",
      );
    }

    await page.waitForTimeout(900);
    const after = await unreadConversationRefs(page);
    const unreadPreserved = after.includes(providerRef);
    const navigationUnchanged = page.url() === beforeUrl
      && listed.observation?.navigation_unchanged === true
      && fetched.observation?.navigation_unchanged === true;
    const sameMessage = fetched.observation?.message_handle === messageHandle;
    const achieved = unreadPreserved && navigationUnchanged && sameMessage;
    let error = null;
    if (!unreadPreserved) error = "UNREAD_CANARY_CHANGED";
    else if (!navigationUnchanged) error = "MESSAGE_RETRIEVAL_NAVIGATION_CHANGED";
    else if (!sameMessage) error = "MESSAGE_FETCH_IDENTITY_MISMATCH";

    return semanticEnvelope(
      operation,
      achieved ? "ACHIEVED" : "FAILED",
      {
        canary_present: true,
        canary_handle: conversationHandle,
        unread_before: true,
        unread_after: unreadPreserved,
        list_state: listed.state,
        list_count: listed.observation?.count ?? 0,
        fetch_state: fetched.state,
        message_identity_stable: sameMessage,
        navigation_unchanged: navigationUnchanged,
        media_open_invoked: false,
        provider_content_model_visible: false,
      },
      [],
      null,
      error,
    );
  }

  async function qualifyConversationMarkRead() {
    const operation = "qualification.conversation.mark_read.count_required_fail_closed";
    const phase = await detectPhase();
    if (phase !== "READY") {
      return semanticEnvelope(operation, "FAILED", { connection_state: phase }, [], null, "SESSION_NOT_READY");
    }

    const page = pageNow();
    const beforeUrl = page.url();
    const conversations = await visibleConversationEntries(page, identity, 50);
    const target = conversations.find((item) => Number.isSafeInteger(item.unread_count) && item.unread_count > 0);
    if (!target) {
      return semanticEnvelope(
        operation,
        "QUALIFICATION_REQUIRED",
        { canary_present: false, provider_content_model_visible: false },
        [],
        null,
        "NO_VISIBLE_UNREAD_CANARY",
      );
    }

    const providerRef = identity.providerRefForHandle(target.handle);
    const unreadBefore = target.unread_count;
    const missing = await conversationMarkRead({ args: { conversation_handle: target.handle } });
    const excessive = await conversationMarkRead({
      args: { conversation_handle: target.handle, count: unreadBefore + 1 },
    });
    const refreshed = await visibleConversationEntries(page, identity, 50);
    const after = refreshed.find((item) => {
      try {
        return identity.providerRefForHandle(item.handle) === providerRef;
      } catch {
        return false;
      }
    });
    const unreadAfter = Number.isSafeInteger(after?.unread_count) ? after.unread_count : null;
    const navigationUnchanged = page.url() === beforeUrl;
    const achieved = missing.state === "FAILED"
      && missing.error === "MARK_READ_COUNT_REQUIRED"
      && missing.observation?.effect_attempted !== true
      && excessive.state === "FAILED"
      && excessive.error === "MARK_READ_COUNT_EXCEEDS_UNREAD"
      && excessive.observation?.effect_attempted !== true
      && unreadAfter === unreadBefore
      && navigationUnchanged;

    return semanticEnvelope(
      operation,
      achieved ? "ACHIEVED" : "FAILED",
      {
        canary_present: true,
        unread_before: unreadBefore,
        unread_after: unreadAfter,
        missing_count_error: missing.error ?? null,
        excessive_count_error: excessive.error ?? null,
        missing_count_effect_attempted: missing.observation?.effect_attempted === true,
        excessive_count_effect_attempted: excessive.observation?.effect_attempted === true,
        navigation_unchanged: navigationUnchanged,
        provider_content_model_visible: false,
      },
      [],
      null,
      achieved ? null : "MARK_READ_FAIL_CLOSED_QUALIFICATION_FAILED",
    );
  }

  async function qualifyMessageOpenMedia() {
    const operation = "qualification.message.open_media.exact_boundary";
    const phase = await detectPhase();
    if (phase !== "READY") {
      return semanticEnvelope(operation, "FAILED", { connection_state: phase }, [], null, "SESSION_NOT_READY");
    }

    const page = pageNow();
    const beforeUrl = page.url();
    const unreadBefore = await unreadConversationRefs(page);
    const conversations = await visibleConversationEntries(page, identity, 50);
    let target = null;

    for (const conversation of conversations) {
      let providerRef;
      try {
        providerRef = identity.providerRefForHandle(conversation.handle);
      } catch {
        continue;
      }
      let messages;
      try {
        messages = await webKListMessages(page, providerRef, 20);
      } catch {
        continue;
      }
      const message = messages.find((item) =>
        (item.media_open_kind === "voice" || item.media_open_kind === "round_video")
        && item.media_unread === true
      );
      if (message) {
        target = {
          providerRef,
          conversationHandle: conversation.handle,
          messageHandle: identity.opaqueMessageHandle(providerRef, message.mid),
          mediaKind: message.media_open_kind,
        };
        break;
      }
    }

    if (!target) {
      return semanticEnvelope(
        operation,
        "QUALIFICATION_REQUIRED",
        { canary_present: false, admitted_media_kinds: ["voice", "round_video"], provider_content_model_visible: false },
        [],
        null,
        "NO_VISIBLE_UNREAD_MEDIA_CANARY",
      );
    }

    const effect = await messageOpenMedia({
      args: {
        conversation_handle: target.conversationHandle,
        message_handle: target.messageHandle,
      },
    });

    await page.waitForTimeout(1200);
    const unreadAfter = await unreadConversationRefs(page);
    const unrelatedBefore = unreadBefore.filter((ref) => ref !== target.providerRef);
    const unrelatedUnreadPreserved = unrelatedBefore.every((ref) => unreadAfter.includes(ref));
    const navigationUnchanged = page.url() === beforeUrl;
    const providerConfirmed = effect.observation?.provider_confirmed === true;
    const targetMediaConsumed = effect.observation?.provider_observation_before?.media_unread === true
      && effect.observation?.provider_observation_after?.media_unread === false;
    const achieved = effect.state === "ACHIEVED"
      && targetMediaConsumed
      && unrelatedUnreadPreserved
      && navigationUnchanged
      && providerConfirmed;

    const observation = {
      canary_present: true,
      media_kind: target.mediaKind,
      target_media_unread_before: true,
      target_media_unread_after: effect.observation?.provider_observation_after?.media_unread ?? null,
      effect_attempted: effect.observation?.effect_attempted === true,
      effect_invocation_acknowledged: effect.observation?.effect_invocation_acknowledged === true,
      provider_confirmed: providerConfirmed,
      unrelated_unread_preserved: unrelatedUnreadPreserved,
      navigation_unchanged: navigationUnchanged,
      provider_content_model_visible: false,
    };

    if (effect.state === "IN_DOUBT" || (!achieved && effect.observation?.effect_attempted === true)) {
      return semanticEnvelope(operation, "IN_DOUBT", observation, effect.side_effects ?? [], null, effect.error || "OPEN_MEDIA_CANARY_IN_DOUBT");
    }
    return semanticEnvelope(
      operation,
      achieved ? "ACHIEVED" : "FAILED",
      observation,
      effect.side_effects ?? [],
      null,
      achieved ? null : "OPEN_MEDIA_CANARY_FAILED",
    );
  }

  async function qualifyAttachmentDownload() {
    const operation = "qualification.attachment.download.local_no_read_or_media_open";
    const phase = await detectPhase();
    if (phase !== "READY") {
      return semanticEnvelope(operation, "FAILED", { connection_state: phase }, [], null, "SESSION_NOT_READY");
    }

    const page = pageNow();
    const beforeUrl = page.url();
    const unreadBefore = await unreadConversationRefs(page);
    const unreadSet = new Set(unreadBefore);
    const conversations = await visibleConversationEntries(page, identity, 50);
    conversations.sort((a, b) => {
      let ar = null;
      let br = null;
      try { ar = identity.providerRefForHandle(a.handle); } catch {}
      try { br = identity.providerRefForHandle(b.handle); } catch {}
      return Number(unreadSet.has(br)) - Number(unreadSet.has(ar));
    });

    const skippable = new Set([
      "WEBK_DOWNLOAD_PROVIDER_RESTRICTED",
      "WEBK_DOWNLOAD_ATTACHMENT_NOT_FOUND",
      "WEBK_DOWNLOAD_ATTACHMENT_SLOT_UNSUPPORTED",
      "WEBK_DOWNLOAD_SIZE_UNKNOWN",
      "WEBK_DOWNLOAD_SIZE_OUT_OF_BOUNDS",
    ]);
    let attemptedEffect = null;
    let target = null;
    let firstUnexpectedError = null;

    outer:
    for (const conversation of conversations) {
      let providerRef;
      try {
        providerRef = identity.providerRefForHandle(conversation.handle);
      } catch {
        continue;
      }

      let messages;
      try {
        messages = await webKListMessages(page, providerRef, 20);
      } catch {
        continue;
      }

      for (const message of messages) {
        const attachments = Array.isArray(message.attachments) ? message.attachments : [];
        for (const attachment of attachments) {
          if (!Number.isSafeInteger(attachment.size_bytes)
              || attachment.size_bytes < 1
              || attachment.size_bytes > downloadBroker.maxFileBytes) {
            continue;
          }

          const messageHandle = identity.opaqueMessageHandle(providerRef, message.mid);
          const attachmentHandle = identity.opaqueAttachmentHandle(providerRef, message.mid, attachment.slot);
          const effect = await attachmentDownload({
            purpose: "LOCAL_DOWNLOAD",
            args: {
              conversation_handle: conversation.handle,
              message_handle: messageHandle,
              attachment_handle: attachmentHandle,
            },
          });

          if (effect.state === "FAILED") {
            if (!skippable.has(effect.error)) firstUnexpectedError ??= effect.error || "DOWNLOAD_CANARY_FAILED";
            continue;
          }

          target = {
            providerRef,
            conversationHandle: conversation.handle,
            messageHandle,
            attachmentHandle,
            slot: attachment.slot,
          };
          attemptedEffect = effect;
          break outer;
        }
      }
    }

    if (!target || !attemptedEffect) {
      return semanticEnvelope(
        operation,
        firstUnexpectedError ? "FAILED" : "QUALIFICATION_REQUIRED",
        {
          canary_present: false,
          admitted_attachment_slots: ["document", "photo"],
          max_file_bytes: downloadBroker.maxFileBytes,
          provider_content_model_visible: false,
        },
        [],
        null,
        firstUnexpectedError || "NO_DOWNLOADABLE_ATTACHMENT_CANARY",
      );
    }

    const fileHandle = attemptedEffect.observation?.file_handle;
    let brokerVerified = false;
    let cleanupConfirmed = false;
    if (typeof fileHandle === "string" && fileHandle.startsWith("file:")) {
      try {
        const stat = downloadBroker.inspect(fileHandle);
        brokerVerified = Number.isSafeInteger(stat.size_bytes) && stat.size_bytes > 0
          && stat.size_bytes <= downloadBroker.maxFileBytes;
      } catch {}
      try {
        const released = downloadBroker.release(fileHandle);
        let missingAfterRelease = false;
        try {
          downloadBroker.inspect(fileHandle);
        } catch (err) {
          missingAfterRelease = err?.code === "UNKNOWN_FILE_HANDLE";
        }
        cleanupConfirmed = released && missingAfterRelease;
      } catch {}
    }

    await page.waitForTimeout(900);
    const unreadAfter = await unreadConversationRefs(page);
    const unrelatedBefore = unreadBefore.filter((ref) => ref !== target.providerRef);
    const unrelatedUnreadPreserved = unrelatedBefore.every((ref) => unreadAfter.includes(ref));
    const targetUnreadPreserved = !unreadSet.has(target.providerRef) || unreadAfter.includes(target.providerRef);
    const beforeProvider = attemptedEffect.observation?.provider_observation_before ?? null;
    const afterProvider = attemptedEffect.observation?.provider_observation_after ?? null;
    const targetReadStateUnchanged = beforeProvider !== null && afterProvider !== null
      && beforeProvider.read_inbox_max_id === afterProvider.read_inbox_max_id
      && beforeProvider.target_read === afterProvider.target_read;
    const targetMediaUnreadUnchanged = beforeProvider !== null && afterProvider !== null
      && beforeProvider.media_unread === afterProvider.media_unread;
    const navigationUnchanged = attemptedEffect.observation?.navigation_unchanged === true
      && page.url() === beforeUrl;
    const providerStateUnchanged = attemptedEffect.observation?.provider_state_unchanged === true;
    const achieved = attemptedEffect.state === "ACHIEVED"
      && attemptedEffect.observation?.local_file_acquired === true
      && attemptedEffect.observation?.provider_restriction_checked === true
      && attemptedEffect.observation?.provider_state_checked === true
      && providerStateUnchanged
      && targetReadStateUnchanged
      && targetMediaUnreadUnchanged
      && targetUnreadPreserved
      && unrelatedUnreadPreserved
      && navigationUnchanged
      && brokerVerified
      && cleanupConfirmed;

    const observation = {
      canary_present: true,
      attachment_slot: target.slot,
      local_file_acquired: attemptedEffect.observation?.local_file_acquired === true,
      file_handle_opaque: attemptedEffect.observation?.file_handle_opaque === true,
      broker_verified: brokerVerified,
      cleanup_confirmed: cleanupConfirmed,
      provider_restriction_checked: attemptedEffect.observation?.provider_restriction_checked === true,
      provider_state_checked: attemptedEffect.observation?.provider_state_checked === true,
      provider_state_unchanged: providerStateUnchanged,
      target_read_state_unchanged: targetReadStateUnchanged,
      target_media_unread_unchanged: targetMediaUnreadUnchanged,
      target_unread_preserved: targetUnreadPreserved,
      unrelated_unread_preserved: unrelatedUnreadPreserved,
      navigation_unchanged: navigationUnchanged,
      provider_content_model_visible: false,
    };

    if (attemptedEffect.state === "IN_DOUBT") {
      return semanticEnvelope(
        operation,
        "IN_DOUBT",
        observation,
        attemptedEffect.side_effects ?? [],
        null,
        attemptedEffect.error || "DOWNLOAD_CANARY_IN_DOUBT",
      );
    }

    return semanticEnvelope(
      operation,
      achieved ? "ACHIEVED" : "FAILED",
      observation,
      attemptedEffect.side_effects ?? [],
      null,
      achieved ? null : "DOWNLOAD_CANARY_FAILED",
    );
  }

  async function qualifyComposerFoundation() {
    const operation = "qualification.composer.local_exact_target_no_send";
    const phase = await detectPhase();
    if (phase !== "READY") {
      return semanticEnvelope(operation, "FAILED", { connection_state: phase }, [], null, "SESSION_NOT_READY");
    }

    let unknownTargetFailClosed = false;
    try {
      composer.resolveExactTarget("tgchat:00000000-0000-0000-0000-000000000000");
    } catch (err) {
      unknownTargetFailClosed = err?.code === "UNKNOWN_CONVERSATION_HANDLE";
    }
    if (!unknownTargetFailClosed) {
      return semanticEnvelope(
        operation,
        "FAILED",
        { unknown_target_fail_closed: false, provider_content_model_visible: false },
        [],
        null,
        "COMPOSER_UNKNOWN_TARGET_NOT_FAIL_CLOSED",
      );
    }

    const page = pageNow();
    const beforeUrl = page.url();
    const unreadBefore = await unreadConversationRefs(page);
    const conversations = await visibleConversationEntries(page, identity, 30);
    if (!conversations.length) {
      return semanticEnvelope(
        operation,
        "QUALIFICATION_REQUIRED",
        {
          canary_present: false,
          unknown_target_fail_closed: true,
          provider_content_model_visible: false,
        },
        [],
        null,
        "NO_COMPOSER_TARGET_CANARY",
      );
    }

    const skippableDrift = new Set([
      "WEBK_COMPOSER_PROVIDER_DRAFT_CHANGED",
      "WEBK_COMPOSER_MESSAGE_TOP_CHANGED",
      "WEBK_COMPOSER_READ_STATE_CHANGED",
    ]);
    let target = null;
    let effect = null;
    let firstUnexpectedError = null;

    for (const conversation of conversations) {
      const canaryText = "pcg-composer-canary-" + randomUUID();
      let candidate;
      try {
        candidate = await composer.prepareLocal(page, {
          conversationHandle: conversation.handle,
          text: canaryText,
        });
      } catch (err) {
        firstUnexpectedError ??= err?.code || "COMPOSER_FOUNDATION_CALL_FAILED";
        continue;
      }

      if (candidate.outcome === "ACHIEVED") {
        target = conversation;
        effect = candidate;
        break;
      }

      if (!skippableDrift.has(candidate.error)) {
        firstUnexpectedError ??= candidate.error || "COMPOSER_FOUNDATION_FAILED";
        break;
      }
    }

    if (!target || !effect) {
      return semanticEnvelope(
        operation,
        firstUnexpectedError ? "FAILED" : "QUALIFICATION_REQUIRED",
        {
          canary_present: false,
          unknown_target_fail_closed: true,
          candidate_count: conversations.length,
          provider_content_model_visible: false,
        },
        [],
        null,
        firstUnexpectedError || "NO_STABLE_COMPOSER_CANARY",
      );
    }

    await page.waitForTimeout(450);
    const unreadAfter = await unreadConversationRefs(page);
    let targetProviderRef;
    try {
      targetProviderRef = identity.providerRefForHandle(target.handle);
    } catch {
      return semanticEnvelope(operation, "FAILED", {}, [], null, "COMPOSER_TARGET_HANDLE_DRIFT");
    }

    const targetWasUnread = unreadBefore.includes(targetProviderRef);
    const targetUnreadPreserved = !targetWasUnread || unreadAfter.includes(targetProviderRef);
    const unrelatedBefore = unreadBefore.filter((ref) => ref !== targetProviderRef);
    const unrelatedUnreadPreserved = unrelatedBefore.every((ref) => unreadAfter.includes(ref));
    const navigationUnchanged = page.url() === beforeUrl;

    const achieved =
      effect.target_resolved === true
      && effect.local_composer_set === true
      && effect.local_composer_restored === true
      && effect.provider_draft_unchanged === true
      && effect.provider_message_top_unchanged === true
      && effect.provider_read_state_unchanged === true
      && effect.server_draft_write_invoked === false
      && effect.send_primitive_invoked === false
      && effect.typing_primitive_invoked === false
      && unknownTargetFailClosed
      && targetUnreadPreserved
      && unrelatedUnreadPreserved
      && navigationUnchanged;

    return semanticEnvelope(
      operation,
      achieved ? "ACHIEVED" : "FAILED",
      {
        canary_present: true,
        target_handle: target.handle,
        target_resolved: effect.target_resolved === true,
        unknown_target_fail_closed: unknownTargetFailClosed,
        local_before_present: effect.local_before_present === true,
        local_composer_set: effect.local_composer_set === true,
        local_composer_restored: effect.local_composer_restored === true,
        provider_draft_unchanged: effect.provider_draft_unchanged === true,
        provider_message_top_unchanged: effect.provider_message_top_unchanged === true,
        provider_read_state_unchanged: effect.provider_read_state_unchanged === true,
        server_draft_write_invoked: effect.server_draft_write_invoked === true,
        send_primitive_invoked: effect.send_primitive_invoked === true,
        typing_primitive_invoked: effect.typing_primitive_invoked === true,
        target_was_unread: targetWasUnread,
        target_unread_preserved: targetUnreadPreserved,
        unrelated_unread_preserved: unrelatedUnreadPreserved,
        navigation_unchanged: navigationUnchanged,
        provider_content_model_visible: false,
      },
      ["transient_local_browser_composer_buffer_restored"],
      null,
      achieved ? null : (effect.error || "COMPOSER_FOUNDATION_CANARY_FAILED"),
    );
  }

  function capabilityGapList(req) {
    const operation = "diagnostics.capability_gap.list";
    const requested = req?.args?.limit ?? req?.args?.max_entries;
    const limit = Number.isSafeInteger(requested) ? requested : 100;
    if (requested !== undefined && !Number.isSafeInteger(requested)) {
      return teachingEnvelope(operation, "INVALID_GAP_LIMIT", "Pass limit as a whole number between 1 and 400, or omit it for the default of 100.");
    }
    return semanticEnvelope(operation, "ACHIEVED", summarizeGaps({ limit }), []);
  }

  async function invoke(request) {
    // Every entry point derives the purpose the same way, so the two sockets
    // cannot disagree. A caller can never widen it, because the value comes
    // from the capability registry rather than from the request.
    // Operation names are part of the interface a model has to guess at, so
    // the same tolerance that applies to argument names applies here: a
    // recognisable intent is translated to the canonical operation instead of
    // being refused. Unknown names still get a teaching refusal.
    const OPERATION_ALIASES = {
      "communication.conversation.get": "communication.message.list",
      "communication.conversation.read": "communication.message.list",
      "communication.conversation.messages": "communication.message.list",
      "communication.conversation.history": "communication.message.list",
      "communication.messages.list": "communication.message.list",
      "communication.message.read": "communication.message.list",
      "communication.message.history": "communication.message.list",
      "communication.message.get": "communication.message.fetch",
      "communication.messages.get": "communication.message.fetch",
      "communication.message.forward": "communication.message.forward-native",
      "communication.message.forward_native": "communication.message.forward-native",
      "communication.conversation.pin": "communication.conversation.pin.set",
      "communication.conversation.unpin": "communication.conversation.pin.set",
      "communication.conversation.mute": "communication.notification.set",
      "communication.conversation.unmute": "communication.notification.set",
      "communication.conversation.mark_as_read": "communication.conversation.mark_read",
    "communication.conversation.mark_as_unread": "communication.conversation.mark_unread",
      "communication.message.reaction": "communication.message.react",
      "communication.message.react.set": "communication.message.react",
      "communication.chat.list": "communication.conversation.list",
      "communication.chat.search": "communication.conversation.search",
    };
    const requestedOperation = typeof request?.operation === "string" ? request.operation : null;
    const canonicalOperation = requestedOperation && OPERATION_ALIASES[requestedOperation]
      ? OPERATION_ALIASES[requestedOperation]
      : requestedOperation;
    if (canonicalOperation && canonicalOperation !== requestedOperation) {
      const desiredMute = requestedOperation === "communication.conversation.mute"
        ? true
        : requestedOperation === "communication.conversation.unmute"
          ? false
          : undefined;
      request = {
        ...request,
        operation: canonicalOperation,
        requested_operation: requestedOperation,
        ...(desiredMute === undefined ? {} : { args: { ...(request?.args || {}), muted: desiredMute } }),
      };
    }
    const derivedPurpose = typeof request?.operation === "string" ? purposeFor(request.operation) : null;
    const req = derivedPurpose ? { ...request, purpose: derivedPurpose } : request;
    if (typeof req.operation !== "string" || !req.operation) {
      const err = new Error("INVALID_SEMANTIC_OPERATION");
      err.code = "INVALID_SEMANTIC_OPERATION";
      throw err;
    }
    switch (req.operation) {
      case "communication.session.status":
        return sessionStatus();
      case "communication.session.screenshot":
        return sessionScreenshot(req);
      case "communication.conversation.list":
        return conversationList(req);
      case "communication.conversation.search":
        return conversationSearch(req);
      case "communication.contact.search":
        return contactSearch(req);
      case "communication.topic.list":
        return topicList(req);
      case "communication.message.list":
        return messageList(req);
      case "communication.message.fetch":
        return messageFetch(req);
      case "communication.message.replies":
        return messageReplies(req);
      case "communication.message.transcribe":
        return messageTranscribe(req);
      case "communication.audio.transcribe":
        return audioTranscribe(req);
      case "communication.message.search":
        return messageSearch(req);
      case "communication.message.reaction.get":
        return messageReactionGet(req);
      case "communication.conversation.pin.set":
        return conversationPinSet(req);
      case "communication.notification.set":
        return notificationSet(req);
      case "communication.conversation.mark_read":
        return conversationMarkRead(req);
      case "communication.conversation.mark_unread":
        return conversationMarkUnread(req);
      case "communication.message.open_media":
        return messageOpenMedia(req);
      case "diagnostics.capability_gap.list":
        return capabilityGapList(req);
      case "communication.message.react":
        return messageReact(req);
      case "communication.attachment.download":
        return attachmentDownload(req);
      case "communication.audio.voice.prepare":
        return audioVoicePrepare(req);
      case "communication.message.send":
        return messageSend(req);
      case "communication.message.reply":
        return messageReply(req);
      case "communication.message.edit":
        return messageEdit(req);
      case "communication.message.delete":
        return messageDelete(req);
      case "communication.message.forward-native":
        return messageForwardNative(req);
      case "communication.message.relay":
        return messageRelay(req);
      default:
        return teachingEnvelope(
          req.operation,
          "UNSUPPORTED_SEMANTIC_OPERATION",
          "This operation is not part of the closed capability registry. Choose one of the nearest listed operations, or read the full registry with communication.session.status.",
          { state: "UNSUPPORTED" },
        );
    }
  }

  return {
    attachmentDownload,
    capabilities,
    capabilityGapList,
    conversationList,
    conversationMarkRead,
    conversationMarkUnread,
    conversationPinSet,
    notificationSet,
    conversationSearch,
    contactSearch,
    invoke,
    purposeFor,
    messageFetch,
    messageReplies,
    messageTranscribe,
    audioTranscribe,
    messageReactionGet,
    messageSearch,
    messageList,
    messageDelete,
    messageEdit,
    messageForwardNative,
    messageRelay,
    messageReply,
    messageSend,
    messageOpenMedia,
    messageReact,
    qualifyAttachmentDownload,
    qualifyComposerFoundation,
    qualifyConversationListNoRead,
    qualifyConversationMarkRead,
    qualifyConversationSearchNoRead,
    qualifyConversationStructure,
    qualifyTopicRetrievalNoRead,
    qualifyMessageRetrievalNoRead,
    qualifyMessageOpenMedia,
    semanticPurposeAllowed,
    sessionScreenshot,
    sessionStatus,
    topicList,
  };
}
