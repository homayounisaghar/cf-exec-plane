function fail(code) {
  const err = new Error(code);
  err.code = code;
  throw err;
}

function safeProviderRef(providerRef) {
  if (typeof providerRef !== "string" || !/^-?[1-9][0-9]*$/.test(providerRef)) fail("INVALID_PROVIDER_CONVERSATION_REFERENCE");
  const peerId = Number(providerRef);
  if (!Number.isSafeInteger(peerId) || peerId === 0) fail("INVALID_PROVIDER_CONVERSATION_REFERENCE");
  return peerId;
}

function mediaOpenKind(message) {
  const document = message?.media?.document;
  const attrs = Array.isArray(document?.attributes) ? document.attributes : [];
  for (const attr of attrs) {
    if (attr?._ === "documentAttributeAudio" && attr.pFlags?.voice === true) return "voice";
    if (attr?._ === "documentAttributeVideo" && attr.pFlags?.round_message === true) return "round_video";
  }
  return null;
}

function attachmentDescriptors(message) {
  const media = message?.media;
  if (media?._ === "messageMediaDocument" && media.document?._ === "document") {
    const document = media.document;
    const attrs = Array.isArray(document.attributes) ? document.attributes : [];
    const filenameAttr = attrs.find((attr) => attr?._ === "documentAttributeFilename");
    const size = Number(document.size);
    return [{
      slot: "document",
      media_type: typeof document.mime_type === "string" && document.mime_type ? document.mime_type : "application/octet-stream",
      size_bytes: Number.isSafeInteger(size) && size > 0 ? size : null,
      filename: typeof filenameAttr?.file_name === "string" && filenameAttr.file_name ? filenameAttr.file_name.slice(0, 512) : null,
    }];
  }

  if (media?._ === "messageMediaPhoto" && media.photo?._ === "photo") {
    const sizes = Array.isArray(media.photo.sizes) ? media.photo.sizes : [];
    const candidates = sizes.filter((item) =>
      (item?._ === "photoSize" || item?._ === "photoSizeProgressive")
      && Number.isSafeInteger(Number(item.size))
      && Number(item.size) > 0
    );
    candidates.sort((a, b) => Number(a.size) - Number(b.size));
    const selected = candidates.at(-1);
    return selected ? [{
      slot: "photo",
      media_type: "image/jpeg",
      size_bytes: Number(selected.size),
      filename: null,
    }] : [];
  }

  return [];
}

function normalizeMessage(message, senders = {}) {
  if (!message || typeof message !== "object" || !Number.isSafeInteger(message.mid)) return null;
  const senderId = message.fromId === undefined || message.fromId === null ? null : String(message.fromId);
  const senderName = senderId !== null && typeof senders[senderId] === "string" ? senders[senderId] : null;
  return {
    mid: message.mid,
    sender_id: senderId,
    sender_name: senderName,
    kind: typeof message._ === "string" ? message._ : "unknown",
    text: typeof message.message === "string" ? message.message.slice(0, 4096) : "",
    date: Number.isSafeInteger(message.date) ? message.date : null,
    outgoing: message.pFlags?.out === true,
    media_type: typeof message.media?._ === "string" ? message.media._ : null,
    media_open_kind: mediaOpenKind(message),
    media_unread: message.pFlags?.media_unread === true,
    attachments: attachmentDescriptors(message),
    service_action: typeof message.action?._ === "string" ? message.action._ : null,
  };
}

