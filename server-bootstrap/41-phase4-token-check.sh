#!/usr/bin/env bash
set -euo pipefail
[[ "$(id -u)" -eq 0 ]] || exit 1
credential=/etc/capability-fabric/secrets/repo-read-token
[[ -s "$credential" ]] || { echo "REPO_READ_ACCESS=missing" >&2; exit 20; }
[[ "$(stat -c %U:%G:%a "$credential")" == root:root:600 ]] || { echo "REPO_READ_ACCESS=unsafe-file-mode" >&2; exit 20; }
command -v curl >/dev/null 2>&1 || { echo "REPO_READ_ACCESS=curl-missing" >&2; exit 20; }
command -v python3 >/dev/null 2>&1 || { echo "REPO_READ_ACCESS=python3-missing" >&2; exit 20; }
cfg="$(mktemp)"
out="$(mktemp)"
trap 'rm -f "$cfg" "$out"' EXIT
chmod 600 "$cfg"
token="$(cat "$credential")"
[[ -n "$token" ]] || exit 20
{
  printf 'silent\nshow-error\nfail\n'
  printf 'header = "Authorization: Bearer %s"\n' "$token"
  printf 'header = "Accept: application/vnd.github+json"\n'
  printf 'header = "X-GitHub-Api-Version: 2022-11-28"\n'
} > "$cfg"
unset token
if ! curl -K "$cfg" 'https://api.github.com/repos/homayounisaghar/capability-fabric/commits/main' -o "$out"; then
  echo "REPO_READ_ACCESS=failed" >&2
  exit 20
fi
python3 - "$out" <<'PY' >/dev/null
import json,re,sys
with open(sys.argv[1],encoding='utf-8') as f:
    data=json.load(f)
if not re.fullmatch(r'[0-9a-f]{40}', data.get('sha','')):
    raise SystemExit(1)
PY
printf 'REPO_READ_ACCESS=ok\n'
