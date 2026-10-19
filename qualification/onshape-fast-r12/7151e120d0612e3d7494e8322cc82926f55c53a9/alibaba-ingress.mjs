import { chromium } from "playwright";

const DEFAULT_CDP_URL = "http://127.0.0.1:9325";
const DEFAULT_STATUS_URL = "http://127.0.0.1:9335/status";
const ALIBABA_ORIGIN = "https://message.alibaba.com";
const ALIBABA_MESSENGER_PATH = "/message/messenger.htm";
const ALIBABA_MATERIAL_ROOT = "/run/pcg-material-files";
const ALIBABA_MATERIAL_TRANSPORT_MAX_BYTES = 2 * 1024 * 1024 * 1024;
const ALIBABA_TRANSFER_CHUNK_BYTES = 2 * 1024 * 1024;

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
      signal: AbortSignal.timeout(2500),
    });
  } catch (cause) {
    const error = codedError(
      "ALIBABA_RUNTIME_STATUS_UNAVAILABLE",
      "Alibaba final runtime status endpoint is unavailable.",
    );
    error.cause = cause;
    throw error;
  }
  if (!response.ok) throw codedError("ALIBABA_RUNTIME_STATUS_UNAVAILABLE");
  let status;
  try {
    status = await response.json();
  } catch {
    throw codedError("ALIBABA_RUNTIME_STATUS_INVALID");
  }

  const updatedAt = Number(status?.updated_at_ms || 0);
  if (!Number.isFinite(updatedAt) || updatedAt <= 0 || Date.now() - updatedAt > 15000) {
    throw codedError("ALIBABA_RUNTIME_STATUS_STALE");
  }
  const state = String(status?.state || "");
  if (state === "LOGIN_REQUIRED") throw codedError("ALIBABA_LOGIN_REQUIRED");
  if (state === "BROKEN") throw codedError("ALIBABA_RUNTIME_BROKEN");
  if (state !== "READY") throw codedError("ALIBABA_RUNTIME_NOT_READY");
  if (String(status?.detail || "") !== "AUTHENTICATED_MESSAGE_CENTER") {
    throw codedError("ALIBABA_RUNTIME_NOT_AUTHENTICATED");
  }
  return status;
}

async function connectBrowser(cdpUrl = DEFAULT_CDP_URL) {
  if (cachedBrowser?.isConnected()) return cachedBrowser;
  if (!connectPromise) {
    connectPromise = chromium.connectOverCDP(cdpUrl, { timeout: 8000 })
      .then((browser) => {
        cachedBrowser = browser;
        browser.once("disconnected", () => {
          if (cachedBrowser === browser) cachedBrowser = null;
        });
        return browser;
      })
      .finally(() => {
        connectPromise = null;
      });
  }
  return await connectPromise;
}

async function alibabaPage(cdpUrl = DEFAULT_CDP_URL, statusUrl = DEFAULT_STATUS_URL) {
  await requireRuntimeReady(statusUrl);
  let browser;
  try {
    browser = await connectBrowser(cdpUrl);
  } catch (cause) {
    const error = codedError(
      "ALIBABA_BROWSER_UNAVAILABLE",
      "Alibaba browser debugging endpoint is unavailable.",
    );
    error.cause = cause;
    throw error;
  }
  const pages = browser.contexts().flatMap((context) => context.pages());
  const page = pages.find((candidate) => {
    try {
      const url = new URL(candidate.url());
      return url.origin === ALIBABA_ORIGIN && url.pathname.includes(ALIBABA_MESSENGER_PATH);
    } catch {
      return false;
    }
  });
  if (!page) throw codedError("ALIBABA_PAGE_NOT_FOUND");
  return page;
}

function result(payload) {
  return {
    structuredContent: payload,
    content: [{ type: "text", text: JSON.stringify(payload, null, 1) }],
    isError: payload?.state === "FAILED",
  };
}

function failure(error, fallback = "ALIBABA_OPERATION_FAILED") {
  const raw = String(error?.code || error?.message || error || "");
  const match = raw.match(/ALIBABA_[A-Z0-9_]+/);
  return result({
    state: "FAILED",
    provider: "alibaba",
    error: match?.[0] || fallback,
  });
}

