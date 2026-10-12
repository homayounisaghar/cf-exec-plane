#!/usr/bin/env bash
# Pin all payloads to one immutable public commit and Git blob manifest.
# This Gate click accuracy runner NEVER invokes a real send.
set -euo pipefail
umask 077
BASE="https://raw.githubusercontent.com/homayounisaghar/cf-exec-plane/3e39defe8b2542f3c2162cba254fe0bb76cbabbc/research-stage/wechat-ui-engine-v2/11b1c58112c120c88f983c80ecb27d40ec5fc5d1"
EXPECTED_MANIFEST="dfe49e76582b261155d6dc2f210c96407a18d6bb"
[ "$(id -u)" -eq 1000 ] || { echo 'CLICK_STAGE_WRONG_UID'; exit 2; }
command -v curl >/dev/null && command -v git >/dev/null || { echo 'CLICK_STAGE_TOOLS_MISSING'; exit 2; }
[ -z "${WX_GATE_H_SEND_ONCE:-}" ] && [ -z "${WX_GATE_H_TEXT:-}" ] || {
  echo 'CLICK_STAGE_SEND_FLAGS_FORBIDDEN'; exit 2;
}
work=$(mktemp -d /tmp/wxgate-click-stage.XXXXXXXX) || exit 2
trap 'rm -rf "$work"' EXIT
curl -fsSL --connect-timeout 8 --max-time 35 "$BASE/MANIFEST" -o "$work/MANIFEST"
[ "$(git hash-object "$work/MANIFEST")" = "$EXPECTED_MANIFEST" ] || {
  echo 'CLICK_STAGE_MANIFEST_HASH_FAILED'; exit 2;
}
count=0
while read -r digest name extra || [ -n "$digest" ]; do
  case "$digest" in \#*|"") continue;; esac
  case "$name" in
    engine.py|atspi_backend.py|ui_primitives.py|fakes.py|benchmark_gate_f_readsafe.py|with_wechat_env.sh|test_engine.py|test_ui_primitives.py|test_benchmark_gate_f.py|test_atspi_text_safety.py|test_benchmark_gate_f_readsafe.py|gate_h_send_once.py|test_gate_h_send_once.py|pointer_mapping.py|gate_click_accuracy.py|test_gate_click_accuracy.py|run_gate_click_accuracy_owner.sh) ;;
    *) echo 'CLICK_STAGE_UNEXPECTED_FILE'; exit 2;;
  esac
  [ -z "${extra:-}" ] && [ ! -e "$work/$name" ] || { echo 'CLICK_STAGE_DUPLICATE'; exit 2; }
  curl -fsSL --connect-timeout 8 --max-time 35 "$BASE/$name" -o "$work/$name"
  [ "$(git hash-object "$work/$name")" = "$digest" ] || {
    echo "CLICK_STAGE_HASH_FAILED $name"; exit 2;
  }
  count=$((count+1))
  echo "CLICK_STAGED_VERIFIED $name"
done < "$work/MANIFEST"
[ "$count" -eq 17 ] || { echo "CLICK_STAGE_FILE_COUNT_INVALID $count"; exit 2; }
mkdir -p /tmp/wxeng
for name in engine.py atspi_backend.py ui_primitives.py fakes.py benchmark_gate_f_readsafe.py with_wechat_env.sh test_engine.py test_ui_primitives.py test_benchmark_gate_f.py test_atspi_text_safety.py test_benchmark_gate_f_readsafe.py gate_h_send_once.py test_gate_h_send_once.py pointer_mapping.py gate_click_accuracy.py test_gate_click_accuracy.py run_gate_click_accuracy_owner.sh; do
  [ ! -L "/tmp/wxeng/$name" ] || { echo 'CLICK_STAGE_SYMLINK_REFUSED'; exit 2; }
  install -m 600 "$work/$name" "/tmp/wxeng/$name"
done
cd /tmp/wxeng
echo 'CLICK_STAGE_VERIFIED count=17 no_private_fetch=True no_send=True'
bash run_gate_click_accuracy_owner.sh "$@"
