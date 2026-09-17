#!/usr/bin/env bash
set -euo pipefail

script_rel="${1:?usage: remote-bundle-exec.sh <server-bootstrap-script>}"
: "${VPS_SSH_KEY:?VPS_SSH_KEY is required}"
: "${VPS_HOST:?VPS_HOST is required}"
: "${VPS_SSH_USER:?VPS_SSH_USER is required}"
: "${VPS_HOST_KEY:?VPS_HOST_KEY is required}"
port="${VPS_PORT:-22}"
case "$port" in ''|*[!0-9]*) echo "VPS_PORT must be numeric" >&2; exit 2 ;; esac
case "$VPS_SSH_USER" in ''|*[!a-zA-Z0-9_-]*) echo "VPS_SSH_USER contains unsupported characters" >&2; exit 2 ;; esac
workspace="${GITHUB_WORKSPACE:-$(pwd)}"
[[ -f "$workspace/$script_rel" ]] || { echo "bootstrap script missing" >&2; exit 2; }

key_file="$(mktemp "${RUNNER_TEMP:-/tmp}/cf-vps-key.XXXXXX")"
known_hosts="$(mktemp "${RUNNER_TEMP:-/tmp}/cf-known-hosts.XXXXXX")"
cleanup() { rm -f "$key_file" "$known_hosts"; }
trap cleanup EXIT
umask 077
printf '%s\n' "$VPS_SSH_KEY" > "$key_file"
chmod 600 "$key_file"
host_key_line="${VPS_HOST_KEY//$'\r'/}"
read -r key_type key_data extra <<< "$host_key_line"
[[ "$key_type" == ssh-ed25519 && -n "$key_data" && -z "${extra:-}" ]] || exit 3
printf '%s %s %s\n' "$VPS_HOST" "$key_type" "$key_data" > "$known_hosts"
printf '[%s]:%s %s %s\n' "$VPS_HOST" "$port" "$key_type" "$key_data" >> "$known_hosts"
chmod 600 "$known_hosts"
ssh_opts=(-i "$key_file" -p "$port" -o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile="$known_hosts" -o ConnectTimeout=15)
remote_env=("VPS_SSH_PORT=$port")
[[ -n "${CF_PHASE4_MODE:-}" ]] && remote_env+=("CF_PHASE4_MODE=$CF_PHASE4_MODE")
remote_cmd='set -euo pipefail; d=$(mktemp -d /root/.cf-bootstrap.XXXXXX); trap '\''rm -rf "$d"'\'' EXIT; tar -xzf - -C "$d"; cd "$d"; env'
for kv in "${remote_env[@]}"; do
  printf -v q '%q' "$kv"
  remote_cmd+=" $q"
done
printf -v qs '%q' "$script_rel"
remote_cmd+=" bash $qs"
tar -C "$workspace" -czf - server-bootstrap | ssh "${ssh_opts[@]}" "${VPS_SSH_USER}@${VPS_HOST}" "$remote_cmd"
