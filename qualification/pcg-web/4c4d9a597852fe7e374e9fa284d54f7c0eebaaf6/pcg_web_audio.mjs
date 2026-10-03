import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const lamejs = require("lamejs");

function fail(code) {
  const err = new Error(code);
  err.code = code;
  throw err;
}

function safeFilename(value) {
  if (typeof value !== "string" || !value.trim()) return "audio.mp3";
  const base = value.replace(/\.[^.]+$/u, "").replace(/[\u0000-\u001f\u007f]/gu, "_").slice(0, 220) || "audio";
  return base + ".mp3";
}

function toInt16(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 2 || buffer.length % 2 !== 0) fail("AUDIO_PCM_INVALID");
  return new Int16Array(buffer.buffer, buffer.byteOffset, buffer.length / 2);
}

export async function transcodeAudioToMp3(page, dataBase64, {
  sourceFilename = null,
  bitrateKbps = 96,
  maxDurationSeconds = 1800,
} = {}) {
  if (!page || typeof page.evaluate !== "function") fail("AUDIO_PAGE_INVALID");
  if (typeof dataBase64 !== "string" || !dataBase64) fail("AUDIO_SOURCE_INVALID");
  if (!Number.isInteger(bitrateKbps) || bitrateKbps < 48 || bitrateKbps > 192) fail("AUDIO_BITRATE_INVALID");
  if (!Number.isFinite(maxDurationSeconds) || maxDurationSeconds < 1 || maxDurationSeconds > 3600) fail("AUDIO_DURATION_LIMIT_INVALID");

  const decoded = await page.evaluate(async ({ dataBase64, maxDurationSeconds }) => {
    const fromBase64 = (value) => {
      const raw = atob(value);
      const out = new Uint8Array(raw.length);
      for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
      return out;
    };
    const toBase64 = (bytes) => {
      let raw = "";
      const step = 0x8000;
      for (let i = 0; i < bytes.length; i += step) {
        raw += String.fromCharCode(...bytes.subarray(i, Math.min(bytes.length, i + step)));
      }
      return btoa(raw);
    };
    const toPcmBase64 = (channel) => {
      const pcm = new Int16Array(channel.length);
      for (let i = 0; i < channel.length; i += 1) {
        const sample = Math.max(-1, Math.min(1, channel[i]));
        pcm[i] = sample < 0 ? Math.round(sample * 32768) : Math.round(sample * 32767);
      }
      return toBase64(new Uint8Array(pcm.buffer));
    };

    const AudioCtx = globalThis.AudioContext || globalThis.webkitAudioContext;
    const OfflineCtx = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
    if (typeof AudioCtx !== "function" || typeof OfflineCtx !== "function") {
      return { ok: false, error: "BROWSER_AUDIO_CODEC_UNAVAILABLE" };
    }

    let context;
    try {
      context = new AudioCtx();
      const source = fromBase64(dataBase64);
      const input = source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength);
      const audio = await context.decodeAudioData(input);
      const duration = Number(audio.duration);
      if (!Number.isFinite(duration) || duration <= 0 || duration > maxDurationSeconds) {
        return { ok: false, error: "AUDIO_DURATION_OUT_OF_BOUNDS" };
      }

      const supported = [48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000];
      const targetRate = supported.reduce((best, rate) =>
        Math.abs(rate - audio.sampleRate) < Math.abs(best - audio.sampleRate) ? rate : best,
      48000);
      const targetChannels = audio.numberOfChannels === 1 ? 1 : 2;
      const targetLength = Math.ceil(duration * targetRate);
      const offline = new OfflineCtx(targetChannels, targetLength, targetRate);
      const sourceNode = offline.createBufferSource();
      sourceNode.buffer = audio;
      sourceNode.connect(offline.destination);
      sourceNode.start(0);
      const rendered = await offline.startRendering();
      const channels = [];
      for (let i = 0; i < targetChannels; i += 1) {
        channels.push(toPcmBase64(rendered.getChannelData(i)));
      }
      return {
        ok: true,
        duration_seconds: duration,
        sample_rate: rendered.sampleRate,
        channels: targetChannels,
        pcm_base64: channels,
      };
    } catch {
      return { ok: false, error: "BROWSER_AUDIO_DECODE_FAILED" };
    } finally {
      try { await context?.close?.(); } catch {}
    }
  }, { dataBase64, maxDurationSeconds });

  if (!decoded?.ok) fail(decoded?.error || "AUDIO_DECODE_FAILED");
  if (![1, 2].includes(decoded.channels) || !Number.isInteger(decoded.sample_rate)) fail("AUDIO_PCM_METADATA_INVALID");
  const left = toInt16(Buffer.from(decoded.pcm_base64?.[0] || "", "base64"));
  const right = decoded.channels === 2 ? toInt16(Buffer.from(decoded.pcm_base64?.[1] || "", "base64")) : null;
  if (!left.length || (right && right.length !== left.length)) fail("AUDIO_PCM_CHANNELS_INVALID");

  const encoder = new lamejs.Mp3Encoder(decoded.channels, decoded.sample_rate, bitrateKbps);
  const parts = [];
  const block = 1152;
  for (let offset = 0; offset < left.length; offset += block) {
    const l = left.subarray(offset, Math.min(left.length, offset + block));
    const encoded = decoded.channels === 2
      ? encoder.encodeBuffer(l, right.subarray(offset, Math.min(right.length, offset + block)))
      : encoder.encodeBuffer(l);
    if (encoded?.length) parts.push(Buffer.from(encoded));
  }
  const tail = encoder.flush();
  if (tail?.length) parts.push(Buffer.from(tail));
  const output = Buffer.concat(parts);
  if (!output.length) fail("AUDIO_MP3_ENCODE_EMPTY");

  return {
    data_base64: output.toString("base64"),
    size_bytes: output.length,
    media_type: "audio/mpeg",
    filename: safeFilename(sourceFilename),
    duration_seconds: decoded.duration_seconds,
    sample_rate: decoded.sample_rate,
    channels: decoded.channels,
    bitrate_kbps: bitrateKbps,
  };
}
