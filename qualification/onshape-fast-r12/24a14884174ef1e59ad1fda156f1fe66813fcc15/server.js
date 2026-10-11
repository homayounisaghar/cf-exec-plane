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
  'const server = new McpServer({ name: "CF-server", version: BUILD_ID, icons: [{ src: "https://cf-onshape.duckdns.org/mcp/cf-server-icon.png", mimeType: "image/png", sizes: ["64x64"] }] });';
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