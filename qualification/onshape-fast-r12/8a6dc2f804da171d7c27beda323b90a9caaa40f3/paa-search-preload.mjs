import fs from "node:fs";
import crypto from "node:crypto";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const RELEASE_CLOSURE_FILE =
  process.env.ONSHAPE_RELEASE_CLOSURE_FILE || "/release/release-closure.json";
const PAA_CONTROL_URL = "http://127.0.0.1:8793";

const BUILD_ID = (() => {
  try {
    const value = JSON.parse(fs.readFileSync(RELEASE_CLOSURE_FILE, "utf8")).build_id;
    if (typeof value === "string" && value.trim().length >= 3) return value.trim();
  } catch {}
  return "onshape-vps-fast-unknown";
})();

function textResult(value) {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

async function paaControl(pathname, { method = "GET", body = undefined } = {}) {
  let response;
  try {
    response = await fetch(PAA_CONTROL_URL + pathname, {
      method,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (cause) {
    const error = new Error("Android command service is unavailable.");
    error.code = "ANDROID_COMMAND_SERVICE_UNAVAILABLE";
    error.cause = cause;
    throw error;
  }

  let value;
  try {
    value = await response.json();
  } catch {
    const error = new Error("Android command service returned invalid JSON.");
    error.code = "ANDROID_COMMAND_SERVICE_INVALID";
    throw error;
  }
  if (!response.ok) {
    const error = new Error(String(value?.error || "Android command service rejected request."));
    error.code = String(value?.error || "ANDROID_COMMAND_SERVICE_REJECTED");
    throw error;
  }
  return value;
}

async function paaPublish(action, parameters) {
  const request_id =
    "paa-cf-" + Date.now().toString(36) + "-" + crypto.randomBytes(6).toString("hex");
  const value = await paaControl("/local/v1/publish", {
    method: "POST",
    body: { request_id, action, parameters, ttl_seconds: 3600 },
  });
  return {
    request_id,
    queue_seq: value.seq,
    duplicate: value.duplicate === true,
    state: "QUEUED",
  };
}

function registerAndroidStorageSearch(server) {
  server.registerTool("android_storage_search", {
    title: "Search Android shared storage",
    description:
      "Queue a fast bounded filename search over Android shared storage using the device MediaStore files index. Prefer directory and extension filters for low latency. alternate_queries can carry transliterations or likely naming variants. The device ranks the bounded indexed candidates instead of recursively crawling the filesystem.",
    inputSchema: {
      directory: z.string().max(512).optional(),
      query: z.string().trim().max(180).optional(),
      alternate_queries: z.array(z.string().trim().min(1).max(180)).max(8).optional(),
      extension: z.string().trim().regex(/^\.?[A-Za-z0-9]{1,16}$/).optional(),
      recursive: z.boolean().optional(),
      limit: z.number().int().min(1).max(100).optional(),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  }, async (input) => {
    try {
      const query = String(input.query || "").trim();
      const alternate_queries =
        Array.isArray(input.alternate_queries) ? input.alternate_queries : [];
      const extension = String(input.extension || "").trim();
      if (!query && !extension && !alternate_queries.length) {
        const error = new Error("Provide query, alternate_queries, or extension.");
        error.code = "ANDROID_STORAGE_SEARCH_QUERY_REQUIRED";
        throw error;
      }

      const command = await paaPublish("storage.search", {
        directory: input.directory || "",
        query,
        alternate_queries,
        extension,
        recursive: input.recursive !== false,
        limit: input.limit || 25,
      });
      return textResult({
        build_id: BUILD_ID,
        command,
        search_architecture: "mediastore_files_index",
      });
    } catch (error) {
      return textResult({
        build_id: BUILD_ID,
        status: "FAILED",
        error: {
          layer: "android",
          code: error?.code || "INTERNAL_ERROR",
          message: String(error?.message || error?.name || "Internal error").slice(0, 300),
        },
      });
    }
  });
}


const BALE_CDP_URL = "http://127.0.0.1:9222/json";

const BALE_LIST_IN_PAGE = async (limit) => {
  const getRequire = () => {
    if (globalThis.__cfBaleRequire) return globalThis.__cfBaleRequire;
    const chunks = globalThis.rspackChunkweb;
    if (!chunks?.push) return null;
    try { chunks.push([[987654321], {}, (req) => { globalThis.__cfBaleRequire = req; }]); } catch {}
    return globalThis.__cfBaleRequire || null;
  };
  const findApi = (req) => {
    if (globalThis.__cfBaleApi?.core?.dialogs && globalThis.__cfBaleApi?.core?.entities) return globalThis.__cfBaleApi;
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
  const firstValue = (observable, timeoutMs = 10000) => new Promise((resolve, reject) => {
    let done = false, subscription = null;
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
    } catch (error) { finish(reject, error); }
  });

  const api = findApi(getRequire());
  if (!api) throw new Error("BALE_API_NOT_FOUND");
  const raw = await firstValue(api.core.dialogs.getAllDialogs(false));
  const rows = (Array.isArray(raw) ? raw : [])
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
      ? (entity?.name || entity?.localName || entity?.nick || ("User " + peerId))
      : (entity?.title || entity?.nick || ("Group " + peerId));
    const unreadCount = Number.isSafeInteger(item.counter) && item.counter >= 0 ? item.counter : 0;
    return {
      handle: "balechat:" + peerType + ":" + peerId,
      name: String(name).slice(0, 256),
      kind: peerType === 1 ? "user" : "group",
      unread_count: unreadCount,
      marked_unread: item.markedAsUnread === true,
      has_unread: unreadCount > 0 || item.markedAsUnread === true,
      last_date_ms: Number.isSafeInteger(item.date) ? item.date : 0,
    };
  });
};

async function baleConversationList(limit) {
  let targets;
  try {
    const response = await fetch(BALE_CDP_URL, { signal: AbortSignal.timeout(4000) });
    if (!response.ok) throw new Error("CDP_HTTP_" + response.status);
    targets = await response.json();
  } catch (cause) {
    const error = new Error("Bale browser debugging endpoint is unavailable.");
    error.code = "BALE_BROWSER_UNAVAILABLE";
    error.cause = cause;
    throw error;
  }
  const page = Array.isArray(targets)
    ? targets.find((target) => target?.type === "page" && /^https:\/\/web\.bale\.ai\/chat(?:[/?#]|$)/.test(String(target.url || "")))
    : null;
  if (!page?.webSocketDebuggerUrl) {
    const error = new Error("Authenticated Bale chat page is not ready.");
    error.code = "BALE_SESSION_NOT_READY";
    throw error;
  }

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let nextId = 0;
  const pending = new Map();
  ws.onmessage = (event) => {
    let message;
    try { message = JSON.parse(String(event.data)); } catch { return; }
    if (message?.id && pending.has(message.id)) {
      pending.get(message.id)(message);
      pending.delete(message.id);
    }
  };
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("BALE_CDP_CONNECT_TIMEOUT")), 5000);
    ws.onopen = () => { clearTimeout(timer); resolve(); };
    ws.onerror = (event) => { clearTimeout(timer); reject(event?.error || new Error("BALE_CDP_CONNECT_FAILED")); };
  });
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error("BALE_CDP_CALL_TIMEOUT"));
    }, 15000);
    pending.set(id, (value) => { clearTimeout(timer); resolve(value); });
    ws.send(JSON.stringify({ id, method, params }));
  });

  try {
    const expression = "(" + BALE_LIST_IN_PAGE.toString() + ")(" + JSON.stringify(limit) + ")";
    const response = await call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    const exception = response?.result?.exceptionDetails;
    if (exception) throw new Error(String(exception?.exception?.description || exception?.text || "BALE_RUNTIME_EVALUATION_FAILED"));
    const conversations = response?.result?.result?.value;
    if (!Array.isArray(conversations)) throw new Error("BALE_RUNTIME_RESULT_INVALID");
    return {
      state: "ACHIEVED",
      provider: "bale",
      realization: "web-rpc",
      count: conversations.length,
      conversations,
      bounded: true,
    };
  } finally {
    try { ws.close(); } catch {}
  }
}

