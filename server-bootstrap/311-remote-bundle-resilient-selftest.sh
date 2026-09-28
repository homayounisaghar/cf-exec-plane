#!/usr/bin/env bash
set -euo pipefail
umask 077
root="/root/.cf-resilient-runner-selftest"
mkdir -p "$root"
chmod 700 "$root"
token="${GITHUB_RUN_ID:-remote}-$$"
printf '%s\n' "$token" > "$root/started"
sleep 8
printf '%s\n' "$token" > "$root/completed"
[[ "$(cat "$root/started")" == "$(cat "$root/completed")" ]]
echo CF_REMOTE_RESILIENT_SELFTEST=pass
