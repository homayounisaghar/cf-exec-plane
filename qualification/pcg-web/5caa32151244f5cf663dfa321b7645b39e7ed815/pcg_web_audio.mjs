import { createRequire } from "node:module";
import { createHash } from "node:crypto";

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


export async function decodeAudioToMono16k(page, dataBase64, {
  maxDurationSeconds = 1800,
} = {}) {
  if (!page || typeof page.evaluate !== "function") fail("AUDIO_PAGE_INVALID");
  if (typeof dataBase64 !== "string" || !dataBase64) fail("AUDIO_SOURCE_INVALID");
  if (!Number.isFinite(maxDurationSeconds) || maxDurationSeconds < 1 || maxDurationSeconds > 3600) {
    fail("AUDIO_DURATION_LIMIT_INVALID");
  }

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
      const audioBuffer = await context.decodeAudioData(input);
      const duration = Number(audioBuffer.duration);
      if (!Number.isFinite(duration) || duration <= 0 || duration > maxDurationSeconds) {
        return { ok: false, error: "AUDIO_DURATION_OUT_OF_BOUNDS" };
      }

      const sampleRate = 16000;
      const targetLength = Math.ceil(duration * sampleRate);
      const offline = new OfflineCtx(1, targetLength, sampleRate);
      const sourceNode = offline.createBufferSource();
      sourceNode.buffer = audioBuffer;
      sourceNode.connect(offline.destination);
      sourceNode.start(0);
      const rendered = await offline.startRendering();
      const samples = rendered.getChannelData(0);
      const copy = new Float32Array(samples.length);
      copy.set(samples);
      return {
        ok: true,
        duration_seconds: duration,
        sample_rate: sampleRate,
        sample_count: copy.length,
        pcm_f32_base64: toBase64(new Uint8Array(copy.buffer)),
      };
    } catch {
      return { ok: false, error: "BROWSER_AUDIO_DECODE_FAILED" };
    } finally {
      try { await context?.close?.(); } catch {}
    }
  }, { dataBase64, maxDurationSeconds });

  if (!decoded?.ok) fail(decoded?.error || "AUDIO_DECODE_FAILED");
  if (decoded.sample_rate !== 16000 || !Number.isInteger(decoded.sample_count) || decoded.sample_count < 1) {
    fail("AUDIO_PCM_METADATA_INVALID");
  }
  const bytes = Buffer.from(decoded.pcm_f32_base64 || "", "base64");
  if (bytes.length !== decoded.sample_count * 4) fail("AUDIO_PCM_SIZE_INVALID");
  return decoded;
}


function oggCrc(buffer) {
  let crc = 0;
  for (let i = 0; i < buffer.length; i += 1) {
    crc ^= buffer[i] << 24;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 0x80000000) !== 0 ? ((crc << 1) ^ 0x04c11db7) : (crc << 1);
      crc >>>= 0;
    }
  }
  return crc >>> 0;
}

function writeUint64LE(buffer, value, offset) {
  let v = BigInt(value);
  for (let i = 0; i < 8; i += 1) {
    buffer[offset + i] = Number(v & 0xffn);
    v >>= 8n;
  }
}

function oggPage(packet, { serial, sequence, granulePosition, headerType = 0 } = {}) {
  if (!Buffer.isBuffer(packet)) packet = Buffer.from(packet);
  const segments = [];
  let remaining = packet.length;
  while (remaining >= 255) {
    segments.push(255);
    remaining -= 255;
  }
  segments.push(remaining);
  if (packet.length > 0 && packet.length % 255 === 0) segments.push(0);
  if (segments.length > 255) fail("OGG_PACKET_TOO_LARGE");

  const header = Buffer.alloc(27 + segments.length);
  header.write("OggS", 0, 4, "ascii");
  header[4] = 0;
  header[5] = headerType & 0xff;
  writeUint64LE(header, granulePosition ?? 0n, 6);
  header.writeUInt32LE(serial >>> 0, 14);
  header.writeUInt32LE(sequence >>> 0, 18);
  header.writeUInt32LE(0, 22);
  header[26] = segments.length;
  for (let i = 0; i < segments.length; i += 1) header[27 + i] = segments[i];
  const page = Buffer.concat([header, packet]);
  page.writeUInt32LE(oggCrc(page), 22);
  return page;
}

