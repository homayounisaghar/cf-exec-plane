#!/bin/sh
# WeChat v9 receive_v1: stage + verify 16 runtime files; optional READ-ONLY receive run.
# Modes: --stage-only | --receive N EXPECT_CHAT
# receive = lock + guard + one AT-SPI read; fails closed unless the selected chat AND header == EXPECT_CHAT; no clicks/keys
set -eu
umask 077
[ "$(id -u)" -eq 1000 ] || { echo "WX_V9_WRONG_UID"; exit 2; }
mode="${1:-}"; nmsg="${2:-}"; chat="${3:-}"
case "$mode" in --stage-only) [ "$#" -eq 1 ] || { echo "WX_V9_ARGS"; exit 2; };; --receive) [ "$#" -eq 3 ] && [ -n "$chat" ] && case "$nmsg" in ''|*[!0-9]*) false;; *) true;; esac || { echo "WX_V9_ARGS"; exit 2; };; *) echo "WX_V9_MODE"; exit 2;; esac
[ -z "${WX_SPEED_SEND_AUTH:-}" ] && [ -z "${WX_SPEED_TEXTS_B64:-}" ] && [ -z "${WX_SPEED_RESUME_UNSENT_FIRST:-}" ] && [ -z "${WX_GATE_H_SEND_ONCE:-}" ] && [ -z "${WX_GATE_H_TEXT:-}" ] || { echo "WX_V9_SEND_ENV_FORBIDDEN"; exit 2; }
BASE="https://raw.githubusercontent.com/homayounisaghar/cf-exec-plane/cd2c89bb7299c5d8330f2b0777cbd90f1cab196d/research-stage/wechat-ui-engine-v2/85963c8efa63b91f0d75b943104d934274e108d5"
MANIFEST_SHA="a18a54766873518ddeb18cbc82dabe2b3a01acfe"
dest=/tmp/wxeng
work=$(mktemp -d /tmp/wx-v9-stage.XXXXXXXX)
trap 'rm -rf "$work"' EXIT HUP INT TERM
[ -d "$dest" ] && [ ! -L "$dest" ] && [ "$(stat -c '%u' "$dest")" -eq 1000 ] || { echo "WX_V9_DEST_UNSAFE"; exit 2; }
curl -fsSL --connect-timeout 8 --max-time 40 "$BASE/MANIFEST" -o "$work/MANIFEST"
[ "$(git hash-object "$work/MANIFEST")" = "$MANIFEST_SHA" ] || { echo "WX_V9_MANIFEST_MISMATCH"; exit 2; }
n=0
while read -r sha name extra || [ -n "${sha:-}" ]; do
  case "$sha" in ""|\#*) continue;; esac
  case "$name" in engine.py|atspi_backend.py|ui_primitives.py|benchmark_gate_f_readsafe.py|pointer_mapping.py|x11_modal_guard.py|popup_closure.py|gate_click_accuracy.py|wechat_ui_ladder_v3.py|with_wechat_env.sh|gate_file_chooser_once.py|wechat_popup_e2e_v4.py|gate_h_send_once.py|wechat_live_lock.py|wechat_speed_send_locked.py|receive_readonly.py) ;; *) echo "WX_V9_UNKNOWN_RUNTIME"; exit 2;; esac
  [ -z "${extra:-}" ] && [ ! -e "$work/$name" ] || { echo "WX_V9_DUPLICATE_OR_EXTRA"; exit 2; }
  [ ! -L "$dest/$name" ] || { echo "WX_V9_DEST_SYMLINK"; exit 2; }
  curl -fsSL --connect-timeout 8 --max-time 40 "$BASE/$name" -o "$work/$name"
  [ "$(git hash-object "$work/$name")" = "$sha" ] || { echo "WX_V9_SOURCE_HASH_MISMATCH $name"; exit 2; }
  n=$((n+1))
done < "$work/MANIFEST"
[ "$n" -eq 16 ] || { echo "WX_V9_MODULE_COUNT"; exit 2; }
(cd "$work" && python3 -m py_compile engine.py atspi_backend.py ui_primitives.py benchmark_gate_f_readsafe.py pointer_mapping.py x11_modal_guard.py popup_closure.py gate_click_accuracy.py wechat_ui_ladder_v3.py gate_file_chooser_once.py wechat_popup_e2e_v4.py gate_h_send_once.py wechat_live_lock.py wechat_speed_send_locked.py receive_readonly.py )
for name in engine.py atspi_backend.py ui_primitives.py benchmark_gate_f_readsafe.py pointer_mapping.py x11_modal_guard.py popup_closure.py gate_click_accuracy.py wechat_ui_ladder_v3.py with_wechat_env.sh gate_file_chooser_once.py wechat_popup_e2e_v4.py gate_h_send_once.py wechat_live_lock.py wechat_speed_send_locked.py receive_readonly.py ; do
  install -m 0600 "$work/$name" "$dest/$name"
done
verified=0
while read -r sha name extra || [ -n "${sha:-}" ]; do
  case "$sha" in ""|\#*) continue;; esac
  [ "$(git hash-object "$dest/$name")" = "$sha" ] || { echo "WX_V9_STAGED_HASH_MISMATCH $name"; exit 2; }
  verified=$((verified+1))
done < "$work/MANIFEST"
[ "$verified" -eq 16 ] || { echo "WX_V9_POSTCOUNT"; exit 2; }
echo "WX_V9_STAGE_OK files=16 hashes=16 tests_published=no source=cd2c89bb7299c5d8330f2b0777cbd90f1cab196d research=85963c8efa63b91f0d75b943104d934274e108d5"
[ "$mode" = "--receive" ] || exit 0
cd "$dest"
exec bash ./with_wechat_env.sh python3 ./receive_readonly.py "$nmsg" "$chat"
