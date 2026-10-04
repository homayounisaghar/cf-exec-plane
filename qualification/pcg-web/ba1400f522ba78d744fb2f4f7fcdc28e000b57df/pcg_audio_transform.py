#!/usr/bin/env python3
import hashlib
import json
import os
import re
import secrets
import socketserver
import stat
from pathlib import Path

import av

SOCKET_PATH = os.environ.get("PCG_AUDIO_TRANSFORM_SOCKET", "/run/pcg/audio-transform.sock")
MATERIAL_ROOT = Path(os.environ.get("PCG_AUDIO_TRANSFORM_MATERIAL_ROOT", "/run/pcg/material-files")).resolve()
MAX_SOURCE_BYTES = 2 * 1024 * 1024 * 1024
MAX_DURATION_SECONDS = 3600
TARGET_RATE = 48000
TARGET_BITRATE = 128000
HANDLE_RE = re.compile(r"^pcgfile:([0-9a-f]{64})$")
SHA_RE = re.compile(r"^[0-9a-f]{64}$")


class TransformError(Exception):
    def __init__(self, code):
        super().__init__(code)
        self.code = code


def fail(code):
    raise TransformError(code)


def safe_filename(value):
    if not isinstance(value, str):
        fail("AUDIO_TRANSFORM_FILENAME_INVALID")
    value = value.strip()
    if not value or len(value) > 128 or value in {".", ".."} or any(ord(ch) < 32 for ch in value) or "/" in value or "\\" in value:
        fail("AUDIO_TRANSFORM_FILENAME_INVALID")
    return value


def material_path(handle, filename):
    match = HANDLE_RE.fullmatch(str(handle or "").strip())
    if not match:
        fail("AUDIO_TRANSFORM_MATERIAL_HANDLE_INVALID")
    filename = safe_filename(filename)
    candidate = MATERIAL_ROOT / (match.group(1) + "-" + filename)
    try:
        resolved_parent = candidate.parent.resolve()
    except Exception:
        fail("AUDIO_TRANSFORM_PATH_INVALID")
    if resolved_parent != MATERIAL_ROOT:
        fail("AUDIO_TRANSFORM_PATH_INVALID")
    return candidate


def file_sha256(path):
    digest = hashlib.sha256()
    with path.open("rb", buffering=0) as f:
        while True:
            chunk = f.read(1024 * 1024)
            if not chunk:
                break
            digest.update(chunk)
    return digest.hexdigest()


def codec_available():
    try:
        av.codec.Codec("libopus", "w")
        return True
    except Exception:
        return False


def validate_source(req):
    filename = safe_filename(req.get("filename"))
    path = material_path(req.get("material_file_handle"), filename)
    try:
        st = path.lstat()
    except FileNotFoundError:
        fail("AUDIO_TRANSFORM_SOURCE_NOT_FOUND")
    if not stat.S_ISREG(st.st_mode) or stat.S_ISLNK(st.st_mode):
        fail("AUDIO_TRANSFORM_SOURCE_INVALID")
    size = req.get("size_bytes")
    if not isinstance(size, int) or isinstance(size, bool) or size < 1 or size > MAX_SOURCE_BYTES or st.st_size != size:
        fail("AUDIO_TRANSFORM_SOURCE_SIZE_INVALID")
    expected = str(req.get("sha256_hex") or "").lower()
    if not SHA_RE.fullmatch(expected):
        fail("AUDIO_TRANSFORM_SOURCE_DIGEST_INVALID")
    actual = file_sha256(path)
    if actual != expected:
        fail("AUDIO_TRANSFORM_SOURCE_DIGEST_MISMATCH")
    return path, filename, size, actual


def output_filename(source_filename):
    stem = source_filename.rsplit(".", 1)[0] if "." in source_filename else source_filename
    stem = re.sub(r"[^A-Za-z0-9._ -]", "_", stem).strip(" .")[:116] or "voice"
    return stem + ".ogg"


