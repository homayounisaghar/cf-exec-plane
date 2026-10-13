#!/bin/sh
# WeChat v11 (v10 + voice): stage + verify 23 runtime files; optional run.
# Modes: --stage-only | --receive N EXPECT_CHAT | --v10 CMD [ARGS...]
set -eu
umask 077
[ "$(id -u)" -eq 1000 ] || { echo "WX_V11_WRONG_UID"; exit 2; }
mode="${1:-}"
case "$mode" in
  --stage-only) [ "$#" -eq 1 ] || { echo "WX_V11_ARGS"; exit 2; };;
  --receive) [ "$#" -eq 3 ] && [ -n "$3" ] && case "$2" in ''|*[!0-9]*) false;; *) true;; esac || { echo "WX_V11_ARGS"; exit 2; };;
  --v10) [ "$#" -ge 2 ] || { echo "WX_V11_ARGS"; exit 2; };;
  *) echo "WX_V11_MODE"; exit 2;;
esac
[ -z "${WX_SPEED_SEND_AUTH:-}" ] && [ -z "${WX_SPEED_TEXTS_B64:-}" ] && [ -z "${WX_SPEED_RESUME_UNSENT_FIRST:-}" ] && [ -z "${WX_GATE_H_SEND_ONCE:-}" ] && [ -z "${WX_GATE_H_TEXT:-}" ] || { echo "WX_V11_SEND_ENV_FORBIDDEN"; exit 2; }
BASE="https://raw.githubusercontent.com/homayounisaghar/cf-exec-plane/a295bd2a1474a42b9e23d2f8b7037bd5d5415d6a/research-stage/wechat-ui-engine-v2/e30aa83a6b0637e5fa21fb8999cc3194e8df9bc7"
MANIFEST_SHA="1eb4953ffde17b1477f8388b5a664dca1ae4a89b"
dest=/tmp/wxeng
work=$(mktemp -d /tmp/wx-v11-stage.XXXXXXXX)
trap 'rm -rf "$work"' EXIT HUP INT TERM
[ -d "$dest" ] && [ ! -L "$dest" ] && [ "$(stat -c '%u' "$dest")" -eq 1000 ] || { echo "WX_V11_DEST_UNSAFE"; exit 2; }
curl -fsSL --connect-timeout 8 --max-time 40 "$BASE/MANIFEST" -o "$work/MANIFEST"
[ "$(git hash-object "$work/MANIFEST")" = "$MANIFEST_SHA" ] || { echo "WX_V11_MANIFEST_MISMATCH"; exit 2; }
n=0
while read -r sha name extra || [ -n "${sha:-}" ]; do
  case "$sha" in ""|\#*) continue;; esac
  case "$name" in engine.py|atspi_backend.py|ui_primitives.py|benchmark_gate_f_readsafe.py|pointer_mapping.py|x11_modal_guard.py|popup_closure.py|gate_click_accuracy.py|wechat_ui_ladder_v3.py|with_wechat_env.sh|gate_file_chooser_once.py|wechat_popup_e2e_v4.py|gate_h_send_once.py|wechat_live_lock.py|wechat_speed_send_locked.py|receive_readonly.py|wx_common.py|wx_pixels.py|wx_nav.py|wx_send.py|wx_menu_watch.py|wx_v10.py|wx_voice.py) ;; *) echo "WX_V11_UNKNOWN_RUNTIME"; exit 2;; esac
  [ -z "${extra:-}" ] && [ ! -e "$work/$name" ] || { echo "WX_V11_DUPLICATE_OR_EXTRA"; exit 2; }
  [ ! -L "$dest/$name" ] || { echo "WX_V11_DEST_SYMLINK"; exit 2; }
  curl -fsSL --connect-timeout 8 --max-time 40 "$BASE/$name" -o "$work/$name"
  [ "$(git hash-object "$work/$name")" = "$sha" ] || { echo "WX_V11_SOURCE_HASH_MISMATCH $name"; exit 2; }
  n=$((n+1))
done < "$work/MANIFEST"
[ "$n" -eq 23 ] || { echo "WX_V11_MODULE_COUNT"; exit 2; }
(cd "$work" && python3 -m py_compile engine.py atspi_backend.py ui_primitives.py benchmark_gate_f_readsafe.py pointer_mapping.py x11_modal_guard.py popup_closure.py gate_click_accuracy.py wechat_ui_ladder_v3.py gate_file_chooser_once.py wechat_popup_e2e_v4.py gate_h_send_once.py wechat_live_lock.py wechat_speed_send_locked.py receive_readonly.py wx_common.py wx_pixels.py wx_nav.py wx_send.py wx_menu_watch.py wx_v10.py wx_voice.py )
for name in engine.py atspi_backend.py ui_primitives.py benchmark_gate_f_readsafe.py pointer_mapping.py x11_modal_guard.py popup_closure.py gate_click_accuracy.py wechat_ui_ladder_v3.py with_wechat_env.sh gate_file_chooser_once.py wechat_popup_e2e_v4.py gate_h_send_once.py wechat_live_lock.py wechat_speed_send_locked.py receive_readonly.py wx_common.py wx_pixels.py wx_nav.py wx_send.py wx_menu_watch.py wx_v10.py wx_voice.py ; do
  install -m 0600 "$work/$name" "$dest/$name"
done
verified=0
while read -r sha name extra || [ -n "${sha:-}" ]; do
  case "$sha" in ""|\#*) continue;; esac
  [ "$(git hash-object "$dest/$name")" = "$sha" ] || { echo "WX_V11_STAGED_HASH_MISMATCH $name"; exit 2; }
  verified=$((verified+1))
done < "$work/MANIFEST"
[ "$verified" -eq 23 ] || { echo "WX_V11_POSTCOUNT"; exit 2; }
echo "WX_V11_STAGE_OK files=23 hashes=23 tests_published=no source=a295bd2a1474a42b9e23d2f8b7037bd5d5415d6a research=e30aa83a6b0637e5fa21fb8999cc3194e8df9bc7"
cd "$dest"
case "$mode" in
  --stage-only) exit 0;;
  --receive) exec bash ./with_wechat_env.sh python3 ./receive_readonly.py "$2" "$3";;
  --v10) shift; exec bash ./with_wechat_env.sh python3 ./wx_v10.py "$@";;
esac
