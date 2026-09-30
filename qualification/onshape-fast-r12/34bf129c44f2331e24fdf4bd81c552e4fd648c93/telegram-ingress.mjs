import net from "node:net";

export const TELEGRAM_CONVERSATIONS_RESOURCE_URI = "ui://capability-fabric/telegram-conversations-v1.html";
export const PROTECTED_CONVERSATIONS_META_KEY = "com.capability-fabric.pcg/protectedConversations";

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
    protectedConversations.push({ name: item.name, type: item.type });
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
    description: "Read the most recent Telegram conversations without opening chats or marking them read. Returns conversation names, exact kind (user, bot, group, supergroup, channel), whether the conversation is a forum with topics, and stable handles. Use a handle as the conversation identity for other Telegram operations.",
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
  "description": "Set or change a reaction on one exact message.",
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
    throw codedError("PCG_OPERATION_UNKNOWN", `Unknown communication operation: ${operation}`);
  }
  const args = input?.args == null ? {} : input.args;
  if (typeof args !== "object" || Array.isArray(args)) {
    throw codedError("PCG_ARGUMENTS_INVALID", "args must be an object.");
  }
  if (TELEGRAM_CONFIRMATION_REQUIRED_OPERATIONS.has(operation) && input?.confirm_irreversible !== true) {
    throw codedError(
      "PCG_OWNER_CONFIRMATION_REQUIRED",
      `${operation} is irreversible. Describe the exact effect to the owner, obtain explicit approval, then retry with confirm_irreversible=true.`,
    );
  }
  const purpose = String(input?.purpose || "OWNER_REQUEST").trim();
  return await callPcgSocket({ op: "semantic.invoke", operation, purpose, args }, options);
}

export function registerTelegramSemanticTools(server, z, {
  socketPath = "/run/pcg/web.sock",
} = {}) {
  server.registerTool("telegram_capability_list", {
    title: "List Telegram/communication capabilities",
    description: "Return every canonical communication operation this gateway can forward to the owner's Telegram runtime, with family, description and effect class. Call this when you need the exact operation name for telegram_semantic_invoke.",
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
    return { content: [{ type: "text", text: JSON.stringify({ count: items.length, operations: items }, null, 1) }] };
  });

  server.registerTool("telegram_semantic_invoke", {
    title: "Invoke a Telegram/communication operation",
    description: "Execute one canonical communication operation on the owner's Telegram runtime on the owner's behalf. Pass the exact operation name from telegram_capability_list plus its arguments, for example communication.message.send, communication.message.reply, communication.message.react, communication.message.forward-native, communication.conversation.pin.set, communication.topic.list, communication.attachment.download. Conversation, topic and message identities come from the list/search operations. Irreversible operations additionally require confirm_irreversible=true after the owner explicitly approves that exact effect. The runtime is the authority on argument names and returns an explicit error when an argument or capability is missing; read that error instead of guessing.",
    inputSchema: {
      operation: z.string().min(3).max(120),
      args: z.record(z.any()).optional(),
      purpose: z.string().max(60).optional(),
      confirm_irreversible: z.boolean().optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  }, async (input) => {
    try {
      const result = await invokeTelegramSemanticOperation(input, { socketPath });
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
