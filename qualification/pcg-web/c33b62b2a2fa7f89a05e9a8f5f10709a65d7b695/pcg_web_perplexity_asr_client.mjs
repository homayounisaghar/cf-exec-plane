import net from "node:net";

const DEFAULT_SOCKET = process.env.PCG_PERPLEXITY_ASR_SOCKET || "/run/pcg/perplexity-asr.sock";

function fail(code, message = code) {
  const err = new Error(message);
  err.code = code;
  throw err;
}

async function call(payload, {
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
        finish(Object.assign(new Error("PERPLEXITY_ASR_RESPONSE_TOO_LARGE"), { code: "PERPLEXITY_ASR_RESPONSE_TOO_LARGE" }));
        return;
      }
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      try {
        const value = JSON.parse(buffer.slice(0, newline));
        if (value?.ok !== true) {
          const code = String(value?.error || "PERPLEXITY_ASR_FAILED");
          finish(Object.assign(new Error(code), { code }));
          return;
        }
        finish(null, value);
      } catch {
        finish(Object.assign(new Error("PERPLEXITY_ASR_RESPONSE_INVALID"), { code: "PERPLEXITY_ASR_RESPONSE_INVALID" }));
      }
    });
    socket.once("timeout", () => finish(Object.assign(new Error("PERPLEXITY_ASR_TIMEOUT"), { code: "PERPLEXITY_ASR_TIMEOUT" })));
    socket.once("error", (err) => {
      const code = err?.code === "ENOENT" || err?.code === "ECONNREFUSED"
        ? "PERPLEXITY_ASR_RUNTIME_UNAVAILABLE"
        : "PERPLEXITY_ASR_SOCKET_FAILED";
      finish(Object.assign(new Error(code), { code }));
    });
    socket.once("end", () => {
      if (!settled) finish(Object.assign(new Error("PERPLEXITY_ASR_RESPONSE_INCOMPLETE"), { code: "PERPLEXITY_ASR_RESPONSE_INCOMPLETE" }));
    });
  });
}

function validSha(value) {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

export async function startPerplexityAsrJob({
  materialFileHandle,
  filename,
  sizeBytes,
  sha256Hex,
  language = "fa",
  speedFactor = 4,
} = {}) {
  if (typeof materialFileHandle !== "string" || !/^pcgfile:[0-9a-f]{64}$/.test(materialFileHandle)) fail("PERPLEXITY_ASR_MATERIAL_HANDLE_INVALID");
  if (typeof filename !== "string" || !filename || filename.length > 512) fail("PERPLEXITY_ASR_FILENAME_INVALID");
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 1 || sizeBytes > 64 * 1024 * 1024) fail("PERPLEXITY_ASR_SOURCE_SIZE_INVALID");
  if (!validSha(sha256Hex)) fail("PERPLEXITY_ASR_SOURCE_DIGEST_INVALID");
  if (language !== "fa") fail("PERPLEXITY_ASR_LANGUAGE_UNSUPPORTED");
  if (!Number.isInteger(speedFactor) || ![1, 2, 4, 8].includes(speedFactor)) fail("PERPLEXITY_ASR_SPEED_FACTOR_UNSUPPORTED");
  return await call({
    op: "transcribe.start",
    material_file_handle: materialFileHandle,
    filename,
    size_bytes: sizeBytes,
    sha256_hex: sha256Hex,
    language,
    speed_factor: speedFactor,
  });
}

export async function getPerplexityAsrJob(jobId) {
  if (typeof jobId !== "string" || !/^[0-9a-f]{64}$/.test(jobId)) fail("PERPLEXITY_ASR_JOB_ID_INVALID");
  return await call({ op: "transcribe.status", job_id: jobId }, { timeoutMs: 3000 });
}

export async function getPerplexityAsrHealth() {
  return await call({ op: "health" }, { timeoutMs: 5000, maxBytes: 262144 });
}
