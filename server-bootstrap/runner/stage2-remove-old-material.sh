#!/usr/bin/env bash
set -euo pipefail
umask 077

: "${VPS_SSH_KEY:?VPS_SSH_KEY is required}"
: "${CF_ADMIN_USER:?CF_ADMIN_USER is required}"
: "${CF_DEPLOY_SIGNING_PUBLIC_KEY:?CF_DEPLOY_SIGNING_PUBLIC_KEY is required}"

tmp="$(mktemp "${RUNNER_TEMP:-/tmp}/cf-stage2-new-key.XXXXXX")"
trap 'rm -f "$tmp"' EXIT
printf '%s\n' "$VPS_SSH_KEY" > "$tmp"
chmod 0600 "$tmp"
raw="$(ssh-keygen -y -f "$tmp")"
read -r kt kd _ <<< "$raw"
[[ "$kt" == ssh-ed25519 && -n "$kd" ]] || { echo "canonical VPS_SSH_KEY does not derive Ed25519" >&2; exit 3; }
case "$kd" in *[!A-Za-z0-9+/=]*) echo "derived SSH public key malformed" >&2; exit 3 ;; esac
export CF_NEW_SSH_PUBLIC_KEY="$kt $kd"
bash server-bootstrap/runner/remote-bundle-exec.sh server-bootstrap/73-stage2-cutover.sh
