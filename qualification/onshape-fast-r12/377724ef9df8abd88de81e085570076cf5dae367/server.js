import fs from "node:fs";
import express from "express";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { OnshapeCore } from "./core.js";
import { OnshapeAgent } from "./onshape-agent.js";
import { registerTelegramConversationTool, registerTelegramSemanticTools } from "./telegram-ingress.mjs";

const RELEASE_CLOSURE_FILE = process.env.ONSHAPE_RELEASE_CLOSURE_FILE || "/release/release-closure.json";
const BUILD_ID = (() => {
  try {
    const value = JSON.parse(fs.readFileSync(RELEASE_CLOSURE_FILE, "utf8")).build_id;
    if (typeof value === "string" && value.trim().length >= 3) return value.trim();
  } catch {}
  return "onshape-vps-fast-unknown";
})();
const HOST = process.env.HOST || "127.0.0.1";
const PORT = Number(process.env.PORT || 8788);
const TOKEN_FILE = process.env.MCP_TOKEN_FILE || "/run/secrets/mcp-token";
const PROFILE_DIR = process.env.ONSHAPE_PROFILE_DIR || "/var/lib/capability-fabric/onshape/browser-profile";
const ACCOUNT_FILE = process.env.ONSHAPE_ACCOUNT_FILE || "/run/onshape-secrets/account";
const PASSWORD_FILE = process.env.ONSHAPE_PASSWORD_FILE || "/run/onshape-secrets/password";
const ANTI_FORGERY_HEADER_NAME = process.env.ONSHAPE_ANTI_FORGERY_HEADER_NAME || "";
const UI_API_VERSION = process.env.ONSHAPE_UI_API_VERSION || "";
const OPENAPI_FILE = process.env.ONSHAPE_OPENAPI_FILE || "/openapi/onshape-openapi.json";
const AGENT_STATE_DIR = process.env.ONSHAPE_AGENT_STATE_DIR || "/agent-state";
const API_MINIMUM_INTERVAL_MS = Number(process.env.ONSHAPE_API_MIN_INTERVAL_MS || 1000);
const PCG_WEB_SOCKET = process.env.PCG_WEB_SOCKET || "/run/pcg/web.sock";

if (HOST !== "127.0.0.1" || PORT !== 8788) throw new Error("Refusing unexpected Onshape backend endpoint.");
if (!OPENAPI_FILE.startsWith("/openapi/")) throw new Error("Invalid local OpenAPI path.");
if (!AGENT_STATE_DIR.startsWith("/")) throw new Error("Invalid Onshape agent-state path.");
if (ANTI_FORGERY_HEADER_NAME !== "x-xsrf-token") throw new Error("Invalid anti-forgery header name.");
if (PCG_WEB_SOCKET !== "/run/pcg/web.sock") throw new Error("Invalid PCG Web socket path.");
if (!/^v[0-9]+$/.test(UI_API_VERSION)) throw new Error("Invalid captured UI API version.");
if (!Number.isInteger(API_MINIMUM_INTERVAL_MS) || API_MINIMUM_INTERVAL_MS < 0 || API_MINIMUM_INTERVAL_MS > 60_000) {
  throw new Error("Onshape API minimum interval must be an integer from 0 to 60000 ms.");
}