async function invokeWebK(page, providerRef, command) {
  const peerId = safeProviderRef(providerRef);
  const result = await page.evaluate(async ({ peerId, command }) => {
    const failResult = (error) => ({ ok: false, error });
    const create = globalThis.createProxiedManagersForAccount;
    if (typeof create !== "function") return failResult("WEBK_MANAGER_PROXY_UNAVAILABLE");

    const rawAccount = new URL(location.href).searchParams.get("account") || "1";
    const accountNumber = Number.parseInt(rawAccount, 10);
    if (!Number.isInteger(accountNumber) || accountNumber < 1 || accountNumber > 4) {
      return failResult("WEBK_ACCOUNT_INVALID");
    }

    const managers = create(accountNumber);
    const messages = managers?.appMessagesManager;
    const peers = managers?.appPeersManager;
    if (!messages) return failResult("WEBK_MESSAGES_MANAGER_UNAVAILABLE");

    const titleForPeer = (peer) => {
      if (!peer || typeof peer !== "object") return null;
      if (peer._ === "user") {
        const title = [peer.first_name, peer.last_name]
          .filter((value) => typeof value === "string" && value.trim())
          .join(" ")
          .trim();
        if (title) return title.slice(0, 256);
        if (typeof peer.username === "string" && peer.username) return ("@" + peer.username).slice(0, 256);
        return "Deleted Account";
      }
      if (typeof peer.title === "string" && peer.title.trim()) return peer.title.trim().slice(0, 256);
      return null;
    };

    const collectSenders = async (rows) => {
      const senders = {};
      if (!peers || typeof peers.getPeer !== "function") return senders;
      for (const row of rows) {
        const from = row?.fromId;
        if (from === undefined || from === null) continue;
        const key = String(from);
        if (key in senders) continue;
        senders[key] = null;
        try { senders[key] = titleForPeer(await peers.getPeer(from)); } catch {}
      }
      return senders;
    };

    const required = ["getDialogOnly", "getHistory", "getMessageByPeer", "reloadMessage"];
    if (required.some((name) => typeof messages[name] !== "function")) {
      return failResult("WEBK_READ_PRIMITIVE_UNAVAILABLE");
    }

    let dialog;
    try {
      dialog = await messages.getDialogOnly(peerId);
    } catch {
      return failResult("WEBK_DIALOG_LOOKUP_FAILED");
    }
    if (!dialog) return failResult("WEBK_DIALOG_NOT_FOUND");

    if (command.type === "list") {
      let history;
      try {
        history = await messages.getHistory({
          peerId,
          offsetId: Number.isSafeInteger(command.offsetMid) ? command.offsetMid : 0,
          limit: command.limit,
          previewOnly: true,
          threadId: Number.isSafeInteger(command.threadId) ? command.threadId : undefined,
        });
      } catch {
        return failResult("WEBK_HISTORY_FETCH_FAILED");
      }

      const mids = Array.isArray(history?.history) ? history.history.slice(0, command.limit) : [];
      const out = [];
      for (const rawMid of mids) {
        const mid = Number(rawMid);
        if (!Number.isSafeInteger(mid)) continue;
        let message = await messages.getMessageByPeer(peerId, mid);
        if (!message) message = await messages.reloadMessage(peerId, mid, false);
        if (!message || message._ === "messageEmpty") continue;
        out.push(message);
      }
      return { ok: true, messages: out, senders: await collectSenders(out) };
    }

    if (command.type === "fetch") {
      const mid = command.mid;
      if (!Number.isSafeInteger(mid)) return failResult("WEBK_MESSAGE_ID_INVALID");
      let message = await messages.getMessageByPeer(peerId, mid);
      if (!message) message = await messages.reloadMessage(peerId, mid, false);
      if (!message || message._ === "messageEmpty") return failResult("WEBK_MESSAGE_NOT_FOUND");
      return { ok: true, messages: [message], senders: await collectSenders([message]) };
    }

    return failResult("WEBK_READ_COMMAND_UNSUPPORTED");
  }, { peerId, command });

  if (!result?.ok) fail(result?.error || "WEBK_READ_FAILED");
  const senders = result.senders && typeof result.senders === "object" ? result.senders : {};
  return result.messages.map((message) => normalizeMessage(message, senders)).filter(Boolean);
}

export async function webKListMessages(page, providerRef, limit, offsetMid = null, threadId = null) {
  if (offsetMid !== null && !Number.isSafeInteger(offsetMid)) fail("WEBK_MESSAGE_OFFSET_INVALID");
  if (threadId !== null && (!Number.isSafeInteger(threadId) || threadId <= 0)) fail("WEBK_TOPIC_THREAD_INVALID");
  return invokeWebK(page, providerRef, { type: "list", limit, offsetMid, threadId });
}

export async function webKFetchMessage(page, providerRef, mid) {
  const messages = await invokeWebK(page, providerRef, { type: "fetch", mid });
  if (messages.length !== 1) fail("WEBK_MESSAGE_NOT_FOUND");
  return messages[0];
}

