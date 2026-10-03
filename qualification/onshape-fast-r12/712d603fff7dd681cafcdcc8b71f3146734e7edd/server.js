import fs from "node:fs";
import net from "node:net";
import crypto from "node:crypto";
import express from "express";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { OnshapeCore } from "./core.js";
import { OnshapeAgent } from "./onshape-agent.js";
import { registerTelegramConversationTool, registerTelegramSemanticTools, invokeTelegramSemanticOperation } from "./telegram-ingress.mjs";

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
const SCREENSHOT_DOWNLOAD_TTL_MS = 2 * 60 * 60 * 1000;
const SCREENSHOT_DOWNLOAD_MAX_ENTRIES = 32;
const screenshotDownloads = new Map();

const TELEGRAM_DOWNLOAD_ROOT = "/run/pcg-downloads";
const TELEGRAM_FILE_TTL_MS = 55 * 60 * 1000;
const TELEGRAM_FILE_MAX_ENTRIES = 32;
const TELEGRAM_FILE_MAX_BYTES = 32 * 1024 * 1024;
const TELEGRAM_FILE_EMBED_MAX_BYTES = 8 * 1024 * 1024;
const TELEGRAM_ANDROID_STREAM_MAX_BYTES = 2 * 1024 * 1024 * 1024;
const telegramFileDownloads = new Map();
const PAA_CONTROL_URL = "http://127.0.0.1:8793";

const TELEGRAM_MATERIAL_UPLOAD_SOCKET = "/run/pcg/material-upload.sock";
const TELEGRAM_MATERIAL_UPLOAD_TTL_MS = 60 * 60 * 1000;
const TELEGRAM_MATERIAL_UPLOAD_MAX_BYTES = 2 * 1024 * 1024 * 1024;
const TELEGRAM_MATERIAL_UPLOAD_MAX_CHUNK_BYTES = 16 * 1024 * 1024;
const telegramMaterialUploads = new Map();

function cleanupScreenshotDownloads() {
  const nowMs = Date.now();
  for (const [id, item] of screenshotDownloads) {
    if (!item || item.expires_at_ms <= nowMs) screenshotDownloads.delete(id);
  }
  while (screenshotDownloads.size >= SCREENSHOT_DOWNLOAD_MAX_ENTRIES) {
    const oldest = screenshotDownloads.keys().next().value;
    if (!oldest) break;
    screenshotDownloads.delete(oldest);
  }
}

function stageScreenshotDownload(shot) {
  cleanupScreenshotDownloads();
  const mimeType = String(shot?.mime_type || "image/jpeg");
  const extension = mimeType === "image/png" ? "png" : "jpg";
  const bytes = Buffer.from(String(shot?.data_base64 || ""), "base64");
  const expectedBytes = Number(shot?.byte_length || 0);
  if (!bytes.length || (expectedBytes > 0 && bytes.length !== expectedBytes)) {
    const error = new Error("Screenshot bytes are missing or inconsistent.");
    error.code = "SCREENSHOT_DOWNLOAD_BYTES_INVALID";
    throw error;
  }
  const id = crypto.randomBytes(32).toString("hex");
  const createdAtMs = Date.now();
  const filename = `onshape-screenshot-${new Date(createdAtMs).toISOString().replace(/[:.]/g, "-")}.${extension}`;
  screenshotDownloads.set(id, {
    bytes,
    mime_type: mimeType,
    filename,
    created_at_ms: createdAtMs,
    expires_at_ms: createdAtMs + SCREENSHOT_DOWNLOAD_TTL_MS,
  });
  return {
    download_id: id,
    download_path: `/mcp/screenshot/${id}`,
    filename,
    expires_after_seconds: Math.floor(SCREENSHOT_DOWNLOAD_TTL_MS / 1000),
  };
}

function getScreenshotDownload(id) {
  cleanupScreenshotDownloads();
  const value = String(id || "").trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(value)) return null;
  return screenshotDownloads.get(value) || null;
}


function cleanupTelegramFileDownloads() {
  const nowMs = Date.now();
  for (const [id, item] of telegramFileDownloads) {
    if (!item || item.expires_at_ms <= nowMs) telegramFileDownloads.delete(id);
  }
  while (telegramFileDownloads.size >= TELEGRAM_FILE_MAX_ENTRIES) {
    const oldest = telegramFileDownloads.keys().next().value;
    if (!oldest) break;
    telegramFileDownloads.delete(oldest);
  }
}

function telegramFileExtension(mimeType) {
  const map = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "audio/ogg": "ogg",
    "audio/mpeg": "mp3",
    "audio/mp4": "m4a",
    "video/mp4": "mp4",
    "application/pdf": "pdf",
  };
  return map[String(mimeType || "").toLowerCase()] || "bin";
}