async function runAlibabaCore(
  op,
  args = {},
  { cdpUrl = DEFAULT_CDP_URL, statusUrl = DEFAULT_STATUS_URL } = {},
) {
  const page = await alibabaPage(cdpUrl, statusUrl);
  try {
    return await page.evaluate(async ({ op, args }) => {
      const fail = (code) => {
        throw new Error(code);
      };
      const sdk = globalThis._imBaaSSDK || globalThis._imsdk;
      if (!sdk) fail("ALIBABA_SDK_UNAVAILABLE");

      const conversationService =
        (typeof sdk.getConversationServiceV2 === "function" && sdk.getConversationServiceV2())
        || (typeof sdk.getConversationService === "function" && sdk.getConversationService());
      const messageServiceV2 =
        (typeof sdk.getMessageServiceV2 === "function" && sdk.getMessageServiceV2())
        || (typeof sdk.getMessageService === "function" && sdk.getMessageService());
      const messageServiceV1 =
        (typeof sdk.getMessageService === "function" && sdk.getMessageService())
        || messageServiceV2;
      const contactService =
        typeof sdk.getContactService === "function" ? sdk.getContactService() : null;
      const authService =
        typeof sdk.getAuthService === "function" ? sdk.getAuthService() : null;

      if (!conversationService) fail("ALIBABA_CONVERSATION_SERVICE_UNAVAILABLE");
      if (!messageServiceV2) fail("ALIBABA_MESSAGE_SERVICE_UNAVAILABLE");

      const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const cleanText = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
      const cachedConversations = Array.isArray(globalThis.__conversationListFullData__)
        ? globalThis.__conversationListFullData__
        : [];
      const cachedConversation = (cid) =>
        cachedConversations.find((item) =>
          String(item?.cid ?? item?.conversationCode ?? "") === String(cid || "")
        ) || null;
      const enrichConversation = (raw) => {
        const cid = String(raw?.cid ?? raw?.conversationCode ?? "").trim();
        const cached = cid ? cachedConversation(cid) : null;
        if (!cached) return raw;
        return {
          ...cached,
          ...raw,
          contact: { ...(cached?.contact || {}), ...(raw?.contact || {}) },
          owner: { ...(cached?.owner || {}), ...(raw?.owner || {}) },
          latestMessage: raw?.latestMessage ?? cached?.latestMessage ?? null,
        };
      };
      const ownAliId = cleanText(
        cachedConversations.find((item) => item?.owner?.aliId)?.owner?.aliId
        ?? "",
      );
      const messageId = (raw) => {
        const candidate =
          raw?.uuid
          ?? raw?.messageId
          ?? raw?.code?.messageId
          ?? raw?.message?.messageId
          ?? null;
        const text = String(candidate ?? "").trim().replace(/\.PNM$/i, "");
        return /^[0-9]+$/.test(text) ? text : "";
      };
      const conversationCode = (raw) =>
        String(raw?.cid ?? raw?.conversationCode ?? raw?.message?.conversationCode ?? "").trim();

      const conversationHandle = (cid) => "alichat:" + cid;
      const parseConversationHandle = (value) => {
        const text = String(value || "").trim();
        return text.startsWith("alichat:") ? text.slice("alichat:".length) : "";
      };
      const messageHandle = (cid, id) => "alimsg:" + cid + ":" + id;
      const parseMessageHandle = (value) => {
        const text = String(value || "").trim();
        if (!text.startsWith("alimsg:")) return null;
        const body = text.slice("alimsg:".length);
        const pos = body.lastIndexOf(":");
        if (pos <= 0) return null;
        const cid = body.slice(0, pos);
        const id = body.slice(pos + 1).replace(/\.PNM$/i, "");
        if (!cid || !/^[0-9]+$/.test(id)) return null;
        return { cid, id };
      };
      const providerMessageId = (id) => {
        const text = String(id || "").replace(/\.PNM$/i, "");
        return /^[0-9]+$/.test(text) ? text + ".PNM" : "";
      };

      const normalizeConversation = (raw) => {
        raw = enrichConversation(raw);
        const cid = conversationCode(raw);
        if (!cid) return null;
        const contact = raw?.contact || raw?.conversationContent?.contact || {};
        const latest =
          raw?.latestMessage
          || raw?.conversationContent?.lastMessageSummary
          || raw?.lastMessage
          || null;
        const latestId = messageId(latest?.message || latest);
        const latestText =
          latest?.content
          ?? latest?.message?.content
          ?? latest?.originalData?.text
          ?? latest?.message?.originalData?.text
          ?? "";
        const modified = Number(
          raw?.modifyTime
          ?? raw?.lastContactTime
          ?? latest?.gmtChatLong
          ?? latest?.gmtChat
          ?? latest?.sendTime
          ?? 0,
        );
        const unread = Number(
          raw?.unreadCount
          ?? raw?.conversationContent?.unReadNumber
          ?? raw?.redPoint
          ?? 0,
        );
        return {
          handle: conversationHandle(cid),
          cid,
          name: cleanText(raw?.name ?? contact?.name ?? raw?.title ?? ""),
          company_name: cleanText(raw?.companyName ?? contact?.companyName ?? ""),
          login_id: cleanText(raw?.loginId ?? contact?.loginId ?? ""),
          ali_id: cleanText(raw?.aliId ?? contact?.aliId ?? ""),
          unread_count: Number.isFinite(unread) && unread > 0 ? Math.floor(unread) : 0,
          has_unread: Number.isFinite(unread) && unread > 0,
          muted: Boolean(raw?.mute ?? raw?.conversationContent?.mute ?? false),
          pinned: Boolean(raw?.stayTop ?? raw?.conversationContent?.stayTop ?? false),
          visible: raw?.visible !== false,
          last_activity_ms: Number.isFinite(modified) && modified > 0 ? modified : null,
          last_message_handle: latestId ? messageHandle(cid, latestId) : null,
          last_message_text: cleanText(latestText).slice(0, 600) || null,
        };
      };

      const normalizeMessage = (raw, fallbackCid = "") => {
        if (!raw || typeof raw !== "object") return null;
        const cid = conversationCode(raw) || fallbackCid;
        const id = messageId(raw);
        if (!cid || !id) return null;
        const contact = raw?.contact || {};
        const owner = raw?.owner || {};
        const original = raw?.originalData || {};
        const textValue =
          original?.text
          ?? raw?.content?.text
          ?? (typeof raw?.content === "string" && !/<(?:img|video|audio)\b/i.test(raw.content)
            ? raw.content
            : "");
        const sendTime = Number(raw?.sendTime ?? raw?.createAt ?? raw?.gmtChatLong ?? raw?.gmtChat ?? 0);
        const type = String(raw?.messageType || "").toLowerCase();
        const conversationMeta = enrichConversation(
          cachedConversation(cid) || { cid },
        );
        const ownerAliId = String(
          owner?.aliId
          || conversationMeta?.owner?.aliId
          || ownAliId
          || "",
        );
        const senderId = String(
          raw?.sender?.targetId
          || raw?.originPaasMessageData?.message?.sender?.uid
          || "",
        ).split("@")[0];
        const outgoing =
          type === "send"
          || (ownerAliId && senderId && ownerAliId === senderId);
        const attachmentUrl =
          typeof original?.url === "string" ? original.url
          : typeof raw?.attachment?.url === "string" ? raw.attachment.url
          : null;
        const attachment = attachmentUrl ? {
          available: true,
          filename: cleanText(original?.fileName ?? original?.filename ?? original?.name ?? "") || null,
          suffix: cleanText(original?.suffix ?? "") || null,
          size_bytes: Number.isFinite(Number(original?.size ?? original?.fileSize))
            ? Number(original?.size ?? original?.fileSize)
            : null,
          width: Number.isFinite(Number(original?.width)) ? Number(original.width) : null,
          height: Number.isFinite(Number(original?.height)) ? Number(original.height) : null,
          file_id: cleanText(original?.fileId ?? "") || null,
        } : null;
        const referCandidates = [
          raw?.extInfo?.referMessage,
          raw?.referMessage,
          raw?.ext?.quoteMessage,
          raw?.localExt?.quoteMessage,
          raw?.originPaasMessageData?.message?.extension?.quoteMessage,
          raw?.originPaasMessageData?.message?.content?.text?.extension?.quoteMessage,
        ];
        let refer = referCandidates.find((value) =>
          value !== null && value !== undefined && value !== ""
        ) ?? null;
        if (typeof refer === "string") {
          try { refer = JSON.parse(refer); } catch { refer = null; }
        }
        const quotedId = String(refer?.messageId || "").replace(/\.PNM$/i, "");
        const quoted = /^[0-9]+$/.test(quotedId) ? {
          message_handle: messageHandle(cid, quotedId),
          provider_message_id: quotedId + ".PNM",
          text: cleanText(refer?.content ?? "") || null,
          sender_name: cleanText(refer?.senderName ?? "") || null,
          sender_ali_id: cleanText(refer?.senderAliId ?? "") || null,
          timestamp_ms: Number.isFinite(Number(refer?.sendTime)) && Number(refer.sendTime) > 0
            ? Number(refer.sendTime)
            : null,
          msg_type: Number.isFinite(Number(refer?.msgType)) ? Number(refer.msgType) : null,
          original_data: refer?.originalData && typeof refer.originalData === "object"
            ? {
                text: cleanText(refer.originalData?.text ?? "") || null,
                file_id: cleanText(refer.originalData?.fileId ?? "") || null,
                suffix: cleanText(refer.originalData?.suffix ?? "") || null,
                size_bytes: Number.isFinite(Number(refer.originalData?.size))
                  ? Number(refer.originalData.size)
                  : null,
              }
            : null,
        } : null;
        return {
          handle: messageHandle(cid, id),
          provider_message_id: id + ".PNM",
          conversation_handle: conversationHandle(cid),
          conversation_cid: cid,
          text: cleanText(textValue),
          timestamp_ms: Number.isFinite(sendTime) && sendTime > 0 ? sendTime : null,
          outgoing,
          direction: outgoing ? "outgoing" : "incoming",
          sender_name: cleanText(
            outgoing
              ? (owner?.name || conversationMeta?.owner?.name)
              : (contact?.name || conversationMeta?.contact?.name || conversationMeta?.name)
          ) || null,
          sender_ali_id: cleanText(
            outgoing
              ? (owner?.aliId || conversationMeta?.owner?.aliId || ownAliId)
              : (contact?.aliId || conversationMeta?.contact?.aliId || conversationMeta?.aliId)
          ) || null,
          read:
            raw?.contactRead === true
            || Number(raw?.readStatus ?? -1) === 2
            || Number(raw?.originPaasMessageData?.readStatus ?? -1) === 2,
          recalled: Number(raw?.status) === 2 || String(raw?.messageType || "").toLowerCase() === "revoke",
          msg_type: Number.isFinite(Number(raw?.msgType)) ? Number(raw.msgType) : null,
          sub_type: Number.isFinite(Number(raw?.subType)) ? Number(raw.subType) : null,
          attachment,
          quoted_message: quoted,
          quoted_message_handle: quoted?.message_handle || null,
        };
      };

      const listConversationPage = async (cursor, count) => {
        if (typeof conversationService.getConversationListByPagination !== "function") {
          fail("ALIBABA_CONVERSATION_REMOTE_READ_UNAVAILABLE");
        }
        const value = await conversationService.getConversationListByPagination({
          cursor,
          count,
        });
        return {
          list: Array.isArray(value?.list) ? value.list : [],
          hasMore: value?.hasMore === true,
          nextCursor: Number(value?.nextCursor || 0),
        };
      };

      const listConversations = async (wanted, maxPages = 1) => {
        const out = [];
        const seen = new Set();
        let cursor = Date.now() + 86400000;
        for (let pageIndex = 0; pageIndex < maxPages && out.length < wanted; pageIndex += 1) {
          const pageValue = await listConversationPage(cursor, Math.min(100, Math.max(20, wanted)));
          for (const raw of pageValue.list) {
            const cid = conversationCode(raw);
            if (!cid || seen.has(cid)) continue;
            seen.add(cid);
            out.push(raw);
            if (out.length >= wanted) break;
          }
          if (!pageValue.hasMore || !Number.isFinite(pageValue.nextCursor) || pageValue.nextCursor <= 0) break;
          cursor = pageValue.nextCursor;
        }
        return out;
      };

      const resolveConversation = async (reference) => {
        const ref = String(reference || "").trim();
        if (!ref) fail("ALIBABA_CONVERSATION_REQUIRED");
        const direct = parseConversationHandle(ref);
        if (direct) {
          const list = await listConversations(500, 5);
          const raw = list.find((item) => conversationCode(item) === direct);
          if (!raw) fail("ALIBABA_CONVERSATION_NOT_FOUND");
          return raw;
        }
        const wanted = ref.toLocaleLowerCase();
        const list = await listConversations(500, 5);
        const matches = list.filter((item) => {
          const contact = item?.contact || {};
          const values = [
            item?.name,
            contact?.name,
            item?.companyName,
            contact?.companyName,
            item?.loginId,
            contact?.loginId,
            item?.aliId,
            contact?.aliId,
          ].map((value) => cleanText(value).toLocaleLowerCase()).filter(Boolean);
          return values.some((value) => value === wanted);
        });
        if (matches.length === 1) return matches[0];
        if (matches.length > 1) fail("ALIBABA_CONVERSATION_AMBIGUOUS");
        fail("ALIBABA_CONVERSATION_NOT_FOUND");
      };

      const history = async (cid, { beforeMs = null, count = 20 } = {}) => {
        if (typeof messageServiceV2.listMessageWithConversationCodeForHistory !== "function") {
          fail("ALIBABA_MESSAGE_REMOTE_READ_UNAVAILABLE");
        }
        return await new Promise((resolve, reject) => {
          let settled = false;
          const done = (error, value) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (error) reject(error);
            else resolve(value);
          };
          const timer = setTimeout(() => done(new Error("ALIBABA_MESSAGE_READ_TIMEOUT")), 9000);
          try {
            messageServiceV2.listMessageWithConversationCodeForHistory({
              cursor: Number.isFinite(beforeMs) && beforeMs > 0 ? { sendTime: beforeMs } : null,
              fetchType: 1,
              conversationCode: cid,
              count,
              dataCallback: (value) => done(null, {
                data: Array.isArray(value?.data) ? value.data : [],
                hasMore: value?.hasMore === true,
              }),
              errorCallBack: () => done(new Error("ALIBABA_MESSAGE_REMOTE_READ_FAILED")),
            });
          } catch (error) {
            done(error);
          }
        });
      };

      const exactMessage = async (cid, id) => {
        const recent = await history(cid, { count: 100 });
        let raw = recent.data.find((item) => messageId(item) === id);
        if (raw) return raw;
        if (typeof messageServiceV2.listMessageWithMessageCode !== "function") {
          fail("ALIBABA_MESSAGE_NOT_FOUND");
        }
        raw = await new Promise((resolve, reject) => {
          let settled = false;
          const done = (error, value) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (error) reject(error);
            else resolve(value);
          };
          const timer = setTimeout(() => done(new Error("ALIBABA_MESSAGE_READ_TIMEOUT")), 9000);
          try {
            messageServiceV2.listMessageWithMessageCode({
              msgLocate: [{ msgCode: { messageId: providerMessageId(id) } }],
              dataCallback: (value) => done(null, Array.isArray(value?.data) ? value.data[0] : null),
              errorCallBack: () => done(new Error("ALIBABA_MESSAGE_REMOTE_READ_FAILED")),
            });
          } catch (error) {
            done(error);
          }
        });
        if (!raw || conversationCode(raw) !== cid) fail("ALIBABA_MESSAGE_NOT_FOUND");
        return raw;
      };

      const resolveMessage = async (input) => {
        const parsed = parseMessageHandle(input?.message_handle);
        if (parsed) {
          const raw = await exactMessage(parsed.cid, parsed.id);
          return { cid: parsed.cid, id: parsed.id, raw };
        }
        if (input?.latest_message === true && input?.conversation) {
          const conversation = await resolveConversation(input.conversation);
          const cid = conversationCode(conversation);
          const value = await history(cid, { count: 1 });
          const raw = value.data.slice().sort((a, b) =>
            Number(b?.sendTime || b?.createAt || 0) - Number(a?.sendTime || a?.createAt || 0)
          )[0];
          const id = messageId(raw);
          if (!raw || !id) fail("ALIBABA_MESSAGE_NOT_FOUND");
          return { cid, id, raw };
        }
        fail("ALIBABA_MESSAGE_REFERENCE_REQUIRED");
      };

      const freshConversation = async (cid) => {
        const list = await listConversations(500, 5);
        return list.find((item) => conversationCode(item) === cid) || null;
      };

      if (op === "api_probe") {
        const connected = Number(authService?.connectionStatus ?? -1);
        const loggedIn = typeof authService?.isLogin === "function"
          ? Boolean(authService.isLogin())
          : null;
        const sample = await listConversationPage(Date.now() + 86400000, 1);
        return {
          state: "ACHIEVED",
          provider_fresh: true,
          sdk_present: true,
          connection_status: connected,
          logged_in: loggedIn,
          conversation_probe_count: sample.list.length,
        };
      }

      if (op === "conversation_list") {
        const limit = Math.min(50, Math.max(1, Number(args.limit || 50)));
        const raw = await listConversations(limit, 2);
        const conversations = raw.map(normalizeConversation).filter(Boolean).slice(0, limit);
        return {
          state: "ACHIEVED",
          provider_fresh: true,
          count: conversations.length,
          conversations,
          bounded: true,
        };
      }

      if (op === "unread_list") {
        const limit = Math.min(50, Math.max(1, Number(args.limit || 50)));
        if (typeof conversationService.getUnreadConversationList !== "function") {
          fail("ALIBABA_UNREAD_REMOTE_READ_UNAVAILABLE");
        }
        const raw = await conversationService.getUnreadConversationList(Math.max(limit, 50), 0);
        const conversations = (Array.isArray(raw) ? raw : [])
          .map(normalizeConversation)
          .filter((item) => item && item.has_unread)
          .slice(0, limit);
        return {
          state: "ACHIEVED",
          provider_fresh: true,
          count: conversations.length,
          conversations,
          bounded: true,
        };
      }

      if (op === "conversation_search") {
        const query = cleanText(args.query).toLocaleLowerCase();
        if (!query) fail("ALIBABA_SEARCH_QUERY_REQUIRED");
        const limit = Math.min(50, Math.max(1, Number(args.limit || 20)));
        const raw = await listConversations(500, 5);
        const conversations = raw.map(normalizeConversation).filter(Boolean).filter((item) =>
          [item.name, item.company_name, item.login_id, item.ali_id, item.cid]
            .filter(Boolean)
            .some((value) => String(value).toLocaleLowerCase().includes(query))
        ).slice(0, limit);
        return {
          state: "ACHIEVED",
          provider_fresh: true,
          query: args.query,
          count: conversations.length,
          conversations,
          bounded: true,
        };
      }

      if (op === "contact_search") {
        const query = cleanText(args.query).toLocaleLowerCase();
        if (!query) fail("ALIBABA_SEARCH_QUERY_REQUIRED");
        const limit = Math.min(50, Math.max(1, Number(args.limit || 20)));
        if (!contactService || typeof contactService.listAllContacts !== "function") {
          fail("ALIBABA_CONTACT_SERVICE_UNAVAILABLE");
        }
        const raw = contactService.listAllContacts();
        const values = Array.isArray(raw) ? raw : [];
        const contacts = values.filter((item) => {
          const fields = [
            item?.name,
            item?.companyName,
            item?.loginId,
            item?.aliId,
          ].map((value) => cleanText(value).toLocaleLowerCase()).filter(Boolean);
          return fields.some((value) => value.includes(query));
        }).slice(0, limit).map((item) => ({
          ali_id: cleanText(item?.aliId) || null,
          name: cleanText(item?.name) || null,
          company_name: cleanText(item?.companyName) || null,
          login_id: cleanText(item?.loginId) || null,
          country_code: cleanText(item?.complianceCountryCode) || null,
        }));
        return {
          state: "ACHIEVED",
          provider_fresh: false,
          source: "authenticated_provider_session_contact_map",
          query: args.query,
          count: contacts.length,
          contacts,
          bounded: true,
        };
      }

      if (op === "message_list") {
        const conversation = await resolveConversation(args.conversation);
        const cid = conversationCode(conversation);
        const limit = Math.min(100, Math.max(1, Number(args.limit || 20)));
        let beforeMs = null;
        if (args.before_message_handle) {
          const parsed = parseMessageHandle(args.before_message_handle);
          if (!parsed || parsed.cid !== cid) fail("ALIBABA_MESSAGE_CURSOR_CONVERSATION_MISMATCH");
          const anchor = await exactMessage(cid, parsed.id);
          beforeMs = Number(anchor?.sendTime ?? anchor?.createAt ?? 0);
          if (!Number.isFinite(beforeMs) || beforeMs <= 0) fail("ALIBABA_MESSAGE_CURSOR_INVALID");
        }
        const value = await history(cid, { beforeMs, count: limit });
        const messages = value.data
          .map((item) => normalizeMessage(item, cid))
          .filter(Boolean)
          .sort((a, b) => Number(b.timestamp_ms || 0) - Number(a.timestamp_ms || 0))
          .slice(0, limit);
        return {
          state: "ACHIEVED",
          provider_fresh: true,
          conversation_handle: conversationHandle(cid),
          count: messages.length,
          messages,
          has_more: value.hasMore,
          bounded: true,
        };
      }

      if (op === "message_get") {
        const value = await resolveMessage(args);
        return {
          state: "ACHIEVED",
          provider_fresh: true,
          message: normalizeMessage(value.raw, value.cid),
        };
      }

      if (op === "message_replies") {
        const source = await resolveMessage(args);
        const sourceMessage = normalizeMessage(source.raw, source.cid);
        const limit = Math.min(100, Math.max(1, Number(args.limit || 50)));
        const maxScan = Math.min(1000, Math.max(100, Number(args.max_scan || 500)));
        const wantedProviderId = providerMessageId(source.id);
        const replies = [];
        const seen = new Set();
        let beforeMs = null;
        let scanned = 0;
        let hasMore = true;
        while (hasMore && scanned < maxScan && replies.length < limit) {
          const count = Math.min(100, maxScan - scanned);
          const value = await history(source.cid, { beforeMs, count });
          if (!Array.isArray(value.data) || value.data.length === 0) break;
          scanned += value.data.length;
          let oldest = null;
          for (const raw of value.data) {
            const normalized = normalizeMessage(raw, source.cid);
            if (!normalized) continue;
            const id = normalized.provider_message_id;
            if (id && !seen.has(id)) {
              seen.add(id);
              if (normalized.quoted_message?.provider_message_id === wantedProviderId) {
                replies.push(normalized);
                if (replies.length >= limit) break;
              }
            }
            const ts = Number(normalized.timestamp_ms || 0);
            if (ts > 0 && (oldest === null || ts < oldest)) oldest = ts;
          }
          hasMore = value.hasMore === true;
          if (!hasMore || !Number.isFinite(oldest) || oldest <= 0) break;
          const sourceTs = Number(sourceMessage?.timestamp_ms || 0);
          if (sourceTs > 0 && oldest <= sourceTs) break;
          beforeMs = oldest - 1;
        }
        replies.sort((a, b) => Number(a.timestamp_ms || 0) - Number(b.timestamp_ms || 0));
        return {
          state: "ACHIEVED",
          provider_fresh: true,
          semantics: "direct_quoted_replies_in_conversation",
          native_thread: false,
          source_message: sourceMessage,
          count: replies.length,
          replies,
          scanned_messages: scanned,
          scan_limit: maxScan,
          bounded: true,
        };
      }

      if (op === "message_search") {
        const query = cleanText(args.query);
        if (!query) fail("ALIBABA_SEARCH_QUERY_REQUIRED");
        const limit = Math.min(50, Math.max(1, Number(args.limit || 20)));
        let cid = null;
        if (args.conversation) {
          cid = conversationCode(await resolveConversation(args.conversation));
        }
        if (typeof messageServiceV2.searchRemoteMessage !== "function") {
          fail("ALIBABA_MESSAGE_SEARCH_UNAVAILABLE");
        }
        const value = await messageServiceV2.searchRemoteMessage({
          query,
          cids: cid ? [cid] : undefined,
          offset: "0",
          size: limit,
        });
        const messages = (Array.isArray(value?.messages) ? value.messages : [])
          .map((item) => normalizeMessage(item, cid || conversationCode(item)))
          .filter(Boolean)
          .slice(0, limit);
        return {
          state: "ACHIEVED",
          provider_fresh: true,
          query,
          count: messages.length,
          messages,
          has_more: value?.hasMore === true,
          next_cursor: value?.nextCursor ?? null,
          bounded: true,
        };
      }

      if (op === "attachment_prepare") {
        const source = await resolveMessage(args);
        const raw = source.raw;
        const original = raw?.originalData || {};
        const providerUrl =
          typeof original?.url === "string" ? original.url.trim()
          : typeof raw?.attachment?.url === "string" ? raw.attachment.url.trim()
          : "";
        if (!providerUrl) fail("ALIBABA_ATTACHMENT_NOT_AVAILABLE");
        let parsedUrl;
        try { parsedUrl = new URL(providerUrl); }
        catch { fail("ALIBABA_ATTACHMENT_URL_INVALID"); }
        const host = parsedUrl.hostname.toLowerCase();
        const providerHost =
          host === "clouddisk.alibaba.com"
          || host.endsWith(".alibaba.com")
          || host.endsWith(".alicdn.com")
          || host.endsWith(".aliyuncs.com");
        if (parsedUrl.protocol !== "https:" || !providerHost) {
          fail("ALIBABA_ATTACHMENT_URL_UNTRUSTED");
        }
        const normalized = normalizeMessage(raw, source.cid);
        const suffix = cleanText(original?.suffix ?? original?.fileType ?? "").replace(/^\./, "");
        const fallbackName =
          cleanText(original?.fileId ?? "")
          || ("alibaba-attachment" + (suffix ? "." + suffix : ""));
        return {
          state: "ACHIEVED",
          provider_fresh: true,
          message: normalized,
          provider_url: providerUrl,
          filename:
            cleanText(original?.fileName ?? original?.filename ?? original?.name ?? "")
            || fallbackName,
          media_type: cleanText(original?.mimeType ?? "") || null,
          size_bytes: Number.isFinite(Number(original?.size ?? original?.fileSize))
            ? Number(original?.size ?? original?.fileSize)
            : null,
        };
      }

      if (op === "send") {
        const conversation = await resolveConversation(args.target);
        const cid = conversationCode(conversation);
        const text = String(args.text || "");
        if (!text) fail("ALIBABA_TEXT_REQUIRED");
        if (typeof messageServiceV1?.sendUIMessages !== "function") {
          fail("ALIBABA_SEND_UNAVAILABLE");
        }
        const before = await history(cid, { count: 50 });
        const priorIds = new Set(before.data.map(messageId).filter(Boolean));
        const startedAt = Date.now();
        let sendResult = null;
        let acknowledged = false;
        try {
          sendResult = await messageServiceV1.sendUIMessages({
            cid,
            content: text,
            msgType: 1,
            ext: { chatScene: JSON.stringify({ clientInfo: "web" }) },
          });
          acknowledged = true;
        } catch (error) {
          sendResult = { error: String(error?.message || error || "send_failed").slice(0, 240) };
        }

        let confirmed = null;
        for (let attempt = 0; attempt < 6 && !confirmed; attempt += 1) {
          await wait(attempt === 0 ? 500 : 800);
          try {
            const observed = await history(cid, { count: 60 });
            confirmed = observed.data.find((item) => {
              const id = messageId(item);
              const normalized = normalizeMessage(item, cid);
              return id
                && !priorIds.has(id)
                && normalized?.outgoing === true
                && normalized?.text === cleanText(text)
                && Number(normalized?.timestamp_ms || 0) >= startedAt - 3000;
            }) || null;
          } catch {}
        }
        if (!confirmed) {
          return {
            state: "IN_DOUBT",
            provider: "alibaba",
            realization: "provider-sdk",
            effect_attempted: true,
            acknowledged,
            provider_confirmed: false,
            blind_retry_allowed: false,
            conversation_handle: conversationHandle(cid),
          };
        }
        return {
          state: "ACHIEVED",
          provider: "alibaba",
          realization: "provider-sdk",
          effect_attempted: true,
          acknowledged,
          provider_confirmed: true,
          provider_fresh: true,
          verification_source: "remote_message_history",
          conversation_handle: conversationHandle(cid),
          message: normalizeMessage(confirmed, cid),
        };
      }

      if (op === "reply") {
        const source = await resolveMessage(args);
        const cid = source.cid;
        const text = String(args.text || "");
        if (!text) fail("ALIBABA_TEXT_REQUIRED");
        if (typeof messageServiceV2?.sendUIMessages !== "function") {
          fail("ALIBABA_REPLY_UNAVAILABLE");
        }
        const sourceMessage = normalizeMessage(source.raw, cid);
        const sourceRawMsgType = Number(source.raw?.msgType);
        if (sourceRawMsgType !== 101) {
          fail("ALIBABA_REPLY_SOURCE_TYPE_UNQUALIFIED");
        }
        const sourceConversation = enrichConversation(cachedConversation(cid) || { cid });
        const sourceSenderAliId = cleanText(
          source.raw?.sender?.targetId
          || source.raw?.originPaasMessageData?.message?.sender?.uid
          || sourceMessage?.sender_ali_id
          || "",
        ).split("@")[0];
        const sourceReceiverAliId = sourceMessage?.outgoing === true
          ? cleanText(sourceConversation?.contact?.aliId || cid.split("-")[0] || "")
          : cleanText(sourceConversation?.owner?.aliId || ownAliId || "");
        const sourceOriginal = source.raw?.originalData && typeof source.raw.originalData === "object"
          ? source.raw.originalData
          : {};
        const sourceText =
          sourceMessage?.text
          || (sourceMessage?.attachment ? "[Attachment]" : "[Message]");
        const referMessage = {
          msgId: providerMessageId(source.id),
          contentDisplay: sourceText,
          msgType: sourceRawMsgType,
          subType: 1,
          senderAliId: sourceSenderAliId,
          receiverAliId: sourceReceiverAliId,
          contentAbstract: sourceText,
          originalData: sourceOriginal,
          senderName: sourceMessage?.sender_name || "",
          sendTime: Number(sourceMessage?.timestamp_ms || 0),
        };
        const before = await history(cid, { count: 60 });
        const priorIds = new Set(before.data.map(messageId).filter(Boolean));
        const startedAt = Date.now();
        let acknowledged = false;
        try {
          await messageServiceV2.sendUIMessages({
            cid,
            content: text,
            msgType: 1,
            referMessage,
            ext: { chatScene: JSON.stringify({ clientInfo: "web" }) },
          });
          acknowledged = true;
        } catch {}

        let confirmed = null;
        for (let attempt = 0; attempt < 6 && !confirmed; attempt += 1) {
          await wait(attempt === 0 ? 500 : 800);
          try {
            const observed = await history(cid, { count: 80 });
            confirmed = observed.data.find((item) => {
              const id = messageId(item);
              const normalized = normalizeMessage(item, cid);
              return id
                && !priorIds.has(id)
                && normalized?.outgoing === true
                && normalized?.text === cleanText(text)
                && normalized?.quoted_message?.provider_message_id === providerMessageId(source.id)
                && Number(normalized?.timestamp_ms || 0) >= startedAt - 3000;
            }) || null;
          } catch {}
        }
        if (!confirmed) {
          return {
            state: "IN_DOUBT",
            provider: "alibaba",
            realization: "provider-sdk",
            effect_attempted: true,
            acknowledged,
            provider_confirmed: false,
            blind_retry_allowed: false,
            conversation_handle: conversationHandle(cid),
            replied_to: sourceMessage,
          };
        }
        return {
          state: "ACHIEVED",
          provider: "alibaba",
          realization: "provider-sdk",
          effect_attempted: true,
          acknowledged,
          provider_confirmed: true,
          provider_fresh: true,
          verification_source: "remote_message_history_quote_relation",
          conversation_handle: conversationHandle(cid),
          replied_to: sourceMessage,
          message: normalizeMessage(confirmed, cid),
        };
      }

      if (op === "delete") {
        if (args.confirm_irreversible !== true) fail("ALIBABA_DELETE_CONFIRMATION_REQUIRED");
        const parsed = parseMessageHandle(args.message_handle);
        if (!parsed) fail("ALIBABA_DELETE_EXACT_MESSAGE_REQUIRED");
        const raw = await exactMessage(parsed.cid, parsed.id);
        const original = normalizeMessage(raw, parsed.cid);
        const forEveryone = args.for_everyone === true;
        let acknowledged = false;

        if (forEveryone) {
          if (original?.outgoing !== true) fail("ALIBABA_RECALL_OUTGOING_REQUIRED");
          if (typeof messageServiceV2?.recallMessage !== "function") {
            fail("ALIBABA_RECALL_UNAVAILABLE");
          }
          const sendTime = Number(original?.timestamp_ms || 0);
          if (!Number.isFinite(sendTime) || sendTime <= 0) {
            fail("ALIBABA_RECALL_SEND_TIME_REQUIRED");
          }
          if (Date.now() - sendTime > 120000) {
            fail("ALIBABA_RECALL_WINDOW_EXPIRED");
          }
          const conversation = enrichConversation(cachedConversation(parsed.cid) || { cid: parsed.cid });
          const recallParams = {
            fromAccountIdEncrypt: cleanText(conversation?.owner?.accountIdEncrypt || ""),
            toAccountIdEncrypt: cleanText(conversation?.contact?.accountIdEncrypt || ""),
            uuid: parsed.id,
            sendTime,
          };
          try {
            await messageServiceV2.recallMessage(recallParams);
            acknowledged = true;
          } catch {}
        } else {
          await new Promise((resolve, reject) => {
            let settled = false;
            const done = (error) => {
              if (settled) return;
              settled = true;
              clearTimeout(timer);
              if (error) reject(error);
              else resolve();
            };
            const timer = setTimeout(() => done(new Error("ALIBABA_DELETE_ACK_TIMEOUT")), 5000);
            try {
              if (typeof messageServiceV1?.deleteMessage !== "function") {
                done(new Error("ALIBABA_DELETE_UNAVAILABLE"));
                return;
              }
              messageServiceV1.deleteMessage({
                messages: [raw],
                dataCallback: () => {
                  acknowledged = true;
                  done(null);
                },
              });
            } catch (error) {
              done(error);
            }
          }).catch(() => {});
        }

        let confirmed = false;
        let observed = null;
        for (let attempt = 0; attempt < 6 && !confirmed; attempt += 1) {
          await wait(attempt === 0 ? 500 : 800);
          try {
            const fresh = await history(parsed.cid, { count: 100 });
            const found = fresh.data.find((item) => messageId(item) === parsed.id) || null;
            if (forEveryone) {
              observed = found ? normalizeMessage(found, parsed.cid) : null;
              confirmed = !found || observed?.recalled === true;
            } else {
              confirmed = !found;
              observed = found ? normalizeMessage(found, parsed.cid) : null;
            }
          } catch {}
        }

        return {
          state: confirmed ? "ACHIEVED" : "IN_DOUBT",
          provider: "alibaba",
          realization: "provider-sdk",
          effect_attempted: true,
          acknowledged,
          provider_confirmed: confirmed,
          provider_fresh: confirmed,
          blind_retry_allowed: false,
          for_everyone: forEveryone,
          deleted_message: original,
          observed_postcondition: observed,
        };
      }

      if (op === "mark_read") {
        const conversation = await resolveConversation(args.conversation);
        const cid = conversationCode(conversation);
        const recent = await history(cid, { count: 100 });
        if (typeof messageServiceV1?.updateMessageToRead !== "function") {
          fail("ALIBABA_MARK_READ_UNAVAILABLE");
        }
        await messageServiceV1.updateMessageToRead(cid, recent.data);
        await wait(500);
        const observed = await freshConversation(cid);
        const normalized = normalizeConversation(observed);
        const confirmed = Boolean(normalized && normalized.unread_count === 0);
        return {
          state: confirmed ? "ACHIEVED" : "IN_DOUBT",
          provider: "alibaba",
          effect_attempted: true,
          provider_confirmed: confirmed,
          provider_fresh: confirmed,
          blind_retry_allowed: confirmed,
          conversation: normalized,
        };
      }

      if (op === "mute" || op === "pin") {
        const conversation = await resolveConversation(args.conversation);
        const cid = conversationCode(conversation);
        const desired = op === "mute" ? args.muted === true : args.pinned === true;
        const method = op === "mute" ? "conversationMute" : "conversationSetTop";
        if (typeof conversationService[method] !== "function") {
          fail(op === "mute" ? "ALIBABA_MUTE_UNAVAILABLE" : "ALIBABA_PIN_UNAVAILABLE");
        }
        await conversationService[method]({ list: [conversation] }, desired);
        await wait(500);
        const observed = normalizeConversation(await freshConversation(cid));
        const actual = op === "mute" ? observed?.muted : observed?.pinned;
        const confirmed = actual === desired;
        return {
          state: confirmed ? "ACHIEVED" : "IN_DOUBT",
          provider: "alibaba",
          effect_attempted: true,
          provider_confirmed: confirmed,
          provider_fresh: confirmed,
          blind_retry_allowed: confirmed,
          desired,
          conversation: observed,
        };
      }

      fail("ALIBABA_OPERATION_UNSUPPORTED");
    }, { op, args });
  } catch (cause) {
    if (cause?.code) throw cause;
    const text = String(cause?.message || cause || "");
    const match = text.match(/ALIBABA_[A-Z0-9_]+/);
    if (match) throw codedError(match[0]);
    const error = codedError("ALIBABA_OPERATION_FAILED", "Alibaba operation failed.");
    error.cause = cause;
    throw error;
  }
}

