#!/bin/sh
set -eu
umask 077
[ "$(id -u)" -eq 1000 ] || { echo LOCK_STAGE_WRONG_UID; exit 2; }
[ "${1:-}" = "--stage-only" ] || { echo STAGE_ONLY_REQUIRED; exit 2; }
[ -z "${WX_GATE_H_SEND_ONCE:-}" ] && [ -z "${WX_GATE_H_TEXT:-}" ] || { echo SEND_ENV_FORBIDDEN; exit 2; }
BASE="https://raw.githubusercontent.com/homayounisaghar/cf-exec-plane/b6c69e30137754c5a29c67cfc2963ecb8750a471/research-stage/wechat-ui-engine-v2/5a98744022388d6b40c4e64c151ef1401c1aa032"
expected_manifest="5c136124ea357f691a44ed6c5389d1f96a44ceb1"
tmp=$(mktemp -d /tmp/wx-live-lock-stage.XXXXXXXX)
trap 'rm -rf "$tmp"' EXIT HUP INT TERM
curl -fsSL --connect-timeout 8 --max-time 40 "$BASE/MANIFEST" -o "$tmp/MANIFEST"
[ "$(git hash-object "$tmp/MANIFEST")" = "$expected_manifest" ] || { echo LOCK_MANIFEST_MISMATCH; exit 2; }
n=0
while read -r sha f extra || [ -n "${sha:-}" ]; do
  case "$sha" in ""|\#*) continue;; esac
  case "$f" in engine.py|atspi_backend.py|ui_primitives.py|benchmark_gate_f_readsafe.py|pointer_mapping.py|x11_modal_guard.py|popup_closure.py|gate_click_accuracy.py|wechat_ui_ladder_v3.py|with_wechat_env.sh|gate_file_chooser_once.py|wechat_popup_e2e_v4.py|gate_h_send_once.py|wechat_live_lock.py) ;; *) echo LOCK_UNEXPECTED_FILE; exit 2;; esac
  [ -z "${extra:-}" ] && [ ! -e "$tmp/$f" ] || { echo LOCK_BAD_ENTRY; exit 2; }
  curl -fsSL --connect-timeout 8 --max-time 40 "$BASE/$f" -o "$tmp/$f"
  [ "$(git hash-object "$tmp/$f")" = "$sha" ] || { echo LOCK_HASH_MISMATCH; exit 2; }
  n=$((n+1))
done < "$tmp/MANIFEST"
[ "$n" -eq 14 ] || { echo LOCK_FILE_COUNT_BAD; exit 2; }
[ -d /tmp/wxeng ] && [ ! -L /tmp/wxeng ] && [ "$(stat -c '%u' /tmp/wxeng)" -eq 1000 ] || { echo LOCK_STAGE_DIR_INVALID; exit 2; }
for f in engine.py atspi_backend.py ui_primitives.py benchmark_gate_f_readsafe.py pointer_mapping.py x11_modal_guard.py popup_closure.py gate_click_accuracy.py wechat_ui_ladder_v3.py with_wechat_env.sh gate_file_chooser_once.py wechat_popup_e2e_v4.py gate_h_send_once.py wechat_live_lock.py; do
  [ ! -L "/tmp/wxeng/$f" ] || { echo LOCK_TARGET_SYMLINK; exit 2; }
  install -m 0600 "$tmp/$f" "/tmp/wxeng/$f"
done
cd /tmp/wxeng
python3 -m py_compile engine.py atspi_backend.py ui_primitives.py benchmark_gate_f_readsafe.py pointer_mapping.py x11_modal_guard.py popup_closure.py gate_click_accuracy.py wechat_ui_ladder_v3.py gate_file_chooser_once.py wechat_popup_e2e_v4.py gate_h_send_once.py wechat_live_lock.py
echo "WX_FLOCK_STAGE_OK count=14 all_blobs_verified=True tests_public=False no_gui=True"