function buildOggOpus(packets, packetSamples, {
  sourceSha256,
  sampleRate = 48000,
  channels = 1,
  preSkip = 312,
} = {}) {
  if (!Array.isArray(packets) || packets.length < 1) fail("OPUS_PACKET_STREAM_EMPTY");
  if (!Array.isArray(packetSamples) || packetSamples.length !== packets.length) fail("OPUS_PACKET_SAMPLES_INVALID");
  if (![1, 2].includes(channels)) fail("OPUS_CHANNELS_UNSUPPORTED");
  if (!/^[0-9a-f]{64}$/.test(sourceSha256 || "")) fail("OPUS_SOURCE_DIGEST_INVALID");

  const serial = (Number.parseInt(sourceSha256.slice(0, 8), 16) >>> 0) || 1;
  const head = Buffer.alloc(19);
  head.write("OpusHead", 0, 8, "ascii");
  head[8] = 1;
  head[9] = channels;
  head.writeUInt16LE(preSkip, 10);
  head.writeUInt32LE(sampleRate, 12);
  head.writeInt16LE(0, 16);
  head[18] = 0;

  const vendor = Buffer.from("capability-fabric", "utf8");
  const tags = Buffer.alloc(8 + 4 + vendor.length + 4);
  tags.write("OpusTags", 0, 8, "ascii");
  tags.writeUInt32LE(vendor.length, 8);
  vendor.copy(tags, 12);
  tags.writeUInt32LE(0, 12 + vendor.length);

  const pages = [
    oggPage(head, { serial, sequence: 0, granulePosition: 0n, headerType: 0x02 }),
    oggPage(tags, { serial, sequence: 1, granulePosition: 0n, headerType: 0x00 }),
  ];

  let granule = BigInt(preSkip);
  for (let i = 0; i < packets.length; i += 1) {
    const samples = packetSamples[i];
    if (!Number.isInteger(samples) || samples < 1 || samples > 5760) fail("OPUS_PACKET_DURATION_INVALID");
    granule += BigInt(samples);
    pages.push(oggPage(Buffer.from(packets[i], "base64"), {
      serial,
      sequence: i + 2,
      granulePosition: granule,
      headerType: i === packets.length - 1 ? 0x04 : 0x00,
    }));
  }
  return Buffer.concat(pages);
}