function safeTelegramFilename(value, mimeType, id) {
  const raw = typeof value === "string" ? value.trim() : "";
  const leaf = raw.split(/[\\/]/u).at(-1) || "";
  const clean = leaf
    .replace(/[\u0000-\u001f\u007f]/gu, "")
    .replace(/["<>:|?*]/gu, "_")
    .slice(0, 180);
  if (clean) return clean;
  return "telegram-" + id.slice(0, 12) + "." + telegramFileExtension(mimeType);
}

function stageTelegramFile({ file_handle, filename = null, media_type = null, size_bytes = null, sha256_hex = null, data_base64 = null } = {}) {
  cleanupTelegramFileDownloads();
  const handle = String(file_handle || "").trim().toLowerCase();
  if (!/^file:[0-9a-f]{64}$/.test(handle)) {
    const error = new Error("Telegram file handle is invalid.");
    error.code = "TELEGRAM_FILE_HANDLE_INVALID";
    throw error;
  }

  let bytes = null;
  let candidate = null;
  if (typeof data_base64 === "string" && data_base64) {
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(data_base64)) {
      const error = new Error("Telegram exported file payload is invalid.");
      error.code = "TELEGRAM_FILE_EXPORT_INVALID";
      throw error;
    }
    bytes = Buffer.from(data_base64, "base64");
  } else {
    const token = handle.slice(5);
    candidate = TELEGRAM_DOWNLOAD_ROOT + "/" + token;
    try {
      const stat = fs.lstatSync(candidate);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("invalid");
      bytes = fs.readFileSync(candidate);
    } catch {
      const error = new Error("Telegram broker file is unavailable or expired.");
      error.code = "TELEGRAM_FILE_UNAVAILABLE";
      throw error;
    }
  }

  if (!Buffer.isBuffer(bytes) || bytes.length < 1 || bytes.length > TELEGRAM_FILE_MAX_BYTES) {
    const error = new Error("Telegram broker file failed bounded-file validation.");
    error.code = "TELEGRAM_FILE_BOUNDS_INVALID";
    throw error;
  }
  if (Number.isSafeInteger(size_bytes) && size_bytes > 0 && bytes.length !== size_bytes) {
    const error = new Error("Telegram broker file size does not match the semantic download result.");
    error.code = "TELEGRAM_FILE_SIZE_MISMATCH";
    throw error;
  }

  const actualSha = crypto.createHash("sha256").update(bytes).digest("hex");
  if (typeof sha256_hex === "string" && /^[0-9a-f]{64}$/i.test(sha256_hex) && actualSha !== sha256_hex.toLowerCase()) {
    const error = new Error("Telegram broker file hash does not match the semantic download result.");
    error.code = "TELEGRAM_FILE_HASH_MISMATCH";
    throw error;
  }

  const id = crypto.randomBytes(32).toString("hex");
  const mimeType = typeof media_type === "string" && media_type.trim()
    ? media_type.trim().slice(0, 200)
    : "application/octet-stream";
  const safeName = safeTelegramFilename(filename, mimeType, id);
  const nowMs = Date.now();
  telegramFileDownloads.set(id, {
    bytes,
    path: candidate,
    mime_type: mimeType,
    filename: safeName,
    size_bytes: bytes.length,
    sha256_hex: actualSha,
    expires_at_ms: nowMs + TELEGRAM_FILE_TTL_MS,
  });
  return {
    download_id: id,
    download_path: "/mcp/telegram-file/" + id,
    filename: safeName,
    mime_type: mimeType,
    size_bytes: bytes.length,
    sha256_hex: actualSha,
    expires_after_seconds: Math.floor(TELEGRAM_FILE_TTL_MS / 1000),
    data_base64: bytes.length <= TELEGRAM_FILE_EMBED_MAX_BYTES ? bytes.toString("base64") : null,
  };
}

async function stageTelegramFileForAndroid({ file_handle, filename = null, media_type = null, size_bytes = null, sha256_hex = null } = {}) {
  cleanupTelegramFileDownloads();
  const handle = String(file_handle || "").trim().toLowerCase();
  if (!/^file:[0-9a-f]{64}$/.test(handle)) {
    const error = new Error("Telegram file handle is invalid.");
    error.code = "TELEGRAM_FILE_HANDLE_INVALID";
    throw error;
  }
  const candidate = TELEGRAM_DOWNLOAD_ROOT + "/" + handle.slice(5);
  let stat;
  try {
    stat = fs.lstatSync(candidate);
  } catch {
    const error = new Error("Telegram broker file is unavailable or expired.");
    error.code = "TELEGRAM_FILE_UNAVAILABLE";
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > TELEGRAM_ANDROID_STREAM_MAX_BYTES) {
    const error = new Error("Telegram broker file failed Android streaming bounds.");
    error.code = "TELEGRAM_FILE_BOUNDS_INVALID";
    throw error;
  }
  if (Number.isSafeInteger(size_bytes) && size_bytes > 0 && stat.size !== size_bytes) {
    const error = new Error("Telegram broker file size does not match semantic metadata.");
    error.code = "TELEGRAM_FILE_SIZE_MISMATCH";
    throw error;
  }
  const digest = crypto.createHash("sha256");
  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(candidate);
    stream.on("data", (chunk) => digest.update(chunk));
    stream.once("error", reject);
    stream.once("end", resolve);
  });
  const actualSha = digest.digest("hex");
  if (typeof sha256_hex === "string" && /^[0-9a-f]{64}$/i.test(sha256_hex)
      && actualSha !== sha256_hex.toLowerCase()) {
    const error = new Error("Telegram broker file hash does not match semantic metadata.");
    error.code = "TELEGRAM_FILE_HASH_MISMATCH";
    throw error;
  }
  const id = crypto.randomBytes(32).toString("hex");
  const mimeType = typeof media_type === "string" && media_type.trim()
    ? media_type.trim().slice(0, 200) : "application/octet-stream";
  const safeName = safeTelegramFilename(filename, mimeType, id);
  telegramFileDownloads.set(id, {
    bytes: null,
    path: candidate,
    mime_type: mimeType,
    filename: safeName,
    size_bytes: stat.size,
    sha256_hex: actualSha,
    expires_at_ms: Date.now() + TELEGRAM_FILE_TTL_MS,
    android_streaming: true,
  });
  return {
    download_id: id,
    download_path: "/mcp/telegram-file/" + id,
    filename: safeName,
    mime_type: mimeType,
    size_bytes: stat.size,
    sha256_hex: actualSha,
    expires_after_seconds: Math.floor(TELEGRAM_FILE_TTL_MS / 1000),
  };
}

