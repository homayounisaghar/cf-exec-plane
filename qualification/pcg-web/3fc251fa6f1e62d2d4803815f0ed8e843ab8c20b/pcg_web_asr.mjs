import fs from "node:fs";

const MODEL_ID = "onnx-community/whisper-tiny";
const CACHE_DIR = "/profile/.pcg-asr-cache";
let transformersPromise = null;
let pipelinePromise = null;

function fail(code) {
  const err = new Error(code);
  err.code = code;
  throw err;
}

fs.mkdirSync(CACHE_DIR, { recursive: true, mode: 0o700 });

async function transformers() {
  if (transformersPromise === null) {
    transformersPromise = import("@huggingface/transformers");
  }
  try {
    return await transformersPromise;
  } catch (err) {
    transformersPromise = null;
    const rawCode = typeof err?.code === "string" ? err.code.toUpperCase().replace(/[^A-Z0-9_]/g, "_").slice(0, 48) : "";
    const rawMessage = typeof err?.message === "string" ? err.message.toLowerCase() : "";
    let category = rawCode || "UNKNOWN";
    if (rawMessage.includes("sharp")) category = "SHARP";
    else if (rawMessage.includes("onnxruntime")) category = "ONNXRUNTIME";
    else if (rawMessage.includes("cannot find package") || rawMessage.includes("cannot find module")) category = "MODULE_NOT_FOUND";
    else if (rawMessage.includes("glibc") || rawMessage.includes("dlopen")) category = "NATIVE_ABI";
    fail("LOCAL_ASR_RUNTIME_LOAD_FAILED_" + category);
  }
}

async function getPipeline() {
  if (pipelinePromise === null) {
    pipelinePromise = (async () => {
      const { env, pipeline } = await transformers();
      env.cacheDir = CACHE_DIR;
      env.allowRemoteModels = true;
      env.useFSCache = true;
      return await pipeline("automatic-speech-recognition", MODEL_ID, {
        dtype: "q4",
      });
    })();
  }
  try {
    return await pipelinePromise;
  } catch (err) {
    pipelinePromise = null;
    if (err?.code) throw err;
    fail("LOCAL_ASR_MODEL_LOAD_FAILED");
  }
}

function float32FromBase64(value, sampleCount) {
  if (typeof value !== "string" || !value) fail("LOCAL_ASR_AUDIO_INVALID");
  const raw = Buffer.from(value, "base64");
  if (raw.length !== sampleCount * 4) fail("LOCAL_ASR_AUDIO_SIZE_INVALID");
  const isolated = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);
  const samples = new Float32Array(isolated);
  for (let i = 0; i < samples.length; i += 1) {
    if (!Number.isFinite(samples[i])) fail("LOCAL_ASR_AUDIO_SAMPLE_INVALID");
  }
  return samples;
}

export async function transcribePcm16k(pcmF32Base64, {
  sampleRate,
  sampleCount,
  durationSeconds,
  language = null,
} = {}) {
  if (sampleRate !== 16000) fail("LOCAL_ASR_SAMPLE_RATE_INVALID");
  if (!Number.isInteger(sampleCount) || sampleCount < 1 || sampleCount > 16000 * 3600) {
    fail("LOCAL_ASR_SAMPLE_COUNT_INVALID");
  }
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0 || durationSeconds > 3600) {
    fail("LOCAL_ASR_DURATION_INVALID");
  }
  if (language !== null && (typeof language !== "string" || !language.trim() || language.length > 32)) {
    fail("LOCAL_ASR_LANGUAGE_INVALID");
  }

  const audio = float32FromBase64(pcmF32Base64, sampleCount);
  const transcriber = await getPipeline();
  const startedAt = Date.now();
  let result;
  try {
    result = await transcriber(audio, {
      task: "transcribe",
      ...(language ? { language: language.trim().toLowerCase() } : {}),
      ...(durationSeconds > 28 ? { chunk_length_s: 30, stride_length_s: 5 } : {}),
    });
  } catch {
    fail("LOCAL_ASR_INFERENCE_FAILED");
  }
  const text = typeof result?.text === "string" ? result.text.trim() : "";
  if (!text) fail("LOCAL_ASR_EMPTY_TRANSCRIPT");

  return {
    text,
    model_id: MODEL_ID,
    engine: "transformers.js-whisper",
    language: language ? language.trim().toLowerCase() : null,
    inference_ms: Date.now() - startedAt,
    sample_rate: sampleRate,
    sample_count: sampleCount,
    duration_seconds: durationSeconds,
  };
}
