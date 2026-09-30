import { createHash, randomUUID } from "node:crypto";
import { createConversationIdentity } from "./pcg_web_identity.mjs";
import { createComposerFoundation } from "./pcg_web_composer.mjs";
import { createPrivateFileBroker } from "./pcg_web_file_broker.mjs";
import {
  locateVisibleConversationRowByHandle,
  protectedConversationTitle,
  unreadConversationRefs,
  visibleConversationEntries,
  withConversationSearch,
} from "./pcg_web_primitives.mjs";
import { webKDownloadAttachment, webKFetchMessage, webKListMessages, webKMarkConversationRead, webKOpenMessageMedia, webKSetMessageReaction } from "./pcg_web_webk_bridge.mjs";
import { webKListConversationStructure, webKListTopics, webKSetConversationPin, webKTopicReadSnapshot } from "./pcg_web_structure.mjs";

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
  const downloadBroker = createPrivateFileBroker(downloadBrokerRoot);

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

  function sendTextArgument(args) {
    for (const key of ["text", "message", "body", "content"]) {
      const value = args?.[key];
      if (typeof value === "string" && value.trim()) return value;
    }
    return null;
  }

  function conversationHandleArgument(args) {
    for (const key of ["conversation_handle", "handle", "conversation", "chat_handle"]) {
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

  async function materialOperation(operation, req) {
    const family = MATERIAL_FAMILIES[operation];
    if (!family) {
      return semanticEnvelope(operation, "UNSUPPORTED", {}, [], null, "UNSUPPORTED_SEMANTIC_OPERATION");
    }
    const args = req?.args && typeof req.args === "object" && !Array.isArray(req.args) ? req.args : {};
    const needs = new Set(family.requires);

    const conversationHandle = conversationHandleArgument(args);
    const sourceConversationHandle = trimmedArgument(args, ["source_conversation_handle", "from_conversation_handle"])
      || (needs.has("source_conversation") ? null : conversationHandle);
    const messageHandle = trimmedArgument(args, ["message_handle", "target_message_handle"]);
    const sourceMessageHandle = trimmedArgument(args, ["source_message_handle", "message_handle", "reply_to_message_handle"]);
    const text = sendTextArgument(args);
    const scope = trimmedArgument(args, ["scope", "deletion_scope"]) || "SELF_ONLY";
    const purpose = trimmedArgument(args, ["relay_purpose"]) || "TRANSPORT_RELAY";
    const sourceText = typeof args.source_text === "string" && args.source_text ? args.source_text : null;
    const sourceContentSha256 = trimmedArgument(args, ["source_content_sha256"])
      || (sourceText ? sha256Hex(sourceText) : null);

    if (needs.has("conversation") && !conversationHandle) {
      return semanticEnvelope(operation, "FAILED", {}, [], null, "CONVERSATION_HANDLE_REQUIRED");
    }
    if (needs.has("source_conversation") && !sourceConversationHandle) {
      return semanticEnvelope(operation, "FAILED", {}, [], null, "SOURCE_CONVERSATION_HANDLE_REQUIRED");
    }
    if (needs.has("message") && !messageHandle) {
      return semanticEnvelope(operation, "FAILED", {}, [], null, "MESSAGE_HANDLE_REQUIRED");
    }
    if (needs.has("source_message") && !sourceMessageHandle) {
      return semanticEnvelope(operation, "FAILED", {}, [], null, "SOURCE_MESSAGE_HANDLE_REQUIRED");
    }
    if (needs.has("text")) {
      if (!text) return semanticEnvelope(operation, "FAILED", {}, [], null, "MESSAGE_TEXT_REQUIRED");
      if (text.length > 4096) return semanticEnvelope(operation, "FAILED", {}, [], null, "MESSAGE_TEXT_TOO_LONG");
    }
    if (needs.has("scope") && scope !== "SELF_ONLY" && scope !== "FOR_EVERYONE") {
      return semanticEnvelope(operation, "FAILED", {}, [], null, "DELETION_SCOPE_UNSUPPORTED");
    }
    if (needs.has("irreversible_confirmation") && args.confirm_irreversible !== true) {
      return semanticEnvelope(operation, "FAILED", {}, [], null, "IRREVERSIBLE_CONFIRMATION_REQUIRED");
    }
    if (needs.has("relay_purpose") && purpose !== "TRANSPORT_RELAY") {
      return semanticEnvelope(operation, "FAILED", {}, [], null, "RELAY_PURPOSE_UNSUPPORTED");
    }
    if (needs.has("source_digest") && !/^[0-9a-f]{64}$/.test(sourceContentSha256 || "")) {
      return semanticEnvelope(operation, "FAILED", {}, [], null, "SOURCE_CONTENT_DIGEST_REQUIRED");
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

    try {
      await family.check(bridge, page, context);
      const dispatched = await family.dispatch(bridge, page, context);

      let observed = null;
      for (let attempt = 0; attempt < 12; attempt += 1) {
        observed = await family.observe(bridge, page, context);
        if (observed?.state === "SUCCEEDED" || observed?.state === "FAILED") break;
        await page.waitForTimeout(500);
      }

      const providerState = observed?.state || dispatched?.ack_state || "UNKNOWN";
      const state = observed?.state === "SUCCEEDED"
        ? "ACHIEVED"
        : (observed?.state === "FAILED" ? "FAILED" : "UNKNOWN");
      const observation = {
        conversation_handle: conversationHandle,
        attempt_id: attemptId,
        delivery_state: providerState,
        provider_confirmed: observed?.provider_confirmed === true,
        provider_rejected: observed?.provider_rejected === true,
        provider_error_code: observed?.provider_error_code ?? null,
        final_message_known: observed?.final_message_known === true,
        final_message_count: observed?.final_message_count ?? 0,
        text_length: typeof text === "string" ? text.length : 0,
        text_sha256: context.payloadSha256,
        provider_content_model_visible: false,
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
      return semanticEnvelope(operation, "FAILED", { conversation_handle: conversationHandle, attempt_id: attemptId }, [], null, err?.code || "MATERIAL_OPERATION_FAILED");
    }
  }

  async function messageSend(req) {
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

  function capabilities() {
    return [
      {
        operation: "communication.session.status",
        support: "IMPLEMENTED",
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
        operation: "communication.conversation.pin.set",
        support: "IMPLEMENTED_EXACT_HIDDEN_DESIRED_STATE",
        side_effect_class: "provider-synced-state",
        provider_content: "NONE",
      },
      {
        operation: "communication.conversation.mark_read",
        support: "IMPLEMENTED_EXACT_HIDDEN",
        side_effect_class: "provider-visible-read",
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
        support: "IMPLEMENTED_EXACT_HIDDEN_BOUNDED",
        side_effect_class: "local-acquisition",
        provider_content: "PROTECTED_ONLY",
      },
      {
        operation: "communication.message.send",
        support: "IMPLEMENTED_EXACT_HIDDEN_TEXT_ATTACHMENT_CAPTION_PHOTO_ALBUM",
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

  async function sessionStatus() {
    const phase = await detectPhase();
    return semanticEnvelope(
      "communication.session.status",
      "ACHIEVED",
      {
        connection_state: phase,
        logged_in: phase === "READY",
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
    const rawLimit = req.args?.limit ?? 20;
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
    const rawLimit = req.args?.limit ?? 20;
    if (!Number.isInteger(rawLimit) || rawLimit < 1 || rawLimit > 50) {
      return semanticEnvelope(operation, "FAILED", {}, [], null, "INVALID_LIMIT");
    }

    const page = pageNow();
    const searched = await withConversationSearch(page, query, async () => {
      const entries = await visibleConversationEntries(page, identity, rawLimit);
      for (const entry of entries) {
        const selected = await locateVisibleConversationRowByHandle(page, identity, entry.handle);
        if (!selected) {
          const err = new Error("SEARCH_SELECTION_RESOLUTION_FAILED");
          err.code = "SEARCH_SELECTION_RESOLUTION_FAILED";
          throw err;
        }
      }
      return entries;
    });

    if (!searched.navigationUnchanged) {
      return semanticEnvelope(operation, "FAILED", { provider_content_model_visible: false }, [], null, "SEARCH_NAVIGATION_CHANGED");
    }

    const entries = searched.result;
    return semanticEnvelope(
      operation,
      "ACHIEVED",
      {
        count: entries.length,
        handles: entries.map((item) => item.handle),
        bounded: true,
        navigation_unchanged: true,
        selection_resolved: true,
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

  async function topicList(req) {
    const operation = "communication.topic.list";
    if (!semanticPurposeAllowed(req.purpose)) {
      return semanticEnvelope(operation, "FAILED", {}, [], null, "DATA_USE_PURPOSE_NOT_ALLOWED");
    }
    const phase = await detectPhase();
    if (phase !== "READY") {
      return semanticEnvelope(operation, "FAILED", { connection_state: phase }, [], null, "SESSION_NOT_READY");
    }
    const conversationHandle = req.args?.conversation_handle;
    let providerRef;
    try {
      providerRef = identity.providerRefForHandle(conversationHandle);
    } catch (err) {
      return semanticEnvelope(operation, "FAILED", {}, [], null, err?.code || "INVALID_CONVERSATION_HANDLE");
    }
    const rawLimit = req.args?.limit ?? 50;
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
        media_type: attachment.media_type,
        size_bytes: attachment.size_bytes,
        filename: attachment.filename,
      })),
      service_action: message.service_action,
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
    const conversationHandle = req.args?.conversation_handle;
    let providerRef;
    try {
      providerRef = identity.providerRefForHandle(conversationHandle);
    } catch (err) {
      return semanticEnvelope(operation, "FAILED", {}, [], null, err?.code || "INVALID_CONVERSATION_HANDLE");
    }
    const rawLimit = req.args?.limit ?? 20;
    if (!Number.isInteger(rawLimit) || rawLimit < 1 || rawLimit > 100) {
      return semanticEnvelope(operation, "FAILED", {}, [], null, "INVALID_LIMIT");
    }
    const topicHandle = req.args?.topic_handle ?? null;
    let threadId = null;
    if (topicHandle !== null) {
      try {
        const topicRef = identity.providerTopicRefForHandle(topicHandle);
        if (topicRef.providerRef !== providerRef) {
          return semanticEnvelope(operation, "FAILED", {}, [], null, "TOPIC_CONVERSATION_MISMATCH");
        }
        threadId = topicRef.topicId;
      } catch (err) {
        return semanticEnvelope(operation, "FAILED", {}, [], null, err?.code || "INVALID_TOPIC_HANDLE");
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
        return semanticEnvelope(operation, "FAILED", {}, [], null, err?.code || "INVALID_MESSAGE_CURSOR");
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

  async function messageFetch(req) {
    const operation = "communication.message.fetch";
    if (!semanticPurposeAllowed(req.purpose)) {
      return semanticEnvelope(operation, "FAILED", {}, [], null, "DATA_USE_PURPOSE_NOT_ALLOWED");
    }
    const phase = await detectPhase();
    if (phase !== "READY") {
      return semanticEnvelope(operation, "FAILED", { connection_state: phase }, [], null, "SESSION_NOT_READY");
    }

    const conversationHandle = req.args?.conversation_handle;
    const messageHandle = req.args?.message_handle;
    let providerRef;
    let messageRef;
    try {
      providerRef = identity.providerRefForHandle(conversationHandle);
      messageRef = identity.providerMessageRefForHandle(messageHandle);
    } catch (err) {
      return semanticEnvelope(operation, "FAILED", {}, [], null, err?.code || "INVALID_MESSAGE_HANDLE");
    }
    if (messageRef.providerRef !== providerRef) {
      return semanticEnvelope(operation, "FAILED", {}, [], null, "MESSAGE_CONVERSATION_MISMATCH");
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

  async function conversationPinSet(req) {
    const operation = "communication.conversation.pin.set";
    const phase = await detectPhase();
    if (phase !== "READY") {
      return semanticEnvelope(operation, "FAILED", { connection_state: phase }, [], null, "SESSION_NOT_READY");
    }

    const conversationHandle = req.args?.conversation_handle;
    const pinned = req.args?.pinned;
    if (typeof pinned !== "boolean") {
      return semanticEnvelope(operation, "FAILED", {}, [], null, "INVALID_PIN_STATE");
    }

    let providerRef;
    try {
      providerRef = identity.providerRefForHandle(conversationHandle);
    } catch (err) {
      return semanticEnvelope(operation, "FAILED", {}, [], null, err?.code || "INVALID_CONVERSATION_PIN_TARGET");
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

  async function conversationMarkRead(req) {
    const operation = "communication.conversation.mark_read";
    const phase = await detectPhase();
    if (phase !== "READY") {
      return semanticEnvelope(operation, "FAILED", { connection_state: phase }, [], null, "SESSION_NOT_READY");
    }

    const conversationHandle = req.args?.conversation_handle;
    const messageHandle = req.args?.message_handle;
    let providerRef;
    let messageRef;
    try {
      providerRef = identity.providerRefForHandle(conversationHandle);
      messageRef = identity.providerMessageRefForHandle(messageHandle);
    } catch (err) {
      return semanticEnvelope(operation, "FAILED", {}, [], null, err?.code || "INVALID_MARK_READ_TARGET");
    }
    if (messageRef.providerRef !== providerRef) {
      return semanticEnvelope(operation, "FAILED", {}, [], null, "MESSAGE_CONVERSATION_MISMATCH");
    }

    const page = pageNow();
    const beforeUrl = page.url();
    let effect;
    try {
      effect = await webKMarkConversationRead(page, providerRef, messageRef.mid);
    } catch (err) {
      return semanticEnvelope(operation, "FAILED", { provider_content_model_visible: false }, [], null, err?.code || "WEBK_MARK_READ_FAILED");
    }

    const navigationUnchanged = page.url() === beforeUrl;
    const observation = {
      conversation_handle: conversationHandle,
      message_handle: messageHandle,
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

    const conversationHandle = req.args?.conversation_handle;
    const messageHandle = req.args?.message_handle;
    let providerRef;
    let messageRef;
    try {
      providerRef = identity.providerRefForHandle(conversationHandle);
      messageRef = identity.providerMessageRefForHandle(messageHandle);
    } catch (err) {
      return semanticEnvelope(operation, "FAILED", {}, [], null, err?.code || "INVALID_OPEN_MEDIA_TARGET");
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
    const operation = "communication.message.react";
    const phase = await detectPhase();
    if (phase !== "READY") {
      return semanticEnvelope(operation, "FAILED", { connection_state: phase }, [], null, "SESSION_NOT_READY");
    }

    const conversationHandle = req.args?.conversation_handle;
    const messageHandle = req.args?.message_handle;
    const emoji = req.args?.emoji;
    if (typeof emoji !== "string" || !emoji || emoji.length > 16 || /[\u0000-\u001f\u007f]/u.test(emoji)) {
      return semanticEnvelope(operation, "FAILED", {}, [], null, "INVALID_REACTION_EMOJI");
    }

    let providerRef;
    let messageRef;
    try {
      providerRef = identity.providerRefForHandle(conversationHandle);
      messageRef = identity.providerMessageRefForHandle(messageHandle);
    } catch (err) {
      return semanticEnvelope(operation, "FAILED", {}, [], null, err?.code || "INVALID_REACTION_TARGET");
    }
    if (messageRef.providerRef !== providerRef) {
      return semanticEnvelope(operation, "FAILED", {}, [], null, "MESSAGE_CONVERSATION_MISMATCH");
    }

    const page = pageNow();
    const beforeUrl = page.url();
    let effect;
    try {
      effect = await webKSetMessageReaction(page, providerRef, messageRef.mid, emoji);
    } catch (err) {
      return semanticEnvelope(operation, "FAILED", { provider_content_model_visible: false }, [], null, err?.code || "WEBK_REACTION_FAILED");
    }

    const navigationUnchanged = page.url() === beforeUrl;
    const observation = {
      conversation_handle: conversationHandle,
      message_handle: messageHandle,
      reaction: emoji,
      selected_before: effect.selected_before === true,
      selected_after: effect.selected_after === true,
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

  async function attachmentDownload(req) {
    const operation = "communication.attachment.download";
    if (!downloadPurposeAllowed(req.purpose)) {
      return semanticEnvelope(operation, "FAILED", {}, [], null, "DATA_USE_PURPOSE_NOT_ALLOWED");
    }
    const phase = await detectPhase();
    if (phase !== "READY") {
      return semanticEnvelope(operation, "FAILED", { connection_state: phase }, [], null, "SESSION_NOT_READY");
    }

    const conversationHandle = req.args?.conversation_handle;
    const messageHandle = req.args?.message_handle;
    const attachmentHandle = req.args?.attachment_handle;
    let providerRef;
    let messageRef;
    let attachmentRef;
    try {
      providerRef = identity.providerRefForHandle(conversationHandle);
      messageRef = identity.providerMessageRefForHandle(messageHandle);
      attachmentRef = identity.providerAttachmentRefForHandle(attachmentHandle);
    } catch (err) {
      return semanticEnvelope(operation, "FAILED", {}, [], null, err?.code || "INVALID_DOWNLOAD_TARGET");
    }

    if (messageRef.providerRef !== providerRef) {
      return semanticEnvelope(operation, "FAILED", {}, [], null, "MESSAGE_CONVERSATION_MISMATCH");
    }
    if (attachmentRef.providerRef !== providerRef || attachmentRef.mid !== messageRef.mid) {
      return semanticEnvelope(operation, "FAILED", {}, [], null, "ATTACHMENT_MESSAGE_MISMATCH");
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

    const navigationUnchanged = page.url() === beforeUrl;
    const observation = {
      conversation_handle: conversationHandle,
      message_handle: messageHandle,
      attachment_handle: attachmentHandle,
      file_handle: lease.file_handle,
      local_file_acquired: true,
      file_handle_opaque: lease.file_handle.startsWith("file:"),
      ttl_seconds: lease.ttl_seconds,
      bounded_size: lease.size_bytes <= downloadBroker.maxFileBytes,
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
      ["local_file_acquired"],
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
    const operation = "qualification.conversation.mark_read.exact_boundary";
    const phase = await detectPhase();
    if (phase !== "READY") {
      return semanticEnvelope(operation, "FAILED", { connection_state: phase }, [], null, "SESSION_NOT_READY");
    }

    const page = pageNow();
    const beforeUrl = page.url();
    const beforeUnread = await unreadConversationRefs(page);
    if (!beforeUnread.length) {
      return semanticEnvelope(
        operation,
        "QUALIFICATION_REQUIRED",
        { canary_present: false, provider_content_model_visible: false },
        [],
        null,
        "NO_VISIBLE_UNREAD_CANARY",
      );
    }

    const providerRef = beforeUnread[0];
    const conversationHandle = identity.opaqueConversationHandle(providerRef);
    const listed = await messageList({
      purpose: "PROTECTED_DISPLAY",
      args: { conversation_handle: conversationHandle, limit: 10 },
    });
    if (listed.state !== "ACHIEVED" || !listed.observation?.handles?.length) {
      return semanticEnvelope(
        operation,
        "QUALIFICATION_REQUIRED",
        {
          canary_present: true,
          target_was_unread: true,
          provider_content_model_visible: false,
        },
        [],
        null,
        "NO_MESSAGE_BOUNDARY_FOR_UNREAD_CANARY",
      );
    }

    const messageHandle = listed.observation.handles[0];
    const effect = await conversationMarkRead({
      args: { conversation_handle: conversationHandle, message_handle: messageHandle },
    });

    await page.waitForTimeout(1200);
    const afterUnread = await unreadConversationRefs(page);
    const targetReadAfter = !afterUnread.includes(providerRef);
    const unrelatedBefore = beforeUnread.filter((ref) => ref !== providerRef);
    const unrelatedUnreadPreserved = unrelatedBefore.every((ref) => afterUnread.includes(ref));
    const navigationUnchanged = page.url() === beforeUrl;
    const providerConfirmed = effect.observation?.provider_confirmed === true;
    const achieved = effect.state === "ACHIEVED"
      && targetReadAfter
      && unrelatedUnreadPreserved
      && navigationUnchanged
      && providerConfirmed;

    const observation = {
      canary_present: true,
      target_was_unread: true,
      target_read_after: targetReadAfter,
      provider_observation_before: effect.observation?.provider_observation_before ?? null,
      provider_observation_after: effect.observation?.provider_observation_after ?? null,
      effect_attempted: effect.observation?.effect_attempted === true,
      effect_invocation_acknowledged: effect.observation?.effect_invocation_acknowledged === true,
      provider_confirmed: providerConfirmed,
      unrelated_unread_preserved: unrelatedUnreadPreserved,
      navigation_unchanged: navigationUnchanged,
      provider_content_model_visible: false,
    };

    if (effect.state === "IN_DOUBT" || (!achieved && effect.observation?.effect_attempted === true)) {
      return semanticEnvelope(operation, "IN_DOUBT", observation, effect.side_effects ?? [], null, effect.error || "MARK_READ_CANARY_IN_DOUBT");
    }
    return semanticEnvelope(
      operation,
      achieved ? "ACHIEVED" : "FAILED",
      observation,
      effect.side_effects ?? [],
      null,
      achieved ? null : "MARK_READ_CANARY_FAILED",
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

  async function invoke(req) {
    if (typeof req.operation !== "string" || !req.operation) {
      const err = new Error("INVALID_SEMANTIC_OPERATION");
      err.code = "INVALID_SEMANTIC_OPERATION";
      throw err;
    }
    switch (req.operation) {
      case "communication.session.status":
        return sessionStatus();
      case "communication.conversation.list":
        return conversationList(req);
      case "communication.conversation.search":
        return conversationSearch(req);
      case "communication.topic.list":
        return topicList(req);
      case "communication.message.list":
        return messageList(req);
      case "communication.message.fetch":
        return messageFetch(req);
      case "communication.conversation.pin.set":
        return conversationPinSet(req);
      case "communication.conversation.mark_read":
        return conversationMarkRead(req);
      case "communication.message.open_media":
        return messageOpenMedia(req);
      case "communication.message.react":
        return messageReact(req);
      case "communication.attachment.download":
        return attachmentDownload(req);
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
        return semanticEnvelope(req.operation, "UNSUPPORTED", {}, [], null, "UNSUPPORTED_SEMANTIC_OPERATION");
    }
  }

  return {
    attachmentDownload,
    capabilities,
    conversationList,
    conversationMarkRead,
    conversationPinSet,
    conversationSearch,
    invoke,
    messageFetch,
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
    sessionStatus,
    topicList,
  };
}
