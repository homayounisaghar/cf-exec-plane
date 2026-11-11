#!/usr/bin/env bash
# Secret-free, SHA-pinned, single-request Dexa owner web+Rana release.
set -euo pipefail
umask 077
req="${1:?immutable request id required}"
[[ "$req" =~ ^dexa-web1671-20261111-[0-9a-f]{8}$ ]] || exit 41
src="/tmp/${req}.tgz"
patch="/tmp/${req}.engine.patch"
archive_sha=7dc8046a16f4e9cf88d2cad279162b05281dde9aaf5b5923c3a4a7e92f93fff3
engine_patch_sha=c2e3e6477179cf3f16567604310530f5f3bb5dbb82e4d2d78e473c8754a3ddf0
old_engine_sha=d1a76fe7ddcbd41e3baf75de74c21b0fb9f35912b1985aa0b2e22e20d4a3cc76
new_engine_sha=fdb185a6a60633a7e4b5f85e99512ae225880d4ab35ee55617ecb2f242f300c2
new_cycle_sha=f81a3f08e83b0a49d8b2fda171b13f00fb8e20470e960aeb598a285b30b24d52
new_server_sha=8b9093290503c5abdad36942a86ac7e321233b9af7cc4d567d939d1926d13f66
[[ -f "$src" && -f "$patch" ]] || exit 42
[[ "$(sha256sum "$src" | cut -d' ' -f1)" == "$archive_sha" ]] || exit 43
[[ "$(sha256sum "$patch" | cut -d' ' -f1)" == "$engine_patch_sha" ]] || exit 44
core=/var/lib/capability-fabric/paa-remote/dexa-mvp
[[ -f "$core/server.mjs" && -f "$core/dexa_safe_restart.sh" ]] || exit 45
[[ "$(sha256sum "$core/server.mjs" | cut -d' ' -f1)" == "$old_engine_sha" ]] || exit 46
old=$(curl -fsS --max-time 6 http://127.0.0.1:4495/api/health |
 node -e 'let s="";process.stdin.on("data",b=>s+=b).on("end",()=>process.stdout.write(JSON.parse(s).webVersion))')
[[ "$old" == web-v1.6.70 ]] || exit 47
curl -fsS --max-time 6 http://127.0.0.1:9471/healthz |
 node -e 'let s="";process.stdin.on("data",b=>s+=b).on("end",()=>{const j=JSON.parse(s);if(!j.ok||!Number.isSafeInteger(j.storedMissions))process.exit(2);console.log("DEXA_ENGINE_SOURCE_VERIFIED,missions="+j.storedMissions)})'
stage="/home/cfserver/dexa-superapp-build/releases/dexa-dashboard-web-1671-$req"
[[ ! -e "$stage" ]] || exit 48
mkdir -p "$stage"/engine
tar -xzf "$src" -C "$stage"
test -f "$stage/web/dexa-integration.mjs"
[[ "$(sha256sum "$stage/web/cycle-panel.js" | cut -d' ' -f1)" == "$new_cycle_sha" ]] || exit 49
[[ "$(sha256sum "$stage/web/server.mjs" | cut -d' ' -f1)" == "$new_server_sha" ]] || exit 50
cp -p "$core/server.mjs" "$stage/engine-original-server.mjs"
cp -p "$core/server.mjs" "$stage/engine/server.mjs"
(cd "$stage/engine" && patch -s --fuzz=0 -p1 < "$patch")
[[ "$(sha256sum "$stage/engine/server.mjs" | cut -d' ' -f1)" == "$new_engine_sha" ]] || exit 51
node --check "$stage/web/cycle-panel.js"
node --check "$stage/web/server.mjs"
node --check "$stage/web/dexa-integration.mjs"
node --check "$stage/engine/server.mjs"
apk17=/home/cfserver/dexa-superapp-build/dexa-wake-v1660-android17/dexa-super-dashboard-v17-cycle-wake-signed.apk
apk18=/home/cfserver/dexa-superapp-build/dexa-native-v18-web1666-binary-speaker/dexa-super-dashboard-v18-binary-speaker-signed.apk
[[ -f "$apk17" && -f "$apk18" ]] || exit 52
[[ "$(sha256sum "$apk17" | cut -d' ' -f1)" == "8cbf66cca9ad0f6e31cb0cda6cb478278f5bb10225f6ff3deeacd0002e40409a" ]] || exit 53
[[ "$(sha256sum "$apk18" | cut -d' ' -f1)" == "a825818783edf470311e8ce013c4526ae91a7abde99aeabfe527709389712f25" ]] || exit 54
install -m 0644 "$apk17" "$stage/web/dexa-super-dashboard-v17-cycle-wake-signed.apk"
install -m 0644 "$apk18" "$stage/web/dexa-super-dashboard-v18-binary-speaker-signed.apk"
if [[ "$(id -un)" == root ]]; then
 chown -R cfserver:cfserver "$stage"
