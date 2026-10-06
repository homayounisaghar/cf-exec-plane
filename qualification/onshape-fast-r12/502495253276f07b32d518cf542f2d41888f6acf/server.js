import fs from "node:fs";
import crypto from "node:crypto";

const BASE_URL = "https://raw.githubusercontent.com/homayounisaghar/cf-exec-plane/main/qualification/onshape-fast-r12/482e02726adf3a6a69687a4b165515c0596854ae/server.js";
const BASE_SHA256 = "17ab8922d909080758ce1b06a48a8b7b2d8c09fdf15f88fcdc6c532b8952d62f";
const REQUIRED_BASE_MARKERS = [
  'agent.executeIntent(args)',
  'execution_path: "mcp->semantic-contract->onshape-agent->browser-session->onshape"',
  'server.registerTool("onshape_operation_execute"',
  'voice_conversion: await voiceRuntimeStatus()',
  'RVC_WORKER_STATUS_URL',
];

const response = await fetch(BASE_URL, { signal: AbortSignal.timeout(15000) });
if (!response.ok) throw new Error("BASE_SERVER_FETCH_FAILED_" + response.status);
let source = await response.text();
const digest = crypto.createHash("sha256").update(source).digest("hex");
if (digest !== BASE_SHA256) throw new Error("BASE_SERVER_DIGEST_MISMATCH");
for (const marker of REQUIRED_BASE_MARKERS) {
  if (!source.includes(marker)) throw new Error("BASE_SERVER_MARKER_MISSING");
}
const implementationNeedle = 'const server = new McpServer({ name: "Onshape", version: BUILD_ID });';
const implementationReplacement =
  'const server = new McpServer({ name: "Onshape", version: BUILD_ID, icons: [{ src: ' +
  JSON.stringify("data:image/png;base64,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") +
  ', mimeType: "image/png", sizes: ["64x64"] }] });';