const CAPABILITIES = [
  ["alibaba_api_probe", "read", "Verify the authenticated Alibaba message-center runtime and provider SDK with a fresh conversation RPC.", "SUPPORTED"],
  ["alibaba_conversation_list", "read", "List recent Alibaba conversations from provider-backed pagination without opening chats.", "SUPPORTED"],
  ["alibaba_capability_list", "read", "Describe the Alibaba connector surface and verification strength.", "SUPPORTED"],
  ["alibaba_capability_gaps", "read", "Report explicit Telegram-parity gaps instead of inventing unsupported Alibaba semantics.", "SUPPORTED"],
  ["alibaba_unread_list", "read", "List unread Alibaba conversations using the provider conversation service.", "SUPPORTED"],
  ["alibaba_conversation_search", "read", "Search bounded provider-backed Alibaba conversations by name, company, login id, Ali id, or conversation id.", "SUPPORTED"],
  ["alibaba_contact_search", "read", "Search contacts known to the authenticated Alibaba provider session.", "SUPPORTED_SESSION_MAP"],
  ["alibaba_message_list", "read", "Read bounded provider-fresh Alibaba message history without opening the conversation.", "SUPPORTED"],
  ["alibaba_message_get", "read", "Read one exact provider message or the explicitly latest message.", "SUPPORTED"],
  ["alibaba_message_replies", "read", "Read direct Alibaba quoted replies to one exact message from bounded provider-fresh conversation history. This does not claim a Telegram-style native thread.", "SUPPORTED_PENDING_LIVE_REQUALIFICATION"],
  ["alibaba_message_search", "read", "Search Alibaba remote message history globally or inside one conversation.", "SUPPORTED"],
  ["alibaba_screenshot", "read", "Capture the current Alibaba Message Center viewport without navigation.", "SUPPORTED"],
  ["alibaba_attachment_get", "read", "Acquire one exact Alibaba CloudDisk/message attachment through the shared material plane and return an expiring local download path.", "SUPPORTED_AND_PROVIDER_VERIFIED"],
  ["alibaba_file_upload", "write", "Create, inspect, or delete a resumable Alibaba material upload ticket on the shared 2 GiB transport plane.", "SUPPORTED_TRANSPORT"],
  ["alibaba_file_upload_chunk", "write", "Append one bounded resumable chunk to an Alibaba material upload ticket.", "SUPPORTED_TRANSPORT"],
  ["alibaba_send", "write", "Send one text message through the Alibaba provider SDK and verify it from fresh remote history.", "SUPPORTED_AND_PROVIDER_VERIFIED"],
  ["alibaba_reply", "write", "Send a provider-native quoted reply to a qualified text source and verify the exact quote relation from fresh remote history.", "SUPPORTED_PENDING_LIVE_REQUALIFICATION"],
  ["alibaba_delete", "write", "Delete one exact message locally or recall an eligible recent outgoing message for everyone; explicit irreversible confirmation is mandatory and success requires a fresh provider postcondition.", "SUPPORTED_PENDING_LIVE_REQUALIFICATION"],
  ["alibaba_mark_read", "write", "Mark unread received messages in one conversation read and verify the provider conversation state.", "SUPPORTED"],
  ["alibaba_mute", "write", "Set one Alibaba conversation mute state and verify the provider conversation state.", "SUPPORTED"],
  ["alibaba_pin", "write", "Set one Alibaba conversation top/pin state and verify the provider conversation state.", "SUPPORTED"],
];

