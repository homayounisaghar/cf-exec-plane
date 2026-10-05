// Bale canary source: the first CF-server exposure may use an equivalent raw-CDP preload bridge while preserving these read-only semantics.
import { chromium } from "playwright";

const DEFAULT_CDP_URL = "http://127.0.0.1:9222";
const BALE_ORIGIN = "https://web.bale.ai";

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

async function balePage(cdpUrl = DEFAULT_CDP_URL) {
  let browser;
  try {
    browser = await connectBrowser(cdpUrl);
  } catch (cause) {
    const error = codedError("BALE_BROWSER_UNAVAILABLE", "Bale browser debugging endpoint is unavailable.");
    error.cause = cause;
    throw error;
  }

  const pages = browser.contexts().flatMap((context) => context.pages());
  const ready = pages.find((page) => {
    try {
      const url = new URL(page.url());
      return url.origin === BALE_ORIGIN && url.pathname.startsWith("/chat");
    } catch {
      return false;
    }
  });
  if (ready) return ready;

  const hasBalePage = pages.some((page) => {
    try { return new URL(page.url()).origin === BALE_ORIGIN; } catch { return false; }
  });
  throw codedError(hasBalePage ? "BALE_SESSION_NOT_READY" : "BALE_PAGE_NOT_FOUND");
}

const LIST_CONVERSATIONS_IN_PAGE = async (limit) => {
  const rows = [...document.querySelectorAll('[aria-label="dialog-item"]')];
  const conversations = [];

  for (let index = 0; index < rows.length && conversations.length < limit; index += 1) {
    const element = rows[index];
    const fiberKey = Object.keys(element).find((key) => key.startsWith("__reactFiber$"));
    let fiber = fiberKey ? element[fiberKey] : null;
    let props = null;

    for (let depth = 0; depth < 12 && fiber; depth += 1, fiber = fiber.return) {
      const candidate = fiber.memoizedProps;
      const peer = candidate?.peer;
      if (
        peer &&
        Number.isSafeInteger(Number(peer.id)) &&
        Number.isSafeInteger(Number(peer.type)) &&
        typeof candidate.title === "string" &&
        Number.isFinite(Number(candidate.unreadCount))
      ) {
        props = candidate;
        break;
      }
    }

    if (!props) continue;

    const peerType = Number(props.peer.type);
    const peerId = Number(props.peer.id);
    const unreadCount = Math.max(0, Number(props.unreadCount) || 0);
    const markedUnread = props.markedAsUnread === true;

    conversations.push({
      handle: `balechat:${peerType}:${peerId}`,
      name: String(props.title).slice(0, 256),
      kind: peerType === 1 ? "user" : (peerType === 2 ? "group" : "other"),
      peer_type: peerType,
      unread_count: unreadCount,
      marked_unread: markedUnread,
      has_unread: unreadCount > 0 || markedUnread,
      last_date_ms: Number.isFinite(Number(props.date)) ? Number(props.date) : 0,
    });
  }

  if (!conversations.length) throw new Error("BALE_RENDERED_DIALOGS_NOT_FOUND");
  return conversations;
};

export async function listBaleConversations(limit = 10, { cdpUrl = DEFAULT_CDP_URL } = {}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw codedError("INVALID_LIMIT");
  const page = await balePage(cdpUrl);
  try {
    const conversations = await page.evaluate(LIST_CONVERSATIONS_IN_PAGE, limit);
    return {
      state: "ACHIEVED",
      provider: "bale",
      realization: "web-rpc",
      count: conversations.length,
      conversations,
      bounded: true,
    };
  } catch (cause) {
    const error = codedError("BALE_CONVERSATION_LIST_FAILED");
    error.cause = cause;
    throw error;
  }
}

export function registerBaleConversationTool(server, z, {
  cdpUrl = DEFAULT_CDP_URL,
} = {}) {
  server.registerTool("bale_conversation_list", {
    title: "List recent Bale conversations",
    description: "Read the currently rendered recent Bale conversations from the authenticated Bale Web sidebar without opening chats or changing read state. Returns names, stable balechat: handles and live unread state.",
    inputSchema: {
      limit: z.number().int().min(1).max(50).optional(),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  }, async ({ limit = 10 }) => {
    try {
      const result = await listBaleConversations(limit, { cdpUrl });
      return {
        structuredContent: result,
        content: [{ type: "text", text: JSON.stringify(result, null, 1) }],
      };
    } catch (error) {
      const code = typeof error?.code === "string" ? error.code : "BALE_CONVERSATION_LIST_FAILED";
      return {
        structuredContent: { state: "FAILED", provider: "bale", error: code },
        content: [{ type: "text", text: `Bale conversation listing failed: ${code}` }],
        isError: true,
      };
    }
  });
}