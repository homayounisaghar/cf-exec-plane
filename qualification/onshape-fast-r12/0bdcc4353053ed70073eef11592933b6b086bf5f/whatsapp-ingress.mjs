import { chromium } from "playwright";

const DEFAULT_CDP_URL = "http://127.0.0.1:9324";
const DEFAULT_STATUS_URL = "http://127.0.0.1:9334/status";
const WHATSAPP_ORIGIN = "https://web.whatsapp.com";

function codedError(code, message = code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

let cachedBrowser = null;
let connectPromise = null;

async function requireRuntimeReady(statusUrl = DEFAULT_STATUS_URL) {
  let response;
  try {
    response = await fetch(statusUrl, {
      headers: { "cache-control": "no-cache" },
      signal: AbortSignal.timeout(2_500),
    });
  } catch (cause) {
    const error = codedError(
      "WHATSAPP_RUNTIME_STATUS_UNAVAILABLE",
      "WhatsApp final runtime status endpoint is unavailable.",
    );
    error.cause = cause;
    throw error;
  }
  if (!response.ok) throw codedError("WHATSAPP_RUNTIME_STATUS_UNAVAILABLE");
  let status;
  try { status = await response.json(); }
  catch { throw codedError("WHATSAPP_RUNTIME_STATUS_INVALID"); }

  const updatedAt = Number(status?.updated_at_ms || 0);
  if (!Number.isFinite(updatedAt) || updatedAt <= 0 || Date.now() - updatedAt > 15_000) {
    throw codedError("WHATSAPP_RUNTIME_STATUS_STALE");
  }
  const state = String(status?.state || "");
  if (state === "LOGIN_REQUIRED") throw codedError("WHATSAPP_LOGIN_REQUIRED");
  if (state === "SESSION_CONFLICT") throw codedError("WHATSAPP_SESSION_CONFLICT");
  if (state === "BROKEN") throw codedError("WHATSAPP_RUNTIME_BROKEN");
  if (state !== "READY") throw codedError("WHATSAPP_RUNTIME_NOT_READY");
  return status;
}

async function connectBrowser(cdpUrl = DEFAULT_CDP_URL) {
  if (cachedBrowser?.isConnected()) return cachedBrowser;
  if (!connectPromise) {
    connectPromise = chromium.connectOverCDP(cdpUrl, { timeout: 8_000 })
      .then((browser) => {
        cachedBrowser = browser;
        browser.once("disconnected", () => {
          if (cachedBrowser === browser) cachedBrowser = null;
        });
        return browser;
      })
      .finally(() => { connectPromise = null; });
  }
  return await connectPromise;
}

async function whatsappPage(cdpUrl = DEFAULT_CDP_URL, statusUrl = DEFAULT_STATUS_URL) {
  await requireRuntimeReady(statusUrl);
  let browser;
  try {
    browser = await connectBrowser(cdpUrl);
  } catch (cause) {
    const error = codedError(
      "WHATSAPP_BROWSER_UNAVAILABLE",
      "WhatsApp browser debugging endpoint is unavailable.",
    );
    error.cause = cause;
    throw error;
  }

  const pages = browser.contexts().flatMap((context) => context.pages());
  const ready = pages.find((page) => {
    try {
      const url = new URL(page.url());
      return url.origin === WHATSAPP_ORIGIN;
    } catch {
      return false;
    }
  });
  if (!ready) throw codedError("WHATSAPP_PAGE_NOT_FOUND");
  if ((await ready.locator("#pane-side").count()) < 1) {
    throw codedError("WHATSAPP_PROVIDER_PAGE_UNUSABLE");
  }
  return ready;
}


function chatFileReference(file) {
  const obj = file && typeof file === "object" ? file : null;
  const downloadUrl = typeof file === "string"
    ? file.trim()
    : (typeof obj?.download_url === "string" ? obj.download_url.trim()
      : (typeof obj?.url === "string" ? obj.url.trim() : ""));
  if (!downloadUrl) throw codedError("CHAT_FILE_CLIENT_HANDOFF_UNAVAILABLE");
  let parsed;
  try { parsed = new URL(downloadUrl); }
  catch { throw codedError("CHAT_FILE_CLIENT_HANDOFF_UNAVAILABLE"); }
  const host = parsed.hostname.toLowerCase();
  const admitted =
    host === "files.oaiusercontent.com"
    || host.endsWith(".oaiusercontent.com")
    || /^oai[a-z0-9-]*\.blob\.core\.windows\.net$/.test(host);
  if (parsed.protocol !== "https:" || !admitted) {
    throw codedError("CHAT_FILE_CLIENT_HANDOFF_UNAVAILABLE");
  }
  const providedName = typeof obj?.file_name === "string" ? obj.file_name.trim() : "";
  const urlLeaf = decodeURIComponent(parsed.pathname.split("/").filter(Boolean).pop() || "");
  const rawName = providedName || (urlLeaf && /\.[A-Za-z0-9]{1,12}$/.test(urlLeaf) ? urlLeaf : "whatsapp-upload.bin");
  return {
    parsed,
    filename: rawName.replace(/[\\/\0]/g, "_").slice(0, 180) || "whatsapp-upload.bin",
    requested_type: typeof obj?.mime_type === "string" ? obj.mime_type.trim().toLowerCase() : "",
  };
}

async function downloadChatFileBytes(file, {
  maxBytes = 16 * 1024 * 1024,
  timeoutMs = 90_000,
} = {}) {
  const ref = chatFileReference(file);
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  try {
    const response = await fetch(ref.parsed, { method: "GET", redirect: "error", signal: abort.signal });
    if (!response.ok) throw codedError("CHAT_FILE_DOWNLOAD_FAILED");
    const declared = Number(response.headers.get("content-length"));
    if (Number.isSafeInteger(declared) && (declared < 1 || declared > maxBytes)) {
      throw codedError("WHATSAPP_FILE_TOO_LARGE");
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length < 1 || bytes.length > maxBytes) throw codedError("WHATSAPP_FILE_TOO_LARGE");
    if (Number.isSafeInteger(declared) && declared !== bytes.length) throw codedError("CHAT_FILE_SIZE_MISMATCH");
    const mediaType =
      ref.requested_type
      || String(response.headers.get("content-type") || "").split(";")[0].trim().toLowerCase()
      || "application/octet-stream";
    return { bytes, filename: ref.filename, media_type: mediaType, size_bytes: bytes.length };
  } catch (error) {
    if (error?.code) throw error;
    throw codedError(error?.name === "AbortError" ? "CHAT_FILE_DOWNLOAD_TIMEOUT" : "CHAT_FILE_DOWNLOAD_FAILED");
  } finally {
    clearTimeout(timer);
  }
}

async function runWhatsAppCore(op, args = {}, { cdpUrl = DEFAULT_CDP_URL, statusUrl = DEFAULT_STATUS_URL } = {}) {
  const page = await whatsappPage(cdpUrl, statusUrl);
  try {
    return await page.evaluate(async ({ op, args }) => {
      const fail = (code) => {
        const e = new Error(code);
        e.code = code;
        throw e;
      };

      const C = require("WAWebCollections");
      const ChatStore = C.Chat;
      const ContactStore = C.Contact;
      const MsgStore = C.Msg;
      if (!ChatStore || !MsgStore) fail("WHATSAPP_STORES_UNAVAILABLE");

      const asArray = (collection) =>
        Array.isArray(collection?._models)
          ? collection._models
          : (Array.isArray(collection?.models) ? collection.models : []);

      const chatId = (chat) => chat?.id?.toString?.() || String(chat?.id || "");
      const chatTitle = (chat) =>
        String(
          chat?.formattedTitle
          || chat?.name
          || chat?.contact?.formattedName
          || chat?.contact?.name
          || chatId(chat),
        );

      const orderedChats = () => {
        const pane = document.querySelector("#pane-side");
        const row = pane?.querySelector('[role="row"]');
        const fiberKey = row
          ? Object.keys(row).find((key) => key.startsWith("__reactFiber$"))
          : null;
        let fiber = fiberKey ? row[fiberKey] : null;
        for (let depth = 0; depth < 24 && fiber; depth += 1, fiber = fiber.return) {
          const candidate = fiber.memoizedProps?.chats;
          if (Array.isArray(candidate)) return candidate;
        }
        return asArray(ChatStore);
      };

      const mapChat = (chat) => {
        const id = chatId(chat);
        const rawUnread = Number(chat?.unreadCount);
        const markedUnread = Boolean(chat?.markedUnread);
        const unreadCount =
          Number.isFinite(rawUnread) && rawUnread > 0
            ? Math.floor(rawUnread)
            : 0;
        const pinValue = Number(chat?.pin);
        let kind = "user";
        if (id.endsWith("@g.us")) kind = "group";
        else if (id.endsWith("@broadcast")) kind = "broadcast";
        else if (id.endsWith("@newsletter")) kind = "newsletter";
        const timestampSeconds = Number(chat?.t);
        return {
          handle: "wachat:" + id,
          name: chatTitle(chat).slice(0, 256),
          kind,
          unread_count: unreadCount,
          marked_unread: markedUnread,
          has_unread: unreadCount > 0 || markedUnread,
          pinned: Number.isFinite(pinValue) && pinValue > 0,
          archived: Boolean(chat?.archive),
          muted: Number(chat?.mute?.expiration || chat?.muteExpiration || 0) > Math.floor(Date.now() / 1000),
          last_activity_ms:
            Number.isFinite(timestampSeconds) && timestampSeconds > 0
              ? Math.floor(timestampSeconds * 1000)
              : 0,
        };
      };

      const normalize = (value) =>
        String(value || "")
          .trim()
          .toLocaleLowerCase();

      const resolveChat = async (value) => {
        const text = String(value || "").trim();
        if (!text) fail("WHATSAPP_CONVERSATION_REQUIRED");
        let rawId = null;
        if (text.startsWith("wachat:")) rawId = text.slice(7);
        if (text.startsWith("wacontact:")) rawId = text.slice(10);

        const chats = asArray(ChatStore);
        if (rawId) {
          let chat = chats.find((item) => chatId(item) === rawId) || null;
          if (!chat && ContactStore) {
            const contact = asArray(ContactStore).find(
              (item) => item?.id?.toString?.() === rawId,
            );
            if (contact && typeof ChatStore.find === "function") {
              try { chat = await ChatStore.find(contact.id); } catch {}
            }
          }
          if (!chat) fail("WHATSAPP_CONVERSATION_NOT_FOUND");
          return chat;
        }

        const needle = normalize(text);
        const matches = chats.filter((item) => normalize(chatTitle(item)) === needle);
        if (matches.length === 1) return matches[0];
        if (matches.length > 1) fail("WHATSAPP_CONVERSATION_AMBIGUOUS");

        const partial = chats.filter((item) => normalize(chatTitle(item)).includes(needle));
        if (partial.length === 1) return partial[0];
        if (partial.length > 1) fail("WHATSAPP_CONVERSATION_AMBIGUOUS");
        fail("WHATSAPP_CONVERSATION_NOT_FOUND");
      };

      const msgKey = (msg) =>
        msg?.id?.toString?.()
        || msg?.id?._serialized
        || String(msg?.id || "");

      const mapMsg = (msg) => {
        const key = msgKey(msg);
        const body =
          typeof msg?.body === "string"
            ? msg.body
            : (typeof msg?.caption === "string" ? msg.caption : "");
        const remote =
          msg?.id?.remote?.toString?.()
          || msg?.chat?.id?.toString?.()
          || key.split("_")[1]
          || "";
        const fromMe = Boolean(msg?.id?.fromMe);
        const type = String(msg?.type || "unknown");
        const timestamp = Number(msg?.t || msg?.timestamp || 0);
        const mediaType = String(msg?.mimetype || "");
        return {
          handle: "wamsg:" + key,
          provider_message_id: key,
          conversation_handle: remote ? "wachat:" + remote : null,
          from_me: fromMe,
          sender:
            msg?.notifyName
            || msg?.author?.toString?.()
            || msg?.from?.toString?.()
            || null,
          type,
          text: body,
          timestamp_ms:
            Number.isFinite(timestamp) && timestamp > 0
              ? Math.floor(timestamp * 1000)
              : 0,
          has_media: Boolean(
            mediaType
            || msg?.mediaData
            || ["image","video","audio","ptt","document","sticker"].includes(type)
          ),
          media_type: mediaType || null,
          filename: typeof msg?.filename === "string" ? msg.filename : null,
          size_bytes: Number.isFinite(Number(msg?.size)) ? Number(msg.size) : null,
          ack: Number.isFinite(Number(msg?.ack)) ? Number(msg.ack) : null,
          quoted_message_id:
            msg?.quotedMsgKey?.toString?.()
            || msg?.quotedMsg?.id?.toString?.()
            || msg?.contextInfo?.stanzaId
            || null,
          edited: Boolean(msg?.latestEditMsgKey),
          revoked: type === "revoked",
          has_reaction: Boolean(msg?.hasReaction),
        };
      };

      const parseMessageHandle = (value) => {
        const text = String(value || "").trim();
        if (!text) fail("WHATSAPP_MESSAGE_REQUIRED");
        return text.startsWith("wamsg:") ? text.slice(6) : text;
      };

      const recentMessages = async (chat, limit) => {
        const count = Math.max(1, Math.min(100, Number(limit) || 20));
        const byKey = new Map();
        const loaded = asArray(chat?.msgs);
        for (const msg of loaded) {
          const key = msgKey(msg);
          if (key) byKey.set(key, msg);
        }

        const lastKey = chat?.lastReceivedKey;
        if (lastKey) {
          try {
            const db = require("WAWebDBMessageFindLocal");
            const found = await db.msgFindByDirection({
              anchor: lastKey,
              count: Math.max(0, count - 1),
              direction: "before",
            });
            const rows = Array.isArray(found) ? found : (found?.messages || []);
            for (const raw of rows) {
              const key = raw?.id?.toString?.() || raw?.id?._serialized || String(raw?.id || "");
              if (!key) continue;
              let model = MsgStore?.get?.(raw.id || key) || null;
              if (!model && MsgStore?.modelClass) {
                try { model = new MsgStore.modelClass(raw); } catch {}
              }
              byKey.set(key, model || raw);
            }
          } catch {}
        }

        const lastModel =
          (lastKey && (MsgStore?.get?.(lastKey) || loaded.find((m) => msgKey(m) === lastKey?.toString?.())))
          || null;
        if (lastModel) byKey.set(msgKey(lastModel), lastModel);

        return [...byKey.values()]
          .sort((a, b) => Number(b?.t || b?.timestamp || 0) - Number(a?.t || a?.timestamp || 0))
          .slice(0, count);
      };

      const resolveMessage = async (value) => {
        const key = parseMessageHandle(value);
        let msg = MsgStore?.get?.(key) || asArray(MsgStore).find((item) => msgKey(item) === key) || null;
        if (msg) return msg;

        const remote = key.split("_")[1] || "";
        if (!remote) fail("WHATSAPP_MESSAGE_NOT_FOUND");
        const chat =
          asArray(ChatStore).find((item) => chatId(item) === remote)
          || null;
        if (!chat) fail("WHATSAPP_MESSAGE_NOT_FOUND");
        const rows = await recentMessages(chat, 100);
        msg = rows.find((item) => msgKey(item) === key) || null;
        if (!msg) fail("WHATSAPP_MESSAGE_NOT_FOUND");
        return msg;
      };

      const latestMessage = async (conversation) => {
        const chat = await resolveChat(conversation);
        const rows = await recentMessages(chat, 1);
        if (!rows.length) fail("WHATSAPP_MESSAGE_NOT_FOUND");
        return rows[0];
      };

      const resolveMessageInput = async (input) => {
        if (input?.message_handle) return await resolveMessage(input.message_handle);
        if (input?.latest_message === true && input?.conversation) {
          return await latestMessage(input.conversation);
        }
        fail("WHATSAPP_MESSAGE_REQUIRED");
      };

      const makeOutgoing = async (chat, raw = {}, quoted = null) => {
        const MsgKey = require("WAWebMsgKey");
        const prefs = require("WAWebUserPrefsMeUser");
        const from =
          chat?.id?.isGroup?.()
            ? prefs.getMeLidUserOrThrow()
            : (chat?.id?.isLid?.()
              ? prefs.getMeLidUserOrThrow()
              : prefs.getMaybeMePnUser());
        const id = new MsgKey({
          from,
          to: chat.id,
          id: await Promise.resolve(MsgKey.newId()),
          participant: chat?.id?.isGroup?.() ? from : undefined,
          selfDir: "out",
        });
        const base = {
          id,
          t: Math.floor(Date.now() / 1000),
          from,
          to: chat.id,
          self: "out",
          isNewMsg: true,
          local: true,
          ack: 0,
        };
        let ephemeral = {};
        if (raw.type !== "protocol") {
          try {
            ephemeral = require("WAWebGetEphemeralFieldsMsgActionsUtils")
              .getEphemeralFields(chat) || {};
          } catch {}
        }
        let context = {};
        if (quoted) {
          if (typeof quoted.msgContextInfo === "function") {
            context = quoted.msgContextInfo(chat.id) || {};
          } else if (typeof quoted.contextInfo === "object") {
            context = { contextInfo: quoted.contextInfo };
          }
        }
        return { ...ephemeral, ...base, ...raw, ...context };
      };

      const sendRaw = async (chat, raw, quoted = null) => {
        const prepared = await makeOutgoing(chat, raw, quoted);
        const result = await require("WAWebSendMsgChatAction").addAndSendMsgToChat(chat, prepared);
        const msg = await result[0];
        let sendResult = null;
        try { sendResult = await result[1]; } catch {}
        return {
          message: mapMsg(msg),
          send_result: sendResult?.messageSendResult || sendResult || null,
        };
      };

      if (op === "conversation_list") {
        const limit = Math.max(1, Math.min(50, Number(args.limit) || 50));
        const rows = orderedChats().slice(0, limit).map(mapChat);
        return { count: rows.length, conversations: rows, total_models: orderedChats().length };
      }

      if (op === "unread_list") {
        const limit = Math.max(1, Math.min(50, Number(args.limit) || 50));
        const rows = orderedChats()
          .map(mapChat)
          .filter((row) => row.has_unread)
          .slice(0, limit);
        return { count: rows.length, conversations: rows };
      }

      if (op === "conversation_search") {
        const query = normalize(args.query);
        const limit = Math.max(1, Math.min(50, Number(args.limit) || 20));
        const rows = orderedChats()
          .filter((chat) => normalize(chatTitle(chat)).includes(query))
          .slice(0, limit)
          .map(mapChat);
        return { query: String(args.query || ""), count: rows.length, conversations: rows };
      }

      if (op === "contact_search") {
        const query = normalize(args.query);
        const limit = Math.max(1, Math.min(50, Number(args.limit) || 20));
        const contacts = asArray(ContactStore)
          .filter((contact) => {
            const id = contact?.id?.toString?.() || "";
            const names = [
              contact?.formattedName,
              contact?.name,
              contact?.pushname,
              contact?.shortName,
              id,
            ].filter(Boolean).map(normalize);
            return names.some((name) => name.includes(query));
          })
          .slice(0, limit)
          .map((contact) => {
            const id = contact?.id?.toString?.() || "";
            return {
              handle: "wacontact:" + id,
              chat_handle: "wachat:" + id,
              name:
                String(
                  contact?.formattedName
                  || contact?.name
                  || contact?.pushname
                  || id,
                ).slice(0, 256),
              is_business: Boolean(contact?.isBusiness),
              is_group: Boolean(contact?.id?.isGroup?.()),
            };
          });
        return { query: String(args.query || ""), count: contacts.length, contacts };
      }

      if (op === "message_list") {
        const chat = await resolveChat(args.conversation);
        const limit = Math.max(1, Math.min(100, Number(args.limit) || 20));
        const rows = (await recentMessages(chat, limit)).map(mapMsg);
        return {
          conversation: mapChat(chat),
          count: rows.length,
          messages: rows,
        };
      }

      if (op === "message_search") {
        const query = String(args.query || "").trim();
        const limit = Math.max(1, Math.min(50, Number(args.limit) || 20));
        let chat = null;
        if (args.conversation) chat = await resolveChat(args.conversation);
        let rows = [];
        try {
          const found = await require("WAWebDBMessageFindLocal").msgFindSearch({
            searchTerm: query,
            remote: chat?.id,
            page: 0,
            count: limit,
          });
          const raw = Array.isArray(found) ? found : (found?.messages || []);
          rows = raw.map((msg) => mapMsg(msg)).slice(0, limit);
        } catch {}
        if (rows.length === 0) {
          const haystack = chat
            ? await recentMessages(chat, 100)
            : asArray(MsgStore);
          const needle = normalize(query);
          rows = haystack
            .filter((msg) => normalize(msg?.body || msg?.caption || "").includes(needle))
            .sort((a, b) => Number(b?.t || 0) - Number(a?.t || 0))
            .slice(0, limit)
            .map(mapMsg);
        }
        return {
          query,
          conversation: chat ? mapChat(chat) : null,
          count: rows.length,
          messages: rows,
        };
      }

      if (op === "reaction_get") {
        const msg = await resolveMessageInput(args);
        const key = msgKey(msg);
        const value = await require("WAWebDBGetReactions").getReactions(key);
        const aggregates = (value?.reactions || []).map((group) => ({
          emoji: group.aggregateEmoji,
          has_reaction_by_me: Boolean(group.hasReactionByMe),
          count: Array.isArray(group.senders) ? group.senders.length : 0,
        }));
        return {
          message: mapMsg(msg),
          reaction_by_me: value?.reactionByMe?.reactionText || null,
          reactions: aggregates,
        };
      }

      if (op === "send") {
        const chat = await resolveChat(args.target);
        if (chat?.canSend === false) fail("WHATSAPP_CONVERSATION_READ_ONLY");
        const sent = await sendRaw(chat, {
          body: String(args.text || ""),
          type: "chat",
          subtype: null,
        });
        return { target: mapChat(chat), ...sent };
      }

      if (op === "reply") {
        const quoted = await resolveMessageInput(args);
        const remote = quoted?.id?.remote?.toString?.() || msgKey(quoted).split("_")[1] || "";
        const chat = await resolveChat("wachat:" + remote);
        const sent = await sendRaw(chat, {
          body: String(args.text || ""),
          type: "chat",
          subtype: null,
        }, quoted);
        return { target: mapChat(chat), quoted_message: mapMsg(quoted), ...sent };
      }

      if (op === "react") {
        const msg = await resolveMessageInput(args);
        const reaction = args.remove === true ? "" : String(args.emoji || "");
        const result = await require("WAWebSendReactionMsgAction").sendReactionToMsg(msg, reaction);
        await new Promise((resolve) => setTimeout(resolve, 200));
        return {
          message: mapMsg(msg),
          reaction: reaction || null,
          removed: reaction === "",
          provider_result: result ?? null,
        };
      }

      if (op === "forward") {
        const msg = args.message_handle
          ? await resolveMessage(args.message_handle)
          : await latestMessage(args.source);
        const target = await resolveChat(args.target);
        const module = require("WAWebChatForwardMessage");
        if (typeof module?.forwardMessages !== "function") fail("WHATSAPP_FORWARD_NOT_AVAILABLE");
        const rejected = await module.forwardMessages({
          chat: target,
          msgs: [msg],
          multicast: false,
          includeCaption: true,
          appendedText: false,
        });
        if (Array.isArray(rejected) && rejected.length) fail("WHATSAPP_FORWARD_REJECTED");
        return {
          source_message: mapMsg(msg),
          target: mapChat(target),
          provider_confirmed: true,
        };
      }

      if (op === "edit") {
        const msg = await resolveMessageInput(args);
        if (!msg?.id?.fromMe) fail("WHATSAPP_EDIT_NOT_OWNER_MESSAGE");
        const remote = msg?.id?.remote?.toString?.() || msgKey(msg).split("_")[1] || "";
        const chat = await resolveChat("wachat:" + remote);
        const raw = await makeOutgoing(chat, {
          type: "protocol",
          subtype: "message_edit",
          protocolMessageKey: msg.id,
          body: String(args.text || "").trim(),
          caption: String(args.text || "").trim(),
          editMsgType: msg.type,
        });
        raw.latestEditMsgKey = raw.id;
        raw.latestEditSenderTimestampMs = raw.t;
        await require("WAWebSendMessageEditAction").addAndSendMessageEdit(msg, raw);
        await new Promise((resolve) => setTimeout(resolve, 350));
        const fresh = MsgStore?.get?.(msg.id) || msg;
        return {
          message: mapMsg(fresh),
          provider_confirmed:
            String(fresh?.body ?? fresh?.caption ?? "") === String(args.text || "").trim(),
        };
      }

      if (op === "delete") {
        const msg = await resolveMessageInput(args);
        const remote = msg?.id?.remote?.toString?.() || msgKey(msg).split("_")[1] || "";
        const chat = await resolveChat("wachat:" + remote);
        const cmd = require("WAWebCmd").Cmd;
        if (args.for_everyone === true) {
          if (!msg?.id?.fromMe && !chat?.id?.isGroup?.()) {
            fail("WHATSAPP_DELETE_FOR_EVERYONE_NOT_ALLOWED");
          }
          await cmd.sendRevokeMsgs(
            chat,
            { type: "message", list: [msg] },
            { clearMedia: false },
          );
        } else {
          await cmd.sendDeleteMsgs(
            chat,
            { type: "message", list: [msg] },
            false,
          );
        }
        await new Promise((resolve) => setTimeout(resolve, 350));
        const fresh = MsgStore?.get?.(msg.id) || null;
        return {
          message_handle: "wamsg:" + msgKey(msg),
          for_everyone: args.for_everyone === true,
          provider_confirmed:
            args.for_everyone === true
              ? Boolean(fresh?.type === "revoked" || msg?.type === "revoked")
              : !asArray(chat?.msgs).some((item) => msgKey(item) === msgKey(msg)),
        };
      }

      if (op === "mark_unread") {
        const chat = await resolveChat(args.conversation);
        await require("WAWebUpdateUnreadChatAction").markUnread(chat, true);
        await new Promise((resolve) => setTimeout(resolve, 250));
        const state = mapChat(chat);
        return {
          conversation: state,
          desired_unread: true,
          provider_confirmed: state.marked_unread || state.has_unread,
        };
      }

      if (op === "mark_read") {
        const chat = await resolveChat(args.conversation);
        const action = require("WAWebUpdateUnreadChatAction");
        await action.sendSeen({ chat, afterAvailable: false });
        await action.markUnread(chat, false);
        await new Promise((resolve) => setTimeout(resolve, 350));
        const state = mapChat(chat);
        return {
          conversation: state,
          desired_read: true,
          provider_confirmed: state.unread_count === 0 && state.marked_unread === false,
        };
      }

      if (op === "mute") {
        const chat = await resolveChat(args.conversation);
        const desired = args.muted === true;
        const now = Math.floor(Date.now() / 1000);
        const before = Number(chat?.mute?.expiration || chat?.muteExpiration || 0) > now;
        if (desired !== before) {
          if (desired) {
            await chat.mute.mute({
              expiration: 2147483647,
              isAutoMuted: false,
              sendDevice: true,
            });
          } else {
            await chat.mute.unmute({ sendDevice: true });
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 200));
        const after = Number(chat?.mute?.expiration || chat?.muteExpiration || 0) > Math.floor(Date.now() / 1000);
        return {
          conversation: mapChat(chat),
          muted: after,
          effect_attempted: desired !== before,
          provider_confirmed: after === desired,
        };
      }

      if (op === "pin") {
        const chat = await resolveChat(args.conversation);
        const desired = args.pinned === true;
        const before = Number(chat?.pin) > 0;
        if (desired !== before) {
          await require("WAWebSetPinChatAction").setPin(chat, desired);
        }
        await new Promise((resolve) => setTimeout(resolve, 200));
        const after = Number(chat?.pin) > 0;
        return {
          conversation: mapChat(chat),
          pinned: after,
          effect_attempted: desired !== before,
          provider_confirmed: after === desired,
        };
      }

      if (op === "attachment_get") {
        const msg = await resolveMessageInput(args);
        if (!msg?.mediaData) fail("WHATSAPP_MESSAGE_HAS_NO_ATTACHMENT");
        const maxBytes = 8 * 1024 * 1024;
        const mediaData = msg.mediaData;
        const hash = mediaData?.filehash || msg?.filehash || null;

        const blobFromCaches = async () => {
          if (mediaData?.mediaBlob?.forceToBlob) {
            try {
              const direct = mediaData.mediaBlob.forceToBlob();
              if (direct) return direct;
            } catch {}
          }
          if (hash) {
            try {
              const memory = require("WAWebMediaInMemoryBlobCache").InMemoryMediaBlobCache;
              if (memory?.has?.(hash)) {
                const direct = memory.get(hash);
                if (direct) return direct;
              }
            } catch {}
            try {
              const lru = require("WAWebMediaStore").LruMediaStore;
              const cached = await lru.get(hash);
              if (cached instanceof ArrayBuffer) {
                return new Blob([cached], { type: mediaData?.mimetype || msg?.mimetype || "application/octet-stream" });
              }
              if (ArrayBuffer.isView(cached)) {
                return new Blob(
                  [cached.buffer.slice(cached.byteOffset, cached.byteOffset + cached.byteLength)],
                  { type: mediaData?.mimetype || msg?.mimetype || "application/octet-stream" },
                );
              }
            } catch {}
          }
          return null;
        };

        let blob = await blobFromCaches();
        if (!blob) {
          try {
            await msg.downloadMedia({
              downloadEvenIfExpensive: true,
              rmrReason: 1,
              isUserInitiated: true,
            });
          } catch {}
          blob = await blobFromCaches();
        }
        if (!blob) fail("WHATSAPP_ATTACHMENT_UNAVAILABLE");
        if (blob.size < 1 || blob.size > maxBytes) fail("WHATSAPP_ATTACHMENT_TOO_LARGE_FOR_DIRECT_RETURN");
        const bytes = new Uint8Array(await blob.arrayBuffer());
        let binary = "";
        const chunk = 0x8000;
        for (let i = 0; i < bytes.length; i += chunk) {
          binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
        }
        const mime = blob.type || mediaData?.mimetype || msg?.mimetype || "application/octet-stream";
        return {
          message: mapMsg(msg),
          filename: msg?.filename || ("whatsapp-attachment-" + Date.now()),
          mime_type: mime,
          size_bytes: bytes.length,
          data_base64: btoa(binary),
        };
      }

      if (op === "file_send") {
        const chat = await resolveChat(args.target);
        if (chat?.canSend === false) fail("WHATSAPP_CONVERSATION_READ_ONLY");
        const binary = atob(String(args.data_base64 || ""));
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
        if (!bytes.length || bytes.length > 16 * 1024 * 1024) fail("WHATSAPP_FILE_TOO_LARGE");
        const mediaType = String(args.media_type || "application/octet-stream");
        const filename = String(args.filename || "whatsapp-upload.bin").slice(0, 180);
        const file = new File([bytes], filename, { type: mediaType });
        const opaque = await require("WAWebMediaOpaqueData").createFromData(file, file.type);
        const mediaPrep = require("WAWebMedia").prepRawMedia(opaque, { asDocument: true });
        const raw = await makeOutgoing(chat, {
          caption: String(args.caption || ""),
          filename,
          isCaptionByUser: Boolean(args.caption),
        });
        await mediaPrep.waitForPrep();
        const expected = raw.id?.toString?.();
        const waiter = new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            try { chat.msgs.off("add", onAdd); } catch {}
            reject(new Error("WHATSAPP_FILE_REGISTER_TIMEOUT"));
          }, 30_000);
          const onAdd = (msg) => {
            if (msg?.id?.toString?.() !== expected) return;
            clearTimeout(timer);
            try { chat.msgs.off("add", onAdd); } catch {}
            resolve(msg);
          };
          chat.msgs.on("add", onAdd);
        });
        const options = {
          caption: String(args.caption || ""),
          productMsgOptions: raw,
          addEvenWhilePreparing: false,
          type: raw.type,
        };
        const sendPromise =
          mediaPrep.sendToChat.length === 1
            ? mediaPrep.sendToChat({ chat, options })
            : mediaPrep.sendToChat(chat, options);
        const msg = await waiter;
        let sendResult = null;
        try { sendResult = await sendPromise; } catch (error) { fail("WHATSAPP_FILE_SEND_REJECTED"); }
        return {
          target: mapChat(chat),
          message: mapMsg(msg),
          filename,
          mime_type: mediaType,
          size_bytes: bytes.length,
          send_result: sendResult?.messageSendResult || sendResult || null,
        };
      }

      fail("WHATSAPP_OPERATION_UNSUPPORTED");
    }, { op, args });
  } catch (cause) {
    if (cause?.code) throw cause;
    const text = String(cause?.message || cause || "");
    const match = /WHATSAPP_[A-Z0-9_]+/.exec(text);
    if (match) throw codedError(match[0]);
    const error = codedError(
      "WHATSAPP_OPERATION_FAILED",
      "WhatsApp operation failed.",
    );
    error.cause = cause;
    throw error;
  }
}

