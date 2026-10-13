#!/bin/sh
# Immutable public runtime only; staging has no UI, keyboard, mouse, or send effects.
set -eu
umask 077
[ "$(id -u)" -eq 1000 ] || { echo "STAGE_WRONG_UID"; exit 2; }
[ "${1:-}" = "--stage-only" ] || { echo "STAGE_ONLY_ALLOWED"; exit 2; }
[ -z "${WX_GATE_H_SEND_ONCE:-}" ] && [ -z "${WX_GATE_H_TEXT:-}" ] || { echo "SEND_ENV_FORBIDDEN"; exit 2; }
command -v curl >/dev/null && command -v git >/dev/null || { echo "STAGE_TOOLS_MISSING"; exit 2; }
BASE=https://raw.githubusercontent.com/homayounisaghar/cf-exec-plane/847b03930df369420e5939ba9f35084474b42f3b/research-stage/wechat-ui-engine-v2/be50f8a35d5bce32862fe0e964aed2e9d284334d
MANIFEST_BLOB=ba3ba58ce96acfad903e13d7e6b5c2b911591b0e
tmp=$(mktemp -d /tmp/wx-v3-file-fix.XXXXXXXX)
trap 'rm -rf "$tmp"' EXIT HUP INT TERM
curl -fsSL --connect-timeout 8 --max-time 45 "$BASE/MANIFEST" -o "$tmp/MANIFEST"
[ "$(git hash-object "$tmp/MANIFEST")" = "$MANIFEST_BLOB" ] || { echo "MANIFEST_MISMATCH"; exit 2; }
n=0
while read -r sha name extra || [ -n "${sha:-}" ]; do
  case "$sha" in ""|\#*) continue;; esac
  case "$name" in
    engine.py|atspi_backend.py|ui_primitives.py|benchmark_gate_f_readsafe.py|pointer_mapping.py|x11_modal_guard.py|popup_closure.py|gate_click_accuracy.py|wechat_ui_ladder_v3.py|with_wechat_env.sh|gate_file_chooser_once.py) ;;
    *) echo "UNEXPECTED_STAGE_FILE"; exit 2;;
  esac
  [ -z "${extra:-}" ] && [ ! -e "$tmp/$name" ] || { echo "BAD_MANIFEST_ENTRY"; exit 2; }
  curl -fsSL --connect-timeout 8 --max-time 45 "$BASE/$name" -o "$tmp/$name"
  [ "$(git hash-object "$tmp/$name")" = "$sha" ] || { echo "STAGE_BLOB_MISMATCH $name"; exit 2; }
  n=$((n+1))
done < "$tmp/MANIFEST"
[ "$n" -eq 11 ] || { echo "STAGE_COUNT_MISMATCH"; exit 2; }
[ -d /tmp/wxeng ] && [ ! -L /tmp/wxeng ] && [ "$(stat -c '%u' /tmp/wxeng)" -eq "$(id -u)" ] || { echo "STAGE_DIR_UNSAFE"; exit 2; }
for name in engine.py atspi_backend.py ui_primitives.py benchmark_gate_f_readsafe.py pointer_mapping.py x11_modal_guard.py popup_closure.py gate_click_accuracy.py wechat_ui_ladder_v3.py with_wechat_env.sh gate_file_chooser_once.py; do
  [ ! -L "/tmp/wxeng/$name" ] || { echo "STAGE_TARGET_SYMLINK"; exit 2; }
  install -m 0600 "$tmp/$name" "/tmp/wxeng/$name"
done
cd /tmp/wxeng
python3 -m py_compile engine.py atspi_backend.py ui_primitives.py benchmark_gate_f_readsafe.py pointer_mapping.py x11_modal_guard.py popup_closure.py gate_click_accuracy.py wechat_ui_ladder_v3.py gate_file_chooser_once.py
echo "WX_V3_FILE_GUARD_STAGED count=11 hashes_verified=True tests_published=False no_ui_effects=True"