async function invokeWebKMarkRead(page, providerRef, mid) {
  const peerId = safeProviderRef(providerRef);
  if (!Number.isSafeInteger(mid)) fail("WEBK_MESSAGE_ID_INVALID");
  const result = await page.evaluate(async ({ peerId, mid }) => {
    const create = globalThis.createProxiedManagersForAccount;
    if (typeof create !== "function") return { ok: false, attempted: false, error: "WEBK_MANAGER_PROXY_UNAVAILABLE" };

    const rawAccount = new URL(location.href).searchParams.get("account") || "1";
    const accountNumber = Number.parseInt(rawAccount, 10);
    if (!Number.isInteger(accountNumber) || accountNumber < 1 || accountNumber > 4) {
      return { ok: false, attempted: false, error: "WEBK_ACCOUNT_INVALID" };
    }

    const messages = create(accountNumber)?.appMessagesManager;
    if (!messages) return { ok: false, attempted: false, error: "WEBK_MESSAGES_MANAGER_UNAVAILABLE" };
    if (typeof messages.readHistory !== "function" || typeof messages.reloadConversation !== "function") {
      return { ok: false, attempted: false, error: "WEBK_MARK_READ_PRIMITIVE_UNAVAILABLE" };
    }

    const snapshot = (dialog) => {
      if (!dialog || typeof dialog !== "object") return null;
      const readInboxMaxId = Number.isSafeInteger(dialog.read_inbox_max_id) ? dialog.read_inbox_max_id : 0;
      const unreadCount = Number.isSafeInteger(dialog.unread_count) ? dialog.unread_count : null;
      const unreadMark = dialog.pFlags?.unread_mark === true;
      return {
        read_inbox_max_id: readInboxMaxId,
        unread_count: unreadCount,
        unread_mark: unreadMark,
        target_read: readInboxMaxId >= mid || (unreadCount === 0 && !unreadMark),
      };
    };

    let beforeDialog;
    try {
      beforeDialog = await messages.reloadConversation(peerId, false);
    } catch {
      return { ok: false, attempted: false, error: "WEBK_MARK_READ_PRECHECK_FAILED" };
    }
    const before = snapshot(beforeDialog);
    if (!before) return { ok: false, attempted: false, error: "WEBK_MARK_READ_PRECHECK_FAILED" };
    if (before.target_read) {
      return {
        ok: true,
        outcome: "ACHIEVED",
        effect_attempted: false,
        effect_invocation_acknowledged: true,
        provider_confirmed: true,
        before,
        after: before,
      };
    }

    try {
      await messages.readHistory({ peerId, maxId: mid, force: true });
    } catch {
      return {
        ok: false,
        attempted: true,
        uncertain: true,
        error: "WEBK_MARK_READ_IN_DOUBT",
        before,
      };
    }

    let afterDialog;
    try {
      afterDialog = await messages.reloadConversation(peerId, false);
    } catch {
      return {
        ok: false,
        attempted: true,
        acknowledged: true,
        uncertain: true,
        error: "WEBK_MARK_READ_RECONCILIATION_FAILED",
        before,
      };
    }
    const after = snapshot(afterDialog);
    if (!after) {
      return {
        ok: false,
        attempted: true,
        acknowledged: true,
        uncertain: true,
        error: "WEBK_MARK_READ_RECONCILIATION_FAILED",
        before,
      };
    }
    if (!after.target_read) {
      return {
        ok: false,
        attempted: true,
        acknowledged: true,
        uncertain: true,
        error: "WEBK_MARK_READ_NOT_CONFIRMED",
        before,
        after,
      };
    }
    return {
      ok: true,
      outcome: "ACHIEVED",
      effect_attempted: true,
      effect_invocation_acknowledged: true,
      provider_confirmed: true,
      before,
      after,
    };
  }, { peerId, mid });

  if (result?.ok) return result;
  if (result?.uncertain) {
    return {
      outcome: "IN_DOUBT",
      effect_attempted: result.attempted === true,
      effect_invocation_acknowledged: result.acknowledged === true,
      provider_confirmed: false,
      before: result.before ?? null,
      after: result.after ?? null,
      error: result.error || "WEBK_MARK_READ_IN_DOUBT",
    };
  }
  fail(result?.error || "WEBK_MARK_READ_FAILED");
}

export async function webKMarkConversationRead(page, providerRef, mid) {
  return invokeWebKMarkRead(page, providerRef, mid);
}

async function invokeWebKOpenMedia(page, providerRef, mid) {
  const peerId = safeProviderRef(providerRef);
  if (!Number.isSafeInteger(mid)) fail("WEBK_MESSAGE_ID_INVALID");
  const result = await page.evaluate(async ({ peerId, mid }) => {
    const create = globalThis.createProxiedManagersForAccount;
    if (typeof create !== "function") return { ok: false, attempted: false, error: "WEBK_MANAGER_PROXY_UNAVAILABLE" };

    const rawAccount = new URL(location.href).searchParams.get("account") || "1";
    const accountNumber = Number.parseInt(rawAccount, 10);
    if (!Number.isInteger(accountNumber) || accountNumber < 1 || accountNumber > 4) {
      return { ok: false, attempted: false, error: "WEBK_ACCOUNT_INVALID" };
    }

    const messages = create(accountNumber)?.appMessagesManager;
    if (!messages) return { ok: false, attempted: false, error: "WEBK_MESSAGES_MANAGER_UNAVAILABLE" };
    if (typeof messages.getMessageByPeer !== "function" || typeof messages.reloadMessage !== "function" || typeof messages.readMessages !== "function") {
      return { ok: false, attempted: false, error: "WEBK_OPEN_MEDIA_PRIMITIVE_UNAVAILABLE" };
    }

    const classify = (message) => {
      if (!message || message._ !== "message") return null;
      const attrs = Array.isArray(message.media?.document?.attributes) ? message.media.document.attributes : [];
      for (const attr of attrs) {
        if (attr?._ === "documentAttributeAudio" && attr.pFlags?.voice === true) {
          return { media_kind: "voice", media_unread: message.pFlags?.media_unread === true };
        }
        if (attr?._ === "documentAttributeVideo" && attr.pFlags?.round_message === true) {
          return { media_kind: "round_video", media_unread: message.pFlags?.media_unread === true };
        }
      }
      return null;
    };

    let message = await messages.getMessageByPeer(peerId, mid);
    if (!message) {
      try { message = await messages.reloadMessage(peerId, mid, false); } catch {}
    }
    if (!message || message._ === "messageEmpty") return { ok: false, attempted: false, error: "WEBK_MESSAGE_NOT_FOUND" };
    const before = classify(message);
    if (!before) return { ok: false, attempted: false, error: "WEBK_OPEN_MEDIA_TYPE_UNSUPPORTED" };

    if (!before.media_unread) {
      return {
        ok: true,
        outcome: "ACHIEVED",
        effect_attempted: false,
        effect_invocation_acknowledged: true,
        provider_confirmed: true,
        before,
        after: before,
      };
    }

    try {
      await messages.readMessages(peerId, [mid]);
    } catch {
      return {
        ok: false,
        attempted: true,
        uncertain: true,
        error: "WEBK_OPEN_MEDIA_IN_DOUBT",
        before,
      };
    }

    let afterMessage;
    try {
      afterMessage = await messages.reloadMessage(peerId, mid, false);
    } catch {
      return {
        ok: false,
        attempted: true,
        acknowledged: true,
        uncertain: true,
        error: "WEBK_OPEN_MEDIA_RECONCILIATION_FAILED",
        before,
      };
    }
    const after = classify(afterMessage);
    if (!after || after.media_kind !== before.media_kind || after.media_unread) {
      return {
        ok: false,
        attempted: true,
        acknowledged: true,
        uncertain: true,
        error: "WEBK_OPEN_MEDIA_NOT_CONFIRMED",
        before,
        after,
      };
    }
    return {
      ok: true,
      outcome: "ACHIEVED",
      effect_attempted: true,
      effect_invocation_acknowledged: true,
      provider_confirmed: true,
      before,
      after,
    };
  }, { peerId, mid });

  if (result?.ok) return result;
  if (result?.uncertain) {
    return {
      outcome: "IN_DOUBT",
      effect_attempted: result.attempted === true,
      effect_invocation_acknowledged: result.acknowledged === true,
      provider_confirmed: false,
      before: result.before ?? null,
      after: result.after ?? null,
      error: result.error || "WEBK_OPEN_MEDIA_IN_DOUBT",
    };
  }
  fail(result?.error || "WEBK_OPEN_MEDIA_FAILED");
}