if (!source.includes(implementationNeedle)) throw new Error("BASE_SERVER_IMPLEMENTATION_MARKER_MISSING");
source = source.replace(implementationNeedle, implementationReplacement);
const materialBridgeNeedle = 'const app = express();';
const materialBridge = `
const WHATSAPP_MATERIAL_DOWNLOAD_ROOT = "/run/pcg-material-files";
const WHATSAPP_MATERIAL_DOWNLOAD_TTL_MS = 55 * 60 * 1000;
const whatsappMaterialDownloads = new Map();

function stageWhatsAppMaterialDownload(ready) {
  const handle = String(ready?.material_file_handle || "").trim();
  const match = /^pcgfile:([0-9a-f]{64})$/.exec(handle);
  if (!match) throw Object.assign(new Error("WHATSAPP_MATERIAL_HANDLE_INVALID"), { code: "WHATSAPP_MATERIAL_HANDLE_INVALID" });
  const filename = String(ready?.filename || "").trim();
  if (!filename || filename.length > 128 || /[\\\\/\\u0000]/u.test(filename)) {
    throw Object.assign(new Error("WHATSAPP_MATERIAL_FILENAME_INVALID"), { code: "WHATSAPP_MATERIAL_FILENAME_INVALID" });
  }
  const filePath = WHATSAPP_MATERIAL_DOWNLOAD_ROOT + "/" + match[1] + "-" + filename;
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== Number(ready?.size_bytes)) {
    throw Object.assign(new Error("WHATSAPP_MATERIAL_FILE_INVALID"), { code: "WHATSAPP_MATERIAL_FILE_INVALID" });
  }
  const id = crypto.randomBytes(32).toString("hex");
  const item = {
    path: filePath,
    filename,
    mime_type: String(ready?.media_type || "application/octet-stream"),
    size_bytes: stat.size,
    sha256_hex: String(ready?.sha256_hex || ""),
    upload_id: String(ready?.upload_id || ""),
    expires_at_ms: Date.now() + WHATSAPP_MATERIAL_DOWNLOAD_TTL_MS,
  };
  whatsappMaterialDownloads.set(id, item);
  const timer = setTimeout(async () => {
    whatsappMaterialDownloads.delete(id);
    if (/^[0-9a-f]{64}$/.test(item.upload_id)) {
      try { await telegramMaterialUpload.delete(item.upload_id); } catch {}
    }
  }, WHATSAPP_MATERIAL_DOWNLOAD_TTL_MS);
  timer.unref?.();
  return {
    download_id: id,
    download_path: "/mcp/whatsapp-file/" + id,
    filename: item.filename,
    mime_type: item.mime_type,
    size_bytes: item.size_bytes,
    sha256_hex: item.sha256_hex || null,
    expires_after_seconds: Math.floor(WHATSAPP_MATERIAL_DOWNLOAD_TTL_MS / 1000),
  };
}

function getWhatsAppMaterialDownload(id) {
  const key = String(id || "").trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(key)) return null;
  const item = whatsappMaterialDownloads.get(key) || null;
  if (!item) return null;
  if (item.expires_at_ms <= Date.now()) {
    whatsappMaterialDownloads.delete(key);
    return null;
  }
  return item;
}

const ALIBABA_MATERIAL_DOWNLOAD_ROOT = "/run/pcg-material-files";
const ALIBABA_MATERIAL_DOWNLOAD_TTL_MS = 55 * 60 * 1000;
const alibabaMaterialDownloads = new Map();

function stageAlibabaMaterialDownload(ready) {
  const handle = String(ready?.material_file_handle || "").trim();
  const match = /^pcgfile:([0-9a-f]{64})$/.exec(handle);
  if (!match) throw Object.assign(new Error("ALIBABA_MATERIAL_HANDLE_INVALID"), { code: "ALIBABA_MATERIAL_HANDLE_INVALID" });
  const filename = String(ready?.filename || "").trim();
  if (!filename || filename.length > 128 || /[\\/\u0000]/u.test(filename)) {
    throw Object.assign(new Error("ALIBABA_MATERIAL_FILENAME_INVALID"), { code: "ALIBABA_MATERIAL_FILENAME_INVALID" });
  }
  const filePath = ALIBABA_MATERIAL_DOWNLOAD_ROOT + "/" + match[1] + "-" + filename;
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== Number(ready?.size_bytes)) {
    throw Object.assign(new Error("ALIBABA_MATERIAL_FILE_INVALID"), { code: "ALIBABA_MATERIAL_FILE_INVALID" });
  }
  const id = crypto.randomBytes(32).toString("hex");
  const item = {
    path: filePath,
    filename,
    mime_type: String(ready?.media_type || "application/octet-stream"),
    size_bytes: stat.size,
    sha256_hex: String(ready?.sha256_hex || ""),
    upload_id: String(ready?.upload_id || ""),
    expires_at_ms: Date.now() + ALIBABA_MATERIAL_DOWNLOAD_TTL_MS,
  };
  alibabaMaterialDownloads.set(id, item);
  const timer = setTimeout(async () => {
    alibabaMaterialDownloads.delete(id);
    if (/^[0-9a-f]{64}$/.test(item.upload_id)) {
      try { await telegramMaterialUpload.delete(item.upload_id); } catch {}
    }
  }, ALIBABA_MATERIAL_DOWNLOAD_TTL_MS);
  timer.unref?.();
  return {
    download_id: id,
    download_path: "/mcp/alibaba-file/" + id,
    filename: item.filename,
    mime_type: item.mime_type,
    size_bytes: item.size_bytes,
    sha256_hex: item.sha256_hex || null,
    expires_after_seconds: Math.floor(ALIBABA_MATERIAL_DOWNLOAD_TTL_MS / 1000),
  };
}

function getAlibabaMaterialDownload(id) {
  const key = String(id || "").trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(key)) return null;
  const item = alibabaMaterialDownloads.get(key) || null;
  if (!item) return null;
  if (item.expires_at_ms <= Date.now()) {
    alibabaMaterialDownloads.delete(key);
    return null;
  }
  return item;
}

globalThis.__cfMaterialUpload = telegramMaterialUpload;
globalThis.__cfStageWhatsAppMaterialDownload = stageWhatsAppMaterialDownload;
globalThis.__cfStageAlibabaMaterialDownload = stageAlibabaMaterialDownload;

const app = express();`;
if (!source.includes(materialBridgeNeedle)) throw new Error("BASE_SERVER_APP_MARKER_MISSING");
source = source.replace(materialBridgeNeedle, materialBridge);

