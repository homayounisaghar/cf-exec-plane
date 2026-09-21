#!/usr/bin/env bash
set -euo pipefail
umask 077

image_ref="${1:?usage: remote-pull-image.sh <ghcr digest ref>}"
case "$image_ref" in
  ghcr.io/homayounisaghar/pcg-tdlib-python@sha256:*) ;;
  *) echo "unsupported image reference" >&2; exit 2 ;;
esac
digest="${image_ref##*@}"
[[ "$digest" =~ ^sha256:[0-9a-f]{64}$ ]] || { echo "invalid image digest" >&2; exit 2; }

: "${VPS_SSH_KEY:?VPS_SSH_KEY is required}"
: "${VPS_HOST:?VPS_HOST is required}"
: "${VPS_SSH_USER:?VPS_SSH_USER is required}"
: "${VPS_HOST_KEY:?VPS_HOST_KEY is required}"
port="${VPS_PORT:-22}"

key_file="$(mktemp "${RUNNER_TEMP:-/tmp}/cf-vps-key.XXXXXX")"
known_hosts="$(mktemp "${RUNNER_TEMP:-/tmp}/cf-known-hosts.XXXXXX")"
trap 'rm -f "$key_file" "$known_hosts"' EXIT
printf '%s\n' "$VPS_SSH_KEY" > "$key_file"
chmod 0600 "$key_file"
host_key_line="${VPS_HOST_KEY//$'\r'/}"
read -r key_type key_data extra <<< "$host_key_line"
[[ "$key_type" == ssh-ed25519 && -n "$key_data" && -z "${extra:-}" ]] || exit 3
printf '%s %s %s\n' "$VPS_HOST" "$key_type" "$key_data" > "$known_hosts"
printf '[%s]:%s %s %s\n' "$VPS_HOST" "$port" "$key_type" "$key_data" >> "$known_hosts"
chmod 0600 "$known_hosts"
ssh_opts=(-i "$key_file" -p "$port" -o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile="$known_hosts" -o ConnectTimeout=15)

printf -v qref '%q' "$image_ref"
remote_output="$(ssh "${ssh_opts[@]}" "${VPS_SSH_USER}@${VPS_HOST}" "set -euo pipefail; docker logout ghcr.io >/dev/null 2>&1 || true; docker pull $qref >/dev/null; docker image inspect $qref --format '{{json .RepoDigests}}'")"
grep -Fq "$digest" <<<"$remote_output" || {
  echo "remote image digest verification failed" >&2
  exit 4
}
echo "PCG_TDLIB_ANONYMOUS_PULL=pass"
echo "PCG_TDLIB_REMOTE_DIGEST=$digest"
