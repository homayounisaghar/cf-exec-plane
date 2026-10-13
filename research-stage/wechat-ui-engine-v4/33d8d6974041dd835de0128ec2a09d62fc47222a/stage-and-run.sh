#!/bin/sh
set -eu
umask 077
[ "$(id -u)" -eq 1000 ] && [ "${1:-}" = "--stage-only" ] || exit 2
[ -z "${WX_GATE_H_SEND_ONCE:-}" ] && [ -z "${WX_GATE_H_TEXT:-}" ] || exit 2
base=https://raw.githubusercontent.com/homayounisaghar/cf-exec-plane/82836e9dd6cc772951d5ff44bfce9b4ec2ba81a3/research-stage/wechat-ui-engine-v4/33d8d6974041dd835de0128ec2a09d62fc47222a
tmp=$(mktemp -d /tmp/wx-v4.XXXXXXXX)
trap 'rm -rf "$tmp"' EXIT HUP INT TERM
curl -fsSL "$base/MANIFEST" -o "$tmp/MANIFEST"
test "$(git hash-object "$tmp/MANIFEST")" = "c78187c210ff5009edd6dd681fa9e733feb52ca9"
n=0
while read -r hash file extra || [ -n "${hash:-}" ]; do
  case "$hash" in ""|\#*) continue;; esac
  case "$file" in engine.py|atspi_backend.py|ui_primitives.py|benchmark_gate_f_readsafe.py|pointer_mapping.py|x11_modal_guard.py|popup_closure.py|gate_click_accuracy.py|wechat_ui_ladder_v3.py|with_wechat_env.sh|gate_file_chooser_once.py|guarded_popup_accuracy_v4.py) ;; *) exit 2;; esac
  [ -z "${extra:-}" ] && [ ! -e "$tmp/$file" ] || exit 2
  curl -fsSL "$base/$file" -o "$tmp/$file"
  test "$(git hash-object "$tmp/$file")" = "$hash"
  n=$((n+1))
done < "$tmp/MANIFEST"
[ "$n" -eq 12 ] && [ -d /tmp/wxeng ] && [ ! -L /tmp/wxeng ] || exit 2
for f in engine.py atspi_backend.py ui_primitives.py benchmark_gate_f_readsafe.py pointer_mapping.py x11_modal_guard.py popup_closure.py gate_click_accuracy.py wechat_ui_ladder_v3.py with_wechat_env.sh gate_file_chooser_once.py guarded_popup_accuracy_v4.py; do
  [ ! -L "/tmp/wxeng/$f" ] || exit 2
  install -m 600 "$tmp/$f" "/tmp/wxeng/$f"
done
cd /tmp/wxeng
python3 -m py_compile engine.py atspi_backend.py ui_primitives.py benchmark_gate_f_readsafe.py pointer_mapping.py x11_modal_guard.py popup_closure.py gate_click_accuracy.py wechat_ui_ladder_v3.py gate_file_chooser_once.py guarded_popup_accuracy_v4.py
echo "V4_STAGED 12/12 hashes verified, runtime only, no GUI"