export async function listWhatsAppConversations(
  limit = 50,
  { cdpUrl = DEFAULT_CDP_URL, statusUrl = DEFAULT_STATUS_URL } = {},
) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
    throw codedError("INVALID_LIMIT");
  }
  const value = await runWhatsAppCore("conversation_list", { limit }, { cdpUrl, statusUrl });
  return {
    state: "ACHIEVED",
    provider: "whatsapp",
    realization: "web-rpc",
    count: value.count,
    conversations: value.conversations,
    bounded: true,
  };
}

function result(payload) {
  return {
    structuredContent: payload,
    content: [{ type: "text", text: JSON.stringify(payload, null, 1) }],
    isError: payload?.state === "FAILED",
  };
}

function failure(error, fallback) {
  const code =
    typeof error?.code === "string"
      ? error.code
      : fallback;
  return result({
    state: "FAILED",
    provider: "whatsapp",
    error: code,
  });
}

const CAPABILITIES = [
  ["whatsapp_conversation_list","read","List up to 50 recent conversations with authoritative unread and pin state."],
  ["whatsapp_capability_list","read","Describe the live WhatsApp connector surface."],
  ["whatsapp_capability_gaps","read","Report explicit unsupported parity gaps."],
  ["whatsapp_unread_list","read","List recent conversations with unread or marked-unread state."],
  ["whatsapp_reaction_get","read","Read own and aggregate reaction state for one exact message."],
  ["whatsapp_conversation_search","read","Search existing WhatsApp conversations by name."],
  ["whatsapp_contact_search","read","Search locally known WhatsApp contacts."],
  ["whatsapp_message_list","read","Read recent messages for one exact conversation without opening it."],
  ["whatsapp_message_search","read","Search messages globally or inside one conversation."],
  ["whatsapp_screenshot","read","Capture the current WhatsApp Web viewport without navigation."],
  ["whatsapp_send","write","Send an ordinary text message."],
  ["whatsapp_reply","write","Reply to an exact or explicitly latest message."],
  ["whatsapp_react","write","Set/change/remove the owner's reaction."],
  ["whatsapp_forward","write","Native-forward one exact or explicitly latest message."],
  ["whatsapp_edit","write","Edit one owner-sent message when WhatsApp permits it."],
  ["whatsapp_delete","write","Delete one exact message locally or for everyone when permitted."],
  ["whatsapp_mark_read","write","Mark one conversation read and clear manual unread state."],
  ["whatsapp_mark_unread","write","Mark one conversation unread without opening it."],
  ["whatsapp_mute","write","Set desired mute state idempotently."],
  ["whatsapp_pin","write","Set desired local chat-pin state idempotently."],
  ["whatsapp_attachment_get","read","Acquire one exact bounded WhatsApp attachment directly from the authenticated web session."],
  ["whatsapp_file_send","write","Send one bounded ChatGPT file as a WhatsApp document."],
];

