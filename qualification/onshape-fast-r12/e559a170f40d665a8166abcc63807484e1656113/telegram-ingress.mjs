import fs from "node:fs";
import crypto from "node:crypto";
import net from "node:net";
import path from "node:path";

export const TELEGRAM_CONVERSATIONS_RESOURCE_URI = "ui://capability-fabric/telegram-conversations-v1.html";
export const PROTECTED_CONVERSATIONS_META_KEY = "com.capability-fabric.pcg/protectedConversations";
export const TELEGRAM_STANDARD_REACTION_BASELINE = Object.freeze(["👍","👎","❤️","🔥","🥰","👏","😁","🤔","🤯","😱","🤬","😢","🎉","🤩","🤮","💩","🙏","👌","🕊","🤡","🥱","🥴","😍","🐳","❤️‍🔥","🌚","🌭","💯","🤣","⚡","🍌","🏆","💔","🤨","😐","🍓","🍾","💋","🖕","😈","😴","😭","🤓","👻","👨‍💻","👀","🎃","🙈","😇","😨","🤝","✍","🤗","🫡","🎅","🎄","☃","💅","🤪","🗿","🆒","💘","🙉","🦄","😘","💊","🙊","😎","👾","🤷‍♂️","🤷","🤷‍♀️","😡"]);
export const TELEGRAM_REACTION_CATALOG_URL = "https://core.telegram.org/bots/api#reactiontypeemoji";

function telegramReactionIdentity(value) {
  return String(value || "").normalize("NFC").replace(/\uFE0F/gu, "");
}

function decodeTelegramDocsHtml(value) {
  return String(value || "")
    .replace(/&#x([0-9a-f]+);/giu, (_, hex) => {
      try { return String.fromCodePoint(Number.parseInt(hex, 16)); } catch { return ""; }
    })
    .replace(/&#([0-9]+);/gu, (_, dec) => {
      try { return String.fromCodePoint(Number.parseInt(dec, 10)); } catch { return ""; }
    })
    .replace(/&quot;/giu, '"')
    .replace(/&#39;|&apos;/giu, "'")
    .replace(/&amp;/giu, "&")
    .replace(/&lt;/giu, "<")
    .replace(/&gt;/giu, ">");
}

