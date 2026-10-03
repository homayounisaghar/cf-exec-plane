#!/usr/bin/env python3
import hashlib
import json
import os
import queue
import re
import socket
import stat
import threading
import time
from pathlib import Path

import av
from faster_whisper import WhisperModel

SOCKET_PATH = os.environ.get("PCG_ASR_SOCKET", "/run/pcg/asr.sock")
MATERIAL_ROOT = Path(os.environ.get("PCG_ASR_MATERIAL_ROOT", "/run/pcg/material-files")).resolve()
STATE_ROOT = Path(os.environ.get("PCG_ASR_STATE_ROOT", "/state")).resolve()
MODEL_PATH = os.environ.get("PCG_ASR_MODEL_PATH", "/models/model")
MODEL_META_PATH = os.environ.get("PCG_ASR_MODEL_META", "/opt/pcg/model-meta.json")
CPU_THREADS = max(1, min(8, int(os.environ.get("PCG_ASR_CPU_THREADS", "1"))))
MAX_SOURCE_BYTES = 2 * 1024 * 1024 * 1024
HANDLE_RE = re.compile(r"^pcgfile:([0-9a-f]{64})$")
SHA_RE = re.compile(r"^[0-9a-f]{64}$")
JOB_RE = re.compile(r"^[0-9a-f]{64}$")

STATE_ROOT.mkdir(parents=True, exist_ok=True)
JOBS_ROOT = STATE_ROOT / "jobs"
JOBS_ROOT.mkdir(parents=True, exist_ok=True)

with open(MODEL_META_PATH, "r", encoding="utf-8") as fh:
    MODEL_META = json.load(fh)

MODEL_ID = str(MODEL_META.get("model_repo") or "unknown")
MODEL_REVISION = str(MODEL_META.get("model_revision") or "unknown")
MODEL_TREE_SHA256 = str(MODEL_META.get("model_tree_sha256") or "unknown")
ENGINE_ID = "faster-whisper"
ENGINE_VERSION = str(MODEL_META.get("faster_whisper_version") or "unknown")
DECODER_ID = "pyav"
DECODER_VERSION = str(av.__version__)
JOB_SCHEMA = 2

_jobs = {}
_jobs_lock = threading.RLock()
_work = queue.Queue()
_enqueued = set()
_active_job_id = None


def now_ms():
    return int(time.time() * 1000)


def atomic_json(path, value):
    tmp = path.with_name(path.name + ".tmp-" + str(os.getpid()))
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(value, fh, ensure_ascii=False, separators=(",", ":"))
        fh.write("\n")
        fh.flush()
        os.fsync(fh.fileno())
    os.replace(tmp, path)
    os.chmod(path, 0o600)


def job_path(job_id):
    return JOBS_ROOT / (job_id + ".json")


def persist(job):
    atomic_json(job_path(job["job_id"]), job)


def public_job(job, cache_hit=False):
    return {
        "ok": True,
        "job_id": job["job_id"],
        "state": job["state"],
        "cache_hit": bool(cache_hit),
        "source_sha256": job["source_sha256"],
        "source_size_bytes": job["source_size_bytes"],
        "language_requested": job.get("language_requested"),
        "language_detected": job.get("language_detected"),
        "language_probability": job.get("language_probability"),
        "text": job.get("text") or "",
        "segments": job.get("segments") or [],
        "duration_seconds": job.get("duration_seconds"),
        "inference_ms": job.get("inference_ms"),
        "engine_id": ENGINE_ID,
        "engine_version": ENGINE_VERSION,
        "decoder_id": DECODER_ID,
        "decoder_version": DECODER_VERSION,
        "job_schema": JOB_SCHEMA,
        "model_id": MODEL_ID,
        "model_revision": MODEL_REVISION,
        "model_tree_sha256": MODEL_TREE_SHA256,
        "error": job.get("error"),
    }


