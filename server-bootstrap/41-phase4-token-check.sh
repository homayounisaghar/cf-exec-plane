#!/usr/bin/env bash
set -euo pipefail
[[ "$(id -u)" -eq 0 ]] || exit 1
credential=/etc/capability-fabric/secrets/repo-read-token
[[ -s "$credential" ]] || { echo "REPO_READ_ACCESS=missing" >&2; exit 20; }
[[ "$(stat -c %U:%G:%a "$credential")" == root:root:600 ]] || { echo "REPO_READ_ACCESS=unsafe-file-mode" >&2; exit 20; }
command -v curl >/dev/null 2>&1 || { echo "REPO_READ_ACCESS=curl-missing" >&2; exit 20; }
cfg="$(mktemp)"
trap 'rm -f "$cfg"' EXIT
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
if ! curl -K "$cfg" 'https://api.github.com/repos/homayounisaghar/capability-fabric/commits/main' -o /dev/null; then
  echo "REPO_READ_ACCESS=failed" >&2
  exit 20
fi
printf 'REPO_READ_ACCESS=ok\n'
