FROM python:3.12-slim-bookworm@sha256:392307d22300de8b5986851a12d9176dfc0fc073e65bf6523ebd7dcbeb23564e

ARG FASTER_WHISPER_VERSION=1.2.0
ARG MODEL_REPO=Systran/faster-whisper-small

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PCG_BUILD_MODEL_REPO=$MODEL_REPO \
    PCG_BUILD_FASTER_WHISPER_VERSION=$FASTER_WHISPER_VERSION

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates libgomp1 \
    && rm -rf /var/lib/apt/lists/*

RUN pip install --no-cache-dir "faster-whisper==$FASTER_WHISPER_VERSION" "requests==2.32.3" "av==18.1.0"

WORKDIR /opt/pcg
COPY pcg_asr_runtime.py /opt/pcg/pcg_asr_runtime.py

RUN python - <<'PY'
import hashlib
import json
import os
from pathlib import Path
from huggingface_hub import HfApi, snapshot_download

repo = os.environ["PCG_BUILD_MODEL_REPO"]
version = os.environ["PCG_BUILD_FASTER_WHISPER_VERSION"]
info = HfApi().model_info(repo)
revision = info.sha
root = Path("/models/model")
snapshot_download(repo_id=repo, revision=revision, local_dir=str(root))

digest = hashlib.sha256()
for path in sorted(p for p in root.rglob("*") if p.is_file()):
    rel = path.relative_to(root).as_posix().encode("utf-8")
    digest.update(len(rel).to_bytes(4, "big"))
    digest.update(rel)
    with open(path, "rb") as fh:
        while True:
            chunk = fh.read(1024 * 1024)
            if not chunk:
                break
            digest.update(chunk)

meta = {
    "model_repo": repo,
    "model_revision": revision,
    "model_tree_sha256": digest.hexdigest(),
    "faster_whisper_version": version,
}
Path("/opt/pcg/model-meta.json").write_text(json.dumps(meta, sort_keys=True) + "\n", encoding="utf-8")
PY

RUN python - <<'PY'
import math
import os
import struct
import tempfile
import wave

import av
from faster_whisper import WhisperModel

assert int(av.__version__.split(".", 1)[0]) < 19, av.__version__
model = WhisperModel("/models/model", device="cpu", compute_type="int8", cpu_threads=1, num_workers=1, local_files_only=True)
fd, wav_path = tempfile.mkstemp(suffix=".wav")
os.close(fd)
try:
    with wave.open(wav_path, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(16000)
        frames = bytearray()
        for i in range(16000):
            sample = int(8000 * math.sin(2 * math.pi * 440 * i / 16000))
            frames += struct.pack("<h", sample)
        wf.writeframes(bytes(frames))
    segments, _ = model.transcribe(wav_path, beam_size=1, vad_filter=False)
    list(segments)
finally:
    os.unlink(wav_path)
print("ASR_MODEL_LOAD=pass")
print("ASR_AUDIO_DECODE=pass")
print("ASR_PYAV_VERSION=" + av.__version__)
PY

RUN chmod 0555 /opt/pcg/pcg_asr_runtime.py \
    && chmod -R a+rX /models /opt/pcg

USER 65534:65534
ENTRYPOINT ["python", "/opt/pcg/pcg_asr_runtime.py"]
