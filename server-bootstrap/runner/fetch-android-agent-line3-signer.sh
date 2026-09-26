#!/usr/bin/env bash
set -euo pipefail
umask 077

dest="$1"
[[ -n "$dest" ]] || { echo "destination required" >&2; exit 2; }
: "$VPS_SSH_KEY"
: "$VPS_HOST"
: "$VPS_SSH_USER"
: "$VPS_HOST_KEY"
port="$VPS_PORT"
[[ -n "$port" ]] || port=22

mkdir -p "$dest"
chmod 700 "$dest"

key_file="$(mktemp "$RUNNER_TEMP/cf-vps-key.XXXXXX")"
known_hosts="$(mktemp "$RUNNER_TEMP/cf-known-hosts.XXXXXX")"
cleanup() { rm -f "$key_file" "$known_hosts"; }
trap cleanup EXIT

printf '%s\n' "$VPS_SSH_KEY" > "$key_file"
chmod 600 "$key_file"
host_key_line="$(printf '%s' "$VPS_HOST_KEY" | tr -d '\r')"
read -r key_type key_data extra <<EOF
$host_key_line
EOF
[[ "$key_type" == ssh-ed25519 && -n "$key_data" && -z "$extra" ]] || exit 3
printf '%s %s %s\n' "$VPS_HOST" "$key_type" "$key_data" > "$known_hosts"
printf '[%s]:%s %s %s\n' "$VPS_HOST" "$port" "$key_type" "$key_data" >> "$known_hosts"
chmod 600 "$known_hosts"

remote_base=/etc/capability-fabric/secrets/android-agent/line3
common=(-i "$key_file" -P "$port" -o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile="$known_hosts" -o ConnectTimeout=15)
scp "${common[@]}" "$VPS_SSH_USER@$VPS_HOST:$remote_base/personal-android-agent-line3.p12" "$dest/signer.p12"
scp "${common[@]}" "$VPS_SSH_USER@$VPS_HOST:$remote_base/personal-android-agent-line3.pass" "$dest/signer.pass"
scp "${common[@]}" "$VPS_SSH_USER@$VPS_HOST:/etc/capability-fabric/trust/android-agent/personal-android-agent-line3-cert.pem" "$dest/signer-cert.pem"
chmod 600 "$dest/signer.p12" "$dest/signer.pass"
chmod 644 "$dest/signer-cert.pem"
