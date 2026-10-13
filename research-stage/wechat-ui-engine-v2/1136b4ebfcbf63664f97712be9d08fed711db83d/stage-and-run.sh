#!/bin/sh
# WeChat v7 receive_v1: stage + verify 16 runtime files; optional READ-ONLY receive run.
# Modes: --stage-only | --receive N   (receive = lock + guard + one AT-SPI read; no clicks/keys)
set -eu
umask 077
[ "$(id -u)" -eq 1000 ] || { echo "WX_V7_WRONG_UID"; exit 2; }
mode="${1:-}"; nmsg="${2:-10}"
case "$mode" in --stage-only) [ "$#" -eq 1 ] || { echo "WX_V7_ARGS"; exit 2; };; --receive) [ "$#" -le 2 ] && case "$nmsg" in ''|*[!0-9]*) false;; *) true;; esac || { echo "WX_V7_ARGS"; exit 2; };; *) echo "WX_V7_MODE"; exit 2;; esac
[ -z "${WX_SPEED_SEND_AUTH:-}" ] && [ -z "${WX_SPEED_TEXTS_B64:-}" ] && [ -z "${WX_SPEED_RESUME_UNSENT_FIRST:-}" ] && [ -z "${WX_GATE_H_SEND_ONCE:-}" ] && [ -z "${WX_GATE_H_TEXT:-}" ] || { echo "WX_V7_SEND_ENV_FORBIDDEN"; exit 2; }
BASE="https://raw.githubusercontent.com/homayounisaghar/cf-exec-plane/38c885eaaab259206dae1a08f6e96c55a959c5b8/research-stage/wechat-ui-engine-v2/1136b4ebfcbf63664f97712be9d08fed711db83d"
MANIFEST_SHA="215dd5ee24bb39d943e07e3cf799707b2e408cd5"
dest=/tmp/wxeng
work=$(mktemp -d /tmp/wx-v7-stage.XXXXXXXX)
trap 'rm -rf "$work"' EXIT HUP INT TERM
[ -d "$dest" ] && [ ! -L "$dest" ] && [ "$(stat -c '%u' "$dest")" -eq 1000 ] || { echo "WX_V7_DEST_UNSAFE"; exit 2; }
curl -fsSL --connect-timeout 8 --max-time 40 "$BASE/MANIFEST" -o "$work/MANIFEST"
[ "$(git hash-object "$work/MANIFEST")" = "$MANIFEST_SHA" ] || { echo "WX_V7_MANIFEST_MISMATCH"; exit 2; }
n=0
while read -r sha name extra || [ -n "${sha:-}" ]; do
  case "$sha" in ""|\#*) continue;; esac
  case "$name" in engine.py|atspi_backend.py|ui_primitives.py|benchmark_gate_f_readsafe.py|pointer_mapping.py|x11_modal_guard.py|popup_closure.py|gate_click_accuracy.py|wechat_ui_ladder_v3.py|with_wechat_env.sh|gate_file_chooser_once.py|wechat_popup_e2e_v4.py|gate_h_send_once.py|wechat_live_lock.py|wechat_speed_send_locked.py|receive_readonly.py) ;; *) echo "WX_V7_UNKNOWN_RUNTIME"; exit 2;; esac
  [ -z "${extra:-}" ] && [ ! -e "$work/$name" ] || { echo "WX_V7_DUPLICATE_OR_EXTRA"; exit 2; }
  [ ! -L "$dest/$name" ] || { echo "WX_V7_DEST_SYMLINK"; exit 2; }
  curl -fsSL --connect-timeout 8 --max-time 40 "$BASE/$name" -o "$work/$name"
  [ "$(git hash-object "$work/$name")" = "$sha" ] || { echo "WX_V7_SOURCE_HASH_MISMATCH $name"; exit 2; }
  n=$((n+1))
done < "$work/MANIFEST"
[ "$n" -eq 16 ] || { echo "WX_V7_MODULE_COUNT"; exit 2; }
(cd "$work" && python3 -m py_compile engine.py atspi_backend.py ui_primitives.py benchmark_gate_f_readsafe.py pointer_mapping.py x11_modal_guard.py popup_closure.py gate_click_accuracy.py wechat_ui_ladder_v3.py gate_file_chooser_once.py wechat_popup_e2e_v4.py gate_h_send_once.py wechat_live_lock.py wechat_speed_send_locked.py receive_readonly.py )
for name in engine.py atspi_backend.py ui_primitives.py benchmark_gate_f_readsafe.py pointer_mapping.py x11_modal_guard.py popup_closure.py gate_click_accuracy.py wechat_ui_ladder_v3.py with_wechat_env.sh gate_file_chooser_once.py wechat_popup_e2e_v4.py gate_h_send_once.py wechat_live_lock.py wechat_speed_send_locked.py receive_readonly.py ; do
  install -m 0600 "$work/$name" "$dest/$name"
done
verified=0
while read -r sha name extra || [ -n "${sha:-}" ]; do
  case "$sha" in ""|\#*) continue;; esac
  [ "$(git hash-object "$dest/$name")" = "$sha" ] || { echo "WX_V7_STAGED_HASH_MISMATCH $name"; exit 2; }
  verified=$((verified+1))
done < "$work/MANIFEST"
[ "$verified" -eq 16 ] || { echo "WX_V7_POSTCOUNT"; exit 2; }
echo "WX_V7_STAGE_OK files=16 hashes=16 tests_published=no source=38c885eaaab259206dae1a08f6e96c55a959c5b8 research=1136b4ebfcbf63664f97712be9d08fed711db83d"
[ "$mode" = "--receive" ] || exit 0
cd "$dest"
exec sh ./with_wechat_env.sh python3 ./receive_readonly.py "$nmsg"