export async function transcodeAudioToOggOpus(page, dataBase64, {
  sourceFilename = null,
  maxDurationSeconds = 1800,
  bitrateBps = 128000,
} = {}) {
  if (!page || typeof page.evaluate !== "function") fail("AUDIO_PAGE_INVALID");
  if (typeof dataBase64 !== "string" || !dataBase64) fail("AUDIO_SOURCE_INVALID");
  if (!Number.isFinite(maxDurationSeconds) || maxDurationSeconds < 1 || maxDurationSeconds > 3600) {
    fail("AUDIO_DURATION_LIMIT_INVALID");
  }
  if (!Number.isInteger(bitrateBps) || bitrateBps < 12000 || bitrateBps > 128000) fail("OPUS_BITRATE_INVALID");

  const sourceBytes = Buffer.from(dataBase64, "base64");
  if (!sourceBytes.length) fail("AUDIO_SOURCE_INVALID");
  const digest = createHash("sha256").update(sourceBytes).digest("hex");

  const encoded = await page.evaluate(async ({ dataBase64, maxDurationSeconds, bitrateBps }) => {
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
    const AudioCtx = globalThis.AudioContext || globalThis.webkitAudioContext;
    const OfflineCtx = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
    if (typeof AudioCtx !== "function" || typeof OfflineCtx !== "function") {
      return { ok: false, error: "BROWSER_AUDIO_CODEC_UNAVAILABLE" };
    }
    if (typeof globalThis.AudioEncoder !== "function" || typeof globalThis.AudioData !== "function") {
      return { ok: false, error: "BROWSER_OPUS_ENCODER_UNAVAILABLE" };
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

      const sampleRate = 48000;
      const targetChannels = audio.numberOfChannels === 1 ? 1 : 2;
      const targetLength = Math.ceil(duration * sampleRate);
      const offline = new OfflineCtx(targetChannels, targetLength, sampleRate);
      const sourceNode = offline.createBufferSource();
      sourceNode.buffer = audio;
      sourceNode.connect(offline.destination);
      sourceNode.start(0);
      const rendered = await offline.startRendering();
      const channelData = [];
      for (let channel = 0; channel < targetChannels; channel += 1) {
        channelData.push(rendered.getChannelData(channel));
      }

      const config = { codec: "opus", sampleRate, numberOfChannels: targetChannels, bitrate: bitrateBps };
      const support = await AudioEncoder.isConfigSupported(config).catch(() => null);
      if (!support?.supported) return { ok: false, error: "BROWSER_OPUS_CONFIG_UNSUPPORTED" };

      const packets = [];
      const packetSamples = [];
      let encodeError = null;
      const encoder = new AudioEncoder({
        output: (chunk) => {
          const bytes = new Uint8Array(chunk.byteLength);
          chunk.copyTo(bytes);
          const durationUs = Number(chunk.duration);
          const samples = Number.isFinite(durationUs) && durationUs > 0
            ? Math.max(1, Math.round(durationUs * sampleRate / 1000000))
            : 960;
          packets.push(toBase64(bytes));
          packetSamples.push(samples);
        },
        error: () => { encodeError = "BROWSER_OPUS_ENCODE_FAILED"; },
      });
      encoder.configure(config);

      const frameSize = 960;
      const totalFrames = channelData[0].length;
      for (let offset = 0; offset < totalFrames; offset += frameSize) {
        const count = Math.min(frameSize, totalFrames - offset);
        const frame = new Float32Array(frameSize * targetChannels);
        for (let channel = 0; channel < targetChannels; channel += 1) {
          frame.set(channelData[channel].subarray(offset, offset + count), channel * frameSize);
        }
        const timestamp = Math.round(offset * 1000000 / sampleRate);
        const audioData = new AudioData({
          format: "f32-planar",
          sampleRate,
          numberOfFrames: frameSize,
          numberOfChannels: targetChannels,
          timestamp,
          data: frame,
        });
        encoder.encode(audioData);
        audioData.close();
      }
      await encoder.flush();
      encoder.close();
      if (encodeError) return { ok: false, error: encodeError };
      if (!packets.length) return { ok: false, error: "BROWSER_OPUS_ENCODE_EMPTY" };
      return {
        ok: true,
        packets,
        packet_samples: packetSamples,
        duration_seconds: duration,
        sample_rate: sampleRate,
        channels: targetChannels,
        bitrate_bps: bitrateBps,
      };
    } catch (err) {
      return {
        ok: false,
        error: typeof err?.message === "string" && /opus|audioencoder|audiodata/i.test(err.message)
          ? "BROWSER_OPUS_ENCODE_FAILED"
          : "BROWSER_AUDIO_DECODE_FAILED",
      };
    } finally {
      try { await context?.close?.(); } catch {}
    }
  }, { dataBase64, maxDurationSeconds, bitrateBps });

  if (!encoded?.ok) fail(encoded?.error || "AUDIO_OGG_OPUS_CONVERSION_FAILED");
  const output = buildOggOpus(encoded.packets, encoded.packet_samples, {
    sourceSha256: digest,
    sampleRate: encoded.sample_rate,
    channels: encoded.channels,
  });
  if (!output.length) fail("AUDIO_OGG_OPUS_ENCODE_EMPTY");

  const base = typeof sourceFilename === "string" && sourceFilename.trim()
    ? sourceFilename.replace(/\.[^.]+$/u, "").replace(/[\u0000-\u001f\u007f]/gu, "_").slice(0, 220)
    : "voice";
  return {
    data_base64: output.toString("base64"),
    size_bytes: output.length,
    media_type: "audio/ogg",
    filename: (base || "voice") + ".ogg",
    duration_seconds: encoded.duration_seconds,
    sample_rate: encoded.sample_rate,
    channels: encoded.channels,
    bitrate_bps: encoded.bitrate_bps,
    source_sha256_hex: digest,
  };
}
