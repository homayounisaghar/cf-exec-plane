import { ensureProviderModel } from "./pcg_web_provider_model.mjs";
import { randomUUID } from "node:crypto";

// Same rule as the write path: a page hop that never answers must become a
// named failure. Reads are fast today, but the bound is what keeps that true.
const BRIDGE_DEADLINE_MS = 30000;

async function evaluateWithin(page, timeoutMs, fn, arg) {
  let timer = null;
  const deadline = new Promise((_resolve, reject) => {
    timer = setTimeout(() => {
      const err = new Error("WEB_PROVIDER_EVALUATE_TIMEOUT");
      err.code = "WEB_PROVIDER_EVALUATE_TIMEOUT";
      err.timeout_ms = timeoutMs;
      reject(err);
    }, timeoutMs);
  });
  try {
    return await Promise.race([
      arg === undefined ? page.evaluate(fn) : page.evaluate(fn, arg),
      deadline,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}



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
    const audioAttr = attrs.find((attr) => attr?._ === "documentAttributeAudio");
    const videoAttr = attrs.find((attr) => attr?._ === "documentAttributeVideo");
    const stickerAttr = attrs.find((attr) => attr?._ === "documentAttributeSticker");
    const animatedAttr = attrs.find((attr) => attr?._ === "documentAttributeAnimated");
    const imageSizeAttr = attrs.find((attr) => attr?._ === "documentAttributeImageSize");
    const mimeType = typeof document.mime_type === "string" && document.mime_type
      ? document.mime_type
      : "application/octet-stream";
    const size = Number(document.size);
    let mediaKind = "file";
    let stickerFormat = null;

    if (stickerAttr) {
      mediaKind = "sticker";
      if (mimeType === "application/x-tgsticker") stickerFormat = "animated";
      else if (mimeType === "video/webm" || videoAttr) stickerFormat = "video";
      else stickerFormat = "static";
    } else if (animatedAttr || mimeType === "image/gif") {
      mediaKind = "gif";
    } else if (audioAttr) {
      mediaKind = audioAttr.pFlags?.voice === true ? "voice" : "audio";
    } else if (videoAttr) {
      mediaKind = videoAttr.pFlags?.round_message === true ? "round_video" : "video";
    } else if (mimeType.startsWith("image/")) {
      mediaKind = "image";
    }

    const thumbs = Array.isArray(document.thumbs) ? document.thumbs : [];
    const hasPreview = thumbs.some((item) =>
      (item?._ === "photoSize" || item?._ === "photoSizeProgressive")
      && Number.isSafeInteger(Number(item.size))
      && Number(item.size) > 0
    );
    const width = Number(imageSizeAttr?.w ?? videoAttr?.w);
    const height = Number(imageSizeAttr?.h ?? videoAttr?.h);

    return [{
      slot: "document",
      media_kind: mediaKind,
      media_type: mimeType,
      size_bytes: Number.isSafeInteger(size) && size > 0 ? size : null,
      filename: typeof filenameAttr?.file_name === "string" && filenameAttr.file_name ? filenameAttr.file_name.slice(0, 512) : null,
      duration_seconds: Number.isSafeInteger(Number(audioAttr?.duration ?? videoAttr?.duration))
        ? Number(audioAttr?.duration ?? videoAttr?.duration)
        : null,
      title: typeof audioAttr?.title === "string" && audioAttr.title.trim() ? audioAttr.title.trim().slice(0, 512) : null,
      performer: typeof audioAttr?.performer === "string" && audioAttr.performer.trim() ? audioAttr.performer.trim().slice(0, 512) : null,
      sticker_emoji: typeof stickerAttr?.alt === "string" && stickerAttr.alt.trim() ? stickerAttr.alt.trim().slice(0, 32) : null,
      sticker_format: stickerFormat,
      animated: Boolean(stickerFormat === "animated" || stickerFormat === "video" || animatedAttr),
      has_preview: hasPreview,
      width: Number.isSafeInteger(width) && width > 0 ? width : null,
      height: Number.isSafeInteger(height) && height > 0 ? height : null,
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
      media_kind: "photo",
      media_type: "image/jpeg",
      size_bytes: Number(selected.size),
      filename: null,
      duration_seconds: null,
      title: null,
      performer: null,
      sticker_emoji: null,
      sticker_format: null,
      animated: false,
      has_preview: false,
      width: Number.isSafeInteger(Number(selected.w)) && Number(selected.w) > 0 ? Number(selected.w) : null,
      height: Number.isSafeInteger(Number(selected.h)) && Number(selected.h) > 0 ? Number(selected.h) : null,
    }] : [];
  }

  return [];
}
function reactionSummary(message) {
  const results = Array.isArray(message?.reactions?.results) ? message.reactions.results : [];
  const reactionCounts = [];
  let total = 0;
  for (const item of results) {
    const count = Number(item?.count);
    const safeCount = Number.isSafeInteger(count) && count > 0 ? count : 0;
    if (safeCount < 1) continue;
    total += safeCount;
    if (item?.reaction?._ === "reactionEmoji" && typeof item.reaction.emoticon === "string") {
      reactionCounts.push({
        kind: "emoji",
        emoji: item.reaction.emoticon,
        count: safeCount,
        chosen_by_me: item.chosen_order !== undefined,
      });
    } else if (item?.reaction?._ === "reactionCustomEmoji") {
      reactionCounts.push({
        kind: "custom",
        document_id: item.reaction.document_id === undefined || item.reaction.document_id === null
          ? null
          : String(item.reaction.document_id),
        count: safeCount,
        chosen_by_me: item.chosen_order !== undefined,
      });
    }
  }
  return {
    reaction_counts: reactionCounts,
    reaction_total_count: total,
    reaction_distinct_count: reactionCounts.length,
    has_reactions: total > 0,
  };
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
    reply_count: Number.isSafeInteger(Number(message.replies?.replies)) && Number(message.replies.replies) >= 0
      ? Number(message.replies.replies)
      : 0,
    has_replies: Number.isSafeInteger(Number(message.replies?.replies)) && Number(message.replies.replies) > 0,
    ...reactionSummary(message),
  };
}

