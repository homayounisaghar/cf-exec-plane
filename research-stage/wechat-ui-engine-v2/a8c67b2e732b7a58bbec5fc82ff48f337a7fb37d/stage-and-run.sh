#!/bin/sh
# Public secret-free WeChat v3 research staging; ONLY runtime, NO GUI interaction.
set -eu
umask 077
SOURCE_COMMIT=50ad0fd729f217e0ccf77b47330061e87741a5d3
STAGE_FOLDER=research-stage/wechat-ui-engine-v2/a8c67b2e732b7a58bbec5fc82ff48f337a7fb37d
MANIFEST_SHA=b9bcca6438fb5b9435f4504ac06a23f82ba69200
BASE="https://raw.githubusercontent.com/homayounisaghar/cf-exec-plane/$SOURCE_COMMIT/$STAGE_FOLDER"
[ "$(id -u)" -eq 1000 ] || { echo 'STAGE_WRONG_UID'; exit 2; }
[ "${1:-}" = "--stage-only" ] || { echo 'STAGE_ONLY_MODE_REQUIRED'; exit 2; }
[ -z "${WX_GATE_H_SEND_ONCE:-}" ] && [ -z "${WX_GATE_H_TEXT:-}" ] || {
  echo 'SEND_ENV_FORBIDDEN'; exit 2;
}
command -v curl >/dev/null && command -v git >/dev/null || {
  echo 'STAGING_TOOLS_MISSING'; exit 2;
}
scratch=$(mktemp -d /tmp/wx-v3-stage.XXXXXXXX)
trap 'rm -rf "$scratch"' EXIT HUP INT TERM
curl -fsSL --connect-timeout 8 --max-time 45 "$BASE/MANIFEST" -o "$scratch/MANIFEST"
[ "$(git hash-object "$scratch/MANIFEST")" = "$MANIFEST_SHA" ] || {
  echo 'MANIFEST_BLOB_MISMATCH'; exit 2;
}
n=0
while read -r sha filename extra || [ -n "${sha:-}" ]; do
  case "$sha" in ""|\#*) continue;; esac
  case "$filename" in
    engine.py|atspi_backend.py|ui_primitives.py|benchmark_gate_f_readsafe.py|pointer_mapping.py|x11_modal_guard.py|popup_closure.py|gate_click_accuracy.py|wechat_ui_ladder_v3.py|with_wechat_env.sh) ;;
    *) echo 'UNAUTHORIZED_FILE_NAME'; exit 2;;
  esac
  [ -z "${extra:-}" ] && [ ! -e "$scratch/$filename" ] || {
    echo 'DUPLICATE_OR_INVALID_ENTRY'; exit 2;
  }
  curl -fsSL --connect-timeout 8 --max-time 45 "$BASE/$filename" -o "$scratch/$filename"
  [ "$(git hash-object "$scratch/$filename")" = "$sha" ] || {
    echo 'RUNTIME_BLOB_MISMATCH'; exit 2;
  }
  n=$((n+1))
done < "$scratch/MANIFEST"
[ "$n" -eq 10 ] || { echo 'WRONG_RUNTIME_COUNT'; exit 2; }
[ -d /tmp/wxeng ] && [ ! -L /tmp/wxeng ] && [ "$(stat -c '%u' /tmp/wxeng)" -eq "$(id -u)" ] || {
  echo 'RUNTIME_STAGE_DIR_UNSAFE'; exit 2;
}
for file in engine.py atspi_backend.py ui_primitives.py benchmark_gate_f_readsafe.py pointer_mapping.py x11_modal_guard.py popup_closure.py gate_click_accuracy.py wechat_ui_ladder_v3.py with_wechat_env.sh; do
  [ ! -L "/tmp/wxeng/$file" ] || { echo 'TARGET_SYMLINK_REFUSED'; exit 2; }
  install -m 0600 "$scratch/$file" "/tmp/wxeng/$file"
done
cd /tmp/wxeng
python3 -m py_compile engine.py atspi_backend.py ui_primitives.py benchmark_gate_f_readsafe.py pointer_mapping.py x11_modal_guard.py popup_closure.py gate_click_accuracy.py wechat_ui_ladder_v3.py || {
  echo 'RUNTIME_PY_COMPILE_FAIL'; exit 2;
}
echo 'WX_V3_RUNTIME_STAGED verified_blobs=10 no_tests_published=True no_send=True no_keys=True'
