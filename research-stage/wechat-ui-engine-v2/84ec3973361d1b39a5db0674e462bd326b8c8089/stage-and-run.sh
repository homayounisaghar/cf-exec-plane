#!/bin/sh
# Immutable runtime-only WeChat chooser qualification staging, NO UI action.
set -eu
umask 077
BASE="https://raw.githubusercontent.com/homayounisaghar/cf-exec-plane/d75f7e576ea19c45765f498be5455e46325b5013/research-stage/wechat-ui-engine-v2/84ec3973361d1b39a5db0674e462bd326b8c8089"
EXPECTED_MANIFEST="e8214df3d73ce02893b91dbb7545c4392ab121e2"
[ "$(id -u)" -eq 1000 ] || { echo WRONG_UID; exit 2; }
[ "${1:-}" = "--stage-only" ] || { echo STAGE_ONLY_REQUIRED; exit 2; }
[ -z "${WX_GATE_H_SEND_ONCE:-}" ] && [ -z "${WX_GATE_H_TEXT:-}" ] || {
 echo SEND_FLAGS_FORBIDDEN; exit 2;
}
tmp=$(mktemp -d /tmp/wx-file-stage.XXXXXXXX)
trap 'rm -rf "$tmp"' EXIT HUP INT TERM
curl -fsSL --connect-timeout 8 --max-time 40 "$BASE/MANIFEST" -o "$tmp/MANIFEST"
[ "$(git hash-object "$tmp/MANIFEST")" = "$EXPECTED_MANIFEST" ] || {
 echo MANIFEST_HASH_INVALID; exit 2;
}
n=0
while read -r sha filename extra || [ -n "${sha:-}" ]; do
 case "$sha" in ""|\#*) continue;; esac
 case "$filename" in engine.py|atspi_backend.py|ui_primitives.py|benchmark_gate_f_readsafe.py|pointer_mapping.py|x11_modal_guard.py|popup_closure.py|gate_click_accuracy.py|wechat_ui_ladder_v3.py|with_wechat_env.sh|gate_file_chooser_once.py) ;; *) echo UNEXPECTED_RUNTIME_FILE; exit 2;; esac
 [ -z "${extra:-}" ] && [ ! -e "$tmp/$filename" ] || { echo DUPLICATE_ENTRY; exit 2; }
 curl -fsSL --connect-timeout 8 --max-time 40 "$BASE/$filename" -o "$tmp/$filename"
 [ "$(git hash-object "$tmp/$filename")" = "$sha" ] || {
    echo "BLOB_HASH_MISMATCH $filename"; exit 2;
 }
 n=$((n+1))
done < "$tmp/MANIFEST"
[ "$n" -eq 11 ] || { echo RUNTIME_COUNT_INVALID; exit 2; }
[ -d /tmp/wxeng ] && [ ! -L /tmp/wxeng ] &&
[ "$(stat -c '%u' /tmp/wxeng)" -eq "$(id -u)" ] || {
 echo UNSAFE_RUNTIME_DIR; exit 2;
}
for filename in engine.py atspi_backend.py ui_primitives.py benchmark_gate_f_readsafe.py pointer_mapping.py x11_modal_guard.py popup_closure.py gate_click_accuracy.py wechat_ui_ladder_v3.py with_wechat_env.sh gate_file_chooser_once.py; do
 [ ! -L "/tmp/wxeng/$filename" ] || { echo SYMLINK_TARGET_BLOCKED; exit 2; }
 install -m 600 "$tmp/$filename" "/tmp/wxeng/$filename"
done
cd /tmp/wxeng
python3 -m py_compile engine.py atspi_backend.py ui_primitives.py benchmark_gate_f_readsafe.py pointer_mapping.py x11_modal_guard.py popup_closure.py gate_click_accuracy.py wechat_ui_ladder_v3.py gate_file_chooser_once.py || { echo PY_COMPILE_FAILED; exit 2; }
echo "FILE_CHOOSER_RUNTIME_STAGE_OK blobs=11 no_tests=True no_send=True no_keyboard=True"