function registerBaleConversationList(server) {
  server.registerTool("bale_conversation_list", {
    title: "List recent Bale conversations",
    description: "Read recent Bale conversations from the authenticated Bale Web session without opening chats or changing read state.",
    inputSchema: { limit: z.number().int().min(1).max(50).optional() },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ limit = 10 }) => {
    try {
      const result = await baleConversationList(limit);
      return { structuredContent: result, content: [{ type: "text", text: JSON.stringify(result, null, 1) }] };
    } catch (error) {
      const code = String(error?.code || "BALE_CONVERSATION_LIST_FAILED");
      return {
        structuredContent: { state: "FAILED", provider: "bale", error: code },
        content: [{ type: "text", text: "Bale conversation listing failed: " + code }],
        isError: true,
      };
    }
  });
}

const originalConnect = McpServer.prototype.connect;
if (typeof originalConnect !== "function") {
  throw new Error("McpServer.connect is unavailable");
}

McpServer.prototype.connect = async function (...args) {
  if (!this.__paaStorageSearchRegistered) {
    registerAndroidStorageSearch(this);
    registerBaleConversationList(this);
    Object.defineProperty(this, "__paaStorageSearchRegistered", {
      value: true,
      enumerable: false,
      configurable: false,
    });
  }
  return originalConnect.apply(this, args);
};