def transcode(req):
    if not codec_available():
        fail("AUDIO_TRANSFORM_OPUS_ENCODER_UNAVAILABLE")
    source_path, source_filename, source_size, source_sha = validate_source(req)

    bitrate = req.get("bitrate_bps", TARGET_BITRATE)
    if bitrate != TARGET_BITRATE:
        fail("AUDIO_TRANSFORM_BITRATE_POLICY_INVALID")
    sample_rate = req.get("sample_rate", TARGET_RATE)
    if sample_rate != TARGET_RATE:
        fail("AUDIO_TRANSFORM_SAMPLE_RATE_POLICY_INVALID")

    out_name = output_filename(source_filename)
    token = secrets.token_hex(32)
    final_path = MATERIAL_ROOT / (token + "-" + out_name)
    tmp_path = MATERIAL_ROOT / ("." + token + ".transform.ogg")

    input_container = None
    output_container = None
    try:
        input_container = av.open(str(source_path), mode="r")
        audio_streams = [stream for stream in input_container.streams if stream.type == "audio"]
        if not audio_streams:
            fail("AUDIO_TRANSFORM_NO_AUDIO_STREAM")
        in_stream = audio_streams[0]
        channels = int(getattr(in_stream.codec_context, "channels", 0) or 0)
        layout = "mono" if channels == 1 else "stereo"

        output_container = av.open(str(tmp_path), mode="w", format="ogg")
        out_stream = output_container.add_stream("libopus", rate=TARGET_RATE)
        out_stream.bit_rate = TARGET_BITRATE
        out_stream.layout = layout

        resampler = av.audio.resampler.AudioResampler(format="fltp", layout=layout, rate=TARGET_RATE)
        total_samples = 0

        def encode_frame(frame):
            nonlocal total_samples
            total_samples += int(frame.samples)
            if total_samples > MAX_DURATION_SECONDS * TARGET_RATE:
                fail("AUDIO_TRANSFORM_DURATION_OUT_OF_BOUNDS")
            for packet in out_stream.encode(frame):
                output_container.mux(packet)

        for frame in input_container.decode(in_stream):
            converted = resampler.resample(frame)
            if converted is None:
                continue
            if not isinstance(converted, (list, tuple)):
                converted = [converted]
            for item in converted:
                if item is not None:
                    encode_frame(item)

        flushed = resampler.resample(None)
        if flushed is not None:
            if not isinstance(flushed, (list, tuple)):
                flushed = [flushed]
            for item in flushed:
                if item is not None:
                    encode_frame(item)

        for packet in out_stream.encode(None):
            output_container.mux(packet)

        output_container.close()
        output_container = None
        input_container.close()
        input_container = None

        if total_samples < 1:
            fail("AUDIO_TRANSFORM_EMPTY_AUDIO")
        duration = total_samples / TARGET_RATE
        st = tmp_path.lstat()
        if not stat.S_ISREG(st.st_mode) or stat.S_ISLNK(st.st_mode) or st.st_size < 1 or st.st_size > MAX_SOURCE_BYTES:
            fail("AUDIO_TRANSFORM_OUTPUT_INVALID")
        out_sha = file_sha256(tmp_path)
        os.rename(tmp_path, final_path)
        os.chmod(final_path, 0o600)

        return {
            "ok": True,
            "state": "ACHIEVED",
            "engine": "pyav-libopus-file",
            "source_material_file_handle": req.get("material_file_handle"),
            "source_filename": source_filename,
            "source_size_bytes": source_size,
            "source_sha256_hex": source_sha,
            "material_file_handle": "pcgfile:" + token,
            "filename": out_name,
            "media_type": "audio/ogg",
            "size_bytes": final_path.stat().st_size,
            "sha256_hex": out_sha,
            "duration_seconds": duration,
            "sample_rate": TARGET_RATE,
            "channels": 1 if layout == "mono" else 2,
            "bitrate_bps": TARGET_BITRATE,
        }
    except TransformError:
        raise
    except Exception:
        fail("AUDIO_TRANSFORM_FAILED")
    finally:
        try:
            if output_container is not None:
                output_container.close()
        except Exception:
            pass
        try:
            if input_container is not None:
                input_container.close()
        except Exception:
            pass
        try:
            if tmp_path.exists():
                tmp_path.unlink()
        except Exception:
            pass


class Handler(socketserver.StreamRequestHandler):
    def handle(self):
        try:
            line = self.rfile.readline(64 * 1024)
            if not line or len(line) >= 64 * 1024:
                fail("AUDIO_TRANSFORM_REQUEST_INVALID")
            req = json.loads(line.decode("utf-8"))
            op = str(req.get("op") or "")
            if op == "health":
                payload = {
                    "ok": True,
                    "state": "READY" if codec_available() else "NOT_READY",
                    "engine": "pyav-libopus-file",
                    "pyav_version": av.__version__,
                    "opus_encoder": codec_available(),
                    "sample_rate": TARGET_RATE,
                    "bitrate_bps": TARGET_BITRATE,
                    "max_source_bytes": MAX_SOURCE_BYTES,
                    "max_duration_seconds": MAX_DURATION_SECONDS,
                }
                if not payload["opus_encoder"]:
                    payload["ok"] = False
                    payload["error"] = "AUDIO_TRANSFORM_OPUS_ENCODER_UNAVAILABLE"
            elif op == "convert":
                payload = transcode(req)
            else:
                fail("AUDIO_TRANSFORM_OPERATION_INVALID")
        except TransformError as exc:
            payload = {"ok": False, "error": exc.code}
        except Exception:
            payload = {"ok": False, "error": "AUDIO_TRANSFORM_REQUEST_FAILED"}
        self.wfile.write((json.dumps(payload, separators=(",", ":")) + "\n").encode("utf-8"))


def main():
    MATERIAL_ROOT.mkdir(parents=True, exist_ok=True, mode=0o700)
    try:
        os.chmod(MATERIAL_ROOT, 0o700)
    except Exception:
        pass
    socket_path = Path(SOCKET_PATH)
    socket_path.parent.mkdir(parents=True, exist_ok=True)
    try:
        socket_path.unlink()
    except FileNotFoundError:
        pass
    with socketserver.UnixStreamServer(SOCKET_PATH, Handler) as server:
        os.chmod(SOCKET_PATH, 0o660)
        server.serve_forever()


if __name__ == "__main__":
    main()