function getTelegramFileDownload(id) {
  cleanupTelegramFileDownloads();
  const value = String(id || "").trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(value)) return null;
  const item = telegramFileDownloads.get(value);
  if (!item) return null;
  if (Buffer.isBuffer(item.bytes)) {
    if (item.bytes.length !== item.size_bytes || item.bytes.length > TELEGRAM_FILE_MAX_BYTES) {
      telegramFileDownloads.delete(value);
      return null;
    }
    return item;
  }
  try {
    const stat = fs.lstatSync(item.path);
    const maxBytes = item.android_streaming === true ? TELEGRAM_ANDROID_STREAM_MAX_BYTES : TELEGRAM_FILE_MAX_BYTES;
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== item.size_bytes || stat.size > maxBytes) {
      telegramFileDownloads.delete(value);
      return null;
    }
  } catch {
    telegramFileDownloads.delete(value);
    return null;
  }
  return item;
}


function safeMaterialUploadFilename(value) {
  const text = String(value || "").trim();
  if (!text || text.length > 128 || text === "." || text === ".." || /[\\/\u0000-\u001f\u007f]/u.test(text)) {
    const error = new Error("Material upload filename is invalid.");
    error.code = "MATERIAL_UPLOAD_FILENAME_INVALID";
    throw error;
  }
  return text;
}

function safeMaterialUploadMediaType(value) {
  const text = String(value || "application/octet-stream").trim().toLowerCase();
  if (text.length > 128 || !/^[a-z0-9][a-z0-9!#&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#&^_.+-]{0,63}$/.test(text)) {
    const error = new Error("Material upload media type is invalid.");
    error.code = "MATERIAL_UPLOAD_MEDIA_TYPE_INVALID";
    throw error;
  }
  return text;
}

function cleanupTelegramMaterialUploads() {
  const now = Date.now();
  for (const [id, item] of telegramMaterialUploads) {
    if (!item || item.expires_at_ms <= now) telegramMaterialUploads.delete(id);
  }
}

function getTelegramMaterialUpload(uploadId) {
  cleanupTelegramMaterialUploads();
  const id = String(uploadId || "").trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(id)) {
    const error = new Error("Upload id is invalid.");
    error.code = "MATERIAL_UPLOAD_ID_INVALID";
    throw error;
  }
  const ticket = telegramMaterialUploads.get(id);
  if (!ticket) {
    const error = new Error("Upload ticket is missing or expired.");
    error.code = "MATERIAL_UPLOAD_NOT_FOUND";
    throw error;
  }
  return ticket;
}

function callMaterialUploadSocket(payload, { timeoutMs = 15_000 } = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(TELEGRAM_MATERIAL_UPLOAD_SOCKET);
    let buffer = "";
    let settled = false;
    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      try { socket.destroy(); } catch {}
      err ? reject(err) : resolve(value);
    };
    socket.setEncoding("utf8");
    socket.setTimeout(timeoutMs, () => {
      const error = new Error("Material upload control timed out.");
      error.code = "MATERIAL_UPLOAD_TIMEOUT";
      finish(error);
    });
    socket.once("error", (err) => {
      const error = new Error("Material upload socket is unavailable.");
      error.code = err?.code === "ENOENT" || err?.code === "ECONNREFUSED" ? "MATERIAL_UPLOAD_RUNTIME_UNAVAILABLE" : "MATERIAL_UPLOAD_SOCKET_ERROR";
      finish(error);
    });
    socket.on("data", (chunk) => {
      buffer += chunk;
      if (buffer.length > 64 * 1024) {
        const error = new Error("Material upload response exceeded the control bound.");
        error.code = "MATERIAL_UPLOAD_RESPONSE_TOO_LARGE";
        finish(error);
        return;
      }
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      try {
        const parsed = JSON.parse(buffer.slice(0, newline));
        if (parsed?.ok !== true) {
          const error = new Error(String(parsed?.error || "MATERIAL_UPLOAD_FAILED"));
          error.code = String(parsed?.error || "MATERIAL_UPLOAD_FAILED");
          if (Number.isSafeInteger(parsed?.expected_offset)) error.expected_offset = parsed.expected_offset;
          finish(error);
          return;
        }
        finish(null, parsed);
      } catch {
        const error = new Error("Material upload response is invalid.");
        error.code = "MATERIAL_UPLOAD_RESPONSE_INVALID";
        finish(error);
      }
    });
    socket.once("connect", () => socket.end(JSON.stringify(payload) + "\n"));
  });
}

