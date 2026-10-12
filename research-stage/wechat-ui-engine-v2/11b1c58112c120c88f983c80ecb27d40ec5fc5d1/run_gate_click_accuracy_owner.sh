#!/usr/bin/env bash
# Owner only: immutable click-accuracy qualification; NEVER sends a message.
set -euo pipefail
[ "$(id -u)" -eq 1000 ] || { echo "GATE_CLICK_WRONG_UID"; exit 2; }
cd "$(dirname "$0")"
python3 -m py_compile ./*.py
echo 'CLICK_PY_COMPILE_PASS'
for pair in test_engine.py:20/20 test_ui_primitives.py:19/19 test_benchmark_gate_f.py:6/6 test_atspi_text_safety.py:6/6; do
  t=${pair%%:*}; expected=${pair#*:}
  output=$(WX_GATE_F_TARGET=FixtureRecipient python3 "$t" 2>&1) || { echo "CLICK_LEGACY_FAILED $t"; exit 2; }
  printf '%s\n' "$output" | grep -Fxq "$expected passed" || { echo "CLICK_LEGACY_COUNT_BAD $t"; exit 2; }
  echo "CLICK_LEGACY_PASS $t $expected"
done
for pair in test_benchmark_gate_f_readsafe:45 test_gate_h_send_once:42 test_gate_click_accuracy:20; do
  t=${pair%%:*}; expected=${pair#*:}
  output=$(WX_GATE_F_TARGET=FixtureRecipient python3 -m unittest -q "$t" 2>&1) || {
    printf '%s\n' "$output"; echo "CLICK_TEST_FAILED $t"; exit 2;
  }
  printf '%s\n' "$output" | grep -Eq "^Ran $expected tests in " &&
  printf '%s\n' "$output" | grep -Fxq OK || {
    printf '%s\n' "$output"; echo "CLICK_TEST_COUNT_BAD $t"; exit 2;
  }
  echo "CLICK_OFFLINE_PASS $t count=$expected"
done
if [ "${1:-}" = "--offline-only" ]; then
  echo "GATE_CLICK_OFFLINE_OK no_gui_effects=True"
  exit 0
fi
[ "${1:-}" = "--click-accuracy" ] || { echo "GATE_CLICK_MODE_REQUIRED"; exit 2; }
[ "${WX_GATE_CLICK_ACCURACY:-}" = 1 ] &&
[ "${WX_GATE_CLICK_UNREAD_ZERO_VERIFIED:-}" = 1 ] &&
[ -n "${WX_GATE_F_TARGET:-}" ] || { echo "GATE_CLICK_OWNER_PREFLIGHT_REQUIRED"; exit 2; }
[ -z "${WX_GATE_H_SEND_ONCE:-}" ] && [ -z "${WX_GATE_H_TEXT:-}" ] || {
  echo "GATE_CLICK_SEND_FLAGS_FORBIDDEN"; exit 2;
}
bash with_wechat_env.sh python3 gate_click_accuracy.py
result=$?
echo "GATE_CLICK_EXIT=$result"
exit "$result"
