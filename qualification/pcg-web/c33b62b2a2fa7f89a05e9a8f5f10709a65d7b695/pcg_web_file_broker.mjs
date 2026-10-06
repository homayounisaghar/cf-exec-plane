import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";

function fail(code) {
  const err = new Error(code);
  err.code = code;
  throw err;
}

function safeRoot(root) {
  if (typeof root !== "string" || !root.startsWith("/") || root.includes("\0")) fail("FILE_BROKER_ROOT_INVALID");
  return root;
}

function tokenForHandle(handle) {
  if (typeof handle !== "string" || !handle.startsWith("file:")) fail("INVALID_FILE_HANDLE");
  const token = handle.slice(5);
  if (!/^[0-9a-f]{64}$/.test(token)) fail("INVALID_FILE_HANDLE");
  return token;
}

export function createPrivateFileBroker(
  root,
  {
    ttlSeconds = 3600,
    maxFileBytes = 32 * 1024 * 1024,
  } = {},
) {
  root = safeRoot(root);
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < 60 || ttlSeconds > 86400) fail("FILE_BROKER_TTL_INVALID");
  if (!Number.isInteger(maxFileBytes) || maxFileBytes < 1 || maxFileBytes > 64 * 1024 * 1024) {
    fail("FILE_BROKER_MAX_SIZE_INVALID");
  }

  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  fs.chmodSync(root, 0o700);

  function filePath(handle) {
    return path.join(root, tokenForHandle(handle));
  }

  function sweepExpired(nowMs = Date.now()) {
    let removed = 0;
    for (const name of fs.readdirSync(root)) {
      if (!/^[0-9a-f]{64}$/.test(name)) continue;
      const candidate = path.join(root, name);
      let stat;
      try {
        stat = fs.lstatSync(candidate);
      } catch {
        continue;
      }
      if (!stat.isFile() || stat.isSymbolicLink()) continue;
      if (stat.mtimeMs + ttlSeconds * 1000 > nowMs) continue;
      try {
        fs.unlinkSync(candidate);
        removed += 1;
      } catch {}
    }
    return removed;
  }

  function importBase64(dataBase64, { expectedSizeBytes, filename = null, mediaType = null } = {}) {
    if (typeof dataBase64 !== "string" || dataBase64.length < 1 || !/^[A-Za-z0-9+/]*={0,2}$/.test(dataBase64)) {
      fail("FILE_BROKER_PAYLOAD_INVALID");
    }
    if (filename !== null && (typeof filename !== "string" || filename.length < 1 || filename.length > 512 || filename.includes("\0"))) {
      fail("FILE_BROKER_FILENAME_INVALID");
    }
    if (mediaType !== null && (typeof mediaType !== "string" || mediaType.length < 1 || mediaType.length > 256 || mediaType.includes("\0"))) {
      fail("FILE_BROKER_MEDIA_TYPE_INVALID");
    }

    const bytes = Buffer.from(dataBase64, "base64");
    if (bytes.length < 1 || bytes.length > maxFileBytes) fail("FILE_BROKER_SIZE_OUT_OF_BOUNDS");
    if (expectedSizeBytes !== undefined && (!Number.isInteger(expectedSizeBytes) || expectedSizeBytes !== bytes.length)) {
      fail("FILE_BROKER_SIZE_MISMATCH");
    }

    sweepExpired();

    let token;
    let destination;
    let fd;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      token = randomBytes(32).toString("hex");
      destination = path.join(root, token);
      try {
        fd = fs.openSync(destination, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
        break;
      } catch (err) {
        if (err?.code !== "EEXIST") throw err;
      }
    }
    if (fd === undefined) fail("FILE_BROKER_HANDLE_ALLOCATION_FAILED");

    let committed = false;
    try {
      fs.writeFileSync(fd, bytes);
      fs.fsyncSync(fd);
      fs.fchmodSync(fd, 0o600);
      committed = true;
    } finally {
      try { fs.closeSync(fd); } catch {}
      if (!committed) {
        try { fs.unlinkSync(destination); } catch {}
      }
    }

    const stat = fs.lstatSync(destination);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== bytes.length) {
      try { fs.unlinkSync(destination); } catch {}
      fail("FILE_BROKER_COMMIT_INVALID");
    }

    const nowMs = Date.now();
    return {
      file_handle: "file:" + token,
      sha256_hex: createHash("sha256").update(bytes).digest("hex"),
      size_bytes: bytes.length,
      ttl_seconds: ttlSeconds,
      expires_at: Math.floor((nowMs + ttlSeconds * 1000) / 1000),
      filename,
      media_type: mediaType,
    };
  }

  function inspect(handle) {
    const candidate = filePath(handle);
    let stat;
    try {
      stat = fs.lstatSync(candidate);
    } catch (err) {
      if (err?.code === "ENOENT") fail("UNKNOWN_FILE_HANDLE");
      throw err;
    }
    if (!stat.isFile() || stat.isSymbolicLink()) fail("FILE_BROKER_ENTRY_INVALID");
    const expiresAtMs = stat.mtimeMs + ttlSeconds * 1000;
    if (expiresAtMs <= Date.now()) {
      try { fs.unlinkSync(candidate); } catch {}
      fail("FILE_HANDLE_EXPIRED");
    }
    return {
      size_bytes: stat.size,
      ttl_seconds: ttlSeconds,
      expires_at: Math.floor(expiresAtMs / 1000),
    };
  }

  function exportBase64(handle, { maxBytes = maxFileBytes } = {}) {
    if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > maxFileBytes) fail("FILE_BROKER_EXPORT_LIMIT_INVALID");
    const candidate = filePath(handle);
    const meta = inspect(handle);
    if (meta.size_bytes > maxBytes) fail("FILE_BROKER_EXPORT_TOO_LARGE");
    const data = fs.readFileSync(candidate);
    if (data.length !== meta.size_bytes) fail("FILE_BROKER_EXPORT_SIZE_MISMATCH");
    return { file_handle: handle, size_bytes: data.length, sha256_hex: createHash("sha256").update(data).digest("hex"), data_base64: data.toString("base64"), ttl_seconds: meta.ttl_seconds, expires_at: meta.expires_at };
  }

  function release(handle) {
    const candidate = filePath(handle);
    try {
      const stat = fs.lstatSync(candidate);
      if (!stat.isFile() || stat.isSymbolicLink()) fail("FILE_BROKER_ENTRY_INVALID");
      fs.unlinkSync(candidate);
      return true;
    } catch (err) {
      if (err?.code === "ENOENT") return false;
      throw err;
    }
  }

  sweepExpired();
  const interval = setInterval(() => {
    try { sweepExpired(); } catch {}
  }, Math.min(60_000, Math.max(10_000, Math.floor(ttlSeconds * 500))));
  interval.unref?.();

  return {
    importBase64,
    inspect,
    exportBase64,
    maxFileBytes,
    release,
    sweepExpired,
    ttlSeconds,
  };
}
