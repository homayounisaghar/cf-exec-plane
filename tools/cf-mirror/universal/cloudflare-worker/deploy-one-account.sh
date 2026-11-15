#!/bin/sh
# Deploy the dedicated Worker from an authorized owner's Cloudflare account.
# Passwords are never passed into this Worker; only upstream public origin.
set -eu
: "${CLOUDFLARE_API_TOKEN:?Set Cloudflare API token privately}"
: "${CLOUDFLARE_ACCOUNT_ID:?Set Cloudflare account ID privately}"
: "${MIRROR_UPSTREAM:?Set active HTTPS quick tunnel}"
: "${PUBLIC_ORIGIN:?Set exact workers.dev HTTPS origin}"
: "${MIRROR_EXPIRES_AT:?Set session Unix expiry milliseconds}"
case "$MIRROR_UPSTREAM" in https://*.trycloudflare.com) : ;; *) echo 'Expected quick tunnel HTTPS origin' >&2; exit 2;; esac
case "$PUBLIC_ORIGIN" in https://*.workers.dev) : ;; *) echo 'Expected workers.dev HTTPS origin' >&2; exit 2;; esac
case "$MIRROR_EXPIRES_AT" in *[!0-9]*|'') echo 'Expiry must be Unix milliseconds' >&2; exit 2;; esac
command -v wrangler >/dev/null 2>&1 || { echo 'Install Wrangler in authorized Cloudflare environment' >&2; exit 3; }
HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
wrangler deploy --config "$HERE/wrangler.toml" \
 --var "MIRROR_UPSTREAM:$MIRROR_UPSTREAM" \
 --var "PUBLIC_ORIGIN:$PUBLIC_ORIGIN" \
 --var "MIRROR_EXPIRES_AT:$MIRROR_EXPIRES_AT"
