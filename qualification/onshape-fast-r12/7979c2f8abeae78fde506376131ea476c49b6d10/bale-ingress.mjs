// Bale reaction-verification r227 candidate. Fixed typed tools only; no generic executor is exposed.
import fs from "node:fs";
import crypto from "node:crypto";
import { chromium } from "playwright";
import { invokeTelegramSemanticOperation } from "./telegram-ingress.mjs";

const DEFAULT_CDP_URL = "http://127.0.0.1:9323";
const BALE_ORIGIN = "https://web.bale.ai";
const BALE_PCG_SOCKET = "/run/pcg/web.sock";
const BALE_MATERIAL_ROOT = "/run/pcg-material-files";
const BALE_MATERIAL_MAX_BYTES = 2 * 1024 * 1024 * 1024;
const BALE_MATERIAL_CHUNK_BYTES = 2 * 1024 * 1024;

const BALE_CAPABILITIES = [
  ["bale_conversation_list","read","List up to 50 recent conversations with authoritative unread state."],
  ["bale_capability_list","read","Describe the live Bale connector surface."],
  ["bale_capability_gaps","read","Report explicit parity gaps."],
  ["bale_unread_list","read","List recent conversations with unread or marked-unread state."],
  ["bale_reaction_get","read","Read own and aggregate reaction state for one exact message."],
  ["bale_conversation_search","read","Search Bale conversations by name."],
  ["bale_contact_search","read","Search locally known Bale contacts."],
  ["bale_message_list","read","Read recent messages for one exact conversation without opening it."],
  ["bale_message_replies","read","Read bounded direct quoted replies to one exact Bale message from fresh provider history."],
  ["bale_message_search","read","Search messages globally or inside one conversation."],
  ["bale_screenshot","read","Capture the current Bale Web viewport without navigation."],
  ["bale_send","write","Send an ordinary text message."],
  ["bale_reply","write","Reply to an exact or explicitly latest message."],
  ["bale_react","write","Set/change/remove the owner's reaction."],
  ["bale_forward","write","Native-forward one exact or explicitly latest message."],
  ["bale_edit","write","Edit one owner-sent message when Bale permits it."],
  ["bale_delete","write","Delete one exact message locally or for everyone when permitted."],
  ["bale_mark_read","write","Mark one conversation read and clear manual unread state."],
  ["bale_mark_unread","write","Mark one conversation unread without opening it."],
  ["bale_mute","write","Set desired mute state idempotently."],
  ["bale_pin","write","Set desired local chat-pin state idempotently."],
  ["bale_attachment_get","read","Acquire one exact Bale attachment without opening the chat."],
  ["bale_file_send","write","Send one bounded ChatGPT file as a Bale document."],
  ["bale_voice_send_file","write","Convert owner audio through the shared voice pipeline and send a provider-native Bale Voice Message."],
];

const BALE_RELIABILITY = {
  bale_conversation_list: "SUPPORTED_AND_SAFE",
  bale_capability_list: "SUPPORTED_AND_SAFE",
  bale_capability_gaps: "SUPPORTED_AND_SAFE",
  bale_unread_list: "SUPPORTED_AND_SAFE",
  bale_reaction_get: "SUPPORTED_AND_SAFE",
  bale_conversation_search: "SUPPORTED_AND_SAFE",
  bale_contact_search: "SUPPORTED_AND_SAFE",
  bale_message_list: "SUPPORTED_AND_SAFE",
  bale_message_replies: "SUPPORTED_AND_SAFE",
  bale_message_search: "SUPPORTED_AND_SAFE",
  bale_screenshot: "SUPPORTED_AND_SAFE",
  bale_attachment_get: "SUPPORTED_AND_SAFE",
  bale_react: "SUPPORTED_AND_SAFE",
  bale_send: "POSSIBLE_BUT_UNVERIFIED/FRAGILE",
  bale_reply: "SUPPORTED_AND_SAFE",
  bale_forward: "POSSIBLE_BUT_UNVERIFIED/FRAGILE",
  bale_edit: "POSSIBLE_BUT_UNVERIFIED/FRAGILE",
  bale_delete: "POSSIBLE_BUT_UNVERIFIED/FRAGILE",
  bale_mark_read: "POSSIBLE_BUT_UNVERIFIED/FRAGILE",
  bale_mark_unread: "POSSIBLE_BUT_UNVERIFIED/FRAGILE",
  bale_mute: "POSSIBLE_BUT_UNVERIFIED/FRAGILE",
  bale_pin: "POSSIBLE_BUT_UNVERIFIED/FRAGILE",
  bale_file_send: "POSSIBLE_BUT_UNVERIFIED/FRAGILE",
  bale_voice_send_file: "SUPPORTED_AND_SAFE",
};

const BALE_GAPS = [
  {
    operation: "bale_transcribe",
    state: "SUPPORTED_AND_SAFE",
    reason: "Provider-specific transcription is unnecessary for the reliable surface; audio_transcribe can consume an acquired attachment.",
  },
  {
    operation: "bale_partial_mark_read",
    state: "POSSIBLE_BUT_UNVERIFIED/FRAGILE",
    reason: "Lower-level history/read primitives exist, but the reliable typed contract intentionally exposes Bale conversation-wide read state rather than inventing Telegram counted-boundary semantics.",
  },
  {
    operation: "bale_large_history_pagination",
    state: "POSSIBLE_BUT_UNVERIFIED/FRAGILE",
    reason: "loadHistory/loadMoreHistory primitives exist, but cursor/range semantics and read-purity have not been qualified as a typed surface.",
  },
  {
    operation: "bale_native_media_send",
    state: "POSSIBLE_BUT_UNVERIFIED/FRAGILE",
    reason: "Document and multi-media provider primitives exist, but native image/video distinctions and provider-fresh write verification are not qualified. Native voice send is separately qualified.",
  },
  {
    operation: "bale_multi_message_forward",
    state: "POSSIBLE_BUT_UNVERIFIED/FRAGILE",
    reason: "The provider forwarding primitive accepts arrays, but bounded multi-message ordering/partial-failure semantics are not qualified.",
  },
];

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
      ex_peer_type: Number.isFinite(Number(props.exPeerType)) ? Number(props.exPeerType) : null,
      unread_count: unreadCount,
      marked_unread: markedUnread,
      has_unread: unreadCount > 0 || markedUnread,
      last_date_ms: Number.isFinite(Number(props.date)) ? Number(props.date) : 0,
      muted: props.isNotificationEnabled === false ? true : (props.isNotificationEnabled === true ? false : null),
      pinned: props.isPinned === true,
      dialog_state_source: "rendered_dialog",
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

  try {
    const target = core.messaging?.api;
    if (target) {
      const items = {};
      for (const name of ["getMessagesReactions","addReaction","removeReaction"]) {
        let fn;
        try { fn = target[name]; } catch { continue; }
        if (typeof fn !== "function") continue;
        let source = "";
        try { source = Function.prototype.toString.call(fn).slice(0, 2400); } catch {}
        items[name] = { arity: Number(fn.length) || 0, source };
      }
      selected_signatures.messaging_api = items;
    }
  } catch {}

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
    "date:l??Date.now()",
    "forwardableGroupedMessages",
    "updateMessage(",
    "setReaction(",
    "getMessagesReactions(",
    "addReaction(",
    "removeReaction(",
    "searchPeerMessages(",
    "loadHistory(",
    "LISTLOADMODE_BACKWARD",
    "getUploadUrl(",
    "textCommand",
    "messageTag",
    "textMessage:{",
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