function createTelegramMaterialUpload({ filename, media_type, size_bytes, sha256_hex = null } = {}) {
  cleanupTelegramMaterialUploads();
  const safeName = safeMaterialUploadFilename(filename);
  const mediaType = safeMaterialUploadMediaType(media_type);
  const sizeBytes = Number(size_bytes);
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 1 || sizeBytes > TELEGRAM_MATERIAL_UPLOAD_MAX_BYTES) {
    const error = new Error("Material upload size is outside the 2 GiB local transport bound.");
    error.code = "MATERIAL_UPLOAD_SIZE_INVALID";
    throw error;
  }
  const expectedSha = sha256_hex == null || sha256_hex === "" ? null : String(sha256_hex).trim().toLowerCase();
  if (expectedSha && !/^[0-9a-f]{64}$/.test(expectedSha)) {
    const error = new Error("Material upload SHA-256 is invalid.");
    error.code = "MATERIAL_UPLOAD_DIGEST_INVALID";
    throw error;
  }
  const uploadId = crypto.randomBytes(32).toString("hex");
  const materialToken = crypto.randomBytes(32).toString("hex");
  const nowMs = Date.now();
  const ticket = {
    upload_id: uploadId,
    material_file_handle: "pcgfile:" + materialToken,
    filename: safeName,
    media_type: mediaType,
    size_bytes: sizeBytes,
    expected_sha256: expectedSha,
    sha256_hex: null,
    created_at_ms: nowMs,
    expires_at_ms: nowMs + TELEGRAM_MATERIAL_UPLOAD_TTL_MS,
    send_started: false,
  };
  telegramMaterialUploads.set(uploadId, ticket);
  return {
    upload_id: uploadId,
    upload_url: "https://cf-onshape.duckdns.org/mcp/upload/" + uploadId,
    filename: safeName,
    media_type: mediaType,
    size_bytes: sizeBytes,
    expected_sha256: expectedSha,
    offset: 0,
    complete: false,
    expires_after_seconds: Math.floor(TELEGRAM_MATERIAL_UPLOAD_TTL_MS / 1000),
    max_chunk_bytes: TELEGRAM_MATERIAL_UPLOAD_MAX_CHUNK_BYTES,
  };
}

async function statusTelegramMaterialUpload(uploadId) {
  const ticket = getTelegramMaterialUpload(uploadId);
  const status = await callMaterialUploadSocket({ op: "status", file_handle: ticket.material_file_handle });
  if (status.complete === true && typeof status.sha256_hex === "string") ticket.sha256_hex = status.sha256_hex;
  return {
    upload_id: ticket.upload_id,
    upload_url: "https://cf-onshape.duckdns.org/mcp/upload/" + ticket.upload_id,
    filename: ticket.filename,
    media_type: ticket.media_type,
    size_bytes: ticket.size_bytes,
    expected_sha256: ticket.expected_sha256,
    sha256_hex: status.sha256_hex || null,
    offset: status.offset,
    complete: status.complete === true,
    send_started: ticket.send_started === true,
    expires_after_seconds: Math.max(0, Math.floor((ticket.expires_at_ms - Date.now()) / 1000)),
  };
}

async function deleteTelegramMaterialUpload(uploadId) {
  const ticket = getTelegramMaterialUpload(uploadId);
  let runtimeDeleted = false;
  try {
    const result = await callMaterialUploadSocket({ op: "delete", file_handle: ticket.material_file_handle });
    runtimeDeleted = result?.state === "DELETED";
  } finally {
    telegramMaterialUploads.delete(ticket.upload_id);
  }
  return { upload_id: ticket.upload_id, deleted: true, runtime_deleted: runtimeDeleted };
}

