#!/usr/bin/env bash
set -euo pipefail

[[ "$(id -u)" -eq 0 ]] || { echo "must run as uid 0" >&2; exit 1; }
echo "BLOCKED: backup backend and tested restore path are not yet provisioned" >&2
exit 31
