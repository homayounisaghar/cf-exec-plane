import fs from "node:fs";
import crypto from "node:crypto";
import { chromium } from "playwright";

const DEFAULT_CDP_URL = "http://127.0.0.1:9324";
const DEFAULT_STATUS_URL = "http://127.0.0.1:9334/status";
const WHATSAPP_ORIGIN = "https://web.whatsapp.com";
const WHATSAPP_PROVIDER_DOCUMENT_MAX_BYTES = 2 * 1024 * 1024 * 1024;
const WHATSAPP_MATERIAL_ROOT = "/run/pcg-material-files";
const WHATSAPP_TRANSFER_CHUNK_BYTES = 2 * 1024 * 1024;

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

function materialPathFor(ready, materialRoot = WHATSAPP_MATERIAL_ROOT) {
  const handle = String(ready?.material_file_handle || "").trim();
  const match = /^pcgfile:([0-9a-f]{64})$/.exec(handle);
  if (!match) throw codedError("WHATSAPP_MATERIAL_HANDLE_INVALID");
  const filename = String(ready?.filename || "").trim();
  if (!filename || filename.length > 128 || /[\\/\0]/u.test(filename)) {
    throw codedError("WHATSAPP_MATERIAL_FILENAME_INVALID");
  }
  const filePath = materialRoot + "/" + match[1] + "-" + filename;
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw codedError("WHATSAPP_MATERIAL_FILE_INVALID");
  if (!Number.isSafeInteger(ready?.size_bytes) || stat.size !== ready.size_bytes) {
    throw codedError("WHATSAPP_MATERIAL_SIZE_MISMATCH");
  }
  return filePath;
}

async function loadMaterialPartsIntoPage(page, ready, materialRoot = WHATSAPP_MATERIAL_ROOT) {
  const filePath = materialPathFor(ready, materialRoot);
  const transferToken = crypto.randomBytes(32).toString("hex");
  await page.evaluate((token) => {
    globalThis.__pcgWhatsappUploadParts ||= Object.create(null);
    globalThis.__pcgWhatsappUploadParts[token] = [];
  }, transferToken);

  let total = 0;
  try {
    for await (const incoming of fs.createReadStream(filePath, { highWaterMark: WHATSAPP_TRANSFER_CHUNK_BYTES })) {
      const chunk = Buffer.from(incoming);
      total += chunk.length;
      await page.evaluate(({ token, data }) => {
        const binary = atob(data);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
        const bucket = globalThis.__pcgWhatsappUploadParts?.[token];
        if (!Array.isArray(bucket)) throw new Error("WHATSAPP_STAGED_UPLOAD_MISSING");
        bucket.push(bytes);
      }, { token: transferToken, data: chunk.toString("base64") });
    }
    if (total !== ready.size_bytes) throw codedError("WHATSAPP_MATERIAL_SIZE_MISMATCH");
    return transferToken;
  } catch (error) {
    await page.evaluate((token) => {
      try { delete globalThis.__pcgWhatsappUploadParts?.[token]; } catch {}
    }, transferToken).catch(() => {});
    throw error;
  }
}

async function cleanupPageUpload(page, transferToken) {
  await page.evaluate((token) => {
    try { delete globalThis.__pcgWhatsappUploadParts?.[token]; } catch {}
  }, transferToken).catch(() => {});
}

async function readPreparedAttachmentChunk(page, transferToken, offset, length) {
  return await page.evaluate(async ({ token, offset, length }) => {
    const blob = globalThis.__pcgWhatsappAttachmentBlobs?.[token];
    if (!(blob instanceof Blob)) throw new Error("WHATSAPP_ATTACHMENT_TRANSFER_MISSING");
    const slice = blob.slice(offset, Math.min(blob.size, offset + length));
    const bytes = new Uint8Array(await slice.arrayBuffer());
    let binary = "";
    const step = 0x8000;
    for (let i = 0; i < bytes.length; i += step) {
      binary += String.fromCharCode(...bytes.subarray(i, i + step));
    }
    return btoa(binary);
  }, { token: transferToken, offset, length });
}

