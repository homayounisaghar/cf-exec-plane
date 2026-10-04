#!/usr/bin/env python3
import hashlib
import json
import os
import subprocess
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

HOST = os.environ.get("CF_RVC_HOST", "127.0.0.1")
PORT = int(os.environ.get("CF_RVC_PORT", "8794"))
RVC_ROOT = Path(os.environ.get("CF_RVC_ROOT", "/var/lib/capability-fabric/rvc/current"))
MODEL = Path(os.environ.get("CF_RVC_MODEL", "/var/lib/capability-fabric/rvc/models/owner.pth"))
INDEX = Path(os.environ.get("CF_RVC_INDEX", "/var/lib/capability-fabric/rvc/models/owner.index"))
BOOTSTRAP_STATUS = Path(os.environ.get("CF_RVC_BOOTSTRAP_STATUS", "/var/lib/capability-fabric/rvc/bootstrap-status.json"))
MAX_INPUT = 64 * 1024 * 1024
MAX_OUTPUT = 64 * 1024 * 1024
TIMEOUT_SECONDS = 20 * 60
LOCK = threading.Lock()

RVC_COMMIT = "81eed5e8f68b6bed1789f682fe78cdd324495afc"
HUBERT_REVISION = "1be9d36ece685661920e1a7cb36eb0437c1e5581"
RMVPE_REVISION = "0d7ebae452fb102c695b08f4e6f546be00603425"

def bootstrap_status():
    try:
        value = json.loads(BOOTSTRAP_STATUS.read_text(encoding="utf-8"))
        return value if isinstance(value, dict) else None
    except Exception:
        return None

def runtime_versions(python_path):
    if not python_path.is_file():
        return {"python": None, "torch": None, "faiss_cpu": None}
    code = (
        "import importlib.metadata as m,json,sys;"
        "get=lambda n: (m.version(n) if True else None);"
        "print(json.dumps({'python':sys.version.split()[0],"
        "'torch':get('torch'),'faiss_cpu':get('faiss-cpu')}))"
    )
    try:
        proc = subprocess.run(
            [str(python_path), "-c", code],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            timeout=8,
            check=False,
        )
        if proc.returncode != 0:
            return {"python": None, "torch": None, "faiss_cpu": None}
        value = json.loads(proc.stdout.decode("utf-8", "replace"))
        return value if isinstance(value, dict) else {"python": None, "torch": None, "faiss_cpu": None}
    except Exception:
        return {"python": None, "torch": None, "faiss_cpu": None}

def runtime_status():
    runtime_python = RVC_ROOT / ".venv" / "bin" / "python"
    required = [
        runtime_python,
        RVC_ROOT / "infer" / "cli.py",
        RVC_ROOT / "assets" / "hubert_base" / "config.json",
        RVC_ROOT / "assets" / "hubert_base" / "preprocessor_config.json",
        RVC_ROOT / "assets" / "hubert_base" / "pytorch_model.bin",
        RVC_ROOT / "assets" / "rmvpe" / "rmvpe.pt",
        RVC_ROOT / ".cf-rvc-runtime.json",
    ]
    runtime_ready = all(p.is_file() for p in required)
    versions = runtime_versions(runtime_python) if runtime_ready else {"python": None, "torch": None, "faiss_cpu": None}
    return {
        "state": "READY" if runtime_ready and MODEL.is_file() else "NOT_READY",
        "engine": "RVC",
        "worker_reachable": True,
        "runtime_ready": runtime_ready,
        "model_ready": MODEL.is_file(),
        "index_ready": INDEX.is_file(),
        "busy": LOCK.locked(),
        "concurrency_limit": 1,
        "rvc_commit": RVC_COMMIT,
        "hubert_revision": HUBERT_REVISION,
        "rmvpe_revision": RMVPE_REVISION,
        "python": versions.get("python"),
        "torch": versions.get("torch"),
        "faiss_cpu": versions.get("faiss_cpu"),
        "bootstrap": bootstrap_status(),
    }

def json_bytes(payload):
    return json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")