const GAPS = [
  {
    operation: "alibaba_reactions",
    state: "NO_PROVIDER_PRIMITIVE_DISCOVERED",
    reason: "No Alibaba message reaction primitive has been found in the authenticated Web SDK. Telegram reaction semantics are not being invented.",
  },
  {
    operation: "alibaba_forward",
    state: "NO_PROVIDER_PRIMITIVE_DISCOVERED",
    reason: "No qualified native forward primitive has been found in the Alibaba Web SDK.",
  },
  {
    operation: "alibaba_image_resend",
    state: "NO_VERIFIED_WEB_RUNTIME_EFFECT",
    reason: "Alibaba Web sendImageMessage accepted both the authenticated CloudDisk redirect URL and its session-resolved signed Alicdn URL but fresh remote provider history showed no new image. The connector therefore does not expose an image-resend write path.",
  },
  {
    operation: "alibaba_reply_non_text_source",
    state: "UNQUALIFIED_SOURCE_TYPE",
    reason: "Provider-native quote relation is live-qualified for text source messages. Non-text source quote subtype mapping is not yet proven and fails closed.",
  },
  {
    operation: "alibaba_edit",
    state: "NO_PROVIDER_PRIMITIVE_DISCOVERED",
    reason: "No qualified provider message-edit primitive has been found.",
  },
  {
    operation: "alibaba_mark_unread",
    state: "NO_PROVIDER_PRIMITIVE_DISCOVERED",
    reason: "The provider exposes read-state mutation, but no manual mark-unread primitive has been qualified.",
  },
  {
    operation: "alibaba_material_transport_limit",
    state: "OPEN_CONNECTOR_LIMIT",
    reason: "The shared resumable material plane currently accepts up to 2 GiB. This is a connector transport bound, not a claimed Alibaba provider limit; if Alibaba permits larger material, owner acceptance or a wider plane is required before treating 2 GiB as final.",
  },
  {
    operation: "alibaba_file_send",
    state: "PARTIAL_PROVIDER_PRIMITIVE",
    reason: "The SDK exposes image/photo send primitives, but arbitrary document transport has not yet been qualified.",
  },
  {
    operation: "alibaba_voice_send_file",
    state: "NO_PROVIDER_PRIMITIVE_DISCOVERED",
    reason: "No provider-native Alibaba voice-message send primitive has been qualified.",
  },
  {
    operation: "alibaba_transcribe",
    state: "NOT_NEEDED_AS_PROVIDER_PRIMITIVE",
    reason: "Transcription is provider-independent and can reuse the shared audio pipeline once Alibaba attachment acquisition is integrated.",
  },
];