function appendTelegramMaterialUploadChunk(uploadId, offset, { data_base64 = null, zero_bytes = null } = {}) {
  const ticket = getTelegramMaterialUpload(uploadId);
  if (ticket.send_started) {
    const error = new Error("This upload ticket has already entered provider dispatch.");
    error.code = "MATERIAL_UPLOAD_SEND_ALREADY_STARTED";
    throw error;
  }
  const start = Number(offset);
  if (!Number.isSafeInteger(start) || start < 0 || start > ticket.size_bytes) {
    const error = new Error("Material upload offset is invalid.");
    error.code = "MATERIAL_UPLOAD_OFFSET_INVALID";
    throw error;
  }

  const hasBase64 = typeof data_base64 === "string" && data_base64.length > 0;
  const hasZero = Number.isSafeInteger(zero_bytes) && zero_bytes > 0;
  if (hasBase64 === hasZero) {
    const error = new Error("Pass exactly one of data_base64 or zero_bytes.");
    error.code = "MATERIAL_UPLOAD_CHUNK_SOURCE_INVALID";
    throw error;
  }

  let bytes;
  if (hasBase64) {
    if (data_base64.length > 2_900_000 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data_base64)) {
      const error = new Error("Base64 chunk is invalid or exceeds the bounded MCP chunk size.");
      error.code = "MATERIAL_UPLOAD_CHUNK_BASE64_INVALID";
      throw error;
    }
    bytes = Buffer.from(data_base64, "base64");
    if (bytes.length < 1 || bytes.length > 2 * 1024 * 1024) {
      const error = new Error("Decoded MCP chunk must be between 1 byte and 2 MiB.");
      error.code = "MATERIAL_UPLOAD_CHUNK_SIZE_INVALID";
      throw error;
    }
  } else {
    if (zero_bytes > TELEGRAM_MATERIAL_UPLOAD_MAX_CHUNK_BYTES) {
      const error = new Error("Zero-fill qualification chunk exceeds the raw upload chunk bound.");
      error.code = "MATERIAL_UPLOAD_CHUNK_SIZE_INVALID";
      throw error;
    }
    bytes = Buffer.alloc(zero_bytes);
  }

  if (start + bytes.length > ticket.size_bytes) {
    const error = new Error("Material upload chunk exceeds declared file size.");
    error.code = "MATERIAL_UPLOAD_SIZE_OVERRUN";
    throw error;
  }

  return new Promise((resolve, reject) => {
    const socket = net.createConnection(TELEGRAM_MATERIAL_UPLOAD_SOCKET);
    let responseBuffer = "";
    let settled = false;
    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      try { socket.destroy(); } catch {}
      err ? reject(err) : resolve(value);
    };
    socket.setEncoding("utf8");
    socket.setTimeout(120_000, () => {
      const error = new Error("Material upload chunk timed out.");
      error.code = "MATERIAL_UPLOAD_TIMEOUT";
      finish(error);
    });
    socket.once("error", (err) => {
      const error = new Error("Material upload socket is unavailable.");
      error.code = err?.code === "ENOENT" || err?.code === "ECONNREFUSED"
        ? "MATERIAL_UPLOAD_RUNTIME_UNAVAILABLE"
        : "MATERIAL_UPLOAD_SOCKET_ERROR";
      finish(error);
    });
    socket.on("data", (chunk) => {
      responseBuffer += chunk;
      if (responseBuffer.length > 64 * 1024) {
        const error = new Error("Material upload response exceeded the control bound.");
        error.code = "MATERIAL_UPLOAD_RESPONSE_TOO_LARGE";
        finish(error);
        return;
      }
      const newline = responseBuffer.indexOf("\n");
      if (newline < 0) return;
      let parsed;
      try { parsed = JSON.parse(responseBuffer.slice(0, newline)); }
      catch {
        const error = new Error("Material upload response is invalid.");
        error.code = "MATERIAL_UPLOAD_RESPONSE_INVALID";
        finish(error);
        return;
      }
      if (parsed?.ok !== true) {
        const error = new Error(String(parsed?.error || "MATERIAL_UPLOAD_FAILED"));
        error.code = String(parsed?.error || "MATERIAL_UPLOAD_FAILED");
        if (Number.isSafeInteger(parsed?.expected_offset)) error.expected_offset = parsed.expected_offset;
        finish(error);
        return;
      }
      if (parsed.complete === true && typeof parsed.sha256_hex === "string") ticket.sha256_hex = parsed.sha256_hex;
      finish(null, {
        upload_id: ticket.upload_id,
        offset: parsed.offset,
        complete: parsed.complete === true,
        sha256_hex: parsed.sha256_hex || null,
        chunk_bytes: bytes.length,
        source: hasBase64 ? "base64" : "zero_fill_qualification",
      });
    });
    socket.once("connect", () => {
      socket.write(JSON.stringify({
        op: "append",
        file_handle: ticket.material_file_handle,
        filename: ticket.filename,
        media_type: ticket.media_type,
        size_bytes: ticket.size_bytes,
        sha256_hex: ticket.expected_sha256,
        offset: start,
        chunk_bytes: bytes.length,
      }) + "\n");
      socket.end(bytes);
    });
  });
}

