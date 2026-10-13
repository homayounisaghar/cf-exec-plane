#!/bin/sh
# Stage exactly 12 secret-free WeChat v4 runtime modules; NO UI interaction.
set -eu
umask 077
[ "$(id -u)" -eq 1000 ] || { echo STAGE_UID_INVALID; exit 2; }
[ "${1:-}" = "--stage-only" ] || { echo ONLY_STAGE_ALLOWED; exit 2; }
[ -z "${WX_GATE_H_TEXT:-}" ] && [ -z "${WX_GATE_H_SEND_ONCE:-}" ] || { echo SEND_ENV_FORBIDDEN; exit 2; }
BASE="https://raw.githubusercontent.com/homayounisaghar/cf-exec-plane/3421d84a6ac51efda6b382b074f6165b942ed784/research-stage/wechat-ui-engine-v2/f21ce9996bdcb3f3380c20b2585ac9e6e5cf3173"
MANIFEST_SHA=200e232e741112e59f5eb028b73b0f586dc822d6
tmp=$(mktemp -d /tmp/wx-v4-stage.XXXXXXXX)
trap 'rm -rf "$tmp"' EXIT HUP INT TERM
curl -fsSL --connect-timeout 8 --max-time 45 "$BASE/MANIFEST" -o "$tmp/MANIFEST"
[ "$(git hash-object "$tmp/MANIFEST")" = "$MANIFEST_SHA" ] || { echo MANIFEST_HASH_MISMATCH; exit 2; }
n=0
while read -r sha filename extra || [ -n "${sha:-}" ]; do
  case "$sha" in ""|\#*) continue;; esac
  case "$filename" in
    engine.py|atspi_backend.py|ui_primitives.py|benchmark_gate_f_readsafe.py|pointer_mapping.py|x11_modal_guard.py|popup_closure.py|gate_click_accuracy.py|wechat_ui_ladder_v3.py|with_wechat_env.sh|gate_file_chooser_once.py|wechat_popup_e2e_v4.py) ;;
    *) echo UNEXPECTED_RUNTIME_FILE; exit 2;;
  esac
  [ -z "${extra:-}" ] && [ ! -e "$tmp/$filename" ] || { echo BAD_MANIFEST_ENTRY; exit 2; }
  curl -fsSL --connect-timeout 8 --max-time 45 "$BASE/$filename" -o "$tmp/$filename"
  [ "$(git hash-object "$tmp/$filename")" = "$sha" ] || { echo RUNTIME_HASH_MISMATCH; exit 2; }
  n=$((n+1))
done < "$tmp/MANIFEST"
[ "$n" -eq 12 ] || { echo RUNTIME_COUNT_MISMATCH; exit 2; }
[ -d /tmp/wxeng ] && [ ! -L /tmp/wxeng ] && [ "$(stat -c %u /tmp/wxeng)" -eq 1000 ] || { echo STAGE_DIR_UNSAFE; exit 2; }
for file in engine.py atspi_backend.py ui_primitives.py benchmark_gate_f_readsafe.py pointer_mapping.py x11_modal_guard.py popup_closure.py gate_click_accuracy.py wechat_ui_ladder_v3.py with_wechat_env.sh gate_file_chooser_once.py wechat_popup_e2e_v4.py; do
  [ ! -L "/tmp/wxeng/$file" ] || { echo STAGE_SYMLINK_REFUSED; exit 2; }
  install -m 0600 "$tmp/$file" "/tmp/wxeng/$file"
done
cd /tmp/wxeng
python3 -m py_compile engine.py atspi_backend.py ui_primitives.py benchmark_gate_f_readsafe.py pointer_mapping.py x11_modal_guard.py popup_closure.py gate_click_accuracy.py wechat_ui_ladder_v3.py gate_file_chooser_once.py wechat_popup_e2e_v4.py
echo "WX_V4_RUNTIME_STAGED blobs_verified=12 test_files=0 no_gui_actions=True no_send=True"