function parseTelegramOfficialReactionHtml(html) {
  if (typeof html !== "string" || html.length < 1000) return [];
  const lower = html.toLowerCase();
  let start = lower.indexOf('name="reactiontypeemoji"');
  if (start < 0) start = lower.indexOf('id="reactiontypeemoji"');
  if (start < 0) start = lower.indexOf("reactiontypeemoji");
  if (start < 0) return [];

  const tail = html.slice(start);
  const nextHeading = tail.slice(64).search(/<h4\b/iu);
  const section = nextHeading >= 0 ? tail.slice(0, nextHeading + 64) : tail.slice(0, 50000);
  const found = [];
  const seen = new Set();
  const add = (raw) => {
    const value = decodeTelegramDocsHtml(raw).trim();
    if (!value || value.length > 32) return;
    if (/^[A-Za-z0-9 _.-]+$/u.test(value)) return;
    const key = telegramReactionIdentity(value);
    if (!key || seen.has(key)) return;
    seen.add(key);
    found.push(value);
  };

  for (const match of section.matchAll(/<img\b[^>]*\balt=(["'])(.*?)\1[^>]*>/giu)) add(match[2]);

  if (found.length < 40) {
    const plain = decodeTelegramDocsHtml(section.replace(/<[^>]+>/gu, " ").replace(/\s+/gu, " "));
    const current = plain.match(/Currently,\s*it\s*can\s*be\s*one\s*of\s*([\s\S]*?)(?:ReactionTypeCustomEmoji|The reaction is based|Custom Emoji)/iu)?.[1] || "";
    for (const match of current.matchAll(/["“]([^"”]{1,32})["”]/gu)) add(match[1]);
  }
  return found;
}

export async function fetchTelegramReactionCatalog({
  fetchImpl = globalThis.fetch,
  timeoutMs = 8000,
} = {}) {
  const source = TELEGRAM_REACTION_CATALOG_URL;
  const fetchedAt = new Date().toISOString();
  const baselineByKey = new Map(TELEGRAM_STANDARD_REACTION_BASELINE.map((emoji) => [telegramReactionIdentity(emoji), emoji]));
  if (typeof fetchImpl !== "function") {
    return {
      provider_fresh: false,
      source,
      fetched_at: fetchedAt,
      baseline: [...TELEGRAM_STANDARD_REACTION_BASELINE],
      official: [],
      reactions: [...TELEGRAM_STANDARD_REACTION_BASELINE],
      new_since_baseline: [],
      baseline_missing_from_official: [],
      error: "TELEGRAM_REACTION_CATALOG_FETCH_UNAVAILABLE",
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(source.split("#", 1)[0], {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
      headers: {
        accept: "text/html,application/xhtml+xml",
        "user-agent": "Capability-Fabric-Telegram-Reaction-Catalog/1.0",
      },
    });
    if (!response?.ok) throw new Error(`HTTP_${response?.status || 0}`);
    const html = await response.text();
    if (html.length > 5_000_000) throw new Error("DOCUMENT_TOO_LARGE");
    const rawOfficial = parseTelegramOfficialReactionHtml(html);
    if (rawOfficial.length < 40) throw new Error("REACTION_LIST_PARSE_INCOMPLETE");

    const official = [];
    const officialKeys = new Set();
    for (const raw of rawOfficial) {
      const key = telegramReactionIdentity(raw);
      if (!key || officialKeys.has(key)) continue;
      officialKeys.add(key);
      official.push(baselineByKey.get(key) || raw);
    }
    const newSinceBaseline = official.filter((emoji) => !baselineByKey.has(telegramReactionIdentity(emoji)));
    const missing = TELEGRAM_STANDARD_REACTION_BASELINE.filter((emoji) => !officialKeys.has(telegramReactionIdentity(emoji)));
    return {
      provider_fresh: true,
      source,
      fetched_at: fetchedAt,
      baseline: [...TELEGRAM_STANDARD_REACTION_BASELINE],
      official,
      reactions: [...TELEGRAM_STANDARD_REACTION_BASELINE, ...newSinceBaseline],
      new_since_baseline: newSinceBaseline,
      baseline_missing_from_official: missing,
      error: null,
    };
  } catch (error) {
    return {
      provider_fresh: false,
      source,
      fetched_at: fetchedAt,
      baseline: [...TELEGRAM_STANDARD_REACTION_BASELINE],
      official: [],
      reactions: [...TELEGRAM_STANDARD_REACTION_BASELINE],
      new_since_baseline: [],
      baseline_missing_from_official: [],
      error: String(error?.name === "AbortError" ? "TELEGRAM_REACTION_CATALOG_TIMEOUT" : (error?.message || "TELEGRAM_REACTION_CATALOG_FETCH_FAILED")).slice(0, 160),
    };
  } finally {
    clearTimeout(timer);
  }
}


// Connector-side capability gap ledger.
//
// The PCG service keeps its own ledger, but a refusal decided here never
// reaches it: an unknown operation name or a missing owner confirmation is
// rejected before the socket call. Those are exactly the cases the owner keeps
// hitting, so they must be recorded on this side too.
//
// Argument NAMES only, never argument VALUES. Aggregated by (operation, code).
const CONNECTOR_GAP_LEDGER = process.env.CF_CONNECTOR_GAP_LEDGER || "/run/cf-state/connector-capability-gaps.json";
const CONNECTOR_GAP_MAX_ENTRIES = 200;

function readConnectorGapLedger() {
  try {
    const parsed = JSON.parse(fs.readFileSync(CONNECTOR_GAP_LEDGER, "utf8"));
    if (parsed && typeof parsed === "object" && Array.isArray(parsed.entries)) return parsed;
  } catch {}
  return { schema: "capability-fabric.connector-gap-ledger.v1", entries: [] };
}

export function recordConnectorGap({ operation, code, detail, args } = {}) {
  try {
    const op = typeof operation === "string" && operation ? operation.slice(0, 128) : "UNKNOWN_OPERATION";
    const errorCode = typeof code === "string" && code ? code.slice(0, 128) : "UNKNOWN_ERROR";
    const ledger = readConnectorGapLedger();
    const now = new Date().toISOString();
    const key = `connector|${op}|${errorCode}`;
    let entry = ledger.entries.find((item) => item.key === key);
    if (!entry) {
      if (ledger.entries.length >= CONNECTOR_GAP_MAX_ENTRIES) {
        ledger.entries.sort((a, b) => String(a.last_seen).localeCompare(String(b.last_seen)));
        ledger.entries.shift();
      }
      entry = {
        key,
        surface: "connector",
        operation: op,
        error_code: errorCode,
        first_seen: now,
        last_seen: now,
        occurrences: 0,
        guidance_detail: null,
        observed_argument_sets: [],
      };
      ledger.entries.push(entry);
    }
    entry.last_seen = now;
    entry.occurrences += 1;
    if (typeof detail === "string" && detail) entry.guidance_detail = detail.slice(0, 400);
    const names = args && typeof args === "object" && !Array.isArray(args)
      ? Object.keys(args).filter((name) => typeof name === "string" && name.length <= 64).sort().slice(0, 24)
      : [];
    const signature = names.join(",");
    if (!entry.observed_argument_sets.some((set) => set.join(",") === signature)) {
      entry.observed_argument_sets.push(names);
      if (entry.observed_argument_sets.length > 3) entry.observed_argument_sets.shift();
    }
    ledger.updated_at = now;
    const tmp = CONNECTOR_GAP_LEDGER + ".tmp";
    fs.mkdirSync(path.dirname(CONNECTOR_GAP_LEDGER), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(ledger), { mode: 0o600 });
    fs.renameSync(tmp, CONNECTOR_GAP_LEDGER);
  } catch {}
}

export function summarizeConnectorGaps() {
  const ledger = readConnectorGapLedger();
  return {
    ledger_path: CONNECTOR_GAP_LEDGER,
    updated_at: ledger.updated_at || null,
    distinct_gaps: ledger.entries.length,
    total_occurrences: ledger.entries.reduce((sum, entry) => sum + (entry.occurrences || 0), 0),
    entries: ledger.entries
      .slice()
      .sort((a, b) => (b.occurrences || 0) - (a.occurrences || 0))
      .map(({ key, ...rest }) => rest),
  };
}

function codedError(code, message = code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

export async function callPcgSocket(payload, {
  socketPath = "/run/pcg/web.sock",
  timeoutMs = 15_000,
  maxBytes = 262_144,
  createConnection = (options) => net.createConnection(options),
} = {}) {
  const request = JSON.stringify(payload) + "\n";
  return await new Promise((resolve, reject) => {
    const socket = createConnection({ path: socketPath });
    let buffer = "";
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error);
      else resolve(value);
    };
    socket.setEncoding("utf8");
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => socket.write(request));
    socket.on("data", (chunk) => {
      buffer += chunk;
      if (buffer.length > maxBytes) {
        finish(codedError("PCG_RESPONSE_TOO_LARGE"));
        return;
      }
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      try {
        finish(null, JSON.parse(buffer.slice(0, newline)));
      } catch {
        finish(codedError("PCG_RESPONSE_INVALID"));
      }
    });
    socket.once("timeout", () => finish(codedError("PCG_TIMEOUT")));
    socket.once("error", () => finish(codedError("PCG_UNAVAILABLE")));
    socket.once("end", () => {
      if (!settled) finish(codedError("PCG_RESPONSE_INCOMPLETE"));
    });
  });
}

export function validateConversationResult(value, limit) {
  if (!value || value.state !== "ACHIEVED" || value.operation !== "communication.conversation.list") {
    throw codedError(String(value?.error || "PCG_CONVERSATION_LIST_FAILED"));
  }
  const observation = value.observation;
  const protectedData = value.protected_provider_data;
  const conversations = protectedData?.conversations;
  if (
    !observation
    || observation.provider_content_model_visible !== false
    || observation.bounded !== true
    || protectedData?.purpose !== "PROTECTED_DISPLAY"
    || protectedData?.model_visible !== false
    || !Array.isArray(conversations)
    || !Number.isInteger(observation.count)
    || observation.count !== conversations.length
    || conversations.length > limit
  ) {
    throw codedError("PCG_CONVERSATION_CONTRACT_INVALID");
  }

  const handles = [];
  const protectedConversations = [];
  for (const item of conversations) {
    if (
      !item
      || typeof item.handle !== "string"
      || !/^tgchat:[0-9a-f-]{36}$/.test(item.handle)
      || typeof item.name !== "string"
      || item.name.length < 1
      || item.name.length > 256
      || !["user", "chat", "channel"].includes(item.type)
      || Object.entries(item).some(([key, entryValue]) => (
        typeof key !== "string"
        || key.length > 64
        || (entryValue !== null && !["string", "boolean", "number"].includes(typeof entryValue))
      ))
    ) {
      throw codedError("PCG_CONVERSATION_ENTRY_INVALID");
    }
    handles.push(item.handle);
    // Carry the classification through. This object is what the tool later
    // reads to report kind, forum/topic state and pinned state; stripping it to
    // name and type made every supergroup look like an ordinary chat and every
    // forum look topic-less, because the fallback silently replaced the missing
    // fields with the coarse provider type.
    protectedConversations.push({
      name: item.name,
      type: item.type,
      peer_kind: typeof item.peer_kind === "string" && item.peer_kind ? item.peer_kind : item.type,
      is_forum: item.is_forum === true,
      forum_kind: typeof item.forum_kind === "string" ? item.forum_kind : null,
      pinned: item.pinned === true,
      unread_count: Number.isSafeInteger(item.unread_count) && item.unread_count >= 0 ? item.unread_count : 0,
      unread_mark: item.unread_mark === true,
      has_unread: item.has_unread === true || item.unread_mark === true || (Number.isSafeInteger(item.unread_count) && item.unread_count > 0),
    });
  }

  return {
    public: {
      state: "ACHIEVED",
      count: protectedConversations.length,
      handles,
      bounded: true,
      provider_content_model_visible: false,
      protected_display: true,
    },
    protected: {
      count: protectedConversations.length,
      conversations: protectedConversations,
    },
  };
}

export async function listTelegramConversations(limit = 10, options = {}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
    throw codedError("INVALID_LIMIT");
  }
  const value = await callPcgSocket({
    op: "semantic.invoke",
    operation: "communication.conversation.list",
    purpose: "PROTECTED_DISPLAY",
    args: { limit },
  }, options);
  return validateConversationResult(value, limit);
}

export const telegramConversationsWidgetHtml = `<!doctype html>
<html lang="fa" dir="rtl">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <style>
    :root { color-scheme: light dark; font-family: ui-sans-serif, system-ui, sans-serif; }
    body { margin: 0; padding: 12px; background: transparent; color: CanvasText; }
    h2 { margin: 0 0 10px; font-size: 16px; }
    pre { margin: 0; padding: 12px; overflow: auto; border: 1px solid color-mix(in srgb, CanvasText 18%, transparent); border-radius: 10px; background: color-mix(in srgb, Canvas 92%, CanvasText 8%); direction: ltr; text-align: left; white-space: pre-wrap; }
    .error { color: #b42318; }
  </style>
</head>
<body>
  <h2>گفت‌وگوهای اخیر تلگرام</h2>
  <pre id="output">در حال دریافت…</pre>
  <script>
    const META_KEY = ${JSON.stringify(PROTECTED_CONVERSATIONS_META_KEY)};
    const output = document.getElementById("output");
    function fromEnvelope(envelope) {
      const meta = envelope?._meta;
      return meta?.[META_KEY] || null;
    }
    function render(envelope) {
      const root = window.openai?.toolResponseMetadata;
      const result = envelope || root?.mcp_tool_result || root?.call_tool_result || root;
      const payload = fromEnvelope(result) || fromEnvelope(root);
      const conversations = payload?.conversations;
      if (!Array.isArray(conversations)) return;
      output.classList.remove("error");
      output.textContent = JSON.stringify(conversations, null, 2);
    }
    window.addEventListener("message", (event) => {
      if (event.source !== window.parent) return;
      const message = event.data;
      if (message?.jsonrpc === "2.0" && message.method === "ui/notifications/tool-result") {
        render(message.params);
      }
    }, { passive: true });
    window.addEventListener("openai:set_globals", () => render(), { passive: true });
    render();
    setTimeout(() => {
      if (output.textContent === "در حال دریافت…") {
        output.textContent = "نمایش محافظت‌شده در این میزبان در دسترس نیست.";
        output.classList.add("error");
      }
    }, 3000);
  </script>
</body>
</html>`;

export function registerTelegramConversationTool(server, z, {
  socketPath = "/run/pcg/web.sock",
  releaseGateFile = "/run/cf-state/release-in-progress",
  releaseGateExists = () => false,
} = {}) {
  server.registerResource("telegram-conversations", TELEGRAM_CONVERSATIONS_RESOURCE_URI, {}, async () => ({
    contents: [{
      uri: TELEGRAM_CONVERSATIONS_RESOURCE_URI,
      mimeType: "text/html;profile=mcp-app",
      text: telegramConversationsWidgetHtml,
      _meta: {
        ui: { prefersBorder: true },
        "openai/widgetDescription": "نمایش محافظت‌شدهٔ نام و نوع گفت‌وگوهای اخیر تلگرام.",
      },
    }],
  }));

  server.registerTool("telegram_conversation_list", {
    title: "List recent Telegram conversations",
    description: "Read the most recent Telegram conversations without opening chats or marking them read. Returns conversation names, exact kind, stable handles, and authoritative unread_count/has_unread state. Use this directly for questions such as which recent chats have new/unread messages.",
    inputSchema: { limit: z.number().int().min(1).max(50).optional() },
    outputSchema: {
      state: z.literal("ACHIEVED"),
      count: z.number().int().min(0).max(50),
      handles: z.array(z.string()),
      conversations: z.array(z.object({
        handle: z.string(),
        name: z.string(),
        type: z.string(),
        kind: z.string(),
        is_forum: z.boolean(),
        forum_kind: z.string().nullable(),
        pinned: z.boolean(),
        unread_count: z.number().int().min(0),
        unread_mark: z.boolean(),
        has_unread: z.boolean(),
      })),
      bounded: z.literal(true),
      provider_content_model_visible: z.boolean(),
      protected_display: z.boolean(),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    _meta: {
      ui: { resourceUri: TELEGRAM_CONVERSATIONS_RESOURCE_URI },
      "openai/outputTemplate": TELEGRAM_CONVERSATIONS_RESOURCE_URI,
      "openai/toolInvocation/invoking": "Reading Telegram conversations…",
      "openai/toolInvocation/invoked": "Telegram conversations ready.",
    },
  }, async ({ limit = 10 }) => {
    if (releaseGateExists(releaseGateFile)) {
      return { content: [{ type: "text", text: "Telegram conversation listing is temporarily unavailable during release activation." }], isError: true };
    }
    try {
      const result = await listTelegramConversations(limit, { socketPath });
      const conversations = result.protected.conversations.map((item, index) => ({
        handle: result.public.handles[index],
        name: item.name,
        type: item.type,
        kind: typeof item.peer_kind === "string" && item.peer_kind ? item.peer_kind : item.type,
        is_forum: item.is_forum === true,
        forum_kind: typeof item.forum_kind === "string" ? item.forum_kind : null,
        pinned: item.pinned === true,
        unread_count: Number.isSafeInteger(item.unread_count) ? item.unread_count : 0,
        unread_mark: item.unread_mark === true,
        has_unread: item.has_unread === true,
      }));
      return {
        structuredContent: { ...result.public, provider_content_model_visible: true, conversations },
        content: [{ type: "text", text: `Retrieved ${result.public.count} Telegram conversations.\n${result.protected.conversations.map((item, index) => `${index + 1}. ${item.name} [${conversations[index].kind}${conversations[index].is_forum ? ", forum/topics" : ""}] ${result.public.handles[index]}`).join("\n")}` }],
        _meta: { [PROTECTED_CONVERSATIONS_META_KEY]: result.protected },
      };
    } catch (error) {
      const code = typeof error?.code === "string" ? error.code : "PCG_INGRESS_FAILED";
      return { content: [{ type: "text", text: `Telegram conversation listing failed: ${code}` }], isError: true };
    }
  });
}

export const TELEGRAM_SEMANTIC_CATALOG = Object.freeze([
 {
  "family": "Calls",
  "operation": "communication.call.accept",
  "description": "Accept an exact incoming real-time call/session.",
  "data_use": "NONE",
  "effect": "REALTIME_EXTERNAL"
 },
 {
  "family": "Calls",
  "operation": "communication.call.end",
  "description": "End an exact real-time call/session.",
  "data_use": "NONE",
  "effect": "REALTIME_EXTERNAL"
 },
 {
  "family": "Calls",
  "operation": "communication.call.start",
  "description": "Start a real-time call/session with an exact target.",
  "data_use": "NONE",
  "effect": "REALTIME_EXTERNAL"
 },
 {
  "family": "Contacts",
  "operation": "communication.contact.add",
  "description": "Add/import an exact contact.",
  "data_use": "NONE",
  "effect": "MATERIAL_EXTERNAL"
 },
 {
  "family": "Contacts",
  "operation": "communication.contact.block.set",
  "description": "Set desired blocked state for an exact contact/peer.",
  "data_use": "NONE",
  "effect": "PROVIDER_SYNCED_STATE"
 },
 {
  "family": "Contacts",
  "operation": "communication.contact.delete",
  "description": "Delete an exact contact relationship.",
  "data_use": "NONE",
  "effect": "DESTRUCTIVE_EXTERNAL"
 },
 {
  "family": "Contacts",
  "operation": "communication.contact.list",
  "description": "List bounded contacts.",
  "data_use": "PURPOSE_REQUIRED",
  "effect": "NONE"
 },
 {
  "family": "Contacts",
  "operation": "communication.contact.search",
  "description": "Search contacts and return opaque local identities.",
  "data_use": "PURPOSE_REQUIRED",
  "effect": "NONE"
 },
 {
  "family": "Conversation",
  "operation": "communication.conversation.get",
  "description": "Fetch bounded metadata for one exact conversation without implicit read-state changes.",
  "data_use": "PURPOSE_REQUIRED",
  "effect": "NONE"
 },
 {
  "family": "Conversation",
  "operation": "communication.conversation.list",
  "description": "List bounded conversations without opening them or advancing read state.",
  "data_use": "PURPOSE_REQUIRED",
  "effect": "NONE"
 },
 {
  "family": "Conversation State",
  "operation": "communication.conversation.archive.set",
  "description": "Set desired archived state for an exact conversation.",
  "data_use": "NONE",
  "effect": "PROVIDER_SYNCED_STATE"
 },
 {
  "family": "Conversation State",
  "operation": "communication.conversation.pin.set",
  "description": "Set desired pinned state for an exact conversation.",
  "data_use": "NONE",
  "effect": "PROVIDER_SYNCED_STATE"
 },
 {
  "family": "Diagnostics",
  "operation": "diagnostics.capability_gap.list",
  "description": "Read the server-side record of requests that could not be satisfied, aggregated by operation and error code, so the next release is planned from evidence instead of remembered chat transcripts.",
  "data_use": "PURPOSE_REQUIRED",
  "effect": "NONE"
 },
 {
  "family": "Discovery",
  "operation": "communication.conversation.search",
  "description": "Search conversations and return opaque local identities without opening results.",
  "data_use": "PURPOSE_REQUIRED",
  "effect": "NONE"
 },
 {
  "family": "Drafts",
  "operation": "communication.draft.set",
  "description": "Set or clear a provider-synced draft for one exact conversation.",
  "data_use": "NONE",
  "effect": "PROVIDER_SYNCED_STATE"
 },
 {
  "family": "Files/Media",
  "operation": "communication.attachment.download",
  "description": "Acquire one allowed provider attachment into the private local broker.",
  "data_use": "PURPOSE_REQUIRED",
  "effect": "LOCAL_ACQUISITION"
 },
 {
  "family": "Files/Media",
  "operation": "communication.audio.voice.prepare",
  "description": "Ingest bounded owner-supplied audio and convert it into brokered Telegram-compatible OGG/Opus voice material.",
  "data_use": "NONE",
  "effect": "LOCAL_ACQUISITION"
 },
 {
  "family": "Folders",
  "operation": "communication.chat.folder.list",
  "description": "List provider-synced chat folders/filters.",
  "data_use": "PURPOSE_REQUIRED",
  "effect": "NONE"
 },
 {
  "family": "Folders",
  "operation": "communication.chat.folder.update",
  "description": "Create/update/delete/reorder provider-synced chat folders with explicit desired state.",
  "data_use": "NONE",
  "effect": "PROVIDER_SYNCED_STATE"
 },
 {
  "family": "Groups/Channels",
  "operation": "communication.channel.create",
  "description": "Create a broadcast/channel-like conversation when the provider exposes that semantic.",
  "data_use": "NONE",
  "effect": "MATERIAL_EXTERNAL"
 },
 {
  "family": "Groups/Channels",
  "operation": "communication.channel.update",
  "description": "Update explicit channel properties without hiding provider-specific unsupported fields.",
  "data_use": "NONE",
  "effect": "MATERIAL_EXTERNAL"
 },
 {
  "family": "Groups/Channels",
  "operation": "communication.group.create",
  "description": "Create a group conversation with explicit initial membership.",
  "data_use": "NONE",
  "effect": "MATERIAL_EXTERNAL"
 },
 {
  "family": "Groups/Channels",
  "operation": "communication.group.leave",
  "description": "Leave an exact group/channel.",
  "data_use": "NONE",
  "effect": "DESTRUCTIVE_EXTERNAL"
 },
 {
  "family": "Groups/Channels",
  "operation": "communication.group.member.add",
  "description": "Add/invite an exact member to an exact group/channel.",
  "data_use": "NONE",
  "effect": "MATERIAL_EXTERNAL"
 },
 {
  "family": "Groups/Channels",
  "operation": "communication.group.member.remove",
  "description": "Remove/ban an exact member with explicit provider-supported scope.",
  "data_use": "NONE",
  "effect": "DESTRUCTIVE_EXTERNAL"
 },
 {
  "family": "Groups/Channels",
  "operation": "communication.group.members.list",
  "description": "List bounded members of an exact group/channel where allowed.",
  "data_use": "PURPOSE_REQUIRED",
  "effect": "NONE"
 },
 {
  "family": "Groups/Channels",
  "operation": "communication.invite_link.create",
  "description": "Create an invite link with explicit constraints.",
  "data_use": "NONE",
  "effect": "MATERIAL_EXTERNAL"
 },
 {
  "family": "Groups/Channels",
  "operation": "communication.invite_link.join",
  "description": "Join an exact invite/channel target.",
  "data_use": "NONE",
  "effect": "MATERIAL_EXTERNAL"
 },
 {
  "family": "Groups/Channels",
  "operation": "communication.invite_link.list",
  "description": "List invite links for an exact conversation when authorized.",
  "data_use": "PURPOSE_REQUIRED",
  "effect": "NONE"
 },
 {
  "family": "Groups/Channels",
  "operation": "communication.invite_link.revoke",
  "description": "Revoke one exact invite link.",
  "data_use": "NONE",
  "effect": "DESTRUCTIVE_EXTERNAL"
 },
 {
  "family": "Message Mutation",
  "operation": "communication.message.delete",
  "description": "Delete one exact message with explicit deletion scope.",
  "data_use": "NONE",
  "effect": "DESTRUCTIVE_EXTERNAL"
 },
 {
  "family": "Message Mutation",
  "operation": "communication.message.edit",
  "description": "Edit one exact message under provider-authorized scope.",
  "data_use": "NONE",
  "effect": "MATERIAL_EXTERNAL"
 },
 {
  "family": "Message Mutation",
  "operation": "communication.message.forward-native",
  "description": "Use provider-native forwarding for an exact source and target when supported.",
  "data_use": "CONDITIONAL",
  "effect": "MATERIAL_EXTERNAL"
 },
 {
  "family": "Message Mutation",
  "operation": "communication.message.pin.set",
  "description": "Set desired pinned state for one exact message.",
  "data_use": "NONE",
  "effect": "PROVIDER_SYNCED_STATE"
 },
 {
  "family": "Message Mutation",
  "operation": "communication.message.react",
  "description": "Set or change a reaction on one exact message. Saved Messages is excluded from ordinary reaction mutation because Telegram uses reaction-shaped state there for message tags.",
  "data_use": "NONE",
  "effect": "PROVIDER_SYNCED_STATE"
 },
 {
  "family": "Message Mutation",
  "operation": "communication.message.relay",
  "description": "Copy/relay authorized content across endpoints/providers as a new send with provenance.",
  "data_use": "PURPOSE_REQUIRED",
  "effect": "MATERIAL_EXTERNAL"
 },
 {
  "family": "Message Mutation",
  "operation": "communication.message.reply",
  "description": "Send a new message as a reply to one exact source message.",
  "data_use": "NONE",
  "effect": "MATERIAL_EXTERNAL"
 },
 {
  "family": "Message Mutation",
  "operation": "communication.message.send",
  "description": "Send a new message, optionally with brokered attachments, to one exact target.",
  "data_use": "NONE",
  "effect": "MATERIAL_EXTERNAL"
 },
 {
  "family": "Message Retrieval",
  "operation": "communication.message.fetch",
  "description": "Fetch one exact message without silently marking it read or opening media.",
  "data_use": "PURPOSE_REQUIRED",
  "effect": "NONE"
 },
 {
  "family": "Message Retrieval",
  "operation": "communication.message.replies",
  "description": "Read the provider reply count and bounded reply thread for one exact message.",
  "data_use": "PURPOSE_REQUIRED",
  "effect": "NONE"
 },
 {
  "family": "Message Retrieval",
  "operation": "communication.message.transcribe",
  "description": "Transcribe one exact Telegram voice, audio or round-video message through the configured high-accuracy whole-message speech-to-text path.",
  "data_use": "PURPOSE_REQUIRED",
  "effect": "NONE"
 },
 {
  "family": "Audio",
  "operation": "communication.audio.transcribe",
  "description": "Transcribe one owner-supplied staged audio file through the same high-accuracy whole-message speech-to-text path used for Telegram voice transcription.",
  "data_use": "PURPOSE_REQUIRED",
  "effect": "NONE"
 },
 {
  "family": "Message Retrieval",
  "operation": "communication.message.reaction.get",
  "description": "Read the owner's current visible reaction state on one exact message without changing it. Saved Messages tag metadata is suppressed and reported as no ordinary reaction.",
  "data_use": "PURPOSE_REQUIRED",
  "effect": "NONE"
 },
 {
  "family": "Message Retrieval",
  "operation": "communication.message.list",
  "description": "List bounded messages for an exact conversation without silently widening read/view state.",
  "data_use": "PURPOSE_REQUIRED",
  "effect": "NONE"
 },
 {
  "family": "Message Retrieval",
  "operation": "communication.message.search",
  "description": "Search messages within an explicit scope without implicitly opening a result.",
  "data_use": "PURPOSE_REQUIRED",
  "effect": "NONE"
 },
 {
  "family": "Notifications",
  "operation": "communication.notification.get",
  "description": "Read notification settings at an exact supported scope.",
  "data_use": "CONDITIONAL",
  "effect": "NONE"
 },
 {
  "family": "Notifications",
  "operation": "communication.notification.set",
  "description": "Set notification settings at an exact supported scope.",
  "data_use": "NONE",
  "effect": "PROVIDER_SYNCED_STATE"
 },
 {
  "family": "Polls",
  "operation": "communication.poll.vote",
  "description": "Submit a vote on one exact poll.",
  "data_use": "NONE",
  "effect": "MATERIAL_EXTERNAL"
 },
 {
  "family": "Presence",
  "operation": "communication.presence.set",
  "description": "Set explicit provider presence/online state only where current provider policy allows it.",
  "data_use": "NONE",
  "effect": "PROVIDER_SYNCED_STATE"
 },
 {
  "family": "Profile",
  "operation": "communication.profile.get",
  "description": "Read profile information at an exact supported scope.",
  "data_use": "PURPOSE_REQUIRED",
  "effect": "NONE"
 },
 {
  "family": "Profile",
  "operation": "communication.profile.update",
  "description": "Update explicit profile fields.",
  "data_use": "NONE",
  "effect": "MATERIAL_EXTERNAL"
 },
 {
  "family": "Read/View State",
  "operation": "communication.conversation.mark_read",
  "description": "Explicitly advance provider read state for an exact conversation/message boundary.",
  "data_use": "NONE",
  "effect": "PROVIDER_VISIBLE_READ"
 },
 {
  "family": "Read/View State",
  "operation": "communication.conversation.mark_unread",
  "description": "Explicitly mark a conversation unread when the provider supports it.",
  "data_use": "NONE",
  "effect": "PROVIDER_SYNCED_STATE"
 },
 {
  "family": "Read/View State",
  "operation": "communication.message.open_media",
  "description": "Explicitly open/listen/view exact message content when provider-visible content-open semantics may occur.",
  "data_use": "PURPOSE_REQUIRED",
  "effect": "PROVIDER_VISIBLE_READ"
 },
 {
  "family": "Scheduled Messages",
  "operation": "communication.scheduled.list",
  "description": "List scheduled messages for an exact conversation.",
  "data_use": "PURPOSE_REQUIRED",
  "effect": "NONE"
 },
 {
  "family": "Scheduled Messages",
  "operation": "communication.scheduled.send_now",
  "description": "Release one exact scheduled message immediately.",
  "data_use": "NONE",
  "effect": "MATERIAL_EXTERNAL"
 },
 {
  "family": "Session",
  "operation": "communication.session.status",
  "description": "Inspect the current provider connection/session state without changing provider state.",
  "data_use": "NONE",
  "effect": "NONE"
 },
 {
  "family": "Session",
  "operation": "communication.session.screenshot",
  "description": "Capture the current logged-in Telegram Web viewport without navigating or changing provider read/view state.",
  "data_use": "PURPOSE_REQUIRED",
  "effect": "LOCAL_ACQUISITION"
 },
 {
  "family": "Stories",
  "operation": "communication.story.delete",
  "description": "Delete one exact story.",
  "data_use": "NONE",
  "effect": "DESTRUCTIVE_EXTERNAL"
 },
 {
  "family": "Stories",
  "operation": "communication.story.edit",
  "description": "Edit one exact story.",
  "data_use": "NONE",
  "effect": "MATERIAL_EXTERNAL"
 },
 {
  "family": "Stories",
  "operation": "communication.story.list",
  "description": "List bounded stories under an exact scope.",
  "data_use": "PURPOSE_REQUIRED",
  "effect": "NONE"
 },
 {
  "family": "Stories",
  "operation": "communication.story.open",
  "description": "Explicitly open/view one exact story where provider view state is observable.",
  "data_use": "PURPOSE_REQUIRED",
  "effect": "PROVIDER_VISIBLE_READ"
 },
 {
  "family": "Stories",
  "operation": "communication.story.post",
  "description": "Publish a new story.",
  "data_use": "NONE",
  "effect": "MATERIAL_EXTERNAL"
 },
 {
  "family": "Topics",
  "operation": "communication.topic.create",
  "description": "Create a topic in an exact topic-enabled conversation.",
  "data_use": "NONE",
  "effect": "MATERIAL_EXTERNAL"
 },
 {
  "family": "Topics",
  "operation": "communication.topic.list",
  "description": "List bounded topics for a topic-enabled conversation.",
  "data_use": "PURPOSE_REQUIRED",
  "effect": "NONE"
 }
]);

const TELEGRAM_SEMANTIC_OPERATIONS = new Set(TELEGRAM_SEMANTIC_CATALOG.map((item) => item.operation));

export const TELEGRAM_CONFIRMATION_REQUIRED_OPERATIONS = Object.freeze(new Set([
  ...TELEGRAM_SEMANTIC_CATALOG.filter((item) => item.effect === "DESTRUCTIVE_EXTERNAL").map((item) => item.operation),
  "communication.contact.block.set",
]));

export async function invokeTelegramSemanticOperation(input, options = {}) {
  const operation = String(input?.operation || "").trim();
  if (!TELEGRAM_SEMANTIC_OPERATIONS.has(operation)) {
    const wanted = new Set(operation.toLowerCase().split(/[^a-z0-9]+/u).filter(Boolean));
    const nearest = [...TELEGRAM_SEMANTIC_OPERATIONS]
      .map((name) => {
        const tokens = new Set(name.toLowerCase().split(/[^a-z0-9]+/u).filter(Boolean));
        let score = 0;
        for (const token of wanted) if (tokens.has(token)) score += 1;
        return { name, score };
      })
      .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
      .slice(0, 5)
      .map((item) => item.name);
    const detail = `Unknown communication operation: ${operation}. Nearest available: ${nearest.join(", ")}. Call telegram_capability_list for the full set.`;
    recordConnectorGap({ operation, code: "PCG_OPERATION_UNKNOWN", detail, args: input?.args });
    throw codedError("PCG_OPERATION_UNKNOWN", detail);
  }
  const args = input?.args == null ? {} : input.args;
  if (typeof args !== "object" || Array.isArray(args)) {
    throw codedError("PCG_ARGUMENTS_INVALID", "args must be an object.");
  }
  // One condition, one owner. The semantic layer is the authority on
  // irreversible effects and expects the flag inside args; this connector only
  // recognises the owner's approval and forwards it. Previously the flag was
  // required here at the top level and there inside args, and only args was
  // forwarded, so no combination of inputs could satisfy both and message
  // delete was unreachable. A connector translates; it does not re-implement a
  // semantic-layer policy.
  const confirmationRequired = TELEGRAM_CONFIRMATION_REQUIRED_OPERATIONS.has(operation);
  const confirmed = input?.confirm_irreversible === true || args?.confirm_irreversible === true;
  if (confirmationRequired && !confirmed) {
    const detail = `${operation} is irreversible. Describe the exact effect to the owner, obtain explicit approval, then retry the same call once with confirm_irreversible=true.`;
    recordConnectorGap({ operation, code: "PCG_OWNER_CONFIRMATION_REQUIRED", detail, args });
    throw codedError("PCG_OWNER_CONFIRMATION_REQUIRED", detail);
  }
  const forwardedArgs = confirmationRequired && confirmed
    ? { ...args, confirm_irreversible: true }
    : args;
  const purpose = String(input?.purpose || "OWNER_REQUEST").trim();
  const result = await callPcgSocket({ op: "semantic.invoke", operation, purpose, args: forwardedArgs }, options);
  const state = result?.state;
  if (result?.error || (state && state !== "ACHIEVED")) {
    recordConnectorGap({
      operation,
      code: String(result?.error || state),
      detail: result?.observation?.guidance_detail || null,
      args: forwardedArgs,
    });
  }
  return result;
}

const TELEGRAM_CHAT_HANDLE_RE = /^tgchat:[0-9a-f-]{36}$/;
const TELEGRAM_MESSAGE_HANDLE_RE = /^tgmsg:[0-9a-f-]{36}$/;

function normalizeTelegramDisplayName(value) {
  return String(value || "").normalize("NFKC").trim().toLocaleLowerCase("en-US");
}

const TELEGRAM_SAVED_MESSAGES_DISPLAY_NAME = "Saved Messages";

function isTelegramSavedMessagesName(value) {
  return normalizeTelegramDisplayName(value) === "saved messages";
}

async function resolveTelegramSavedMessagesHandle({ socketPath = "/run/pcg/web.sock" } = {}) {
  const result = await invokeTelegramSemanticOperation({
    operation: "communication.conversation.search",
    purpose: "PROTECTED_DISPLAY",
    args: { query: TELEGRAM_SAVED_MESSAGES_DISPLAY_NAME, limit: 20 },
  }, { socketPath });
  const rows = Array.isArray(result?.protected_provider_data?.conversations)
    ? result.protected_provider_data.conversations
    : [];
  const matches = rows.filter((item) => item
    && TELEGRAM_CHAT_HANDLE_RE.test(String(item.handle || ""))
    && isTelegramSavedMessagesName(item.name));
  if (matches.length === 1) return matches[0].handle;
  if (matches.length > 1) {
    throw codedError("PCG_SAVED_MESSAGES_AMBIGUOUS", "More than one Saved Messages conversation was returned by Telegram.");
  }
  return null;
}

async function isTelegramSavedMessagesConversationHandle(conversationHandle, { socketPath = "/run/pcg/web.sock" } = {}) {
  const handle = String(conversationHandle || "").trim();
  if (!TELEGRAM_CHAT_HANDLE_RE.test(handle)) return false;
  const savedHandle = await resolveTelegramSavedMessagesHandle({ socketPath });
  return typeof savedHandle === "string" && savedHandle === handle;
}

function suppressTelegramSavedMessagesReactionFields(message) {
  if (!message || typeof message !== "object" || Array.isArray(message)) return message;
  return {
    ...message,
    has_reactions: false,
    reaction_total_count: 0,
    reaction_distinct_count: 0,
    reaction_counts: [],
    saved_messages_tag_state_suppressed: true,
  };
}

function telegramSavedMessagesReactionReadResult(messageHandle) {
  return {
    ok: true,
    state: "ACHIEVED",
    operation: "communication.message.reaction.get",
    provider: "telegram",
    realization: "connector-saved-messages-guard",
    observation: {
      message_handle: messageHandle,
      reaction_state_readable: true,
      has_my_reaction: false,
      has_reactions: false,
      reaction_total_count: 0,
      reaction_distinct_count: 0,
      ordinary_reaction_supported: false,
      saved_messages: true,
      saved_messages_tag_state_suppressed: true,
      provider_content_model_visible: false,
    },
    side_effects: [],
    protected_provider_data: {
      purpose: "PROTECTED_DISPLAY",
      model_visible: false,
      message_handle: messageHandle,
      my_reaction_emojis: [],
      my_custom_emoji_reaction_count: 0,
      reaction_counts: [],
    },
  };
}

async function resolveTelegramReactionTarget({
  message_handle,
  conversation,
  latest_message,
}, { socketPath = "/run/pcg/web.sock" } = {}) {
  const explicit = String(message_handle || "").trim();
  if (explicit) {
    if (!TELEGRAM_MESSAGE_HANDLE_RE.test(explicit)) {
      throw codedError("PCG_MESSAGE_HANDLE_INVALID", "message_handle must be an exact tgmsg: handle.");
    }
    const fetched = await invokeTelegramSemanticOperation({
      operation: "communication.message.fetch",
      purpose: "PROTECTED_DISPLAY",
      args: { message_handle: explicit },
    }, { socketPath });
    const conversationHandle = String(
      fetched?.observation?.conversation_handle
      || fetched?.protected_provider_data?.conversation_handle
      || ""
    ).trim();
    if (!TELEGRAM_CHAT_HANDLE_RE.test(conversationHandle)) {
      throw codedError(
        "PCG_REACTION_TARGET_CONTEXT_UNAVAILABLE",
        "CF-server could not prove which Telegram conversation owns this message, so it will not read or mutate reaction state."
      );
    }
    return {
      message_handle: explicit,
      conversation_handle: conversationHandle,
      saved_messages: await isTelegramSavedMessagesConversationHandle(conversationHandle, { socketPath }),
    };
  }

  if (latest_message !== true) {
    throw codedError(
      "PCG_MESSAGE_HANDLE_REQUIRED",
      "Pass message_handle, or pass conversation plus latest_message=true when the owner explicitly means the latest message."
    );
  }
  const rawConversation = String(conversation || "").trim();
  const conversationHandle = await resolveTelegramConversationRef(rawConversation, { socketPath });
  const latestHandle = await latestTelegramMessageHandle(conversationHandle, { socketPath });
  return {
    message_handle: latestHandle,
    conversation_handle: conversationHandle,
    saved_messages: isTelegramSavedMessagesName(rawConversation)
      || await isTelegramSavedMessagesConversationHandle(conversationHandle, { socketPath }),
  };
}

function rejectTelegramSavedMessagesReaction(args = {}) {
  const detail = "Telegram Saved Messages does not expose ordinary visible reactions. Reaction-shaped state there is Saved Messages tag metadata, so CF-server refuses ordinary reaction mutation before any provider write.";
  recordConnectorGap({
    operation: "communication.message.react",
    code: "TELEGRAM_SAVED_MESSAGES_REACTION_UNSUPPORTED",
    detail,
    args,
  });
  throw codedError("TELEGRAM_SAVED_MESSAGES_REACTION_UNSUPPORTED", detail);
}

async function resolveTelegramConversationRef(value, { socketPath = "/run/pcg/web.sock" } = {}) {
  const raw = String(value || "").trim();
  if (!raw) throw codedError("PCG_CONVERSATION_REQUIRED", "Pass an exact Telegram display name or tgchat: handle.");
  if (TELEGRAM_CHAT_HANDLE_RE.test(raw)) return raw;

  const result = await invokeTelegramSemanticOperation({
    operation: "communication.conversation.search",
    purpose: "PROTECTED_DISPLAY",
    args: { query: raw, limit: 20 },
  }, { socketPath });
  const rows = Array.isArray(result?.protected_provider_data?.conversations)
    ? result.protected_provider_data.conversations
    : [];
  const valid = rows.filter((item) => item
    && TELEGRAM_CHAT_HANDLE_RE.test(String(item.handle || ""))
    && typeof item.name === "string");

  const exact = valid.filter((item) => item.name.trim() === raw);
  if (exact.length === 1) return exact[0].handle;
  if (exact.length > 1) {
    throw codedError("PCG_CONVERSATION_AMBIGUOUS", `More than one Telegram conversation is named exactly "${raw}". Use its tgchat: handle.`);
  }

  const folded = normalizeTelegramDisplayName(raw);
  const insensitive = valid.filter((item) => normalizeTelegramDisplayName(item.name) === folded);
  if (insensitive.length === 1) return insensitive[0].handle;
  if (insensitive.length > 1) {
    throw codedError("PCG_CONVERSATION_AMBIGUOUS", `More than one Telegram conversation matches "${raw}". Use its tgchat: handle.`);
  }

  throw codedError("PCG_CONVERSATION_NOT_FOUND", `No exact Telegram conversation named "${raw}" was found. Use the exact display name or tgchat: handle.`);
}

async function latestTelegramMessageHandle(conversationHandle, { socketPath = "/run/pcg/web.sock" } = {}) {
  const result = await invokeTelegramSemanticOperation({
    operation: "communication.message.list",
    purpose: "PROTECTED_DISPLAY",
    args: { conversation_handle: conversationHandle, limit: 1 },
  }, { socketPath });
  const handle = result?.observation?.handles?.[0];
  if (!TELEGRAM_MESSAGE_HANDLE_RE.test(String(handle || ""))) {
    throw codedError("PCG_MESSAGE_NOT_FOUND", "No latest message is available for that Telegram conversation.");
  }
  return handle;
}

async function resolveTelegramMessageRef({
  message_handle,
  conversation,
  latest_message,
}, { socketPath = "/run/pcg/web.sock" } = {}) {
  const explicit = String(message_handle || "").trim();
  if (explicit) {
    if (!TELEGRAM_MESSAGE_HANDLE_RE.test(explicit)) {
      throw codedError("PCG_MESSAGE_HANDLE_INVALID", "message_handle must be an exact tgmsg: handle.");
    }
    return explicit;
  }
  if (latest_message !== true) {
    throw codedError("PCG_MESSAGE_HANDLE_REQUIRED", "Pass message_handle, or pass conversation plus latest_message=true when the owner explicitly means the latest message.");
  }
  const conversationHandle = await resolveTelegramConversationRef(conversation, { socketPath });
  return await latestTelegramMessageHandle(conversationHandle, { socketPath });
}

function telegramDirectToolResult(result) {
  const text = JSON.stringify(result, null, 1);
  return {
    content: [{ type: "text", text: text.length > 60_000 ? text.slice(0, 60_000) + "\n…truncated" : text }],
    isError: result?.state === "FAILED" || Boolean(result?.error),
  };
}

function telegramDirectToolFailure(error) {
  const code = typeof error?.code === "string" ? error.code : "PCG_INGRESS_FAILED";
  return { content: [{ type: "text", text: `Telegram direct action failed: ${code}: ${error?.message || ""}` }], isError: true };
}

export async function exportTelegramBrokerFile(fileHandle, { socketPath = "/run/pcg/web.sock" } = {}) {
  const handle = String(fileHandle || "").trim().toLowerCase();
  if (!/^file:[0-9a-f]{64}$/.test(handle)) throw codedError("TELEGRAM_FILE_HANDLE_INVALID");
  const exported = await callPcgSocket({
    op: "file.export",
    file_handle: handle,
    max_bytes: 32 * 1024 * 1024,
  }, {
    socketPath,
    timeoutMs: 30_000,
    maxBytes: 48 * 1024 * 1024,
  });
  if (exported?.ok !== true || typeof exported?.data_base64 !== "string" || !exported.data_base64) {
    throw codedError(String(exported?.error || "TELEGRAM_FILE_EXPORT_FAILED"));
  }
  return exported;
}


const RVC_WORKER_URL = process.env.CF_RVC_WORKER_URL || "http://127.0.0.1:8794";
const RVC_MAX_INPUT_BYTES = 64 * 1024 * 1024;
const RVC_MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
const RVC_TIMEOUT_MS = 20 * 60 * 1000;

function rvcWorkerError(code, message) {
  return codedError(code || "RVC_WORKER_FAILED", message || code || "RVC worker failed.");
}

async function rvcStatus() {
  let response;
  try {
    response = await fetch(RVC_WORKER_URL + "/status", {
      method: "GET",
      signal: AbortSignal.timeout(4_000),
    });
  } catch (error) {
    throw rvcWorkerError("RVC_WORKER_UNAVAILABLE", String(error?.message || error));
  }
  let payload;
  try { payload = await response.json(); }
  catch { throw rvcWorkerError("RVC_WORKER_RESPONSE_INVALID", "RVC worker returned invalid status JSON."); }
  if (!response.ok) {
    throw rvcWorkerError(payload?.error || "RVC_WORKER_STATUS_FAILED", payload?.message || payload?.error);
  }
  return payload;
}

async function rvcPreflight() {
  const status = await rvcStatus();
  if (status?.runtime_ready !== true) {
    throw rvcWorkerError("RVC_RUNTIME_NOT_INSTALLED", "The pinned RVC runtime is not ready on the VPS.");
  }
  if (status?.model_ready !== true) {
    throw rvcWorkerError("MODEL_NOT_INSTALLED", "The owner's trained RVC model is not installed yet.");
  }
  return status;
}

async function downloadChatFileForRvc(file) {
  const obj = file && typeof file === "object" ? file : null;
  const downloadUrl = typeof file === "string"
    ? file.trim()
    : (typeof obj?.download_url === "string" ? obj.download_url.trim()
      : (typeof obj?.url === "string" ? obj.url.trim() : ""));
  if (!downloadUrl) throw codedError("CHAT_FILE_CLIENT_HANDOFF_UNAVAILABLE", "The ChatGPT client did not provide a usable file URL.");

  let parsed;
  try { parsed = new URL(downloadUrl); }
  catch { throw codedError("CHAT_FILE_CLIENT_HANDOFF_UNAVAILABLE", "The ChatGPT client provided a non-URL file reference."); }

  const host = parsed.hostname.toLowerCase();
  const admitted =
    host === "files.oaiusercontent.com"
    || host.endsWith(".oaiusercontent.com")
    || /^oai[a-z0-9-]*\.blob\.core\.windows\.net$/.test(host);
  if (parsed.protocol !== "https:" || !admitted) {
    throw codedError("CHAT_FILE_CLIENT_HANDOFF_UNAVAILABLE", "The ChatGPT file reference is not on an admitted temporary-file host.");
  }

  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 60_000);
  let response;
  try {
    response = await fetch(parsed, { method: "GET", redirect: "error", signal: abort.signal });
  } catch (error) {
    throw codedError(error?.name === "AbortError" ? "CHAT_FILE_DOWNLOAD_TIMEOUT" : "CHAT_FILE_DOWNLOAD_FAILED");
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) throw codedError("CHAT_FILE_DOWNLOAD_FAILED", "ChatGPT file download returned HTTP " + response.status + ".");

  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > RVC_MAX_INPUT_BYTES) {
    throw codedError("VOICE_CONVERT_SOURCE_TOO_LARGE", "Voice conversion input must be at most 64 MiB.");
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length < 1 || bytes.length > RVC_MAX_INPUT_BYTES) {
    throw codedError("VOICE_CONVERT_SOURCE_SIZE_INVALID", "Voice conversion input must be between 1 byte and 64 MiB.");
  }
  return {
    bytes,
    size_bytes: bytes.length,
    sha256_hex: crypto.createHash("sha256").update(bytes).digest("hex"),
    file_id: typeof obj?.file_id === "string" && obj.file_id ? obj.file_id : null,
    media_type: typeof obj?.mime_type === "string" && obj.mime_type ? obj.mime_type : String(response.headers.get("content-type") || "application/octet-stream"),
  };
}

async function runRvcWorker({ bytes, mediaType, pitch = 0, indexRate = 0.75, outputFormat = "mp3", sourceSha256 }) {
  const url = new URL("/convert", RVC_WORKER_URL);
  url.searchParams.set("pitch", String(pitch));
  url.searchParams.set("index_rate", String(indexRate));
  url.searchParams.set("format", outputFormat);

  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": mediaType || "application/octet-stream",
        "content-length": String(bytes.length),
      },
      body: bytes,
      signal: AbortSignal.timeout(RVC_TIMEOUT_MS + 15_000),
    });
  } catch (error) {
    const code = error?.name === "TimeoutError" || error?.name === "AbortError"
      ? "VOICE_CONVERT_TIMEOUT"
      : "RVC_WORKER_UNAVAILABLE";
    throw rvcWorkerError(code, String(error?.message || error));
  }

  if (!response.ok) {
    let payload = null;
    try { payload = await response.json(); } catch {}
    throw rvcWorkerError(payload?.error || "RVC_INFERENCE_FAILED", payload?.detail || payload?.message || payload?.error);
  }

  const outputBytes = Buffer.from(await response.arrayBuffer());
  if (outputBytes.length < 1 || outputBytes.length > RVC_MAX_OUTPUT_BYTES) {
    throw rvcWorkerError("RVC_OUTPUT_SIZE_INVALID", "RVC output is empty or exceeds the 64 MiB return bound.");
  }

  const workerSourceSha = String(response.headers.get("x-cf-rvc-source-sha256") || "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(workerSourceSha) || workerSourceSha !== String(sourceSha256 || "").toLowerCase()) {
    throw rvcWorkerError("RVC_SOURCE_DIGEST_MISMATCH", "RVC worker source digest did not match the connector input.");
  }
  const outputSha = crypto.createHash("sha256").update(outputBytes).digest("hex");
  const workerOutputSha = String(response.headers.get("x-cf-rvc-output-sha256") || "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(workerOutputSha) || workerOutputSha !== outputSha) {
    throw rvcWorkerError("RVC_OUTPUT_DIGEST_MISMATCH", "RVC worker output digest did not match connector readback.");
  }

  const elapsed = Number(response.headers.get("x-cf-rvc-elapsed-ms"));
  return {
    outputBytes,
    output_sha256: outputSha,
    size_bytes: outputBytes.length,
    elapsed_ms: Number.isFinite(elapsed) ? elapsed : null,
    index_used: response.headers.get("x-cf-rvc-index-used") === "1",
  };
}