def validate_material(handle, filename, size_bytes, source_sha256):
    match = HANDLE_RE.fullmatch(str(handle or ""))
    if not match:
        raise ValueError("ASR_MATERIAL_HANDLE_INVALID")
    if not isinstance(filename, str) or not filename or len(filename) > 512:
        raise ValueError("ASR_FILENAME_INVALID")
    if filename in (".", "..") or "/" in filename or "\\" in filename or "\x00" in filename:
        raise ValueError("ASR_FILENAME_INVALID")
    if not isinstance(size_bytes, int) or size_bytes < 1 or size_bytes > MAX_SOURCE_BYTES:
        raise ValueError("ASR_SOURCE_SIZE_INVALID")
    if not isinstance(source_sha256, str) or not SHA_RE.fullmatch(source_sha256):
        raise ValueError("ASR_SOURCE_DIGEST_INVALID")
    path = (MATERIAL_ROOT / (match.group(1) + "-" + filename)).resolve()
    if path.parent != MATERIAL_ROOT:
        raise ValueError("ASR_MATERIAL_PATH_INVALID")
    st = path.lstat()
    if not stat.S_ISREG(st.st_mode) or stat.S_ISLNK(st.st_mode):
        raise ValueError("ASR_MATERIAL_ENTRY_INVALID")
    if st.st_size != size_bytes:
        raise ValueError("ASR_SOURCE_SIZE_MISMATCH")
    digest = hashlib.sha256()
    with open(path, "rb") as fh:
        while True:
            chunk = fh.read(1024 * 1024)
            if not chunk:
                break
            digest.update(chunk)
    if digest.hexdigest() != source_sha256:
        raise ValueError("ASR_SOURCE_DIGEST_MISMATCH")
    return path


def normalize_language(value):
    if value is None or value == "":
        return None
    if not isinstance(value, str):
        raise ValueError("ASR_LANGUAGE_INVALID")
    value = value.strip().lower()
    if not re.fullmatch(r"[a-z]{2,3}", value):
        raise ValueError("ASR_LANGUAGE_INVALID")
    return value


