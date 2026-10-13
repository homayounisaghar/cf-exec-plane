#!/bin/sh
# WeChat v8 receive_v1: stage + verify 16 runtime files; optional READ-ONLY receive run.
# Modes: --stage-only | --receive N EXPECT_CHAT
# receive = lock + guard + one AT-SPI read; fails closed unless the selected chat AND header == EXPECT_CHAT; no clicks/keys
set -eu
umask 077
[ "$(id -u)" -eq 1000 ] || { echo "WX_V8_WRONG_UID"; exit 2; }
mode="${1:-}"; nmsg="${2:-}"; chat="${3:-}"
case "$mode" in --stage-only) [ "$#" -eq 1 ] || { echo "WX_V8_ARGS"; exit 2; };; --receive) [ "$#" -eq 3 ] && [ -n "$chat" ] && case "$nmsg" in ''|*[!0-9]*) false;; *) true;; esac || { echo "WX_V8_ARGS"; exit 2; };; *) echo "WX_V8_MODE"; exit 2;; esac
[ -z "${WX_SPEED_SEND_AUTH:-}" ] && [ -z "${WX_SPEED_TEXTS_B64:-}" ] && [ -z "${WX_SPEED_RESUME_UNSENT_FIRST:-}" ] && [ -z "${WX_GATE_H_SEND_ONCE:-}" ] && [ -z "${WX_GATE_H_TEXT:-}" ] || { echo "WX_V8_SEND_ENV_FORBIDDEN"; exit 2; }
BASE="https://raw.githubusercontent.com/homayounisaghar/cf-exec-plane/d254e359de57896080cadd532e4662bc032dbcf1/research-stage/wechat-ui-engine-v2/42eb14fc883c2e1feb0c9ebba64b9f9d3daf4beb"
MANIFEST_SHA="71bffc0ddc2b82e73a0bf43eddb86a702d116fbf"
dest=/tmp/wxeng
work=$(mktemp -d /tmp/wx-v8-stage.XXXXXXXX)
trap 'rm -rf "$work"' EXIT HUP INT TERM
[ -d "$dest" ] && [ ! -L "$dest" ] && [ "$(stat -c '%u' "$dest")" -eq 1000 ] || { echo "WX_V8_DEST_UNSAFE"; exit 2; }
curl -fsSL --connect-timeout 8 --max-time 40 "$BASE/MANIFEST" -o "$work/MANIFEST"
[ "$(git hash-object "$work/MANIFEST")" = "$MANIFEST_SHA" ] || { echo "WX_V8_MANIFEST_MISMATCH"; exit 2; }
n=0
while read -r sha name extra || [ -n "${sha:-}" ]; do
  case "$sha" in ""|\#*) continue;; esac
  case "$name" in engine.py|atspi_backend.py|ui_primitives.py|benchmark_gate_f_readsafe.py|pointer_mapping.py|x11_modal_guard.py|popup_closure.py|gate_click_accuracy.py|wechat_ui_ladder_v3.py|with_wechat_env.sh|gate_file_chooser_once.py|wechat_popup_e2e_v4.py|gate_h_send_once.py|wechat_live_lock.py|wechat_speed_send_locked.py|receive_readonly.py) ;; *) echo "WX_V8_UNKNOWN_RUNTIME"; exit 2;; esac
  [ -z "${extra:-}" ] && [ ! -e "$work/$name" ] || { echo "WX_V8_DUPLICATE_OR_EXTRA"; exit 2; }
  [ ! -L "$dest/$name" ] || { echo "WX_V8_DEST_SYMLINK"; exit 2; }
  curl -fsSL --connect-timeout 8 --max-time 40 "$BASE/$name" -o "$work/$name"
  [ "$(git hash-object "$work/$name")" = "$sha" ] || { echo "WX_V8_SOURCE_HASH_MISMATCH $name"; exit 2; }
  n=$((n+1))
done < "$work/MANIFEST"
[ "$n" -eq 16 ] || { echo "WX_V8_MODULE_COUNT"; exit 2; }
(cd "$work" && python3 -m py_compile engine.py atspi_backend.py ui_primitives.py benchmark_gate_f_readsafe.py pointer_mapping.py x11_modal_guard.py popup_closure.py gate_click_accuracy.py wechat_ui_ladder_v3.py gate_file_chooser_once.py wechat_popup_e2e_v4.py gate_h_send_once.py wechat_live_lock.py wechat_speed_send_locked.py receive_readonly.py )
for name in engine.py atspi_backend.py ui_primitives.py benchmark_gate_f_readsafe.py pointer_mapping.py x11_modal_guard.py popup_closure.py gate_click_accuracy.py wechat_ui_ladder_v3.py with_wechat_env.sh gate_file_chooser_once.py wechat_popup_e2e_v4.py gate_h_send_once.py wechat_live_lock.py wechat_speed_send_locked.py receive_readonly.py ; do
  install -m 0600 "$work/$name" "$dest/$name"
done
verified=0
while read -r sha name extra || [ -n "${sha:-}" ]; do
  case "$sha" in ""|\#*) continue;; esac
  [ "$(git hash-object "$dest/$name")" = "$sha" ] || { echo "WX_V8_STAGED_HASH_MISMATCH $name"; exit 2; }
  verified=$((verified+1))
done < "$work/MANIFEST"
[ "$verified" -eq 16 ] || { echo "WX_V8_POSTCOUNT"; exit 2; }
echo "WX_V8_STAGE_OK files=16 hashes=16 tests_published=no source=d254e359de57896080cadd532e4662bc032dbcf1 research=42eb14fc883c2e1feb0c9ebba64b9f9d3daf4beb"
[ "$mode" = "--receive" ] || exit 0
cd "$dest"
exec sh ./with_wechat_env.sh python3 ./receive_readonly.py "$nmsg" "$chat"
