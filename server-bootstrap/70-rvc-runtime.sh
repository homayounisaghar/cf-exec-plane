#!/usr/bin/env bash
set -euo pipefail
umask 022

[[ "$(id -u)" -eq 0 ]] || { echo "RVC_RUNTIME_REQUIRES_ROOT" >&2; exit 10; }
RVC_COMMIT="81eed5e8f68b6bed1789f682fe78cdd324495afc"
HUBERT_REVISION="1be9d36ece685661920e1a7cb36eb0437c1e5581"
RMVPE_REVISION="0d7ebae452fb102c695b08f4e6f546be00603425"
HUBERT_SHA256="cc8c20f4b90a520757260197a3ff2505705a7adbd20ad9eeaa4e1a9b38442ef5"
RMVPE_SHA256="6d62215f4306e3ca278246188607209f09af3dc77ed4232efdd069798c4ec193"

root=/var/lib/capability-fabric/rvc
releases="$root/releases"
release="$releases/$RVC_COMMIT"
current="$root/current"
models="$root/models"
incoming="$releases/.incoming-$RVC_COMMIT-$$"
worker_src=server-bootstrap/rvc-worker.py
unit_src=server-bootstrap/capability-fabric-rvc-worker.service
worker_dst=/usr/local/libexec/capability-fabric-rvc-worker
unit_dst=/etc/systemd/system/capability-fabric-rvc-worker.service

[[ -f "$worker_src" && -f "$unit_src" ]] || { echo "RVC_BOOTSTRAP_BUNDLE_INCOMPLETE" >&2; exit 12; }

status_file=/var/lib/capability-fabric/onshape/agent/rvc-bootstrap-status.json
status_file_worker="$root/bootstrap-status.json"
tmpdir=''
CURRENT_STAGE="bootstrap_prepare"
BOOTSTRAP_OK=0
FAIL_DETAIL=''

write_status() {
  local state="$1" stage="$2" detail="${3:-}"
  python3 - "$status_file" "$status_file_worker" "$state" "$stage" "$detail" "$RVC_COMMIT" <<'PY'
import json,os,sys,tempfile
from datetime import datetime,timezone
path,worker_path,state,stage,detail,commit=sys.argv[1:]
payload={
  "schema":"capability-fabric.rvc-bootstrap-status.v1",
  "state":state,
  "stage":stage,
  "detail":detail[:500],
  "rvc_commit":commit,
  "updated_at":datetime.now(timezone.utc).isoformat(),
}
for target in (path,worker_path):
    os.makedirs(os.path.dirname(target),exist_ok=True)
    fd,tmp=tempfile.mkstemp(prefix=".bootstrap-status.",dir=os.path.dirname(target),text=True)
    try:
        with os.fdopen(fd,"w",encoding="utf-8") as out:
            json.dump(payload,out,separators=(",",":"))
            out.write("\n")
        os.chmod(tmp,0o644)
        os.replace(tmp,target)
    finally:
        try:
            if os.path.exists(tmp): os.unlink(tmp)
        except OSError:
            pass
PY
}

cleanup_bootstrap() {
  [[ -z "$tmpdir" ]] || rm -rf "$tmpdir"
  if [[ -n "${incoming:-}" && -e "$incoming" && "$BOOTSTRAP_OK" != 1 ]]; then
    rm -rf "$incoming"
  fi
}

on_exit() {
  local rc=$?
  cleanup_bootstrap
  if [[ "$rc" -ne 0 ]]; then
    if [[ -n "$FAIL_DETAIL" ]]; then
      write_status "FAILED" "$CURRENT_STAGE" "$FAIL_DETAIL exit_code=$rc"
    else
      write_status "FAILED" "$CURRENT_STAGE" "exit_code=$rc"
    fi
  elif [[ "$BOOTSTRAP_OK" != 1 ]]; then
    write_status "FAILED" "$CURRENT_STAGE" "bootstrap exited before ready marker"
  fi
}
trap on_exit EXIT

command -v python3 >/dev/null 2>&1 || { echo "RVC_SYSTEM_PYTHON_REQUIRED" >&2; exit 13; }

if ! id -u cf-rvc >/dev/null 2>&1; then
  useradd --system --home-dir /nonexistent --shell /usr/sbin/nologin cf-rvc
