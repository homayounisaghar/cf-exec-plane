#!/usr/bin/env bash
set -euo pipefail
umask 077

[[ "$(id -u)" -eq 0 ]] || { echo "must run as root" >&2; exit 1; }

payload="server-bootstrap/.runtime/paa-command-payload.bin"
private_key=/etc/capability-fabric/secrets/android-agent/producer-p256-v1.pem
public_key=/etc/capability-fabric/trust/android-agent/producer-p256-v1.pub.pem
key_id=personal-android-agent-producer-v1

[[ -s "$payload" ]] || { echo "payload missing" >&2; exit 10; }
[[ "$(stat -c '%s' "$payload")" -le 65536 ]] || { echo "payload too large" >&2; exit 11; }
[[ "$(stat -c '%U:%G:%a' "$private_key")" == root:root:600 ]] || { echo "producer key unavailable" >&2; exit 12; }
[[ -s "$public_key" ]] || { echo "producer public key unavailable" >&2; exit 13; }

sig="$(mktemp)"
trap 'rm -f "$sig"' EXIT
openssl dgst -sha256 -sign "$private_key" -out "$sig" "$payload"
openssl dgst -sha256 -verify "$public_key" -signature "$sig" "$payload" >/dev/null

sig_b64url="$(base64 -w 0 "$sig" | tr '+/' '-_' | tr -d '=')"
[[ -n "$sig_b64url" ]]

printf 'CF_PAA_PRODUCER_KEY_ID=%s\n' "$key_id"
printf 'CF_PAA_PRODUCER_SIGNATURE_B64URL=%s\n' "$sig_b64url"
printf 'CF_PAA_PRODUCER_SIGN_VERIFY=pass\n'