const GAPS = [
  {
    operation: "whatsapp_provider_write_verification",
    state: "ACKNOWLEDGED_UNVERIFIED",
    reason: "Provider-visible writes are exposed but remain IN_DOUBT until an independent provider-fresh verifier is qualified; mutation return values and the same Web runtime store are not confirmation.",
  },
  {
    operation: "whatsapp_message_replies",
    state: "UNSUPPORTED",
    reason: "WhatsApp does not expose Telegram-style reply threads; replies are quoted-message relationships inside the normal message stream.",
  },
  {
    operation: "whatsapp_transcribe",
    state: "NOT_NEEDED_AS_PROVIDER_PRIMITIVE",
    reason: "Transcription is provider-independent and can reuse the existing audio_transcribe pipeline after attachment acquisition is implemented.",
  },
  {
    operation: "whatsapp_voice_send_file",
    state: "NOT_YET_EXPOSED",
    reason: "Native WhatsApp voice-note media preparation needs the same bounded file path as whatsapp_file_send.",
  },
];

export function registerWhatsAppConversationTool(
  server,
  z,
  { cdpUrl = DEFAULT_CDP_URL, statusUrl = DEFAULT_STATUS_URL } = {},
) {
  const writeOps = new Set([
    "send","reply","react","forward","edit","delete",
    "mark_read","mark_unread","mute","pin","file_send",
  ]);
  const invoke = async (op, args, fallback) => {
    try {
      const value = await runWhatsAppCore(op, args, { cdpUrl, statusUrl });
      if (writeOps.has(op)) {
        return result({
          state: "IN_DOUBT",
          provider: "whatsapp",
          realization: "web-rpc",
          effect_attempted: value?.effect_attempted !== false,
          acknowledged: true,
          ...value,
          provider_confirmed: false,
          verification: {
            authority: "NONE_INDEPENDENT_PROVIDER_FRESH",
            blind_retry_allowed: false,
          },
        });
      }
      return result({
        state: "ACHIEVED",
        provider: "whatsapp",
        realization: "web-rpc",
        ...value,
      });
    } catch (error) {
      return failure(error, fallback);
    }
  };

  server.registerTool("whatsapp_conversation_list", {
    title: "List recent WhatsApp conversations",
    description:
      "Read up to 50 recent WhatsApp conversations from the authenticated WhatsApp Web chat model without opening chats or changing read state. Returns stable wachat: handles and authoritative unread state.",
    inputSchema: {
      limit: z.number().int().min(1).max(50).optional(),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ limit = 50 }) => {
    try {
      return result(await listWhatsAppConversations(limit, { cdpUrl, statusUrl }));
    } catch (error) {
      return failure(error, "WHATSAPP_CONVERSATION_LIST_FAILED");
    }
  });

  server.registerTool("whatsapp_capability_list", {
    title: "List WhatsApp capabilities",
    description: "Return the typed WhatsApp capabilities exposed by this CF-server release.",
    inputSchema: {},
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async () => result({
    state: "ACHIEVED",
    provider: "whatsapp",
    realization: "web-rpc",
    capabilities: CAPABILITIES.map(([name, effect, description]) => ({ name, effect, description })),
  }));

  server.registerTool("whatsapp_capability_gaps", {
    title: "List WhatsApp capability gaps",
    description: "Return explicit Telegram-parity gaps that are unsupported or not yet safely exposed for WhatsApp.",
    inputSchema: {},
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async () => result({
    state: "ACHIEVED",
    provider: "whatsapp",
    gaps: GAPS,
  }));

  server.registerTool("whatsapp_unread_list", {
    title: "List unread WhatsApp conversations",
    description: "Return only recent WhatsApp conversations with unread messages or a manual unread marker.",
    inputSchema: { limit: z.number().int().min(1).max(50).optional() },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ limit = 50 }) => invoke("unread_list", { limit }, "WHATSAPP_UNREAD_LIST_FAILED"));

  server.registerTool("whatsapp_conversation_search", {
    title: "Search WhatsApp conversations",
    description: "Search existing WhatsApp conversations by display name and return stable wachat: handles.",
    inputSchema: {
      query: z.string().trim().min(1).max(128),
      limit: z.number().int().min(1).max(50).optional(),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ query, limit = 20 }) => invoke("conversation_search", { query, limit }, "WHATSAPP_CONVERSATION_SEARCH_FAILED"));

  server.registerTool("whatsapp_contact_search", {
    title: "Search WhatsApp contacts",
    description: "Search locally known WhatsApp contacts by name, pushname, or identifier.",
    inputSchema: {
      query: z.string().trim().min(1).max(128),
      limit: z.number().int().min(1).max(50).optional(),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ query, limit = 20 }) => invoke("contact_search", { query, limit }, "WHATSAPP_CONTACT_SEARCH_FAILED"));

  server.registerTool("whatsapp_message_list", {
    title: "Read recent WhatsApp messages",
    description: "Read recent messages for one exact WhatsApp conversation without opening the chat or changing read state.",
    inputSchema: {
      conversation: z.string().trim().min(1).max(256),
      limit: z.number().int().min(1).max(100).optional(),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ conversation, limit = 20 }) => invoke("message_list", { conversation, limit }, "WHATSAPP_MESSAGE_LIST_FAILED"));

  server.registerTool("whatsapp_message_search", {
    title: "Search WhatsApp messages",
    description: "Search WhatsApp messages globally or inside one exact conversation. Returns stable wamsg: handles.",
    inputSchema: {
      query: z.string().trim().min(1).max(128),
      conversation: z.string().trim().max(256).optional(),
      limit: z.number().int().min(1).max(50).optional(),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ query, conversation, limit = 20 }) => invoke("message_search", { query, conversation, limit }, "WHATSAPP_MESSAGE_SEARCH_FAILED"));

  const messageTargetSchema = {
    message_handle: z.string().trim().max(256).optional(),
    conversation: z.string().trim().max(256).optional(),
    latest_message: z.boolean().optional(),
  };

  server.registerTool("whatsapp_reaction_get", {
    title: "Read WhatsApp reaction state",
    description: "Read the owner's reaction and aggregate emoji counts for one exact WhatsApp message.",
    inputSchema: messageTargetSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async (input) => invoke("reaction_get", input, "WHATSAPP_REACTION_GET_FAILED"));

  server.registerTool("whatsapp_screenshot", {
    title: "Capture WhatsApp screenshot",
    description: "Capture the current logged-in WhatsApp Web viewport without navigating or opening another chat.",
    inputSchema: {
      format: z.enum(["jpeg", "png"]).optional(),
      quality: z.number().int().min(40).max(95).optional(),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ format = "jpeg", quality = 80 }) => {
    try {
      const page = await whatsappPage(cdpUrl, statusUrl);
      const bytes = await page.screenshot({
        type: format,
        ...(format === "jpeg" ? { quality } : {}),
      });
      return {
        structuredContent: {
          state: "ACHIEVED",
          provider: "whatsapp",
          realization: "web-rpc",
          mime_type: format === "png" ? "image/png" : "image/jpeg",
          byte_length: bytes.length,
        },
        content: [{
          type: "image",
          data: bytes.toString("base64"),
          mimeType: format === "png" ? "image/png" : "image/jpeg",
        }],
      };
    } catch (error) {
      return failure(error, "WHATSAPP_SCREENSHOT_FAILED");
    }
  });

  server.registerTool("whatsapp_send", {
    title: "Send WhatsApp text",
    description: "Send an ordinary text message to one exact WhatsApp conversation.",
    inputSchema: {
      target: z.string().trim().min(1).max(256),
      text: z.string().min(1).max(16000),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async ({ target, text }) => invoke("send", { target, text }, "WHATSAPP_SEND_FAILED"));

  server.registerTool("whatsapp_reply", {
    title: "Reply on WhatsApp",
    description: "Reply to one exact WhatsApp message, or to the explicitly requested latest message in a conversation.",
    inputSchema: {
      ...messageTargetSchema,
      text: z.string().min(1).max(16000),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async (input) => invoke("reply", input, "WHATSAPP_REPLY_FAILED"));

  server.registerTool("whatsapp_react", {
    title: "React on WhatsApp",
    description: "Set, change, or remove the owner's reaction on one exact WhatsApp message.",
    inputSchema: {
      ...messageTargetSchema,
      emoji: z.string().max(32).optional(),
      remove: z.boolean().optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async (input) => invoke("react", input, "WHATSAPP_REACT_FAILED"));

  server.registerTool("whatsapp_forward", {
    title: "Forward WhatsApp message",
    description: "Native-forward one exact WhatsApp message. Prefer message_handle; for the latest source message use source plus latest_message=true.",
    inputSchema: {
      message_handle: z.string().trim().max(256).optional(),
      source: z.string().trim().max(256).optional(),
      latest_message: z.boolean().optional(),
      target: z.string().trim().min(1).max(256),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async (input) => invoke("forward", input, "WHATSAPP_FORWARD_FAILED"));

  server.registerTool("whatsapp_edit", {
    title: "Edit WhatsApp message",
    description: "Edit one exact owner-sent WhatsApp message when the provider permits it.",
    inputSchema: {
      ...messageTargetSchema,
      text: z.string().min(1).max(16000),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async (input) => invoke("edit", input, "WHATSAPP_EDIT_FAILED"));

  server.registerTool("whatsapp_delete", {
    title: "Delete WhatsApp message",
    description: "Delete one exact WhatsApp message. confirm_irreversible=true is required. for_everyone requests provider revoke when allowed.",
    inputSchema: {
      ...messageTargetSchema,
      for_everyone: z.boolean().optional(),
      confirm_irreversible: z.literal(true),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  }, async (input) => invoke("delete", input, "WHATSAPP_DELETE_FAILED"));

  server.registerTool("whatsapp_mark_read", {
    title: "Mark WhatsApp conversation read",
    description: "Mark one exact WhatsApp conversation read and clear any manual unread marker. WhatsApp exposes all/read-state semantics rather than Telegram-style partial counted read boundaries.",
    inputSchema: {
      conversation: z.string().trim().min(1).max(256),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ conversation }) => invoke("mark_read", { conversation }, "WHATSAPP_MARK_READ_FAILED"));

  server.registerTool("whatsapp_mark_unread", {
    title: "Mark WhatsApp conversation unread",
    description: "Set the manual unread state for one exact WhatsApp conversation without opening it.",
    inputSchema: {
      conversation: z.string().trim().min(1).max(256),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ conversation }) => invoke("mark_unread", { conversation }, "WHATSAPP_MARK_UNREAD_FAILED"));

  server.registerTool("whatsapp_mute", {
    title: "Mute or unmute WhatsApp conversation",
    description: "Set the exact desired mute state for one WhatsApp conversation. muted=true mutes indefinitely; muted=false unmutes.",
    inputSchema: {
      conversation: z.string().trim().min(1).max(256),
      muted: z.boolean(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ conversation, muted }) => invoke("mute", { conversation, muted }, "WHATSAPP_MUTE_FAILED"));

  server.registerTool("whatsapp_pin", {
    title: "Pin or unpin WhatsApp conversation",
    description: "Set the exact desired local chat-pin state for one WhatsApp conversation.",
    inputSchema: {
      conversation: z.string().trim().min(1).max(256),
      pinned: z.boolean(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ conversation, pinned }) => invoke("pin", { conversation, pinned }, "WHATSAPP_PIN_FAILED"));

  server.registerTool("whatsapp_attachment_get", {
    title: "Get WhatsApp attachment",
    description: "Acquire one exact WhatsApp attachment without opening the chat. Direct return is bounded to 8 MiB.",
    inputSchema: {
      ...messageTargetSchema,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async (input) => {
    try {
      const value = await runWhatsAppCore("attachment_get", input, { cdpUrl });
      const payload = {
        state: "ACHIEVED",
        provider: "whatsapp",
        realization: "web-rpc",
        message: value.message,
        filename: value.filename,
        mime_type: value.mime_type,
        size_bytes: value.size_bytes,
      };
      return {
        structuredContent: payload,
        content: [{
          type: "resource",
          resource: {
            uri: "whatsapp://attachment/" + encodeURIComponent(value.message?.provider_message_id || "attachment"),
            mimeType: value.mime_type,
            blob: value.data_base64,
          },
        }],
      };
    } catch (error) {
      return failure(error, "WHATSAPP_ATTACHMENT_GET_FAILED");
    }
  });

  server.registerTool("whatsapp_file_send", {
    title: "Send WhatsApp file",
    description: "Send one ChatGPT-attached file as a WhatsApp document. Basic direct path is bounded to 16 MiB.",
    inputSchema: {
      target: z.string().trim().min(1).max(256),
      file: z.any(),
      caption: z.string().max(4000).optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async ({ target, file, caption = "" }) => {
    try {
      const source = await downloadChatFileBytes(file);
      const value = await runWhatsAppCore("file_send", {
        target,
        data_base64: source.bytes.toString("base64"),
        filename: source.filename,
        media_type: source.media_type,
        caption,
      }, { cdpUrl, statusUrl });
      return result({
        state: "IN_DOUBT",
        provider: "whatsapp",
        realization: "web-rpc",
        effect_attempted: true,
        acknowledged: true,
        ...value,
        provider_confirmed: false,
        verification: {
          authority: "NONE_INDEPENDENT_PROVIDER_FRESH",
          blind_retry_allowed: false,
        },
      });
    } catch (error) {
      return failure(error, "WHATSAPP_FILE_SEND_FAILED");
    }
  });
}