fi
install -d -m 0755 -o root -g root "$root" "$releases"
install -d -m 0750 -o root -g cf-rvc "$models"
install -d -m 0755 -o root -g root /usr/local/libexec
write_status "RUNNING" "$CURRENT_STAGE" "installing supervisor"

install -m 0755 -o root -g root "$worker_src" "$worker_dst"
install -m 0644 -o root -g root "$unit_src" "$unit_dst"
systemctl daemon-reload
systemctl enable capability-fabric-rvc-worker.service >/dev/null
systemctl restart capability-fabric-rvc-worker.service

CURRENT_STAGE="os_check"
write_status "RUNNING" "$CURRENT_STAGE" "validating host OS"
. /etc/os-release
[[ "${ID:-}" == "ubuntu" && "${VERSION_ID:-}" == "24.04" ]] || {
  FAIL_DETAIL="id=${ID:-unknown} version=${VERSION_ID:-unknown}"
  echo "RVC_RUNTIME_UNSUPPORTED_OS $FAIL_DETAIL" >&2
  exit 11
}

CURRENT_STAGE="apt_dependencies"
write_status "RUNNING" "$CURRENT_STAGE" "installing OS prerequisites"
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends \
  ca-certificates curl ffmpeg unzip \
  python3.12 python3.12-venv python3.12-dev \
  libsndfile1 libportaudio2

if [[ -e "$release" ]]; then
  [[ -f "$release/.cf-rvc-runtime.json" ]] || {
    echo "RVC_RELEASE_COLLISION existing release lacks marker" >&2
    exit 20
  }
else
  CURRENT_STAGE="rvc_source"
  write_status "RUNNING" "$CURRENT_STAGE" "downloading pinned RVC source"
  rm -rf "$incoming"
  install -d -m 0755 -o root -g root "$incoming"
  tmpdir="$(mktemp -d)"

  curl -fL --retry 5 --retry-delay 2 --connect-timeout 15 \
    "https://codeload.github.com/RVC-Project/Retrieval-based-Voice-Conversion-WebUI/tar.gz/$RVC_COMMIT" \
    -o "$tmpdir/rvc.tar.gz"
  tar -xzf "$tmpdir/rvc.tar.gz" --strip-components=1 -C "$incoming"
  [[ -f "$incoming/infer/cli.py" && -f "$incoming/requirments_cpu_py312.txt" ]] || {
    echo "RVC_SOURCE_LAYOUT_INVALID" >&2
    exit 21
  }

  CURRENT_STAGE="python_environment"
  write_status "RUNNING" "$CURRENT_STAGE" "creating pinned CPU Python environment"
  python3.12 -m venv "$incoming/.venv"
  "$incoming/.venv/bin/python" -m pip install --upgrade "pip>=24,<26" "setuptools>=75,<81" "wheel>=0.45,<1"

  cp "$incoming/requirments_cpu_py312.txt" "$tmpdir/requirements.txt"
  sed -i \
    -e 's#https://mirrors.pku.edu.cn/pypi/simple#https://pypi.org/simple#g' \
    -e 's#https://mirrors.nju.edu.cn/pytorch/whl/cpu#https://download.pytorch.org/whl/cpu#g' \
    "$tmpdir/requirements.txt"
  "$incoming/.venv/bin/python" -m pip install --no-cache-dir -r "$tmpdir/requirements.txt"

  CURRENT_STAGE="inference_assets"
  write_status "RUNNING" "$CURRENT_STAGE" "downloading pinned HuBERT and RMVPE assets"
  install -d -m 0755 "$incoming/assets/hubert_base" "$incoming/assets/rmvpe"
  curl -fL --retry 5 --retry-delay 2 --connect-timeout 15 \
    "https://huggingface.co/lj1995/VoiceConversionWebUI/resolve/$HUBERT_REVISION/hubert_base/config.json" \
    -o "$incoming/assets/hubert_base/config.json"
  curl -fL --retry 5 --retry-delay 2 --connect-timeout 15 \
    "https://huggingface.co/lj1995/VoiceConversionWebUI/resolve/$HUBERT_REVISION/hubert_base/preprocessor_config.json" \
    -o "$incoming/assets/hubert_base/preprocessor_config.json"
  curl -fL --retry 5 --retry-delay 2 --connect-timeout 15 \
    "https://huggingface.co/lj1995/VoiceConversionWebUI/resolve/$HUBERT_REVISION/hubert_base/pytorch_model.bin" \
    -o "$incoming/assets/hubert_base/pytorch_model.bin"
  printf '%s  %s\n' "$HUBERT_SHA256" "$incoming/assets/hubert_base/pytorch_model.bin" | sha256sum -c -

  curl -fL --retry 5 --retry-delay 2 --connect-timeout 15 \
    "https://huggingface.co/lj1995/VoiceConversionWebUI/resolve/$RMVPE_REVISION/rmvpe.pt" \
    -o "$incoming/assets/rmvpe/rmvpe.pt"
  printf '%s  %s\n' "$RMVPE_SHA256" "$incoming/assets/rmvpe/rmvpe.pt" | sha256sum -c -

  (
    cd "$incoming"
    "$incoming/.venv/bin/python" - <<'PY'
import importlib.metadata as m
import json
print(json.dumps({
  "python_ok": True,
  "torch": m.version("torch"),
  "faiss_cpu": m.version("faiss-cpu"),
  "transformers": m.version("transformers"),
}))
PY
  )

  CURRENT_STAGE="runtime_finalize"
  write_status "RUNNING" "$CURRENT_STAGE" "finalizing immutable runtime release"
  cat > "$incoming/.cf-rvc-runtime.json" <<EOF
{
  "schema": "capability-fabric.rvc-runtime.v1",
  "rvc_commit": "$RVC_COMMIT",
  "hubert_revision": "$HUBERT_REVISION",
  "hubert_sha256": "$HUBERT_SHA256",
  "rmvpe_revision": "$RMVPE_REVISION",
  "rmvpe_sha256": "$RMVPE_SHA256"
}
EOF
  chown -R root:root "$incoming"
  chmod -R go-w "$incoming"
  mv "$incoming" "$release"
  tmpdir=''
