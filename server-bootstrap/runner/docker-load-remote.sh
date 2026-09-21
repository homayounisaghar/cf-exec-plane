#!/usr/bin/env bash
set -euo pipefail
umask 077

image_ref="${1:?usage: docker-load-remote.sh <local-image-ref>}"
case "$image_ref" in
  capability-fabric/pcg-tdlib-python:*) ;;
  *) echo "unsupported image ref" >&2; exit 2 ;;
esac

: "${VPS_SSH_KEY:?VPS_SSH_KEY is required}"
: "${VPS_HOST:?VPS_HOST is required}"
: "${VPS_SSH_USER:?VPS_SSH_USER is required}"
: "${VPS_HOST_KEY:?VPS_HOST_KEY is required}"
port="${VPS_PORT:-22}"
case "$port" in ''|*[!0-9]*) echo "VPS_PORT must be numeric" >&2; exit 2 ;; esac
case "$VPS_SSH_USER" in ''|*[!a-zA-Z0-9_-]*) echo "VPS_SSH_USER contains unsupported characters" >&2; exit 2 ;; esac

local_id="$(docker image inspect "$image_ref" --format '{{.Id}}')"
[[ "$local_id" =~ ^sha256:[0-9a-f]{64}$ ]] || { echo "invalid local image id" >&2; exit 3; }

key_file="$(mktemp "${RUNNER_TEMP:-/tmp}/cf-vps-key.XXXXXX")"
known_hosts="$(mktemp "${RUNNER_TEMP:-/tmp}/cf-known-hosts.XXXXXX")"
trap 'rm -f "$key_file" "$known_hosts"' EXIT
printf '%s\n' "$VPS_SSH_KEY" > "$key_file"
chmod 0600 "$key_file"
host_key_line="${VPS_HOST_KEY//$'\r'/}"
read -r key_type key_data extra <<< "$host_key_line"
[[ "$key_type" == ssh-ed25519 && -n "$key_data" && -z "${extra:-}" ]] || exit 4
printf '%s %s %s\n' "$VPS_HOST" "$key_type" "$key_data" > "$known_hosts"
printf '[%s]:%s %s %s\n' "$VPS_HOST" "$port" "$key_type" "$key_data" >> "$known_hosts"
chmod 0600 "$known_hosts"
ssh_opts=(-i "$key_file" -p "$port" -o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile="$known_hosts" -o ConnectTimeout=15)

docker save "$image_ref" | gzip -1 | ssh "${ssh_opts[@]}" "${VPS_SSH_USER}@${VPS_HOST}" 'set -euo pipefail; gzip -dc | docker load >/dev/null'

printf -v qref '%q' "$image_ref"
remote_id="$(ssh "${ssh_opts[@]}" "${VPS_SSH_USER}@${VPS_HOST}" "docker image inspect $qref --format '{{.Id}}'")"
[[ "$remote_id" == "$local_id" ]] || {
  echo "remote image id mismatch" >&2
  exit 5
}
echo "PCG_TDLIB_IMAGE_REF=$image_ref"
echo "PCG_TDLIB_IMAGE_ID=$local_id"
echo "PCG_TDLIB_REMOTE_LOAD=pass"
