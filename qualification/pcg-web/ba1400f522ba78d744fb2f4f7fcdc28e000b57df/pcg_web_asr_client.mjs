import net from "node:net";

const DEFAULT_SOCKET = process.env.PCG_ASR_SOCKET || "/run/pcg/asr.sock";

function fail(code, message = code) {
  const err = new Error(message);
  err.code = code;
  throw err;
}

async function callAsr(payload, {
  socketPath = DEFAULT_SOCKET,
  timeoutMs = 15000,
  maxBytes = 2 * 1024 * 1024,
} = {}) {
  return await new Promise((resolve, reject) => {
    const socket = net.createConnection({ path: socketPath });
    let buffer = "";
    let settled = false;
    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      try { socket.destroy(); } catch {}
      err ? reject(err) : resolve(value);
    };
    socket.setEncoding("utf8");
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => socket.write(JSON.stringify(payload) + "\n"));
    socket.on("data", (chunk) => {
      buffer += chunk;
      if (buffer.length > maxBytes) {
        finish(Object.assign(new Error("LOCAL_ASR_RESPONSE_TOO_LARGE"), { code: "LOCAL_ASR_RESPONSE_TOO_LARGE" }));
        return;
      }
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      try {
        const value = JSON.parse(buffer.slice(0, newline));
        if (value?.ok !== true) {
          finish(Object.assign(new Error(String(value?.error || "LOCAL_ASR_FAILED")), {
            code: String(value?.error || "LOCAL_ASR_FAILED"),
          }));
          return;
        }
        finish(null, value);
      } catch {
        finish(Object.assign(new Error("LOCAL_ASR_RESPONSE_INVALID"), { code: "LOCAL_ASR_RESPONSE_INVALID" }));
      }
    });
    socket.once("timeout", () => finish(Object.assign(new Error("LOCAL_ASR_TIMEOUT"), { code: "LOCAL_ASR_TIMEOUT" })));
    socket.once("error", (err) => {
      const code = err?.code === "ENOENT" || err?.code === "ECONNREFUSED"
        ? "LOCAL_ASR_RUNTIME_UNAVAILABLE"
        : "LOCAL_ASR_SOCKET_FAILED";
      finish(Object.assign(new Error(code), { code }));
    });
    socket.once("end", () => {
      if (!settled) finish(Object.assign(new Error("LOCAL_ASR_RESPONSE_INCOMPLETE"), { code: "LOCAL_ASR_RESPONSE_INCOMPLETE" }));
    });
  });
}

function validSha(value) {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

export async function startLocalAsrJob({
  materialFileHandle,
  filename,
  sizeBytes,
  sha256Hex,
  language = null,
} = {}) {
  if (typeof materialFileHandle !== "string" || !/^pcgfile:[0-9a-f]{64}$/.test(materialFileHandle)) {
    fail("LOCAL_ASR_MATERIAL_HANDLE_INVALID");
  }
  if (typeof filename !== "string" || !filename || filename.length > 512) fail("LOCAL_ASR_FILENAME_INVALID");
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 1 || sizeBytes > 2 * 1024 * 1024 * 1024) {
    fail("LOCAL_ASR_SOURCE_SIZE_INVALID");
  }
  if (!validSha(sha256Hex)) fail("LOCAL_ASR_SOURCE_DIGEST_INVALID");
  if (language !== null && (typeof language !== "string" || !/^[a-z]{2,3}$/i.test(language.trim()))) {
    fail("LOCAL_ASR_LANGUAGE_INVALID");
  }
  return await callAsr({
    op: "transcribe.start",
    material_file_handle: materialFileHandle,
    filename,
    size_bytes: sizeBytes,
    sha256_hex: sha256Hex,
    language: language ? language.trim().toLowerCase() : null,
  });
}

export async function getLocalAsrJob(jobId) {
  if (typeof jobId !== "string" || !/^[0-9a-f]{64}$/.test(jobId)) fail("LOCAL_ASR_JOB_ID_INVALID");
  return await callAsr({ op: "transcribe.status", job_id: jobId }, { timeoutMs: 3000 });
}

export async function getLocalAsrHealth() {
  return await callAsr({ op: "health" }, { timeoutMs: 3000, maxBytes: 262144 });
}