export async function webKOpenMessageMedia(page, providerRef, mid) {
  return invokeWebKOpenMedia(page, providerRef, mid);
}

function boundedReactionEmoji(value, { allowEmpty = false } = {}) {
  if (allowEmpty && (value === undefined || value === null || value === "")) return "";
  if (typeof value !== "string" || !value || value.length > 16 || /[\u0000-\u001f\u007f]/u.test(value)) {
    fail("WEBK_REACTION_EMOJI_INVALID");
  }
  return value;
}

async function invokeWebKSetReaction(page, providerRef, mid, emoji, remove = false) {
  const peerId = safeProviderRef(providerRef);
  if (!Number.isSafeInteger(mid)) fail("WEBK_MESSAGE_ID_INVALID");
  remove = remove === true;
  emoji = boundedReactionEmoji(emoji, { allowEmpty: remove });

  const result = await page.evaluate(async ({ peerId, mid, emoji, remove }) => {
    const create = globalThis.createProxiedManagersForAccount;
    if (typeof create !== "function") return { ok: false, attempted: false, error: "WEBK_MANAGER_PROXY_UNAVAILABLE" };

    const rawAccount = new URL(location.href).searchParams.get("account") || "1";
    const accountNumber = Number.parseInt(rawAccount, 10);
    if (!Number.isInteger(accountNumber) || accountNumber < 1 || accountNumber > 4) {
      return { ok: false, attempted: false, error: "WEBK_ACCOUNT_INVALID" };
    }

    const managers = create(accountNumber);
    const api = managers?.apiManager;
    const peers = managers?.appPeersManager;
    const messages = managers?.appMessagesManager;
    const ids = managers?.appMessagesIdsManager;
    const updatesManager = managers?.apiUpdatesManager;
    if (!api || !peers || !messages || !ids || !updatesManager) {
      return { ok: false, attempted: false, error: "WEBK_REACTION_MANAGER_UNAVAILABLE" };
    }
    for (const [manager, methods] of [
      [api, ["invokeApi"]],
      [peers, ["getInputPeerById"]],
      [messages, ["reloadMessage"]],
      [ids, ["getMessageIdInfo"]],
      [updatesManager, ["processUpdateMessage"]],
    ]) {
      if (methods.some((name) => typeof manager?.[name] !== "function")) {
        return { ok: false, attempted: false, error: "WEBK_REACTION_PRIMITIVE_UNAVAILABLE" };
      }
    }

    const chosen = (message) => {
      if (message?._ !== "message") return null;
      const results = Array.isArray(message.reactions?.results) ? message.reactions.results : [];
      return results
        .filter((item) => item?.chosen_order !== undefined
          && item?.reaction?._ === "reactionEmoji"
          && typeof item.reaction.emoticon === "string")
        .map((item) => item.reaction.emoticon);
    };

    let beforeMessage;
    try {
      beforeMessage = await messages.reloadMessage(peerId, mid, true);
    } catch {
      return { ok: false, attempted: false, error: "WEBK_REACTION_PRECHECK_FAILED" };
    }
    if (beforeMessage?._ !== "message") {
      return { ok: false, attempted: false, error: "WEBK_REACTION_TARGET_NOT_FOUND" };
    }
    if (typeof messages.isEphemeralMessage === "function") {
      try {
        if (messages.isEphemeralMessage(beforeMessage)) {
          return { ok: false, attempted: false, error: "WEBK_REACTION_EPHEMERAL_UNSUPPORTED" };
        }
      } catch {
        return { ok: false, attempted: false, error: "WEBK_REACTION_EPHEMERAL_CHECK_FAILED" };
      }
    }

    const before = chosen(beforeMessage);
    if (!Array.isArray(before)) {
      return { ok: false, attempted: false, error: "WEBK_REACTION_PRECHECK_FAILED" };
    }
    const hadSelection = before.length > 0;
    if (remove && !hadSelection) {
      return {
        ok: true,
        outcome: "ACHIEVED",
        effect_attempted: false,
        effect_invocation_acknowledged: true,
        provider_confirmed: true,
        selected_before: false,
        selected_after: false,
        removed: true,
      };
    }
    if (!remove && before.includes(emoji)) {
      return {
        ok: true,
        outcome: "ACHIEVED",
        effect_attempted: false,
        effect_invocation_acknowledged: true,
        provider_confirmed: true,
        selected_before: true,
        selected_after: true,
      };
    }

    const info = ids.getMessageIdInfo(mid);
    const serverMessageId = Number(info?.messageId);
    if (!Number.isSafeInteger(serverMessageId) || serverMessageId <= 0) {
      return { ok: false, attempted: false, error: "WEBK_REACTION_MESSAGE_ID_INVALID" };
    }

    let updates;
    try {
      updates = await api.invokeApi("messages.sendReaction", {
        peer: await peers.getInputPeerById(peerId),
        msg_id: serverMessageId,
        reaction: remove ? [] : [{ _: "reactionEmoji", emoticon: emoji }],
      });
    } catch {
      return {
        ok: false,
        attempted: true,
        uncertain: true,
        error: "WEBK_REACTION_IN_DOUBT",
        selected_before: hadSelection,
      };
    }

    try { await updatesManager.processUpdateMessage(updates); } catch {}

    let afterMessage;
    try {
      afterMessage = await messages.reloadMessage(peerId, mid, true);
    } catch {
      return {
        ok: false,
        attempted: true,
        acknowledged: true,
        uncertain: true,
        error: "WEBK_REACTION_RECONCILIATION_FAILED",
        selected_before: hadSelection,
      };
    }
    const after = chosen(afterMessage);
    const satisfied = Array.isArray(after) && (remove ? after.length === 0 : after.includes(emoji));
    if (!satisfied) {
      return {
        ok: false,
        attempted: true,
        acknowledged: true,
        uncertain: true,
        error: "WEBK_REACTION_NOT_CONFIRMED",
        selected_before: hadSelection,
        selected_after: Array.isArray(after) && after.length > 0,
      };
    }
    return {
      ok: true,
      outcome: "ACHIEVED",
      effect_attempted: true,
      effect_invocation_acknowledged: true,
      provider_confirmed: true,
      selected_before: hadSelection,
      selected_after: !remove,
      removed: remove,
    };
  }, { peerId, mid, emoji, remove });

  if (result?.ok) return result;
  if (result?.uncertain) {
    return {
      outcome: "IN_DOUBT",
      effect_attempted: result.attempted === true,
      effect_invocation_acknowledged: result.acknowledged === true,
      provider_confirmed: false,
      selected_before: result.selected_before === true,
      selected_after: result.selected_after === true,
      error: result.error || "WEBK_REACTION_IN_DOUBT",
    };
  }
  fail(result?.error || "WEBK_REACTION_FAILED");
}