class Handler(BaseHTTPRequestHandler):
    server_version = "CapabilityFabricRVC/1"

    def log_message(self, fmt, *args):
        sys.stderr.write("rvc-worker: " + (fmt % args) + "\n")

    def send_json(self, status, payload):
        body = json_bytes(payload)
        self.send_response(status)
        self.send_header("content-type", "application/json; charset=utf-8")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path != "/status":
            self.send_json(404, {"error": "NOT_FOUND"})
            return
        self.send_json(200, runtime_status())

    def do_POST(self):
        parsed = urlparse(self.path)
        if parsed.path != "/convert":
            self.send_json(404, {"error": "NOT_FOUND"})
            return

        status = runtime_status()
        if not status["runtime_ready"]:
            self.send_json(503, {"error": "RVC_RUNTIME_NOT_INSTALLED", **status})
            return
        if not status["model_ready"]:
            self.send_json(409, {"error": "MODEL_NOT_INSTALLED", **status})
            return

        try:
            length = int(self.headers.get("content-length", ""))
        except Exception:
            length = -1
        if length < 1 or length > MAX_INPUT:
            self.send_json(413, {"error": "VOICE_CONVERT_SOURCE_SIZE_INVALID", "max_bytes": MAX_INPUT})
            return

        qs = parse_qs(parsed.query, keep_blank_values=False)
        try:
            pitch = int(qs.get("pitch", ["0"])[0])
            index_rate = float(qs.get("index_rate", ["0.75"])[0])
            output_format = qs.get("format", ["mp3"])[0].lower()
        except Exception:
            self.send_json(400, {"error": "VOICE_CONVERT_ARGUMENTS_INVALID"})
            return
        if pitch < -12 or pitch > 12 or not (0.0 <= index_rate <= 1.0) or output_format not in {"mp3", "wav"}:
            self.send_json(400, {"error": "VOICE_CONVERT_ARGUMENTS_INVALID"})
            return
        if index_rate > 0 and not INDEX.is_file():
            self.send_json(409, {"error": "INDEX_NOT_INSTALLED", **status})
            return
        if not LOCK.acquire(blocking=False):
            self.send_json(409, {"error": "VOICE_CONVERT_BUSY"})
            return

        started = time.monotonic()
        try:
            source = self.rfile.read(length)
            if len(source) != length:
                self.send_json(400, {"error": "VOICE_CONVERT_SOURCE_TRUNCATED"})
                return
            source_sha = hashlib.sha256(source).hexdigest()

            with tempfile.TemporaryDirectory(prefix="cf-rvc-") as td:
                work = Path(td)
                input_path = work / "input.audio"
                output_path = work / ("converted." + output_format)
                input_path.write_bytes(source)

                runtime_python = RVC_ROOT / ".venv" / "bin" / "python"
                cmd = [
                    str(runtime_python),
                    str(RVC_ROOT / "infer" / "cli.py"),
                    "--model", str(MODEL),
                    "--input", str(input_path),
                    "--output", str(output_path),
                    "--pitch", str(pitch),
                    "--f0-method", "rmvpe",
                    "--index-rate", str(index_rate),
                    "--overwrite",
                ]
                if INDEX.is_file():
                    cmd += ["--index", str(INDEX)]

                env = dict(os.environ)
                env.update({
                    "OPENBLAS_NUM_THREADS": "1",
                    "OMP_NUM_THREADS": "1",
                    "MKL_NUM_THREADS": "1",
                    "RVC_AUDIO_FORCE_CPU": "1",
                    "RVC_CUDA_GRAPH": "0",
                    "PYTHONUNBUFFERED": "1",
                })
                try:
                    proc = subprocess.run(
                        cmd,
                        cwd=str(RVC_ROOT),
                        env=env,
                        stdin=subprocess.DEVNULL,
                        stdout=subprocess.PIPE,
                        stderr=subprocess.PIPE,
                        timeout=TIMEOUT_SECONDS,
                        check=False,
                    )
                except subprocess.TimeoutExpired:
                    self.send_json(504, {"error": "VOICE_CONVERT_TIMEOUT"})
                    return

                if proc.returncode != 0:
                    detail = proc.stderr.decode("utf-8", "replace")[-4000:]
                    self.send_json(500, {"error": "RVC_INFERENCE_FAILED", "exit_code": proc.returncode, "detail": detail})
                    return
                if not output_path.is_file():
                    self.send_json(500, {"error": "RVC_OUTPUT_MISSING"})
                    return
                output = output_path.read_bytes()
                if len(output) < 1 or len(output) > MAX_OUTPUT:
                    self.send_json(500, {"error": "RVC_OUTPUT_SIZE_INVALID", "max_bytes": MAX_OUTPUT})
                    return

            elapsed_ms = int((time.monotonic() - started) * 1000)
            self.send_response(200)
            self.send_header("content-type", "audio/mpeg" if output_format == "mp3" else "audio/wav")
            self.send_header("content-length", str(len(output)))
            self.send_header("x-cf-rvc-source-sha256", source_sha)
            self.send_header("x-cf-rvc-output-sha256", hashlib.sha256(output).hexdigest())
            self.send_header("x-cf-rvc-elapsed-ms", str(elapsed_ms))
            self.send_header("x-cf-rvc-index-used", "1" if INDEX.is_file() and index_rate > 0 else "0")
            self.end_headers()
            self.wfile.write(output)
        finally:
            LOCK.release()

def main():
    if HOST != "127.0.0.1" or PORT != 8794:
        raise SystemExit("refusing unexpected RVC worker endpoint")
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    server.daemon_threads = True
    print(json.dumps({"event": "rvc_worker_listening", "host": HOST, "port": PORT, **runtime_status()}), flush=True)
    server.serve_forever()

if __name__ == "__main__":
    main()