async function cleanupPreparedAttachment(page, transferToken) {
  await page.evaluate((token) => {
    try { delete globalThis.__pcgWhatsappAttachmentBlobs?.[token]; } catch {}
  }, transferToken).catch(() => {});
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
        const markedUnread =
          Boolean(chat?.markedUnread)
          || rawUnread === -1;
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

      try {
        if (globalThis.__pcgReceiptTap?.active && typeof globalThis.__pcgReceiptTap.restore === "function") {
          globalThis.__pcgReceiptTap.restore();
        }
        delete globalThis.__pcgReceiptTap;
      } catch {}

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
        const quotedMessageId =
          msg?.quotedMsgKey?.toString?.()
          || msg?.quotedMsg?.id?.toString?.()
          || msg?.contextInfo?.stanzaId
          || null;
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
          quoted_message_id: quotedMessageId,
          quoted_message_handle: quotedMessageId ? "wamsg:" + quotedMessageId : null,
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

      const recentMessages = async (chat, limit, beforeMessage = null) => {
        const count = Math.max(1, Math.min(100, Number(limit) || 20));
        const byKey = new Map();
        const loaded = asArray(chat?.msgs);

        if (!beforeMessage) {
          for (const msg of loaded) {
            const key = msgKey(msg);
            if (key) byKey.set(key, msg);
          }
        }

        const anchor = beforeMessage?.id || chat?.lastReceivedKey;
        let dbSucceeded = false;
        if (anchor) {
          try {
            const db = require("WAWebDBMessageFindLocal");
            const found = await db.msgFindByDirection({
              anchor,
              count: beforeMessage ? count : Math.max(0, count - 1),
              direction: "before",
            });
            dbSucceeded = true;
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

        if (beforeMessage && !dbSucceeded) {
          fail("WHATSAPP_HISTORY_PAGINATION_UNAVAILABLE");
        }

        if (!beforeMessage) {
          const lastKey = chat?.lastReceivedKey;
          const lastModel =
            (lastKey && (MsgStore?.get?.(lastKey) || loaded.find((m) => msgKey(m) === lastKey?.toString?.())))
            || null;
          if (lastModel) byKey.set(msgKey(lastModel), lastModel);
        }

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

      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

      const providerFreshPrimarySnapshot = async (messageHandle, timeoutMs = 12_000) => {
        const keyString = parseMessageHandle(messageHandle);
        const key = require("WAWebMsgKey").fromString(keyString);
        const previous = globalThis.__pcgWhatsappPrimaryVerifyTail || Promise.resolve();
        let release;
        const current = new Promise((resolve) => { release = resolve; });
        globalThis.__pcgWhatsappPrimaryVerifyTail =
          Promise.resolve(previous).catch(() => {}).then(() => current);
        await Promise.resolve(previous).catch(() => {});

        try {
          const handler = require("WAWebNonMessageDataRequestHandlerPlaceholderResend");
          const request = require("WAWebSendNonMessageDataRequest");
          const protobuf = require("WAWebProtobufsE2E.pb");
          const webProtobuf = require("WAWebProtobufsWeb.pb");
          const decoder = require("decodeProtobuf");
          const parser = require("WAWebParseWebMessageInfoApi");
          const original = handler?.handlePlaceholderResendOperationRequestResponse;
          if (typeof original !== "function"
              || typeof request?.sendPeerDataOperationRequest !== "function") {
            return {
              provider_fresh: false,
              authority: "PRIMARY_DEVICE_PLACEHOLDER_RESEND",
              error: "WHATSAPP_PRIMARY_VERIFY_UNAVAILABLE",
            };
          }

          let settle;
          const observed = new Promise((resolve) => { settle = resolve; });
          let settled = false;
          const finish = (value) => {
            if (settled) return;
            settled = true;
            settle(value);
          };

          const wrapper = async function(stanzaId, results) {
            let matched = null;
            try {
              for (const entry of Array.isArray(results) ? results : []) {
                const bytes = entry?.placeholderMessageResendResponse?.webMessageInfoBytes;
                if (!bytes) continue;
                const raw = decoder.decodeProtobuf(webProtobuf.WebMessageInfoSpec, bytes);
                if (String(raw?.key?.id || "") !== String(key.id || "")) continue;
                const parsed = await Promise.resolve(parser.parseWebMessageInfo(raw));
                const message = raw?.message || {};
                const context =
                  message?.extendedTextMessage?.contextInfo
                  || message?.imageMessage?.contextInfo
                  || message?.videoMessage?.contextInfo
                  || message?.documentMessage?.contextInfo
                  || null;
                const text =
                  message?.conversation
                  ?? message?.extendedTextMessage?.text
                  ?? message?.imageMessage?.caption
                  ?? message?.videoMessage?.caption
                  ?? message?.documentMessage?.caption
                  ?? parsed?.body
                  ?? parsed?.caption
                  ?? "";
                const protocol = raw?.message?.protocolMessage || null;
                const editedMessage = protocol?.editedMessage || null;
                const parsedProtocolKey =
                  parsed?.protocolMessageKey?.id
                  || parsed?.protocolMessageKey?.toString?.()?.split("_").pop()
                  || null;
                const editedText =
                  editedMessage?.conversation
                  ?? editedMessage?.extendedTextMessage?.text
                  ?? editedMessage?.imageMessage?.caption
                  ?? editedMessage?.videoMessage?.caption
                  ?? editedMessage?.documentMessage?.caption
                  ?? null;
                matched = {
                  provider_fresh: true,
                  authority: "PRIMARY_DEVICE_PLACEHOLDER_RESEND",
                  verification_source: "WAWebNonMessageDataRequestHandlerPlaceholderResend",
                  request_stanza_id: String(stanzaId || ""),
                  provider_message_id:
                    parsed?.id?.toString?.()
                    || keyString,
                  stanza_id: String(raw?.key?.id || ""),
                  from_me: Boolean(parsed?.id?.fromMe ?? raw?.key?.fromMe),
                  type: String(parsed?.type || ""),
                  subtype: parsed?.subtype == null ? null : String(parsed.subtype),
                  text: String(text || ""),
                  quoted_stanza_id:
                    context?.stanzaId
                    || parsed?.quotedStanzaID
                    || parsed?.quotedMsgKey?.id
                    || null,
                  protocol_type: protocol?.type ?? null,
                  protocol_target_stanza_id:
                    protocol?.key?.id
                    || parsedProtocolKey,
                  edited_text:
                    editedText == null ? null : String(editedText),
                  reactions: (Array.isArray(raw?.reactions) ? raw.reactions : []).map((reaction) => ({
                    text: reaction?.text == null ? "" : String(reaction.text),
                    key_id: reaction?.key?.id == null ? null : String(reaction.key.id),
                    key_from_me: Boolean(reaction?.key?.fromMe),
                    sender_timestamp_ms: Number(
                      reaction?.senderTimestampMs
                      || reaction?.senderTimestamp
                      || 0
                    ),
                  })),
                  status: raw?.status ?? null,
                };
              }
            } catch (error) {
              matched = {
                provider_fresh: false,
                authority: "PRIMARY_DEVICE_PLACEHOLDER_RESEND",
                error: String(error?.message || error),
              };
            }
            let originalResult;
            try {
              originalResult = await original.apply(this, arguments);
            } finally {
              if (matched) finish(matched);
            }
            return originalResult;
          };

          handler.handlePlaceholderResendOperationRequestResponse = wrapper;
          try {
            const type =
              protobuf.Message$PeerDataOperationRequestType.PLACEHOLDER_MESSAGE_RESEND;
            await request.sendPeerDataOperationRequest(type, { msgKeys: [key] });
            return await Promise.race([
              observed,
              sleep(timeoutMs).then(() => ({
                provider_fresh: false,
                authority: "PRIMARY_DEVICE_PLACEHOLDER_RESEND",
                error: "WHATSAPP_PRIMARY_VERIFY_TIMEOUT",
              })),
            ]);
          } finally {
            if (handler.handlePlaceholderResendOperationRequestResponse === wrapper) {
              handler.handlePlaceholderResendOperationRequestResponse = original;
            }
          }
        } catch (error) {
          return {
            provider_fresh: false,
            authority: "PRIMARY_DEVICE_PLACEHOLDER_RESEND",
            error: String(error?.message || error),
          };
        } finally {
          release();
        }
      };

      const verifyPrimaryMessage = async (messageHandle, predicate, {
        attempts = 3,
        delays_ms = [0, 1400, 2800],
      } = {}) => {
        let last = null;
        for (let i = 0; i < attempts; i += 1) {
          const delay = Number(delays_ms[i] || 0);
          if (delay > 0) await sleep(delay);
          last = await providerFreshPrimarySnapshot(messageHandle);
          if (!last?.provider_fresh) continue;
          let matches = false;
          try { matches = predicate(last) === true; } catch {}
          return {
            provider_confirmed: matches,
            provider_fresh: true,
            authority: last.authority,
            verification_source: last.verification_source,
            evidence: last,
            error: matches ? null : "WHATSAPP_PRIMARY_POSTCONDITION_MISMATCH",
          };
        }
        return {
          provider_confirmed: false,
          provider_fresh: false,
          authority: "PRIMARY_DEVICE_PLACEHOLDER_RESEND",
          verification_source: "WAWebNonMessageDataRequestHandlerPlaceholderResend",
          evidence: last,
          error: last?.error || "WHATSAPP_PRIMARY_VERIFY_UNAVAILABLE",
        };
      };

      const syncdPendingCollections = async () => {
        const names = new Set();
        const syncd = require("WAWebSyncd");
        for (const value of [
          syncd?.getPendingCollections?.(),
          syncd?.getInFlightCollections?.(),
        ]) {
          try {
            for (const name of value || []) names.add(String(name));
          } catch {}
        }
        try {
          const rows = await require("WAWebSyncdDb").getAllPendingMutationsRows();
          for (const row of Array.isArray(rows) ? rows : []) {
            if (row?.collection) names.add(String(row.collection));
          }
        } catch {}
        return names;
      };

      const waitSyncdIdle = async (collections, timeoutMs = 15_000) => {
        const wanted = new Set(collections.map(String));
        const end = Date.now() + timeoutMs;
        while (Date.now() < end) {
          const pending = await syncdPendingCollections();
          if ([...wanted].every((name) => !pending.has(name))) {
            return { idle: true, pending: [...pending] };
          }
          await sleep(120);
        }
        const pending = await syncdPendingCollections();
        return { idle: false, pending: [...pending] };
      };

      const verifyFreshSyncdChatState = async (
        chat,
        collections,
        predicate,
        timeoutMs = 18_000,
      ) => {
        const wanted = [...new Set(collections.map(String))];
        try {
          const before = await waitSyncdIdle(wanted, timeoutMs);
          if (!before.idle) {
            return {
              provider_confirmed: false,
              provider_fresh: false,
              authority: "SYNCD_FORCED_PROVIDER_REFRESH",
              verification_source: "WAWebSyncd.markCollectionsForSync",
              error: "WHATSAPP_SYNCD_NOT_IDLE_BEFORE_VERIFY",
              evidence: { pending: before.pending },
            };
          }
          const syncd = require("WAWebSyncd");
          if (typeof syncd?.markCollectionsForSync !== "function") {
            return {
              provider_confirmed: false,
              provider_fresh: false,
              authority: "SYNCD_FORCED_PROVIDER_REFRESH",
              verification_source: "WAWebSyncd.markCollectionsForSync",
              error: "WHATSAPP_SYNCD_VERIFY_UNAVAILABLE",
            };
          }
          await syncd.markCollectionsForSync(wanted);
          await sleep(350);
          const after = await waitSyncdIdle(wanted, timeoutMs);
          if (!after.idle) {
            return {
              provider_confirmed: false,
              provider_fresh: false,
              authority: "SYNCD_FORCED_PROVIDER_REFRESH",
              verification_source: "WAWebSyncd.markCollectionsForSync",
              error: "WHATSAPP_SYNCD_NOT_IDLE_AFTER_VERIFY",
              evidence: { pending: after.pending },
            };
          }
          const state = mapChat(chat);
          let matches = false;
          try { matches = predicate(state) === true; } catch {}
          return {
            provider_confirmed: matches,
            provider_fresh: true,
            authority: "SYNCD_FORCED_PROVIDER_REFRESH",
            verification_source: "WAWebSyncd.markCollectionsForSync",
            evidence: {
              collections: wanted,
              conversation: state,
            },
            error: matches ? null : "WHATSAPP_SYNCD_POSTCONDITION_MISMATCH",
          };
        } catch (error) {
          return {
            provider_confirmed: false,
            provider_fresh: false,
            authority: "SYNCD_FORCED_PROVIDER_REFRESH",
            verification_source: "WAWebSyncd.markCollectionsForSync",
            error: String(error?.message || error),
          };
        }
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
        const expectedText = String(raw?.body ?? raw?.caption ?? "");
        const expectedQuoted = quoted ? String(quoted?.id?.id || "") : null;
        const providerVerification = await verifyPrimaryMessage(
          "wamsg:" + msgKey(msg),
          (fresh) => {
            if (!fresh?.from_me) return false;
            if (expectedText && fresh.text !== expectedText) return false;
            if (expectedQuoted
                && String(fresh.quoted_stanza_id || "") !== expectedQuoted) {
              return false;
            }
            return true;
          },
        );
        return {
          message: mapMsg(msg),
          send_result: sendResult?.messageSendResult || sendResult || null,
          provider_verification: providerVerification,
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
        let beforeMessage = null;
        if (args.before_message_handle) {
          beforeMessage = await resolveMessage(args.before_message_handle);
          const cursorRemote =
            beforeMessage?.id?.remote?.toString?.()
            || msgKey(beforeMessage).split("_")[1]
            || "";
          if (cursorRemote && cursorRemote !== chatId(chat)) {
            fail("WHATSAPP_PAGINATION_CURSOR_CONVERSATION_MISMATCH");
          }
        }
        const rows = (await recentMessages(chat, limit, beforeMessage)).map(mapMsg);
        return {
          conversation: mapChat(chat),
          count: rows.length,
          before_message_handle: beforeMessage ? "wamsg:" + msgKey(beforeMessage) : null,
          next_before_message_handle:
            rows.length === limit && rows.length
              ? rows[rows.length - 1].handle
              : null,
          messages: rows,
        };
      }

      if (op === "message_get") {
        const msg = await resolveMessageInput(args);
        const message = mapMsg(msg);
        let quotedMessage = null;
        let quotedMessageUnavailable = false;
        if (args.include_quoted !== false && message.quoted_message_id) {
          try {
            quotedMessage = mapMsg(await resolveMessage(message.quoted_message_id));
          } catch {
            quotedMessageUnavailable = true;
          }
        }
        return {
          message,
          quoted_message: quotedMessage,
          quoted_message_unavailable: quotedMessageUnavailable,
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
          rows = raw
            .filter((msg) => String(msg?.type || "") !== "protocol")
            .map((msg) => mapMsg(msg))
            .slice(0, limit);
        } catch {}
        if (rows.length === 0) {
          const haystack = chat
            ? await recentMessages(chat, 100)
            : asArray(MsgStore);
          const needle = normalize(query);
          rows = haystack
            .filter((msg) =>
              String(msg?.type || "") !== "protocol"
              && normalize(msg?.body || msg?.caption || "").includes(needle)
            )
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
        const reactionByMe = value?.reactionByMe?.reactionText || null;
        return {
          message: {
            ...mapMsg(msg),
            has_reaction: Boolean(reactionByMe || aggregates.length),
          },
          reaction_by_me: reactionByMe,
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
        await sleep(500);
        const providerVerification = await verifyPrimaryMessage(
          "wamsg:" + msgKey(msg),
          (fresh) => {
            const mine = (fresh.reactions || []).filter((item) => item.key_from_me === true);
            if (reaction === "") return mine.length === 0 || mine.every((item) => item.text === "");
            return mine.some((item) => item.text === reaction);
          },
        );
        return {
          message: mapMsg(msg),
          reaction: reaction || null,
          removed: reaction === "",
          provider_result: result ?? null,
          provider_verification: providerVerification,
        };
      }

      if (op === "forward") {
        const msg = args.message_handle
          ? await resolveMessage(args.message_handle)
          : await latestMessage(args.source);
        const target = await resolveChat(args.target);
        if (target?.canSend === false) fail("WHATSAPP_CONVERSATION_READ_ONLY");
        try {
          await require("WAWebForwardMessageFlowLoadable").requireBundle();
        } catch {
          fail("WHATSAPP_FORWARD_BUNDLE_UNAVAILABLE");
        }
        const module = require("WAWebForwardMessagesToChat");
        if (typeof module?.forwardMessagesToChats !== "function") {
          fail("WHATSAPP_FORWARD_NOT_AVAILABLE");
        }

        const sourceText = String(msg?.body ?? msg?.caption ?? "");
        const sourceType = String(msg?.type || "");
        const startedAt = Date.now();
        const forwarded = new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            try { target.msgs.off("add", onAdd); } catch {}
            reject(new Error("WHATSAPP_FORWARD_REGISTER_TIMEOUT"));
          }, 15_000);
          const onAdd = (candidate) => {
            if (!candidate?.id?.fromMe) return;
            const ts = Number(candidate?.t || 0) * 1000;
            if (ts + 3000 < startedAt) return;
            if (sourceType && String(candidate?.type || "") !== sourceType) return;
            if (sourceText && String(candidate?.body ?? candidate?.caption ?? "") !== sourceText) return;
            clearTimeout(timer);
            try { target.msgs.off("add", onAdd); } catch {}
            resolve(candidate);
          };
          target.msgs.on("add", onAdd);
        });

        await module.forwardMessagesToChats({
          msgs: [msg],
          chats: [target],
          includeCaption: true,
        });
        const forwardedMessage = await forwarded;
        const providerVerification = await verifyPrimaryMessage(
          "wamsg:" + msgKey(forwardedMessage),
          (fresh) =>
            fresh?.from_me === true
            && (!sourceText || fresh.text === sourceText),
        );
        return {
          source_message: mapMsg(msg),
          forwarded_message: mapMsg(forwardedMessage),
          target: mapChat(target),
          provider_verification: providerVerification,
        };
      }

      if (op === "edit") {
        const msg = await resolveMessageInput(args);
        if (!msg?.id?.fromMe) fail("WHATSAPP_EDIT_NOT_OWNER_MESSAGE");
        const originalKey = msgKey(msg);
        const originalStanzaId = String(msg?.id?.id || originalKey.split("_").pop() || "");
        const desiredText = String(args.text || "").trim();
        const remote = msg?.id?.remote?.toString?.() || originalKey.split("_")[1] || "";
        const chat = await resolveChat("wachat:" + remote);
        const raw = await makeOutgoing(chat, {
          type: "protocol",
          subtype: "message_edit",
          protocolMessageKey: msg.id,
          body: desiredText,
          caption: desiredText,
          editMsgType: msg.type,
        });
        const editProtocolKey = raw?.id?.toString?.() || null;
        raw.latestEditMsgKey = raw.id;
        raw.latestEditSenderTimestampMs = raw.t;
        await require("WAWebSendMessageEditAction").addAndSendMessageEdit(msg, raw);
        await sleep(350);
        const current = MsgStore?.get?.(originalKey) || MsgStore?.get?.(msg.id) || msg;
        const providerVerification = editProtocolKey
          ? await verifyPrimaryMessage(
              "wamsg:" + editProtocolKey,
              (fresh) =>
                fresh?.from_me === true
                && String(fresh?.protocol_target_stanza_id || "") === originalStanzaId
                && String(fresh?.edited_text ?? fresh?.text ?? "") === desiredText,
            )
          : {
              provider_confirmed: false,
              provider_fresh: false,
              authority: "PRIMARY_DEVICE_PLACEHOLDER_RESEND",
              error: "WHATSAPP_EDIT_PROTOCOL_KEY_MISSING",
            };
        return {
          message: mapMsg(current),
          edit_protocol_message_key: editProtocolKey,
          provider_verification: providerVerification,
        };
      }

      if (op === "delete") {
        const msg = await resolveMessageInput(args);
        const originalMessageKey = msgKey(msg);
        const originalStanzaId = String(msg?.id?.id || originalMessageKey.split("_").pop() || "");
        const remote = msg?.id?.remote?.toString?.() || originalMessageKey.split("_")[1] || "";
        const chat = await resolveChat("wachat:" + remote);
        const cmd = require("WAWebCmd").Cmd;
        const before = new Set(asArray(chat?.msgs).map(msgKey).filter(Boolean));
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
        await sleep(450);

        let providerVerification;
        let revokeMessageKey = null;
        if (args.for_everyone === true) {
          const revoke = asArray(chat?.msgs)
            .filter((item) => {
              const key = msgKey(item);
              const target =
                item?.protocolMessageKey?.toString?.()
                || item?.protocolMessageKey?.id
                || "";
              return key
                && !before.has(key)
                && item?.id?.fromMe
                && String(item?.type || "") === "revoked"
                && (
                  String(target) === originalMessageKey
                  || String(target).endsWith("_" + originalStanzaId)
                  || String(target) === originalStanzaId
                );
            })
            .sort((a, b) => Number(b?.t || 0) - Number(a?.t || 0))[0] || null;
          revokeMessageKey = revoke ? msgKey(revoke) : null;
          providerVerification = revokeMessageKey
            ? await verifyPrimaryMessage(
                "wamsg:" + revokeMessageKey,
                (fresh) =>
                  fresh?.from_me === true
                  && fresh?.type === "revoked",
              )
            : {
                provider_confirmed: false,
                provider_fresh: false,
                authority: "PRIMARY_DEVICE_PLACEHOLDER_RESEND",
                error: "WHATSAPP_REVOKE_MESSAGE_KEY_MISSING",
              };
        } else {
          providerVerification = await verifyFreshSyncdChatState(
            chat,
            ["regular_high"],
            () => !asArray(chat?.msgs).some((item) => msgKey(item) === originalMessageKey),
          );
        }

        return {
          message_handle: "wamsg:" + originalMessageKey,
          revoke_message_key: revokeMessageKey,
          for_everyone: args.for_everyone === true,
          provider_verification: providerVerification,
        };
      }

      if (op === "mark_unread") {
        const chat = await resolveChat(args.conversation);
        await require("WAWebUpdateUnreadChatAction").markUnread(chat, true);
        await sleep(250);
        const providerVerification = await verifyFreshSyncdChatState(
          chat,
          ["regular_low"],
          (state) => state.marked_unread === true || state.has_unread === true,
        );
        return {
          conversation: mapChat(chat),
          desired_unread: true,
          provider_verification: providerVerification,
        };
      }

      if (op === "mark_read") {
        const chat = await resolveChat(args.conversation);
        const action = require("WAWebUpdateUnreadChatAction");
        await action.sendSeen({ chat, afterAvailable: false });
        await action.markUnread(chat, false);
        await sleep(350);
        const providerVerification = await verifyFreshSyncdChatState(
          chat,
          ["regular_low"],
          (state) => state.unread_count === 0 && state.marked_unread === false,
        );
        return {
          conversation: mapChat(chat),
          desired_read: true,
          provider_verification: providerVerification,
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
        const providerVerification = await verifyFreshSyncdChatState(
          chat,
          ["regular_high"],
          (state) => state.muted === desired,
        );
        return {
          conversation: mapChat(chat),
          muted: after,
          effect_attempted: desired !== before,
          provider_verification: providerVerification,
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
        const providerVerification = await verifyFreshSyncdChatState(
          chat,
          ["regular_low"],
          (state) => state.pinned === desired,
        );
        return {
          conversation: mapChat(chat),
          pinned: after,
          effect_attempted: desired !== before,
          provider_verification: providerVerification,
        };
      }

      if (op === "attachment_prepare") {
        const msg = await resolveMessageInput(args);
        if (!msg?.mediaData) fail("WHATSAPP_MESSAGE_HAS_NO_ATTACHMENT");
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
        if (blob.size < 1 || blob.size > 2 * 1024 * 1024 * 1024) {
          fail("WHATSAPP_ATTACHMENT_PROVIDER_SIZE_INVALID");
        }
        const token = String(args.transfer_token || "");
        if (!/^[0-9a-f]{64}$/.test(token)) fail("WHATSAPP_ATTACHMENT_TRANSFER_TOKEN_INVALID");
        globalThis.__pcgWhatsappAttachmentBlobs ||= Object.create(null);
        globalThis.__pcgWhatsappAttachmentBlobs[token] = blob;
        const mime = blob.type || mediaData?.mimetype || msg?.mimetype || "application/octet-stream";
        return {
          message: mapMsg(msg),
          filename: msg?.filename || ("whatsapp-attachment-" + Date.now()),
          mime_type: mime,
          size_bytes: blob.size,
          transfer_token: token,
        };
      }

      if (op === "file_send_staged") {
        const chat = await resolveChat(args.target);
        if (chat?.canSend === false) fail("WHATSAPP_CONVERSATION_READ_ONLY");
        const token = String(args.transfer_token || "");
        const parts = globalThis.__pcgWhatsappUploadParts?.[token];
        if (!/^[0-9a-f]{64}$/.test(token) || !Array.isArray(parts) || !parts.length) {
          fail("WHATSAPP_STAGED_UPLOAD_MISSING");
        }
        const expectedSize = Number(args.size_bytes);
        const actualSize = parts.reduce((sum, part) => sum + Number(part?.byteLength || 0), 0);
        if (!Number.isSafeInteger(expectedSize) || expectedSize < 1 || actualSize !== expectedSize) {
          fail("WHATSAPP_STAGED_UPLOAD_SIZE_MISMATCH");
        }
        const mediaType = String(args.media_type || "application/octet-stream");
        const filename = String(args.filename || "whatsapp-upload.bin").slice(0, 180);
        const file = new File(parts, filename, { type: mediaType });
        delete globalThis.__pcgWhatsappUploadParts[token];

        const opaque = await require("WAWebMediaOpaqueData").createFromData(file, file.type);
        const voiceMessage = args.voice_message === true;
        const mediaPrep = require("WAWebMedia").prepRawMedia(
          opaque,
          voiceMessage ? { isPtt: true } : { asDocument: true },
        );
        const raw = await makeOutgoing(chat, {
          type: mediaPrep.baseType,
          caption: voiceMessage ? "" : String(args.caption || ""),
          filename,
          isCaptionByUser: !voiceMessage && Boolean(args.caption),
        });
        await mediaPrep.waitForPrep();
        const expected = raw.id?.toString?.();
        const waiter = new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            try { chat.msgs.off("add", onAdd); } catch {}
            reject(new Error("WHATSAPP_FILE_REGISTER_TIMEOUT"));
          }, 60_000);
          const onAdd = (msg) => {
            if (msg?.id?.toString?.() !== expected) return;
            clearTimeout(timer);
            try { chat.msgs.off("add", onAdd); } catch {}
            resolve(msg);
          };
          chat.msgs.on("add", onAdd);
        });
        const options = {
          caption: voiceMessage ? "" : String(args.caption || ""),
          productMsgOptions: raw,
          addEvenWhilePreparing: false,
          type: raw.type,
        };
        const sendPromise =
          mediaPrep.sendToChat.length === 1
            ? mediaPrep.sendToChat({ chat, options })
            : mediaPrep.sendToChat(chat, options);
        try {
          const msg = await waiter;
          let sendResult = null;
          try { sendResult = await sendPromise; } catch { fail("WHATSAPP_FILE_SEND_REJECTED"); }
          const providerVerification = await verifyPrimaryMessage(
            "wamsg:" + msgKey(msg),
            (fresh) => {
              if (fresh?.from_me !== true) return false;
              if (voiceMessage) return ["ptt", "audio"].includes(fresh.type);
              return ["document", "image", "video", "audio"].includes(fresh.type);
            },
          );
          return {
            target: mapChat(chat),
            message: mapMsg(msg),
            filename,
            mime_type: mediaType,
            size_bytes: actualSize,
            voice_message: voiceMessage,
            send_result: sendResult?.messageSendResult || sendResult || null,
            provider_verification: providerVerification,
          };
        } finally {
          try { opaque.release?.(); } catch {}
        }
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
  ["whatsapp_message_list","read","Read recent or paginated older messages for one exact conversation without opening it."],
  ["whatsapp_message_get","read","Read one exact or explicitly latest message and resolve its quoted-message relationship when locally available."],
  ["whatsapp_message_search","read","Search messages globally or inside one conversation."],
  ["whatsapp_screenshot","read","Capture the current WhatsApp Web viewport without navigation."],
  ["whatsapp_send","write","Send an ordinary text message."],
  ["whatsapp_reply","write","Reply to an exact or explicitly latest message."],
  ["whatsapp_react","write","Set/change/remove the owner's reaction."],
  ["whatsapp_forward","write","Native-forward one exact WhatsApp message through WhatsApp Web's own forward bundle, then verify the created message with a fresh primary-device read."],
  ["whatsapp_edit","write","Edit one owner-sent message when WhatsApp permits it."],
  ["whatsapp_delete","write","Delete one exact message locally or for everyone when permitted."],
  ["whatsapp_mark_read","write","Mark one conversation read and clear manual unread state."],
  ["whatsapp_mark_unread","write","Mark one conversation unread without opening it."],
  ["whatsapp_mute","write","Set desired mute state idempotently."],
  ["whatsapp_pin","write","Set desired local chat-pin state idempotently."],
  ["whatsapp_attachment_get","read","Acquire one exact WhatsApp attachment through the shared resumable material plane and return an expiring download link up to the provider 2 GB document bound."],
  ["whatsapp_file_upload","write","Create, inspect, or delete a resumable WhatsApp material upload ticket up to 2 GB."],
  ["whatsapp_file_upload_chunk","write","Append one bounded resumable chunk to a WhatsApp material upload ticket."],
  ["whatsapp_file_send","write","Send a ChatGPT attachment or completed material upload as a WhatsApp document up to the provider 2 GB document bound."],
  ["whatsapp_voice_send_file","write","Send owner-supplied audio through WhatsApp Web native PTT media preparation as a voice message."],
];

const GAPS = [
  {
    operation: "whatsapp_provider_write_verification",
    state: "PROVIDER_FRESH_VERIFIER_QUALIFIED",
    reason: "Fresh linked-primary-device reads independently verify send, reply, native forward, reaction, edit and revoke/delete-for-everyone postconditions, while a forced provider Syncd roundtrip verifies account-state writes such as read/unread, mute, pin and local-only delete. Any unavailable or mismatched postcondition remains IN_DOUBT and is never blindly retried.",
  },
  {
    operation: "whatsapp_forward",
    state: "SUPPORTED_AND_VERIFIED",
    reason: "Native forwarding uses WhatsApp Web's own lazily-loaded forwardMessagesToChats flow and the exact created message is independently re-read from the linked primary device.",
  },
  {
    operation: "whatsapp_material_transport",
    state: "PROVIDER_ALIGNED",
    reason: "Document ingress and attachment egress use the shared resumable material plane up to 2 GB, matching the current WhatsApp document limit. Provider-specific media rules can still reject individual formats.",
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
    state: "SUPPORTED",
    reason: "Native OGG/Opus PTT dispatch is live-qualified on an owner-approved target and uses the shared provider-aligned material plane.",
  },
];

export function registerWhatsAppConversationTool(
  server,
  z,
  {
    cdpUrl = DEFAULT_CDP_URL,
    statusUrl = DEFAULT_STATUS_URL,
    materialUpload = null,
    stageMaterialDownload = null,
    materialRoot = WHATSAPP_MATERIAL_ROOT,
  } = {},
) {
  const requireMaterialUpload = () => {
    if (!materialUpload
        || typeof materialUpload.create !== "function"
        || typeof materialUpload.status !== "function"
        || typeof materialUpload.delete !== "function"
        || typeof materialUpload.append !== "function"
        || typeof materialUpload.ready !== "function"
        || typeof materialUpload.markSendStarted !== "function") {
      throw codedError("WHATSAPP_MATERIAL_UPLOAD_UNAVAILABLE");
    }
    return materialUpload;
  };

  const stageChatUploadedFile = async (file, {
    maxBytes = WHATSAPP_PROVIDER_DOCUMENT_MAX_BYTES,
    timeoutMs = 12 * 60 * 1000,
  } = {}) => {
    const ref = chatFileReference(file);
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), timeoutMs);
    let created = null;
    try {
      const response = await fetch(ref.parsed, { method: "GET", redirect: "error", signal: abort.signal });
      if (!response.ok) throw codedError("CHAT_FILE_DOWNLOAD_FAILED");
      const declared = Number(response.headers.get("content-length"));
      if (!Number.isSafeInteger(declared) || declared < 1 || declared > maxBytes) {
        throw codedError("WHATSAPP_FILE_PROVIDER_SIZE_INVALID");
      }
      const mediaType =
        ref.requested_type
        || String(response.headers.get("content-type") || "").split(";")[0].trim().toLowerCase()
        || "application/octet-stream";
      const upload = requireMaterialUpload();
      created = upload.create({
        filename: ref.filename,
        media_type: mediaType,
        size_bytes: declared,
        sha256_hex: null,
      });
      let offset = 0;
      let carry = Buffer.alloc(0);
      if (!response.body) throw codedError("CHAT_FILE_DOWNLOAD_FAILED");
      for await (const incoming of response.body) {
        const bytes = Buffer.from(incoming);
        carry = carry.length ? Buffer.concat([carry, bytes]) : bytes;
        while (carry.length >= WHATSAPP_TRANSFER_CHUNK_BYTES) {
          const chunk = carry.subarray(0, WHATSAPP_TRANSFER_CHUNK_BYTES);
          await upload.append(created.upload_id, offset, { data_base64: chunk.toString("base64") });
          offset += chunk.length;
          carry = carry.subarray(WHATSAPP_TRANSFER_CHUNK_BYTES);
        }
        if (offset + carry.length > declared) throw codedError("CHAT_FILE_SIZE_MISMATCH");
      }
      if (carry.length) {
        await upload.append(created.upload_id, offset, { data_base64: carry.toString("base64") });
        offset += carry.length;
      }
      if (offset !== declared) throw codedError("CHAT_FILE_SIZE_MISMATCH");
      return await upload.ready(created.upload_id);
    } catch (error) {
      if (created?.upload_id) {
        try { await requireMaterialUpload().delete(created.upload_id); } catch {}
      }
      if (error?.code) throw error;
      throw codedError(error?.name === "AbortError" ? "CHAT_FILE_DOWNLOAD_TIMEOUT" : "CHAT_FILE_DOWNLOAD_FAILED");
    } finally {
      clearTimeout(timer);
    }
  };

  const sendReadyMaterial = async (ready, { target, caption = "", voice_message = false } = {}) => {
    const page = await whatsappPage(cdpUrl, statusUrl);
    const transferToken = await loadMaterialPartsIntoPage(page, ready, materialRoot);
    try {
      return await runWhatsAppCore("file_send_staged", {
        target,
        caption,
        voice_message,
        transfer_token: transferToken,
        filename: ready.filename,
        media_type: ready.media_type,
        size_bytes: ready.size_bytes,
      }, { cdpUrl, statusUrl });
    } finally {
      await cleanupPageUpload(page, transferToken);
    }
  };

  const stageAttachmentDownload = async (input) => {
    const upload = requireMaterialUpload();
    if (typeof stageMaterialDownload !== "function") {
      throw codedError("WHATSAPP_ATTACHMENT_DOWNLOAD_STAGING_UNAVAILABLE");
    }
    const page = await whatsappPage(cdpUrl, statusUrl);
    const transferToken = crypto.randomBytes(32).toString("hex");
    let created = null;
    try {
      const prepared = await runWhatsAppCore("attachment_prepare", {
        ...input,
        transfer_token: transferToken,
      }, { cdpUrl, statusUrl });
      created = upload.create({
        filename: String(prepared.filename || "whatsapp-attachment").slice(0, 128),
        media_type: prepared.mime_type || "application/octet-stream",
        size_bytes: prepared.size_bytes,
        sha256_hex: null,
      });
      let offset = 0;
      while (offset < prepared.size_bytes) {
        const length = Math.min(WHATSAPP_TRANSFER_CHUNK_BYTES, prepared.size_bytes - offset);
        const data_base64 = await readPreparedAttachmentChunk(page, transferToken, offset, length);
        const appended = await upload.append(created.upload_id, offset, { data_base64 });
        offset = Number(appended.offset);
      }
      const ready = await upload.ready(created.upload_id);
      const download = await stageMaterialDownload(ready);
      return {
        message: prepared.message,
        filename: ready.filename,
        mime_type: ready.media_type,
        size_bytes: ready.size_bytes,
        sha256_hex: ready.sha256_hex,
        download,
      };
    } catch (error) {
      if (created?.upload_id) {
        try { await upload.delete(created.upload_id); } catch {}
      }
      throw error;
    } finally {
      await cleanupPreparedAttachment(page, transferToken);
    }
  };

  const writeOps = new Set([
    "send","reply","react","forward","edit","delete",
    "mark_read","mark_unread","mute","pin","file_send_staged",
  ]);
  const invoke = async (op, args, fallback) => {
    try {
      const value = await runWhatsAppCore(op, args, { cdpUrl, statusUrl });
      if (writeOps.has(op)) {
        const fresh = value?.provider_verification?.provider_confirmed === true;
        const clean = { ...(value || {}) };
        delete clean.provider_verification;
        delete clean.provider_confirmed;
        return result({
          state: fresh ? "ACHIEVED" : "IN_DOUBT",
          provider: "whatsapp",
          realization: "web-rpc",
          effect_attempted: value?.effect_attempted !== false,
          acknowledged: true,
          ...clean,
          provider_confirmed: fresh,
          verification: fresh
            ? {
                ...value.provider_verification,
                blind_retry_allowed: false,
              }
            : {
                authority: "NONE_INDEPENDENT_PROVIDER_FRESH",
                provider_fresh: false,
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
    capabilities: CAPABILITIES.map(([name, effect, description, availability = "SUPPORTED"]) => ({
      name,
      effect,
      description,
      availability,
    })),
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
    title: "Read WhatsApp message history",
    description: "Read recent messages or page backward from one stable wamsg: cursor without opening the chat or changing read state.",
    inputSchema: {
      conversation: z.string().trim().min(1).max(256),
      limit: z.number().int().min(1).max(100).optional(),
      before_message_handle: z.string().trim().max(256).optional(),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ conversation, limit = 20, before_message_handle }) =>
    invoke("message_list", { conversation, limit, before_message_handle }, "WHATSAPP_MESSAGE_LIST_FAILED"));

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

  server.registerTool("whatsapp_message_get", {
    title: "Read one WhatsApp message",
    description: "Resolve one exact WhatsApp message, or the explicitly requested latest message, without opening the chat. Returns stable quoted-message handle metadata and resolves one quoted message when locally available.",
    inputSchema: {
      ...messageTargetSchema,
      include_quoted: z.boolean().optional(),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async (input) => invoke("message_get", input, "WHATSAPP_MESSAGE_GET_FAILED"));

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
    description: "Acquire one exact WhatsApp attachment without opening the chat, stage it through the resumable material plane, and return an expiring download link. Supports provider files up to the current WhatsApp 2 GB document bound.",
    inputSchema: { ...messageTargetSchema },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async (input) => {
    try {
      const value = await stageAttachmentDownload(input);
      const payload = {
        state: "ACHIEVED",
        provider: "whatsapp",
        realization: "web-rpc-material",
        message: value.message,
        filename: value.filename,
        mime_type: value.mime_type,
        size_bytes: value.size_bytes,
        sha256_hex: value.sha256_hex,
        download_path: value.download.download_path,
        expires_after_seconds: value.download.expires_after_seconds,
      };
      return {
        structuredContent: payload,
        content: [
          { type: "text", text: JSON.stringify(payload, null, 1) },
          {
            type: "resource_link",
            uri: "https://cf-onshape.duckdns.org" + value.download.download_path,
            name: value.filename,
            mimeType: value.mime_type,
            size: value.size_bytes,
            description: "Expiring WhatsApp attachment download.",
          },
        ],
      };
    } catch (error) {
      return failure(error, "WHATSAPP_ATTACHMENT_GET_FAILED");
    }
  });

  server.registerTool("whatsapp_file_upload", {
    title: "Stage a large WhatsApp file",
    description: "Create, inspect, or delete a resumable WhatsApp material upload ticket. The shared material plane accepts files up to the current WhatsApp 2 GB document limit.",
    inputSchema: {
      action: z.enum(["create", "status", "delete"]),
      upload_id: z.string().regex(/^[0-9a-f]{64}$/).optional(),
      filename: z.string().min(1).max(128).optional(),
      media_type: z.string().min(3).max(128).optional(),
      size_bytes: z.number().int().min(1).max(2147483648).optional(),
      sha256_hex: z.string().regex(/^[0-9a-fA-F]{64}$/).optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async (input) => {
    try {
      const upload = requireMaterialUpload();
      let value;
      if (input.action === "create") {
        value = upload.create({
          filename: input.filename,
          media_type: input.media_type,
          size_bytes: input.size_bytes,
          sha256_hex: input.sha256_hex,
        });
      } else if (input.action === "status") {
        value = await upload.status(input.upload_id);
      } else {
        value = await upload.delete(input.upload_id);
      }
      return result({ state: "ACHIEVED", provider: "whatsapp", realization: "material-plane", ...value });
    } catch (error) {
      return failure(error, "WHATSAPP_FILE_UPLOAD_FAILED");
    }
  });

  server.registerTool("whatsapp_file_upload_chunk", {
    title: "Upload one WhatsApp file chunk",
    description: "Append one bounded chunk to a resumable WhatsApp material upload ticket. offset must equal the current staged offset.",
    inputSchema: {
      upload_id: z.string().regex(/^[0-9a-f]{64}$/),
      offset: z.number().int().nonnegative(),
      data_base64: z.string().max(2900000).optional(),
      zero_bytes: z.number().int().min(1).max(16777216).optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async ({ upload_id, offset, data_base64, zero_bytes }) => {
    try {
      const value = await requireMaterialUpload().append(upload_id, offset, { data_base64, zero_bytes });
      return result({ state: "ACHIEVED", provider: "whatsapp", realization: "material-plane", ...value });
    } catch (error) {
      return failure(error, "WHATSAPP_FILE_UPLOAD_CHUNK_FAILED");
    }
  });

  const fileInputSchema = {
    target: z.string().trim().min(1).max(256),
    file: z.union([
      z.string().min(1),
      z.object({
        download_url: z.string().optional(),
        file_id: z.string().optional(),
        mime_type: z.string().optional(),
        file_name: z.string().optional(),
        url: z.string().optional(),
      }).passthrough(),
    ]).optional(),
    upload_id: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  };

  server.registerTool("whatsapp_file_send", {
    title: "Send WhatsApp file",
    description: "Send one ChatGPT-attached file or completed resumable upload as a WhatsApp document. No connector-specific size cap below WhatsApp's current 2 GB document limit is imposed.",
    inputSchema: {
      ...fileInputSchema,
      caption: z.string().max(4000).optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    _meta: { "openai/fileParams": ["file"] },
  }, async (input) => {
    let transientUploadId = null;
    try {
      if (Number(Boolean(input.file)) + Number(Boolean(input.upload_id)) !== 1) {
        throw codedError("WHATSAPP_FILE_SOURCE_AMBIGUOUS");
      }
      const upload = requireMaterialUpload();
      const ready = input.file
        ? await stageChatUploadedFile(input.file)
        : await upload.ready(input.upload_id);
      if (input.file) transientUploadId = ready.upload_id;
      upload.markSendStarted(ready.upload_id);
      const value = await sendReadyMaterial(ready, {
        target: input.target,
        caption: input.caption || "",
        voice_message: false,
      });
      const fresh = value?.provider_verification?.provider_confirmed === true;
      const clean = { ...(value || {}) };
      delete clean.provider_verification;
      delete clean.provider_confirmed;
      return result({
        state: fresh ? "ACHIEVED" : "IN_DOUBT",
        provider: "whatsapp",
        realization: "web-rpc-material",
        effect_attempted: true,
        acknowledged: true,
        ...clean,
        provider_confirmed: fresh,
        verification: fresh
          ? { ...value.provider_verification, blind_retry_allowed: false }
          : { authority: "NONE_INDEPENDENT_PROVIDER_FRESH", provider_fresh: false, blind_retry_allowed: false },
      });
    } catch (error) {
      return failure(error, "WHATSAPP_FILE_SEND_FAILED");
    } finally {
      if (transientUploadId) {
        try { await requireMaterialUpload().delete(transientUploadId); } catch {}
      }
    }
  });

  server.registerTool("whatsapp_voice_send_file", {
    title: "Send WhatsApp voice message",
    description: "Send owner-supplied audio through WhatsApp Web native PTT media preparation. Preferred path is a ChatGPT attachment; a completed resumable upload may also be used.",
    inputSchema: fileInputSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    _meta: { "openai/fileParams": ["file"] },
  }, async (input) => {
    let transientUploadId = null;
    try {
      if (Number(Boolean(input.file)) + Number(Boolean(input.upload_id)) !== 1) {
        throw codedError("WHATSAPP_FILE_SOURCE_AMBIGUOUS");
      }
      const upload = requireMaterialUpload();
      const ready = input.file
        ? await stageChatUploadedFile(input.file)
        : await upload.ready(input.upload_id);
      if (input.file) transientUploadId = ready.upload_id;
      upload.markSendStarted(ready.upload_id);
      const value = await sendReadyMaterial(ready, {
        target: input.target,
        caption: "",
        voice_message: true,
      });
      const fresh = value?.provider_verification?.provider_confirmed === true;
      const clean = { ...(value || {}) };
      delete clean.provider_verification;
      delete clean.provider_confirmed;
      return result({
        state: fresh ? "ACHIEVED" : "IN_DOUBT",
        provider: "whatsapp",
        realization: "web-rpc-material",
        effect_attempted: true,
        acknowledged: true,
        ...clean,
        provider_confirmed: fresh,
        verification: fresh
          ? { ...value.provider_verification, blind_retry_allowed: false }
          : { authority: "NONE_INDEPENDENT_PROVIDER_FRESH", provider_fresh: false, blind_retry_allowed: false },
      });
    } catch (error) {
      return failure(error, "WHATSAPP_VOICE_SEND_FAILED");
    } finally {
      if (transientUploadId) {
        try { await requireMaterialUpload().delete(transientUploadId); } catch {}
      }
    }
  });
}