export async function webKSetMessageReaction(page, providerRef, mid, emoji, remove = false) {
  return invokeWebKSetReaction(page, providerRef, mid, emoji, remove);
}

async function invokeWebKDownloadAttachment(page, providerRef, mid, slot, maxBytes) {
  const peerId = safeProviderRef(providerRef);
  if (!Number.isSafeInteger(mid)) fail("WEBK_MESSAGE_ID_INVALID");
  if (slot !== "document" && slot !== "photo") fail("WEBK_DOWNLOAD_ATTACHMENT_SLOT_UNSUPPORTED");
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) fail("WEBK_DOWNLOAD_BOUND_INVALID");

  const result = await page.evaluate(async ({ peerId, mid, slot, maxBytes }) => {
    const failResult = (error, extra = {}) => ({ ok: false, error, ...extra });
    const create = globalThis.createProxiedManagersForAccount;
    if (typeof create !== "function") return failResult("WEBK_MANAGER_PROXY_UNAVAILABLE");

    const rawAccount = new URL(location.href).searchParams.get("account") || "1";
    const accountNumber = Number.parseInt(rawAccount, 10);
    if (!Number.isInteger(accountNumber) || accountNumber < 1 || accountNumber > 4) {
      return failResult("WEBK_ACCOUNT_INVALID");
    }

    const managers = create(accountNumber);
    const messages = managers?.appMessagesManager;
    const profiles = managers?.appProfileManager;
    const files = managers?.apiFileManager;
    if (!messages || !profiles || !files) return failResult("WEBK_DOWNLOAD_MANAGER_UNAVAILABLE");

    for (const [manager, methods] of [
      [messages, ["getMessageByPeer", "reloadMessage", "reloadConversation", "canForward"]],
      [profiles, ["getProfileByPeerId"]],
      [files, ["downloadMedia"]],
    ]) {
      if (methods.some((name) => typeof manager?.[name] !== "function")) {
        return failResult("WEBK_DOWNLOAD_PRIMITIVE_UNAVAILABLE");
      }
    }

    let message = await messages.getMessageByPeer(peerId, mid);
    if (!message) {
      try { message = await messages.reloadMessage(peerId, mid, false); } catch {}
    }
    if (!message || message._ !== "message") return failResult("WEBK_MESSAGE_NOT_FOUND");

    try {
      await profiles.getProfileByPeerId(peerId);
    } catch {
      return failResult("WEBK_DOWNLOAD_RESTRICTION_CHECK_FAILED");
    }

    let allowed;
    try {
      allowed = await messages.canForward(message);
    } catch {
      return failResult("WEBK_DOWNLOAD_RESTRICTION_CHECK_FAILED");
    }
    if (allowed !== true) return failResult("WEBK_DOWNLOAD_PROVIDER_RESTRICTED");

    const selectAttachment = (source) => {
      const media = source?.media;
      if (slot === "document" && media?._ === "messageMediaDocument" && media.document?._ === "document") {
        const document = media.document;
        const attrs = Array.isArray(document.attributes) ? document.attributes : [];
        const filenameAttr = attrs.find((attr) => attr?._ === "documentAttributeFilename");
        const size = Number(document.size);
        return {
          media: document,
          thumb: undefined,
          size_bytes: Number.isSafeInteger(size) && size > 0 ? size : null,
          media_type: typeof document.mime_type === "string" && document.mime_type ? document.mime_type : "application/octet-stream",
          filename: typeof filenameAttr?.file_name === "string" && filenameAttr.file_name ? filenameAttr.file_name.slice(0, 512) : null,
        };
      }
      if (slot === "photo" && media?._ === "messageMediaPhoto" && media.photo?._ === "photo") {
        const sizes = Array.isArray(media.photo.sizes) ? media.photo.sizes : [];
        const candidates = sizes.filter((item) =>
          (item?._ === "photoSize" || item?._ === "photoSizeProgressive")
          && Number.isSafeInteger(Number(item.size))
          && Number(item.size) > 0
        );
        candidates.sort((a, b) => Number(a.size) - Number(b.size));
        const selected = candidates.at(-1);
        if (!selected) return null;
        return {
          media: media.photo,
          thumb: selected,
          size_bytes: Number(selected.size),
          media_type: "image/jpeg",
          filename: null,
        };
      }
      return null;
    };

    const attachment = selectAttachment(message);
    if (!attachment) return failResult("WEBK_DOWNLOAD_ATTACHMENT_NOT_FOUND");
    if (!Number.isSafeInteger(attachment.size_bytes) || attachment.size_bytes < 1) {
      return failResult("WEBK_DOWNLOAD_SIZE_UNKNOWN");
    }
    if (attachment.size_bytes > maxBytes) return failResult("WEBK_DOWNLOAD_SIZE_OUT_OF_BOUNDS");

    const snapshot = (dialog, target) => {
      if (!dialog || !target || target._ !== "message") return null;
      const readInboxMaxId = Number.isSafeInteger(dialog.read_inbox_max_id) ? dialog.read_inbox_max_id : 0;
      return {
        read_inbox_max_id: readInboxMaxId,
        unread_count: Number.isSafeInteger(dialog.unread_count) ? dialog.unread_count : null,
        unread_mark: dialog.pFlags?.unread_mark === true,
        target_read: target.pFlags?.out === true || readInboxMaxId >= mid,
        media_unread: target.pFlags?.media_unread === true,
      };
    };

    let beforeDialog;
    try {
      beforeDialog = await messages.reloadConversation(peerId, false);
    } catch {
      return failResult("WEBK_DOWNLOAD_PRECHECK_FAILED");
    }
    const before = snapshot(beforeDialog, message);
    if (!before) return failResult("WEBK_DOWNLOAD_PRECHECK_FAILED");

    let blob;
    try {
      blob = await files.downloadMedia({
        media: attachment.media,
        ...(attachment.thumb ? { thumb: attachment.thumb } : {}),
      });
    } catch {
      return failResult("WEBK_DOWNLOAD_FAILED", { attempted: true, before });
    }

    if (!(blob instanceof Blob)) return failResult("WEBK_DOWNLOAD_RESULT_INVALID", { attempted: true, before });
    if (!Number.isSafeInteger(blob.size) || blob.size < 1 || blob.size > maxBytes) {
      return failResult("WEBK_DOWNLOAD_RESULT_SIZE_INVALID", { attempted: true, before });
    }

    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = "";
    const chunkSize = 0x8000;
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
      binary += String.fromCharCode(...bytes.subarray(offset, Math.min(bytes.length, offset + chunkSize)));
    }
    const dataBase64 = btoa(binary);

    let afterMessage;
    let afterDialog;
    try {
      afterMessage = await messages.reloadMessage(peerId, mid, false);
      afterDialog = await messages.reloadConversation(peerId, false);
    } catch {
      return {
        ok: true,
        outcome: "IN_DOUBT",
        error: "WEBK_DOWNLOAD_RECONCILIATION_FAILED",
        local_acquisition_attempted: true,
        provider_restriction_checked: true,
        provider_state_checked: false,
        before,
        after: null,
        data_base64: dataBase64,
        size_bytes: blob.size,
        media_type: attachment.media_type,
        filename: attachment.filename,
      };
    }

    const after = snapshot(afterDialog, afterMessage);
    if (!after) {
      return {
        ok: true,
        outcome: "IN_DOUBT",
        error: "WEBK_DOWNLOAD_RECONCILIATION_FAILED",
        local_acquisition_attempted: true,
        provider_restriction_checked: true,
        provider_state_checked: false,
        before,
        after: null,
        data_base64: dataBase64,
        size_bytes: blob.size,
        media_type: attachment.media_type,
        filename: attachment.filename,
      };
    }

    const providerStateUnchanged =
      after.read_inbox_max_id === before.read_inbox_max_id
      && after.target_read === before.target_read
      && after.media_unread === before.media_unread;

    return {
      ok: true,
      outcome: providerStateUnchanged ? "ACHIEVED" : "IN_DOUBT",
      error: providerStateUnchanged ? null : "WEBK_DOWNLOAD_PROVIDER_STATE_CHANGED",
      local_acquisition_attempted: true,
      provider_restriction_checked: true,
      provider_state_checked: true,
      provider_state_unchanged: providerStateUnchanged,
      before,
      after,
      data_base64: dataBase64,
      size_bytes: blob.size,
      media_type: attachment.media_type,
      filename: attachment.filename,
    };
  }, { peerId, mid, slot, maxBytes });

  if (!result?.ok) fail(result?.error || "WEBK_DOWNLOAD_FAILED");
  return result;
}