fi

CURRENT_STAGE="runtime_activate"
write_status "RUNNING" "$CURRENT_STAGE" "activating pinned runtime"
ln -sfn "$release" "$current"
systemctl restart capability-fabric-rvc-worker.service

CURRENT_STAGE="runtime_verify"
write_status "RUNNING" "$CURRENT_STAGE" "verifying loopback supervisor and runtime"
status=''
for _ in $(seq 1 60); do
  status="$(curl -fsS --max-time 3 http://127.0.0.1:8794/status 2>/dev/null || true)"
  if [[ -n "$status" ]] && python3 - "$status" "$RVC_COMMIT" <<'PY'
import json,sys
o=json.loads(sys.argv[1])
assert o.get("runtime_ready") is True
assert o.get("rvc_commit")==sys.argv[2]
assert o.get("concurrency_limit")==1
PY
  then
    break
  fi
  sleep 1
done
[[ -n "$status" ]] || { echo "RVC_WORKER_STATUS_UNAVAILABLE" >&2; exit 30; }
python3 - "$status" "$RVC_COMMIT" <<'PY'
import json,sys
o=json.loads(sys.argv[1])
assert o.get("runtime_ready") is True
assert o.get("rvc_commit")==sys.argv[2]
assert o.get("concurrency_limit")==1
print("CF_RVC_STATUS="+json.dumps(o,separators=(",",":")))
PY

systemctl is-active --quiet capability-fabric-rvc-worker.service
ss -lnt | awk '$4=="127.0.0.1:8794"{ok=1} END{exit ok?0:1}'
if ss -lnt | awk '$4 ~ /^(0\.0\.0\.0|\[::\]|\*):8794$/ {bad=1} END{exit bad?0:1}'; then
  echo "RVC_WORKER_EXPOSED_BEYOND_LOOPBACK" >&2
  exit 31
fi

CURRENT_STAGE="complete"
write_status "READY" "$CURRENT_STAGE" "runtime ready; owner model intentionally separate"
BOOTSTRAP_OK=1
printf 'CF_RVC_RUNTIME=ready\n'
printf 'CF_RVC_COMMIT=%s\n' "$RVC_COMMIT"
printf 'CF_RVC_LOOPBACK_ONLY=pass\n'
