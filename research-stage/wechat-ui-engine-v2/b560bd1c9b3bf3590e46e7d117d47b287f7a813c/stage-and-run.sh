#!/usr/bin/env bash
# Immutable public, secret-free Gate H staging. Never fetch private repository.
set -euo pipefail
umask 077
BASE="https://raw.githubusercontent.com/homayounisaghar/cf-exec-plane/main/research-stage/wechat-ui-engine-v2/b560bd1c9b3bf3590e46e7d117d47b287f7a813c"
EXPECTED_MANIFEST=b6c28bf76be3e05a777a264eecadd859d8c13380
[ "$(id -u)" -eq 1000 ] || { echo "STAGING_WRONG_UID"; exit 2; }
command -v curl >/dev/null && command -v git >/dev/null || { echo "STAGING_DEPENDENCY_MISSING"; exit 2; }
work=$(mktemp -d /tmp/wxgate-stage.XXXXXXXX) || exit 2
trap 'rm -rf "$work"' EXIT
curl -fsSL --connect-timeout 8 --max-time 30 "$BASE/MANIFEST" -o "$work/MANIFEST"
[ "$(git hash-object "$work/MANIFEST")" = "$EXPECTED_MANIFEST" ] || { echo "STAGING_MANIFEST_HASH_FAILED"; exit 2; }
count=0
while read -r expected file extra || [ -n "$expected" ]; do
  case "$expected" in \#*|"") continue ;; esac
  case "$file" in
    engine.py|atspi_backend.py|ui_primitives.py|fakes.py|benchmark_gate_f_readsafe.py|test_engine.py|test_ui_primitives.py|test_benchmark_gate_f.py|test_atspi_text_safety.py|test_benchmark_gate_f_readsafe.py|with_wechat_env.sh|run_gate_f_owner.sh|gate_h_send_once.py|test_gate_h_send_once.py|run_gate_h_owner.sh) ;;
    *) echo "STAGING_UNEXPECTED_FILENAME"; exit 2 ;;
  esac
  [ -z "${extra:-}" ] && [ ! -e "$work/$file" ] || { echo "STAGING_DUPLICATE_OR_EXTRA"; exit 2; }
  curl -fsSL --connect-timeout 8 --max-time 30 "$BASE/$file" -o "$work/$file"
  got=$(git hash-object "$work/$file")
  [ "$got" = "$expected" ] || { echo "STAGING_BLOB_HASH_FAILED $file"; exit 2; }
  count=$((count+1))
  echo "STAGED_VERIFIED $file"
done < "$work/MANIFEST"
[ "$count" -eq 15 ] || { echo "STAGING_FILE_COUNT_FAILED"; exit 2; }
mkdir -p /tmp/wxeng
for file in engine.py atspi_backend.py ui_primitives.py fakes.py benchmark_gate_f_readsafe.py test_engine.py test_ui_primitives.py test_benchmark_gate_f.py test_atspi_text_safety.py test_benchmark_gate_f_readsafe.py with_wechat_env.sh run_gate_f_owner.sh gate_h_send_once.py test_gate_h_send_once.py run_gate_h_owner.sh; do
  [ ! -L "/tmp/wxeng/$file" ] || { echo "STAGING_SYMLINK_DENIED"; exit 2; }
  install -m 600 "$work/$file" "/tmp/wxeng/$file"
done
[ ! -L /tmp/wxeng/benchmark_gate_f.py ] || { echo "OLD_SCRIPT_SYMLINK_DENIED"; exit 2; }
rm -f /tmp/wxeng/benchmark_gate_f.py
cd /tmp/wxeng
echo "STAGING_MANIFEST_VERIFIED count=15 no_private_fetch=True"
bash run_gate_h_owner.sh "$@"