fi
svc() {
 if [[ "$(id -un)" == cfserver ]]; then
  env XDG_RUNTIME_DIR=/run/user/1000 DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus systemctl --user "$@"
 else
  runuser -u cfserver -- env HOME=/home/cfserver XDG_RUNTIME_DIR=/run/user/1000 DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus systemctl --user "$@"
 fi
}
guarded_engine_restart() {
 if [[ "$(id -un)" == cfserver ]]; then
  env HOME=/home/cfserver XDG_RUNTIME_DIR=/run/user/1000 DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus sh "$core/dexa_safe_restart.sh" --restart
 else
  runuser -u cfserver -- env HOME=/home/cfserver XDG_RUNTIME_DIR=/run/user/1000 DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus sh "$core/dexa_safe_restart.sh" --restart
 fi
}
# All provisioning is local/VPS-private; no secrets enter GitHub or logs.
private=/home/cfserver/.config/dexa-integration
if [[ "$(id -un)" == root ]]; then
 install -d -o cfserver -g cfserver -m 0700 "$private"
else
 install -d -m 0700 "$private"
fi
if [[ ! -f "$private/engine-bridge-key" ]]; then
 key=$(openssl rand -hex 32)
 printf '%s\n' "$key" > "$private/engine-bridge-key"
 chmod 0600 "$private/engine-bridge-key"
 unset key
 echo PRIVATE_ENGINE_BRIDGE_KEY_CONFIGURED
fi
if [[ ! -f "$private/owner-token.sha256" && ! -f "$private/owner-pair-code.sha256" ]]; then
 code=$(openssl rand -hex 16)
 printf '%s\n' "$code" > "$private/owner-pair-code.txt"
 printf '%s' "$code" | sha256sum | cut -d' ' -f1 > "$private/owner-pair-code.sha256"
 chmod 0600 "$private/owner-pair-code.txt" "$private/owner-pair-code.sha256"
 unset code
 echo PRIVATE_ONE_TIME_PAIR_CODE_CONFIGURED
fi
if [[ "$(id -un)" == root ]]; then chown -R cfserver:cfserver "$private";fi
[[ "$(stat -c '%a' "$private")" == 700 ]] || exit 55
[[ "$(stat -c '%a' "$private/engine-bridge-key")" == 600 ]] || exit 56

override=/home/cfserver/.config/systemd/user/dexa-super-dashboard-v6.service.d/99-web-v1671.conf
[[ ! -e "$override" ]] || exit 57
engine_changed=0
web_changed=0
commit=0
rollback(){
 local rc=$?
 if [[ "$commit" -ne 1 ]]; then
  echo DEXA_V1671_RELEASE_ROLLBACK code="$rc" >&2
  if [[ "$web_changed" -eq 1 ]]; then
   rm -f "$override";svc daemon-reload || true
   svc restart dexa-super-dashboard-v6.service || true
  fi
  if [[ "$engine_changed" -eq 1 ]]; then
   cp -p "$stage/engine-original-server.mjs" "$core/server.mjs"
   if [[ "$(id -un)" == root ]]; then chown cfserver:cfserver "$core/server.mjs"; fi
   guarded_engine_restart || true
  fi
 fi
}
trap rollback EXIT
# No change to other files/modules, mission records, or Android app.
cp -p "$stage/engine/server.mjs" "$core/server.mjs"
if [[ "$(id -un)" == root ]]; then chown cfserver:cfserver "$core/server.mjs"; fi
engine_changed=1
guarded_engine_restart
[[ "$(sha256sum "$core/server.mjs" | cut -d' ' -f1)" == "$new_engine_sha" ]] || exit 58
new_health=$(curl -fsS --max-time 8 http://127.0.0.1:9471/healthz)
printf '%s' "$new_health" | node -e 'let s="";process.stdin.on("data",b=>s+=b).on("end",()=>{const j=JSON.parse(s);if(!j.ok||!Number.isSafeInteger(j.storedMissions)||j.universalMissionEngine?.enabled!==true)process.exit(3);console.log("DEXA_ENGINE_RANA_ACTIVE,missions="+j.storedMissions)})'
status=$(curl -s -o /dev/null -w '%{http_code}' --max-time 4 http://127.0.0.1:9471/api/superapp/history)
[[ "$status" == 401 ]] || exit 59
mkdir -p "$(dirname "$override")"
printf '[Service]\nWorkingDirectory=%s/web\n' "$stage" > "$override"
if [[ "$(id -un)" == root ]]; then chown cfserver:cfserver "$override";fi
web_changed=1
svc daemon-reload
svc restart dexa-super-dashboard-v6.service
web_ok=0
for n in 1 2 3 4 5 6 7 8 9 10;do
 web=$(curl -fsS --max-time 4 http://127.0.0.1:4495/api/health |
  node -e 'let s="";process.stdin.on("data",b=>s+=b).on("end",()=>process.stdout.write(JSON.parse(s).webVersion))' 2>/dev/null || true)
 if [[ "$web" == web-v1.6.71 ]];then web_ok=1;break;fi
 sleep 1
done
[[ "$web_ok" == 1 ]] || exit 60
paired=$(curl -fsS --max-time 5 http://127.0.0.1:4495/api/dexa/pair/status)
printf '%s' "$paired" | node -e 'let s="";process.stdin.on("data",b=>s+=b).on("end",()=>{let j=JSON.parse(s);if(typeof j.paired!=="boolean"||j.configured!==true)process.exit(4);console.log("PRIVATE_ENGINE_PAIRING_AVAILABLE,paired="+j.paired)})'
commit=1
echo DEXA_V1671_ENGINE_AND_WEB_LOCAL_VERIFIED