export async function webKDownloadAttachment(page, providerRef, mid, slot, maxBytes) {
  return invokeWebKDownloadAttachment(page, providerRef, mid, slot, maxBytes);
}

async function invokeWebKPrepareLocalComposer(page, providerRef, text) {
  const peerId = safeProviderRef(providerRef);
  if (typeof text !== "string" || text.length < 1 || text.length > 512 || text.includes("\0")) {
    fail("WEBK_COMPOSER_TEXT_INVALID");
  }

  const result = await page.evaluate(async ({ peerId, text }) => {
    const failResult = (error) => ({ ok: false, error });
    const create = globalThis.createProxiedManagersForAccount;
    if (typeof create !== "function") return failResult("WEBK_MANAGER_PROXY_UNAVAILABLE");

    const rawAccount = new URL(location.href).searchParams.get("account") || "1";
    const accountNumber = Number.parseInt(rawAccount, 10);
    if (!Number.isInteger(accountNumber) || accountNumber < 1 || accountNumber > 4) {
      return failResult("WEBK_ACCOUNT_INVALID");
    }

    const managers = create(accountNumber);
    const drafts = managers?.appDraftsManager;
    const messages = managers?.appMessagesManager;
    const peers = managers?.appPeersManager;
    const api = managers?.apiManager;
    if (!drafts || !messages || !peers || !api) {
      return failResult("WEBK_COMPOSER_MANAGER_UNAVAILABLE");
    }

    for (const [manager, methods] of [
      [drafts, ["getDraft", "setDraft", "saveDraft", "clearDraft"]],
      [messages, ["reloadConversation"]],
      [peers, ["getPeerId"]],
      [api, ["invokeApi"]],
    ]) {
      if (methods.some((name) => typeof manager?.[name] !== "function")) {
        return failResult("WEBK_COMPOSER_PRIMITIVE_UNAVAILABLE");
      }
    }

    const canonical = (value) => {
      if (value === null || value === undefined) return value ?? null;
      if (value instanceof Uint8Array) return Array.from(value);
      if (Array.isArray(value)) return value.map(canonical);
      if (typeof value === "object") {
        const out = {};
        for (const key of Object.keys(value).sort()) out[key] = canonical(value[key]);
        return out;
      }
      return value;
    };
    const fingerprint = (value) => JSON.stringify(canonical(value));

    const dialogSnapshot = (dialog) => {
      if (!dialog || typeof dialog !== "object") return null;
      return {
        top_message: Number.isSafeInteger(dialog.top_message) ? dialog.top_message : null,
        read_inbox_max_id: Number.isSafeInteger(dialog.read_inbox_max_id) ? dialog.read_inbox_max_id : 0,
        unread_count: Number.isSafeInteger(dialog.unread_count) ? dialog.unread_count : null,
        unread_mark: dialog.pFlags?.unread_mark === true,
      };
    };

    const providerDraftFingerprint = async () => {
      const updates = await api.invokeApi("messages.getAllDrafts");
      const list = Array.isArray(updates?.updates) ? updates.updates : [];
      for (const update of list) {
        if (update?._ !== "updateDraftMessage") continue;
        let updatePeerId;
        try {
          updatePeerId = Number(await peers.getPeerId(update.peer));
        } catch {
          continue;
        }
        if (updatePeerId === peerId) return fingerprint(update.draft ?? null);
      }
      return fingerprint(null);
    };

    let beforeDialog;
    let providerBefore;
    let localBefore;
    try {
      beforeDialog = dialogSnapshot(await messages.reloadConversation(peerId, false));
      providerBefore = await providerDraftFingerprint();
      localBefore = await drafts.getDraft(peerId, 0);
    } catch {
      return failResult("WEBK_COMPOSER_PRECHECK_FAILED");
    }
    if (!beforeDialog) return failResult("WEBK_COMPOSER_TARGET_NOT_FOUND");

    const localBeforeFingerprint = fingerprint(localBefore ?? null);
    const localBeforeClone = localBefore ? structuredClone(localBefore) : null;

    let localSet = false;
    let localComposerSet = false;
    let localComposerRestored = false;
    let providerAfterSet = null;
    let providerAfterRestore = null;
    let afterSetDialog = null;
    let afterRestoreDialog = null;
    let operationError = null;

    try {
      await drafts.setDraft(peerId, 0, text);
      localSet = true;
      const localAfter = await drafts.getDraft(peerId, 0);
      localComposerSet = localAfter?._ === "draftMessage" && localAfter.message === text;

      // WebK's actual ChatInput autosave debounce is 2500ms. Waiting beyond
      // that boundary proves the draft_updated -> processingDraftMessage guard
      // did not schedule a provider-synced save for this local-only mutation.
      await new Promise((resolve) => setTimeout(resolve, 3200));

      providerAfterSet = await providerDraftFingerprint();
      afterSetDialog = dialogSnapshot(await messages.reloadConversation(peerId, false));
    } catch {
      operationError = "WEBK_COMPOSER_LOCAL_SET_OR_OBSERVATION_FAILED";
    } finally {
      if (localSet) {
        try {
          if (localBeforeClone) {
            await drafts.saveDraft({
              peerId,
              threadId: undefined,
              draft: localBeforeClone,
              notify: true,
              force: true,
            });
          } else {
            await drafts.clearDraft({ peerId });
          }
        } catch {
          operationError = "WEBK_COMPOSER_LOCAL_RESTORE_FAILED";
        }
      }
    }

    try {
      await new Promise((resolve) => setTimeout(resolve, 350));
      const localRestored = await drafts.getDraft(peerId, 0);
      localComposerRestored = fingerprint(localRestored ?? null) === localBeforeFingerprint;
      providerAfterRestore = await providerDraftFingerprint();
      afterRestoreDialog = dialogSnapshot(await messages.reloadConversation(peerId, false));
    } catch {
      operationError ||= "WEBK_COMPOSER_POST_RESTORE_OBSERVATION_FAILED";
    }

    const providerDraftUnchanged = providerAfterSet !== null
      && providerAfterRestore !== null
      && providerBefore === providerAfterSet
      && providerBefore === providerAfterRestore;
    const providerMessageTopUnchanged = afterSetDialog !== null
      && afterRestoreDialog !== null
      && beforeDialog.top_message === afterSetDialog.top_message
      && beforeDialog.top_message === afterRestoreDialog.top_message;
    const providerReadStateUnchanged = afterSetDialog !== null
      && afterRestoreDialog !== null
      && beforeDialog.read_inbox_max_id === afterSetDialog.read_inbox_max_id
      && beforeDialog.read_inbox_max_id === afterRestoreDialog.read_inbox_max_id
      && beforeDialog.unread_count === afterSetDialog.unread_count
      && beforeDialog.unread_count === afterRestoreDialog.unread_count
      && beforeDialog.unread_mark === afterSetDialog.unread_mark
      && beforeDialog.unread_mark === afterRestoreDialog.unread_mark;

    let error = operationError;
    if (!error && !localComposerSet) error = "WEBK_COMPOSER_LOCAL_SET_NOT_CONFIRMED";
    if (!error && !localComposerRestored) error = "WEBK_COMPOSER_LOCAL_RESTORE_NOT_CONFIRMED";
    if (!error && !providerDraftUnchanged) error = "WEBK_COMPOSER_PROVIDER_DRAFT_CHANGED";
    if (!error && !providerMessageTopUnchanged) error = "WEBK_COMPOSER_MESSAGE_TOP_CHANGED";
    if (!error && !providerReadStateUnchanged) error = "WEBK_COMPOSER_READ_STATE_CHANGED";

    return {
      ok: true,
      outcome: error ? "OBSERVATION_DRIFT" : "ACHIEVED",
      error,
      target_resolved: true,
      local_before_present: localBefore !== undefined && localBefore !== null,
      local_composer_set: localComposerSet,
      local_composer_restored: localComposerRestored,
      provider_draft_unchanged: providerDraftUnchanged,
      provider_message_top_unchanged: providerMessageTopUnchanged,
      provider_read_state_unchanged: providerReadStateUnchanged,
      server_draft_write_invoked: false,
      send_primitive_invoked: false,
      typing_primitive_invoked: false,
    };
  }, { peerId, text });

  if (!result?.ok) fail(result?.error || "WEBK_COMPOSER_FAILED");
  return result;
}

export async function webKPrepareLocalComposer(page, providerRef, text) {
  return invokeWebKPrepareLocalComposer(page, providerRef, text);
}
