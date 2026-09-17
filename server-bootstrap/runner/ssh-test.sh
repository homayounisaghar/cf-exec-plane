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

valid_host_key_lines=0
while IFS= read -r line; do
  [[ -n "$line" ]] || continue
  key_type="${line%% *}"
  key_data="${line#* }"
  case "$key_type" in ssh-ed25519|ssh-rsa|rsa-sha2-*|ecdsa-sha2-*) ;; *) exit 3 ;; esac
  case "$key_data" in ''|*[!A-Za-z0-9+/=]*) exit 3 ;; esac
  printf '%s %s %s\n' "$VPS_HOST" "$key_type" "$key_data" >> "$known_hosts"
  printf '[%s]:%s %s %s\n' "$VPS_HOST" "$port" "$key_type" "$key_data" >> "$known_hosts"
  valid_host_key_lines=$((valid_host_key_lines + 1))
done <<< "$VPS_HOST_KEY"
(( valid_host_key_lines > 0 )) || exit 3
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