const secretDir = "/run/onshape-secrets";
fs.mkdirSync(secretDir, { recursive: true, mode: 0o700 });
fs.chmodSync(secretDir, 0o700);
for (const file of [ACCOUNT_FILE, PASSWORD_FILE]) {
  if (!fs.existsSync(file)) fs.writeFileSync(file, "", { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

const MCP_TOKEN = fs.readFileSync(TOKEN_FILE, "utf8").trim();
if (!/^[A-Za-z0-9_-]{32,}$/.test(MCP_TOKEN)) throw new Error("MCP token file is missing or invalid.");

const core = new OnshapeCore({
  profileDir: PROFILE_DIR,
  accountFile: ACCOUNT_FILE,
  passwordFile: PASSWORD_FILE,
  buildId: BUILD_ID,
  antiForgeryHeaderName: ANTI_FORGERY_HEADER_NAME,
  uiApiVersion: UI_API_VERSION,
  openApiFile: OPENAPI_FILE,
  minimumApiIntervalMs: API_MINIMUM_INTERVAL_MS,
});
await core.initialize();

const agent = new OnshapeAgent({
  core,
  openApiFile: OPENAPI_FILE,
  stateDir: AGENT_STATE_DIR,
  buildId: BUILD_ID,
});
const registry = agent.operationRegistry();
const semanticSurface = agent.semanticCapabilitySurface();

function textResult(value) {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

function imageResult(value) {
  const { data_base64, mime_type, ...metadata } = value || {};
  return {
    content: [
      { type: "text", text: JSON.stringify({ build_id: BUILD_ID, ...metadata }) },
      { type: "image", data: String(data_base64 || ""), mimeType: String(mime_type || "image/jpeg") },
    ],
  };
}

function toolError(error, layer) {
  return {
    layer,
    code: error?.code || "INTERNAL_ERROR",
    message: String(error?.message || error?.name || "Internal error").slice(0, 300),
  };
}

async function safeTool(layer, fn) {
  try {
    const value = await fn();
    return textResult({
      build_id: BUILD_ID,
      ...(value && typeof value === "object" && !Array.isArray(value) ? value : { result: value }),
    });
  } catch (error) {
    return textResult({
      build_id: BUILD_ID,
      status: "FAILED",
      error: toolError(error, layer),
    });
  }
}

function makeServer() {
  const server = new McpServer({ name: "Onshape", version: BUILD_ID });

  server.registerTool("onshape_operation_execute", {
    title: "Execute Onshape Semantic Operation",
    description: semanticSurface.prompt,
    inputSchema: {
      operation: z.string().trim().min(1).max(240),
      target: z.record(z.unknown()).optional(),
      arguments: z.record(z.unknown()).optional(),
      path_params: z.record(z.unknown()).optional(),
      query: z.record(z.unknown()).optional(),
      body: z.unknown().optional(),
      headers: z.record(z.unknown()).optional(),
      multipart: z.record(z.unknown()).optional(),
      owner_confirmed_high_impact: z.boolean().optional(),
      request_id: z.string().trim().regex(/^[A-Za-z0-9:._-]{1,160}$/).optional(),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  }, async ({
    operation,
    target,
    arguments: intentArguments,
    path_params,
    query,
    body,
    headers,
    multipart,
    owner_confirmed_high_impact,
    request_id,
  }) => safeTool("onshape", async () => {
    const connectorStart = process.hrtime.bigint();
    const rawPath = path_params || {};
    const derivedTarget = {
      document_id: rawPath.document_id ?? rawPath.documentId ?? rawPath.did,
      workspace_id: rawPath.workspace_id ?? rawPath.workspaceId ?? rawPath.wid ?? rawPath.wvmid,
      element_id: rawPath.element_id ?? rawPath.elementId ?? rawPath.eid,
      part_id: rawPath.part_id ?? rawPath.partId ?? rawPath.pid,
      part_name: rawPath.part_name ?? rawPath.partName,
      entity_id: rawPath.entity_id ?? rawPath.entityId,
      entity_name: rawPath.entity_name ?? rawPath.entityName,
      feature_id: rawPath.feature_id ?? rawPath.featureId ?? rawPath.fid,
      version_id: rawPath.version_id ?? rawPath.versionId ?? rawPath.vid,
      microversion_id: rawPath.microversion_id ?? rawPath.microversionId ?? rawPath.mid,
    };
    const semanticOnlyPathKeys = new Set([
      "document_id", "documentId", "workspace_id", "workspaceId",
      "element_id", "elementId", "part_id", "partId", "part_name", "partName",
      "entity_id", "entityId", "entity_name", "entityName",
      "feature_id", "featureId", "version_id", "versionId",
      "microversion_id", "microversionId",
    ]);
    const documentedPathParams = Object.fromEntries(
      Object.entries(rawPath).filter(([key]) => !semanticOnlyPathKeys.has(key)),
    );
    const args = {
      intent: operation,
      target: {
        ...Object.fromEntries(Object.entries(derivedTarget).filter(([, value]) => value != null)),
        ...(target || {}),
      },
      arguments: intentArguments || {},
      pathParams: documentedPathParams,
      query: query || {},
      headers: headers || {},
    };
    if (body !== undefined) args.body = body;
    if (multipart !== undefined) args.multipart = multipart;
    if (owner_confirmed_high_impact !== undefined) args.ownerConfirmedHighImpact = owner_confirmed_high_impact;
    if (request_id !== undefined) args.requestId = request_id;

    const result = await agent.executeIntent(args);
    const connectorTotalMs = Number(process.hrtime.bigint() - connectorStart) / 1e6;
    return {
      execution_path: "mcp->semantic-contract->onshape-agent->browser-session->onshape",
      semantic_catalog: {
        count: semanticSurface.count,
        public_count: semanticSurface.public_count,
        resolution: semanticSurface.resolution,
      },
      timing: {
        connector_total_ms: connectorTotalMs,
        connector_overhead_ms: Math.max(0, connectorTotalMs - Number(result?.timing?.total_ms || 0)),
        agent: result?.timing || null,
      },
      result,
    };
  }));

  server.registerTool("onshape_status", {
    title: "Onshape Runtime Status",
    description: "Return current browser-session and local scheduler status.",
    inputSchema: {},
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async () => safeTool("onshape", async () => ({ status: await core.status() })));

  server.registerTool("onshape_reauth", {
    title: "Re-authenticate Onshape Session",
    description: "Start bounded re-authentication of the single Onshape browser session.",
    inputSchema: {},
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async () => safeTool("onshape", async () => core.startReauth()));

  server.registerTool("onshape_verification_submit", {
    title: "Submit Onshape Verification Code",
    description: "Submit a verification code only when the current re-auth operation is waiting for one.",
    inputSchema: { code: z.string().trim().regex(/^[0-9A-Za-z-]{4,16}$/) },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async ({ code }) => safeTool("onshape", async () => core.submitVerification(code)));

  server.registerTool("onshape_operation_status", {
    title: "Get Onshape Re-auth Status",
    description: "Return status/result for a previously started re-auth operation.",
    inputSchema: { operation_id: z.string().trim().min(1).max(128) },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ operation_id }) => safeTool("onshape", async () => core.operationStatus(operation_id)));

  server.registerTool("onshape_artifact", {
    title: "Onshape Temporary Artifact",
    description: "Stage/read temporary byte-exact artifacts used by documented multipart operations.",
    inputSchema: {
      action: z.enum(["write", "read", "status", "delete"]),
      artifact_id: z.string().regex(/^[0-9a-f]{32}$/).optional(),
      offset: z.number().int().nonnegative().optional(),
      length: z.number().int().min(1).max(393216).optional(),
      data_base64: z.string().min(1).max(530000).optional(),
      filename: z.string().trim().min(1).max(255).optional(),
      content_type: z.string().trim().min(1).max(200).optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async (args) => safeTool("onshape", async () => core.artifact(args.action, args)));

  server.registerTool("onshape_screenshot", {
    title: "Capture Onshape Screenshot",
    description: "Capture the current authenticated Onshape browser viewport and return the image directly. Optionally provide exact document/workspace/element ids to navigate before capture. Defaults to compact JPEG for low latency.",
    inputSchema: {
      document_id: z.string().trim().regex(/^[0-9a-fA-F]{24}$/).optional(),
      workspace_id: z.string().trim().regex(/^[0-9a-fA-F]{24}$/).optional(),
      element_id: z.string().trim().regex(/^[0-9a-fA-F]{24}$/).optional(),
      format: z.enum(["jpeg", "png"]).optional(),
      quality: z.number().int().min(40).max(95).optional(),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ document_id, workspace_id, element_id, format, quality }) => {
    try {
      const shot = await core.captureScreenshot({
        documentId: document_id ?? null,
        workspaceId: workspace_id ?? null,
        elementId: element_id ?? null,
        format: format || "jpeg",
        quality: quality ?? 80,
      });
      return imageResult(shot);
    } catch (error) {
      return textResult({
        build_id: BUILD_ID,
        status: "FAILED",
        error: toolError(error, "onshape"),
      });
    }
  });

  server.registerTool("onshape_catalog_refresh", {
    title: "Refresh Onshape Operation Catalog",
    description: "Maintenance-only: refresh the cached official OpenAPI document. Restart the Onshape service afterward to compile the new registry.",
    inputSchema: {},
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async () => safeTool("onshape", async () => ({
    refreshed: await core.refreshOpenApi(),
    restart_required: true,
  })));

  server.registerTool("onshape_capability_list", {
    title: "List Onshape Capabilities",
    description: "Return the full precompiled Onshape capability catalogue this connector can execute, including curated human intents and every admitted documented operation id. Call this when you need to know whether a command is supported or which intent string to pass to onshape_operation_execute.",
    inputSchema: { search: z.string().trim().max(120).optional() },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ search }) => safeTool("onshape", async () => {
    const surface = agent.semanticCapabilitySurface();
    const needle = String(search || "").trim().toLowerCase();
    const capabilities = needle
      ? surface.capabilities.filter((item) => JSON.stringify(item).toLowerCase().includes(needle))
      : surface.capabilities;
    return {
      total_contracts: surface.count,
      curated_capabilities: capabilities,
      documented_operation_ids_accepted: true,
      note: "Any admitted documented operationId or its precompiled summary is also a valid operation string.",
    };
  }));

  server.registerTool("onshape_resolve", {
    title: "Resolve Onshape Identities",
    description: "Turn a document URL and ordinary human names into exact Onshape ids. Accepts document_url or ids plus optional element_name (tab), part_name and feature_name, and returns the matching ids together with the available tabs, parts and features. Name matching tolerates case, spacing and Persian/Arabic letter variants; it reports the candidates when a name is genuinely ambiguous. Use this before operations that need an element, part or feature id.",
    inputSchema: {
      document_url: z.string().trim().max(500).optional(),
      document_id: z.string().trim().max(40).optional(),
      workspace_id: z.string().trim().max(40).optional(),
      element_id: z.string().trim().max(40).optional(),
      element_name: z.string().trim().max(300).optional(),
      part_name: z.string().trim().max(300).optional(),
      feature_name: z.string().trim().max(300).optional(),
      include_elements: z.boolean().optional(),
      include_parts: z.boolean().optional(),
      include_features: z.boolean().optional(),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (args) => safeTool("onshape", async () => agent.resolveIdentities(args)));

  registerTelegramConversationTool(server, z, { socketPath: PCG_WEB_SOCKET });
  registerTelegramSemanticTools(server, z, { socketPath: PCG_WEB_SOCKET });

  return server;
}

const app = express();
app.use((_req, res, next) => {
  res.setHeader("X-CF-Build-Id", BUILD_ID);
  next();
});
app.use(express.json({ limit: "5mb" }));
app.get("/", (_req, res) => res.type("text/plain").send("cf-onshape-single ok"));
app.post(`/mcp/${MCP_TOKEN}`, async (req, res) => {
  try {
    const server = makeServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error(error?.code || error?.name || "request-error");
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal error", data: { build_id: BUILD_ID } },
        id: null,
      });
    }
  }
});
app.get(`/mcp/${MCP_TOKEN}`, (_req, res) => res.status(405).json({ error: "Use POST" }));
app.use((_req, res) => res.sendStatus(404));

const httpServer = app.listen(PORT, HOST, () => {
  console.log(`cf-onshape listening on ${HOST}:${PORT}`);
});

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`cf-onshape shutdown ${signal}`);
  httpServer.close();
  if (typeof httpServer.closeAllConnections === "function") httpServer.closeAllConnections();
  try {
    await core.close();
  } catch (error) {
    console.error(error?.code || error?.name || "shutdown-error");
  }
  process.exit(0);
}
process.once("SIGTERM", () => { void shutdown("SIGTERM"); });
process.once("SIGINT", () => { void shutdown("SIGINT"); });