const telegramMaterialUpload = {
  create: createTelegramMaterialUpload,
  status: statusTelegramMaterialUpload,
  delete: deleteTelegramMaterialUpload,
  append: appendTelegramMaterialUploadChunk,
  async ready(uploadId) {
    const ticket = getTelegramMaterialUpload(uploadId);
    if (ticket.send_started) {
      const error = new Error("This upload ticket has already entered provider dispatch and cannot be blindly reused.");
      error.code = "MATERIAL_UPLOAD_SEND_ALREADY_STARTED";
      throw error;
    }
    const status = await statusTelegramMaterialUpload(uploadId);
    if (status.complete !== true || !/^[0-9a-f]{64}$/.test(String(status.sha256_hex || ""))) {
      const error = new Error("Material upload is not complete.");
      error.code = "MATERIAL_UPLOAD_INCOMPLETE";
      throw error;
    }
    return { ...ticket, sha256_hex: status.sha256_hex };
  },
  markSendStarted(uploadId) {
    getTelegramMaterialUpload(uploadId).send_started = true;
  },
};

function handleTelegramMaterialUploadPut(req, res) {
  try {
    const ticket = getTelegramMaterialUpload(req.params.upload_id);
    if (ticket.send_started) {
      res.status(409).json({ error: "MATERIAL_UPLOAD_SEND_ALREADY_STARTED" });
      return;
    }
    const offset = Number(req.get("upload-offset"));
    const contentLength = Number(req.get("content-length"));
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > ticket.size_bytes) {
      res.status(400).json({ error: "MATERIAL_UPLOAD_OFFSET_INVALID" });
      return;
    }
    if (!Number.isSafeInteger(contentLength) || contentLength < 1 || contentLength > TELEGRAM_MATERIAL_UPLOAD_MAX_CHUNK_BYTES) {
      res.status(413).json({ error: "MATERIAL_UPLOAD_CHUNK_SIZE_INVALID", max_chunk_bytes: TELEGRAM_MATERIAL_UPLOAD_MAX_CHUNK_BYTES });
      return;
    }
    if (offset + contentLength > ticket.size_bytes) {
      res.status(400).json({ error: "MATERIAL_UPLOAD_SIZE_OVERRUN" });
      return;
    }
    const upstream = net.createConnection(TELEGRAM_MATERIAL_UPLOAD_SOCKET);
    let responseBuffer = "";
    let finished = false;
    const finish = (statusCode, payload) => {
      if (finished) return;
      finished = true;
      try { upstream.destroy(); } catch {}
      if (!res.headersSent) res.status(statusCode).json(payload);
    };
    upstream.setEncoding("utf8");
    upstream.setTimeout(120_000, () => finish(504, { error: "MATERIAL_UPLOAD_TIMEOUT" }));
    upstream.once("error", (err) => finish(503, { error: err?.code === "ENOENT" || err?.code === "ECONNREFUSED" ? "MATERIAL_UPLOAD_RUNTIME_UNAVAILABLE" : "MATERIAL_UPLOAD_SOCKET_ERROR" }));
    upstream.on("data", (chunk) => {
      responseBuffer += chunk;
      if (responseBuffer.length > 64 * 1024) { finish(502, { error: "MATERIAL_UPLOAD_RESPONSE_TOO_LARGE" }); return; }
      const newline = responseBuffer.indexOf("\n");
      if (newline < 0) return;
      let parsed;
      try { parsed = JSON.parse(responseBuffer.slice(0, newline)); } catch { finish(502, { error: "MATERIAL_UPLOAD_RESPONSE_INVALID" }); return; }
      if (parsed?.ok !== true) {
        const code = String(parsed?.error || "MATERIAL_UPLOAD_FAILED");
        finish(code === "MATERIAL_UPLOAD_OFFSET_MISMATCH" ? 409 : 400, parsed);
        return;
      }
      if (parsed.complete === true && typeof parsed.sha256_hex === "string") ticket.sha256_hex = parsed.sha256_hex;
      finish(parsed.complete === true ? 201 : 200, { upload_id: ticket.upload_id, offset: parsed.offset, complete: parsed.complete === true, sha256_hex: parsed.sha256_hex || null });
    });
    upstream.once("connect", () => {
      upstream.write(JSON.stringify({
        op: "append",
        file_handle: ticket.material_file_handle,
        filename: ticket.filename,
        media_type: ticket.media_type,
        size_bytes: ticket.size_bytes,
        sha256_hex: ticket.expected_sha256,
        offset,
        chunk_bytes: contentLength,
      }) + "\n");
      req.pipe(upstream);
    });
    req.once("aborted", () => { try { upstream.destroy(); } catch {} });
  } catch (error) {
    res.status(error?.code === "MATERIAL_UPLOAD_NOT_FOUND" ? 404 : 400).json({ error: error?.code || "MATERIAL_UPLOAD_FAILED" });
  }
}

