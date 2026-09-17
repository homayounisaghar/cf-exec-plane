#!/usr/bin/env bash
set -euo pipefail

script_rel="${1:?usage: remote-exec.sh <server-bootstrap-script>}"
: "${VPS_SSH_KEY:?VPS_SSH_KEY is required}"
: "${VPS_HOST:?VPS_HOST is required}"
: "${VPS_SSH_USER:?VPS_SSH_USER is required}"
: "${VPS_HOST_KEY:?VPS_HOST_KEY is required}"
port="${VPS_PORT:-22}"

case "$port" in ''|*[!0-9]*) echo "VPS_PORT must be numeric" >&2; exit 2 ;; esac
case "$VPS_SSH_USER" in ''|*[!a-zA-Z0-9_-]*) echo "VPS_SSH_USER contains unsupported characters" >&2; exit 2 ;; esac
[[ "$VPS_HOST" != *"@"* ]] || { echo "VPS_HOST must contain only the address/hostname" >&2; exit 2; }

workspace="${GITHUB_WORKSPACE:-$(pwd)}"
script_path="$workspace/$script_rel"
[[ -f "$script_path" ]] || { echo "bootstrap script not found" >&2; exit 2; }

key_file="$(mktemp "${RUNNER_TEMP:-/tmp}/cf-vps-key.XXXXXX")"
known_hosts="$(mktemp "${RUNNER_TEMP:-/tmp}/cf-known-hosts.XXXXXX")"
cleanup() {
  rm -f "$key_file" "$known_hosts"
}
trap cleanup EXIT

umask 077
printf '%s\n' "$VPS_SSH_KEY" > "$key_file"
chmod 600 "$key_file"

# VPS_HOST_KEY is deliberately a single endpoint-free line:
#   ssh-ed25519 <base64-public-key>
# The endpoint field required by known_hosts is constructed here at runtime
# from VPS_HOST and VPS_PORT, so neither host nor trust file is committed.
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

ssh_opts=(
  -i "$key_file"
  -p "$port"
  -o BatchMode=yes
  -o IdentitiesOnly=yes
  -o StrictHostKeyChecking=yes
  -o UserKnownHostsFile="$known_hosts"
  -o ConnectTimeout=15
  -o ServerAliveInterval=15
  -o ServerAliveCountMax=2
)

remote_env=("VPS_SSH_PORT=$port")
if [[ -n "${CF_ADMIN_USER:-}" ]]; then
  remote_env+=("CF_ADMIN_USER=$CF_ADMIN_USER")
fi
if [[ -n "${CF_SWAPFILE_BYTES:-}" ]]; then
  remote_env+=("CF_SWAPFILE_BYTES=$CF_SWAPFILE_BYTES")
fi
remote_cmd='env'
for kv in "${remote_env[@]}"; do
  printf -v q '%q' "$kv"
  remote_cmd+=" $q"
done
remote_cmd+=' bash -s'

ssh "${ssh_opts[@]}" "${VPS_SSH_USER}@${VPS_HOST}" "$remote_cmd" < "$script_path"
