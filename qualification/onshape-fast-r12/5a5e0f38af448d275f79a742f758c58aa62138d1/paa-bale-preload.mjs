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

const originalConnect = McpServer.prototype.connect;
if (typeof originalConnect !== "function") {
  throw new Error("McpServer.connect is unavailable");
}

McpServer.prototype.connect = async function (...args) {
  if (!this.__paaBalePreloadRegistered) {
    registerAndroidStorageSearch(this);
    registerBaleConversationTool(this, z);
    Object.defineProperty(this, "__paaBalePreloadRegistered", {
      value: true,
      enumerable: false,
      configurable: false,
    });
  }
  return originalConnect.apply(this, args);
};
