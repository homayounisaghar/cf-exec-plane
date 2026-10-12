#!/usr/bin/env bash
# Gate H owner-only ONE real Send; no Return, no retry. Private body via ENV ONLY.
set -u
[ "$(id -u)" -eq 1000 ] || { echo 'GATE_H_WRONG_UID EXIT=2'; exit 2; }
cd "$(dirname "$0")" || { echo 'GATE_H_STAGE_MISSING EXIT=2'; exit 2; }
python3 -m py_compile ./*.py; rc=$?
printf 'H_PY_COMPILE_EXIT=%s\n' "$rc"
[ "$rc" -eq 0 ] || exit 2
for pair in test_engine.py:20/20 test_ui_primitives.py:19/19 \
            test_benchmark_gate_f.py:6/6 test_atspi_text_safety.py:6/6; do
  file=${pair%%:*}; expected=${pair#*:}
  output=$(WX_GATE_F_TARGET=FixtureRecipient python3 "$file" 2>&1); rc=$?
  printf 'H_LEGACY_TEST %s EXIT=%s\n' "$file" "$rc"
  if [ "$rc" -ne 0 ] || ! printf '%s\n' "$output" | grep -Fxq "$expected passed"; then
    printf '%s\n' "$output"; echo 'H_OFFLINE_LEGACY_FAILED EXIT=2'; exit 2
  fi
done
output=$(WX_GATE_F_TARGET=FixtureRecipient python3 -m unittest -q test_benchmark_gate_f_readsafe 2>&1); rc=$?
printf '%s\n' "$output"
printf 'H_F_READSAFE_EXIT=%s\n' "$rc"
[ "$rc" -eq 0 ] && printf '%s\n' "$output" | grep -Eq '^Ran 45 tests in ' \
  && printf '%s\n' "$output" | grep -Fxq OK || { echo 'H_F_READSAFE_FAILED EXIT=2'; exit 2; }

output=$(WX_GATE_F_TARGET=FixtureRecipient python3 -m unittest -q test_gate_h_send_once 2>&1); rc=$?
printf '%s\n' "$output"
printf 'H_SEND_SAFETY_EXIT=%s\n' "$rc"
[ "$rc" -eq 0 ] && printf '%s\n' "$output" | grep -Eq '^Ran 20 tests in ' \
  && printf '%s\n' "$output" | grep -Fxq OK || { echo 'H_SEND_SAFETY_FAILED EXIT=2'; exit 2; }

if [ "${1:-}" = "--offline-only" ]; then
  echo 'H_OFFLINE_PASS no_real_send=True'
  exit 0
fi
[ "${WX_GATE_H_SEND_ONCE:-}" = "1" ] || { echo 'H_SEND_FLAG_REQUIRED EXIT=2'; exit 2; }
[ "${WX_GATE_H_UNREAD_ZERO_VERIFIED:-}" = "1" ] || { echo 'H_EXTERNAL_UNREAD_ZERO_REQUIRED EXIT=2'; exit 2; }
[ -n "${WX_GATE_F_TARGET:-}" ] && [ -n "${WX_GATE_H_TEXT:-}" ] || {
  echo 'H_TARGET_OR_MESSAGE_REQUIRED EXIT=2'; exit 2;
}
# Same PASSed F on the identical display: clipboard preflight, read-only targets.
output=$(bash with_wechat_env.sh python3 benchmark_gate_f_readsafe.py --clipboard-preflight 2>&1); rc=$?
printf '%s\n' "$output"
printf 'H_XCLIP_PREFLIGHT_EXIT=%s\n' "$rc"
[ "$rc" -eq 0 ] && printf '%s\n' "$output" | grep -Fq 'XCLIP_PREFLIGHT matched=True cleared=True' || {
  echo 'H_CLIPBOARD_BLOCKED EXIT=4'; exit 4;
}
output=$(bash with_wechat_env.sh python3 benchmark_gate_f_readsafe.py --targets-readonly 2>&1); rc=$?
printf '%s\n' "$output"
printf 'H_TARGETS_READONLY_EXIT=%s\n' "$rc"
[ "$rc" -eq 0 ] && printf '%s\n' "$output" | grep -Fq 'BENCH_READONLY_READY=True no_send=True' || {
  echo 'H_TARGETS_BLOCKED EXIT=2'; exit 2;
}
# EXACTLY ONE irreversible activation attempt. No Send retries or Return fallback.
bash with_wechat_env.sh python3 gate_h_send_once.py --unread-zero-verified
rc=$?
printf 'GATE_H_EXIT=%s\n' "$rc"
if [ "$rc" -ne 0 ]; then
  echo 'H_STOP_NO_RETRY_CHECK_PHONE'
fi
exit "$rc"
