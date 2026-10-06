import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { createHash } from "node:crypto";

const HANDLE_RE = /^pcgfile:([0-9a-f]{64})$/;
const SHA_RE = /^[0-9a-f]{64}$/;
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024 * 1024;
const DEFAULT_MAX_CHUNK_BYTES = 16 * 1024 * 1024;
const HEADER_MAX_BYTES = 16 * 1024;

function fail(code, message = code, extra = {}) {
  const err = new Error(message);
  err.code = code;
  Object.assign(err, extra);
  throw err;
}

function safeFilename(value) {
  const text = String(value || "").trim();
  if (!text || text.length > 128 || text === "." || text === ".." || /[\\/\u0000-\u001f\u007f]/u.test(text)) {
    fail("MATERIAL_UPLOAD_FILENAME_INVALID");
  }
  return text;
}

function safeMediaType(value) {
  const text = String(value || "application/octet-stream").trim().toLowerCase();
  if (text.length > 128 || !/^[a-z0-9][a-z0-9!#&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#&^_.+-]{0,63}$/.test(text)) {
    fail("MATERIAL_UPLOAD_MEDIA_TYPE_INVALID");
  }
  return text;
}

function tokenForHandle(value) {
  const match = HANDLE_RE.exec(String(value || "").trim());
  if (!match) fail("MATERIAL_UPLOAD_HANDLE_INVALID");
  return match[1];
}

function sha256File(filePath) {
  const hash = createHash("sha256");
  const fd = fs.openSync(filePath, "r");
  const buffer = Buffer.alloc(1024 * 1024);
  try {
    for (;;) {
      const n = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (!n) break;
      hash.update(buffer.subarray(0, n));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest("hex");
}

export function createMaterialUploadIngress({
  socketPath,
  materialFileRoot,
  maxBytes = DEFAULT_MAX_BYTES,
  maxChunkBytes = DEFAULT_MAX_CHUNK_BYTES,
} = {}) {
  if (!path.isAbsolute(String(socketPath || ""))) fail("MATERIAL_UPLOAD_SOCKET_INVALID");
  if (!path.isAbsolute(String(materialFileRoot || ""))) fail("MATERIAL_UPLOAD_ROOT_INVALID");
  const metaRoot = path.join(materialFileRoot, ".upload-meta");
  let server = null;

  function ensureDirs() {
    fs.mkdirSync(path.dirname(socketPath), { recursive: true, mode: 0o770 });
    fs.mkdirSync(materialFileRoot, { recursive: true, mode: 0o710 });
    fs.mkdirSync(metaRoot, { recursive: true, mode: 0o700 });
    fs.chmodSync(materialFileRoot, 0o710);
    fs.chmodSync(metaRoot, 0o700);
  }

  function pathsFor(token, filename) {
    return {
      data: path.join(materialFileRoot, token + "-" + filename),
      meta: path.join(metaRoot, token + ".json"),
    };
  }

  function readMeta(token) {
    const metaPath = path.join(metaRoot, token + ".json");
    let meta;
    try {
      meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
    } catch {
      fail("MATERIAL_UPLOAD_NOT_FOUND");
    }
    if (!meta || meta.schema !== 1 || meta.token !== token) fail("MATERIAL_UPLOAD_METADATA_INVALID");
    return { meta, paths: pathsFor(token, meta.filename) };
  }

  function writeMeta(meta, { exclusive = false } = {}) {
    const target = path.join(metaRoot, meta.token + ".json");
    if (exclusive) {
      fs.writeFileSync(target, JSON.stringify(meta) + "\n", { encoding: "utf8", mode: 0o600, flag: "wx" });
      return;
    }
    const tmp = target + "." + process.pid + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(meta) + "\n", { encoding: "utf8", mode: 0o600 });
    fs.renameSync(tmp, target);
    fs.chmodSync(target, 0o600);
  }

  function publicStatus(meta, paths, { hashWhenComplete = true } = {}) {
    let size = 0;
    try {
      const st = fs.lstatSync(paths.data);
      if (!st.isFile() || st.isSymbolicLink()) fail("MATERIAL_UPLOAD_ENTRY_INVALID");
      size = st.size;
    } catch (err) {
      if (err?.code !== "ENOENT") throw err;
    }
    if (size > meta.size_bytes) fail("MATERIAL_UPLOAD_SIZE_OVERRUN");
    const complete = size === meta.size_bytes;
    let sha = meta.actual_sha256 || null;
    if (complete && hashWhenComplete && !sha) {
      sha = sha256File(paths.data);
      if (meta.expected_sha256 && sha !== meta.expected_sha256) {
        try { fs.unlinkSync(paths.data); } catch {}
        try { fs.unlinkSync(paths.meta); } catch {}
        fail("MATERIAL_UPLOAD_DIGEST_MISMATCH");
      }
      meta.actual_sha256 = sha;
      meta.completed_at = new Date().toISOString();
      writeMeta(meta);
    }
    return {
      ok: true,
      state: complete ? "COMPLETE" : "UPLOADING",
      material_file_handle: "pcgfile:" + meta.token,
      filename: meta.filename,
      media_type: meta.media_type,
      size_bytes: meta.size_bytes,
      offset: size,
      complete,
      sha256_hex: complete ? sha : null,
    };
  }

  function validateHeader(raw) {
    const op = String(raw?.op || "").trim();
    const token = tokenForHandle(raw?.file_handle);
    if (op === "status" || op === "delete") return { op, token };

    if (op !== "append") fail("MATERIAL_UPLOAD_OPERATION_INVALID");
    const filename = safeFilename(raw.filename);
    const mediaType = safeMediaType(raw.media_type);
    const sizeBytes = Number(raw.size_bytes);
    const offset = Number(raw.offset);
    const chunkBytes = Number(raw.chunk_bytes);
    const expectedSha = raw.sha256_hex == null || raw.sha256_hex === ""
      ? null
      : String(raw.sha256_hex).toLowerCase();

    if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 1 || sizeBytes > maxBytes) fail("MATERIAL_UPLOAD_SIZE_INVALID");
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > sizeBytes) fail("MATERIAL_UPLOAD_OFFSET_INVALID");
    if (!Number.isSafeInteger(chunkBytes) || chunkBytes < 1 || chunkBytes > maxChunkBytes || offset + chunkBytes > sizeBytes) {
      fail("MATERIAL_UPLOAD_CHUNK_SIZE_INVALID");
    }
    if (expectedSha && !SHA_RE.test(expectedSha)) fail("MATERIAL_UPLOAD_DIGEST_INVALID");
    return { op, token, filename, mediaType, sizeBytes, offset, chunkBytes, expectedSha };
  }

  function setupAppend(header) {
    ensureDirs();
    const incomingMeta = {
      schema: 1,
      token: header.token,
      filename: header.filename,
      media_type: header.mediaType,
      size_bytes: header.sizeBytes,
      expected_sha256: header.expectedSha,
      actual_sha256: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    const candidatePaths = pathsFor(header.token, header.filename);
    let existing = null;
    try { existing = readMeta(header.token); } catch (err) {
      if (err?.code !== "MATERIAL_UPLOAD_NOT_FOUND") throw err;
    }

    if (!existing) {
      if (header.offset !== 0) fail("MATERIAL_UPLOAD_OFFSET_MISMATCH", "Upload must start at offset zero.", { expected_offset: 0 });
      try {
        const fd = fs.openSync(candidatePaths.data, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
        fs.fchmodSync(fd, 0o640);
        fs.closeSync(fd);
        writeMeta(incomingMeta, { exclusive: true });
        existing = { meta: incomingMeta, paths: candidatePaths };
      } catch (err) {
        try { fs.unlinkSync(candidatePaths.data); } catch {}
        try { fs.unlinkSync(candidatePaths.meta); } catch {}
        if (err?.code === "EEXIST") fail("MATERIAL_UPLOAD_COLLISION");
        throw err;
      }
    }

    const meta = existing.meta;
    const paths = existing.paths;
    if (
      meta.filename !== header.filename
      || meta.media_type !== header.mediaType
      || meta.size_bytes !== header.sizeBytes
      || (meta.expected_sha256 || null) !== (header.expectedSha || null)
    ) {
      fail("MATERIAL_UPLOAD_METADATA_MISMATCH");
    }
    const current = fs.lstatSync(paths.data);
    if (!current.isFile() || current.isSymbolicLink()) fail("MATERIAL_UPLOAD_ENTRY_INVALID");
    fs.chmodSync(paths.data, 0o640);
    if (current.size !== header.offset) {
      fail("MATERIAL_UPLOAD_OFFSET_MISMATCH", "Upload offset does not match staged file.", { expected_offset: current.size });
    }
    const fd = fs.openSync(paths.data, "r+");
    return { meta, paths, fd };
  }

  function responseForError(err) {
    return {
      ok: false,
      error: typeof err?.code === "string" ? err.code : "MATERIAL_UPLOAD_FAILED",
      ...(Number.isSafeInteger(err?.expected_offset) ? { expected_offset: err.expected_offset } : {}),
    };
  }

  function handleConnection(socket) {
    let headerBuffer = Buffer.alloc(0);
    let header = null;
    let append = null;
    let received = 0;
    let replied = false;

    function reply(payload) {
      if (replied) return;
      replied = true;
      try { socket.end(JSON.stringify(payload) + "\n"); } catch {}
    }

    function closeFd() {
      if (append?.fd !== undefined && append.fd !== null) {
        try { fs.closeSync(append.fd); } catch {}
        append.fd = null;
      }
    }

    function processBody(chunk) {
      if (!header || header.op !== "append" || !append || replied || !chunk.length) return;
      const remaining = header.chunkBytes - received;
      if (chunk.length > remaining) {
        if (remaining > 0) {
          fs.writeSync(append.fd, chunk, 0, remaining, header.offset + received);
          received += remaining;
        }
        closeFd();
        reply({ ok: false, error: "MATERIAL_UPLOAD_CHUNK_OVERRUN", offset: header.offset + received });
        return;
      }
      fs.writeSync(append.fd, chunk, 0, chunk.length, header.offset + received);
      received += chunk.length;
    }

    socket.on("data", (chunk) => {
      try {
        if (replied) return;
        if (!header) {
          headerBuffer = Buffer.concat([headerBuffer, chunk]);
          const newline = headerBuffer.indexOf(0x0a);
          if (newline < 0) {
            if (headerBuffer.length > HEADER_MAX_BYTES) fail("MATERIAL_UPLOAD_HEADER_TOO_LARGE");
            return;
          }
          if (newline > HEADER_MAX_BYTES) fail("MATERIAL_UPLOAD_HEADER_TOO_LARGE");
          const rawHeader = JSON.parse(headerBuffer.subarray(0, newline).toString("utf8"));
          header = validateHeader(rawHeader);
          const remainder = headerBuffer.subarray(newline + 1);
          headerBuffer = Buffer.alloc(0);

          if (header.op === "status") {
            const existing = readMeta(header.token);
            reply(publicStatus(existing.meta, existing.paths));
            return;
          }
          if (header.op === "delete") {
            let existing = null;
            try { existing = readMeta(header.token); } catch {}
            if (existing) {
              try { fs.unlinkSync(existing.paths.data); } catch {}
              try { fs.unlinkSync(existing.paths.meta); } catch {}
            }
            reply({ ok: true, state: "DELETED", material_file_handle: "pcgfile:" + header.token });
            return;
          }
          append = setupAppend(header);
          processBody(remainder);
          return;
        }
        processBody(chunk);
      } catch (err) {
        closeFd();
        reply(responseForError(err));
      }
    });

    socket.on("end", () => {
      if (replied) return;
      try {
        if (!header) fail("MATERIAL_UPLOAD_HEADER_INCOMPLETE");
        if (header.op !== "append") return;
        if (!append) fail("MATERIAL_UPLOAD_NOT_INITIALIZED");
        fs.fsyncSync(append.fd);
        closeFd();
        append.meta.updated_at = new Date().toISOString();
        writeMeta(append.meta);
        const status = publicStatus(append.meta, append.paths);
        if (received !== header.chunkBytes) {
          reply({
            ok: false,
            error: "MATERIAL_UPLOAD_CHUNK_INCOMPLETE",
            offset: status.offset,
            expected_chunk_bytes: header.chunkBytes,
            received_chunk_bytes: received,
          });
          return;
        }
        reply(status);
      } catch (err) {
        closeFd();
        reply(responseForError(err));
      }
    });

    socket.on("error", () => { closeFd(); });
    socket.on("close", () => { closeFd(); });
  }

  async function start() {
    if (server) return;
    ensureDirs();
    try { fs.unlinkSync(socketPath); } catch (err) { if (err?.code !== "ENOENT") throw err; }
    server = net.createServer(handleConnection);
    await new Promise((resolve, reject) => {
      const onError = (err) => { server?.off("listening", onListen); reject(err); };
      const onListen = () => { server?.off("error", onError); resolve(); };
      server.once("error", onError);
      server.once("listening", onListen);
      server.listen(socketPath);
    });
    fs.chmodSync(socketPath, 0o660);
  }

  async function close() {
    if (!server) return;
    const active = server;
    server = null;
    await new Promise((resolve) => active.close(() => resolve()));
    try { fs.unlinkSync(socketPath); } catch {}
  }

  return { start, close };
}
