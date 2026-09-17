#!/usr/bin/env bash
set -euo pipefail

mode="${1:?usage: install-server-material.sh <token|signing-key>}"
: "${VPS_SSH_KEY:?VPS_SSH_KEY is required}"
: "${VPS_HOST:?VPS_HOST is required}"
: "${VPS_SSH_USER:?VPS_SSH_USER is required}"
: "${VPS_HOST_KEY:?VPS_HOST_KEY is required}"
port="${VPS_PORT:-22}"
case "$port" in ''|*[!0-9]*) echo "VPS_PORT must be numeric" >&2; exit 2 ;; esac
case "$VPS_SSH_USER" in ''|*[!a-zA-Z0-9_-]*) echo "VPS_SSH_USER contains unsupported characters" >&2; exit 2 ;; esac

case "$mode" in
  token)
    : "${CF_REPO_READ_TOKEN:?CF_REPO_READ_TOKEN is required}"
    payload="$CF_REPO_READ_TOKEN"
    remote_cmd='set -euo pipefail; umask 077; install -d -m 0700 -o root -g root /etc/capability-fabric/secrets; t=$(mktemp /etc/capability-fabric/secrets/.repo-read-token.XXXXXX); trap '\''rm -f "$t"'\'' EXIT; cat > "$t"; test -s "$t"; chown root:root "$t"; chmod 0600 "$t"; mv -f "$t" /etc/capability-fabric/secrets/repo-read-token; trap - EXIT; printf "CF_MATERIAL_INSTALL=repo-token-ok\n"'
    ;;
  signing-key)
    : "${CF_DEPLOY_SIGNING_PUBLIC_KEY:?CF_DEPLOY_SIGNING_PUBLIC_KEY is required}"
    payload="${CF_DEPLOY_SIGNING_PUBLIC_KEY//$'\r'/}"
    [[ "$payload" != *$'\n'* ]] || { echo "deployment signing public key must be one line" >&2; exit 2; }
    read -r kt kd extra <<< "$payload"
    [[ "$kt" == ssh-ed25519 && -n "$kd" && -z "${extra:-}" ]] || { echo "deployment signing public key must be exactly: ssh-ed25519 <base64>" >&2; exit 2; }
    case "$kd" in *[!A-Za-z0-9+/=]*) echo "deployment signing public key data malformed" >&2; exit 2 ;; esac
    remote_cmd='set -euo pipefail; umask 077; install -d -m 0755 -o root -g root /etc/capability-fabric/trust; t=$(mktemp /etc/capability-fabric/trust/.deploy-signing.XXXXXX); trap '\''rm -f "$t"'\'' EXIT; cat > "$t"; test -s "$t"; chown root:root "$t"; chmod 0644 "$t"; mv -f "$t" /etc/capability-fabric/trust/deploy-signing.pub; trap - EXIT; printf "CF_MATERIAL_INSTALL=signing-key-ok\n"'
    ;;
  *) echo "invalid material mode" >&2; exit 2 ;;
esac

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

printf '%s' "$payload" | ssh \
  -i "$key_file" -p "$port" -o BatchMode=yes -o IdentitiesOnly=yes \
  -o StrictHostKeyChecking=yes -o UserKnownHostsFile="$known_hosts" \
  -o ConnectTimeout=15 "${VPS_SSH_USER}@${VPS_HOST}" "$remote_cmd"
