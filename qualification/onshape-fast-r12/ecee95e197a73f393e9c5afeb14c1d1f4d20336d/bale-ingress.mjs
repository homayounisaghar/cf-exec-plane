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
  const rowSelector = '[aria-label="dialog-item"]';
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const nextFrame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));

  const readConversation = (element) => {
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

    if (!props) return null;

    const peerType = Number(props.peer.type);
    const peerId = Number(props.peer.id);
    const unreadCount = Math.max(0, Number(props.unreadCount) || 0);
    const markedUnread = props.markedAsUnread === true;

    return {
      handle: "balechat:" + peerType + ":" + peerId,
      name: String(props.title).slice(0, 256),
      kind: peerType === 1 ? "user" : (peerType === 2 ? "group" : "other"),
      peer_type: peerType,
      unread_count: unreadCount,
      marked_unread: markedUnread,
      has_unread: unreadCount > 0 || markedUnread,
      last_date_ms: Number.isFinite(Number(props.date)) ? Number(props.date) : 0,
    };
  };

  const renderedRows = () => [...document.querySelectorAll(rowSelector)]
    .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);

  const findScrollContainer = (seed) => {
    let fallback = null;
    for (let element = seed?.parentElement; element && element !== document.body; element = element.parentElement) {
      if (element.scrollHeight <= element.clientHeight + 4) continue;
      if (!fallback) fallback = element;
      const overflowY = getComputedStyle(element).overflowY;
      if (overflowY === "auto" || overflowY === "scroll" || overflowY === "overlay") return element;
    }
    return fallback;
  };

  const conversations = [];
  const seen = new Set();

  const collectRendered = () => {
    for (const element of renderedRows()) {
      if (conversations.length >= limit) break;
      const item = readConversation(element);
      if (!item || seen.has(item.handle)) continue;
      seen.add(item.handle);
      conversations.push(item);
    }
  };

  const initialRows = renderedRows();
  if (!initialRows.length) throw new Error("BALE_RENDERED_DIALOGS_NOT_FOUND");

  const scroller = findScrollContainer(initialRows[0]);
  if (!scroller) throw new Error("BALE_DIALOG_SCROLL_CONTAINER_NOT_FOUND");

  const originalTop = scroller.scrollTop;
  let bottomStalls = 0;

  try {
    scroller.scrollTop = 0;
    scroller.dispatchEvent(new Event("scroll", { bubbles: true }));
    await nextFrame();
    await sleep(120);
    collectRendered();
    if (!conversations.length) throw new Error("BALE_RENDERED_DIALOGS_NOT_FOUND");

    for (let iteration = 0; iteration < 80 && conversations.length < limit; iteration += 1) {
      const beforeCount = conversations.length;
      const beforeTop = scroller.scrollTop;
      const maxTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
      const step = Math.max(240, Math.floor(scroller.clientHeight * 0.8));
      const targetTop = Math.min(maxTop, beforeTop + step);

      scroller.scrollTop = targetTop;
      scroller.dispatchEvent(new Event("scroll", { bubbles: true }));
      await nextFrame();
      await sleep(90);
      collectRendered();

      const refreshedMaxTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
      const atBottom = scroller.scrollTop >= refreshedMaxTop - 2;
      const advanced = scroller.scrollTop > beforeTop + 1;
      const gained = conversations.length > beforeCount;

      if (atBottom && !gained) {
        bottomStalls += 1;
        if (bottomStalls >= 3) {
          await sleep(220);
          collectRendered();
          const finalMaxTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
          if (scroller.scrollTop >= finalMaxTop - 2 && conversations.length === beforeCount) break;
          bottomStalls = 0;
        }
      } else {
        bottomStalls = 0;
      }

      if (!advanced && !gained && !atBottom) {
        scroller.scrollTop = Math.min(refreshedMaxTop, beforeTop + Math.max(step, 480));
        scroller.dispatchEvent(new Event("scroll", { bubbles: true }));
        await nextFrame();
        await sleep(120);
        collectRendered();
      }
    }
  } finally {
    scroller.scrollTop = originalTop;
    scroller.dispatchEvent(new Event("scroll", { bubbles: true }));
    await nextFrame();
    await sleep(60);
  }

  return conversations.slice(0, limit);
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
    description: "Read up to the requested number of recent Bale conversations from the authenticated Bale Web sidebar by bounded scrolling of rendered rows, without opening chats or changing read state. Returns names, stable balechat: handles and live unread state.",
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