const BALE_CORE_OPERATION_IN_PAGE = async (request) => {
  const op = String(request?.op || "");
  const args = request?.args && typeof request.args === "object" ? request.args : {};

  const firstValue = (observable, timeoutMs = 12_000) => new Promise((resolve, reject) => {
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

  const getRequire = () => {
    if (globalThis.__cfBaleRequire) return globalThis.__cfBaleRequire;
    const chunks = globalThis.rspackChunkweb;
    if (!chunks || typeof chunks.push !== "function") return null;
    try {
      chunks.push([[987654322], {}, (req) => { globalThis.__cfBaleRequire = req; }]);
    } catch {}
    return globalThis.__cfBaleRequire || null;
  };

  const findApi = (req) => {
    const cached = globalThis.__cfBaleApi;
    if (cached?.core?.dialogs && cached?.core?.messaging && cached?.core?.search) return cached;
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
          if (value?.core?.dialogs && value?.core?.messaging && value?.core?.search) {
            globalThis.__cfBaleApi = value;
            return value;
          }
        } catch {}
      }
    }
    return null;
  };

  const api = findApi(getRequire());
  if (!api) throw new Error("BALE_API_NOT_FOUND");
  const core = api.core || {};
  const messageCache = globalThis.__cfBaleMessageCache instanceof Map
    ? globalThis.__cfBaleMessageCache
    : (globalThis.__cfBaleMessageCache = new Map());

  const parseChatHandle = (value) => {
    const match = /^balechat:(\d+):(-?\d+)$/.exec(String(value || ""));
    if (!match) throw new Error("BALE_CHAT_HANDLE_INVALID");
    const type = Number(match[1]);
    const id = Number(match[2]);
    if (!Number.isSafeInteger(type) || !Number.isSafeInteger(id)) throw new Error("BALE_CHAT_HANDLE_INVALID");
    return { type, id };
  };

  const chatHandle = (peer) => "balechat:" + Number(peer.type) + ":" + Number(peer.id);

  const parseMessageHandle = (value) => {
    const match = /^balemsg:(\d+):(-?\d+):(\d+):(-?\d+)$/.exec(String(value || ""));
    if (!match) throw new Error("BALE_MESSAGE_HANDLE_INVALID");
    const peer = { type: Number(match[1]), id: Number(match[2]) };
    const date = Number(match[3]);
    const rid = String(match[4]);
    if (!Number.isSafeInteger(peer.type) || !Number.isSafeInteger(peer.id) || !Number.isFinite(date)) {
      throw new Error("BALE_MESSAGE_HANDLE_INVALID");
    }
    return { peer, date, rid };
  };

  const messageHandle = (peer, message) =>
    "balemsg:" + Number(peer.type) + ":" + Number(peer.id) + ":" + Number(message.date || 0) + ":" + String(message.rid);

  const cacheKey = (peer, rid) => chatHandle(peer) + ":" + String(rid);

  const ownUserId = () => {
    const id = Number(core.auth?.user?.id);
    return Number.isSafeInteger(id) ? id : null;
  };

  const safeText = (message) => {
    const payload = message?.message || {};
    if (typeof payload?.textMessage?.text === "string") return payload.textMessage.text;
    if (typeof payload?.longTextMessage?.text === "string") return payload.longTextMessage.text;
    if (typeof payload?.documentMessage?.caption?.text === "string") return payload.documentMessage.caption.text;
    if (typeof payload?.templateMessage?.generalMessage?.textMessage?.text === "string") {
      return payload.templateMessage.generalMessage.textMessage.text;
    }
    return "";
  };

  const ownReaction = (message) => {
    const uid = ownUserId();
    if (uid === null || !Array.isArray(message?.reactions)) return null;
    for (const reaction of message.reactions) {
      if (Array.isArray(reaction?.users) && reaction.users.map(Number).includes(uid)) {
        return typeof reaction.code === "string" ? reaction.code : String(reaction.code ?? "");
      }
    }
    return null;
  };

  const normalizeReactionCode = (value) => {
    const code = String(value ?? "").trim();
    // Bale provider state uses U+2764 for the heart code; the common rendered
    // heart includes U+FE0F. Only normalize the provider-proven presentation
    // variant rather than guessing other emoji mappings.
    return code === "\u2764\uFE0F" ? "\u2764" : code;
  };

  const reactionStateFromMessage = (message) => {
    if (!message || !Array.isArray(message.reactions)) return null;
    const mine = ownReaction(message);
    const reactions = message.reactions.map((reaction) => {
      const cardinality = Number(reaction?.cardinality?.value);
      const usersCount = Array.isArray(reaction?.users) ? reaction.users.length : 0;
      const emoji = typeof reaction?.code === "string" ? reaction.code : String(reaction?.code ?? "");
      return {
        emoji,
        count: Number.isFinite(cardinality) ? Math.max(0, cardinality) : usersCount,
        mine: mine === emoji,
      };
    });
    return { my_reaction: mine, reactions };
  };

  const readProviderReactionState = async (source) => {
    // This wrapper performs Bale's provider RPC GetMessagesReactions and returns
    // the response containers. It may update local stores as a side effect, but
    // verification is derived only from its returned provider response.
    const mid = {
      rid: String(source.rid),
      date: Number(source.message?.date || source.date || 0),
      seq: "0",
    };
    const containers = await firstValue(
      core.messaging.getReactions(source.peer, [mid], source.peer, [mid]),
      15_000
    );
    if (!Array.isArray(containers)) return null;

    // The provider request is scoped to exactly one rid. A successful empty
    // provider response is authoritative "no reactions".
    if (containers.length === 0) {
      return { my_reaction: null, reactions: [] };
    }

    const wantedRid = String(source.rid);
    const identityMatches = (item) => [
      item?.rid,
      item?.messageId,
      item?.messageId?.value,
      item?.mid,
      item?.mid?.value,
      item?.id,
      item?.id?.value,
    ].some((value) => value !== undefined && value !== null && String(value) === wantedRid);

    let container = containers.find(identityMatches) || null;
    if (!container && containers.length === 1) container = containers[0];
    if (!container || !Array.isArray(container.reactions)) return null;

    return reactionStateFromMessage({ reactions: container.reactions });
  };

  const fileCandidates = (message) => {
    const found = [];
    const seen = new Set();
    const root = message?.message;
    const visit = (value, path, depth) => {
      if (!value || typeof value !== "object" || depth > 7) return;
      if (seen.has(value)) return;
      seen.add(value);
      const fileId = value.fileId;
      if (fileId !== undefined && fileId !== null && String(fileId)) {
        const location = {
          fileId: String(fileId),
          accessHash: value.accessHash !== undefined && value.accessHash !== null ? String(value.accessHash) : undefined,
          fileStorageVersion: Number.isFinite(Number(value.fileStorageVersion)) ? Number(value.fileStorageVersion) : undefined,
        };
        found.push({
          path,
          location,
          filename: typeof value.name === "string" ? value.name
            : (typeof value.fileName === "string" ? value.fileName : null),
          media_type: typeof value.mimeType === "string" ? value.mimeType
            : (typeof value.mediaType === "string" ? value.mediaType : null),
          size_bytes: Number.isSafeInteger(Number(value.fileSize)) ? Number(value.fileSize) : null,
        });
      }
      for (const [key, child] of Object.entries(value)) {
        if (child && typeof child === "object") visit(child, path ? path + "." + key : key, depth + 1);
      }
    };
    visit(root, "message", 0);
    const deduped = [];
    const ids = new Set();
    for (const item of found.sort((a, b) => a.path.length - b.path.length)) {
      const key = item.location.fileId + ":" + String(item.location.accessHash || "");
      if (ids.has(key)) continue;
      ids.add(key);
      deduped.push(item);
    }
    return deduped;
  };

  const normalizeMessage = (peer, message) => {
    if (!message || typeof message !== "object" || message.rid === undefined || message.rid === null) return null;
    const attachments = fileCandidates(message).map((file, index) => ({
      index: index + 1,
      filename: file.filename,
      media_type: file.media_type,
      size_bytes: file.size_bytes,
      source_path: file.path,
    }));
    const reactionState = reactionStateFromMessage(message) || { my_reaction: null, reactions: [] };
    const normalized = {
      handle: messageHandle(peer, message),
      conversation_handle: chatHandle(peer),
      rid: String(message.rid),
      date_ms: Number(message.date || 0),
      sender_id: Number.isFinite(Number(message.senderUid)) ? Number(message.senderUid) : null,
      is_outgoing: message.isOut === true,
      type: message.type ?? null,
      text: safeText(message),
      edited_at: message.editedAt ?? null,
      reply_to_top_id: message.replyToTopId ?? null,
      has_comment: message.hasComment === true,
      state: message.state ?? null,
      is_forwarded: Boolean(message.quotedMessage),
      quoted_message_id: message?.quotedMessage?.messageId?.value != null ? String(message.quotedMessage.messageId.value) : null,
      quoted_message_date_ms: Number.isFinite(Number(message?.quotedMessage?.messageDate)) ? Number(message.quotedMessage.messageDate) : null,
      quoted_text: safeText({ message: message?.quotedMessage?.quotedMessageContent || {} }),
      reaction_count: reactionState.reactions.reduce((sum, item) => sum + Number(item.count || 0), 0),
      my_reaction: reactionState.my_reaction,
      reactions: reactionState.reactions,
      attachments,
    };
    messageCache.set(cacheKey(peer, message.rid), message);
    return normalized;
  };

  const getDialog = async (peer) => {
    try { return await firstValue(core.dialogs.getPeerDialog(peer, { save: false })); }
    catch { return null; }
  };

  const getExPeerType = async (peer) => {
    const dialog = await getDialog(peer);
    const exact = Number(dialog?.exInfo?.exPeerType);
    if (Number.isFinite(exact)) return exact;
    return Number(peer.type) === 1 ? 1 : 3;
  };

  const exactExPeer = (peer, dialog, accessHash = "") => {
    const type = Number(dialog?.exInfo?.exPeerType);
    const id = Number(peer?.id);
    if (!Number.isSafeInteger(type) || !Number.isSafeInteger(id)) {
      throw codedError("BALE_EXPEER_UNAVAILABLE");
    }
    return { type, id, accessHash: String(accessHash) };
  };

  const pollObserved = async (read, matches, attempts = 12, delayMs = 200) => {
    let value;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      value = await read();
      if (matches(value)) return { value, matched: true };
      if (attempt + 1 < attempts) await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    return { value, matched: false };
  };

  const boundedErrorText = (error) => {
    const parts = [];
    if (error?.code !== undefined) parts.push(String(error.code));
    if (error?.message) parts.push(String(error.message));
    if (!parts.length) {
      try { parts.push(JSON.stringify(error)); } catch {}
    }
    return (parts.join(": ") || String(error || "BALE_WRITE_ERROR")).slice(0, 500);
  };

  const getMessage = async (handle) => {
    const parsed = parseMessageHandle(handle);
    const key = cacheKey(parsed.peer, parsed.rid);
    if (messageCache.has(key)) return { ...parsed, message: messageCache.get(key) };

    let message = null;
    try { message = await firstValue(core.messaging.getHistoryMessage(parsed.peer, parsed.rid)); } catch {}
    if (!message) {
      try {
        const rows = await firstValue(core.messaging.getLastMessages(parsed.peer, undefined), 15_000);
        message = (Array.isArray(rows) ? rows : []).find((item) => String(item?.rid) === parsed.rid) || null;
      } catch {}
    }
    if (!message) throw new Error("BALE_MESSAGE_NOT_FOUND");
    messageCache.set(key, message);
    return { ...parsed, message };
  };

  const getFreshReplyMessage = async (handle) => {
    const parsed = parseMessageHandle(handle);
    const wantedRid = String(parsed.rid);

    // Reply identity must come from Bale's remote history request, never from the
    // optimistic/local message cache. The provider enum LISTLOADMODE_BOTH is 3.
    // The input date is only a range anchor; the returned message carries the
    // canonical provider date used to construct the quoted MessageId.
    let rows;
    try {
      rows = await firstValue(
        core.messaging.loadHistoryFromRemote(parsed.peer, undefined, parsed.date, 3, 50),
        15_000
      );
    } catch {
      throw codedError(
        "BALE_REPLY_SOURCE_PROVIDER_READ_FAILED",
        "Bale remote history could not be read; no reply write was attempted."
      );
    }

    const message = (Array.isArray(rows) ? rows : [])
      .find((item) => String(item?.rid) === wantedRid) || null;
    if (!message) throw codedError(
      "BALE_REPLY_SOURCE_NOT_PROVIDER_RESOLVED",
      "Reply target was not present in Bale remote history; no write was attempted."
    );

    const canonicalDate = Number(message?.date || 0);
    if (!Number.isFinite(canonicalDate) || canonicalDate <= 0) {
      throw codedError("BALE_REPLY_SOURCE_IDENTITY_INVALID");
    }

    const canonicalHandle = messageHandle(parsed.peer, message);
    messageCache.set(cacheKey(parsed.peer, wantedRid), message);
    return {
      peer: parsed.peer,
      rid: wantedRid,
      date: canonicalDate,
      message,
      canonical_handle: canonicalHandle,
      identity_source: "loadHistoryFromRemote",
      input_handle: handle,
      identity_changed: canonicalHandle !== handle,
    };
  };

  const verifyFreshReply = async ({ peer, createdRid, expectedText, replyToHandle }) => {
    const target = parseMessageHandle(replyToHandle);
    if (target.peer.type !== peer.type || target.peer.id !== peer.id) {
      return { confirmed: false, reason: "reply_target_peer_mismatch" };
    }

    let lastObservation = null;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      let rows;
      try {
        rows = await firstValue(
          core.messaging.loadHistoryFromRemote(peer, undefined, Date.now(), 3, 50),
          15_000
        );
      } catch (error) {
        lastObservation = {
          confirmed: false,
          reason: "provider_read_failed",
          error: boundedErrorText(error),
        };
        if (attempt + 1 < 8) await new Promise((resolve) => setTimeout(resolve, 300));
        continue;
      }

      const message = (Array.isArray(rows) ? rows : [])
        .find((item) => String(item?.rid) === String(createdRid)) || null;
      if (!message) {
        lastObservation = { confirmed: false, reason: "created_message_not_in_remote_history" };
        if (attempt + 1 < 8) await new Promise((resolve) => setTimeout(resolve, 300));
        continue;
      }

      const quoted = message?.quotedMessage || null;
      const quotedRid = quoted?.messageId?.value == null ? null : String(quoted.messageId.value);
      const quotedDate = Number(quoted?.messageDate || 0);
      const quotedPeerId = Number(quoted?.quotedPeer?.id);
      const quotedPeerType = Number(quoted?.quotedPeer?.type);
      const textMatches = safeText(message) === String(expectedText);
      const quoteMatches =
        quotedRid === String(target.rid)
        && quotedDate === Number(target.date)
        && quotedPeerId === Number(target.peer.id)
        && quotedPeerType === Number(target.peer.type);

      lastObservation = {
        confirmed: textMatches && quoteMatches,
        reason: textMatches && quoteMatches ? "matched" : "postcondition_mismatch",
        message,
        observed_message_handle: messageHandle(peer, message),
        observed_text: safeText(message),
        observed_quote: {
          message_rid: quotedRid,
          message_date_ms: Number.isFinite(quotedDate) ? quotedDate : null,
          peer_id: Number.isFinite(quotedPeerId) ? quotedPeerId : null,
          peer_type: Number.isFinite(quotedPeerType) ? quotedPeerType : null,
        },
      };
      if (lastObservation.confirmed) return lastObservation;
      if (attempt + 1 < 8) await new Promise((resolve) => setTimeout(resolve, 300));
    }

    return lastObservation || { confirmed: false, reason: "provider_read_inconclusive" };
  };

  const randomRid = () => {
    const values = new Uint32Array(2);
    crypto.getRandomValues(values);
    let value = (BigInt(values[0]) << 32n) | BigInt(values[1]);
    value &= (1n << 63n) - 1n;
    if (value === 0n) value = BigInt(Date.now());
    return value.toString();
  };

  const quoteReference = (peer, message) => ({
    publicGroupId: undefined,
    quotedMessageContent: message?.message ?? undefined,
    senderUserId: Number.isFinite(Number(message?.senderUid)) ? Number(message.senderUid) : undefined,
    messageDate: Number(message?.date || 0),
    quotedPeer: { id: Number(peer.id), type: Number(peer.type), accessHash: "0" },
    messageId: { value: String(message?.rid ?? "") },
    authorSign: typeof message?.authorSign === "string" ? message.authorSign : "",
  });

  const textPending = (text, quotedMessage = undefined) => {
    const rid = randomRid();
    const date = Date.now();
    return {
      rid,
      date,
      message: { textMessage: { text: String(text), mentions: [], ext: undefined } },
      state: 1,
      senderUid: ownUserId(),
      isOut: true,
      reactions: [],
      type: "TEXT",
      authorSign: "",
      quotedMessage,
    };
  };

  const verifyRid = async (peer, rid) => {
    try {
      const direct = await firstValue(core.messaging.getHistoryMessage(peer, rid), 4_000);
      if (direct) return direct;
    } catch {}
    try {
      const rows = await firstValue(core.messaging.getLastMessages(peer, undefined), 8_000);
      return (Array.isArray(rows) ? rows : []).find((item) => String(item?.rid) === String(rid)) || null;
    } catch {
      return null;
    }
  };

  const findRawMessageByRid = (value, rid) => {
    const wantedRid = String(rid);
    const seen = new Set();
    const visit = (node, depth) => {
      if (!node || typeof node !== "object" || depth > 7 || seen.has(node)) return null;
      seen.add(node);
      const candidate = node.result && typeof node.result === "object" ? node.result : node;
      if (candidate?.rid !== undefined && candidate?.message && String(candidate.rid) === wantedRid) return candidate;
      for (const child of Object.values(node)) {
        if (!child || typeof child !== "object") continue;
        if (Array.isArray(child)) {
          for (const item of child.slice(0, 200)) {
            const found = visit(item, depth + 1);
            if (found) return found;
          }
        } else {
          const found = visit(child, depth + 1);
          if (found) return found;
        }
      }
      return null;
    };
    return visit(value, 0);
  };

  const searchProviderMessageByRid = async (peer, query, rid) => {
    const text = String(query || "").trim();
    if (!text) return null;
    try {
      const response = await firstValue(core.search.searchPeerMessages(peer, text, 0, 0, undefined), 15_000);
      const raw = findRawMessageByRid(response, rid);
      if (raw) messageCache.set(cacheKey(peer, rid), raw);
      return raw;
    } catch {
      return null;
    }
  };

  const walkMessages = (value, fallbackPeer, limit) => {
    const rows = [];
    const seenObjects = new Set();
    const seenMessages = new Set();
    const visit = (node, inheritedPeer, depth) => {
      if (!node || typeof node !== "object" || depth > 6 || rows.length >= limit) return;
      if (seenObjects.has(node)) return;
      seenObjects.add(node);
      const localPeer = node.peer && Number.isFinite(Number(node.peer.id)) && Number.isFinite(Number(node.peer.type))
        ? { id: Number(node.peer.id), type: Number(node.peer.type) }
        : inheritedPeer;
      const candidate = node.result && typeof node.result === "object" ? node.result : node;
      if (candidate?.rid !== undefined && candidate?.date !== undefined && candidate?.message && localPeer) {
        const key = chatHandle(localPeer) + ":" + String(candidate.rid);
        if (!seenMessages.has(key)) {
          seenMessages.add(key);
          const normalized = normalizeMessage(localPeer, candidate);
          if (normalized) rows.push(normalized);
        }
      }
      for (const child of Object.values(node)) {
        if (child && typeof child === "object") {
          if (Array.isArray(child)) {
            for (const item of child.slice(0, 100)) visit(item, localPeer, depth + 1);
          } else {
            visit(child, localPeer, depth + 1);
          }
        }
        if (rows.length >= limit) break;
      }
    };
    visit(value, fallbackPeer || null, 0);
    return rows.slice(0, limit);
  };

  if (op === "contact_search") {
    const query = String(args.query || "").trim();
    const limit = Math.max(1, Math.min(50, Number(args.limit) || 20));
    if (!query) throw new Error("BALE_SEARCH_QUERY_REQUIRED");
    const wanted = query.normalize("NFKC").toLowerCase();
    let rawContacts = [];
    try { rawContacts = await firstValue(core.users.getContacts(), 15_000) || []; } catch {}
    const peers = [];
    for (const item of Array.isArray(rawContacts) ? rawContacts : []) {
      const id = Number(item?.uid ?? item?.id ?? item);
      if (Number.isSafeInteger(id) && !peers.some((p) => p.id === id)) peers.push({ type: 1, id });
      if (peers.length >= 500) break;
    }
    let entities = { users: [] };
    if (peers.length) {
      try { entities = await firstValue(core.entities.loadPeers(peers), 15_000) || entities; } catch {}
    }
    const users = Array.isArray(entities?.users) ? entities.users : [];
    const results = [];
    const addUser = (user) => {
      const id = Number(user?.id ?? user?.uid);
      if (!Number.isSafeInteger(id) || results.some((x) => x.user_id === id)) return;
      const name = String(user?.name || user?.localName || user?.nick || user?.username || ("User " + id));
      const hay = [name, user?.nick, user?.username, user?.localName, String(id)]
        .filter(Boolean).join(" ").normalize("NFKC").toLowerCase();
      if (!hay.includes(wanted)) return;
      results.push({
        handle: chatHandle({ type: 1, id }),
        name: name.slice(0, 256),
        kind: "user",
        user_id: id,
        username: typeof user?.nick === "string" ? user.nick : (typeof user?.username === "string" ? user.username : null),
        local_name: typeof user?.localName === "string" ? user.localName : null,
        matched_on: [
          ["name", name],
          ["nick", user?.nick],
          ["username", user?.username],
          ["local_name", user?.localName],
          ["id", String(id)],
        ].filter(([, value]) => value != null && String(value).normalize("NFKC").toLowerCase().includes(wanted)).map(([field]) => field),
      });
    };
    for (const user of users) {
      addUser(user);
      if (results.length >= limit) break;
    }
    if (!results.length) {
      try {
        const found = await firstValue(core.users.searchUser(query), 8_000);
        const uid = Number(found?.uid);
        if (Number.isSafeInteger(uid)) {
          let user = null;
          try { user = await firstValue(core.users.loadUser(uid), 8_000); } catch {}
          addUser(user || { id: uid, name: query });
        }
      } catch {}
    }
    return { state: "ACHIEVED", provider: "bale", query, count: results.slice(0, limit).length, results: results.slice(0, limit) };
  }

  if (op === "message_get_local") {
    const source = await getMessage(args.message_handle);
    return {
      state: "ACHIEVED",
      provider: "bale",
      message: normalizeMessage(source.peer, source.message),
      source: "local_descriptor_only",
    };
  }

  if (op === "reaction_get") {
    const source = await getMessage(args.message_handle);
    const providerState = await readProviderReactionState(source);
    if (!providerState) throw new Error("BALE_REACTION_PROVIDER_READ_UNAVAILABLE");
    messageCache.delete(cacheKey(source.peer, source.rid));
    return {
      state: "ACHIEVED",
      provider: "bale",
      message_handle: args.message_handle,
      my_reaction: providerState.my_reaction,
      reactions: providerState.reactions,
      provider_fresh: true,
      verification_source: "getMessagesReactions",
    };
  }

  if (op === "mark_read" || op === "mark_unread") {
    const peer = parseChatHandle(args.conversation_handle);
    const before = await getDialog(peer);
    const beforeUnread = Math.max(0, Number(before?.unreadCount || 0));
    const beforeMarked = before?.markedAsUnread === true;
    const wantsUnread = op === "mark_unread";
    const alreadyDesired = wantsUnread ? beforeMarked : (beforeUnread === 0 && !beforeMarked);
    let observed = { value: before, matched: alreadyDesired };
    if (!alreadyDesired) {
      const exPeer = exactExPeer(peer, before, "");
      await firstValue(
        wantsUnread ? core.dialogs.markDialogsAsUnRead([exPeer]) : core.dialogs.markDialogsAsRead([exPeer]),
        15_000
      );
      observed = await pollObserved(
        () => getDialog(peer),
        (dialog) => wantsUnread
          ? dialog?.markedAsUnread === true
          : (Math.max(0, Number(dialog?.unreadCount || 0)) === 0 && dialog?.markedAsUnread !== true)
      );
    }
    const after = observed.value || await getDialog(peer);
    const afterUnread = Math.max(0, Number(after?.unreadCount || 0));
    const afterMarked = after?.markedAsUnread === true;
    return {
      state: alreadyDesired ? "ACKNOWLEDGED" : "IN_DOUBT",
      provider: "bale",
      operation: wantsUnread ? "mark_unread" : "mark_read",
      conversation_handle: chatHandle(peer),
      effect_attempted: !alreadyDesired,
      unread_count_before: beforeUnread,
      unread_count_after: afterUnread,
      marked_unread_before: beforeMarked,
      marked_unread_after: afterMarked,
      provider_confirmed: false,
      observed_same_runtime_postcondition: observed.matched,
      verification_note: "Dialog state is same-runtime and is not provider-fresh confirmation.",
    };
  }

  if (op === "conversation_search") {
    const query = String(args.query || "").trim();
    const limit = Math.max(1, Math.min(50, Number(args.limit) || 20));
    if (!query) throw new Error("BALE_SEARCH_QUERY_REQUIRED");
    const peers = [];
    const addPeer = (type, id) => {
      const peer = { type: Number(type), id: Number(id) };
      if (!Number.isSafeInteger(peer.type) || !Number.isSafeInteger(peer.id)) return;
      if (!peers.some((item) => item.type === peer.type && item.id === peer.id)) peers.push(peer);
    };

    try {
      const user = await firstValue(core.users.searchUser(query), 8_000);
      if (Number.isSafeInteger(Number(user?.uid))) addPeer(1, user.uid);
    } catch {}

    try {
      const remote = await firstValue(core.search.globalChannelSearch(query), 10_000);
      for (const item of Array.isArray(remote?.userPeers) ? remote.userPeers : []) addPeer(1, item?.id ?? item);
      for (const item of Array.isArray(remote?.groupPeers) ? remote.groupPeers : []) addPeer(2, item?.id ?? item);
    } catch {}

    let entities = { users: [], groups: [] };
    if (peers.length) {
      try { entities = await firstValue(core.entities.loadPeers(peers), 10_000) || entities; } catch {}
    }
    const users = new Map((entities?.users || []).map((item) => [Number(item.id), item]));
    const groups = new Map((entities?.groups || []).map((item) => [Number(item.id), item]));
    const results = peers.slice(0, limit).map((peer) => {
      const entity = peer.type === 1 ? users.get(peer.id) : groups.get(peer.id);
      const name = peer.type === 1
        ? (entity?.name || entity?.localName || entity?.nick || ("User " + peer.id))
        : (entity?.title || entity?.nick || ("Group " + peer.id));
      return {
        handle: chatHandle(peer),
        name: String(name).slice(0, 256),
        kind: peer.type === 1 ? "user" : "group",
        peer_type: peer.type,
      };
    });
    return { state: "ACHIEVED", provider: "bale", query, count: results.length, results };
  }

  if (op === "message_list") {
    const peer = parseChatHandle(args.conversation_handle);
    const limit = Math.max(1, Math.min(100, Number(args.limit) || 10));
    const before = await getDialog(peer);
    const rows = await firstValue(core.messaging.getLastMessages(peer, undefined), 15_000);
    const byRid = new Map();
    for (const item of Array.isArray(rows) ? rows : []) {
      if (!item || item.rid === undefined) continue;
      const key = String(item.rid);
      const existing = byRid.get(key);
      if (!existing || Number(item.date || 0) >= Number(existing.date || 0)) byRid.set(key, item);
    }
    const messages = [...byRid.values()]
      .sort((a, b) => Number(b.date || 0) - Number(a.date || 0))
      .slice(0, limit)
      .map((item) => {
        const cached = messageCache.get(cacheKey(peer, item.rid));
        return normalizeMessage(peer, cached || item);
      })
      .filter(Boolean);
    const after = await getDialog(peer);
    return {
      state: "ACHIEVED",
      provider: "bale",
      conversation_handle: chatHandle(peer),
      count: messages.length,
      ordering: "newest_first",
      read_state_unchanged:
        Number(before?.unreadCount ?? 0) === Number(after?.unreadCount ?? 0)
        && Boolean(before?.markedAsUnread) === Boolean(after?.markedAsUnread),
      messages,
    };
  }

  if (op === "message_search") {
    const query = String(args.query || "").trim();
    const limit = Math.max(1, Math.min(50, Number(args.limit) || 20));
    if (!query) throw new Error("BALE_SEARCH_QUERY_REQUIRED");
    let response;
    let peer = null;
    if (args.conversation_handle) {
      peer = parseChatHandle(args.conversation_handle);
      response = await firstValue(core.search.searchPeerMessages(peer, query, 0, 0, undefined), 15_000);
    } else {
      response = await firstValue(core.search.allMessagesSearch(query), 15_000);
    }
    let results = walkMessages(response, peer, limit);
    let resultSource = results.length ? "provider_search" : null;
    if (!results.length && peer) {
      try {
        const rows = await firstValue(core.messaging.getLastMessages(peer, undefined), 15_000);
        const wanted = query.normalize("NFKC").toLowerCase();
        const seen = new Set();
        results = (Array.isArray(rows) ? rows : [])
          .filter((item) => {
            if (!item || item.rid === undefined) return false;
            const key = String(item.rid);
            if (seen.has(key)) return false;
            seen.add(key);
            return safeText(item).normalize("NFKC").toLowerCase().includes(wanted);
          })
          .sort((a, b) => Number(b.date || 0) - Number(a.date || 0))
          .slice(0, limit)
          .map((item) => normalizeMessage(peer, item))
          .filter(Boolean);
        if (results.length) resultSource = "local_history_fallback";
      } catch {}
    }
    return {
      state: "ACHIEVED",
      provider: "bale",
      query,
      scope: peer ? "CONVERSATION" : "GLOBAL",
      conversation_handle: peer ? chatHandle(peer) : null,
      count: results.length,
      results,
      source: resultSource,
      fallback: resultSource === "local_history_fallback" ? "local_history" : null,
    };
  }

  if (op === "send_text" || op === "reply_text") {
    const peer = parseChatHandle(args.conversation_handle);
    const text = String(args.text || "");
    if (!text) throw new Error("BALE_TEXT_REQUIRED");
    const exPeerType = await getExPeerType(peer);
    let quote;
    let replyTo = null;
    let replyIdentity = null;
    if (op === "reply_text") {
      const source = await getFreshReplyMessage(args.message_handle);
      if (source.peer.type !== peer.type || source.peer.id !== peer.id) throw new Error("BALE_REPLY_PEER_MISMATCH");
      quote = quoteReference(peer, source.message);
      replyTo = source.canonical_handle;
      replyIdentity = {
        input_message_handle: source.input_handle,
        canonical_message_handle: source.canonical_handle,
        identity_source: source.identity_source,
        identity_changed: source.identity_changed,
      };
    }
    const pending = textPending(text, quote);
    let ack;
    let dispatchError = null;
    try {
      await firstValue(core.messaging.addPendingMessages(peer, undefined, [pending], true), 10_000);
      ack = await firstValue(
        core.messaging.sendTextMessage(pending, peer, exPeerType, undefined),
        20_000
      );
    } catch (error) {
      dispatchError = boundedErrorText(error);
      try {
        await firstValue(core.messaging.updateMessagesOnDeletePendingMessage(peer, [pending.rid]), 8_000);
      } catch {}
    }
    await new Promise((resolve) => setTimeout(resolve, 240));

    let replyVerification = null;
    if (op === "reply_text" && replyTo) {
      replyVerification = await verifyFreshReply({
        peer,
        createdRid: pending.rid,
        expectedText: text,
        replyToHandle: replyTo,
      });
    }

    const providerVerified = op === "reply_text"
      ? (replyVerification?.confirmed ? replyVerification.message : null)
      : await searchProviderMessageByRid(peer, text, pending.rid);
    const verified = providerVerified || await verifyRid(peer, pending.rid);
    if (verified) messageCache.set(cacheKey(peer, pending.rid), verified);

    const replyConfirmed = op === "reply_text" && replyVerification?.confirmed === true;
    return {
      state: replyConfirmed ? "ACHIEVED" : "IN_DOUBT",
      provider: "bale",
      operation: op === "reply_text" ? "reply" : "send",
      conversation_handle: chatHandle(peer),
      reply_to_message_handle: replyTo,
      reply_identity: replyIdentity,
      created_message_handle: verified ? messageHandle(peer, verified) : messageHandle(peer, { rid: pending.rid, date: Number(ack?.date || pending.date) }),
      effect_attempted: true,
      provider_acknowledged: dispatchError === null,
      provider_confirmed: replyConfirmed,
      provider_fresh: replyConfirmed,
      verification_source: replyConfirmed ? "loadHistoryFromRemote" : null,
      provider_observation_candidate: Boolean(providerVerified),
      reply_verification: op === "reply_text" && replyVerification ? {
        confirmed: replyVerification.confirmed === true,
        reason: replyVerification.reason,
        observed_message_handle: replyVerification.observed_message_handle || null,
        observed_text: replyVerification.observed_text || null,
        observed_quote: replyVerification.observed_quote || null,
      } : null,
      dispatch_error: dispatchError,
      retry_safe: replyConfirmed,
      verification_note: replyConfirmed
        ? "Reply postcondition was independently confirmed from Bale remote history."
        : (dispatchError
          ? "Dispatch ended ambiguously and fresh remote-history verification was inconclusive. Do not retry blindly."
          : (op === "reply_text"
            ? "Reply dispatch completed, but fresh remote-history verification was inconclusive."
            : "Provider search observation is not yet independently qualified as a canonical write verifier.")),
    };
  }

  if (op === "edit_message") {
    const source = await getMessage(args.message_handle);
    const text = String(args.text ?? "");
    const current = source.message;
    let payload;
    if (current?.message?.textMessage) {
      payload = {
        ...current.message,
        textMessage: { ...current.message.textMessage, text, mentions: [] },
      };
    } else if (current?.message?.documentMessage) {
      payload = {
        ...current.message,
        documentMessage: {
          ...current.message.documentMessage,
          caption: { ...(current.message.documentMessage.caption || {}), text, mentions: [] },
        },
      };
    } else {
      throw new Error("BALE_EDIT_UNSUPPORTED_MESSAGE_TYPE");
    }
    const updated = { ...current, message: payload };
    await firstValue(core.messaging.updateMessage(source.peer, updated), 20_000);
    await new Promise((resolve) => setTimeout(resolve, 160));
    const providerVerified = await searchProviderMessageByRid(source.peer, text, source.rid);
    const verified = providerVerified || await verifyRid(source.peer, source.rid);
    if (verified) messageCache.set(cacheKey(source.peer, source.rid), verified);
    return {
      state: "IN_DOUBT",
      provider: "bale",
      operation: "edit",
      message_handle: args.message_handle,
      provider_acknowledged: true,
      provider_confirmed: false,
      provider_observation_candidate: Boolean(providerVerified && safeText(providerVerified) === text),
      verification_note: "Provider search observation is not yet independently qualified as a canonical write verifier.",
      text: verified ? safeText(verified) : text,
    };
  }

  if (op === "react_message") {
    const source = await getMessage(args.message_handle);
    const code = normalizeReactionCode(args.emoji);
    if (!code) throw new Error("BALE_REACTION_REQUIRED");
    const date = Number(source.message.date || source.date);
    if (args.remove === true) {
      await firstValue(core.messaging.removeReaction(source.peer, code, source.rid, date), 20_000);
    } else {
      await firstValue(core.messaging.addReaction(source.peer, code, source.rid, date), 20_000);
    }
    return {
      state: "ACKNOWLEDGED",
      provider: "bale",
      operation: "react",
      message_handle: args.message_handle,
      effect_attempted: true,
      provider_acknowledged: true,
      provider_confirmed: false,
      requested_reaction: code,
      remove: args.remove === true,
    };
  }

  if (op === "forward_message") {
    const source = await getMessage(args.message_handle);
    const destPeer = parseChatHandle(args.target_handle);
    const exPeerType = await getExPeerType(destPeer);
    const rid = randomRid();
    const quote = source.message?.quotedMessage || quoteReference(source.peer, source.message);
    const forwarded = {
      ...source.message,
      rid,
      date: Date.now(),
      senderUid: ownUserId(),
      isOut: true,
      state: 1,
      reactions: [],
      quotedMessage: quote,
      message: { emptyMessage: {} },
      previousMessageId: undefined,
      nextMessageId: undefined,
      editedAt: undefined,
      editorUserId: undefined,
      authorSign: undefined,
    };
    try {
      await firstValue(core.messaging.addPendingMessages(destPeer, undefined, [forwarded]), 10_000);
      await firstValue(
        core.messaging.forwardMessages(
          destPeer,
          exPeerType,
          [forwarded],
          source.message?.groupedId?.value,
          false
        ),
        20_000
      );
    } catch (error) {
      try {
        await firstValue(core.messaging.updateMessagesOnDeletePendingMessage(destPeer, [rid]), 8_000);
      } catch {}
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 180));
    const sourceText = safeText(source.message);
    const providerVerified = sourceText
      ? await searchProviderMessageByRid(destPeer, sourceText, rid)
      : null;
    const verified = providerVerified || await verifyRid(destPeer, rid);
    if (verified) messageCache.set(cacheKey(destPeer, rid), verified);
    return {
      state: "IN_DOUBT",
      provider: "bale",
      operation: "forward",
      source_message_handle: args.message_handle,
      target_handle: chatHandle(destPeer),
      created_message_handle: verified ? messageHandle(destPeer, verified) : messageHandle(destPeer, forwarded),
      provider_acknowledged: true,
      provider_confirmed: false,
      provider_observation_candidate: Boolean(providerVerified),
      verification_note: "Provider search observation is not yet independently qualified as a canonical write verifier.",
    };
  }

  if (op === "mute_conversation") {
    const peer = parseChatHandle(args.conversation_handle);
    const desiredMuted = args.muted === true;
    const beforeEnabled = await core.dialogs.isChatNotificationEnabledAsync(peer);
    const desiredEnabled = !desiredMuted;
    if (Boolean(beforeEnabled) === desiredEnabled) {
      return {
        state: "ACKNOWLEDGED",
        provider: "bale",
        operation: "mute",
        conversation_handle: chatHandle(peer),
        muted: desiredMuted,
        effect_attempted: false,
        provider_confirmed: false,
        observed_same_runtime_postcondition: true,
        verification_note: "Notification state is same-runtime and is not provider-fresh confirmation.",
      };
    }
    await firstValue(core.dialogs.changeChatNotification(peer, desiredEnabled), 12_000);
    const observed = await pollObserved(
      () => core.dialogs.isChatNotificationEnabledAsync(peer),
      (enabled) => Boolean(enabled) === desiredEnabled
    );
    return {
      state: "IN_DOUBT",
      provider: "bale",
      operation: "mute",
      conversation_handle: chatHandle(peer),
      muted: !Boolean(observed.value),
      effect_attempted: true,
      provider_confirmed: false,
      observed_same_runtime_postcondition: observed.matched,
      verification_note: "Notification state is same-runtime and is not provider-fresh confirmation.",
    };
  }

  if (op === "pin_conversation") {
    const peer = parseChatHandle(args.conversation_handle);
    const desiredPinned = args.pinned === true;
    const dialog = await getDialog(peer);
    const exPeer = exactExPeer(peer, dialog, "0");
    const readPinned = async () => {
      const rows = await firstValue(core.dialogs.loadPinnedDialogs(0), 12_000);
      return (Array.isArray(rows) ? rows : []).some((item) =>
        Number(item?.peer?.id) === Number(peer.id) && Number(item?.peer?.type) === Number(peer.type)
      );
    };
    const beforePinned = await readPinned();
    if (beforePinned === desiredPinned) {
      return {
        state: "ACKNOWLEDGED",
        provider: "bale",
        operation: desiredPinned ? "pin" : "unpin",
        conversation_handle: chatHandle(peer),
        pinned: beforePinned,
        effect_attempted: false,
        provider_acknowledged: true,
        provider_confirmed: false,
        observed_same_runtime_postcondition: true,
        verification_note: "Pinned-dialog state is same-runtime and is not provider-fresh confirmation.",
      };
    }
    if (desiredPinned) {
      await firstValue(core.dialogs.pinDialogs([exPeer], 0), 20_000);
    } else {
      await firstValue(core.dialogs.unPinDialogs([exPeer], 0), 20_000);
    }
    const observed = await pollObserved(readPinned, (pinned) => pinned === desiredPinned);
    return {
      state: "IN_DOUBT",
      provider: "bale",
      operation: desiredPinned ? "pin" : "unpin",
      conversation_handle: chatHandle(peer),
      pinned: Boolean(observed.value),
      effect_attempted: true,
      provider_acknowledged: true,
      provider_confirmed: false,
      observed_same_runtime_postcondition: observed.matched,
      verification_note: "Pinned-dialog state is same-runtime and is not provider-fresh confirmation.",
    };
  }

  if (op === "delete_message") {
    const source = await getMessage(args.message_handle);
    const forEveryone = args.for_everyone === true;
    const beforeText = safeText(source.message);
    await firstValue(
      core.messaging.deleteMessages(
        source.peer,
        [source.rid],
        [Number(source.message.date || source.date)],
        !forEveryone
      ),
      20_000
    );
    messageCache.delete(cacheKey(source.peer, source.rid));
    await new Promise((resolve) => setTimeout(resolve, 160));
    let providerConfirmed = null;
    if (beforeText) {
      try {
        const response = await firstValue(core.search.searchPeerMessages(source.peer, beforeText, 0, 0, undefined), 15_000);
        providerConfirmed = !findRawMessageByRid(response, source.rid);
      } catch {}
    }
    return {
      state: "IN_DOUBT",
      provider: "bale",
      operation: "delete",
      message_handle: args.message_handle,
      for_everyone: forEveryone,
      provider_acknowledged: true,
      provider_confirmed: false,
      provider_observation_candidate: providerConfirmed === true,
      verification_note: "Provider search absence is not yet independently qualified as a canonical delete verifier.",
    };
  }


  if (op === "message_replies") {
    const source = await getFreshReplyMessage(args.message_handle);
    const peer = source.peer;
    const limit = Math.max(1, Math.min(100, Number(args.limit) || 50));
    const before = await getDialog(peer);
    const sourceRid = String(source.rid);
    const sourceDate = Number(source.date);
    const declaredReplyCount = Number(source.message?.replies?.repliesCount);
    let replies = [];
    let semantics = "reply_chain";
    let providerPath = null;
    let scanComplete = false;
    let scannedMessages = 0;
    let pagesRead = 0;

    // When Bale exposes an actual comment/reply thread for the message, use the
    // provider's native LoadReplies path. This preserves the whole chain even
    // when later replies quote earlier replies rather than the root message.
    if (
      Number(peer.type) === 2
      && Number.isFinite(declaredReplyCount)
      && declaredReplyCount > 0
    ) {
      try {
        const thread = {
          messageId: { rid: sourceRid, date: sourceDate, seq: "0" },
          threadType: "COMMENT",
        };
        const rows = await firstValue(
          core.messaging.loadReplies(peer, thread, sourceDate, 1, Math.min(100, Math.max(limit, declaredReplyCount))),
          15_000
        );
        replies = (Array.isArray(rows) ? rows : [])
          .map((item) => normalizeMessage(peer, item))
          .filter(Boolean);
        scannedMessages = replies.length;
        pagesRead = 1;
        scanComplete = replies.length >= declaredReplyCount || declaredReplyCount <= 100;
        providerPath = "loadReplies";
        semantics = "provider_reply_thread";
      } catch {}
    }

    // Ordinary chats do not necessarily expose a separate thread object. In
    // that case, reconstruct the chain from fresh provider history using the
    // root replyToTopId when present, with direct quoted-message identity as a
    // fallback. Local cache/DOM state is never authoritative for this read.
    if (!providerPath) {
      const seen = new Set();
      const found = [];
      let anchor = Date.now();

      for (let pageIndex = 0; pageIndex < 10; pageIndex += 1) {
        const rows = await firstValue(
          core.messaging.loadHistoryFromRemote(peer, undefined, anchor, 3, 100),
          15_000
        );
        pagesRead += 1;
        if (!Array.isArray(rows) || !rows.length) {
          scanComplete = true;
          break;
        }

        let minDate = Number.POSITIVE_INFINITY;
        let newRows = 0;
        for (const item of rows) {
          const rid = String(item?.rid ?? "");
          const date = Number(item?.date || 0);
          if (Number.isFinite(date) && date > 0) minDate = Math.min(minDate, date);
          if (!rid || seen.has(rid)) continue;
          seen.add(rid);
          newRows += 1;
          scannedMessages += 1;

          const top = item?.replyToTopId || null;
          const topRid = top?.rid == null ? null : String(top.rid);
          const topDate = Number(top?.date || 0);
          const quoted = item?.quotedMessage || null;
          const quotedRid = quoted?.messageId?.value == null ? null : String(quoted.messageId.value);
          const quotedDate = Number(quoted?.messageDate || 0);
          const quotedPeerId = Number(quoted?.quotedPeer?.id);
          const quotedPeerType = Number(quoted?.quotedPeer?.type);

          const sameTop =
            topRid === sourceRid
            && topDate === sourceDate;
          const directQuote =
            quotedRid === sourceRid
            && quotedDate === sourceDate
            && quotedPeerId === Number(peer.id)
            && quotedPeerType === Number(peer.type);

          if (sameTop || directQuote) {
            const normalized = normalizeMessage(peer, item);
            if (normalized) found.push(normalized);
          }
        }

        if (Number.isFinite(minDate) && minDate <= sourceDate) {
          scanComplete = true;
          break;
        }
        const nextAnchor = Number.isFinite(minDate) ? minDate - 1 : anchor - 1;
        if (!newRows || nextAnchor >= anchor) break;
        anchor = nextAnchor;
      }
      replies = found;
      providerPath = "loadHistoryFromRemote";
      semantics = "provider_reply_chain";
    }

    const deduped = [];
    const replyRids = new Set();
    for (const item of replies) {
      const rid = String(item?.rid || "");
      if (!rid || replyRids.has(rid)) continue;
      replyRids.add(rid);
      deduped.push(item);
    }
    deduped.sort((a, b) => Number(a?.date_ms || 0) - Number(b?.date_ms || 0));

    const after = await getDialog(peer);
    const returned = deduped.slice(0, limit);
    const readStateUnchanged =
      Number(before?.unreadCount ?? 0) === Number(after?.unreadCount ?? 0)
      && Boolean(before?.markedAsUnread) === Boolean(after?.markedAsUnread);

    return {
      state: "ACHIEVED",
      provider: "bale",
      message_handle: source.canonical_handle,
      semantics,
      provider_path: providerPath,
      reply_count: Number.isFinite(declaredReplyCount) && declaredReplyCount >= 0
        ? Math.max(declaredReplyCount, deduped.length)
        : (scanComplete ? deduped.length : null),
      reply_count_lower_bound: deduped.length,
      returned_count: returned.length,
      ordering: "chronological",
      continuation_ready:
        (Number.isFinite(declaredReplyCount) && declaredReplyCount > returned.length)
        || !scanComplete
        || deduped.length > limit,
      scan_complete: scanComplete,
      scanned_messages: scannedMessages,
      pages_read: pagesRead,
      provider_fresh: true,
      verification_source: providerPath,
      read_state_unchanged: readStateUnchanged,
      replies: returned,
    };
  }

  if (op === "send_uploaded_voice") {
    const peer = parseChatHandle(args.conversation_handle);
    const exPeerType = await getExPeerType(peer);
    const rid = randomRid();
    const date = Date.now();
    const durationMs = Math.max(1, Math.floor(Number(args.duration_ms) || 0));
    const expectedSize = Number(args.size_bytes);
    const expectedMime = String(args.media_type || "audio/ogg");
    if (!Number.isSafeInteger(expectedSize) || expectedSize < 1) throw new Error("BALE_VOICE_SIZE_INVALID");

    const senderUid = ownUserId();
    const documentAccessHash = Number(exPeerType) === 3 ? String(peer.id) : String(senderUid);

    const pending = {
      rid,
      date,
      message: {
        documentMessage: {
          fileId: String(args.file_id),
          accessHash: documentAccessHash,
          fileSize: expectedSize,
          mimeType: expectedMime,
          name: String(args.filename || "voice.ogg"),
          ext: { documentExVoice: { duration: durationMs } },
          caption: { text: "", mentions: [], ext: undefined },
          isUploading: false,
          isCompressing: false,
        },
      },
      state: 1,
      senderUid,
      isOut: true,
      reactions: [],
      type: "VOICE",
      authorSign: "",
    };

    let dispatchError = null;
    try {
      await firstValue(core.messaging.addPendingMessages(peer, undefined, [pending], true), 10_000);
      await firstValue(core.messaging.sendDocumentMessage(peer, pending, exPeerType, undefined), 25_000);
    } catch (error) {
      dispatchError = boundedErrorText(error);
    }

    let observed = null;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      try {
        const rows = await firstValue(
          core.messaging.loadHistoryFromRemote(peer, undefined, Date.now(), 3, 50),
          15_000
        );
        const message = (Array.isArray(rows) ? rows : [])
          .find((item) => String(item?.rid) === String(rid)) || null;
        if (message) {
          const doc = message?.message?.documentMessage || null;
          const voice = doc?.ext?.documentExVoice || null;
          const observedSize = Number(doc?.fileSize);
          const observedDuration = Number(voice?.duration || 0);
          const observedMime = String(doc?.mimeType || "");
          const confirmed =
            Boolean(voice)
            && observedSize === expectedSize
            && observedDuration > 0
            && (observedMime.includes("ogg") || observedMime.includes("opus") || observedMime.includes("wav"));
          observed = {
            confirmed,
            message,
            message_handle: messageHandle(peer, message),
            size_bytes: Number.isFinite(observedSize) ? observedSize : null,
            duration_ms: Number.isFinite(observedDuration) ? observedDuration : null,
            media_type: observedMime || null,
          };
          if (confirmed) break;
        }
      } catch {}
      if (attempt + 1 < 8) await new Promise((resolve) => setTimeout(resolve, 350));
    }

    if (observed?.message) messageCache.set(cacheKey(peer, rid), observed.message);
    const confirmed = observed?.confirmed === true;
    return {
      state: confirmed ? "ACHIEVED" : "IN_DOUBT",
      provider: "bale",
      operation: "voice_send",
      conversation_handle: chatHandle(peer),
      created_message_handle: observed?.message_handle || messageHandle(peer, pending),
      voice_message: true,
      effect_attempted: true,
      provider_acknowledged: dispatchError === null,
      provider_confirmed: confirmed,
      provider_fresh: confirmed,
      verification_source: confirmed ? "loadHistoryFromRemote" : null,
      observed_voice: observed ? {
        size_bytes: observed.size_bytes,
        duration_ms: observed.duration_ms,
        media_type: observed.media_type,
      } : null,
      dispatch_error: dispatchError,
      retry_safe: confirmed,
      verification_note: confirmed
        ? "Native Bale Voice Message was independently confirmed from fresh remote history."
        : "Voice dispatch is not independently confirmed; do not retry blindly.",
    };
  }

  if (op === "attachment_prepare_download") {
    const source = await getMessage(args.message_handle);
    const files = fileCandidates(source.message);
    const index = Math.max(1, Number(args.attachment_index) || 1);
    const selected = files[index - 1];
    if (!selected) throw new Error("BALE_ATTACHMENT_NOT_FOUND");

    const attempts = [selected.location];
    const doc = source.message?.message?.documentMessage;
    if (doc && doc !== selected.location && doc.fileId !== undefined) {
      attempts.push({
        fileId: String(doc.fileId),
        accessHash: doc.accessHash !== undefined ? String(doc.accessHash) : undefined,
        fileStorageVersion: Number.isFinite(Number(doc.fileStorageVersion)) ? Number(doc.fileStorageVersion) : undefined,
      });
    }
    let resolved = null;
    let lastError = null;
    for (const location of attempts) {
      try {
        let value = null;
        try {
          value = await firstValue(core.filesModule.loadFileUrl(location), 12_000);
        } catch {}
        if (!value) {
          value = await firstValue(core.filesModule.getFileDownloadUrl(location), 12_000);
        }
        const url =
          typeof value === "string" ? value
          : (typeof value?.url === "string" ? value.url
            : (typeof value?.fileUrl?.url === "string" ? value.fileUrl.url
              : (Array.isArray(value?.fileUrls) && typeof value.fileUrls[0]?.url === "string"
                ? value.fileUrls[0].url
                : null)));
        if (url) { resolved = { value, url }; break; }
      } catch (error) {
        lastError = error;
      }
    }
    if (!resolved) throw lastError || new Error("BALE_ATTACHMENT_URL_UNAVAILABLE");
    return {
      state: "ACHIEVED",
      provider: "bale",
      message_handle: args.message_handle,
      attachment_index: index,
      attachment_count: files.length,
      filename: selected.filename,
      media_type: selected.media_type,
      size_bytes: selected.size_bytes,
      download_url: resolved.url,
    };
  }

  if (op === "prepare_file_upload") {
    const peer = parseChatHandle(args.conversation_handle);
    const size = Number(args.size_bytes);
    const filename = String(args.filename || "upload.bin");
    const mediaType = String(args.media_type || "application/octet-stream");
    if (!Number.isSafeInteger(size) || size < 1) throw new Error("BALE_FILE_SIZE_INVALID");
    const dialog = await getDialog(peer);
    const exPeer = exactExPeer(peer, dialog);
    const value = await firstValue(core.filesModule.getUploadUrl(size, filename, mediaType, exPeer, undefined), 15_000);
    if (!value || typeof value.url !== "string" || value.fileId === undefined || value.fileId === null) {
      throw new Error("BALE_UPLOAD_URL_INVALID");
    }
    return {
      state: "ACHIEVED",
      provider: "bale",
      conversation_handle: chatHandle(peer),
      upload_url: value.url,
      file_id: String(value.fileId),
      chunk_size: Number.isSafeInteger(Number(value.chunkSize)) ? Number(value.chunkSize) : null,
    };
  }

  if (op === "send_uploaded_file") {
    const peer = parseChatHandle(args.conversation_handle);
    const exPeerType = await getExPeerType(peer);
    const rid = randomRid();
    const date = Date.now();
    const caption = String(args.caption || "");
    const pending = {
      rid,
      date,
      message: {
        documentMessage: {
          fileId: String(args.file_id),
          fileSize: Number(args.size_bytes),
          mimeType: String(args.media_type || "application/octet-stream"),
          name: String(args.filename || "upload.bin"),
          caption: { text: caption, mentions: [], ext: undefined },
          isUploading: false,
          isCompressing: false,
        },
      },
      state: 1,
      senderUid: ownUserId(),
      isOut: true,
      reactions: [],
      type: "DOCUMENT",
      authorSign: "",
    };
    await firstValue(core.messaging.addPendingMessages(peer, undefined, [pending]), 10_000);
    await firstValue(core.messaging.sendDocumentMessage(peer, pending, exPeerType, undefined), 25_000);
    await new Promise((resolve) => setTimeout(resolve, 180));
    const verified = await verifyRid(peer, rid);
    if (verified) messageCache.set(cacheKey(peer, rid), verified);
    return {
      state: "IN_DOUBT",
      provider: "bale",
      operation: "file_send",
      conversation_handle: chatHandle(peer),
      created_message_handle: verified ? messageHandle(peer, verified) : messageHandle(peer, pending),
      provider_acknowledged: true,
      provider_confirmed: false,
      observed_same_runtime_postcondition: Boolean(verified),
      verification_note: "Same-runtime history observation is not provider-fresh confirmation.",
    };
  }

  if (op === "baseline_read_canary") {
    const peer = parseChatHandle(args.conversation_handle);
    const before = await getDialog(peer);
    const rows = await firstValue(core.messaging.getLastMessages(peer, undefined), 15_000);
    const sample = (Array.isArray(rows) ? rows : []).slice(-3).map((item) => normalizeMessage(peer, item)).filter(Boolean);
    const after = await getDialog(peer);
    return {
      state: "ACHIEVED",
      provider: "bale",
      message_list_ready: Array.isArray(rows),
      normalized_sample_count: sample.length,
      unread_before: Number(before?.unreadCount ?? 0),
      unread_after: Number(after?.unreadCount ?? 0),
      read_state_unchanged:
        Number(before?.unreadCount ?? 0) === Number(after?.unreadCount ?? 0)
        && Boolean(before?.markedAsUnread) === Boolean(after?.markedAsUnread),
    };
  }

  throw new Error("BALE_OPERATION_UNSUPPORTED");
};



