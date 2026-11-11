#!/usr/bin/env bash
# Secret-free, hash-pinned Dexa web-only v1.6.72 release. No Android/engine writes.
set -euo pipefail
umask 077
req="$1"
[[ "$req" =~ ^dexa-web1672-20261111-[0-9a-f]{8}$ ]] || exit 41
src="/tmp/$req.tgz"
archive_sha=ea566857b1b22c042849086df022f664ab43feab85e7af6177fedcbba8513dd1
cycle_sha=37d608422eeeaacf987558caccc04ba7727fbc5dc2037af26eb03b2c4726e4a8
integration_sha=38b502f41d13a7dbb5f4fd42e9332ecf7f34d1c296b2c87108b50d1e0af275c9
server_sha=57c8007436253babf8afca833bcb8c70205d0b0cdeb3028dd76b1f1d3227155c
test -f "$src" || exit 42
[[ "$(sha256sum "$src" | cut -d' ' -f1)" == "$archive_sha" ]] || exit 43
old=$(curl -fsS --max-time 6 http://127.0.0.1:4495/api/health | node -p 'JSON.parse(require("fs").readFileSync(0,"utf8")).webVersion')
[[ "$old" == web-v1.6.71 ]] || exit 44
paired=$(curl -fsS --max-time 6 http://127.0.0.1:4495/api/dexa/pair/status | node -p 'JSON.parse(require("fs").readFileSync(0,"utf8")).paired')
[[ "$paired" == true ]] || exit 45
private=/home/cfserver/.config/dexa-integration
test -f "$private/owner-token.sha256" && test -f "$private/engine-bridge-key" || exit 46
old_owner_sha=$(sha256sum "$private/owner-token.sha256" | cut -d' ' -f1)
old_engine_sha=$(sha256sum /var/lib/capability-fabric/paa-remote/dexa-mvp/server.mjs | cut -d' ' -f1)
stage="/home/cfserver/dexa-superapp-build/releases/dexa-dashboard-web-1672-$req"
test ! -e "$stage" || exit 47
mkdir -p "$stage"
tar -xzf "$src" -C "$stage"
test -f "$stage/web/dexa-integration.mjs" || exit 48
[[ "$(sha256sum "$stage/web/cycle-panel.js" | cut -d' ' -f1)" == "$cycle_sha" ]] || exit 49
[[ "$(sha256sum "$stage/web/dexa-integration.mjs" | cut -d' ' -f1)" == "$integration_sha" ]] || exit 50
[[ "$(sha256sum "$stage/web/server.mjs" | cut -d' ' -f1)" == "$server_sha" ]] || exit 51
node --check "$stage/web/cycle-panel.js"
node --check "$stage/web/server.mjs"
node --check "$stage/web/dexa-integration.mjs"
apk17=/home/cfserver/dexa-superapp-build/dexa-wake-v1660-android17/dexa-super-dashboard-v17-cycle-wake-signed.apk
apk18=/home/cfserver/dexa-superapp-build/dexa-native-v18-web1666-binary-speaker/dexa-super-dashboard-v18-binary-speaker-signed.apk
[[ "$(sha256sum "$apk18" | cut -d' ' -f1)" == a825818783edf470311e8ce013c4526ae91a7abde99aeabfe527709389712f25 ]] || exit 52
install -m 0644 "$apk17" "$stage/web/dexa-super-dashboard-v17-cycle-wake-signed.apk"
install -m 0644 "$apk18" "$stage/web/dexa-super-dashboard-v18-binary-speaker-signed.apk"
if [[ "$(id -un)" == root ]]; then chown -R cfserver:cfserver "$stage"; fi
svc() {
 if [[ "$(id -un)" == cfserver ]]; then
  env XDG_RUNTIME_DIR=/run/user/1000 DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus systemctl --user "$@"
 else
  runuser -u cfserver -- env HOME=/home/cfserver XDG_RUNTIME_DIR=/run/user/1000 DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus systemctl --user "$@"
 fi
}
override=/home/cfserver/.config/systemd/user/dexa-super-dashboard-v6.service.d/99-web-v1672.conf
test ! -e "$override" || exit 53
web_changed=0
committed=0
rollback() {
 rc=$?
 if [[ "$committed" != 1 && "$web_changed" == 1 ]]; then
  echo "DEXA_WEB1672_ROLLBACK cause=$rc" >&2
  rm -f "$override"
  svc daemon-reload || true
  svc restart dexa-super-dashboard-v6.service || true
 fi
}
trap rollback EXIT
# Only the existing web dashboard restarts; the original Rana engine stays running.
printf '[Service]\nWorkingDirectory=%s/web\n' "$stage" > "$override"
if [[ "$(id -un)" == root ]]; then chown cfserver:cfserver "$override"; fi
web_changed=1
svc daemon-reload
svc restart dexa-super-dashboard-v6.service
healthy=0
for n in 1 2 3 4 5 6 7 8 9 10; do
 version=$(curl -fsS --max-time 4 http://127.0.0.1:4495/api/health | node -p 'JSON.parse(require("fs").readFileSync(0,"utf8")).webVersion' 2>/dev/null || true)
 if [[ "$version" == web-v1.6.72 ]]; then healthy=1;break;fi
 sleep 1
done
[[ "$healthy" == 1 ]] || exit 54
[[ "$(sha256sum "$private/owner-token.sha256" | cut -d' ' -f1)" == "$old_owner_sha" ]] || exit 55
[[ "$(sha256sum /var/lib/capability-fabric/paa-remote/dexa-mvp/server.mjs | cut -d' ' -f1)" == "$old_engine_sha" ]] || exit 56
paired_after=$(curl -fsS --max-time 5 http://127.0.0.1:4495/api/dexa/pair/status | node -p 'JSON.parse(require("fs").readFileSync(0,"utf8")).paired')
[[ "$paired_after" == true ]] || exit 57
headers=$(mktemp)
status=$(curl -s -D "$headers" -o /dev/null -w '%{http_code}' --max-time 5 -X OPTIONS http://127.0.0.1:4495/api/dexa/pair -H 'Origin: https://dexa-cf-worker-canary-20261104.mirkazem.workers.dev' -H 'Access-Control-Request-Method: POST' -H 'Access-Control-Request-Headers: content-type,x-dexa-owner-token')
[[ "$status" == 204 ]] || exit 58
grep -iq 'Access-Control-Allow-Origin: https://dexa-cf-worker-canary-20261104.mirkazem.workers.dev' "$headers" || exit 59
rm -f "$headers"
committed=1
echo DEXA_WEB1672_VERIFIED_LOCAL_PAIREDSAFE_CORS
