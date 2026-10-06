import fs from "node:fs";
import crypto from "node:crypto";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerBaleConversationTool } from "./bale-ingress.mjs";

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
      "Queue a fast bounded filename search over Android shared storage using the device MediaStore files index.",
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


function registerAndroidMessaging(server) {
  server.registerTool("android_sms_status", {
    title: "Android SMS access status",
    description: "Read Android Agent SMS/default-role and contact permission readiness.",
    inputSchema: {},
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async () => textResult({ build_id: BUILD_ID, command: await paaPublish("sms.status", {}) }));

  server.registerTool("android_sms_list", {
    title: "List Android SMS messages",
    description: "Queue a bounded read of SMS messages from the phone Telephony provider.",
    inputSchema: {
      box: z.enum(["any","inbox","sent","draft","outbox","failed","queued"]).optional(),
      limit: z.number().int().min(1).max(50).optional(),
      address: z.string().max(160).optional(),
      unread_only: z.boolean().optional(),
      since_ms: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (input) => textResult({
    build_id: BUILD_ID,
    command: await paaPublish("sms.list", {
      box: input.box || "any",
      limit: input.limit || 20,
      address: input.address || "",
      unread_only: input.unread_only === true,
      since_ms: input.since_ms || 0,
    }),
  }));

  server.registerTool("android_sms_conversation_list", {
    title: "List Android SMS conversations",
    description: "Queue a bounded conversation-level read from the phone SMS provider. Returns one latest-message summary per unique thread.",
    inputSchema: {
      limit: z.number().int().min(1).max(50).optional(),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (input) => textResult({
    build_id: BUILD_ID,
    command: await paaPublish("sms.conversation_list", {
      limit: input.limit || 20,
    }),
  }));

  server.registerTool("android_sms_search", {
    title: "Search Android SMS messages",
    description: "Queue a bounded text/address search over SMS messages on the phone.",
    inputSchema: {
      query: z.string().trim().min(1).max(300),
      box: z.enum(["any","inbox","sent","draft","outbox","failed","queued"]).optional(),
      limit: z.number().int().min(1).max(50).optional(),
      since_ms: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (input) => textResult({
    build_id: BUILD_ID,
    command: await paaPublish("sms.search", {
      query: input.query.trim(),
      box: input.box || "any",
      limit: input.limit || 20,
      since_ms: input.since_ms || 0,
    }),
  }));

  server.registerTool("android_contact_search", {
    title: "Search Android contacts",
    description: "Queue a bounded name/phone-number search over the phone contacts provider.",
    inputSchema: {
      query: z.string().trim().min(1).max(200),
      limit: z.number().int().min(1).max(50).optional(),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (input) => textResult({
    build_id: BUILD_ID,
    command: await paaPublish("contacts.search", {
      query: input.query.trim(),
      limit: input.limit || 20,
    }),
  }));

  server.registerTool("android_sms_send", {
    title: "Send SMS from Android phone",
    description: "Queue one SMS send through Android SmsManager. Reading and sending do not require Android Agent to be the default SMS app; a successful receipt proves framework send acknowledgement, not carrier delivery.",
    inputSchema: {
      recipient: z.string().trim().min(1).max(160),
      body: z.string().min(1).max(10000),
      subscription_id: z.number().int().min(-1).max(2147483647).optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async (input) => textResult({
    build_id: BUILD_ID,
    command: await paaPublish("sms.send", {
      recipient: input.recipient.trim(),
      body: input.body,
      subscription_id: Number.isInteger(input.subscription_id) ? input.subscription_id : -1,
    }),
  }));

  server.registerTool("android_sms_mark_read", {
    title: "Mark Android SMS read or unread",
    description: "Queue a provider mutation to mark one SMS read/seen or unread on the phone. Requires Android Agent to hold the default SMS role.",
    inputSchema: {
      message_id: z.string().regex(/^[0-9]{1,19}$/),
      read: z.boolean().optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (input) => textResult({
    build_id: BUILD_ID,
    command: await paaPublish("sms.mark_read", {
      message_id: input.message_id,
      read: input.read !== false,
    }),
  }));

  server.registerTool("android_sms_delete", {
    title: "Delete Android SMS",
    description: "Permanently delete one SMS from the phone provider. Requires explicit confirm=true and Android Agent to hold the default SMS role.",
    inputSchema: {
      message_id: z.string().regex(/^[0-9]{1,19}$/),
      confirm: z.boolean(),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  }, async (input) => {
    if (input.confirm !== true) {
      return textResult({ build_id: BUILD_ID, status: "REJECTED", reason: "confirmation_required" });
    }
    return textResult({
      build_id: BUILD_ID,
      command: await paaPublish("sms.delete", {
        message_id: input.message_id,
        confirm: true,
      }),
    });
  });

  server.registerTool("android_sms_thread_delete", {
    title: "Delete Android SMS thread",
    description: "Permanently delete all SMS rows in one thread. Requires explicit confirm=true and Android Agent to temporarily hold the default SMS role. MMS is outside this typed scope.",
    inputSchema: {
      thread_id: z.string().regex(/^[0-9]{1,19}$/),
      confirm: z.boolean(),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  }, async (input) => {
    if (input.confirm !== true) {
      return textResult({ build_id: BUILD_ID, status: "REJECTED", reason: "confirmation_required" });
    }
    return textResult({
      build_id: BUILD_ID,
      command: await paaPublish("sms.thread_delete", {
        thread_id: input.thread_id,
        confirm: true,
      }),
    });
  });
}

const originalConnect = McpServer.prototype.connect;
if (typeof originalConnect !== "function") {
  throw new Error("McpServer.connect is unavailable");
}

McpServer.prototype.connect = async function (...args) {
  if (!this.__paaBalePreloadRegistered) {
    registerAndroidStorageSearch(this);
    registerAndroidMessaging(this);
    registerBaleConversationTool(this, z, { materialUpload: globalThis.__cfMaterialUpload });
    Object.defineProperty(this, "__paaBalePreloadRegistered", {
      value: true,
      enumerable: false,
      configurable: false,
    });
  }
  return originalConnect.apply(this, args);
};
