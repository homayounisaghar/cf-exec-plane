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
  const getRequire = () => {
    if (globalThis.__cfBaleRequire) return globalThis.__cfBaleRequire;
    const chunks = globalThis.rspackChunkweb;
    if (!chunks || typeof chunks.push !== "function") return null;
    try {
      chunks.push([[987654321], {}, (req) => { globalThis.__cfBaleRequire = req; }]);
    } catch {}
    return globalThis.__cfBaleRequire || null;
  };

  const findApi = (req) => {
    const cached = globalThis.__cfBaleApi;
    if (cached?.core?.dialogs && cached?.core?.entities && cached?.core?.messaging && cached?.core?.search) {
      return cached;
    }
    for (const module of Object.values(req?.c || {})) {
      let exported;
      try { exported = module?.exports; } catch { continue; }
      const candidates = [exported];
      if (exported && (typeof exported === "object" || typeof exported === "function")) {
        for (const key of Object.keys(exported).slice(0, 100)) {
          try { candidates.push(exported[key]); } catch {}
        }
      }
      for (const value of candidates) {
        try {
          if (value?.core?.dialogs && value?.core?.entities && value?.core?.messaging && value?.core?.search) {
            globalThis.__cfBaleApi = value;
            return value;
          }
        } catch {}
      }
    }
    return null;
  };

  const firstValue = (observable, timeoutMs = 10_000) => new Promise((resolve, reject) => {
    let done = false;
    let subscription = null;
    const finish = (fn, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { subscription?.unsubscribe?.(); } catch {}
      fn(value);
    };
    const timer = setTimeout(() => finish(reject, new Error("BALE_OBSERVABLE_TIMEOUT")), timeoutMs);
    try {
      subscription = observable.subscribe({
        next: (value) => finish(resolve, value),
        error: (error) => finish(reject, error),
        complete: () => finish(resolve, undefined),
      });
    } catch (error) {
      finish(reject, error);
    }
  });

  const api = findApi(getRequire());
  if (!api) throw new Error("BALE_API_NOT_FOUND");

  const rawDialogs = await firstValue(api.core.dialogs.getAllDialogs(false));
  const rows = (Array.isArray(rawDialogs) ? rawDialogs : [])
    .filter((item) => item?.peer && Number.isSafeInteger(item.peer.id))
    .sort((a, b) => Number(b.date || 0) - Number(a.date || 0))
    .slice(0, limit);

  const entities = rows.length
    ? await firstValue(api.core.entities.loadPeers(rows.map((item) => item.peer)))
    : { users: [], groups: [] };
  const users = new Map((entities?.users || []).map((item) => [Number(item.id), item]));
  const groups = new Map((entities?.groups || []).map((item) => [Number(item.id), item]));

  return rows.map((item) => {
    const peerType = Number(item.peer.type);
    const peerId = Number(item.peer.id);
    const entity = peerType === 1 ? users.get(peerId) : groups.get(peerId);
    const name = peerType === 1
      ? (entity?.name || entity?.localName || entity?.nick || `User ${peerId}`)
      : (entity?.title || entity?.nick || `Group ${peerId}`);
    const unreadCount = Number.isSafeInteger(item.counter) && item.counter >= 0 ? item.counter : 0;
    return {
      handle: `balechat:${peerType}:${peerId}`,
      name: String(name).slice(0, 256),
      kind: peerType === 1 ? "user" : "group",
      peer_type: peerType,
      unread_count: unreadCount,
      marked_unread: item.markedAsUnread === true,
      has_unread: unreadCount > 0 || item.markedAsUnread === true,
      last_date_ms: Number.isSafeInteger(item.date) ? item.date : 0,
    };
  });
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
    description: "Read the most recent Bale conversations from the authenticated Bale Web session without opening chats or changing read state. Returns names, stable balechat: handles and unread state.",
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