async function invokeWebK(page, providerRef, command) {
  const peerId = safeProviderRef(providerRef);
  // Reads go through the provider model too, so it must be present.
  await ensureProviderModel(page);
  const result = await evaluateWithin(page, BRIDGE_DEADLINE_MS, async ({ peerId, command }) => {
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
        history = await globalThis.__pcgProvider.history(managers, peerId, {
          offsetId: Number.isSafeInteger(command.offsetMid) ? command.offsetMid : 0,
          limit: command.limit,
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
      const message = await globalThis.__pcgProvider.readMessage(managers, peerId, mid);
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

export async function webKSearchMessages(page, providerRef, query, limit = 20) {
  const q = typeof query === "string" ? query.trim() : "";
  if (!q || q.length > 128 || /[\u0000-\u001f\u007f]/u.test(q)) fail("WEBK_MESSAGE_SEARCH_QUERY_INVALID");
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) fail("WEBK_MESSAGE_SEARCH_LIMIT_INVALID");
  const scopedPeerId = providerRef === null || providerRef === undefined ? null : safeProviderRef(providerRef);

  await ensureProviderModel(page);
  const result = await evaluateWithin(page, BRIDGE_DEADLINE_MS, async ({ scopedPeerId, q, limit }) => {
    const failResult = (error) => ({ ok: false, error });
    const create = globalThis.createProxiedManagersForAccount;
    if (typeof create !== "function") return failResult("WEBK_MANAGER_PROXY_UNAVAILABLE");

    const rawAccount = new URL(location.href).searchParams.get("account") || "1";
    const accountNumber = Number.parseInt(rawAccount, 10);
    if (!Number.isInteger(accountNumber) || accountNumber < 1 || accountNumber > 4) {
      return failResult("WEBK_ACCOUNT_INVALID");
    }

    const managers = create(accountNumber);
    const api = managers?.apiManager;
    const peers = managers?.appPeersManager;
    if (!api || !peers || typeof api.invokeApi !== "function"
        || typeof peers.getPeerId !== "function"
        || typeof peers.getInputPeerById !== "function"
        || typeof peers.getPeer !== "function") {
      return failResult("WEBK_MESSAGE_SEARCH_PRIMITIVE_UNAVAILABLE");
    }

    let response;
    try {
      const filter = { _: "inputMessagesFilterEmpty" };
      if (scopedPeerId !== null) {
        response = await api.invokeApi("messages.search", {
          peer: await peers.getInputPeerById(scopedPeerId),
          q,
          filter,
          min_date: 0,
          max_date: 0,
          offset_id: 0,
          add_offset: 0,
          limit,
          max_id: 0,
          min_id: 0,
          hash: 0,
        });
      } else {
        response = await api.invokeApi("messages.searchGlobal", {
          q,
          filter,
          min_date: 0,
          max_date: 0,
          offset_rate: 0,
          offset_peer: { _: "inputPeerEmpty" },
          offset_id: 0,
          limit,
        });
      }
    } catch {
      return failResult(scopedPeerId === null ? "WEBK_GLOBAL_MESSAGE_SEARCH_FAILED" : "WEBK_MESSAGE_SEARCH_FAILED");
    }

    const rawMessages = Array.isArray(response?.messages) ? response.messages : [];
    const items = [];
    for (const raw of rawMessages) {
      if (!raw || raw._ === "messageEmpty") continue;
      let peerId = scopedPeerId;
      if (peerId === null) {
        try {
          peerId = Number(await peers.getPeerId(raw.peer_id ?? raw.peerId ?? raw.peer));
        } catch {
          peerId = null;
        }
      }
      if (!Number.isSafeInteger(peerId) || peerId === 0) continue;

      const serverId = Number(raw.id);
      if (!Number.isSafeInteger(serverId) || serverId <= 0) continue;
      let mid = serverId;
      try {
        const normalized = await globalThis.__pcgProvider.normalizeClientMid(managers, peerId, serverId);
        if (Number.isSafeInteger(normalized) && normalized > 0) mid = normalized;
      } catch {}

      let message = null;
      try { message = await globalThis.__pcgProvider.readMessage(managers, peerId, mid); } catch {}
      if (!message || message._ !== "message") continue;

      let conversationName = null;
      try {
        const peer = await peers.getPeer(peerId);
        if (peer?._ === "user") {
          const title = [peer.first_name, peer.last_name]
            .filter((value) => typeof value === "string" && value.trim())
            .join(" ")
            .trim();
          conversationName = title || (typeof peer.username === "string" && peer.username ? "@" + peer.username : "Deleted Account");
        } else if (typeof peer?.title === "string" && peer.title.trim()) {
          conversationName = peer.title.trim().slice(0, 256);
        }
      } catch {}

      let senderName = null;
      if (message.fromId !== undefined && message.fromId !== null) {
        try {
          const sender = await peers.getPeer(message.fromId);
          if (sender?._ === "user") {
            const title = [sender.first_name, sender.last_name]
              .filter((value) => typeof value === "string" && value.trim())
              .join(" ")
              .trim();
            senderName = title || (typeof sender.username === "string" && sender.username ? "@" + sender.username : null);
          } else if (typeof sender?.title === "string" && sender.title.trim()) {
            senderName = sender.title.trim().slice(0, 256);
          }
        } catch {}
      }

      items.push({
        provider_ref: String(peerId),
        conversation_name: conversationName,
        message,
        sender_name: senderName,
      });
      if (items.length >= limit) break;
    }

    return { ok: true, items };
  }, { scopedPeerId, q, limit });

  if (!result?.ok) fail(result?.error || "WEBK_MESSAGE_SEARCH_FAILED");
  return (Array.isArray(result.items) ? result.items : []).map((item) => {
    const senderId = item?.message?.fromId === undefined || item?.message?.fromId === null
      ? null
      : String(item.message.fromId);
    const senders = senderId !== null && typeof item.sender_name === "string"
      ? { [senderId]: item.sender_name }
      : {};
    return {
      provider_ref: String(item.provider_ref),
      conversation_name: typeof item.conversation_name === "string" ? item.conversation_name : null,
      message: normalizeMessage(item.message, senders),
    };
  }).filter((item) => item.message !== null);
}

export async function webKListMessageReplies(page, providerRef, mid, limit = 50) {
  const peerId = safeProviderRef(providerRef);
  if (!Number.isSafeInteger(mid)) fail("WEBK_MESSAGE_ID_INVALID");
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) fail("WEBK_REPLY_LIMIT_INVALID");
  await ensureProviderModel(page);
  const result = await evaluateWithin(page, BRIDGE_DEADLINE_MS, async ({ peerId, mid, limit }) => {
    const failResult = (error) => ({ ok: false, error });
    const create = globalThis.createProxiedManagersForAccount;
    if (typeof create !== "function") return failResult("WEBK_MANAGER_PROXY_UNAVAILABLE");

    const rawAccount = new URL(location.href).searchParams.get("account") || "1";
    const accountNumber = Number.parseInt(rawAccount, 10);
    if (!Number.isInteger(accountNumber) || accountNumber < 1 || accountNumber > 4) return failResult("WEBK_ACCOUNT_INVALID");

    const managers = create(accountNumber);
    const api = managers?.apiManager;
    const peers = managers?.appPeersManager;
    const ids = managers?.appMessagesIdsManager;
    if (!api || !peers || !ids || typeof api.invokeApi !== "function" || typeof peers.getInputPeerById !== "function") {
      return failResult("WEBK_REPLY_PRIMITIVE_UNAVAILABLE");
    }

    const target = await globalThis.__pcgProvider.readMessage(managers, peerId, mid);
    if (!target || target._ !== "message") return failResult("WEBK_REPLY_TARGET_NOT_FOUND");
    const targetId = await globalThis.__pcgProvider.serverMessageId(ids, mid, target);
    if (!targetId?.ok || !Number.isSafeInteger(Number(targetId.value))) return failResult("WEBK_REPLY_TARGET_ID_UNRESOLVED");
    const targetServerId = Number(targetId.value);

    let response;
    try {
      response = await api.invokeApi("messages.getReplies", {
        peer: await peers.getInputPeerById(peerId),
        msg_id: targetServerId,
        offset_id: 0,
        offset_date: 0,
        add_offset: 0,
        limit,
        max_id: 0,
        min_id: 0,
        hash: 0,
      });
    } catch {
      return failResult("WEBK_REPLY_FETCH_FAILED");
    }

    const rawMessages = Array.isArray(response?.messages) ? response.messages : [];
    const rows = [];
    for (const raw of rawMessages) {
      if (!raw || raw._ === "messageEmpty") continue;
      const serverId = Number(raw.id);
      if (!Number.isSafeInteger(serverId) || serverId <= 0 || serverId === targetServerId) continue;
      let clientMid = serverId;
      try {
        const normalized = await globalThis.__pcgProvider.normalizeClientMid(managers, peerId, serverId);
        if (Number.isSafeInteger(normalized) && normalized > 0) clientMid = normalized;
      } catch {}
      let message = null;
      try { message = await globalThis.__pcgProvider.readMessage(managers, peerId, clientMid); } catch {}
      if (!message || message._ !== "message") continue;
      const replyToServerId = Number(raw?.reply_to?.reply_to_msg_id ?? message?.reply_to?.reply_to_msg_id);
      rows.push({
        message,
        direct_to_target: Number.isSafeInteger(replyToServerId) ? replyToServerId === targetServerId : null,
      });
      if (rows.length >= limit) break;
    }

    const targetReplyCount = Number(target?.replies?.replies);
    const responseCount = Number(response?.count);
    return {
      ok: true,
      reply_count: Number.isSafeInteger(targetReplyCount) && targetReplyCount >= 0
        ? targetReplyCount
        : (Number.isSafeInteger(responseCount) && responseCount >= 0 ? responseCount : rows.length),
      rows,
      senders: await (async () => {
        const out = {};
        if (typeof peers.getPeer !== "function") return out;
        for (const row of rows) {
          const from = row?.message?.fromId;
          if (from === undefined || from === null) continue;
          const key = String(from);
          if (Object.prototype.hasOwnProperty.call(out, key)) continue;
          out[key] = null;
          try {
            const peer = await peers.getPeer(from);
            if (peer?._ === "user") {
              const title = [peer.first_name, peer.last_name].filter((v) => typeof v === "string" && v.trim()).join(" ").trim();
              out[key] = title || (typeof peer.username === "string" && peer.username ? "@" + peer.username : null);
            } else if (typeof peer?.title === "string" && peer.title.trim()) {
              out[key] = peer.title.trim().slice(0, 256);
            }
          } catch {}
        }
        return out;
      })(),
    };
  }, { peerId, mid, limit });

  if (!result?.ok) fail(result?.error || "WEBK_REPLY_FETCH_FAILED");
  const senders = result.senders && typeof result.senders === "object" ? result.senders : {};
  const replies = (Array.isArray(result.rows) ? result.rows : []).map((row) => {
    const normalized = normalizeMessage(row.message, senders);
    return normalized ? { ...normalized, direct_to_target: row.direct_to_target } : null;
  }).filter(Boolean);
  return {
    reply_count: Number.isSafeInteger(result.reply_count) ? result.reply_count : replies.length,
    replies,
  };
}

export async function webKTranscribeMessage(page, providerRef, mid) {
  const peerId = safeProviderRef(providerRef);
  if (!Number.isSafeInteger(mid)) fail("WEBK_MESSAGE_ID_INVALID");
  await ensureProviderModel(page);
  const result = await evaluateWithin(page, BRIDGE_DEADLINE_MS, async ({ peerId, mid }) => {
    const failResult = (error) => ({ ok: false, error });
    const create = globalThis.createProxiedManagersForAccount;
    if (typeof create !== "function") return failResult("WEBK_MANAGER_PROXY_UNAVAILABLE");

    const rawAccount = new URL(location.href).searchParams.get("account") || "1";
    const accountNumber = Number.parseInt(rawAccount, 10);
    if (!Number.isInteger(accountNumber) || accountNumber < 1 || accountNumber > 4) return failResult("WEBK_ACCOUNT_INVALID");

    const managers = create(accountNumber);
    const messages = managers?.appMessagesManager;
    if (!messages || typeof messages.transcribeAudio !== "function") {
      return failResult("WEBK_TRANSCRIPTION_PRIMITIVE_UNAVAILABLE");
    }

    const rootScope = managers?.rootScope;
    if (!rootScope || typeof rootScope.getPremium !== "function") {
      return failResult("WEBK_PREMIUM_STATE_UNAVAILABLE");
    }
    let isPremium = false;
    try {
      isPremium = (await rootScope.getPremium()) === true;
    } catch {
      return failResult("WEBK_PREMIUM_STATE_UNAVAILABLE");
    }
    if (!isPremium) return failResult("TELEGRAM_PREMIUM_REQUIRED");

    const message = await globalThis.__pcgProvider.readMessage(managers, peerId, mid);
    if (!message || message._ !== "message") return failResult("WEBK_TRANSCRIPTION_TARGET_NOT_FOUND");
    const attrs = Array.isArray(message.media?.document?.attributes) ? message.media.document.attributes : [];
    const audio = attrs.find((attr) => attr?._ === "documentAttributeAudio");
    const video = attrs.find((attr) => attr?._ === "documentAttributeVideo");
    const mediaKind = audio ? (audio.pFlags?.voice === true ? "voice" : "audio")
      : (video?.pFlags?.round_message === true ? "round_video" : null);
    if (!mediaKind) return failResult("WEBK_TRANSCRIPTION_MEDIA_UNSUPPORTED");

    let response = null;
    try {
      // Use WebK's own domain manager rather than bypassing it with raw MTProto.
      // noPending=true asks the manager to resolve the provider's eventual
      // updateTranscribedAudio result, while callWithin keeps the wait bounded.
      response = await globalThis.__pcgProvider.callWithin(
        25_000,
        messages,
        "transcribeAudio",
        message,
        true,
      );
    } catch (err) {
      const raw = String(
        err?.type
        || err?.error_message
        || err?.code
        || err?.message
        || "",
      ).toUpperCase();
      const providerCode = raw
        .replace(/[^A-Z0-9_]+/g, "_")
        .replace(/^_+|_+$/g, "")
        .slice(0, 96);
      return failResult(
        providerCode
          ? "WEBK_TRANSCRIPTION_PROVIDER_REJECTED__" + providerCode
          : "WEBK_TRANSCRIPTION_PROVIDER_REJECTED",
      );
    }

    return {
      ok: true,
      media_kind: mediaKind,
      pending: response?.pFlags?.pending === true || response?.pending === true,
      text: typeof response?.text === "string" ? response.text : "",
      transcription_id: response?.transcription_id === undefined || response?.transcription_id === null
        ? null
        : String(response.transcription_id),
      trial_remains_num: Number.isSafeInteger(Number(response?.trial_remains_num)) ? Number(response.trial_remains_num) : null,
      trial_remains_until_date: Number.isSafeInteger(Number(response?.trial_remains_until_date)) ? Number(response.trial_remains_until_date) : null,
    };
  }, { peerId, mid });

  if (!result?.ok) fail(result?.error || "WEBK_TRANSCRIPTION_FAILED");
  return result;
}

async function invokeWebKGetMessageReactionState(page, providerRef, mid) {
  const peerId = safeProviderRef(providerRef);
  if (!Number.isSafeInteger(mid)) fail("WEBK_MESSAGE_ID_INVALID");
  await ensureProviderModel(page);
  const result = await evaluateWithin(page, BRIDGE_DEADLINE_MS, async ({ peerId, mid }) => {
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
    const reactions = managers?.appReactionsManager;
    if (!messages || !reactions) return failResult("WEBK_REACTION_MANAGER_UNAVAILABLE");
    if (typeof reactions.getMessagesReactions !== "function") return failResult("WEBK_REACTION_READ_PRIMITIVE_UNAVAILABLE");

    let message = await globalThis.__pcgProvider.readMessage(managers, peerId, mid);
    if (!message || message._ !== "message") return failResult("WEBK_REACTION_TARGET_NOT_FOUND");

    try {
      await globalThis.__pcgProvider.callWithin(6000, reactions, "getMessagesReactions", peerId, [mid]);
    } catch {
      return failResult("WEBK_REACTION_STATE_UNREADABLE");
    }

    message = await globalThis.__pcgProvider.readMessage(managers, peerId, mid);
    if (!message || message._ !== "message") return failResult("WEBK_REACTION_TARGET_NOT_FOUND");

    const results = Array.isArray(message.reactions?.results) ? message.reactions.results : [];
    const selected = [];
    const reactionCounts = [];
    let customCount = 0;
    let totalCount = 0;
    for (const item of results) {
      const count = Number(item?.count);
      const safeCount = Number.isSafeInteger(count) && count > 0 ? count : 0;
      totalCount += safeCount;
      if (item?.reaction?._ === "reactionEmoji" && typeof item.reaction.emoticon === "string") {
        if (safeCount > 0) {
          reactionCounts.push({
            kind: "emoji",
            emoji: item.reaction.emoticon,
            count: safeCount,
            chosen_by_me: item.chosen_order !== undefined,
          });
        }
        if (item?.chosen_order !== undefined) selected.push(item.reaction.emoticon);
      } else if (item?.reaction?._ === "reactionCustomEmoji") {
        if (safeCount > 0) {
          reactionCounts.push({
            kind: "custom",
            document_id: item.reaction.document_id === undefined || item.reaction.document_id === null
              ? null
              : String(item.reaction.document_id),
            count: safeCount,
            chosen_by_me: item.chosen_order !== undefined,
          });
        }
        if (item?.chosen_order !== undefined) customCount += 1;
      }
    }
    return {
      ok: true,
      reaction_state_readable: true,
      selected_emojis: selected,
      selected_custom_emoji_count: customCount,
      has_my_reaction: selected.length > 0 || customCount > 0,
      reaction_counts: reactionCounts,
      reaction_total_count: totalCount,
      reaction_distinct_count: reactionCounts.length,
      has_reactions: totalCount > 0,
      reaction_list_visible: message.reactions?.pFlags?.can_see_list === true,
    };
  }, { peerId, mid });

  if (!result?.ok) fail(result?.error || "WEBK_REACTION_STATE_UNREADABLE");
  return result;
}

export async function webKGetMessageReactionState(page, providerRef, mid) {
  return invokeWebKGetMessageReactionState(page, providerRef, mid);
}

async function invokeWebKMarkRead(page, providerRef, count) {
  const peerId = safeProviderRef(providerRef);
  if (!Number.isInteger(count) || count < 1 || count > 10000) fail("MARK_READ_COUNT_INVALID");
  await ensureProviderModel(page);

  const result = await evaluateWithin(page, BRIDGE_DEADLINE_MS, async ({ peerId, count }) => {
    const failResult = (error, before = null) => ({
      ok: false,
      attempted: false,
      uncertain: false,
      error,
      before,
    });
    const create = globalThis.createProxiedManagersForAccount;
    if (typeof create !== "function") return failResult("WEBK_MANAGER_PROXY_UNAVAILABLE");

    const rawAccount = new URL(location.href).searchParams.get("account") || "1";
    const accountNumber = Number.parseInt(rawAccount, 10);
    if (!Number.isInteger(accountNumber) || accountNumber < 1 || accountNumber > 4) {
      return failResult("WEBK_ACCOUNT_INVALID");
    }

    const managers = create(accountNumber);
    const messages = managers?.appMessagesManager;
    const provider = globalThis.__pcgProvider;
    if (!messages) return failResult("WEBK_MESSAGES_MANAGER_UNAVAILABLE");
    if (!provider || typeof provider.history !== "function") {
      return failResult("WEBK_PROVIDER_MODEL_UNAVAILABLE");
    }
    const required = ["readHistory", "reloadConversation", "getMessageByPeer", "reloadMessage"];
    if (required.some((name) => typeof messages[name] !== "function")) {
      return failResult("WEBK_MARK_READ_PRIMITIVE_UNAVAILABLE");
    }

    const snapshot = (dialog) => {
      if (!dialog || typeof dialog !== "object") return null;
      const readInboxMaxId = Number.isSafeInteger(dialog.read_inbox_max_id) ? dialog.read_inbox_max_id : 0;
      const unreadCount = Number.isSafeInteger(dialog.unread_count) && dialog.unread_count >= 0
        ? dialog.unread_count
        : null;
      return {
        read_inbox_max_id: readInboxMaxId,
        unread_count: unreadCount,
        unread_mark: dialog.pFlags?.unread_mark === true,
      };
    };

    let beforeDialog;
    try {
      beforeDialog = await messages.reloadConversation(peerId, false);
    } catch {
      return failResult("WEBK_MARK_READ_PRECHECK_FAILED");
    }
    const before = snapshot(beforeDialog);
    if (!before || before.unread_count === null) {
      return failResult("MARK_READ_UNREAD_COUNT_UNAVAILABLE", before);
    }
    if (count > before.unread_count) {
      return failResult("MARK_READ_COUNT_EXCEEDS_UNREAD", before);
    }

    const unreadIncomingMids = [];
    const seen = new Set();
    let offsetId = 0;
    let pagingComplete = false;

    for (let pageIndex = 0; pageIndex < 100; pageIndex += 1) {
      let history;
      try {
        history = await provider.history(managers, peerId, {
          offsetId,
          limit: 100,
        });
      } catch {
        return failResult("MARK_READ_UNREAD_BOUNDARY_UNPROVEN", before);
      }
      const mids = Array.isArray(history?.history)
        ? history.history.map((value) => Number(value)).filter((value) => Number.isSafeInteger(value))
        : [];
      if (!mids.length) {
        pagingComplete = true;
        break;
      }

      let progressed = false;
      for (const mid of mids) {
        if (seen.has(mid)) continue;
        seen.add(mid);
        progressed = true;
        if (mid <= before.read_inbox_max_id) continue;

        let message = null;
        try {
          message = await messages.getMessageByPeer(peerId, mid);
          if (!message) message = await messages.reloadMessage(peerId, mid, false);
        } catch {
          message = null;
        }
        if (!message || message._ === "messageEmpty") {
          return failResult("MARK_READ_UNREAD_BOUNDARY_UNPROVEN", before);
        }
        if (message.pFlags?.out !== true) unreadIncomingMids.push(mid);
        if (unreadIncomingMids.length > before.unread_count) {
          return failResult("MARK_READ_UNREAD_BOUNDARY_UNPROVEN", before);
        }
      }

      if (unreadIncomingMids.length === before.unread_count) {
        pagingComplete = true;
        break;
      }
      if (!progressed) break;

      const nextOffset = mids[mids.length - 1];
      if (!Number.isSafeInteger(nextOffset) || nextOffset === offsetId) break;
      offsetId = nextOffset;
    }

    if (!pagingComplete || unreadIncomingMids.length !== before.unread_count) {
      return failResult("MARK_READ_UNREAD_BOUNDARY_UNPROVEN", before);
    }

    unreadIncomingMids.sort((a, b) => a - b);
    const boundaryMid = unreadIncomingMids[count - 1];
    if (!Number.isSafeInteger(boundaryMid)) {
      return failResult("MARK_READ_UNREAD_BOUNDARY_UNPROVEN", before);
    }

    let recheckedDialog;
    try {
      recheckedDialog = await messages.reloadConversation(peerId, false);
    } catch {
      return failResult("MARK_READ_RECHECK_FAILED", before);
    }
    const rechecked = snapshot(recheckedDialog);
    if (!rechecked
        || rechecked.read_inbox_max_id !== before.read_inbox_max_id
        || rechecked.unread_count !== before.unread_count
        || rechecked.unread_mark !== before.unread_mark) {
      return failResult("MARK_READ_STATE_CHANGED_BEFORE_EFFECT", before);
    }

    try {
      await messages.readHistory({ peerId, maxId: boundaryMid, force: true });
    } catch {
      return {
        ok: false,
        attempted: true,
        uncertain: true,
        error: "WEBK_MARK_READ_IN_DOUBT",
        before,
        boundary_mid: boundaryMid,
        requested_count: count,
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
        boundary_mid: boundaryMid,
        requested_count: count,
      };
    }
    const after = snapshot(afterDialog);
    const expectedUnreadCount = before.unread_count - count;
    if (!after
        || after.unread_count !== expectedUnreadCount
        || after.read_inbox_max_id < boundaryMid) {
      return {
        ok: false,
        attempted: true,
        acknowledged: true,
        uncertain: true,
        error: "WEBK_MARK_READ_COUNT_NOT_CONFIRMED",
        before,
        after,
        boundary_mid: boundaryMid,
        requested_count: count,
        expected_unread_count: expectedUnreadCount,
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
      boundary_mid: boundaryMid,
      requested_count: count,
      expected_unread_count: expectedUnreadCount,
    };
  }, { peerId, count });

  if (result?.ok) return result;
  if (result?.uncertain) {
    return {
      outcome: "IN_DOUBT",
      effect_attempted: result.attempted === true,
      effect_invocation_acknowledged: result.acknowledged === true,
      provider_confirmed: false,
      before: result.before ?? null,
      after: result.after ?? null,
      boundary_mid: result.boundary_mid ?? null,
      requested_count: result.requested_count ?? count,
      expected_unread_count: result.expected_unread_count ?? null,
      error: result.error || "WEBK_MARK_READ_IN_DOUBT",
    };
  }
  return {
    outcome: "FAILED",
    effect_attempted: false,
    effect_invocation_acknowledged: false,
    provider_confirmed: false,
    before: result?.before ?? null,
    after: null,
    boundary_mid: null,
    requested_count: count,
    expected_unread_count: null,
    error: result?.error || "WEBK_MARK_READ_FAILED",
  };
}

export async function webKMarkConversationRead(page, providerRef, count) {
  return invokeWebKMarkRead(page, providerRef, count);
}

async function invokeWebKOpenMedia(page, providerRef, mid) {
  const peerId = safeProviderRef(providerRef);
  if (!Number.isSafeInteger(mid)) fail("WEBK_MESSAGE_ID_INVALID");
  const result = await evaluateWithin(page, BRIDGE_DEADLINE_MS, async ({ peerId, mid }) => {
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
  await ensureProviderModel(page);

  const result = await evaluateWithin(page, BRIDGE_DEADLINE_MS, async ({ peerId, mid, emoji, remove }) => {
    const create = globalThis.createProxiedManagersForAccount;
    if (typeof create !== "function") return { ok: false, attempted: false, error: "WEBK_MANAGER_PROXY_UNAVAILABLE" };

    const rawAccount = new URL(location.href).searchParams.get("account") || "1";
    const accountNumber = Number.parseInt(rawAccount, 10);
    if (!Number.isInteger(accountNumber) || accountNumber < 1 || accountNumber > 4) {
      return { ok: false, attempted: false, error: "WEBK_ACCOUNT_INVALID" };
    }

    const managers = create(accountNumber);
    const messages = managers?.appMessagesManager;
    const reactionsManager = managers?.appReactionsManager;
    if (!messages || !reactionsManager) {
      return { ok: false, attempted: false, error: "WEBK_REACTION_MANAGER_UNAVAILABLE" };
    }
    for (const [manager, methods] of [
      [messages, ["getMessageByPeer", "reloadMessage"]],
      [reactionsManager, ["getMessagesReactions", "sendReaction"]],
    ]) {
      if (methods.some((name) => typeof manager?.[name] !== "function")) {
        return { ok: false, attempted: false, error: "WEBK_REACTION_PRIMITIVE_UNAVAILABLE" };
      }
    }

    const chosen = (message) => {
      if (message?._ !== "message" || message.reactions === undefined || message.reactions === null) return null;
      const results = Array.isArray(message.reactions?.results) ? message.reactions.results : [];
      return results
        .filter((item) => item?.chosen_order !== undefined
          && item?.reaction?._ === "reactionEmoji"
          && typeof item.reaction.emoticon === "string")
        .map((item) => item.reaction.emoticon);
    };

    const readMessage = async () => {
      try {
        return await globalThis.__pcgProvider.readMessage(managers, peerId, mid);
      } catch {
        return null;
      }
    };

    let beforeMessage = await readMessage();
    if (beforeMessage?._ !== "message") {
      return { ok: false, attempted: false, error: "WEBK_REACTION_TARGET_NOT_FOUND" };
    }
    if (globalThis.__pcgProvider.selfDestructing(beforeMessage)) {
      return { ok: false, attempted: false, error: "WEBK_REACTION_SELF_DESTRUCTING_UNSUPPORTED" };
    }

    // Use WebK's own reaction manager as the provider primitive. It owns
    // reaction limits, Saved-Messages/tag semantics and provider rollback for
    // REACTION_INVALID. Raw messages.sendReaction bypasses that logic.
    const refreshChosen = async () => {
      try {
        await globalThis.__pcgProvider.callWithin(6000, reactionsManager, "getMessagesReactions", peerId, [mid]);
      } catch {
        return null;
      }
      const local = await readMessage();
      return chosen(local);
    };

    let before = await refreshChosen();
    if (!Array.isArray(before)) before = chosen(beforeMessage);
    const beforeReadable = Array.isArray(before);
    const hadSelection = beforeReadable && before.length > 0;
    const desiredSatisfied = (list) => Array.isArray(list)
      && (remove ? list.length === 0 : list.includes(emoji));

    if (beforeReadable && desiredSatisfied(before)) {
      return {
        ok: true,
        outcome: "ACHIEVED",
        effect_attempted: false,
        effect_attempt_count: 0,
        reconciled_retry: false,
        effect_invocation_acknowledged: true,
        provider_confirmed: true,
        reaction_state_readable: true,
        selected_before: hadSelection,
        selected_after: !remove,
        removed: remove,
      };
    }
    if (remove && !beforeReadable) {
      return {
        ok: false,
        attempted: false,
        error: "WEBK_REACTION_STATE_UNREADABLE",
        reaction_state_readable: false,
        selected_before: false,
      };
    }

    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const applySet = async () => {
      beforeMessage = await readMessage();
      if (beforeMessage?._ !== "message") throw new Error("REACTION_TARGET_MISSING");
      await globalThis.__pcgProvider.callWithin(5000, reactionsManager, "sendReaction", {
        message: beforeMessage,
        reaction: { _: "reactionEmoji", emoticon: emoji },
      });
    };
    const applyRemove = async (current) => {
      const selected = Array.isArray(current) ? current.slice(0, 10) : [];
      for (const selectedEmoji of selected) {
        const message = await readMessage();
        if (message?._ !== "message") throw new Error("REACTION_TARGET_MISSING");
        await globalThis.__pcgProvider.callWithin(5000, reactionsManager, "sendReaction", {
          message,
          reaction: { _: "reactionEmoji", emoticon: selectedEmoji },
        });
      }
    };
    const applyDesired = async (current) => {
      if (remove) return applyRemove(current);
      return applySet();
    };
    const verifyDesired = async (delayMs = 140) => {
      if (delayMs > 0) await sleep(delayMs);
      let current = await refreshChosen();
      if (desiredSatisfied(current)) return { satisfied: true, current };
      if (Array.isArray(current)) {
        await sleep(180);
        current = await refreshChosen();
        if (desiredSatisfied(current)) return { satisfied: true, current };
      }
      return { satisfied: false, current };
    };

    const achieved = (attempts, retry) => ({
      ok: true,
      outcome: "ACHIEVED",
      effect_attempted: attempts > 0,
      effect_attempt_count: attempts,
      reconciled_retry: retry,
      effect_invocation_acknowledged: true,
      provider_confirmed: true,
      reaction_state_readable: true,
      selected_before: hadSelection,
      selected_after: !remove,
      removed: remove,
    });
    const uncertain = (attempts, retry, current, error) => ({
      ok: false,
      attempted: attempts > 0,
      effect_attempt_count: attempts,
      reconciled_retry: retry,
      acknowledged: false,
      uncertain: attempts > 0,
      error,
      reaction_state_readable: Array.isArray(current),
      selected_before: hadSelection,
      selected_after: Array.isArray(current) ? current.length > 0 : false,
    });

    let attempts = 1;
    try {
      await applyDesired(before);
    } catch {
      const reconciled = await verifyDesired(0);
      if (reconciled.satisfied) return achieved(attempts, false);
      if (!Array.isArray(reconciled.current)) {
        return uncertain(attempts, false, reconciled.current, "WEBK_REACTION_STATE_UNREADABLE");
      }
    }

    let verified = await verifyDesired();
    if (verified.satisfied) return achieved(attempts, false);
    if (!Array.isArray(verified.current)) {
      return uncertain(attempts, false, verified.current, "WEBK_REACTION_STATE_UNREADABLE");
    }

    // Only a readable provider refresh proving the desired state is absent
    // authorizes one same-invocation retry.
    attempts += 1;
    try {
      await applyDesired(verified.current);
    } catch {
      const finalAfterError = await verifyDesired(0);
      if (finalAfterError.satisfied) return achieved(attempts, true);
      return uncertain(
        attempts,
        true,
        finalAfterError.current,
        Array.isArray(finalAfterError.current) ? "WEBK_REACTION_NOT_CONFIRMED" : "WEBK_REACTION_STATE_UNREADABLE",
      );
    }

    verified = await verifyDesired();
    if (verified.satisfied) return achieved(attempts, true);
    return uncertain(
      attempts,
      true,
      verified.current,
      Array.isArray(verified.current) ? "WEBK_REACTION_NOT_CONFIRMED" : "WEBK_REACTION_STATE_UNREADABLE",
    );
  }, { peerId, mid, emoji, remove });

  if (result?.ok) return result;
  if (result?.uncertain) {
    return {
      outcome: "IN_DOUBT",
      effect_attempted: result.attempted === true,
      effect_invocation_acknowledged: result.acknowledged === true,
      provider_confirmed: false,
      effect_attempt_count: Number.isSafeInteger(result.effect_attempt_count) ? result.effect_attempt_count : (result.attempted ? 1 : 0),
      reconciled_retry: result.reconciled_retry === true,
      reaction_state_readable: result.reaction_state_readable === true,
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

  const result = await evaluateWithin(page, BRIDGE_DEADLINE_MS, async ({ peerId, mid, slot, maxBytes }) => {
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
        const stickerAttr = attrs.find((attr) => attr?._ === "documentAttributeSticker");
        const animatedAttr = attrs.find((attr) => attr?._ === "documentAttributeAnimated");
        const audioAttr = attrs.find((attr) => attr?._ === "documentAttributeAudio");
        const videoAttr = attrs.find((attr) => attr?._ === "documentAttributeVideo");
        const mimeType = typeof document.mime_type === "string" && document.mime_type ? document.mime_type : "application/octet-stream";
        let mediaKind = "file";
        if (stickerAttr) mediaKind = "sticker";
        else if (animatedAttr || mimeType === "image/gif") mediaKind = "gif";
        else if (audioAttr) mediaKind = audioAttr.pFlags?.voice === true ? "voice" : "audio";
        else if (videoAttr) mediaKind = videoAttr.pFlags?.round_message === true ? "round_video" : "video";
        else if (mimeType.startsWith("image/")) mediaKind = "image";
        const previewCandidates = (Array.isArray(document.thumbs) ? document.thumbs : [])
          .filter((item) =>
            (item?._ === "photoSize" || item?._ === "photoSizeProgressive")
            && Number.isSafeInteger(Number(item.size))
            && Number(item.size) > 0
          )
          .sort((a, b) => Number(a.size) - Number(b.size));
        const size = Number(document.size);
        return {
          media: document,
          thumb: undefined,
          preview_thumb: ["sticker", "gif", "video", "round_video", "image"].includes(mediaKind)
            ? previewCandidates.at(-1)
            : undefined,
          media_kind: mediaKind,
          size_bytes: Number.isSafeInteger(size) && size > 0 ? size : null,
          media_type: mimeType,
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

    let previewDataBase64 = null;
    let previewMediaType = null;
    let previewSizeBytes = null;
    if (attachment.preview_thumb) {
      try {
        const previewBlob = await files.downloadMedia({
          media: attachment.media,
          thumb: attachment.preview_thumb,
        });
        if (previewBlob instanceof Blob
            && Number.isSafeInteger(previewBlob.size)
            && previewBlob.size > 0
            && previewBlob.size <= Math.min(maxBytes, 4 * 1024 * 1024)) {
          const previewBytes = new Uint8Array(await previewBlob.arrayBuffer());
          let previewBinary = "";
          const previewChunkSize = 0x8000;
          for (let offset = 0; offset < previewBytes.length; offset += previewChunkSize) {
            previewBinary += String.fromCharCode(...previewBytes.subarray(offset, Math.min(previewBytes.length, offset + previewChunkSize)));
          }
          previewDataBase64 = btoa(previewBinary);
          previewMediaType = typeof previewBlob.type === "string" && previewBlob.type.startsWith("image/")
            ? previewBlob.type
            : "image/jpeg";
          previewSizeBytes = previewBlob.size;
        }
      } catch {}
    }

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
        preview_data_base64: previewDataBase64,
        preview_media_type: previewMediaType,
        preview_size_bytes: previewSizeBytes,
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
        preview_data_base64: previewDataBase64,
        preview_media_type: previewMediaType,
        preview_size_bytes: previewSizeBytes,
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
      preview_data_base64: previewDataBase64,
      preview_media_type: previewMediaType,
      preview_size_bytes: previewSizeBytes,
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


const LARGE_ATTACHMENT_PART_BYTES = 1024 * 1024;
const LARGE_ATTACHMENT_BATCH_BYTES = 8 * 1024 * 1024;

export async function webKPrepareLargeAttachmentDownload(page, providerRef, mid, slot, maxBytes) {
  const peerId = safeProviderRef(providerRef);
  if (!Number.isSafeInteger(mid)) fail("WEBK_MESSAGE_ID_INVALID");
  if (slot !== "document") fail("WEBK_LARGE_DOWNLOAD_DOCUMENT_REQUIRED");
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 2 * 1024 * 1024 * 1024) fail("WEBK_LARGE_DOWNLOAD_BOUND_INVALID");
  const token = randomUUID().replaceAll("-", "");

  const result = await evaluateWithin(page, BRIDGE_DEADLINE_MS, async ({ peerId, mid, maxBytes, token }) => {
    const failResult = (error, extra = {}) => ({ ok: false, error, ...extra });
    const create = globalThis.createProxiedManagersForAccount;
    if (typeof create !== "function") return failResult("WEBK_MANAGER_PROXY_UNAVAILABLE");
    const rawAccount = new URL(location.href).searchParams.get("account") || "1";
    const accountNumber = Number.parseInt(rawAccount, 10);
    if (!Number.isInteger(accountNumber) || accountNumber < 1 || accountNumber > 4) return failResult("WEBK_ACCOUNT_INVALID");

    const managers = create(accountNumber);
    const messages = managers?.appMessagesManager;
    const profiles = managers?.appProfileManager;
    const files = managers?.apiFileManager;
    if (!messages || !profiles || !files) return failResult("WEBK_LARGE_DOWNLOAD_MANAGER_UNAVAILABLE");
    for (const [manager, methods] of [
      [messages, ["getMessageByPeer", "reloadMessage", "reloadConversation", "canForward"]],
      [profiles, ["getProfileByPeerId"]],
      [files, ["requestFilePart"]],
    ]) {
      if (methods.some((name) => typeof manager?.[name] !== "function")) return failResult("WEBK_LARGE_DOWNLOAD_PRIMITIVE_UNAVAILABLE");
    }

    let message = await messages.getMessageByPeer(peerId, mid);
    if (!message) {
      try { message = await messages.reloadMessage(peerId, mid, false); } catch {}
    }
    if (!message || message._ !== "message") return failResult("WEBK_MESSAGE_NOT_FOUND");

    try { await profiles.getProfileByPeerId(peerId); }
    catch { return failResult("WEBK_DOWNLOAD_RESTRICTION_CHECK_FAILED"); }

    let allowed;
    try { allowed = await messages.canForward(message); }
    catch { return failResult("WEBK_DOWNLOAD_RESTRICTION_CHECK_FAILED"); }
    if (allowed !== true) return failResult("WEBK_DOWNLOAD_PROVIDER_RESTRICTED");

    const document = message?.media?._ === "messageMediaDocument" && message.media.document?._ === "document"
      ? message.media.document
      : null;
    if (!document) return failResult("WEBK_DOWNLOAD_ATTACHMENT_NOT_FOUND");

    const sizeBytes = Number(document.size);
    const dcId = Number(document.dc_id);
    if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 1 || sizeBytes > maxBytes) return failResult("WEBK_LARGE_DOWNLOAD_SIZE_OUT_OF_BOUNDS");
    if (!Number.isSafeInteger(dcId) || dcId < 1) return failResult("WEBK_LARGE_DOWNLOAD_DC_INVALID");

    const attrs = Array.isArray(document.attributes) ? document.attributes : [];
    const filenameAttr = attrs.find((attr) => attr?._ === "documentAttributeFilename");
    const filename = typeof filenameAttr?.file_name === "string" && filenameAttr.file_name
      ? filenameAttr.file_name.slice(0, 512)
      : "attachment.bin";
    const mediaType = typeof document.mime_type === "string" && document.mime_type
      ? document.mime_type
      : "application/octet-stream";

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
    try { beforeDialog = await messages.reloadConversation(peerId, false); }
    catch { return failResult("WEBK_DOWNLOAD_PRECHECK_FAILED"); }
    const before = snapshot(beforeDialog, message);
    if (!before) return failResult("WEBK_DOWNLOAD_PRECHECK_FAILED");

    if (!(globalThis.__pcgLargeAttachmentDownloads instanceof Map)) globalThis.__pcgLargeAttachmentDownloads = new Map();
    globalThis.__pcgLargeAttachmentDownloads.set(token, {
      peerId,
      mid,
      dcId,
      location: {
        _: "inputDocumentFileLocation",
        id: document.id,
        access_hash: document.access_hash,
        file_reference: document.file_reference,
        thumb_size: "",
      },
      before,
      filename,
      mediaType,
      sizeBytes,
    });

    return { ok: true, token, size_bytes: sizeBytes, filename, media_type: mediaType, before, provider_restriction_checked: true };
  }, { peerId, mid, maxBytes, token });

  if (!result?.ok) fail(result?.error || "WEBK_LARGE_DOWNLOAD_PREPARE_FAILED");
  return result;
}

export async function webKReadLargeAttachmentDownloadChunk(page, token, offset, batchBytes = LARGE_ATTACHMENT_BATCH_BYTES) {
  if (typeof token !== "string" || !/^[0-9a-f]{32}$/.test(token)) fail("WEBK_LARGE_DOWNLOAD_TOKEN_INVALID");
  if (!Number.isSafeInteger(offset) || offset < 0) fail("WEBK_LARGE_DOWNLOAD_OFFSET_INVALID");
  if (!Number.isSafeInteger(batchBytes) || batchBytes < LARGE_ATTACHMENT_PART_BYTES || batchBytes > 16 * 1024 * 1024) fail("WEBK_LARGE_DOWNLOAD_BATCH_INVALID");

  const result = await evaluateWithin(page, BRIDGE_DEADLINE_MS, async ({ token, offset, batchBytes, partBytes }) => {
    const failResult = (error, extra = {}) => ({ ok: false, error, ...extra });
    const sessions = globalThis.__pcgLargeAttachmentDownloads;
    const state = sessions instanceof Map ? sessions.get(token) : null;
    if (!state) return failResult("WEBK_LARGE_DOWNLOAD_SESSION_NOT_FOUND");
    if (offset < 0 || offset > state.sizeBytes) return failResult("WEBK_LARGE_DOWNLOAD_OFFSET_INVALID");
    if (offset === state.sizeBytes) return { ok: true, offset, size_bytes: 0, data_base64: "", complete: true };

    const create = globalThis.createProxiedManagersForAccount;
    if (typeof create !== "function") return failResult("WEBK_MANAGER_PROXY_UNAVAILABLE");
    const rawAccount = new URL(location.href).searchParams.get("account") || "1";
    const accountNumber = Number.parseInt(rawAccount, 10);
    const files = Number.isInteger(accountNumber) ? create(accountNumber)?.apiFileManager : null;
    if (!files || typeof files.requestFilePart !== "function") return failResult("WEBK_LARGE_DOWNLOAD_PRIMITIVE_UNAVAILABLE");

    const wanted = Math.min(batchBytes, state.sizeBytes - offset);
    const count = Math.ceil(wanted / partBytes);
    const chunks = new Array(count);

    for (let base = 0; base < count; base += 4) {
      const indexes = [];
      for (let i = base; i < Math.min(count, base + 4); i += 1) indexes.push(i);
      const responses = await Promise.all(indexes.map(async (i) => {
        const partOffset = offset + i * partBytes;
        try {
          return await files.requestFilePart({ dcId: state.dcId, location: state.location, offset: partOffset, limit: partBytes });
        } catch (err) {
          return { __pcg_error: String(err?.type || err?.code || err?.message || "WEBK_LARGE_DOWNLOAD_PART_FAILED") };
        }
      }));

      for (let j = 0; j < responses.length; j += 1) {
        const i = indexes[j];
        const response = responses[j];
        if (response?.__pcg_error) return failResult("WEBK_LARGE_DOWNLOAD_PART_FAILED", { provider_error_type: response.__pcg_error });
        if (response?._ === "upload.fileCdnRedirect") return failResult("WEBK_LARGE_DOWNLOAD_CDN_REDIRECT_UNSUPPORTED");
        const raw = response?.bytes;
        const bytes = raw instanceof Uint8Array
          ? raw
          : (raw instanceof ArrayBuffer ? new Uint8Array(raw) : (Array.isArray(raw) ? Uint8Array.from(raw) : null));
        const expected = Math.min(partBytes, state.sizeBytes - (offset + i * partBytes));
        if (!(bytes instanceof Uint8Array) || bytes.length !== expected) {
          return failResult("WEBK_LARGE_DOWNLOAD_PART_SIZE_INVALID", { expected_bytes: expected, actual_bytes: bytes instanceof Uint8Array ? bytes.length : null });
        }
        chunks[i] = bytes;
      }
    }

    const total = chunks.reduce((sum, item) => sum + item.length, 0);
    if (total !== wanted) return failResult("WEBK_LARGE_DOWNLOAD_BATCH_SIZE_INVALID");
    const combined = new Uint8Array(total);
    let cursor = 0;
    for (const chunk of chunks) {
      combined.set(chunk, cursor);
      cursor += chunk.length;
    }
    let binary = "";
    const encodeChunk = 0x8000;
    for (let i = 0; i < combined.length; i += encodeChunk) {
      binary += String.fromCharCode(...combined.subarray(i, Math.min(combined.length, i + encodeChunk)));
    }
    return { ok: true, offset: offset + total, size_bytes: total, data_base64: btoa(binary), complete: offset + total === state.sizeBytes };
  }, { token, offset, batchBytes, partBytes: LARGE_ATTACHMENT_PART_BYTES });

  if (!result?.ok) {
    const err = new Error(result?.error || "WEBK_LARGE_DOWNLOAD_CHUNK_FAILED");
    err.code = result?.error || "WEBK_LARGE_DOWNLOAD_CHUNK_FAILED";
    if (result?.provider_error_type) err.provider_error_type = result.provider_error_type;
    throw err;
  }
  return result;
}

export async function webKFinishLargeAttachmentDownload(page, token) {
  if (typeof token !== "string" || !/^[0-9a-f]{32}$/.test(token)) fail("WEBK_LARGE_DOWNLOAD_TOKEN_INVALID");
  const result = await evaluateWithin(page, BRIDGE_DEADLINE_MS, async (token) => {
    const failResult = (error, extra = {}) => ({ ok: false, error, ...extra });
    const sessions = globalThis.__pcgLargeAttachmentDownloads;
    const state = sessions instanceof Map ? sessions.get(token) : null;
    if (!state) return failResult("WEBK_LARGE_DOWNLOAD_SESSION_NOT_FOUND");
    const create = globalThis.createProxiedManagersForAccount;
    if (typeof create !== "function") return failResult("WEBK_MANAGER_PROXY_UNAVAILABLE");
    const rawAccount = new URL(location.href).searchParams.get("account") || "1";
    const accountNumber = Number.parseInt(rawAccount, 10);
    const messages = Number.isInteger(accountNumber) ? create(accountNumber)?.appMessagesManager : null;
    if (!messages) return failResult("WEBK_LARGE_DOWNLOAD_MANAGER_UNAVAILABLE");

    const snapshot = (dialog, target) => {
      if (!dialog || !target || target._ !== "message") return null;
      const readInboxMaxId = Number.isSafeInteger(dialog.read_inbox_max_id) ? dialog.read_inbox_max_id : 0;
      return {
        read_inbox_max_id: readInboxMaxId,
        unread_count: Number.isSafeInteger(dialog.unread_count) ? dialog.unread_count : null,
        unread_mark: dialog.pFlags?.unread_mark === true,
        target_read: target.pFlags?.out === true || readInboxMaxId >= state.mid,
        media_unread: target.pFlags?.media_unread === true,
      };
    };

    let afterMessage;
    let afterDialog;
    try {
      afterMessage = await messages.reloadMessage(state.peerId, state.mid, false);
      afterDialog = await messages.reloadConversation(state.peerId, false);
    } catch {
      sessions.delete(token);
      return { ok: true, outcome: "IN_DOUBT", error: "WEBK_LARGE_DOWNLOAD_RECONCILIATION_FAILED", before: state.before, after: null, provider_state_checked: false };
    }
    const after = snapshot(afterDialog, afterMessage);
    sessions.delete(token);
    if (!after) return { ok: true, outcome: "IN_DOUBT", error: "WEBK_LARGE_DOWNLOAD_RECONCILIATION_FAILED", before: state.before, after: null, provider_state_checked: false };

    const unchanged = after.read_inbox_max_id === state.before.read_inbox_max_id
      && after.target_read === state.before.target_read
      && after.media_unread === state.before.media_unread
      && after.unread_count === state.before.unread_count
      && after.unread_mark === state.before.unread_mark;
    return {
      ok: true,
      outcome: unchanged ? "ACHIEVED" : "IN_DOUBT",
      error: unchanged ? null : "WEBK_LARGE_DOWNLOAD_PROVIDER_STATE_CHANGED",
      before: state.before,
      after,
      provider_state_checked: true,
      provider_state_unchanged: unchanged,
    };
  }, token);
  if (!result?.ok) fail(result?.error || "WEBK_LARGE_DOWNLOAD_FINISH_FAILED");
  return result;
}

export async function webKAbortLargeAttachmentDownload(page, token) {
  if (typeof token !== "string" || !/^[0-9a-f]{32}$/.test(token)) return false;
  try {
    return await evaluateWithin(page, BRIDGE_DEADLINE_MS, (token) => {
      const sessions = globalThis.__pcgLargeAttachmentDownloads;
      if (!(sessions instanceof Map)) return false;
      return sessions.delete(token);
    }, token);
  } catch {
    return false;
  }
}

async function invokeWebKPrepareLocalComposer(page, providerRef, text) {
  const peerId = safeProviderRef(providerRef);
  if (typeof text !== "string" || text.length < 1 || text.length > 512 || text.includes("\0")) {
    fail("WEBK_COMPOSER_TEXT_INVALID");
  }

  const result = await evaluateWithin(page, BRIDGE_DEADLINE_MS, async ({ peerId, text }) => {
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
