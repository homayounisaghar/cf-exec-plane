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
        !["handle", "name", "type", "pinned", "sponsored", "proxy_sponsor", "sponsor_kind", "is_forum", "forum_kind", "list_section"].includes(key)
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
  <h2>۱۰ گفت‌وگوی اخیر تلگرام</h2>
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
    description: "Read the most recent Telegram conversations without opening chats or marking them read. Names and types are delivered only to a protected UI component; model-visible output contains count and opaque handles only.",
    inputSchema: { limit: z.number().int().min(1).max(50).optional() },
    outputSchema: {
      state: z.literal("ACHIEVED"),
      count: z.number().int().min(0).max(50),
      handles: z.array(z.string()),
      bounded: z.literal(true),
      provider_content_model_visible: z.literal(false),
      protected_display: z.literal(true),
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
      return {
        structuredContent: result.public,
        content: [{ type: "text", text: `Retrieved ${result.public.count} Telegram conversations. Names and types are visible only in the protected component.` }],
        _meta: { [PROTECTED_CONVERSATIONS_META_KEY]: result.protected },
      };
    } catch (error) {
      const code = typeof error?.code === "string" ? error.code : "PCG_INGRESS_FAILED";
      return { content: [{ type: "text", text: `Telegram conversation listing failed: ${code}` }], isError: true };
    }
  });
}