def job_key(source_sha256, language):
    payload = json.dumps({
        "source_sha256": source_sha256,
        "engine_id": ENGINE_ID,
        "engine_version": ENGINE_VERSION,
        "decoder_id": DECODER_ID,
        "decoder_version": DECODER_VERSION,
        "job_schema": JOB_SCHEMA,
        "model_revision": MODEL_REVISION,
        "model_tree_sha256": MODEL_TREE_SHA256,
        "language": language,
        "vad": True,
        "beam_size": 5,
    }, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(payload).hexdigest()


def enqueue(job_id):
    with _jobs_lock:
        if job_id in _enqueued:
            return
        _enqueued.add(job_id)
        _work.put(job_id)


def start_job(request):
    language = normalize_language(request.get("language"))
    source_sha256 = str(request.get("sha256_hex") or "").lower()
    path = validate_material(
        request.get("material_file_handle"),
        request.get("filename"),
        request.get("size_bytes"),
        source_sha256,
    )
    job_id = job_key(source_sha256, language)
    with _jobs_lock:
        existing = _jobs.get(job_id)
        if existing:
            return public_job(existing, cache_hit=existing.get("state") == "SUCCEEDED")
        job = {
            "job_id": job_id,
            "state": "QUEUED",
            "source_sha256": source_sha256,
            "source_size_bytes": int(request["size_bytes"]),
            "source_path": str(path),
            "source_filename": request["filename"],
            "language_requested": language,
            "language_detected": None,
            "language_probability": None,
            "text": "",
            "segments": [],
            "duration_seconds": None,
            "inference_ms": None,
            "error": None,
            "created_at_ms": now_ms(),
            "started_at_ms": None,
            "completed_at_ms": None,
        }
        _jobs[job_id] = job
        persist(job)
        enqueue(job_id)
        return public_job(job)


def status_job(request):
    job_id = str(request.get("job_id") or "").lower()
    if not JOB_RE.fullmatch(job_id):
        raise ValueError("ASR_JOB_ID_INVALID")
    with _jobs_lock:
        job = _jobs.get(job_id)
        if not job:
            raise ValueError("ASR_JOB_NOT_FOUND")
        return public_job(job, cache_hit=job.get("state") == "SUCCEEDED")


def load_jobs():
    for path in JOBS_ROOT.glob("*.json"):
        try:
            with open(path, "r", encoding="utf-8") as fh:
                job = json.load(fh)
            job_id = str(job.get("job_id") or "")
            if not JOB_RE.fullmatch(job_id):
                continue
            source = Path(str(job.get("source_path") or ""))
            if job.get("state") in ("RUNNING", "QUEUED"):
                if source.is_file():
                    job["state"] = "QUEUED"
                    job["error"] = None
                    persist(job)
                else:
                    job["state"] = "FAILED"
                    job["error"] = "ASR_SOURCE_MISSING_AFTER_RESTART"
                    job["completed_at_ms"] = now_ms()
                    persist(job)
            _jobs[job_id] = job
        except Exception:
            continue
    for job_id, job in list(_jobs.items()):
        if job.get("state") == "QUEUED":
            enqueue(job_id)


def worker_loop(model):
    global _active_job_id
    while True:
        job_id = _work.get()
        with _jobs_lock:
            _enqueued.discard(job_id)
            job = _jobs.get(job_id)
            if not job or job.get("state") != "QUEUED":
                _work.task_done()
                continue
            job["state"] = "RUNNING"
            job["started_at_ms"] = now_ms()
            job["error"] = None
            persist(job)
            _active_job_id = job_id

        started = time.monotonic()
        try:
            segments_iter, info = model.transcribe(
                job["source_path"],
                language=job.get("language_requested"),
                task="transcribe",
                beam_size=5,
                vad_filter=True,
                vad_parameters={"min_silence_duration_ms": 500},
                condition_on_previous_text=True,
                word_timestamps=False,
            )
            segments = []
            text_parts = []
            for segment in segments_iter:
                text = str(segment.text or "").strip()
                if text:
                    text_parts.append(text)
                segments.append({
                    "start": round(float(segment.start), 3),
                    "end": round(float(segment.end), 3),
                    "text": text,
                })
            text = " ".join(text_parts).strip()
            if not text:
                raise RuntimeError("ASR_EMPTY_TRANSCRIPT")
            with _jobs_lock:
                job["state"] = "SUCCEEDED"
                job["text"] = text
                job["segments"] = segments
                job["duration_seconds"] = round(float(getattr(info, "duration", 0.0) or 0.0), 3)
                job["language_detected"] = str(getattr(info, "language", "") or "") or None
                probability = getattr(info, "language_probability", None)
                job["language_probability"] = round(float(probability), 6) if probability is not None else None
                job["inference_ms"] = int((time.monotonic() - started) * 1000)
                job["completed_at_ms"] = now_ms()
                job["error"] = None
                persist(job)
        except Exception as exc:
            code = str(exc)[:240] or exc.__class__.__name__
            with _jobs_lock:
                job["state"] = "FAILED"
                job["error"] = code
                job["inference_ms"] = int((time.monotonic() - started) * 1000)
                job["completed_at_ms"] = now_ms()
                persist(job)
        finally:
            with _jobs_lock:
                _active_job_id = None
            _work.task_done()


def health():
    with _jobs_lock:
        return {
            "ok": True,
            "state": "READY",
            "engine_id": ENGINE_ID,
            "engine_version": ENGINE_VERSION,
            "decoder_id": DECODER_ID,
            "decoder_version": DECODER_VERSION,
            "job_schema": JOB_SCHEMA,
            "model_id": MODEL_ID,
            "model_revision": MODEL_REVISION,
            "model_tree_sha256": MODEL_TREE_SHA256,
            "cpu_threads": CPU_THREADS,
            "active_job_id": _active_job_id,
            "queued_jobs": _work.qsize(),
            "jobs_known": len(_jobs),
        }


def dispatch(request):
    op = str(request.get("op") or "")
    if op == "health":
        return health()
    if op == "transcribe.start":
        return start_job(request)
    if op == "transcribe.status":
        return status_job(request)
    raise ValueError("ASR_OPERATION_UNSUPPORTED")


def handle_connection(conn):
    try:
        conn.settimeout(10)
        buf = b""
        while b"\n" not in buf:
            chunk = conn.recv(65536)
            if not chunk:
                break
            buf += chunk
            if len(buf) > 1024 * 1024:
                raise ValueError("ASR_REQUEST_TOO_LARGE")
        if b"\n" not in buf:
            raise ValueError("ASR_REQUEST_INCOMPLETE")
        request = json.loads(buf.split(b"\n", 1)[0].decode("utf-8"))
        result = dispatch(request)
    except Exception as exc:
        result = {"ok": False, "error": str(exc)[:240] or exc.__class__.__name__}
    try:
        conn.sendall((json.dumps(result, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8"))
    finally:
        try:
            conn.close()
        except Exception:
            pass


def main():
    global _model
    MATERIAL_ROOT.mkdir(parents=True, exist_ok=True)
    load_jobs()
    _model = WhisperModel(
        MODEL_PATH,
        device="cpu",
        compute_type="int8",
        cpu_threads=CPU_THREADS,
        num_workers=1,
        local_files_only=True,
    )
    threading.Thread(target=worker_loop, args=(_model,), daemon=True).start()

    socket_path = Path(SOCKET_PATH)
    socket_path.parent.mkdir(parents=True, exist_ok=True)
    try:
        socket_path.unlink()
    except FileNotFoundError:
        pass
    server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    server.bind(SOCKET_PATH)
    os.chmod(SOCKET_PATH, 0o660)
    server.listen(16)
    while True:
        conn, _ = server.accept()
        threading.Thread(target=handle_connection, args=(conn,), daemon=True).start()


if __name__ == "__main__":
    main()
