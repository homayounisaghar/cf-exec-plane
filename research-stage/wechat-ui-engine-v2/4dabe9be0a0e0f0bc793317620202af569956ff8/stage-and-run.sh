#!/bin/sh
# B-only WeChat v6, immutable, stage + verify 15 runtime files; NO GUI execution.
set -eu
umask 077
[ "$(id -u)" -eq 1000 ] || { echo "WX_V6_WRONG_UID"; exit 2; }
[ "${1:-}" = "--stage-only" ] && [ "$#" -eq 1 ] || { echo "WX_V6_STAGE_ONLY"; exit 2; }
[ -z "${WX_SPEED_SEND_AUTH:-}" ] && [ -z "${WX_SPEED_TEXTS_B64:-}" ] && [ -z "${WX_SPEED_RESUME_UNSENT_FIRST:-}" ] && [ -z "${WX_GATE_H_SEND_ONCE:-}" ] && [ -z "${WX_GATE_H_TEXT:-}" ] || { echo "WX_V6_SEND_ENV_FORBIDDEN"; exit 2; }
BASE="https://raw.githubusercontent.com/homayounisaghar/cf-exec-plane/078770035259df163ad65e1f57090331d166ffe4/research-stage/wechat-ui-engine-v2/4dabe9be0a0e0f0bc793317620202af569956ff8"
MANIFEST_SHA="6035e49cd37d069caf90fa752cedfe91f989ac9a"
dest=/tmp/wxeng
work=$(mktemp -d /tmp/wx-v6-stage.XXXXXXXX)
trap 'rm -rf "$work"' EXIT HUP INT TERM
[ -d "$dest" ] && [ ! -L "$dest" ] && [ "$(stat -c '%u' "$dest")" -eq 1000 ] || { echo "WX_V6_DEST_UNSAFE"; exit 2; }
curl -fsSL --connect-timeout 8 --max-time 40 "$BASE/MANIFEST" -o "$work/MANIFEST"
[ "$(git hash-object "$work/MANIFEST")" = "$MANIFEST_SHA" ] || { echo "WX_V6_MANIFEST_MISMATCH"; exit 2; }
n=0
while read -r sha name extra || [ -n "${sha:-}" ]; do
  case "$sha" in ""|\#*) continue;; esac
  case "$name" in engine.py|atspi_backend.py|ui_primitives.py|benchmark_gate_f_readsafe.py|pointer_mapping.py|x11_modal_guard.py|popup_closure.py|gate_click_accuracy.py|wechat_ui_ladder_v3.py|with_wechat_env.sh|gate_file_chooser_once.py|wechat_popup_e2e_v4.py|gate_h_send_once.py|wechat_live_lock.py|wechat_speed_send_locked.py) ;; *) echo "WX_V6_UNKNOWN_RUNTIME"; exit 2;; esac
  [ -z "${extra:-}" ] && [ ! -e "$work/$name" ] || { echo "WX_V6_DUPLICATE_OR_EXTRA"; exit 2; }
  [ ! -L "$dest/$name" ] || { echo "WX_V6_DEST_SYMLINK"; exit 2; }
  curl -fsSL --connect-timeout 8 --max-time 40 "$BASE/$name" -o "$work/$name"
  [ "$(git hash-object "$work/$name")" = "$sha" ] || { echo "WX_V6_SOURCE_HASH_MISMATCH"; exit 2; }
  n=$((n+1))
done < "$work/MANIFEST"
[ "$n" -eq 15 ] || { echo "WX_V6_MODULE_COUNT"; exit 2; }
(cd "$work" && python3 -m py_compile engine.py atspi_backend.py ui_primitives.py benchmark_gate_f_readsafe.py pointer_mapping.py x11_modal_guard.py popup_closure.py gate_click_accuracy.py wechat_ui_ladder_v3.py gate_file_chooser_once.py wechat_popup_e2e_v4.py gate_h_send_once.py wechat_live_lock.py wechat_speed_send_locked.py)
for name in engine.py atspi_backend.py ui_primitives.py benchmark_gate_f_readsafe.py pointer_mapping.py x11_modal_guard.py popup_closure.py gate_click_accuracy.py wechat_ui_ladder_v3.py with_wechat_env.sh gate_file_chooser_once.py wechat_popup_e2e_v4.py gate_h_send_once.py wechat_live_lock.py wechat_speed_send_locked.py; do
  install -m 0600 "$work/$name" "$dest/$name"
done
verified=0
while read -r sha name extra || [ -n "${sha:-}" ]; do
  case "$sha" in ""|\#*) continue;; esac
  [ "$(git hash-object "$dest/$name")" = "$sha" ] || { echo "WX_V6_STAGED_HASH_MISMATCH $name"; exit 2; }
  verified=$((verified+1))
done < "$work/MANIFEST"
[ "$verified" -eq 15 ] || { echo "WX_V6_POSTCOUNT"; exit 2; }
echo "WX_V6_STAGE_OK files=15 hashes=15 tests_published=no ui_effects=none source=078770035259df163ad65e1f57090331d166ffe4"
