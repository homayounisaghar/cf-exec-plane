#!/usr/bin/env bash
set -euo pipefail

: "${VPS_SSH_KEY:?VPS_SSH_KEY is required}"
: "${VPS_HOST:?VPS_HOST is required}"
: "${VPS_TEST_USER:?VPS_TEST_USER is required}"
: "${VPS_HOST_KEY:?VPS_HOST_KEY is required}"
port="${VPS_PORT:-22}"
require_sudo="${REQUIRE_SUDO:-no}"

case "$port" in ''|*[!0-9]*) echo "VPS_PORT must be numeric" >&2; exit 2 ;; esac
case "$VPS_TEST_USER" in ''|*[!a-zA-Z0-9_-]*) echo "VPS_TEST_USER contains unsupported characters" >&2; exit 2 ;; esac
case "$require_sudo" in yes|no) ;; *) echo "REQUIRE_SUDO must be yes or no" >&2; exit 2 ;; esac
[[ "$VPS_HOST" != *"@"* ]] || { echo "VPS_HOST must contain only the address/hostname" >&2; exit 2; }

key_file="$(mktemp "${RUNNER_TEMP:-/tmp}/cf-vps-key.XXXXXX")"
known_hosts="$(mktemp "${RUNNER_TEMP:-/tmp}/cf-known-hosts.XXXXXX")"
cleanup() {
  rm -f "$key_file" "$known_hosts"
}
trap cleanup EXIT

umask 077
printf '%s\n' "$VPS_SSH_KEY" > "$key_file"
chmod 600 "$key_file"

host_key_line="${VPS_HOST_KEY//$'\r'/}"
[[ "$host_key_line" != *$'\n'* ]] || { echo "VPS_HOST_KEY must contain exactly one line" >&2; exit 3; }
read -r key_type key_data extra <<< "$host_key_line"
[[ "$key_type" == "ssh-ed25519" && -n "$key_data" && -z "${extra:-}" ]] || {
  echo "VPS_HOST_KEY must be exactly: ssh-ed25519 <base64-public-key>" >&2
  exit 3
}
case "$key_data" in
  *[!A-Za-z0-9+/=]*) echo "VPS_HOST_KEY contains malformed key data" >&2; exit 3 ;;
esac
printf '%s %s %s\n' "$VPS_HOST" "$key_type" "$key_data" > "$known_hosts"
printf '[%s]:%s %s %s\n' "$VPS_HOST" "$port" "$key_type" "$key_data" >> "$known_hosts"
chmod 600 "$known_hosts"

remote_check='printf "CF_SSH_TEST_OK\\n"'
if [[ "$require_sudo" == yes ]]; then
  remote_check='sudo -n true && printf "CF_SSH_TEST_OK\\n"'
fi

ssh \
  -i "$key_file" \
  -p "$port" \
  -o BatchMode=yes \
  -o IdentitiesOnly=yes \
  -o StrictHostKeyChecking=yes \
  -o UserKnownHostsFile="$known_hosts" \
  -o ConnectTimeout=15 \
  "${VPS_TEST_USER}@${VPS_HOST}" "$remote_check"