export function registerAlibabaConversationTool(
  server,
  z,
  {
    cdpUrl = DEFAULT_CDP_URL,
    statusUrl = DEFAULT_STATUS_URL,
    materialUpload = null,
    stageMaterialDownload = null,
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
      throw codedError("ALIBABA_MATERIAL_UPLOAD_UNAVAILABLE");
    }
    return materialUpload;
  };

  const stageAttachmentDownload = async (input) => {
    const upload = requireMaterialUpload();
    if (typeof stageMaterialDownload !== "function") {
      throw codedError("ALIBABA_ATTACHMENT_DOWNLOAD_STAGING_UNAVAILABLE");
    }
    const prepared = await runAlibabaCore("attachment_prepare", input, { cdpUrl, statusUrl });
    const sizeHint = Number(prepared?.size_bytes || 0);
    if (Number.isFinite(sizeHint) && sizeHint > ALIBABA_MATERIAL_TRANSPORT_MAX_BYTES) {
      throw codedError("ALIBABA_MATERIAL_TRANSPORT_LIMIT");
    }
    const page = await alibabaPage(cdpUrl, statusUrl);
    const cookies = await page.context().cookies(prepared.provider_url);
    const cookieHeader = cookies
      .map((item) => item.name + "=" + item.value)
      .join("; ");
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 12 * 60 * 1000);
    let created = null;
    try {
      const response = await fetch(prepared.provider_url, {
        method: "GET",
        redirect: "follow",
        signal: abort.signal,
        headers: {
          ...(cookieHeader ? { cookie: cookieHeader } : {}),
          referer: page.url(),
          "user-agent": await page.evaluate(() => navigator.userAgent),
        },
      });
      if (!response.ok || !response.body) {
        throw codedError("ALIBABA_ATTACHMENT_DOWNLOAD_FAILED");
      }
      const declared = Number(response.headers.get("content-length"));
      const expected =
        Number.isSafeInteger(declared) && declared > 0
          ? declared
          : (Number.isSafeInteger(sizeHint) && sizeHint > 0 ? sizeHint : 0);
      if (!Number.isSafeInteger(expected) || expected < 1) {
        throw codedError("ALIBABA_ATTACHMENT_SIZE_UNKNOWN");
      }
      if (expected > ALIBABA_MATERIAL_TRANSPORT_MAX_BYTES) {
        throw codedError("ALIBABA_MATERIAL_TRANSPORT_LIMIT");
      }
      const mediaType =
        String(response.headers.get("content-type") || "").split(";")[0].trim().toLowerCase()
        || prepared.media_type
        || "application/octet-stream";
      const rawName = String(prepared.filename || "alibaba-attachment").trim();
      const filename = rawName.replace(/[\\/\u0000-\u001f\u007f]/g, "_").slice(0, 128)
        || "alibaba-attachment";
      created = upload.create({
        filename,
        media_type: mediaType,
        size_bytes: expected,
        sha256_hex: null,
      });
      let offset = 0;
      let carry = Buffer.alloc(0);
      for await (const incoming of response.body) {
        const bytes = Buffer.from(incoming);
        carry = carry.length ? Buffer.concat([carry, bytes]) : bytes;
        while (carry.length >= ALIBABA_TRANSFER_CHUNK_BYTES) {
          const chunk = carry.subarray(0, ALIBABA_TRANSFER_CHUNK_BYTES);
          const appended = await upload.append(created.upload_id, offset, {
            data_base64: chunk.toString("base64"),
          });
          offset = Number(appended.offset);
          carry = carry.subarray(ALIBABA_TRANSFER_CHUNK_BYTES);
        }
      }
      if (carry.length) {
        const appended = await upload.append(created.upload_id, offset, {
          data_base64: carry.toString("base64"),
        });
        offset = Number(appended.offset);
      }
      if (offset !== expected) throw codedError("ALIBABA_ATTACHMENT_SIZE_MISMATCH");
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
      clearTimeout(timer);
    }
  };

  const invoke = async (op, args, fallback) => {
    try {
      const value = await runAlibabaCore(op, args, { cdpUrl, statusUrl });
      return result({
        provider: "alibaba",
        realization: "provider-sdk",
        ...value,
      });
    } catch (error) {
      return failure(error, fallback);
    }
  };

  server.registerTool("alibaba_api_probe", {
    title: "Probe Alibaba provider runtime",
    description: "Verify the authenticated Alibaba Message Center runtime and provider SDK using a bounded provider-backed conversation read.",
    inputSchema: {},
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async () => invoke("api_probe", {}, "ALIBABA_API_PROBE_FAILED"));

  server.registerTool("alibaba_conversation_list", {
    title: "List recent Alibaba conversations",
    description: "Read recent Alibaba Message Center conversations from provider-backed pagination without opening chats or intentionally changing read state.",
    inputSchema: {
      limit: z.number().int().min(1).max(50).optional(),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ limit = 50 }) =>
    invoke("conversation_list", { limit }, "ALIBABA_CONVERSATION_LIST_FAILED"));

  server.registerTool("alibaba_capability_list", {
    title: "List Alibaba capabilities",
    description: "Return the Alibaba typed capability surface and current availability classification.",
    inputSchema: {},
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async () => result({
    state: "ACHIEVED",
    provider: "alibaba",
    realization: "provider-sdk",
    capabilities: CAPABILITIES.map(([name, effect, description, availability]) => ({
      name,
      effect,
      description,
      availability,
    })),
  }));

  server.registerTool("alibaba_capability_gaps", {
    title: "List Alibaba capability gaps",
    description: "Return explicit Telegram-parity gaps that are unsupported, provider-specific, or not yet safely qualified on Alibaba.",
    inputSchema: {},
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async () => result({
    state: "ACHIEVED",
    provider: "alibaba",
    gaps: GAPS,
  }));

  server.registerTool("alibaba_unread_list", {
    title: "List unread Alibaba conversations",
    description: "Read unread Alibaba conversations from the provider conversation service without opening them.",
    inputSchema: {
      limit: z.number().int().min(1).max(50).optional(),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ limit = 50 }) =>
    invoke("unread_list", { limit }, "ALIBABA_UNREAD_LIST_FAILED"));

  server.registerTool("alibaba_conversation_search", {
    title: "Search Alibaba conversations",
    description: "Search bounded provider-backed Alibaba conversations by display name, company, login id, Ali id, or conversation id.",
    inputSchema: {
      query: z.string().trim().min(1).max(160),
      limit: z.number().int().min(1).max(50).optional(),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ query, limit = 20 }) =>
    invoke("conversation_search", { query, limit }, "ALIBABA_CONVERSATION_SEARCH_FAILED"));

  server.registerTool("alibaba_contact_search", {
    title: "Search Alibaba contacts",
    description: "Search contacts already known to the authenticated Alibaba provider session. This does not claim a fresh provider directory lookup.",
    inputSchema: {
      query: z.string().trim().min(1).max(160),
      limit: z.number().int().min(1).max(50).optional(),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ query, limit = 20 }) =>
    invoke("contact_search", { query, limit }, "ALIBABA_CONTACT_SEARCH_FAILED"));

  server.registerTool("alibaba_message_list", {
    title: "Read Alibaba message history",
    description: "Read bounded provider-fresh Alibaba message history without opening the chat. Supports paging backward from an exact alimsg: handle.",
    inputSchema: {
      conversation: z.string().trim().min(1).max(256),
      limit: z.number().int().min(1).max(100).optional(),
      before_message_handle: z.string().trim().max(512).optional(),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ conversation, limit = 20, before_message_handle }) =>
    invoke("message_list", { conversation, limit, before_message_handle }, "ALIBABA_MESSAGE_LIST_FAILED"));

  const messageTargetSchema = {
    message_handle: z.string().trim().max(512).optional(),
    conversation: z.string().trim().max(256).optional(),
    latest_message: z.boolean().optional(),
  };

  server.registerTool("alibaba_message_get", {
    title: "Read one Alibaba message",
    description: "Read one exact provider message by stable alimsg: handle, or the explicitly requested latest message in a conversation.",
    inputSchema: messageTargetSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async (input) =>
    invoke("message_get", input, "ALIBABA_MESSAGE_GET_FAILED"));

  server.registerTool("alibaba_message_replies", {
    title: "Read Alibaba quoted replies",
    description: "Read direct quoted replies to one exact Alibaba message by scanning bounded provider-fresh history in the same conversation. Alibaba does not expose a Telegram-style native reply thread here, so this tool reports only direct quote relationships.",
    inputSchema: {
      ...messageTargetSchema,
      limit: z.number().int().min(1).max(100).optional(),
      max_scan: z.number().int().min(100).max(1000).optional(),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async (input) =>
    invoke("message_replies", input, "ALIBABA_MESSAGE_REPLIES_FAILED"));

  server.registerTool("alibaba_message_search", {
    title: "Search Alibaba messages",
    description: "Use Alibaba remote message search globally or within one exact conversation.",
    inputSchema: {
      query: z.string().trim().min(1).max(300),
      conversation: z.string().trim().max(256).optional(),
      limit: z.number().int().min(1).max(50).optional(),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ query, conversation, limit = 20 }) =>
    invoke("message_search", { query, conversation, limit }, "ALIBABA_MESSAGE_SEARCH_FAILED"));

  server.registerTool("alibaba_screenshot", {
    title: "Capture Alibaba screenshot",
    description: "Capture the current authenticated Alibaba Message Center viewport without navigating or opening another conversation.",
    inputSchema: {
      format: z.enum(["jpeg", "png"]).optional(),
      quality: z.number().int().min(40).max(95).optional(),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ format = "jpeg", quality = 80 }) => {
    try {
      const page = await alibabaPage(cdpUrl, statusUrl);
      const bytes = await page.screenshot({
        type: format,
        ...(format === "jpeg" ? { quality } : {}),
      });
      return {
        structuredContent: {
          state: "ACHIEVED",
          provider: "alibaba",
          realization: "provider-sdk",
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
      return failure(error, "ALIBABA_SCREENSHOT_FAILED");
    }
  });

  server.registerTool("alibaba_attachment_get", {
    title: "Get Alibaba attachment",
    description: "Acquire one exact Alibaba message attachment from the authenticated provider session, stage it through the shared material plane, and return an expiring CF-server download path. Raw provider URLs are not exposed.",
    inputSchema: {
      ...messageTargetSchema,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async (input) => {
    try {
      const value = await stageAttachmentDownload(input);
      return result({
        state: "ACHIEVED",
        provider: "alibaba",
        realization: "provider-sdk-material",
        provider_fresh: true,
        message: value.message,
        filename: value.filename,
        mime_type: value.mime_type,
        size_bytes: value.size_bytes,
        sha256_hex: value.sha256_hex,
        download_path: value.download.download_path,
        expires_after_seconds: value.download.expires_after_seconds,
      });
    } catch (error) {
      return failure(error, "ALIBABA_ATTACHMENT_GET_FAILED");
    }
  });

  server.registerTool("alibaba_file_upload", {
    title: "Stage a large Alibaba file",
    description: "Create, inspect, or delete a resumable Alibaba material upload ticket. The current shared connector transport plane accepts up to 2 GiB; this is not claimed as the Alibaba provider limit.",
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
        if (!input.filename || !input.media_type || !input.size_bytes) {
          throw codedError("ALIBABA_MATERIAL_UPLOAD_FIELDS_REQUIRED");
        }
        value = upload.create({
          filename: input.filename,
          media_type: input.media_type,
          size_bytes: input.size_bytes,
          sha256_hex: input.sha256_hex,
        });
      } else if (input.action === "status") {
        if (!input.upload_id) throw codedError("ALIBABA_MATERIAL_UPLOAD_ID_REQUIRED");
        value = await upload.status(input.upload_id);
      } else {
        if (!input.upload_id) throw codedError("ALIBABA_MATERIAL_UPLOAD_ID_REQUIRED");
        value = await upload.delete(input.upload_id);
      }
      return result({
        state: "ACHIEVED",
        provider: "alibaba",
        realization: "material-plane",
        ...value,
      });
    } catch (error) {
      return failure(error, "ALIBABA_FILE_UPLOAD_FAILED");
    }
  });

  server.registerTool("alibaba_file_upload_chunk", {
    title: "Append Alibaba upload chunk",
    description: "Append one bounded base64 chunk to an existing Alibaba material upload ticket.",
    inputSchema: {
      upload_id: z.string().regex(/^[0-9a-f]{64}$/),
      offset: z.number().int().min(0).max(2147483648),
      data_base64: z.string().min(1),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ upload_id, offset, data_base64 }) => {
    try {
      const value = await requireMaterialUpload().append(upload_id, offset, { data_base64 });
      return result({
        state: "ACHIEVED",
        provider: "alibaba",
        realization: "material-plane",
        ...value,
      });
    } catch (error) {
      return failure(error, "ALIBABA_FILE_UPLOAD_CHUNK_FAILED");
    }
  });

  server.registerTool("alibaba_send", {
    title: "Send Alibaba text",
    description: "Send one text message through the authenticated Alibaba provider SDK. Success requires a new exact message in fresh remote provider history; ambiguous effects return IN_DOUBT and must not be blindly retried.",
    inputSchema: {
      target: z.string().trim().min(1).max(256),
      text: z.string().min(1).max(16000),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async ({ target, text }) =>
    invoke("send", { target, text }, "ALIBABA_SEND_FAILED"));

  server.registerTool("alibaba_reply", {
    title: "Reply to Alibaba message",
    description: "Send a provider-native quoted reply to one exact Alibaba text message. Success requires fresh remote history to contain a new message whose provider quote relation points to the exact source. Non-text source messages fail closed until their subtype mapping is qualified.",
    inputSchema: {
      ...messageTargetSchema,
      text: z.string().min(1).max(16000),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async (input) =>
    invoke("reply", input, "ALIBABA_REPLY_FAILED"));

  server.registerTool("alibaba_delete", {
    title: "Delete Alibaba message",
    description: "Delete one exact Alibaba message. confirm_irreversible=true is required. for_everyone uses Alibaba Web V2 recall for an eligible recent outgoing message (the current Web UI recall window is 120 seconds). Success requires a fresh provider postcondition; ambiguous effects remain IN_DOUBT and are never blindly retried.",
    inputSchema: {
      message_handle: z.string().trim().min(1).max(512),
      for_everyone: z.boolean().optional(),
      confirm_irreversible: z.literal(true),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  }, async (input) =>
    invoke("delete", input, "ALIBABA_DELETE_FAILED"));

  server.registerTool("alibaba_mark_read", {
    title: "Mark Alibaba conversation read",
    description: "Mark currently unread received messages in one Alibaba conversation read, then require a fresh provider conversation postcondition.",
    inputSchema: {
      conversation: z.string().trim().min(1).max(256),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ conversation }) =>
    invoke("mark_read", { conversation }, "ALIBABA_MARK_READ_FAILED"));

  server.registerTool("alibaba_mute", {
    title: "Set Alibaba conversation mute",
    description: "Set desired Alibaba conversation mute state idempotently and verify from a fresh provider conversation read.",
    inputSchema: {
      conversation: z.string().trim().min(1).max(256),
      muted: z.boolean(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ conversation, muted }) =>
    invoke("mute", { conversation, muted }, "ALIBABA_MUTE_FAILED"));

  server.registerTool("alibaba_pin", {
    title: "Set Alibaba conversation pin",
    description: "Set desired Alibaba conversation top/pin state idempotently and verify from a fresh provider conversation read.",
    inputSchema: {
      conversation: z.string().trim().min(1).max(256),
      pinned: z.boolean(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ conversation, pinned }) =>
    invoke("pin", { conversation, pinned }, "ALIBABA_PIN_FAILED"));
}

export {
  alibabaPage,
  runAlibabaCore,
};
