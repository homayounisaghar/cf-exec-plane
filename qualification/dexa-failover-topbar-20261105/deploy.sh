#!/usr/bin/env bash
set -euo pipefail
[[ "$(id -un)" == "cfserver" ]] || { echo WRONG_OWNER; exit 2; }
export XDG_RUNTIME_DIR=/run/user/1000

SRC=/tmp/dexa-failover-topbar-20261105
TARGET=/home/cfserver/.local/share/dexa-lite-20261103/lite-gateway.mjs
BACKUP_DIR=/home/cfserver/.local/share/dexa-failover-topbar-20261105
BACKUP="$BACKUP_DIR/lite-gateway.previous.mjs"
BEFORE=7bf000e95c9a78f0787238c945ffaf6c941354a0dd920f605d0f06cacef4cc71
AFTER=0bde41d448b39dbae90583dcfebeece3ab64e4f0cf99856ba7aaee88997dcbcb

test -f "$SRC/lite-gateway.mjs" && test -f "$TARGET"
[[ ! -L "$TARGET" ]] || { echo SYMLINK_REFUSED; exit 2; }
echo "$AFTER  $SRC/lite-gateway.mjs" | sha256sum -c -
node --check "$SRC/lite-gateway.mjs"
systemctl --user is-active --quiet dexa-main.service
systemctl --user is-active --quiet dexa-lite.service
current=$(sha256sum "$TARGET" | cut -d' ' -f1)
if [[ "$current" == "$AFTER" ]]; then
  echo "DEXA_FAILOVER_TOPBAR_ALREADY_DEPLOYED"
  exit 0
fi
[[ "$current" == "$BEFORE" ]] || { echo UNEXPECTED_LIVE_GATEWAY_SOURCE; exit 3; }

mkdir -p -m 700 "$BACKUP_DIR"
[[ ! -e "$BACKUP" ]] || { echo BACKUP_ALREADY_EXISTS_STOP; exit 4; }
install -m 600 "$TARGET" "$BACKUP"

rollback(){
  echo "ROLLBACK_DEXA_LITE_ONLY"
  install -m 600 "$BACKUP" "$TARGET"
  systemctl --user restart dexa-lite.service || true
}
applied=0
on_exit(){
  code=$?
  if [[ "$code" -ne 0 && "$applied" -eq 1 ]]; then rollback; fi
  exit "$code"
}
trap on_exit EXIT

# This is a Lite-only restart. The main Dexa engine, journal and Cloudflare Workers are untouched.
install -m 600 "$SRC/lite-gateway.mjs" "$TARGET"
applied=1
systemctl --user restart dexa-lite.service

local_health=0
for attempt in {1..25}; do
  local_health=$(curl -sS --max-time 2 -o /dev/null -w '%{http_code}' http://127.0.0.1:9518/_local-health || true)
  [[ "$local_health" == "200" ]] && break
  sleep 0.4
done
[[ "$local_health" == "200" ]] || { echo LOCAL_LITE_UNHEALTHY; exit 5; }

get_code(){
  curl -sS --max-time 9 -o /dev/null -w '%{http_code}' "$1" || true
}
[[ "$(get_code 'https://cf-onshape.duckdns.org/dexa-lite/check')" == "200" ]] || { echo LITE_HTTPS_CHECK_FAILED; exit 6; }
[[ "$(get_code 'https://cf-onshape.duckdns.org/dexa-lite/')" == "401" ]] || { echo LITE_AUTH_REGRESSION; exit 7; }
[[ "$(get_code 'https://cf-onshape.duckdns.org/dexa-mobile/')" == "401" ]] || { echo MAIN_AUTH_REGRESSION; exit 8; }
[[ "$(get_code 'http://127.0.0.1:9471/healthz')" == "200" ]] || { echo MAIN_HEALTH_REGRESSION; exit 9; }
systemctl --user is-active --quiet dexa-main.service
systemctl --user is-active --quiet dexa-lite.service
test "$(sha256sum "$TARGET" | cut -d' ' -f1)" = "$AFTER"
applied=0
echo "DEXA_FAILOVER_TOPBAR_LITE_ONLY_DEPLOY_VERIFIED"