const whatsappRouteNeedle = 'app.put("/mcp/upload/:upload_id", handleTelegramMaterialUploadPut);';
const whatsappRoute = `
app.get("/mcp/alibaba-file/:download_id", (req, res) => {
  const item = getAlibabaMaterialDownload(req.params.download_id);
  if (!item) {
    res.status(404).json({ error: "Alibaba file download not found or expired." });
    return;
  }
  const disposition = /^(image|audio|video)\\//i.test(item.mime_type) ? "inline" : "attachment";
  res.setHeader("content-type", item.mime_type);
  res.setHeader("content-disposition", disposition + '; filename="' + item.filename.replace(/"/g, "_") + '"');
  res.setHeader("content-length", String(item.size_bytes));
  res.setHeader("cache-control", "private, no-store, max-age=0");
  res.setHeader("x-content-type-options", "nosniff");
  const stream = fs.createReadStream(item.path);
  stream.once("error", () => {
    if (!res.headersSent) res.status(410).json({ error: "Alibaba staged file became unavailable." });
    else res.destroy();
  });
  stream.pipe(res);
});
app.get("/mcp/whatsapp-file/:download_id", (req, res) => {
  const item = getWhatsAppMaterialDownload(req.params.download_id);
  if (!item) {
    res.status(404).json({ error: "WhatsApp file download not found or expired." });
    return;
  }
  const disposition = /^(image|audio|video)\\//i.test(item.mime_type) ? "inline" : "attachment";
  res.setHeader("content-type", item.mime_type);
  res.setHeader("content-disposition", disposition + '; filename="' + item.filename.replace(/"/g, "_") + '"');
  res.setHeader("content-length", String(item.size_bytes));
  res.setHeader("cache-control", "private, no-store, max-age=0");
  res.setHeader("x-content-type-options", "nosniff");
  const stream = fs.createReadStream(item.path);
  stream.once("error", () => {
    if (!res.headersSent) res.status(410).json({ error: "WhatsApp staged file became unavailable." });
    else res.destroy();
  });
  stream.pipe(res);
});
app.put("/mcp/upload/:upload_id", handleTelegramMaterialUploadPut);`;
if (!source.includes(whatsappRouteNeedle)) throw new Error("BASE_SERVER_UPLOAD_ROUTE_MARKER_MISSING");
source = source.replace(whatsappRouteNeedle, whatsappRoute);

const ownerAuthImportNeedle = 'import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";';
if (!source.includes(ownerAuthImportNeedle)) throw new Error("OWNER_AUTH_IMPORT_MARKER_MISSING");
source = source.replace(ownerAuthImportNeedle, ownerAuthImportNeedle + '\nimport { createOwnerAuthGate, registerOwnerAuthTools } from "./owner-auth.mjs";');
const ownerAuthTokenNeedle = 'const MCP_TOKEN = fs.readFileSync(TOKEN_FILE, "utf8").trim();\nif (!/^[A-Za-z0-9_-]{32,}$/.test(MCP_TOKEN)) throw new Error("MCP token file is missing or invalid.");';
if (!source.includes(ownerAuthTokenNeedle)) throw new Error("OWNER_AUTH_TOKEN_MARKER_MISSING");
source = source.replace(ownerAuthTokenNeedle, ownerAuthTokenNeedle + '\nconst ownerAuth = createOwnerAuthGate({ stateDir: AGENT_STATE_DIR + "/owner-auth", buildId: BUILD_ID });');
if (!source.includes(implementationReplacement)) throw new Error("OWNER_AUTH_SERVER_MARKER_MISSING");
source = source.replace(implementationReplacement, implementationReplacement + '\n  registerOwnerAuthTools(server, z, ownerAuth, safeTool);');
const ownerAuthJsonNeedle = 'app.use(express.json({ limit: "5mb" }));';
if (!source.includes(ownerAuthJsonNeedle)) throw new Error("OWNER_AUTH_MIDDLEWARE_MARKER_MISSING");
source = source.replace(ownerAuthJsonNeedle, ownerAuthJsonNeedle + '\napp.use((req, res, next) => {\n  const decision = ownerAuth.authorizeToolCall(req.body);\n  if (decision.allowed) { next(); return; }\n  res.status(200).json(ownerAuth.deniedRpc(req.body?.id, decision));\n});');

const target = "/tmp/app/server.base.mjs";
fs.writeFileSync(target, source, { mode: 0o600 });
await import("./server.base.mjs");