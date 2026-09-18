#!/usr/bin/env bash
set -euo pipefail
umask 077
: "${VPS_SSH_KEY:?VPS_SSH_KEY is required}"
: "${CF_ADMIN_USER:?CF_ADMIN_USER is required}"
: "${CF_DEPLOY_SIGNING_PUBLIC_KEY:?CF_DEPLOY_SIGNING_PUBLIC_KEY is required}"
tmp="$(mktemp "${RUNNER_TEMP:-/tmp}/cf-stage2-overlap-key.XXXXXX")"
trap 'rm -f "$tmp"' EXIT
printf '%s\n' "$VPS_SSH_KEY" > "$tmp"
chmod 0600 "$tmp"
raw="$(ssh-keygen -y -f "$tmp")"
read -r kt kd _ <<< "$raw"
[[ "$kt" == ssh-ed25519 && -n "$kd" ]] || exit 3
export CF_NEW_SSH_PUBLIC_KEY="$kt $kd"
bash server-bootstrap/runner/remote-bundle-exec.sh server-bootstrap/74-stage2-verify-overlap.sh
