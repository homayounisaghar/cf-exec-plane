import net from "node:net";

const DEFAULT_SOCKET = process.env.PCG_AUDIO_TRANSFORM_SOCKET || "/run/pcg/audio-transform.sock";

function fail(code) {
  const err = new Error(code);
  err.code = code;
  throw err;
}

async function callTransform(payload, {
  socketPath = DEFAULT_SOCKET,
  timeoutMs = 12 * 60 * 1000,
  maxBytes = 512 * 1024,
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
        finish(Object.assign(new Error("AUDIO_TRANSFORM_RESPONSE_TOO_LARGE"), { code: "AUDIO_TRANSFORM_RESPONSE_TOO_LARGE" }));
        return;
      }
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      try {
        const value = JSON.parse(buffer.slice(0, newline));
        if (value?.ok !== true) {
          finish(Object.assign(new Error(String(value?.error || "AUDIO_TRANSFORM_FAILED")), {
            code: String(value?.error || "AUDIO_TRANSFORM_FAILED"),
          }));
          return;
        }
        finish(null, value);
      } catch {
        finish(Object.assign(new Error("AUDIO_TRANSFORM_RESPONSE_INVALID"), { code: "AUDIO_TRANSFORM_RESPONSE_INVALID" }));
      }
    });
    socket.once("timeout", () => finish(Object.assign(new Error("AUDIO_TRANSFORM_TIMEOUT"), { code: "AUDIO_TRANSFORM_TIMEOUT" })));
    socket.once("error", (err) => {
      const code = err?.code === "ENOENT" || err?.code === "ECONNREFUSED"
        ? "AUDIO_TRANSFORM_RUNTIME_UNAVAILABLE"
        : "AUDIO_TRANSFORM_SOCKET_FAILED";
      finish(Object.assign(new Error(code), { code }));
    });
    socket.once("end", () => {
      if (!settled) finish(Object.assign(new Error("AUDIO_TRANSFORM_RESPONSE_INCOMPLETE"), { code: "AUDIO_TRANSFORM_RESPONSE_INCOMPLETE" }));
    });
  });
}

export async function convertMaterialAudioToOggOpus({
  materialFileHandle,
  filename,
  sizeBytes,
  sha256Hex,
} = {}) {
  if (typeof materialFileHandle !== "string" || !/^pcgfile:[0-9a-f]{64}$/.test(materialFileHandle)) {
    fail("AUDIO_TRANSFORM_MATERIAL_HANDLE_INVALID");
  }
  if (typeof filename !== "string" || !filename || filename.length > 128) fail("AUDIO_TRANSFORM_FILENAME_INVALID");
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 1 || sizeBytes > 2 * 1024 * 1024 * 1024) {
    fail("AUDIO_TRANSFORM_SOURCE_SIZE_INVALID");
  }
  if (typeof sha256Hex !== "string" || !/^[0-9a-f]{64}$/.test(sha256Hex)) fail("AUDIO_TRANSFORM_SOURCE_DIGEST_INVALID");
  return await callTransform({
    op: "convert",
    material_file_handle: materialFileHandle,
    filename,
    size_bytes: sizeBytes,
    sha256_hex: sha256Hex,
    sample_rate: 48000,
    bitrate_bps: 128000,
  });
}

export async function getAudioTransformHealth() {
  return await callTransform({ op: "health" }, { timeoutMs: 3000, maxBytes: 64 * 1024 });
}
