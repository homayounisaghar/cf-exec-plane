import { chromium } from "playwright";

const DEFAULT_CDP_URL = "http://127.0.0.1:9224";
const WHATSAPP_ORIGIN = "https://web.whatsapp.com";

function codedError(code, message = code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

let cachedBrowser = null;
let connectPromise = null;

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

async function whatsappPage(cdpUrl = DEFAULT_CDP_URL) {
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
  return ready;
}

const LIST_CONVERSATIONS_IN_PAGE = (limit) => {
  const pane = document.querySelector("#pane-side");
  if (!pane) throw new Error("WHATSAPP_SESSION_NOT_READY");

  const row = pane.querySelector('[role="row"]');
  if (!row) throw new Error("WHATSAPP_CHATLIST_NOT_READY");

  const fiberKey = Object.keys(row).find((key) => key.startsWith("__reactFiber$"));
  let fiber = fiberKey ? row[fiberKey] : null;
  let chats = null;

  for (let depth = 0; depth < 24 && fiber; depth += 1, fiber = fiber.return) {
    const candidate = fiber.memoizedProps?.chats;
    if (Array.isArray(candidate)) {
      chats = candidate;
      break;
    }
  }

  if (!Array.isArray(chats)) throw new Error("WHATSAPP_CHAT_MODELS_NOT_FOUND");

  return chats.slice(0, limit).map((chat) => {
    const rawId = chat?.id?.toString?.() || String(chat?.id || "");
    if (!rawId) throw new Error("WHATSAPP_CHAT_ID_MISSING");

    const title =
      chat?.formattedTitle ||
      chat?.name ||
      chat?.contact?.formattedName ||
      chat?.contact?.name ||
      rawId;

    const rawUnread = Number(chat?.unreadCount);
    const markedUnread = Number.isFinite(rawUnread) && rawUnread < 0;
    const unreadCount =
      Number.isFinite(rawUnread) && rawUnread > 0 ? Math.floor(rawUnread) : 0;

    let kind = "user";
    if (rawId.endsWith("@g.us")) kind = "group";
    else if (rawId.endsWith("@broadcast")) kind = "broadcast";

    const timestampSeconds = Number(chat?.t);
    const pinValue = Number(chat?.pin);

    return {
      handle: `wachat:${rawId}`,
      name: String(title).slice(0, 256),
      kind,
      unread_count: unreadCount,
      marked_unread: markedUnread,
      has_unread: unreadCount > 0 || markedUnread,
      pinned: Number.isFinite(pinValue) && pinValue > 0,
      last_activity_ms:
        Number.isFinite(timestampSeconds) && timestampSeconds > 0
          ? Math.floor(timestampSeconds * 1000)
          : 0,
    };
  });
};

export async function listWhatsAppConversations(
  limit = 50,
  { cdpUrl = DEFAULT_CDP_URL } = {},
) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
    throw codedError("INVALID_LIMIT");
  }

  const page = await whatsappPage(cdpUrl);
  try {
    const conversations = await page.evaluate(LIST_CONVERSATIONS_IN_PAGE, limit);
    if (!Array.isArray(conversations)) {
      throw codedError("WHATSAPP_RUNTIME_RESULT_INVALID");
    }
    return {
      state: "ACHIEVED",
      provider: "whatsapp",
      realization: "web-rpc",
      count: conversations.length,
      conversations,
      bounded: true,
    };
  } catch (cause) {
    if (cause?.code) throw cause;
    const error = codedError(
      "WHATSAPP_CONVERSATION_LIST_FAILED",
      "WhatsApp conversation listing failed.",
    );
    error.cause = cause;
    throw error;
  }
}

export function registerWhatsAppConversationTool(
  server,
  z,
  { cdpUrl = DEFAULT_CDP_URL } = {},
) {
  server.registerTool("whatsapp_conversation_list", {
    title: "List recent WhatsApp conversations",
    description:
      "Read up to 50 recent WhatsApp conversations from the authenticated WhatsApp Web chat list without opening chats or changing read state. Returns stable wachat: handles and unread counts.",
    inputSchema: {
      limit: z.number().int().min(1).max(50).optional(),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  }, async ({ limit = 50 }) => {
    try {
      const result = await listWhatsAppConversations(limit, { cdpUrl });
      return {
        structuredContent: result,
        content: [{ type: "text", text: JSON.stringify(result, null, 1) }],
      };
    } catch (error) {
      const code =
        typeof error?.code === "string"
          ? error.code
          : "WHATSAPP_CONVERSATION_LIST_FAILED";
      return {
        structuredContent: {
          state: "FAILED",
          provider: "whatsapp",
          error: code,
        },
        content: [{
          type: "text",
          text: `WhatsApp conversation listing failed: ${code}`,
        }],
        isError: true,
      };
    }
  });
}