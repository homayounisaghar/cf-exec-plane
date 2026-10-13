#!/bin/sh
# Immutable 15 runtime modules; this script ONLY stages and compiles.
set -eu
umask 077
[ "$(id -u)" -eq 1000 ] || { echo "V5_WRONG_OWNER"; exit 2; }
[ "${1:-}" = "--stage-only" ] || { echo "V5_STAGING_ONLY"; exit 2; }
[ -z "${WX_GATE_H_SEND_ONCE:-}" ] && [ -z "${WX_GATE_H_TEXT:-}" ] || { echo "V5_SEND_ENV_FORBIDDEN"; exit 2; }
BASE="https://raw.githubusercontent.com/homayounisaghar/cf-exec-plane/aa38eeacd54a5a161ca0f0b765da2890d628fe74/research-stage/wechat-ui-engine-v2/844ba621bc189dcaee1d3908dbd541d837d07ac1"
MANIFEST_SHA="2b89bd310ad1e7fd588901fed5c1e87ba62c10ed"
dir=$(mktemp -d /tmp/wx-v5-locked.XXXXXXXX)
trap 'rm -rf "$dir"' EXIT HUP INT TERM
curl -fsSL --connect-timeout 8 --max-time 40 "$BASE/MANIFEST" -o "$dir/MANIFEST"
[ "$(git hash-object "$dir/MANIFEST")" = "$MANIFEST_SHA" ] || { echo "V5_MANIFEST_SHA_FAIL"; exit 2; }
n=0
while read -r sha name extra || [ -n "${sha:-}" ]; do
  case "$sha" in ""|\#*) continue;; esac
  case "$name" in engine.py|atspi_backend.py|ui_primitives.py|benchmark_gate_f_readsafe.py|pointer_mapping.py|x11_modal_guard.py|popup_closure.py|gate_click_accuracy.py|wechat_ui_ladder_v3.py|with_wechat_env.sh|gate_file_chooser_once.py|wechat_popup_e2e_v4.py|gate_h_send_once.py|wechat_live_lock.py|wechat_speed_send_locked.py) ;; *) echo "V5_BAD_RUNTIME_ENTRY"; exit 2;; esac
  [ -z "${extra:-}" ] && [ ! -e "$dir/$name" ] || { echo "V5_EXTRA_OR_DUPLICATE_ENTRY"; exit 2; }
  curl -fsSL --connect-timeout 8 --max-time 40 "$BASE/$name" -o "$dir/$name"
  [ "$(git hash-object "$dir/$name")" = "$sha" ] || { echo "V5_BLOB_MISMATCH $name"; exit 2; }
  n=$((n+1))
done < "$dir/MANIFEST"
[ "$n" -eq 15 ] || { echo "V5_RUNTIME_COUNT_WRONG"; exit 2; }
[ -d /tmp/wxeng ] && [ ! -L /tmp/wxeng ] && [ "$(stat -c '%u' /tmp/wxeng)" -eq 1000 ] || { echo "V5_STAGE_DIR_UNSAFE"; exit 2; }
for name in engine.py atspi_backend.py ui_primitives.py benchmark_gate_f_readsafe.py pointer_mapping.py x11_modal_guard.py popup_closure.py gate_click_accuracy.py wechat_ui_ladder_v3.py with_wechat_env.sh gate_file_chooser_once.py wechat_popup_e2e_v4.py gate_h_send_once.py wechat_live_lock.py wechat_speed_send_locked.py; do
  [ ! -L "/tmp/wxeng/$name" ] || { echo "V5_STAGE_SYMLINK_UNSAFE"; exit 2; }
  install -m 0600 "$dir/$name" "/tmp/wxeng/$name"
done
cd /tmp/wxeng
python3 -m py_compile engine.py atspi_backend.py ui_primitives.py benchmark_gate_f_readsafe.py pointer_mapping.py x11_modal_guard.py popup_closure.py gate_click_accuracy.py wechat_ui_ladder_v3.py gate_file_chooser_once.py wechat_popup_e2e_v4.py gate_h_send_once.py wechat_live_lock.py wechat_speed_send_locked.py
echo "WX_V5_SPEED_STAGED count=15 verified=True tests_published=False no_gui=True"
