const MODEL_ID = "onnx-community/whisper-tiny";
const TRANSFORMERS_CDN = "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1";
const SHELL_URL = "http://127.0.0.1:8765/pcg-asr-shell";
let asrPagePromise = null;

function fail(code) {
  const err = new Error(code);
  err.code = code;
  throw err;
}

function classifyError(err, prefix) {
  const raw = typeof err?.message === "string" ? err.message.toLowerCase() : "";
  if (raw.includes("wasm")) return prefix + "_WASM";
  if (raw.includes("fetch")) return prefix + "_FETCH";
  if (raw.includes("model")) return prefix + "_MODEL";
  if (raw.includes("memory") || raw.includes("out of")) return prefix + "_MEMORY";
  if (raw.includes("unsupported") || raw.includes("not supported")) return prefix + "_UNSUPPORTED";
  if (raw.includes("tensor") || raw.includes("shape") || raw.includes("input")) return prefix + "_TENSOR";
  if (raw.includes("matmul") || raw.includes("conv")) return prefix + "_OPERATOR";
  if (raw.includes("dtype") || raw.includes("data type")) return prefix + "_DTYPE";
  if (raw.includes("typeerror")) return prefix + "_TYPE";
  return prefix;
}

async function createAsrPage(providerPage) {
  if (!providerPage || providerPage.isClosed()) fail("LOCAL_ASR_PROVIDER_PAGE_INVALID");
  const context = providerPage.context();
  const handler = async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "text/html; charset=utf-8",
      body: "<!doctype html><meta charset=utf-8><title>PCG ASR</title>",
    });
  };
  await context.route(SHELL_URL, handler);
  let page;
  try {
    page = await context.newPage();
    await page.goto(SHELL_URL, { waitUntil: "domcontentloaded", timeout: 15000 });
  } finally {
    try { await context.unroute(SHELL_URL, handler); } catch {}
  }

  try {
    await page.evaluate(async ({ cdn, modelId }) => {
      const mod = await import(cdn);
      const { env, pipeline } = mod;
      env.allowLocalModels = false;
      env.allowRemoteModels = true;
      env.useBrowserCache = true;
      if (env.backends?.onnx?.wasm) {
        env.backends.onnx.wasm.numThreads = 1;
      }
      globalThis.__pcgAsrPipeline = await pipeline(
        "automatic-speech-recognition",
        modelId,
        { dtype: "q8", device: "wasm" },
      );
      return true;
    }, { cdn: TRANSFORMERS_CDN, modelId: MODEL_ID });
  } catch (err) {
    try { await page.close(); } catch {}
    fail(classifyError(err, "LOCAL_ASR_BROWSER_RUNTIME_LOAD_FAILED"));
  }
  return page;
}

async function getAsrPage(providerPage) {
  if (asrPagePromise === null) asrPagePromise = createAsrPage(providerPage);
  try {
    const page = await asrPagePromise;
    if (!page || page.isClosed()) {
      asrPagePromise = null;
      return await getAsrPage(providerPage);
    }
    return page;
  } catch (err) {
    asrPagePromise = null;
    throw err;
  }
}

export async function transcribePcm16k(providerPage, pcmF32Base64, {
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
  if (typeof pcmF32Base64 !== "string" || !pcmF32Base64) fail("LOCAL_ASR_AUDIO_INVALID");
  if (language !== null && (typeof language !== "string" || !language.trim() || language.length > 32)) {
    fail("LOCAL_ASR_LANGUAGE_INVALID");
  }

  const page = await getAsrPage(providerPage);
  const startedAt = Date.now();
  let result;
  try {
    result = await page.evaluate(async ({ pcmF32Base64, sampleCount, durationSeconds, language }) => {
      const raw = atob(pcmF32Base64);
      const bytes = new Uint8Array(raw.length);
      for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
      if (bytes.byteLength !== sampleCount * 4) throw new Error("PCM_SIZE_INVALID");
      const audio = new Float32Array(bytes.buffer);
      const pipe = globalThis.__pcgAsrPipeline;
      if (typeof pipe !== "function") throw new Error("ASR_PIPELINE_MISSING");
      const output = await pipe(audio, {
        task: "transcribe",
        ...(language ? { language: language.trim().toLowerCase() } : {}),
        ...(durationSeconds > 28 ? { chunk_length_s: 30, stride_length_s: 5 } : {}),
      });
      return {
        text: typeof output?.text === "string" ? output.text.trim() : "",
      };
    }, {
      pcmF32Base64,
      sampleCount,
      durationSeconds,
      language: language ? language.trim() : null,
    });
  } catch (err) {
    const base = classifyError(err, "LOCAL_ASR_BROWSER_INFERENCE_FAILED");
    const name = typeof err?.name === "string"
      ? err.name.toUpperCase().replace(/[^A-Z0-9]+/g, "_").slice(0, 24)
      : "";
    const message = typeof err?.message === "string"
      ? err.message.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 72)
      : "";
    const detail = [base, name, message].filter(Boolean).join("_").slice(0, 160);
    fail(detail || "LOCAL_ASR_BROWSER_INFERENCE_FAILED");
  } finally {
    // The isolated Whisper target is intentionally one-shot. Reusing the same
    // WASM page across inferences can leave the target in a crashed/high-water
    // memory state even after a successful transcript. Browser cache keeps
    // model reload bounded while closing the page releases inference memory.
    asrPagePromise = null;
    try { if (page && !page.isClosed()) await page.close(); } catch {}
  }
  const text = typeof result?.text === "string" ? result.text.trim() : "";
  if (!text) fail("LOCAL_ASR_EMPTY_TRANSCRIPT");

  return {
    text,
    model_id: MODEL_ID,
    engine: "transformers.js-whisper-wasm",
    language: language ? language.trim().toLowerCase() : null,
    inference_ms: Date.now() - startedAt,
    sample_rate: sampleRate,
    sample_count: sampleCount,
    duration_seconds: durationSeconds,
  };
}
