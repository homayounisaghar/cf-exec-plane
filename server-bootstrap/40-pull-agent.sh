#!/usr/bin/env bash
set -euo pipefail

[[ "$(id -u)" -eq 0 ]] || { echo "must run as uid 0" >&2; exit 1; }
echo "BLOCKED: pull-agent implementation frontier not yet completed" >&2
exit 22
