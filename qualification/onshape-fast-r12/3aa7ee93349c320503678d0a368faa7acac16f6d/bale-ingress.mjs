// Bale parity source. Mapping probe r209 adds bounded call-site inspection; user-facing tools remain fixed and typed.
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

  collectRendered();
  if (!conversations.length) throw new Error("BALE_RENDERED_DIALOGS_NOT_FOUND");
  if (conversations.length >= limit) return conversations.slice(0, limit);

  const scroller = findScrollContainer(renderedRows()[0]);
  if (!scroller) throw new Error("BALE_DIALOG_SCROLL_CONTAINER_NOT_FOUND");

  const originalTop = scroller.scrollTop;
  let bottomStalls = 0;

  try {
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


const PROBE_API_IN_PAGE = async () => {
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

  const describeObject = (value) => {
    const names = new Set();
    let current = value;
    for (let depth = 0; depth < 4 && current; depth += 1) {
      try {
        for (const key of Reflect.ownKeys(current)) {
          if (typeof key === "string" && key !== "constructor") names.add(key);
        }
      } catch {}
      try { current = Object.getPrototypeOf(current); } catch { current = null; }
    }
    const out = [];
    for (const name of [...names].sort().slice(0, 160)) {
      let kind = "unknown";
      try { kind = typeof value?.[name]; } catch {}
      out.push({ name, kind });
    }
    return out;
  };

  const req = getRequire();
  const api = findApi(req);
  if (!api) throw new Error("BALE_API_NOT_FOUND");

  const core = api.core || {};
  const namespaces = {};
  for (const key of Object.keys(core).sort().slice(0, 120)) {
    let value;
    try { value = core[key]; } catch { continue; }
    if (!value || (typeof value !== "object" && typeof value !== "function")) continue;
    namespaces[key] = describeObject(value);
  }

  const selected = {
    dialogs: ["findDialog","findDialogs","getDialog","getPeerDialog","getPeersDialogs","getOutPeers","loadPeerDialog","markDialogsAsRead","markDialogsAsUnRead","readMessages","receivedMessages","isChatNotificationEnabledAsync","changeChatNotification","pinDialogs","unPinDialogs","deleteChat","deleteDialog","loadDialogs","getArchivedPeerUniqueIds"],
    entities: ["loadPeers","queryNickname"],
    search: ["allMessagesSearch","searchPeerMessages","loadMoreSearchMessages","getUsers","searchMembers","globalChannelSearch","searchContent","searchPeerMedia"],
    messaging: ["getLastMessage","getLastMessages","getHistoryMessage","getFirstMessages","openHistory","loadHistory","loadMoreHistory","loadReplies","loadMessagesRepliesInfo","sendAndAddPendingMessage","putPendingMessage","prepareMessages","addPendingMessages","sendTextMessage","sendMessage","sendMessages","sendDocumentMessage","sendMultiMediaMessage","forwardMessages","deleteMessages","updateMessage","updateHistoryMessage","setReaction","addReaction","changeReaction","removeReaction","getReactions","pinMessage","unPinMessage","getTopics","createTopic","editTopic","deleteTopic"],
    users: ["getContacts","searchUser","addContact","importContact","deleteContact","blockUser","unblockUser","findUser","loadUser","loadFullUser","editMyName","editMyAbout","editMyNick","editName"],
    usersClient: ["SearchContacts","AddContact","RemoveContact","BlockUser","UnblockUser","GetContacts","EditAbout","EditName","EditNickName","GetFullUser"],
    groups: ["createGroup","findGroup","loadGroup","getMyGroups","loadMembers","getMemberPermissions","getBannedUsers","addMembers","kickUser","leaveGroup","getGroupUrl","revokeGroupUrl","joinGroup","joinPublicGroup","editGroupTitle","editGroupAbout","makeUserAdmin","removeUserAdmin","getFullGroup","getGroupPreview","setAvailableReactions"],
    folders: ["getAllFolders","createFolder","editFolder","deleteFolder","reorderFolders","loadFolders"],
    settings: ["saveDraft","toggleDialogPin","changePeerTypeNotification","changeNotificationMention","changeNotificationPerview"],
    meet: ["startCall","acceptCall","discardCall","startGroupCall","joinGroupCall","leaveGroupCall","getCallLogs","getOngoingCalls","generateCallLink"],
    scheduler: ["listTasks","scheduleTask","unScheduleTask","executeTaskNow","reScheduleTask"],
    presence: ["setAppVisibliblity","getContactsPresence","getUsersPresences"],
    filesModule: ["getFileDownloadUrl","getFileUrl","loadFileUrl","getUploadUrl"],
    ai: ["getTranscript","getLinkSummary"],
    sharedMedia: ["loadMedia","getActiveSharedMedia"],
    topPeer: ["getTopPeer","loadTopPeer","removePeer"],
  };

  const selected_signatures = {};
  for (const [namespace, names] of Object.entries(selected)) {
    const target = core[namespace];
    if (!target) continue;
    const items = {};
    for (const name of names) {
      let fn;
      try { fn = target[name]; } catch { continue; }
      if (typeof fn !== "function") continue;
      let source = "";
      try { source = Function.prototype.toString.call(fn).slice(0, 1800); } catch {}
      items[name] = { arity: Number(fn.length) || 0, source };
    }
    selected_signatures[namespace] = items;
  }

  const firstValue = (observable, timeoutMs = 8000) => new Promise((resolve, reject) => {
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

  const sanitize = (value, depth = 0, seen = new WeakSet()) => {
    if (value === null || value === undefined) return value ?? null;
    const t = typeof value;
    if (t === "string") return value.slice(0, 240);
    if (t === "number" || t === "boolean") return value;
    if (t === "bigint") return value.toString();
    if (t === "function") return "[function]";
    if (t !== "object") return String(value).slice(0, 240);
    if (depth >= 4) return "[depth-limit]";
    if (seen.has(value)) return "[circular]";
    seen.add(value);
    if (Array.isArray(value)) return value.slice(0, 8).map((item) => sanitize(item, depth + 1, seen));
    const out = {};
    let keys = [];
    try { keys = Object.keys(value).slice(0, 80); } catch {}
    for (const key of keys) {
      try { out[key] = sanitize(value[key], depth + 1, seen); } catch {}
    }
    return out;
  };

  let sample = null;
  try {
    const row = document.querySelector('[aria-label="dialog-item"]');
    const fiberKey = row && Object.keys(row).find((key) => key.startsWith("__reactFiber$"));
    let fiber = fiberKey ? row[fiberKey] : null;
    let props = null;
    for (let depth = 0; depth < 12 && fiber; depth += 1, fiber = fiber.return) {
      const candidate = fiber.memoizedProps;
      if (candidate?.peer && Number.isFinite(Number(candidate.peer.id)) && Number.isFinite(Number(candidate.peer.type))) {
        props = candidate;
        break;
      }
    }
    if (props?.peer) {
      const peer = props.peer;
      let dialog = null;
      let lastMessage = null;
      let notificationEnabled = null;
      try { dialog = await firstValue(api.core.dialogs.getPeerDialog(peer, { save: false })); } catch {}
      try { lastMessage = await firstValue(api.core.messaging.getLastMessage(peer)); } catch {}
      try { notificationEnabled = await firstValue(api.core.dialogs.isChatNotificationEnabledAsync(peer)); } catch {}
      sample = {
        rendered_props: sanitize(props),
        peer: sanitize(peer),
        dialog: sanitize(dialog),
        last_message: sanitize(lastMessage),
        notification_enabled: sanitize(notificationEnabled),
      };
    }
  } catch (error) {
    sample = { error: String(error?.message || error).slice(0, 240) };
  }

  const callsiteTerms = [
    "sendTextMessage(",
    "sendDocumentMessage(",
    "forwardMessages(",
    "updateMessage(",
    "setReaction(",
    "searchPeerMessages(",
    "loadHistory(",
    "getUploadUrl(",
  ];
  const callsite_scan = {};
  const factories = req?.m && typeof req.m === "object" ? Object.entries(req.m) : [];
  for (const term of callsiteTerms) {
    const hits = [];
    for (const [moduleId, factory] of factories) {
      let source = "";
      try { source = Function.prototype.toString.call(factory); } catch { continue; }
      let from = 0;
      while (hits.length < 12) {
        const index = source.indexOf(term, from);
        if (index < 0) break;
        hits.push({
          module_id: String(moduleId),
          snippet: source.slice(Math.max(0, index - 650), Math.min(source.length, index + 1200)),
        });
        from = index + term.length;
      }
      if (hits.length >= 12) break;
    }
    callsite_scan[term] = hits;
  }

  return {
    top_level: describeObject(api),
    core_namespaces: Object.keys(namespaces),
    namespaces,
    selected_signatures,
    sample,
    callsite_scan,
  };
};

export async function probeBaleApi({ cdpUrl = DEFAULT_CDP_URL } = {}) {
  const page = await balePage(cdpUrl);
  try {
    const api = await page.evaluate(PROBE_API_IN_PAGE);
    return {
      state: "ACHIEVED",
      provider: "bale",
      realization: "bounded-api-shape-probe",
      api,
    };
  } catch (cause) {
    const error = codedError("BALE_API_PROBE_FAILED");
    error.cause = cause;
    throw error;
  }
}

export async function listBaleConversations(limit = 10, { cdpUrl = DEFAULT_CDP_URL } = {}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw codedError("INVALID_LIMIT");
  const page = await balePage(cdpUrl);
  try {
    const conversations = await page.evaluate(LIST_CONVERSATIONS_IN_PAGE, limit);
    const api_shape = await page.evaluate(PROBE_API_IN_PAGE);
    return {
      state: "ACHIEVED",
      provider: "bale",
      realization: "web-rpc",
      count: conversations.length,
      conversations,
      bounded: true,
      diagnostic_api_shape: api_shape,
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

  server.registerTool("bale_api_probe", {
    title: "Inspect Bale internal capability shape",
    description: "Read-only bounded diagnostic that returns Bale API namespace and method names from the authenticated Bale Web session. It accepts no arbitrary code or operation arguments.",
    inputSchema: {},
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  }, async () => {
    try {
      const result = await probeBaleApi({ cdpUrl });
      return {
        structuredContent: result,
        content: [{ type: "text", text: JSON.stringify(result, null, 1) }],
      };
    } catch (error) {
      const code = typeof error?.code === "string" ? error.code : "BALE_API_PROBE_FAILED";
      return {
        structuredContent: { state: "FAILED", provider: "bale", error: code },
        content: [{ type: "text", text: `Bale API probe failed: ${code}` }],
        isError: true,
      };
    }
  });
}