function normalizeBaleName(value) {
  return String(value || "")
    .normalize("NFKC")
    .replace(/\u064A/g, "\u06CC")
    .replace(/\u0643/g, "\u06A9")
    .replace(/[\u200c\u200d]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

async function runBaleCore(op, args = {}, { cdpUrl = DEFAULT_CDP_URL } = {}) {
  const page = await balePage(cdpUrl);
  try {
    return await page.evaluate(BALE_CORE_OPERATION_IN_PAGE, { op, args });
  } catch (cause) {
    const raw = String(cause?.message || cause || "");
    const codeMatch = raw.match(/\b(BALE_[A-Z0-9_]+)\b/);
    const error = codedError(codeMatch?.[1] || "BALE_OPERATION_FAILED", raw.slice(0, 300) || "Bale operation failed.");
    error.cause = cause;
    throw error;
  }
}

async function searchBaleConversations(query, limit = 20, { cdpUrl = DEFAULT_CDP_URL } = {}) {
  const wanted = normalizeBaleName(query);
  if (!wanted) throw codedError("BALE_SEARCH_QUERY_REQUIRED");
  const [recent, provider] = await Promise.all([
    listBaleConversations(50, { cdpUrl }),
    runBaleCore("conversation_search", { query, limit }, { cdpUrl }).catch(() => ({ results: [] })),
  ]);
  const merged = [];
  const seen = new Set();
  for (const item of [...(recent.conversations || []), ...(provider.results || [])]) {
    const handle = String(item?.handle || "");
    if (!handle || seen.has(handle)) continue;
    const name = normalizeBaleName(item?.name);
    if (!name.includes(wanted) && !wanted.includes(name)) continue;
    seen.add(handle);
    merged.push(item);
  }
  merged.sort((a, b) => {
    const an = normalizeBaleName(a.name);
    const bn = normalizeBaleName(b.name);
    const as = an === wanted ? 0 : (an.startsWith(wanted) ? 1 : 2);
    const bs = bn === wanted ? 0 : (bn.startsWith(wanted) ? 1 : 2);
    return as - bs;
  });
  return {
    state: "ACHIEVED",
    provider: "bale",
    query: String(query),
    count: Math.min(limit, merged.length),
    results: merged.slice(0, limit),
  };
}

async function resolveBaleConversationRef(value, { cdpUrl = DEFAULT_CDP_URL } = {}) {
  const text = String(value || "").trim();
  if (!text) throw codedError("BALE_CONVERSATION_REQUIRED");
  if (/^balechat:\d+:-?\d+$/.test(text)) return text;

  const wanted = normalizeBaleName(text);
  const recent = await listBaleConversations(50, { cdpUrl });
  const personalAliases = new Set([
    normalizeBaleName("فضای شخصی"),
    normalizeBaleName("پیام های ذخیره شده"),
    normalizeBaleName("پیام‌های ذخیره‌شده"),
    normalizeBaleName("saved messages"),
  ]);
  if (personalAliases.has(wanted)) {
    const saved = (recent.conversations || []).find((item) => normalizeBaleName(item.name) === normalizeBaleName("Saved Messages"));
    if (saved?.handle) return saved.handle;
  }
  const exactRecent = (recent.conversations || []).filter((item) => normalizeBaleName(item.name) === wanted);
  if (exactRecent.length === 1) return exactRecent[0].handle;
  if (exactRecent.length > 1) {
    const error = codedError("BALE_CONVERSATION_AMBIGUOUS");
    error.candidates = exactRecent.slice(0, 10);
    throw error;
  }

  const searched = await searchBaleConversations(text, 20, { cdpUrl });
  const exact = searched.results.filter((item) => normalizeBaleName(item.name) === wanted);
  if (exact.length === 1) return exact[0].handle;
  if (exact.length > 1) {
    const error = codedError("BALE_CONVERSATION_AMBIGUOUS");
    error.candidates = exact.slice(0, 10);
    throw error;
  }

  const contacts = await runBaleCore("contact_search", { query: text, limit: 20 }, { cdpUrl })
    .catch(() => ({ results: [] }));
  const exactContacts = (contacts.results || []).filter((item) => {
    const fields = [item?.name, item?.username, item?.local_name, String(item?.user_id ?? "")];
    return fields.some((value) => value && normalizeBaleName(value) === wanted);
  });
  if (exactContacts.length === 1) return exactContacts[0].handle;
  const candidates = [...(searched.results || []), ...(contacts.results || [])]
    .filter((item, index, all) => item?.handle && all.findIndex((x) => x?.handle === item.handle) === index)
    .slice(0, 10);
  if (exactContacts.length > 1 || candidates.length) {
    const error = codedError("BALE_CONVERSATION_AMBIGUOUS");
    error.candidates = candidates;
    throw error;
  }
  throw codedError("BALE_CONVERSATION_NOT_FOUND");
}

async function resolveBaleMessageRef(input, { cdpUrl = DEFAULT_CDP_URL } = {}) {
  const direct = String(input?.message_handle || "").trim();
  if (direct) {
    if (!/^balemsg:\d+:-?\d+:\d+:-?\d+$/.test(direct)) throw codedError("BALE_MESSAGE_HANDLE_INVALID");
    return direct;
  }
  if (input?.latest_message === true && typeof input?.conversation === "string" && input.conversation.trim()) {
    const conversation_handle = await resolveBaleConversationRef(input.conversation, { cdpUrl });
    const listed = await runBaleCore("message_list", { conversation_handle, limit: 1 }, { cdpUrl });
    const handle = listed?.messages?.[0]?.handle;
    if (typeof handle === "string" && handle) return handle;
    throw codedError("BALE_MESSAGE_NOT_FOUND");
  }
  throw codedError("BALE_MESSAGE_REFERENCE_REQUIRED", "Pass message_handle, or conversation with latest_message=true.");
}

function normalizeBaleReactionCode(value) {
  const code = String(value ?? "").trim();
  return code === "\u2764\uFE0F" ? "\u2764" : code;
}

async function readBaleProviderReactionState(messageHandle, { cdpUrl = DEFAULT_CDP_URL } = {}) {
  const result = await runBaleCore("reaction_get", { message_handle: messageHandle }, { cdpUrl });
  if (result?.provider_fresh !== true || result?.verification_source !== "getMessagesReactions") {
    throw codedError("BALE_REACTION_PROVIDER_READ_UNAVAILABLE");
  }
  return result;
}

function baleToolFailure(error, fallback = "BALE_OPERATION_FAILED") {
  const code = typeof error?.code === "string" ? error.code : fallback;
  const payload = {
    state: "FAILED",
    provider: "bale",
    error: code,
    message: String(error?.message || code).slice(0, 300),
    ...(Array.isArray(error?.candidates) ? { candidates: error.candidates.slice(0, 10) } : {}),
  };
  return {
    structuredContent: payload,
    content: [{ type: "text", text: JSON.stringify(payload, null, 1) }],
    isError: true,
  };
}

function baleToolResult(payload) {
  return {
    structuredContent: payload,
    content: [{ type: "text", text: JSON.stringify(payload, null, 1) }],
    isError: payload?.state === "FAILED" || Boolean(payload?.error),
  };
}

function chatFileReference(file) {
  const obj = file && typeof file === "object" ? file : null;
  const downloadUrl = typeof file === "string"
    ? file.trim()
    : (typeof obj?.download_url === "string" ? obj.download_url.trim()
      : (typeof obj?.url === "string" ? obj.url.trim() : ""));
  if (!downloadUrl) {
    const keys = obj ? Object.keys(obj).sort().slice(0, 12).join(",") : typeof file;
    throw codedError("CHAT_FILE_CLIENT_HANDOFF_UNAVAILABLE", "No usable ChatGPT file URL; reference keys=" + keys + ".");
  }
  let parsed;
  try { parsed = new URL(downloadUrl); }
  catch { throw codedError("CHAT_FILE_CLIENT_HANDOFF_UNAVAILABLE", "ChatGPT file reference is not a URL."); }
  const host = parsed.hostname.toLowerCase();
  const admitted =
    host === "files.oaiusercontent.com"
    || host.endsWith(".oaiusercontent.com")
    || /^oai[a-z0-9-]*\.blob\.core\.windows\.net$/.test(host);
  if (parsed.protocol !== "https:" || !admitted) {
    throw codedError("CHAT_FILE_CLIENT_HANDOFF_UNAVAILABLE", "ChatGPT file reference host is not admitted.");
  }
  const providedName = typeof obj?.file_name === "string" ? obj.file_name.trim() : "";
  const urlLeaf = decodeURIComponent(parsed.pathname.split("/").filter(Boolean).pop() || "");
  const rawName = providedName || (urlLeaf && /\.[A-Za-z0-9]{1,12}$/.test(urlLeaf) ? urlLeaf : "chat-upload.bin");
  return {
    parsed,
    filename: rawName.replace(/[\\/\0]/g, "_").slice(0, 180) || "chat-upload.bin",
    requested_type: typeof obj?.mime_type === "string" ? obj.mime_type.trim().toLowerCase() : "",
  };
}

async function downloadChatFileBytes(file, {
  maxBytes = 64 * 1024 * 1024,
  timeoutMs = 90_000,
} = {}) {
  const ref = chatFileReference(file);
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  try {
    const response = await fetch(ref.parsed, { method: "GET", redirect: "error", signal: abort.signal });
    if (!response.ok) throw codedError("CHAT_FILE_DOWNLOAD_FAILED", "ChatGPT file download returned HTTP " + response.status + ".");
    const declared = Number(response.headers.get("content-length"));
    if (Number.isSafeInteger(declared) && (declared < 1 || declared > maxBytes)) {
      throw codedError("BALE_UPLOAD_SIZE_INVALID", "Bale basic upload supports files up to 64 MiB.");
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length < 1 || bytes.length > maxBytes) {
      throw codedError("BALE_UPLOAD_SIZE_INVALID", "Bale basic upload supports files up to 64 MiB.");
    }
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

function validateProviderHttpsUrl(value, code) {
  let parsed;
  try { parsed = new URL(String(value || "")); }
  catch { throw codedError(code); }
  if (parsed.protocol !== "https:" || !parsed.hostname || parsed.hostname === "localhost") throw codedError(code);
  return parsed;
}

async function uploadBaleBytes(uploadUrl, bytes, mediaType, { timeoutMs = 120_000 } = {}) {
  const parsed = validateProviderHttpsUrl(uploadUrl, "BALE_UPLOAD_URL_INVALID");
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  try {
    const response = await fetch(parsed, {
      method: "PUT",
      headers: {
        "content-type": mediaType || "application/octet-stream",
        "content-length": String(bytes.length),
      },
      body: bytes,
      redirect: "error",
      signal: abort.signal,
    });
    if (!response.ok) throw codedError("BALE_FILE_UPLOAD_FAILED", "Bale upload returned HTTP " + response.status + ".");
    return { http_status: response.status };
  } catch (error) {
    if (error?.code) throw error;
    throw codedError(error?.name === "AbortError" ? "BALE_FILE_UPLOAD_TIMEOUT" : "BALE_FILE_UPLOAD_FAILED");
  } finally {
    clearTimeout(timer);
  }
}

async function sha256File(filePath) {
  const hash = crypto.createHash("sha256");
  for await (const chunk of fs.createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

async function resolvePreparedMaterialFile(material) {
  const handle = String(material?.file_handle || "").trim();
  const match = /^pcgfile:([0-9a-f]{64})$/.exec(handle);
  if (!match) throw codedError("BALE_VOICE_MATERIAL_HANDLE_INVALID");
  const filename = String(material?.filename || "").trim();
  if (!filename || filename.length > 128 || /[\\/\u0000]/u.test(filename)) {
    throw codedError("BALE_VOICE_MATERIAL_FILENAME_INVALID");
  }
  const sizeBytes = Number(material?.size_bytes);
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 1 || sizeBytes > BALE_MATERIAL_MAX_BYTES) {
    throw codedError("BALE_VOICE_MATERIAL_SIZE_INVALID");
  }
  const expectedSha = String(material?.sha256_hex || "").trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(expectedSha)) throw codedError("BALE_VOICE_MATERIAL_DIGEST_INVALID");
  const filePath = BALE_MATERIAL_ROOT + "/" + match[1] + "-" + filename;
  let stat;
  try { stat = fs.lstatSync(filePath); } catch { throw codedError("BALE_VOICE_MATERIAL_FILE_UNAVAILABLE"); }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== sizeBytes) {
    throw codedError("BALE_VOICE_MATERIAL_FILE_INVALID");
  }
  const actualSha = await sha256File(filePath);
  if (actualSha !== expectedSha) throw codedError("BALE_VOICE_MATERIAL_DIGEST_MISMATCH");
  return {
    file_path: filePath,
    filename,
    media_type: String(material?.media_type || "audio/ogg"),
    size_bytes: sizeBytes,
    sha256_hex: expectedSha,
  };
}

async function uploadBaleFilePath(uploadUrl, filePath, sizeBytes, mediaType, { timeoutMs = 12 * 60 * 1000 } = {}) {
  const parsed = validateProviderHttpsUrl(uploadUrl, "BALE_UPLOAD_URL_INVALID");
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  const stream = fs.createReadStream(filePath);
  try {
    const response = await fetch(parsed, {
      method: "PUT",
      headers: {
        "content-type": mediaType || "application/octet-stream",
        "content-length": String(sizeBytes),
      },
      body: stream,
      duplex: "half",
      redirect: "error",
      signal: abort.signal,
    });
    if (!response.ok) throw codedError("BALE_FILE_UPLOAD_FAILED", "Bale upload returned HTTP " + response.status + ".");
    return { http_status: response.status };
  } catch (error) {
    try { stream.destroy(); } catch {}
    if (error?.code) throw error;
    throw codedError(error?.name === "AbortError" ? "BALE_FILE_UPLOAD_TIMEOUT" : "BALE_FILE_UPLOAD_FAILED");
  } finally {
    clearTimeout(timer);
  }
}

async function downloadBaleAttachmentBytes(url, {
  maxBytes = 64 * 1024 * 1024,
  timeoutMs = 90_000,
} = {}) {
  const parsed = validateProviderHttpsUrl(url, "BALE_ATTACHMENT_URL_INVALID");
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  try {
    const response = await fetch(parsed, { method: "GET", redirect: "error", signal: abort.signal });
    if (!response.ok) throw codedError("BALE_ATTACHMENT_DOWNLOAD_FAILED", "Bale attachment download returned HTTP " + response.status + ".");
    const declared = Number(response.headers.get("content-length"));
    if (Number.isSafeInteger(declared) && (declared < 0 || declared > maxBytes)) throw codedError("BALE_ATTACHMENT_TOO_LARGE");
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > maxBytes) throw codedError("BALE_ATTACHMENT_TOO_LARGE");
    return {
      bytes,
      media_type: String(response.headers.get("content-type") || "").split(";")[0].trim().toLowerCase() || null,
      size_bytes: bytes.length,
      source_url: parsed.toString(),
    };
  } catch (error) {
    if (error?.code) throw error;
    throw codedError(error?.name === "AbortError" ? "BALE_ATTACHMENT_DOWNLOAD_TIMEOUT" : "BALE_ATTACHMENT_DOWNLOAD_FAILED");
  } finally {
    clearTimeout(timer);
  }
}


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
  socketPath = BALE_PCG_SOCKET,
  materialUpload = null,
} = {}) {
  const requireMaterialUpload = () => {
    if (
      !materialUpload
      || typeof materialUpload.create !== "function"
      || typeof materialUpload.status !== "function"
      || typeof materialUpload.delete !== "function"
      || typeof materialUpload.append !== "function"
      || typeof materialUpload.ready !== "function"
    ) {
      throw codedError("BALE_MATERIAL_UPLOAD_UNAVAILABLE");
    }
    return materialUpload;
  };

  const stageChatUploadedMaterial = async (file, {
    maxBytes = BALE_MATERIAL_MAX_BYTES,
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
        throw codedError("BALE_VOICE_INPUT_SIZE_INVALID");
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
        while (carry.length >= BALE_MATERIAL_CHUNK_BYTES) {
          const chunk = carry.subarray(0, BALE_MATERIAL_CHUNK_BYTES);
          await upload.append(created.upload_id, offset, { data_base64: chunk.toString("base64") });
          offset += chunk.length;
          carry = carry.subarray(BALE_MATERIAL_CHUNK_BYTES);
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

  server.registerTool("bale_capability_list", {
    title: "List Bale capabilities",
    description: "Return the typed Bale capabilities exposed by this CF-server release.",
    inputSchema: {},
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async () => baleToolResult({
    state: "ACHIEVED",
    provider: "bale",
    realization: "web-rpc",
    capabilities: BALE_CAPABILITIES.map(([name, effect, description]) => ({
      name,
      effect,
      description,
      parity_status: BALE_RELIABILITY[name] || "POSSIBLE_BUT_UNVERIFIED/FRAGILE",
    })),
    provider_semantics: {
      reactions: "Provider-native codes; common ❤️ is normalized to Bale ❤. Reaction mutation uses provider-fresh confirmation.",
      reply: "Reply source identity and reply postcondition are both resolved through Bale remote history. A reply is provider-confirmed only when the fresh created message matches the exact source RID/date/peer and intended text.",
      reply_reads: "When Bale exposes a native reply thread, bale_message_replies reads it through provider LoadReplies. Ordinary chats fall back to fresh remote history using replyToTopId/direct quote identity; local cache is not authoritative.",
      voice_send: "Owner audio is converted through the shared OGG/Opus voice-preparation path, then sent as Bale native VOICE content and independently confirmed from fresh remote history.",
      read_state: "Conversation-wide read plus a manual unread marker; no Telegram counted read boundary is claimed.",
      pin: "Owner-local dialog-list pin state, not a pinned message visible to other participants.",
      mute: "Conversation notification state.",
      edit: "Current typed path edits text messages and document captions only when Bale permits it.",
      file_send: "Current bounded direct path sends a document with optional caption, up to 64 MiB; native media/voice semantics are not claimed.",
      message_ids: "Stable balemsg handles retain peer type/id, provider date, and provider rid; provider-fresh reaction verification reconstructs the full Bale MessageId.",
    },
    write_verification: {
      provider_confirmed: ["bale_react","bale_reply","bale_voice_send_file"],
      acknowledged_or_in_doubt_until_fresh_verifier_qualified: [
        "bale_send","bale_forward","bale_edit","bale_delete",
        "bale_mark_read","bale_mark_unread","bale_mute","bale_pin","bale_file_send"
      ],
    },
  }));

  server.registerTool("bale_capability_gaps", {
    title: "List Bale capability gaps",
    description: "Return explicit Telegram/WhatsApp-parity gaps that are not exposed in the current Bale surface.",
    inputSchema: {},
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async () => baleToolResult({
    state: "ACHIEVED",
    provider: "bale",
    gaps: BALE_GAPS,
  }));

  server.registerTool("bale_unread_list", {
    title: "List unread Bale conversations",
    description: "Return only recent Bale conversations with unread messages or a manual unread marker.",
    inputSchema: { limit: z.number().int().min(1).max(50).optional() },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ limit = 50 }) => {
    try {
      const listed = await listBaleConversations(limit, { cdpUrl });
      const conversations = listed.conversations.filter((item) => item.has_unread);
      return baleToolResult({
        state: "ACHIEVED",
        provider: "bale",
        realization: "web-rpc",
        count: conversations.length,
        total_unread_messages: conversations.reduce((sum, item) => sum + Number(item.unread_count || 0), 0),
        conversations,
      });
    } catch (error) {
      return baleToolFailure(error, "BALE_UNREAD_LIST_FAILED");
    }
  });

  server.registerTool("bale_contact_search", {
    title: "Search Bale contacts",
    description: "Search locally known Bale contacts by name or identifier.",
    inputSchema: {
      query: z.string().trim().min(1).max(128),
      limit: z.number().int().min(1).max(50).optional(),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ query, limit = 20 }) => {
    try {
      return baleToolResult(await runBaleCore("contact_search", { query, limit }, { cdpUrl }));
    } catch (error) {
      return baleToolFailure(error, "BALE_CONTACT_SEARCH_FAILED");
    }
  });

  server.registerTool("bale_reaction_get", {
    title: "Read Bale reaction state",
    description: "Read the owner's reaction and aggregate emoji counts for one exact Bale message.",
    inputSchema: {
      message_handle: z.string().max(120).optional(),
      conversation: z.string().trim().max(256).optional(),
      latest_message: z.boolean().optional(),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async (input) => {
    try {
      const message_handle = await resolveBaleMessageRef(input, { cdpUrl });
      return baleToolResult(await readBaleProviderReactionState(message_handle, { cdpUrl }));
    } catch (error) {
      return baleToolFailure(error, "BALE_REACTION_GET_FAILED");
    }
  });

  server.registerTool("bale_screenshot", {
    title: "Capture Bale screenshot",
    description: "Capture the current logged-in Bale Web viewport without navigating or opening another chat.",
    inputSchema: {
      format: z.enum(["jpeg", "png"]).optional(),
      quality: z.number().int().min(40).max(95).optional(),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ format = "jpeg", quality = 80 }) => {
    try {
      const page = await balePage(cdpUrl);
      const bytes = await page.screenshot({
        type: format,
        ...(format === "jpeg" ? { quality } : {}),
      });
      return {
        structuredContent: {
          state: "ACHIEVED",
          provider: "bale",
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
      return baleToolFailure(error, "BALE_SCREENSHOT_FAILED");
    }
  });

  server.registerTool("bale_conversation_search", {
    title: "Search Bale conversations",
    description: "Search Bale conversations by name without opening results or changing read state. Returns stable balechat: handles.",
    inputSchema: {
      query: z.string().trim().min(1).max(128),
      limit: z.number().int().min(1).max(50).optional(),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ query, limit = 20 }) => {
    try {
      return baleToolResult(await searchBaleConversations(query, limit, { cdpUrl }));
    } catch (error) {
      return baleToolFailure(error, "BALE_CONVERSATION_SEARCH_FAILED");
    }
  });

  server.registerTool("bale_message_list", {
    title: "List Bale messages",
    description: "Read the most recent messages in one Bale conversation without opening the chat or changing read state. conversation accepts an exact display name or balechat: handle.",
    inputSchema: {
      conversation: z.string().trim().min(1).max(256),
      limit: z.number().int().min(1).max(100).optional(),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ conversation, limit = 10 }) => {
    try {
      const conversation_handle = await resolveBaleConversationRef(conversation, { cdpUrl });
      return baleToolResult(await runBaleCore("message_list", { conversation_handle, limit }, { cdpUrl }));
    } catch (error) {
      return baleToolFailure(error, "BALE_MESSAGE_LIST_FAILED");
    }
  });

  server.registerTool("bale_message_replies", {
    title: "Read Bale message replies",
    description: "Read bounded direct replies that quote one exact Bale message. For ordinary chats Bale exposes quoted-message relationships rather than a separate Telegram-style thread object. Reads fresh provider history without opening the chat or changing read state.",
    inputSchema: {
      message_handle: z.string().max(120).optional(),
      conversation: z.string().trim().max(256).optional(),
      latest_message: z.boolean().optional(),
      limit: z.number().int().min(1).max(100).optional(),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async (input) => {
    try {
      const message_handle = await resolveBaleMessageRef(input, { cdpUrl });
      return baleToolResult(await runBaleCore("message_replies", {
        message_handle,
        limit: input.limit ?? 50,
      }, { cdpUrl }));
    } catch (error) {
      return baleToolFailure(error, "BALE_MESSAGE_REPLIES_FAILED");
    }
  });

  server.registerTool("bale_message_search", {
    title: "Search Bale messages",
    description: "Search Bale messages globally or within one exact conversation without opening a result. Returned messages have stable balemsg: handles.",
    inputSchema: {
      query: z.string().trim().min(1).max(128),
      conversation: z.string().trim().max(256).optional(),
      limit: z.number().int().min(1).max(50).optional(),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ query, conversation, limit = 20 }) => {
    try {
      const conversation_handle = conversation
        ? await resolveBaleConversationRef(conversation, { cdpUrl })
        : undefined;
      return baleToolResult(await runBaleCore("message_search", { query, conversation_handle, limit }, { cdpUrl }));
    } catch (error) {
      return baleToolFailure(error, "BALE_MESSAGE_SEARCH_FAILED");
    }
  });

  server.registerTool("bale_send", {
    title: "Send Bale message",
    description: "Send an ordinary text message to one exact Bale conversation. target accepts an exact display name or balechat: handle.",
    inputSchema: {
      target: z.string().trim().min(1).max(256),
      text: z.string().min(1).max(16000),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async ({ target, text }) => {
    try {
      const conversation_handle = await resolveBaleConversationRef(target, { cdpUrl });
      return baleToolResult(await runBaleCore("send_text", { conversation_handle, text }, { cdpUrl }));
    } catch (error) {
      return baleToolFailure(error, "BALE_SEND_FAILED");
    }
  });

  server.registerTool("bale_reply", {
    title: "Reply in Bale",
    description: "Reply to one exact Bale message. Prefer message_handle; when the owner explicitly means the latest message, pass conversation with latest_message=true.",
    inputSchema: {
      message_handle: z.string().max(120).optional(),
      conversation: z.string().trim().max(256).optional(),
      latest_message: z.boolean().optional(),
      text: z.string().min(1).max(16000),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async (input) => {
    try {
      const message_handle = await resolveBaleMessageRef(input, { cdpUrl });
      const parsed = /^balemsg:(\d+):(-?\d+):/.exec(message_handle);
      if (!parsed) throw codedError("BALE_MESSAGE_HANDLE_INVALID");
      const conversation_handle = "balechat:" + parsed[1] + ":" + parsed[2];
      return baleToolResult(await runBaleCore("reply_text", {
        conversation_handle,
        message_handle,
        text: input.text,
      }, { cdpUrl }));
    } catch (error) {
      return baleToolFailure(error, "BALE_REPLY_FAILED");
    }
  });

  server.registerTool("bale_react", {
    title: "React to Bale message",
    description: "Set, change, or remove the owner's reaction on one exact Bale message.",
    inputSchema: {
      message_handle: z.string().max(120).optional(),
      conversation: z.string().trim().max(256).optional(),
      latest_message: z.boolean().optional(),
      emoji: z.string().max(32).optional(),
      remove: z.boolean().optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async (input) => {
    try {
      const message_handle = await resolveBaleMessageRef(input, { cdpUrl });
      const remove = input.remove === true;
      const desired = normalizeBaleReactionCode(input.emoji);
      if (!remove && !desired) throw codedError("BALE_REACTION_REQUIRED");

      const before = await readBaleProviderReactionState(message_handle, { cdpUrl });
      const alreadyDesired = remove ? before.my_reaction === null : before.my_reaction === desired;
      if (alreadyDesired) {
        return baleToolResult({
          state: "ACHIEVED",
          provider: "bale",
          operation: "react",
          message_handle,
          effect_attempted: false,
          provider_acknowledged: false,
          provider_confirmed: true,
          my_reaction: before.my_reaction,
          reactions: before.reactions,
          provider_fresh: true,
          verification_source: before.verification_source,
        });
      }

      const mutationCode = remove ? before.my_reaction : desired;
      let providerAcknowledged = false;
      let mutationError = null;
      try {
        await runBaleCore("react_message", {
          message_handle,
          emoji: mutationCode,
          remove,
        }, { cdpUrl });
        providerAcknowledged = true;
      } catch (error) {
        mutationError = error;
      }

      let after = null;
      for (const delayMs of [180, 320, 500, 800]) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        try {
          after = await readBaleProviderReactionState(message_handle, { cdpUrl });
        } catch {
          after = null;
        }
        if (!after) continue;
        const satisfied = remove ? after.my_reaction === null : after.my_reaction === desired;
        if (satisfied) break;
      }

      if (!after) {
        return baleToolResult({
          state: "IN_DOUBT",
          provider: "bale",
          operation: "react",
          message_handle,
          effect_attempted: true,
          provider_acknowledged: providerAcknowledged,
          provider_confirmed: false,
          error: mutationError ? "BALE_REACTION_PROVIDER_RESULT_UNKNOWN" : null,
          my_reaction: null,
          provider_fresh: false,
        });
      }

      const confirmed = remove ? after.my_reaction === null : after.my_reaction === desired;
      return baleToolResult({
        state: confirmed ? "ACHIEVED" : "FAILED",
        provider: "bale",
        operation: "react",
        message_handle,
        effect_attempted: true,
        provider_acknowledged: providerAcknowledged,
        provider_confirmed: confirmed,
        error: confirmed ? null : (mutationError ? "BALE_REACTION_PROVIDER_REJECTED" : "BALE_REACTION_POSTCONDITION_NOT_MET"),
        my_reaction: after.my_reaction,
        reactions: after.reactions,
        provider_fresh: true,
        verification_source: after.verification_source,
      });
    } catch (error) {
      return baleToolFailure(error, "BALE_REACT_FAILED");
    }
  });

  server.registerTool("bale_forward", {
    title: "Forward Bale message",
    description: "Forward one exact Bale message natively to another Bale conversation. Prefer message_handle; for the latest source message use source plus latest_message=true.",
    inputSchema: {
      message_handle: z.string().max(120).optional(),
      source: z.string().trim().max(256).optional(),
      latest_message: z.boolean().optional(),
      target: z.string().trim().min(1).max(256),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async (input) => {
    try {
      const message_handle = await resolveBaleMessageRef({
        message_handle: input.message_handle,
        conversation: input.source,
        latest_message: input.latest_message,
      }, { cdpUrl });
      const target_handle = await resolveBaleConversationRef(input.target, { cdpUrl });
      return baleToolResult(await runBaleCore("forward_message", { message_handle, target_handle }, { cdpUrl }));
    } catch (error) {
      return baleToolFailure(error, "BALE_FORWARD_FAILED");
    }
  });

  server.registerTool("bale_edit", {
    title: "Edit Bale message",
    description: "Edit one exact Bale text message or document caption. Prefer message_handle; for the latest message use conversation plus latest_message=true.",
    inputSchema: {
      message_handle: z.string().max(120).optional(),
      conversation: z.string().trim().max(256).optional(),
      latest_message: z.boolean().optional(),
      text: z.string().max(16000),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async (input) => {
    try {
      const message_handle = await resolveBaleMessageRef(input, { cdpUrl });
      return baleToolResult(await runBaleCore("edit_message", { message_handle, text: input.text }, { cdpUrl }));
    } catch (error) {
      return baleToolFailure(error, "BALE_EDIT_FAILED");
    }
  });

  server.registerTool("bale_mark_read", {
    title: "Mark Bale conversation read",
    description: "Mark one exact Bale conversation read and clear any manual unread marker. This is all/read-state semantics like WhatsApp.",
    inputSchema: {
      conversation: z.string().trim().min(1).max(256),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ conversation }) => {
    try {
      const conversation_handle = await resolveBaleConversationRef(conversation, { cdpUrl });
      return baleToolResult(await runBaleCore("mark_read", { conversation_handle }, { cdpUrl }));
    } catch (error) {
      return baleToolFailure(error, "BALE_MARK_READ_FAILED");
    }
  });

  server.registerTool("bale_mark_unread", {
    title: "Mark Bale conversation unread",
    description: "Set the manual unread state for one exact Bale conversation without opening it.",
    inputSchema: {
      conversation: z.string().trim().min(1).max(256),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ conversation }) => {
    try {
      const conversation_handle = await resolveBaleConversationRef(conversation, { cdpUrl });
      return baleToolResult(await runBaleCore("mark_unread", { conversation_handle }, { cdpUrl }));
    } catch (error) {
      return baleToolFailure(error, "BALE_MARK_UNREAD_FAILED");
    }
  });

  server.registerTool("bale_mute", {
    title: "Set Bale mute state",
    description: "Set the exact desired mute state for one Bale conversation. muted=true mutes; muted=false unmutes.",
    inputSchema: {
      conversation: z.string().trim().min(1).max(256),
      muted: z.boolean(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ conversation, muted }) => {
    try {
      const conversation_handle = await resolveBaleConversationRef(conversation, { cdpUrl });
      return baleToolResult(await runBaleCore("mute_conversation", { conversation_handle, muted }, { cdpUrl }));
    } catch (error) {
      return baleToolFailure(error, "BALE_MUTE_FAILED");
    }
  });

  server.registerTool("bale_pin", {
    title: "Set Bale conversation pin",
    description: "Pin or unpin one Bale conversation for the owner's own dialog list. This does not pin a message for other participants.",
    inputSchema: {
      conversation: z.string().trim().min(1).max(256),
      pinned: z.boolean(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ conversation, pinned }) => {
    try {
      const conversation_handle = await resolveBaleConversationRef(conversation, { cdpUrl });
      return baleToolResult(await runBaleCore("pin_conversation", { conversation_handle, pinned }, { cdpUrl }));
    } catch (error) {
      return baleToolFailure(error, "BALE_PIN_FAILED");
    }
  });

  server.registerTool("bale_delete", {
    title: "Delete Bale message",
    description: "Delete one exact Bale message. confirm_irreversible=true is required. for_everyone=true requests deletion for all participants when the provider permits it; otherwise deletion is owner-only.",
    inputSchema: {
      message_handle: z.string().max(120).optional(),
      conversation: z.string().trim().max(256).optional(),
      latest_message: z.boolean().optional(),
      for_everyone: z.boolean().optional(),
      confirm_irreversible: z.literal(true),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  }, async (input) => {
    try {
      const message_handle = await resolveBaleMessageRef(input, { cdpUrl });
      return baleToolResult(await runBaleCore("delete_message", {
        message_handle,
        for_everyone: input.for_everyone === true,
      }, { cdpUrl }));
    } catch (error) {
      return baleToolFailure(error, "BALE_DELETE_FAILED");
    }
  });

  server.registerTool("bale_attachment_get", {
    title: "Get Bale attachment",
    description: "Resolve one exact Bale message attachment and return the provider download as a resource link without opening the chat or changing read state.",
    inputSchema: {
      message_handle: z.string().max(120).optional(),
      conversation: z.string().trim().max(256).optional(),
      latest_message: z.boolean().optional(),
      attachment_index: z.number().int().min(1).max(10).optional(),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async (input) => {
    try {
      const message_handle = await resolveBaleMessageRef(input, { cdpUrl });
      const prepared = await runBaleCore("attachment_prepare_download", {
        message_handle,
        attachment_index: input.attachment_index ?? 1,
      }, { cdpUrl });
      const uri = validateProviderHttpsUrl(prepared.download_url, "BALE_ATTACHMENT_URL_INVALID").toString();
      const metadata = {
        state: "ACHIEVED",
        provider: "bale",
        message_handle,
        attachment_index: prepared.attachment_index,
        attachment_count: prepared.attachment_count,
        filename: prepared.filename || "bale-attachment",
        media_type: prepared.media_type || "application/octet-stream",
        size_bytes: prepared.size_bytes ?? null,
      };
      return {
        structuredContent: metadata,
        content: [
          { type: "text", text: JSON.stringify(metadata, null, 1) },
          {
            type: "resource_link",
            uri,
            name: metadata.filename,
            mimeType: metadata.media_type,
            size: Number.isSafeInteger(metadata.size_bytes) ? metadata.size_bytes : undefined,
            description: "Expiring Bale attachment download.",
          },
        ],
      };
    } catch (error) {
      return baleToolFailure(error, "BALE_ATTACHMENT_GET_FAILED");
    }
  });

  server.registerTool("bale_file_send", {
    title: "Send file in Bale",
    description: "Upload one ChatGPT-attached file to Bale and send it as a document message to one exact conversation. Basic path is bounded to 64 MiB.",
    inputSchema: {
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
      ]),
      caption: z.string().max(4000).optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    _meta: { "openai/fileParams": ["file"] },
  }, async ({ target, file, caption = "" }) => {
    try {
      const conversation_handle = await resolveBaleConversationRef(target, { cdpUrl });
      const source = await downloadChatFileBytes(file);
      const prepared = await runBaleCore("prepare_file_upload", {
        conversation_handle,
        filename: source.filename,
        media_type: source.media_type,
        size_bytes: source.size_bytes,
      }, { cdpUrl });
      const upload = await uploadBaleBytes(prepared.upload_url, source.bytes, source.media_type);
      const sent = await runBaleCore("send_uploaded_file", {
        conversation_handle,
        file_id: prepared.file_id,
        filename: source.filename,
        media_type: source.media_type,
        size_bytes: source.size_bytes,
        caption,
      }, { cdpUrl });
      return baleToolResult({
        ...sent,
        upload_http_status: upload.http_status,
        uploaded_file: {
          filename: source.filename,
          media_type: source.media_type,
          size_bytes: source.size_bytes,
        },
      });
    } catch (error) {
      return baleToolFailure(error, "BALE_FILE_SEND_FAILED");
    }
  });


  server.registerTool("bale_voice_send_file", {
    title: "Send audio as Bale Voice Message",
    description: "Convert owner-supplied audio through the shared OGG/Opus voice-preparation pipeline and send it as a provider-native Bale Voice Message. Pass exactly one of file or a completed shared upload_id. target accepts an exact Bale display name or balechat: handle.",
    inputSchema: {
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
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    _meta: { "openai/fileParams": ["file"] },
  }, async (input) => {
    let transientUploadId = null;
    try {
      const sourceCount = Number(Boolean(input.file)) + Number(Boolean(input.upload_id));
      if (sourceCount !== 1) {
        throw codedError("BALE_VOICE_SOURCE_AMBIGUOUS", "Pass exactly one of file or upload_id.");
      }

      const conversation_handle = await resolveBaleConversationRef(input.target, { cdpUrl });
      let ready;
      if (input.file) {
        ready = await stageChatUploadedMaterial(input.file);
        transientUploadId = ready.upload_id;
      } else {
        ready = await requireMaterialUpload().ready(input.upload_id);
      }

      const prepared = await invokeTelegramSemanticOperation({
        operation: "communication.audio.voice.prepare",
        args: {
          material_file_handle: ready.material_file_handle,
          filename: ready.filename,
          media_type: ready.media_type,
          size_bytes: ready.size_bytes,
          sha256_hex: ready.sha256_hex,
        },
        purpose: "LOCAL_PROCESSING",
      }, { socketPath, timeoutMs: 12 * 60 * 1000, maxBytes: 524_288 });

      if (prepared?.state !== "ACHIEVED") {
        throw codedError(String(prepared?.error || prepared?.state || "PCG_VOICE_PREPARE_FAILED"));
      }

      if (transientUploadId) {
        try { await requireMaterialUpload().delete(transientUploadId); } catch {}
        transientUploadId = null;
      }

      const protectedData = prepared?.protected_provider_data || {};
      const material = protectedData?.material_file || {};
      const durationSeconds = Number(protectedData?.duration_seconds ?? prepared?.observation?.duration_seconds);
      if (
        typeof material.file_handle !== "string"
        || typeof material.filename !== "string"
        || typeof material.media_type !== "string"
        || !Number.isSafeInteger(material.size_bytes)
        || typeof material.sha256_hex !== "string"
        || !Number.isFinite(durationSeconds)
        || durationSeconds <= 0
      ) {
        throw codedError("PCG_VOICE_PREPARE_CONTRACT_INVALID");
      }

      const local = await resolvePreparedMaterialFile(material);
      const uploadPlan = await runBaleCore("prepare_file_upload", {
        conversation_handle,
        filename: local.filename,
        media_type: local.media_type,
        size_bytes: local.size_bytes,
      }, { cdpUrl });
      const uploaded = await uploadBaleFilePath(
        uploadPlan.upload_url,
        local.file_path,
        local.size_bytes,
        local.media_type
      );
      const sent = await runBaleCore("send_uploaded_voice", {
        conversation_handle,
        file_id: uploadPlan.file_id,
        filename: local.filename,
        media_type: local.media_type,
        size_bytes: local.size_bytes,
        duration_ms: Math.max(1, Math.round(durationSeconds * 1000)),
      }, { cdpUrl });

      return baleToolResult({
        ...sent,
        upload_http_status: uploaded.http_status,
        converted: prepared?.observation?.converted === true,
        source_media_type: prepared?.observation?.source_media_type ?? null,
        source_size_bytes: prepared?.observation?.source_size_bytes ?? null,
        output_media_type: prepared?.observation?.output_media_type ?? local.media_type,
        output_size_bytes: prepared?.observation?.output_size_bytes ?? local.size_bytes,
        duration_seconds: durationSeconds,
      });
    } catch (error) {
      if (transientUploadId) {
        try { await requireMaterialUpload().delete(transientUploadId); } catch {}
      }
      return baleToolFailure(error, "BALE_VOICE_SEND_FAILED");
    }
  });
}