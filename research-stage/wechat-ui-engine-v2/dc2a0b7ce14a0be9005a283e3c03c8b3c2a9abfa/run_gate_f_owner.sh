#!/usr/bin/env bash
# Gate F: local only, no provider Send, no Return, no network, no private content.
set -u
[ "$(id -u)" -eq 1000 ] || { echo 'WRONG_UID EXIT=2'; exit 2; }
cd "$(dirname "$0")" || { echo 'STAGING_MISSING EXIT=2'; exit 2; }
python3 -m py_compile ./*.py
rc=$?
echo "ALL_PY_COMPILE_EXIT=$rc"
[ "$rc" -eq 0 ] || { echo 'OFFLINE_PY_COMPILE_FAILED EXIT=2'; exit 2; }

# Public bootstrap verifies each file's Git blob before running this script.
# Legacy tests are directly executed Python scripts, NOT unittest modules.
for pair in test_engine.py:20/20 test_ui_primitives.py:19/19 \
            test_benchmark_gate_f.py:6/6 test_atspi_text_safety.py:6/6
do
  file=${pair%%:*}; count=${pair#*:}
  output=$(WX_GATE_F_TARGET=FixtureRecipient python3 "$file" 2>&1); rc=$?
  printf 'TEST %s EXIT=%d EXPECTED=%s\n' "$file" "$rc" "$count"
  if [ "$rc" -ne 0 ] || ! printf '%s\n' "$output" | grep -Fxq "$count passed"; then
    printf '%s\n' "$output"; echo 'OFFLINE_LEGACY_FAILED EXIT=2'; exit 2
  fi
done

output=$(WX_GATE_F_TARGET=FixtureRecipient python3 -m unittest -q test_benchmark_gate_f_readsafe 2>&1); rc=$?
printf '%s\n' "$output"
printf 'READSAFE_EXIT=%d\n' "$rc"
if [ "$rc" -ne 0 ] || ! printf '%s\n' "$output" | grep -Eq '^Ran 42 tests in ' \
   || ! printf '%s\n' "$output" | grep -Fxq OK; then
  echo 'OFFLINE_READSAFE_FAILED EXIT=2'; exit 2
fi

if [ "${1:-}" = "--offline-only" ]; then
  echo "OFFLINE_GATE_F_PASS no_send=True"
  exit 0
fi
[ -n "${WX_GATE_F_TARGET:-}" ] || { echo 'TARGET_ENV_REQUIRED EXIT=2'; exit 2; }

output=$(bash with_wechat_env.sh python3 benchmark_gate_f_readsafe.py --clipboard-preflight 2>&1); rc=$?
printf '%s\n' "$output"
printf 'XCLIP_PREFLIGHT_EXIT=%d\n' "$rc"
if [ "$rc" -ne 0 ] || ! printf '%s\n' "$output" | grep -Fq 'XCLIP_PREFLIGHT matched=True cleared=True'; then
  echo 'CLIPBOARD_BLOCKED EXIT=4'; exit 4
fi

output=$(bash with_wechat_env.sh python3 benchmark_gate_f_readsafe.py --targets-readonly 2>&1); rc=$?
printf '%s\n' "$output"
printf 'TARGETS_READONLY_EXIT=%d\n' "$rc"
if [ "$rc" -ne 0 ] || ! printf '%s\n' "$output" | grep -Fq 'BENCH_READONLY_READY=True no_send=True'; then
  echo 'TARGETS_BLOCKED EXIT=2'; exit 2
fi

# ASCII first, then Persian/emoji; NEVER Send/Return; cleanup each.
bash with_wechat_env.sh python3 benchmark_gate_f_readsafe.py --unread-zero-verified
rc=$?
printf 'DRAFT_ONLY_EXIT=%d\n' "$rc"
exit "$rc"