if (HOST !== "127.0.0.1" || PORT !== 8788) throw new Error("Refusing unexpected Onshape backend endpoint.");
if (!OPENAPI_FILE.startsWith("/openapi/")) throw new Error("Invalid local OpenAPI path.");
if (!AGENT_STATE_DIR.startsWith("/")) throw new Error("Invalid Onshape agent-state path.");
if (ANTI_FORGERY_HEADER_NAME !== "x-xsrf-token") throw new Error("Invalid anti-forgery header name.");
if (PCG_WEB_SOCKET !== "/run/pcg/web.sock") throw new Error("Invalid PCG Web socket path.");
if (TELEGRAM_DOWNLOAD_ROOT !== "/run/pcg-downloads") throw new Error("Invalid Telegram download root.");
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
  const data = String(data_base64 || "");
  const mimeType = String(mime_type || "image/jpeg");
  const downloadPath = String(metadata?.download?.download_path || "");
  const content = [
    { type: "text", text: JSON.stringify({ build_id: BUILD_ID, ...metadata }) },
  ];

  if (/^\/mcp\/screenshot\/[0-9a-f]{64}$/.test(downloadPath) && data) {
    content.push({
      type: "resource",
      resource: {
        uri: `https://cf-onshape.duckdns.org${downloadPath}`,
        mimeType,
        blob: data,
      },
    });
  }

  return { content };
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
  try { value = await response.json(); }
  catch {
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

function paaRequestId(prefix) {
  return prefix + "-" + Date.now().toString(36) + "-" + crypto.randomBytes(6).toString("hex");
}

async function paaPublish(action, parameters, requestId = null) {
  const request_id = requestId || paaRequestId("paa-cf");
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
    description: "Capture the current browser viewport exactly as displayed, regardless of authentication or page content, and return the image directly. Optionally provide exact document/workspace/element ids to navigate before capture; that navigation still requires normal Onshape access. Defaults to compact JPEG for low latency.",
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
      const download = stageScreenshotDownload(shot);
      return imageResult({ ...shot, download });
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

  server.registerTool("android_command_status", {
    title: "Read Android command status",
    description: "Read the receipt/state of one previously queued Personal Android Agent command.",
    inputSchema: { request_id: z.string().regex(/^[A-Za-z0-9_.-]{8,96}$/) },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ request_id }) => safeTool("android", async () =>
    await paaControl("/local/v1/status?request_id=" + encodeURIComponent(request_id))));

  server.registerTool("android_storage_status", {
    title: "Read Android shared-storage status",
    description: "Queue a read-only check of the persisted user-granted Android storage tree.",
    inputSchema: {},
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async () => safeTool("android", async () => ({
    command: await paaPublish("storage.status", {}),
  })));

  server.registerTool("android_storage_list", {
    title: "List Android shared-storage folder",
    description: "Queue a bounded listing inside the one user-granted Android storage tree. directory is relative to that granted root.",
    inputSchema: {
      directory: z.string().max(512).optional(),
      limit: z.number().int().min(1).max(500).optional(),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async ({ directory = "", limit = 100 }) => safeTool("android", async () => ({
    command: await paaPublish("storage.list", { directory, limit }),
  })));

  server.registerTool("android_storage_stat", {
    title: "Inspect Android shared-storage file",
    description: "Queue a read-only stat for one relative path inside the user-granted Android storage tree.",
    inputSchema: { path: z.string().min(1).max(512) },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async ({ path }) => safeTool("android", async () => ({
    command: await paaPublish("storage.stat", { path }),
  })));

  server.registerTool("android_storage_save_telegram_attachment", {
    title: "Save Telegram attachment to Android",
    description: "Acquire one exact Telegram attachment into the private broker, stream-verify it server-side, then queue a verified save into a relative folder of the user-granted Android storage tree.",
    inputSchema: {
      message_handle: z.string().regex(/^tgmsg:[0-9a-f-]{36}$/),
      directory: z.string().max(512).optional(),
      filename: z.string().min(1).max(180).optional(),
      attachment_handle: z.string().max(90).optional(),
      attachment_index: z.number().int().min(1).max(10).optional(),
      portable_format: z.enum(["original", "mp3"]).optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async (input) => safeTool("android", async () => {
    const message_handle = input.message_handle;
    const fetched = await invokeTelegramSemanticOperation({
      operation: "communication.message.fetch", args: { message_handle },
    }, { socketPath: PCG_WEB_SOCKET });
    const message = fetched?.protected_provider_data?.message;
    const attachments = Array.isArray(message?.attachments) ? message.attachments : [];
    if (!attachments.length) {
      const error = new Error("Telegram message has no downloadable attachment.");
      error.code = "PCG_ATTACHMENT_NOT_FOUND";
      throw error;
    }
    let attachment = null;
    if (input.attachment_handle) {
      attachment = attachments.find((item) => item?.handle === input.attachment_handle) || null;
    } else {
      attachment = attachments[(input.attachment_index ?? 1) - 1] || null;
    }
    if (!attachment) {
      const error = new Error("Requested Telegram attachment was not found.");
      error.code = "PCG_ATTACHMENT_NOT_FOUND";
      throw error;
    }
    const attachmentIsAudio = attachment?.media_kind === "voice"
      || attachment?.media_kind === "audio"
      || String(attachment?.media_type || "").startsWith("audio/");
    const portableFormat = input.portable_format || (attachmentIsAudio ? "mp3" : "original");
    const downloaded = await invokeTelegramSemanticOperation({
      operation: "communication.attachment.download",
      args: { message_handle, attachment_handle: attachment.handle, portable_format: portableFormat },
    }, { socketPath: PCG_WEB_SOCKET });
    if (downloaded?.state !== "ACHIEVED") {
      const error = new Error(String(downloaded?.error || "PCG_ATTACHMENT_DOWNLOAD_FAILED"));
      error.code = String(downloaded?.error || "PCG_ATTACHMENT_DOWNLOAD_FAILED");
      throw error;
    }
    const localFile = downloaded?.protected_provider_data?.local_file || {};
    const fileMeta = downloaded?.protected_provider_data?.attachment || {};
    const staged = await stageTelegramFileForAndroid({
      file_handle: localFile.file_handle,
      filename: fileMeta.filename || attachment.filename || null,
      media_type: fileMeta.media_type || attachment.media_type || "application/octet-stream",
      size_bytes: fileMeta.size_bytes || attachment.size_bytes || null,
      sha256_hex: fileMeta.sha256_hex || null,
    });
    const filename = input.filename || staged.filename;
    const command = await paaPublish("storage.file.save_from_url", {
      url: "https://cf-onshape.duckdns.org" + staged.download_path,
      sha256: staged.sha256_hex,
      size_bytes: staged.size_bytes,
      directory: input.directory || "",
      filename,
      mime: staged.mime_type,
    });
    return {
      command,
      attachment: {
        message_handle,
        attachment_handle: attachment.handle,
        filename,
        media_type: staged.mime_type,
        size_bytes: staged.size_bytes,
        sha256_hex: staged.sha256_hex,
        portable_format: portableFormat,
        expires_after_seconds: staged.expires_after_seconds,
      },
    };
  }));

  server.registerTool("android_storage_upload_to_server", {
    title: "Upload Android file for Telegram",
    description: "Create a resumable server upload ticket and queue Android Agent to upload one exact relative file from the user-granted storage tree. After the command receipt is complete, use telegram_file_send with the returned upload_id.",
    inputSchema: {
      path: z.string().min(1).max(512),
      filename: z.string().min(1).max(128),
      media_type: z.string().min(3).max(128),
      size_bytes: z.number().int().min(1).max(2147483648),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async ({ path, filename, media_type, size_bytes }) => safeTool("android", async () => {
    const upload = createTelegramMaterialUpload({ filename, media_type, size_bytes });
    const command = await paaPublish("storage.file.upload_to_url", {
      path,
      upload_url: upload.upload_url,
      size_bytes,
    });
    return { command, upload };
  }));

  registerTelegramConversationTool(server, z, { socketPath: PCG_WEB_SOCKET });
  registerTelegramSemanticTools(server, z, { socketPath: PCG_WEB_SOCKET, stageTelegramFile, materialUpload: telegramMaterialUpload });

  return server;
}

const app = express();
app.use((_req, res, next) => {
  res.setHeader("X-CF-Build-Id", BUILD_ID);
  next();
});
app.use(express.json({ limit: "5mb" }));
app.get("/", (_req, res) => res.type("text/plain").send("cf-onshape-single ok"));
app.get("/mcp/screenshot/:download_id", (req, res) => {
  const item = getScreenshotDownload(req.params.download_id);
  if (!item) {
    res.status(404).json({ error: "Screenshot download not found or expired." });
    return;
  }
  res.setHeader("content-type", item.mime_type);
  res.setHeader("content-disposition", `attachment; filename="${item.filename}"`);
  res.setHeader("content-length", String(item.bytes.length));
  res.setHeader("cache-control", "private, no-store, max-age=0");
  res.setHeader("x-content-type-options", "nosniff");
  res.status(200).end(item.bytes);
});
app.put("/mcp/upload/:upload_id", handleTelegramMaterialUploadPut);
app.get("/mcp/telegram-file/:download_id", (req, res) => {
  const item = getTelegramFileDownload(req.params.download_id);
  if (!item) {
    res.status(404).json({ error: "Telegram file download not found or expired." });
    return;
  }
  const disposition = /^(image|audio|video)\//i.test(item.mime_type) ? "inline" : "attachment";
  res.setHeader("content-type", item.mime_type);
  res.setHeader("content-disposition", disposition + '; filename="' + item.filename.replace(/"/g, "_") + '"');
  res.setHeader("content-length", String(item.size_bytes));
  res.setHeader("cache-control", "private, no-store, max-age=0");
  res.setHeader("x-content-type-options", "nosniff");
  if (Buffer.isBuffer(item.bytes)) {
    res.status(200).end(item.bytes);
    return;
  }
  const stream = fs.createReadStream(item.path);
  stream.once("error", () => {
    telegramFileDownloads.delete(String(req.params.download_id || "").toLowerCase());
    if (!res.headersSent) res.status(404).json({ error: "Telegram file download not found or expired." });
    else res.destroy();
  });
  res.status(200);
  stream.pipe(res);
});
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