export function registerTelegramSemanticTools(server, z, {
  socketPath = "/run/pcg/web.sock",
  stageTelegramFile = null,
  materialUpload = null,
} = {}) {
  function requireMaterialUpload() {
    if (!materialUpload
        || typeof materialUpload.create !== "function"
        || typeof materialUpload.status !== "function"
        || typeof materialUpload.delete !== "function"
        || typeof materialUpload.append !== "function"
        || typeof materialUpload.ready !== "function"
        || typeof materialUpload.markSendStarted !== "function") {
      throw codedError("MATERIAL_UPLOAD_UNAVAILABLE");
    }
    return materialUpload;
  }

  async function createMaterialUpload(args = {}) {
    return requireMaterialUpload().create({
      filename: args.filename,
      media_type: args.media_type,
      size_bytes: args.size_bytes,
      sha256_hex: args.sha256_hex,
    });
  }

  async function materialUploadStatus(args = {}) {
    return await requireMaterialUpload().status(args.upload_id);
  }

  async function deleteMaterialUpload(args = {}) {
    return await requireMaterialUpload().delete(args.upload_id);
  }

  async function sendMaterialUpload(args = {}) {
    const upload = requireMaterialUpload();
    const ready = await upload.ready(args.upload_id);
    const conversation_handle = await resolveTelegramConversationRef(args.target, { socketPath });
    upload.markSendStarted(args.upload_id);
    const result = await invokeTelegramSemanticOperation({
      operation: "communication.message.send",
      args: {
        conversation_handle,
        material_file_handle: ready.material_file_handle,
        filename: ready.filename,
        media_type: ready.media_type,
        size_bytes: ready.size_bytes,
        sha256_hex: ready.sha256_hex,
        caption: typeof args.caption === "string" ? args.caption : "",
      },
    }, { socketPath, timeoutMs: 180_000 });
    return {
      ...result,
      upload_id: args.upload_id,
      uploaded_file: {
        filename: ready.filename,
        media_type: ready.media_type,
        size_bytes: ready.size_bytes,
        sha256_hex: ready.sha256_hex,
      },
    };
  }

  async function transcribeMaterialUpload(args = {}) {
    const upload = requireMaterialUpload();
    const ready = await upload.ready(args.upload_id);
    if (!Number.isSafeInteger(ready.size_bytes) || ready.size_bytes < 1 || ready.size_bytes > 64 * 1024 * 1024) {
      throw codedError("PERPLEXITY_ASR_SOURCE_SIZE_INVALID", "Uploaded audio for transcription must be at most 64 MiB.");
    }
    const speedFactor = args.speed_factor ?? 4;
    if (![1, 2, 4, 8].includes(speedFactor)) {
      throw codedError("PERPLEXITY_ASR_SPEED_FACTOR_UNSUPPORTED", "speed_factor must be one of 1, 2, 4, or 8.");
    }
    return await invokeTelegramSemanticOperation({
      operation: "communication.audio.transcribe",
      args: {
        material_file_handle: ready.material_file_handle,
        filename: ready.filename,
        media_type: ready.media_type,
        size_bytes: ready.size_bytes,
        sha256_hex: ready.sha256_hex,
        language: "fa",
        speed_factor: speedFactor,
      },
    }, { socketPath, timeoutMs: 90_000 });
  }

  async function stageChatUploadedFile(file, {
    maxBytes = 64 * 1024 * 1024,
    timeoutMs = 60_000,
    sizeErrorCode = "PERPLEXITY_ASR_SOURCE_SIZE_INVALID",
  } = {}) {
    const obj = file && typeof file === "object" ? file : null;
    const downloadUrl = typeof file === "string"
      ? file.trim()
      : (typeof obj?.download_url === "string" ? obj.download_url.trim()
        : (typeof obj?.url === "string" ? obj.url.trim() : ""));
    const fileId = typeof obj?.file_id === "string" ? obj.file_id.trim() : "";

    if (!downloadUrl) {
      const keys = obj ? Object.keys(obj).sort().slice(0, 12).join(",") : typeof file;
      throw codedError(
        "CHAT_FILE_CLIENT_HANDOFF_UNAVAILABLE",
        "The ChatGPT client did not provide a usable file URL; reference keys=" + keys + "."
      );
    }

    let parsed;
    try { parsed = new URL(downloadUrl); }
    catch {
      throw codedError(
        "CHAT_FILE_CLIENT_HANDOFF_UNAVAILABLE",
        "The ChatGPT client provided a non-URL file reference."
      );
    }
    const host = parsed.hostname.toLowerCase();
    const admittedTemporaryHost =
      host === "files.oaiusercontent.com"
      || host.endsWith(".oaiusercontent.com")
      || /^oai[a-z0-9-]*\.blob\.core\.windows\.net$/.test(host);
    if (parsed.protocol !== "https:" || !admittedTemporaryHost) {
      throw codedError(
        "CHAT_FILE_CLIENT_HANDOFF_UNAVAILABLE",
        "The ChatGPT file reference is not on an admitted OpenAI temporary-file host; scheme=" + parsed.protocol + " host=" + (host || "(none)") + "."
      );
    }

    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), timeoutMs);
    let response;
    try {
      response = await fetch(parsed, { method: "GET", redirect: "error", signal: abort.signal });
      if (!response.ok) {
        throw codedError("CHAT_FILE_DOWNLOAD_FAILED", "ChatGPT file download returned HTTP " + String(response.status) + ".");
      }

      const declared = Number(response.headers.get("content-length"));
      if (!Number.isSafeInteger(declared) || declared < 1 || declared > maxBytes) {
        throw codedError(sizeErrorCode, "ChatGPT file size is unavailable or outside the admitted bound.");
      }

      const providedName = typeof obj?.file_name === "string" ? obj.file_name.trim() : "";
      const urlLeaf = decodeURIComponent(parsed.pathname.split("/").filter(Boolean).pop() || "");
      const rawName = providedName || (urlLeaf && /\.[A-Za-z0-9]{1,8}$/.test(urlLeaf) ? urlLeaf : "chat-upload.audio");
      const filename = rawName.replace(/[^A-Za-z0-9._ -]/g, "_").slice(0, 128);
      const headerType = String(response.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
      const requestedType = typeof obj?.mime_type === "string" ? obj.mime_type.trim().toLowerCase() : "";
      const mediaType = requestedType || headerType || "application/octet-stream";

      const upload = requireMaterialUpload();
      const created = upload.create({
        filename,
        media_type: mediaType,
        size_bytes: declared,
        sha256_hex: null,
      });
      try {
        const step = 1024 * 1024;
        let offset = 0;
        let carry = Buffer.alloc(0);
        if (!response.body) throw codedError("CHAT_FILE_DOWNLOAD_FAILED", "ChatGPT file response body is unavailable.");
        for await (const incoming of response.body) {
          const bytes = Buffer.from(incoming);
          carry = carry.length ? Buffer.concat([carry, bytes]) : bytes;
          while (carry.length >= step) {
            const chunk = carry.subarray(0, step);
            await upload.append(created.upload_id, offset, { data_base64: chunk.toString("base64") });
            offset += chunk.length;
            carry = carry.subarray(step);
          }
          if (offset + carry.length > declared) {
            throw codedError("CHAT_FILE_SIZE_MISMATCH", "ChatGPT file exceeded its declared size.");
          }
        }
        if (carry.length) {
          await upload.append(created.upload_id, offset, { data_base64: carry.toString("base64") });
          offset += carry.length;
        }
        if (offset !== declared) {
          throw codedError("CHAT_FILE_SIZE_MISMATCH", "ChatGPT file did not match its declared size.");
        }
        const ready = await upload.ready(created.upload_id);
        return {
          upload_id: created.upload_id,
          material_file_handle: ready.material_file_handle,
          file_id: fileId || null,
          filename: ready.filename,
          media_type: ready.media_type,
          size_bytes: ready.size_bytes,
          sha256_hex: ready.sha256_hex,
        };
      } catch (error) {
        try { await upload.delete(created.upload_id); } catch {}
        throw error;
      }
    } catch (error) {
      if (error?.code) throw error;
      throw codedError(
        error?.name === "AbortError" ? "CHAT_FILE_DOWNLOAD_TIMEOUT" : "CHAT_FILE_DOWNLOAD_FAILED",
        "CF-server could not download the ChatGPT-provided file."
      );
    } finally {
      clearTimeout(timer);
    }
  }

  async function connectorLocalOperation(input) {
    if (input.operation === "connector.telegram.file_upload.create") return await createMaterialUpload(input.args || {});
    if (input.operation === "connector.telegram.file_upload.status") return await materialUploadStatus(input.args || {});
    if (input.operation === "connector.telegram.file_upload.delete") return await deleteMaterialUpload(input.args || {});
    if (input.operation === "connector.telegram.file_send") return await sendMaterialUpload(input.args || {});
    return null;
  }
  server.registerTool("telegram_capability_list", {
    title: "List Telegram/communication capabilities",
    description: "Return every canonical communication operation this gateway can forward to the owner\'s Telegram runtime, with family, description and effect class. Use this only when the requested capability is unfamiliar or a direct call reports an unknown operation. Do not call it before routine send, reply, react, edit, delete or forward commands. If the owner asks for the allowed/supported Telegram reaction list, call telegram_reaction_catalog directly instead of guessing from memory.",
    inputSchema: { family: z.string().max(60).optional() },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ family }) => {
    const wanted = String(family || "").trim().toLowerCase();
    const items = (wanted
      ? TELEGRAM_SEMANTIC_CATALOG.filter((item) => item.family.toLowerCase().includes(wanted))
      : TELEGRAM_SEMANTIC_CATALOG).map((item) => ({
        ...item,
        owner_confirmation_required: TELEGRAM_CONFIRMATION_REQUIRED_OPERATIONS.has(item.operation),
      }));
    const payload = {
      count: items.length,
      operations: items,
      reaction_catalog: {
        tool: "telegram_reaction_catalog",
        baseline_count: TELEGRAM_STANDARD_REACTION_BASELINE.length,
        freshness: "fresh_official_telegram_https_per_call",
      },
    };
    return { structuredContent: payload, content: [{ type: "text", text: JSON.stringify(payload, null, 1) }] };
  });

  server.registerTool("telegram_reaction_catalog", {
    title: "List current Telegram reactions",
    description: "Call this directly whenever the owner asks for the allowed/supported Telegram reaction list, asks which standard reaction emojis Telegram currently accepts, or asks whether a candidate emoji is in the global standard reaction vocabulary. Every call performs a fresh HTTPS read of Telegram's official Bot API ReactionTypeEmoji documentation, keeps the canonical 73-item baseline, and appends any newly documented standard emoji. Do not answer reaction-list questions from memory and do not call telegram_react for a list-only request. A particular chat can still restrict this global list.",
    inputSchema: {},
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async () => {
    const catalog = await fetchTelegramReactionCatalog();
    const payload = {
      state: catalog.provider_fresh ? "ACHIEVED" : "IN_DOUBT",
      provider: "telegram",
      scope: "global_standard_emoji_reactions",
      provider_fresh: catalog.provider_fresh === true,
      verification_source: "official_telegram_bot_api_https",
      source: catalog.source,
      fetched_at: catalog.fetched_at,
      baseline_count: catalog.baseline.length,
      official_count: catalog.official.length,
      count: catalog.reactions.length,
      reactions: catalog.reactions,
      new_since_baseline: catalog.new_since_baseline,
      baseline_missing_from_official: catalog.baseline_missing_from_official,
      chat_specific_restrictions_may_narrow: true,
      error: catalog.error,
    };
    return {
      structuredContent: payload,
      content: [{ type: "text", text: JSON.stringify(payload, null, 1) }],
      isError: false,
    };
  });

  server.registerTool("telegram_capability_gaps", {
    title: "Read recorded capability gaps",
    description: "Return the accumulated record of requests that could not be satisfied, from both this connector and the Telegram runtime, aggregated by operation and error code with occurrence counts and the argument names that were supplied. Read this before proposing a fix or a new release: it is evidence collected on the server, not recollection from a chat. Argument values are never recorded.",
    inputSchema: { limit: z.number().int().min(1).max(400).optional() },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ limit = 100 }) => {
    const connector = summarizeConnectorGaps();
    let runtime = null;
    try {
      runtime = await callPcgSocket({
        op: "semantic.invoke",
        operation: "diagnostics.capability_gap.list",
        purpose: "OWNER_REQUEST",
        args: { limit },
      }, { socketPath });
    } catch (error) {
      runtime = { error: typeof error?.code === "string" ? error.code : "PCG_INGRESS_FAILED" };
    }
    const payload = { connector, runtime: runtime?.observation || runtime };
    const text = JSON.stringify(payload, null, 1);
    return { content: [{ type: "text", text: text.length > 60_000 ? text.slice(0, 60_000) + "\n…truncated" : text }] };
  });

  server.registerTool("telegram_mark_read", {
    title: "Mark exact unread Telegram messages read",
    description: "Mark exactly count currently unread messages read in one Telegram conversation. conversation accepts an exact display name or tgchat: handle. count is mandatory; there is no default and no implicit latest/all behavior. To mark all unread messages, first read the current unread_count and pass that exact integer as count. The runtime resolves and verifies the cumulative provider read boundary fail-closed before any effect.",
    inputSchema: {
      conversation: z.string().min(1).max(256),
      count: z.number().int().min(1).max(10000),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async ({ conversation, count }) => {
    try {
      const conversation_handle = await resolveTelegramConversationRef(conversation, { socketPath });
      const result = await invokeTelegramSemanticOperation({
        operation: "communication.conversation.mark_read",
        args: { conversation_handle, count },
      }, { socketPath });
      return telegramDirectToolResult(result);
    } catch (error) {
      return telegramDirectToolFailure(error);
    }
  });

  server.registerTool("telegram_mark_unread", {
    title: "Mark a Telegram conversation unread",
    description: "Mark one exact Telegram conversation unread. conversation accepts an exact display name or tgchat: handle. This sets the provider unread marker as an idempotent desired state without changing the message read cursor or unread message count.",
    inputSchema: {
      conversation: z.string().min(1).max(256),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ conversation }) => {
    try {
      const conversation_handle = await resolveTelegramConversationRef(conversation, { socketPath });
      const result = await invokeTelegramSemanticOperation({
        operation: "communication.conversation.mark_unread",
        args: { conversation_handle, marked_unread: true },
      }, { socketPath });
      return telegramDirectToolResult(result);
    } catch (error) {
      return telegramDirectToolFailure(error);
    }
  });

  server.registerTool("telegram_mute", {
    title: "Mute or unmute a Telegram conversation",
    description: "Set the exact desired mute state for one Telegram conversation. conversation accepts an exact display name or tgchat: handle. muted=true mutes; muted=false unmutes. This is desired-state and idempotent, not a toggle.",
    inputSchema: {
      conversation: z.string().min(1).max(256),
      muted: z.boolean(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ conversation, muted }) => {
    try {
      const conversation_handle = await resolveTelegramConversationRef(conversation, { socketPath });
      const result = await invokeTelegramSemanticOperation({
        operation: "communication.notification.set",
        args: { conversation_handle, muted },
      }, { socketPath });
      return telegramDirectToolResult(result);
    } catch (error) {
      return telegramDirectToolFailure(error);
    }
  });

  server.registerTool("telegram_file_upload", {
    title: "Stage a large file for Telegram",
    description: "Create, inspect, or delete a resumable large-file upload ticket on the existing CF-server endpoint. File bytes are uploaded with HTTP PUT to the returned upload_url using Upload-Offset; no whole-file base64 is used.",
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
      let result;
      if (input.action === "create") result = await createMaterialUpload(input);
      else if (input.action === "status") result = await materialUploadStatus(input);
      else result = await deleteMaterialUpload(input);
      return { structuredContent: result, content: [{ type: "text", text: JSON.stringify(result, null, 1) }] };
    } catch (error) {
      return telegramDirectToolFailure(error);
    }
  });

  server.registerTool("telegram_file_upload_chunk", {
    title: "Upload one bounded Telegram file chunk",
    description: "Append one bounded chunk to an existing large-file upload ticket. For real file bytes pass data_base64 (decoded maximum 2 MiB). For large transport qualification only, zero_bytes writes a deterministic zero-filled chunk up to 16 MiB without model-visible bulk data. offset must equal the current staged offset, so interrupted uploads resume safely.",
    inputSchema: {
      upload_id: z.string().regex(/^[0-9a-f]{64}$/),
      offset: z.number().int().nonnegative(),
      data_base64: z.string().max(2900000).optional(),
      zero_bytes: z.number().int().min(1).max(16777216).optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async ({ upload_id, offset, data_base64, zero_bytes }) => {
    try {
      const result = await requireMaterialUpload().append(upload_id, offset, { data_base64, zero_bytes });
      return { structuredContent: result, content: [{ type: "text", text: JSON.stringify(result, null, 1) }] };
    } catch (error) {
      return telegramDirectToolFailure(error);
    }
  });

  server.registerTool("telegram_file_send", {
    title: "Send staged large file to Telegram",
    description: "Send one completed CF-server large-file upload to Telegram without reserializing its bytes. target accepts an exact display name or tgchat: handle. An upload ticket is one-shot once provider dispatch begins.",
    inputSchema: {
      upload_id: z.string().regex(/^[0-9a-f]{64}$/),
      target: z.string().min(1).max(256),
      caption: z.string().max(1024).optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async (input) => {
    try {
      const result = await sendMaterialUpload(input);
      return telegramDirectToolResult(result);
    } catch (error) {
      return telegramDirectToolFailure(error);
    }
  });

  server.registerTool("telegram_unread_list", {
    title: "List unread Telegram conversations",
    description: "Immediate read-only hot path for questions about which recent Telegram conversations have new/unread messages. Call directly; do not use capability discovery. Returns only unread conversations from the requested recent window with unread_count.",
    inputSchema: {
      limit: z.number().int().min(1).max(50).optional(),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ limit = 30 }) => {
    try {
      const listed = await listTelegramConversations(limit, { socketPath });
      const unread = listed.protected.conversations
        .map((item, index) => ({
          handle: listed.public.handles[index],
          name: item.name,
          kind: typeof item.peer_kind === "string" && item.peer_kind ? item.peer_kind : item.type,
          unread_count: Number.isSafeInteger(item.unread_count) ? item.unread_count : 0,
          unread_mark: item.unread_mark === true,
          has_unread: item.has_unread === true,
        }))
        .filter((item) => item.has_unread);
      const payload = {
        state: "ACHIEVED",
        scanned_count: listed.public.count,
        unread_conversation_count: unread.length,
        unread_message_count: unread.reduce((sum, item) => sum + item.unread_count, 0),
        conversations: unread,
      };
      return {
        structuredContent: payload,
        content: [{ type: "text", text: JSON.stringify(payload, null, 1) }],
      };
    } catch (error) {
      return telegramDirectToolFailure(error);
    }
  });

  server.registerTool("telegram_reaction_get", {
    title: "Read my Telegram reaction",
    description: "Immediate read-only hot path for questions such as 'what is my reaction on the latest message from X?'. Prefer message_handle when known; when the owner explicitly means the latest/last message, pass conversation as an exact display name or tgchat: handle and latest_message=true. Saved Messages does not expose ordinary visible reactions: tag metadata is suppressed and this tool returns no reaction emoji with ordinary_reaction_supported=false.",
    inputSchema: {
      message_handle: z.string().max(80).optional(),
      conversation: z.string().max(256).optional(),
      latest_message: z.boolean().optional(),
      speed_factor: z.union([z.literal(1), z.literal(2), z.literal(4), z.literal(8)]).optional(),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async (input) => {
    try {
      const target = await resolveTelegramReactionTarget(input, { socketPath });
      if (target.saved_messages) {
        const result = telegramSavedMessagesReactionReadResult(target.message_handle);
        const payload = {
          state: "ACHIEVED",
          message_handle: target.message_handle,
          reaction_state_readable: true,
          ordinary_reaction_supported: false,
          saved_messages: true,
          saved_messages_tag_state_suppressed: true,
          has_my_reaction: false,
          my_reaction_emojis: [],
          my_custom_emoji_reaction_count: 0,
          has_reactions: false,
          reaction_total_count: 0,
          reaction_distinct_count: 0,
          reaction_counts: [],
          elapsed_ms: null,
        };
        return {
          structuredContent: payload,
          content: [{ type: "text", text: JSON.stringify(payload, null, 1) }],
          isError: false,
        };
      }
      const result = await invokeTelegramSemanticOperation({
        operation: "communication.message.reaction.get",
        args: { message_handle: target.message_handle },
      }, { socketPath });
      const protectedData = result?.protected_provider_data || {};
      const payload = {
        state: result?.state || "FAILED",
        message_handle: target.message_handle,
        reaction_state_readable: result?.observation?.reaction_state_readable === true,
        ordinary_reaction_supported: true,
        saved_messages: false,
        saved_messages_tag_state_suppressed: false,
        has_my_reaction: result?.observation?.has_my_reaction === true,
        my_reaction_emojis: Array.isArray(protectedData.my_reaction_emojis) ? protectedData.my_reaction_emojis : [],
        my_custom_emoji_reaction_count: Number.isSafeInteger(protectedData.my_custom_emoji_reaction_count)
          ? protectedData.my_custom_emoji_reaction_count
          : 0,
        has_reactions: result?.observation?.has_reactions === true,
        reaction_total_count: Number.isSafeInteger(result?.observation?.reaction_total_count) ? result.observation.reaction_total_count : 0,
        reaction_distinct_count: Number.isSafeInteger(result?.observation?.reaction_distinct_count) ? result.observation.reaction_distinct_count : 0,
        reaction_counts: Array.isArray(protectedData.reaction_counts) ? protectedData.reaction_counts : [],
        elapsed_ms: Number.isFinite(result?.observation?.elapsed_ms) ? result.observation.elapsed_ms : null,
      };
      return {
        structuredContent: payload,
        content: [{ type: "text", text: JSON.stringify(payload, null, 1) }],
        isError: result?.state === "FAILED" || Boolean(result?.error),
      };
    } catch (error) {
      return telegramDirectToolFailure(error);
    }
  });

  server.registerTool("telegram_conversation_search", {
    title: "Search Telegram conversations",
    description: "Immediate read-only provider-side search for Telegram conversations by name. Use this directly instead of listing recent chats. Results are ranked in Telegram provider search order and include stable tgchat: handles.",
    inputSchema: {
      query: z.string().min(1).max(128),
      limit: z.number().int().min(1).max(50).optional(),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ query, limit = 20 }) => {
    try {
      const result = await invokeTelegramSemanticOperation({
        operation: "communication.conversation.search",
        args: { query, limit },
      }, { socketPath });
      const rows = Array.isArray(result?.protected_provider_data?.conversations)
        ? result.protected_provider_data.conversations
        : [];
      const payload = {
        state: result?.state || "FAILED",
        query,
        count: rows.length,
        ordering: result?.observation?.ordering || "provider_search_order",
        conversations: rows,
        elapsed_ms: Number.isFinite(result?.observation?.elapsed_ms) ? result.observation.elapsed_ms : null,
      };
      return { structuredContent: payload, content: [{ type: "text", text: JSON.stringify(payload, null, 1) }], isError: result?.state === "FAILED" || Boolean(result?.error) };
    } catch (error) { return telegramDirectToolFailure(error); }
  });

  server.registerTool("telegram_contact_search", {
    title: "Search Telegram contacts",
    description: "Immediate read-only provider-side search of Telegram contacts. Use this when the person may exist in contacts even without a recent conversation. Results are ranked in Telegram contact-provider order and include stable tgchat: handles usable by send.",
    inputSchema: {
      query: z.string().min(1).max(128),
      limit: z.number().int().min(1).max(50).optional(),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ query, limit = 20 }) => {
    try {
      const result = await invokeTelegramSemanticOperation({
        operation: "communication.contact.search",
        args: { query, limit },
      }, { socketPath });
      const rows = Array.isArray(result?.protected_provider_data?.contacts)
        ? result.protected_provider_data.contacts
        : [];
      const payload = {
        state: result?.state || "FAILED",
        query,
        count: rows.length,
        ordering: result?.observation?.ordering || "contact_provider_order",
        contacts: rows,
        elapsed_ms: Number.isFinite(result?.observation?.elapsed_ms) ? result.observation.elapsed_ms : null,
      };
      return { structuredContent: payload, content: [{ type: "text", text: JSON.stringify(payload, null, 1) }], isError: result?.state === "FAILED" || Boolean(result?.error) };
    } catch (error) { return telegramDirectToolFailure(error); }
  });

  server.registerTool("telegram_message_list", {
    title: "Read recent Telegram messages",
    description: "Immediate read-only hot path for 'read the last N messages in X' or 'what was our last message?'. conversation accepts an exact display name or tgchat: handle and is resolved inside CF-server; no separate conversation search is needed. In Saved Messages, Telegram tag metadata that shares the provider reaction structure is suppressed from ordinary reaction fields.",
    inputSchema: {
      conversation: z.string().min(1).max(256),
      limit: z.number().int().min(1).max(100).optional(),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ conversation, limit = 10 }) => {
    try {
      const conversation_handle = await resolveTelegramConversationRef(conversation, { socketPath });
      const result = await invokeTelegramSemanticOperation({
        operation: "communication.message.list",
        args: { conversation_handle, limit },
      }, { socketPath });
      const rows = Array.isArray(result?.protected_provider_data?.messages)
        ? result.protected_provider_data.messages
        : [];
      const saved_messages = isTelegramSavedMessagesName(conversation)
        || await isTelegramSavedMessagesConversationHandle(conversation_handle, { socketPath });
      const visibleRows = saved_messages
        ? rows.map((message) => suppressTelegramSavedMessagesReactionFields(message))
        : rows;
      const payload = {
        state: result?.state || "FAILED",
        conversation_handle,
        count: visibleRows.length,
        ordering: "newest_first",
        saved_messages,
        saved_messages_tag_state_suppressed: saved_messages,
        messages: visibleRows,
      };
      return { structuredContent: payload, content: [{ type: "text", text: JSON.stringify(payload, null, 1) }], isError: result?.state === "FAILED" || Boolean(result?.error) };
    } catch (error) { return telegramDirectToolFailure(error); }
  });

  server.registerTool("telegram_message_search", {
    title: "Search Telegram messages",
    description: "Immediate read-only provider-side message search. Search all Telegram messages by omitting conversation, or search within one named conversation by passing its exact display name or tgchat: handle. Results preserve Telegram provider ranking, include stable tgmsg: handles for immediate follow-up reply/forward/react/edit, and include ranked conversation groups when matches span multiple chats. Do not page backward manually when this tool can answer the request.",
    inputSchema: {
      query: z.string().min(1).max(128),
      conversation: z.string().max(256).optional(),
      limit: z.number().int().min(1).max(50).optional(),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ query, conversation, limit = 20 }) => {
    try {
      const args = { query, limit };
      if (typeof conversation === "string" && conversation.trim()) {
        args.conversation_handle = await resolveTelegramConversationRef(conversation, { socketPath });
      }
      const result = await invokeTelegramSemanticOperation({
        operation: "communication.message.search",
        args,
      }, { socketPath });
      const protectedData = result?.protected_provider_data || {};
      const rows = Array.isArray(protectedData.results) ? protectedData.results : [];
      const groups = Array.isArray(protectedData.conversation_groups) ? protectedData.conversation_groups : [];
      const payload = {
        state: result?.state || "FAILED",
        query,
        scope: result?.observation?.scope || (args.conversation_handle ? "CONVERSATION" : "GLOBAL"),
        conversation_handle: result?.observation?.conversation_handle || args.conversation_handle || null,
        count: rows.length,
        conversation_count: Number.isSafeInteger(result?.observation?.conversation_count) ? result.observation.conversation_count : groups.length,
        ordering: result?.observation?.ordering || "telegram_provider_search_order",
        continuation_ready: result?.observation?.continuation_ready === true,
        results: rows,
        conversation_groups: groups,
        elapsed_ms: Number.isFinite(result?.observation?.elapsed_ms) ? result.observation.elapsed_ms : null,
      };
      return { structuredContent: payload, content: [{ type: "text", text: JSON.stringify(payload, null, 1) }], isError: result?.state === "FAILED" || Boolean(result?.error) };
    } catch (error) { return telegramDirectToolFailure(error); }
  });

  server.registerTool("telegram_message_replies", {
    title: "Read Telegram message replies",
    description: "Immediate read-only hot path for reading the provider reply count and replies attached to one exact Telegram message. Prefer a known tgmsg: message_handle from search. Returned reply messages keep stable tgmsg: handles for immediate reply/forward/react/edit continuation.",
    inputSchema: {
      message_handle: z.string().max(80).optional(),
      conversation: z.string().max(256).optional(),
      latest_message: z.boolean().optional(),
      limit: z.number().int().min(1).max(100).optional(),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async (input) => {
    try {
      const message_handle = await resolveTelegramMessageRef(input, { socketPath });
      const result = await invokeTelegramSemanticOperation({
        operation: "communication.message.replies",
        args: { message_handle, limit: input.limit ?? 50 },
      }, { socketPath });
      const replies = Array.isArray(result?.protected_provider_data?.replies)
        ? result.protected_provider_data.replies
        : [];
      const payload = {
        state: result?.state || "FAILED",
        message_handle,
        reply_count: Number.isSafeInteger(result?.observation?.reply_count) ? result.observation.reply_count : replies.length,
        returned_count: replies.length,
        ordering: result?.observation?.ordering || "telegram_provider_reply_order",
        continuation_ready: result?.observation?.continuation_ready === true,
        replies,
        elapsed_ms: Number.isFinite(result?.observation?.elapsed_ms) ? result.observation.elapsed_ms : null,
      };
      return { structuredContent: payload, content: [{ type: "text", text: JSON.stringify(payload, null, 1) }], isError: result?.state === "FAILED" || Boolean(result?.error) };
    } catch (error) {
      return telegramDirectToolFailure(error);
    }
  });

  server.registerTool("telegram_attachment_get", {
    title: "Get Telegram media attachment",
    description: "Download and return one exact Telegram attachment without opening the chat or widening read/view state. Supports photos, files, videos, stickers, GIF/animations, voice notes, audio/music, and round videos. When Telegram provides a visual thumbnail for sticker/GIF/video media, the tool returns that preview inline while preserving the original attachment as an expiring file link. Voice/audio defaults to a portable MP3; set portable_format=original for the source asset.",
    inputSchema: {
      message_handle: z.string().max(80).optional(),
      conversation: z.string().max(256).optional(),
      latest_message: z.boolean().optional(),
      attachment_handle: z.string().max(90).optional(),
      attachment_index: z.number().int().min(1).max(10).optional(),
      portable_format: z.enum(["original", "mp3"]).optional(),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async (input) => {
    try {
      if (typeof stageTelegramFile !== "function") throw codedError("TELEGRAM_FILE_STAGING_UNAVAILABLE");
      const message_handle = await resolveTelegramMessageRef(input, { socketPath });
      const fetched = await invokeTelegramSemanticOperation({
        operation: "communication.message.fetch",
        args: { message_handle },
      }, { socketPath });
      const message = fetched?.protected_provider_data?.message;
      const attachments = Array.isArray(message?.attachments) ? message.attachments : [];
      if (!attachments.length) throw codedError("PCG_ATTACHMENT_NOT_FOUND", "That Telegram message has no downloadable attachment.");

      let attachment = null;
      const explicit = String(input.attachment_handle || "").trim();
      if (explicit) {
        attachment = attachments.find((item) => item?.handle === explicit) || null;
        if (!attachment) throw codedError("PCG_ATTACHMENT_HANDLE_NOT_FOUND", "attachment_handle is not attached to that message.");
      } else {
        const index = input.attachment_index ?? 1;
        attachment = attachments[index - 1] || null;
        if (!attachment) throw codedError("PCG_ATTACHMENT_INDEX_OUT_OF_RANGE", "attachment_index is outside the message attachment list.");
      }

      const attachmentIsAudio = attachment?.media_kind === "voice"
        || attachment?.media_kind === "audio"
        || (typeof attachment?.media_type === "string" && attachment.media_type.startsWith("audio/"));
      const portableFormat = input.portable_format || (attachmentIsAudio ? "mp3" : "original");
      const downloaded = await invokeTelegramSemanticOperation({
        operation: "communication.attachment.download",
        args: { message_handle, attachment_handle: attachment.handle, portable_format: portableFormat },
      }, { socketPath });
      if (downloaded?.state !== "ACHIEVED") {
        throw codedError(String(downloaded?.error || downloaded?.state || "PCG_ATTACHMENT_DOWNLOAD_FAILED"));
      }

      const localFile = downloaded?.protected_provider_data?.local_file;
      const fileMeta = downloaded?.protected_provider_data?.attachment || {};
      const exported = await exportTelegramBrokerFile(localFile?.file_handle, { socketPath });
      const staged = await stageTelegramFile({
        file_handle: localFile?.file_handle,
        filename: fileMeta.filename || attachment.filename || null,
        media_type: fileMeta.media_type || attachment.media_type || "application/octet-stream",
        size_bytes: fileMeta.size_bytes || attachment.size_bytes || exported.size_bytes || null,
        sha256_hex: fileMeta.sha256_hex || exported.sha256_hex || null,
        data_base64: exported.data_base64,
      });

      let previewStaged = null;
      const previewLocalFile = downloaded?.protected_provider_data?.preview_local_file;
      const previewMeta = downloaded?.protected_provider_data?.preview || {};
      if (typeof previewLocalFile?.file_handle === "string" && previewLocalFile.file_handle) {
        try {
          const previewExported = await exportTelegramBrokerFile(previewLocalFile.file_handle, { socketPath });
          previewStaged = await stageTelegramFile({
            file_handle: previewLocalFile.file_handle,
            filename: previewMeta.filename || "telegram-preview.jpg",
            media_type: previewMeta.media_type || "image/jpeg",
            size_bytes: previewMeta.size_bytes || previewExported.size_bytes || null,
            sha256_hex: previewMeta.sha256_hex || previewExported.sha256_hex || null,
            data_base64: previewExported.data_base64,
          });
        } catch {
          previewStaged = null;
        }
      }

      const metadata = {
        state: "ACHIEVED",
        message_handle,
        attachment_handle: attachment.handle,
        media_kind: attachment.media_kind ?? null,
        media_type: staged.mime_type,
        size_bytes: staged.size_bytes,
        filename: staged.filename,
        portable_format: portableFormat,
        converted: fileMeta.converted === true,
        source_media_type: fileMeta.source_media_type || attachment.media_type || null,
        source_size_bytes: fileMeta.source_size_bytes || attachment.size_bytes || null,
        duration_seconds: attachment.duration_seconds ?? null,
        title: attachment.title ?? null,
        performer: attachment.performer ?? null,
        sticker_emoji: attachment.sticker_emoji ?? null,
        sticker_format: attachment.sticker_format ?? null,
        animated: attachment.animated === true,
        width: Number.isSafeInteger(attachment.width) ? attachment.width : null,
        height: Number.isSafeInteger(attachment.height) ? attachment.height : null,
        preview_available: previewStaged !== null,
        preview: previewStaged ? {
          media_type: previewStaged.mime_type,
          size_bytes: previewStaged.size_bytes,
          filename: previewStaged.filename,
          download_path: previewStaged.download_path,
          expires_after_seconds: previewStaged.expires_after_seconds,
        } : null,
        download_path: staged.download_path,
        expires_after_seconds: staged.expires_after_seconds,
      };

      const content = [{ type: "text", text: JSON.stringify(metadata, null, 1) }];
      if (previewStaged && typeof previewStaged.data_base64 === "string" && previewStaged.data_base64) {
        content.push({
          type: "resource",
          resource: {
            uri: "https://cf-onshape.duckdns.org" + previewStaged.download_path,
            mimeType: previewStaged.mime_type,
            blob: previewStaged.data_base64,
          },
        });
        content.push({
          type: "resource_link",
          uri: "https://cf-onshape.duckdns.org" + staged.download_path,
          name: staged.filename,
          mimeType: staged.mime_type,
          size: staged.size_bytes,
          description: "Original Telegram attachment; expiring download.",
        });
      } else if (typeof staged.data_base64 === "string" && staged.data_base64) {
        content.push({
          type: "resource",
          resource: {
            uri: "https://cf-onshape.duckdns.org" + staged.download_path,
            mimeType: staged.mime_type,
            blob: staged.data_base64,
          },
        });
      } else {
        content.push({
          type: "resource_link",
          uri: "https://cf-onshape.duckdns.org" + staged.download_path,
          name: staged.filename,
          mimeType: staged.mime_type,
          size: staged.size_bytes,
          description: "Expiring Telegram attachment download.",
        });
      }
      return { structuredContent: metadata, content };
    } catch (error) {
      return telegramDirectToolFailure(error);
    }
  });

  server.registerTool("telegram_transcribe", {
    title: "Transcribe Telegram voice or audio",
    description: "Immediate read-only hot path for converting an exact Telegram voice note, audio message, or round video to text. The default path uses the live high-accuracy anonymous Perplexity/Soniox whole-message transcription route with 4x stream pacing. If the user explicitly requests 1x, 2x, 4x, or 8x, pass that value as speed_factor; otherwise omit it and use 4x. Prefer a known tgmsg: message_handle. Use telegram_attachment_get separately only when the user also wants the playable/downloadable media file.",
    inputSchema: {
      message_handle: z.string().max(80).optional(),
      conversation: z.string().max(256).optional(),
      latest_message: z.boolean().optional(),
      speed_factor: z.union([z.literal(1), z.literal(2), z.literal(4), z.literal(8)]).optional(),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async (input) => {
    try {
      const message_handle = await resolveTelegramMessageRef(input, { socketPath });
      const result = await invokeTelegramSemanticOperation({
        operation: "communication.message.transcribe",
        args: { message_handle, mode: "perplexity", language: "fa", speed_factor: input.speed_factor ?? 4 },
      }, { socketPath });
      const protectedData = result?.protected_provider_data || {};
      const payload = {
        state: result?.state || "FAILED",
        message_handle,
        media_kind: result?.observation?.media_kind ?? null,
        transcription_mode: result?.observation?.transcription_mode ?? null,
        transcription_pending: result?.observation?.transcription_pending === true,
        transcript_available: result?.observation?.transcript_available === true,
        transcript: typeof protectedData.transcript === "string" ? protectedData.transcript : "",
        asr_engine: result?.observation?.asr_engine ?? protectedData?.asr_engine ?? null,
        asr_model: result?.observation?.asr_model ?? protectedData?.asr_model ?? null,
        whole_message: result?.observation?.whole_message === true || protectedData?.whole_message === true,
        stream_speed_factor: Number.isInteger(result?.observation?.stream_speed_factor)
          ? result.observation.stream_speed_factor
          : (Number.isInteger(protectedData?.stream_speed_factor) ? protectedData.stream_speed_factor : (input.speed_factor ?? 4)),
        asr_cache_hit: result?.observation?.asr_cache_hit === true,
        asr_inference_ms: Number.isFinite(result?.observation?.asr_inference_ms) ? result.observation.asr_inference_ms : null,
        elapsed_ms: Number.isFinite(result?.observation?.elapsed_ms) ? result.observation.elapsed_ms : null,
        error: result?.error || null,
      };
      return { structuredContent: payload, content: [{ type: "text", text: JSON.stringify(payload, null, 1) }], isError: result?.state === "FAILED" || Boolean(result?.error) };
    } catch (error) {
      return telegramDirectToolFailure(error);
    }
  });


  server.registerTool("voice_convert", {
    title: "Convert voice to the owner's trained voice",
    description: "Self-hosted voice-to-voice conversion through the fixed owner RVC model on the personal VPS. action=status checks the pinned host worker without audio. action=convert accepts one ChatGPT audio attachment and returns converted audio. This is not text-to-speech. Inference concurrency is fixed at one.",
    inputSchema: {
      action: z.enum(["status", "convert"]),
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
      pitch: z.number().int().min(-12).max(12).optional(),
      index_rate: z.number().min(0).max(1).optional(),
      output_format: z.enum(["mp3", "wav"]).optional(),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    _meta: { "openai/fileParams": ["file"] },
  }, async (input) => {
    try {
      if (input.action === "status") {
        const payload = await rvcStatus();
        return { structuredContent: payload, content: [{ type: "text", text: JSON.stringify(payload, null, 1) }] };
      }
      if (!input.file) throw codedError("VOICE_CONVERT_SOURCE_REQUIRED", "action=convert requires one ChatGPT audio file.");
      const workerStatus = await rvcPreflight();
      const format = input.output_format || "mp3";
      const source = await downloadChatFileForRvc(input.file);
      const run = await runRvcWorker({
        bytes: source.bytes,
        mediaType: source.media_type,
        pitch: input.pitch ?? 0,
        indexRate: input.index_rate ?? 0.75,
        outputFormat: format,
        sourceSha256: source.sha256_hex,
      });
      const mimeType = format === "wav" ? "audio/wav" : "audio/mpeg";
      const payload = {
        state: "ACHIEVED",
        engine: "RVC",
        self_hosted: true,
        worker: {
          rvc_commit: workerStatus?.rvc_commit ?? null,
          torch: workerStatus?.torch ?? null,
          runtime_ready: workerStatus?.runtime_ready === true,
          model_ready: workerStatus?.model_ready === true,
        },
        source_size_bytes: source.size_bytes,
        source_sha256: source.sha256_hex,
        output_format: format,
        output_size_bytes: run.size_bytes,
        output_sha256: run.output_sha256,
        pitch: input.pitch ?? 0,
        index_rate: input.index_rate ?? 0.75,
        elapsed_ms: run.elapsed_ms,
        model_fixed: true,
        index_used: run.index_used,
      };
      return {
        structuredContent: payload,
        content: [
          { type: "text", text: JSON.stringify(payload, null, 1) },
          {
            type: "resource",
            resource: {
              uri: "urn:capability-fabric:voice-convert:" + run.output_sha256,
              mimeType,
              blob: run.outputBytes.toString("base64"),
            },
          },
        ],
      };
    } catch (error) {
      return telegramDirectToolFailure(error);
    }
  });

  server.registerTool("audio_upload", {
    title: "Stage audio for transcription",
    description: "Reliable private staging path for owner-supplied audio when the ChatGPT native file handoff is unavailable. This never sends the file to Telegram. Use create, then one or more append calls with exact offsets, then pass the completed upload_id to audio_transcribe. Use status to resume safely and delete to clean up.",
    inputSchema: {
      action: z.enum(["create", "append", "status", "delete"]),
      upload_id: z.string().regex(/^[0-9a-f]{64}$/).optional(),
      filename: z.string().min(1).max(128).optional(),
      media_type: z.string().min(3).max(128).optional(),
      size_bytes: z.number().int().min(1).max(64 * 1024 * 1024).optional(),
      sha256_hex: z.string().regex(/^[0-9a-fA-F]{64}$/).optional(),
      offset: z.number().int().nonnegative().optional(),
      data_base64: z.string().max(2900000).optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async (input) => {
    try {
      let result;
      if (input.action === "create") {
        if (!input.filename || !input.media_type || !Number.isSafeInteger(input.size_bytes)) {
          throw codedError("AUDIO_UPLOAD_CREATE_ARGUMENTS_REQUIRED", "create requires filename, media_type, and size_bytes.");
        }
        result = await createMaterialUpload(input);
      } else if (input.action === "append") {
        if (!input.upload_id || !Number.isSafeInteger(input.offset) || typeof input.data_base64 !== "string" || !input.data_base64) {
          throw codedError("AUDIO_UPLOAD_APPEND_ARGUMENTS_REQUIRED", "append requires upload_id, offset, and data_base64.");
        }
        result = await requireMaterialUpload().append(input.upload_id, input.offset, { data_base64: input.data_base64 });
      } else if (input.action === "status") {
        if (!input.upload_id) throw codedError("AUDIO_UPLOAD_ID_REQUIRED", "status requires upload_id.");
        result = await materialUploadStatus(input);
      } else {
        if (!input.upload_id) throw codedError("AUDIO_UPLOAD_ID_REQUIRED", "delete requires upload_id.");
        result = await deleteMaterialUpload(input);
      }
      return { structuredContent: result, content: [{ type: "text", text: JSON.stringify(result, null, 1) }] };
    } catch (error) {
      return telegramDirectToolFailure(error);
    }
  });

  server.registerTool("audio_transcribe", {
    title: "Transcribe uploaded audio",
    description: "Transcribe owner-supplied audio through the same anonymous Perplexity/Soniox whole-message engine as telegram_transcribe, without sending the file to Telegram. Preferred path: pass the ChatGPT attachment in file; the connector accepts the host-supplied native file reference in either string or object form. Durable fallback: stage bytes privately with audio_upload and pass the completed upload_id here. Default stream pacing is 4x; only pass 1x, 2x, 4x, or 8x when the user explicitly asks for that speed.",
    inputSchema: {
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
      speed_factor: z.union([z.literal(1), z.literal(2), z.literal(4), z.literal(8)]).optional(),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    _meta: { "openai/fileParams": ["file"] },
  }, async (input) => {
    let transientUploadId = null;
    try {
      if (input.file && input.upload_id) {
        throw codedError("AUDIO_TRANSCRIBE_SOURCE_AMBIGUOUS", "Pass either file or upload_id, not both.");
      }
      let uploadId = input.upload_id || null;
      let chatFileId = null;
      if (input.file) {
        const staged = await stageChatUploadedFile(input.file);
        transientUploadId = staged.upload_id;
        uploadId = staged.upload_id;
        chatFileId = staged.file_id;
      }
      if (!uploadId) {
        throw codedError("AUDIO_TRANSCRIBE_SOURCE_REQUIRED", "Pass one ChatGPT file or one completed upload_id.");
      }

      const result = await transcribeMaterialUpload({ upload_id: uploadId, speed_factor: input.speed_factor });
      const protectedData = result?.protected_provider_data || {};
      const payload = {
        state: result?.state || "FAILED",
        upload_id: uploadId,
        chat_file_id: chatFileId,
        transcription_mode: result?.observation?.transcription_mode ?? null,
        transcription_pending: result?.observation?.transcription_pending === true,
        transcript_available: result?.observation?.transcript_available === true,
        transcript: typeof protectedData.transcript === "string" ? protectedData.transcript : "",
        source_filename: result?.observation?.source_filename ?? null,
        source_media_type: result?.observation?.source_media_type ?? null,
        source_size_bytes: Number.isSafeInteger(result?.observation?.source_size_bytes) ? result.observation.source_size_bytes : null,
        source_sha256: result?.observation?.source_sha256 ?? protectedData?.source_sha256 ?? null,
        asr_engine: result?.observation?.asr_engine ?? protectedData?.asr_engine ?? null,
        asr_model: result?.observation?.asr_model ?? protectedData?.asr_model ?? null,
        whole_message: result?.observation?.whole_message === true || protectedData?.whole_message === true,
        stream_speed_factor: Number.isInteger(result?.observation?.stream_speed_factor)
          ? result.observation.stream_speed_factor
          : (Number.isInteger(protectedData?.stream_speed_factor) ? protectedData.stream_speed_factor : (input.speed_factor ?? 4)),
        asr_cache_hit: result?.observation?.asr_cache_hit === true,
        asr_inference_ms: Number.isFinite(result?.observation?.asr_inference_ms) ? result.observation.asr_inference_ms : null,
        elapsed_ms: Number.isFinite(result?.observation?.elapsed_ms) ? result.observation.elapsed_ms : null,
        error: result?.error || null,
      };
      if (transientUploadId && payload.transcription_pending !== true) {
        try { await deleteMaterialUpload({ upload_id: transientUploadId }); } catch {}
      }
      return {
        structuredContent: payload,
        content: [{ type: "text", text: JSON.stringify(payload, null, 1) }],
        isError: result?.state === "FAILED" || Boolean(result?.error),
      };
    } catch (error) {
      if (transientUploadId) {
        try { await deleteMaterialUpload({ upload_id: transientUploadId }); } catch {}
      }
      return telegramDirectToolFailure(error);
    }
  });

  server.registerTool("telegram_screenshot", {
    title: "Capture logged-in Telegram screenshot",
    description: "Capture the current viewport of the logged-in Telegram Web session running on the server and return the image directly. This does not navigate, open another chat, or change read/view state.",
    inputSchema: {
      format: z.enum(["jpeg", "png"]).optional(),
      quality: z.number().int().min(40).max(95).optional(),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ format = "jpeg", quality = 80 }) => {
    try {
      if (typeof stageTelegramFile !== "function") throw codedError("TELEGRAM_FILE_STAGING_UNAVAILABLE");
      const result = await invokeTelegramSemanticOperation({
        operation: "communication.session.screenshot",
        args: { format, quality },
      }, { socketPath });
      if (result?.state !== "ACHIEVED") {
        throw codedError(String(result?.error || result?.state || "PCG_SCREENSHOT_FAILED"));
      }
      const localFile = result?.protected_provider_data?.local_file;
      const shotMeta = result?.protected_provider_data?.screenshot || {};
      const exported = await exportTelegramBrokerFile(localFile?.file_handle, { socketPath });
      const staged = await stageTelegramFile({
        file_handle: localFile?.file_handle,
        filename: shotMeta.filename || null,
        media_type: shotMeta.media_type || (format === "png" ? "image/png" : "image/jpeg"),
        size_bytes: shotMeta.size_bytes || exported.size_bytes || null,
        sha256_hex: shotMeta.sha256_hex || exported.sha256_hex || null,
        data_base64: exported.data_base64,
      });
      const metadata = {
        state: "ACHIEVED",
        logged_in: result?.observation?.logged_in === true,
        current_viewport: result?.observation?.current_viewport === true,
        navigation_unchanged: result?.observation?.navigation_unchanged === true,
        viewport_width: result?.observation?.viewport_width ?? null,
        viewport_height: result?.observation?.viewport_height ?? null,
        media_type: staged.mime_type,
        size_bytes: staged.size_bytes,
        filename: staged.filename,
        download_path: staged.download_path,
        expires_after_seconds: staged.expires_after_seconds,
        elapsed_ms: Number.isFinite(result?.observation?.elapsed_ms) ? result.observation.elapsed_ms : null,
      };
      const content = [{ type: "text", text: JSON.stringify(metadata, null, 1) }];
      if (typeof staged.data_base64 === "string" && staged.data_base64) {
        content.push({
          type: "resource",
          resource: {
            uri: "https://cf-onshape.duckdns.org" + staged.download_path,
            mimeType: staged.mime_type,
            blob: staged.data_base64,
          },
        });
      } else {
        content.push({
          type: "resource_link",
          uri: "https://cf-onshape.duckdns.org" + staged.download_path,
          name: staged.filename,
          mimeType: staged.mime_type,
          size: staged.size_bytes,
          description: "Expiring Telegram session screenshot.",
        });
      }
      return { structuredContent: metadata, content };
    } catch (error) {
      return telegramDirectToolFailure(error);
    }
  });

  server.registerTool("telegram_voice_send_file", {
    title: "Send an audio file as Telegram Voice Message",
    description: "Convert owner-supplied audio to Telegram-compatible OGG/Opus on the shared material plane and send it as a new native Telegram Voice Message. Preferred path: pass a ChatGPT attachment in file. Durable fallback: pass a completed large-file upload_id. No whole-file base64 path is used. target accepts an exact Telegram display name or tgchat: handle.",
    inputSchema: {
      target: z.string().min(1).max(256),
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
      filename: z.string().min(1).max(128).optional(),
      media_type: z.string().min(1).max(128).optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    _meta: { "openai/fileParams": ["file"] },
  }, async (input) => {
    let transientUploadId = null;
    try {
      const sourceCount = Number(Boolean(input.file)) + Number(Boolean(input.upload_id));
      if (sourceCount !== 1) {
        throw codedError("PCG_VOICE_SOURCE_AMBIGUOUS", "Pass exactly one of file or upload_id.");
      }

      const conversation_handle = await resolveTelegramConversationRef(input.target, { socketPath });
      let prepared;

      let ready;
      if (input.file) {
        const staged = await stageChatUploadedFile(input.file, {
          maxBytes: 2 * 1024 * 1024 * 1024,
          timeoutMs: 12 * 60 * 1000,
          sizeErrorCode: "OWNER_AUDIO_SIZE_INVALID",
        });
        transientUploadId = staged.upload_id;
        ready = staged;
      } else {
        ready = await requireMaterialUpload().ready(input.upload_id);
      }
      prepared = await invokeTelegramSemanticOperation({
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
        try { await deleteMaterialUpload({ upload_id: transientUploadId }); } catch {}
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

      const sent = await invokeTelegramSemanticOperation({
        operation: "communication.message.send",
        args: {
          conversation_handle,
          material_file_handle: material.file_handle,
          filename: material.filename,
          media_type: material.media_type,
          size_bytes: material.size_bytes,
          sha256_hex: material.sha256_hex,
          voice_message: true,
          duration_seconds: durationSeconds,
          caption: "",
        },
      }, { socketPath, timeoutMs: 180_000 });

      const payload = {
        state: sent?.state || "FAILED",
        conversation_handle,
        created_message_handle: sent?.observation?.created_message_handle ?? null,
        voice_message: true,
        voice_message_confirmed: sent?.observation?.voice_message_confirmed === true,
        converted: prepared?.observation?.converted === true,
        input_mode: prepared?.observation?.input_mode ?? "material_file",
        source_media_type: prepared?.observation?.source_media_type ?? null,
        source_size_bytes: prepared?.observation?.source_size_bytes ?? null,
        output_media_type: prepared?.observation?.output_media_type ?? material.media_type,
        output_size_bytes: prepared?.observation?.output_size_bytes ?? material.size_bytes,
        duration_seconds: durationSeconds,
        error: sent?.error || null,
      };
      return {
        structuredContent: payload,
        content: [{ type: "text", text: JSON.stringify(payload, null, 1) }],
        isError: sent?.state === "FAILED" || Boolean(sent?.error),
      };
    } catch (error) {
      if (transientUploadId) {
        try { await deleteMaterialUpload({ upload_id: transientUploadId }); } catch {}
      }
      return telegramDirectToolFailure(error);
    }
  });

  server.registerTool("telegram_send", {
    title: "Send Telegram message",
    description: "Immediate hot path for ordinary Telegram send requests. Call this directly; do not list capabilities or conversations first. target accepts an exact Telegram display name or tgchat: handle and is resolved inside CF-server.",
    inputSchema: {
      target: z.string().min(1).max(256),
      text: z.string().min(1).max(16_000),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async ({ target, text }) => {
    try {
      const conversation_handle = await resolveTelegramConversationRef(target, { socketPath });
      const result = await invokeTelegramSemanticOperation({
        operation: "communication.message.send",
        args: { conversation_handle, text },
      }, { socketPath });
      return telegramDirectToolResult(result);
    } catch (error) {
      return telegramDirectToolFailure(error);
    }
  });

  server.registerTool("telegram_reply", {
    title: "Reply to Telegram message",
    description: "Immediate hot path for Telegram replies. Call directly. Prefer an existing tgmsg: message_handle. If the owner explicitly says latest/last message, pass conversation as an exact display name or tgchat: handle and latest_message=true; CF-server resolves it internally.",
    inputSchema: {
      message_handle: z.string().max(80).optional(),
      conversation: z.string().max(256).optional(),
      latest_message: z.boolean().optional(),
      text: z.string().min(1).max(16_000),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async (input) => {
    try {
      const message_handle = await resolveTelegramMessageRef(input, { socketPath });
      const result = await invokeTelegramSemanticOperation({
        operation: "communication.message.reply",
        args: { message_handle, text: input.text },
      }, { socketPath });
      return telegramDirectToolResult(result);
    } catch (error) {
      return telegramDirectToolFailure(error);
    }
  });

  server.registerTool("telegram_react", {
    title: "React to Telegram message",
    description: "Immediate hot path for setting, changing or removing a Telegram reaction. Call directly for an actual mutation. Prefer an existing tgmsg: message_handle; when the owner explicitly means the latest message, use conversation plus latest_message=true. Saved Messages is not an ordinary visible-reaction surface: this tool proves the target conversation and refuses Saved Messages before any provider mutation. For a list/support question such as which reaction emojis are allowed, call telegram_reaction_catalog instead.",
    inputSchema: {
      message_handle: z.string().max(80).optional(),
      conversation: z.string().max(256).optional(),
      latest_message: z.boolean().optional(),
      emoji: z.string().max(32).optional(),
      remove: z.boolean().optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async (input) => {
    try {
      if (input.remove !== true && !String(input.emoji || "").trim()) {
        throw codedError("PCG_REACTION_REQUIRED", "Pass emoji when setting or changing a reaction.");
      }
      const target = await resolveTelegramReactionTarget(input, { socketPath });
      if (target.saved_messages) rejectTelegramSavedMessagesReaction(input);
      const args = { message_handle: target.message_handle };
      if (String(input.emoji || "").trim()) args.emoji = String(input.emoji).trim();
      if (input.remove === true) args.remove = true;
      const result = await invokeTelegramSemanticOperation({
        operation: "communication.message.react",
        args,
      }, { socketPath });
      return telegramDirectToolResult(result);
    } catch (error) {
      return telegramDirectToolFailure(error);
    }
  });

  server.registerTool("telegram_forward", {
    title: "Forward Telegram message",
    description: "Immediate hot path for native Telegram forwarding. Call directly; do not list capabilities first. target accepts an exact display name or tgchat: handle. Prefer source message_handle; if the owner explicitly says latest/last message from a conversation, pass source plus latest_message=true. CF-server resolves source/target internally.",
    inputSchema: {
      message_handle: z.string().max(80).optional(),
      source: z.string().max(256).optional(),
      latest_message: z.boolean().optional(),
      target: z.string().min(1).max(256),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async (input) => {
    try {
      const message_handle = await resolveTelegramMessageRef({
        message_handle: input.message_handle,
        conversation: input.source,
        latest_message: input.latest_message,
      }, { socketPath });
      const conversation_handle = await resolveTelegramConversationRef(input.target, { socketPath });
      const result = await invokeTelegramSemanticOperation({
        operation: "communication.message.forward-native",
        args: { message_handle, conversation_handle },
      }, { socketPath });
      return telegramDirectToolResult(result);
    } catch (error) {
      return telegramDirectToolFailure(error);
    }
  });

  server.registerTool("telegram_edit", {
    title: "Edit Telegram message",
    description: "Immediate hot path for editing a Telegram message. Call directly. Prefer an existing tgmsg: message_handle; when the owner explicitly means the latest message in a conversation, pass conversation plus latest_message=true.",
    inputSchema: {
      message_handle: z.string().max(80).optional(),
      conversation: z.string().max(256).optional(),
      latest_message: z.boolean().optional(),
      text: z.string().min(1).max(16_000),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async (input) => {
    try {
      const message_handle = await resolveTelegramMessageRef(input, { socketPath });
      const result = await invokeTelegramSemanticOperation({
        operation: "communication.message.edit",
        args: { message_handle, text: input.text },
      }, { socketPath });
      return telegramDirectToolResult(result);
    } catch (error) {
      return telegramDirectToolFailure(error);
    }
  });

  server.registerTool("telegram_semantic_invoke", {
    title: "Invoke a Telegram/communication operation",
    description: "Execute a Telegram action directly on the owner's behalf. For routine owner commands, prefer the typed tools. Saved Messages is not an ordinary visible-reaction surface: communication.message.react is refused there before any provider mutation, and communication.message.reaction.get suppresses Saved Messages tag metadata. For communication.audio.voice.prepare, args may contain artifact_id from onshape_artifact; CF-server stages that artifact privately into the shared material plane and passes only a material handle to PCG. Irreversible operations additionally require confirm_irreversible=true after the owner explicitly approves that exact effect.",
    inputSchema: {
      operation: z.string().min(3).max(120),
      args: z.record(z.any()).optional(),
      purpose: z.string().max(60).optional(),
      confirm_irreversible: z.boolean().optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  }, async (input) => {
    try {
      const connectorLocal = await connectorLocalOperation(input);
      if (connectorLocal !== null) {
        const text = JSON.stringify(connectorLocal, null, 1);
        return { content: [{ type: "text", text }], isError: connectorLocal?.state === "FAILED" || Boolean(connectorLocal?.error) };
      }
      if (
        input.operation === "communication.message.react"
        || input.operation === "communication.message.reaction.get"
      ) {
        const messageHandle = String(input.args?.message_handle || "").trim();
        if (messageHandle) {
          const target = await resolveTelegramReactionTarget({ message_handle: messageHandle }, { socketPath });
          if (target.saved_messages) {
            if (input.operation === "communication.message.react") {
              rejectTelegramSavedMessagesReaction(input.args || {});
            }
            const guarded = telegramSavedMessagesReactionReadResult(target.message_handle);
            const guardedText = JSON.stringify(guarded, null, 1);
            return { content: [{ type: "text", text: guardedText }], isError: false };
          }
        }
      }
      let forwarded = input;
      let transientArtifactUploadId = null;
      if (input.operation === "communication.audio.voice.prepare" && typeof input.args?.artifact_id === "string") {
        const artifactId = input.args.artifact_id.trim();
        if (!/^[0-9a-f]{32}$/.test(artifactId)) throw codedError("ARTIFACT_ID_INVALID");
        const root = "/tmp/onshape-artifacts";
        const dataPath = path.join(root, artifactId + ".bin");
        const metaPath = path.join(root, artifactId + ".json");
        let meta;
        let stat;
        try {
          meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
          stat = fs.lstatSync(dataPath);
        } catch {
          throw codedError("ARTIFACT_NOT_FOUND");
        }
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > 2 * 1024 * 1024 * 1024) {
          throw codedError("OWNER_AUDIO_SIZE_INVALID");
        }
        if (Number(meta?.size || 0) !== stat.size) throw codedError("ARTIFACT_SIZE_MISMATCH");
        const filename = typeof meta?.filename === "string" && meta.filename ? meta.filename : "audio";
        const mediaType = typeof meta?.content_type === "string" && meta.content_type ? meta.content_type : "application/octet-stream";
        const upload = requireMaterialUpload();
        const created = upload.create({ filename, media_type: mediaType, size_bytes: stat.size, sha256_hex: null });
        transientArtifactUploadId = created.upload_id;
        try {
          let offset = 0;
          for await (const incoming of fs.createReadStream(dataPath, { highWaterMark: 1024 * 1024 })) {
            const chunk = Buffer.from(incoming);
            await upload.append(created.upload_id, offset, { data_base64: chunk.toString("base64") });
            offset += chunk.length;
          }
          if (offset !== stat.size) throw codedError("ARTIFACT_SIZE_MISMATCH");
          const ready = await upload.ready(created.upload_id);
          forwarded = {
            ...input,
            args: {
              ...input.args,
              artifact_id: undefined,
              material_file_handle: ready.material_file_handle,
              filename: ready.filename,
              media_type: ready.media_type,
              size_bytes: ready.size_bytes,
              sha256_hex: ready.sha256_hex,
            },
          };
        } catch (error) {
          try { await upload.delete(created.upload_id); } catch {}
          transientArtifactUploadId = null;
          throw error;
        }
      }
      const result = await invokeTelegramSemanticOperation(forwarded, { socketPath });
      if (transientArtifactUploadId) {
        try { await deleteMaterialUpload({ upload_id: transientArtifactUploadId }); } catch {}
        transientArtifactUploadId = null;
      }
      const text = JSON.stringify(result, null, 1);
      return {
        content: [{ type: "text", text: text.length > 60_000 ? text.slice(0, 60_000) + "\n…truncated" : text }],
        isError: result?.state === "FAILED" || Boolean(result?.error),
      };
    } catch (error) {
      const code = typeof error?.code === "string" ? error.code : "PCG_INGRESS_FAILED";
      return { content: [{ type: "text", text: `Telegram operation failed: ${code}: ${error?.message || ""}` }], isError: true };
    }
  });
}