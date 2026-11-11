#!/usr/bin/env bash
# Source-hash guarded Dexa v1.6.73 web + engine prompt-only deploy.
set -euo pipefail
umask 077
test "$#" -eq 1 || exit 40
req="$1"
[[ "$req" =~ ^dexa-web1673-20261111-[0-9a-f]{8}$ ]] || exit 41
src="/tmp/$req.tgz"
engpatch="/tmp/$req.engine.patch"
archive_sha=ce38e7a99f4ff3e4314fdb90e5ec3e09b9126dd87876946d8918fb9fa16d29ac
patch_sha=eb003a949bdee1b92937f536ef5e19cf556f3ed73cad0dcb089837ec3fa21f56
old_prompt_sha=e05d2a84b372f27871f08736072ffa0b466b5ed1ab1664ea996d1669652623a5
new_prompt_sha=7ca0f7551bc429347545b5f721bd425ce865ff4b698f1a537fbd29212634efbd
core_server_sha=fdb185a6a60633a7e4b5f85e99512ae225880d4ab35ee55617ecb2f242f300c2
cycle_sha=1fc9d6f7b6186fb254188ff34e5a5e2352ab417a4d71b75fb384bd93d3eac64c
server_sha=a700b0c3c6eee2e5c7aa9cf61683f7b5516a091a22515383c36aa692c0fe6a5b
integration_sha=78dc382a988bb8ceb29a03b8879f686ddea38bfd7b05fe1d6a097f6243fdb487
catalog_sha=4afb984650e6c23794382a8f82c88f11e61725a34eb4530a6df12cd006419d4f
file_sha() { sha256sum "$1" | cut -d' ' -f1; }
[[ -f "$src" && -f "$engpatch" ]] || exit 42
[[ "$(file_sha "$src")" == "$archive_sha" ]] || exit 43
[[ "$(file_sha "$engpatch")" == "$patch_sha" ]] || exit 44
core=/var/lib/capability-fabric/paa-remote/dexa-mvp
prompt="$core/dexa_typed_planner_prompt_v3.mjs"
[[ "$(file_sha "$prompt")" == "$old_prompt_sha" ]] || exit 45
[[ "$(file_sha "$core/server.mjs")" == "$core_server_sha" ]] || exit 46
[[ -f "$core/dexa_safe_restart.sh" ]] || exit 47
old=$(curl -fsS --max-time 6 http://127.0.0.1:4495/api/health | node -p 'JSON.parse(require("fs").readFileSync(0,"utf8")).webVersion')
[[ "$old" == web-v1.6.72 ]] || exit 48
health=$(curl -fsS --max-time 6 http://127.0.0.1:9471/healthz)
missions=$(printf '%s' "$health" | node -e 'let s="";process.stdin.on("data",b=>s+=b).on("end",()=>{let j=JSON.parse(s);if(!j.ok||j.activeMissions!==0||!Number.isSafeInteger(j.storedMissions))process.exit(1);console.log(j.storedMissions)})')
[[ "$missions" =~ ^[0-9]+$ ]] || exit 49
private=/home/cfserver/.config/dexa-integration
for f in owner-token.sha256 owner-token-mobile.sha256 engine-bridge-key; do
 [[ -f "$private/$f" && "$(stat -c %a "$private/$f")" == 600 ]] || exit 50
done
owner_hash=$(file_sha "$private/owner-token.sha256")
mobile_hash=$(file_sha "$private/owner-token-mobile.sha256")
bridge_hash=$(file_sha "$private/engine-bridge-key")
stage="/home/cfserver/dexa-superapp-build/releases/dexa-dashboard-web-1673-$req"
[[ ! -e "$stage" ]] || exit 51
mkdir -p "$stage/engine"
tar -xzf "$src" -C "$stage"
[[ "$(file_sha "$stage/web/cycle-panel.js")" == "$cycle_sha" ]] || exit 52
[[ "$(file_sha "$stage/web/server.mjs")" == "$server_sha" ]] || exit 53
[[ "$(file_sha "$stage/web/dexa-integration.mjs")" == "$integration_sha" ]] || exit 54
[[ "$(file_sha "$stage/web/catalog-mvp.md")" == "$catalog_sha" ]] || exit 55
cp -p "$prompt" "$stage/engine-old-prompt.mjs"
cp -p "$prompt" "$stage/engine/dexa_typed_planner_prompt_v3.mjs"
(cd "$stage" && patch -s --fuzz=0 -p1 < "$engpatch")
[[ "$(file_sha "$stage/engine/dexa_typed_planner_prompt_v3.mjs")" == "$new_prompt_sha" ]] || exit 56
node --check "$stage/web/cycle-panel.js"
node --check "$stage/web/server.mjs"
node --check "$stage/web/dexa-integration.mjs"
node --check "$stage/engine/dexa_typed_planner_prompt_v3.mjs"
apk17=/home/cfserver/dexa-superapp-build/dexa-wake-v1660-android17/dexa-super-dashboard-v17-cycle-wake-signed.apk
apk18=/home/cfserver/dexa-superapp-build/dexa-native-v18-web1666-binary-speaker/dexa-super-dashboard-v18-binary-speaker-signed.apk
[[ "$(file_sha "$apk18")" == a825818783edf470311e8ce013c4526ae91a7abde99aeabfe527709389712f25 ]] || exit 57
install -m 0644 "$apk17" "$stage/web/dexa-super-dashboard-v17-cycle-wake-signed.apk"
install -m 0644 "$apk18" "$stage/web/dexa-super-dashboard-v18-binary-speaker-signed.apk"
if [[ "$(id -un)" == root ]];then chown -R cfserver:cfserver "$stage";fi
svc(){
 if [[ "$(id -un)" == cfserver ]];then
  env XDG_RUNTIME_DIR=/run/user/1000 DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus systemctl --user "$@"
 else
  runuser -u cfserver -- env HOME=/home/cfserver XDG_RUNTIME_DIR=/run/user/1000 DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus systemctl --user "$@"
 fi
}
restart_engine(){
 if [[ "$(id -un)" == cfserver ]];then
  env HOME=/home/cfserver XDG_RUNTIME_DIR=/run/user/1000 DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus sh "$core/dexa_safe_restart.sh" --restart
 else
  runuser -u cfserver -- env HOME=/home/cfserver XDG_RUNTIME_DIR=/run/user/1000 DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus sh "$core/dexa_safe_restart.sh" --restart
 fi
}
override=/home/cfserver/.config/systemd/user/dexa-super-dashboard-v6.service.d/99-web-v1673.conf
[[ ! -e "$override" ]] || exit 58
engine_changed=0
web_changed=0
committed=0
rollback(){
 rc=$?
 if [[ "$committed" != 1 ]];then
  echo "DEXA_1673_ROLLBACK code=$rc" >&2
  if [[ "$web_changed" == 1 ]];then
   rm -f "$override"
   svc daemon-reload || true
   svc restart dexa-super-dashboard-v6.service || true
  fi
  if [[ "$engine_changed" == 1 ]];then
   cp -p "$stage/engine-old-prompt.mjs" "$prompt"
   if [[ "$(id -un)" == root ]];then chown cfserver:cfserver "$prompt";fi
   restart_engine || true
  fi
 fi
}
trap rollback EXIT
cp -p "$stage/engine/dexa_typed_planner_prompt_v3.mjs" "$prompt"
if [[ "$(id -un)" == root ]];then chown cfserver:cfserver "$prompt";fi
engine_changed=1
restart_engine
[[ "$(file_sha "$prompt")" == "$new_prompt_sha" ]] || exit 59
[[ "$(file_sha "$core/server.mjs")" == "$core_server_sha" ]] || exit 60
again=$(curl -fsS --max-time 8 http://127.0.0.1:9471/healthz)
printf '%s' "$again" | node -e 'let s="";process.stdin.on("data",b=>s+=b).on("end",()=>{let j=JSON.parse(s);if(!j.ok||j.activeMissions!==0)process.exit(1)})'
after=$(printf '%s' "$again" | node -p 'JSON.parse(require("fs").readFileSync(0,"utf8")).storedMissions')
[[ "$after" == "$missions" ]] || exit 61
printf '[Service]\nWorkingDirectory=%s/web\n' "$stage" > "$override"
if [[ "$(id -un)" == root ]];then chown cfserver:cfserver "$override";fi
web_changed=1
svc daemon-reload
svc restart dexa-super-dashboard-v6.service
web_ok=0
for n in 1 2 3 4 5 6 7 8 9 10;do
 current=$(curl -fsS --max-time 4 http://127.0.0.1:4495/api/health | node -p 'JSON.parse(require("fs").readFileSync(0,"utf8")).webVersion' 2>/dev/null || true)
 if [[ "$current" == web-v1.6.73 ]];then web_ok=1;break;fi
 sleep 1
done
[[ "$web_ok" == 1 ]] || exit 62
[[ "$(file_sha "$private/owner-token.sha256")" == "$owner_hash" ]] || exit 63
[[ "$(file_sha "$private/owner-token-mobile.sha256")" == "$mobile_hash" ]] || exit 64
[[ "$(file_sha "$private/engine-bridge-key")" == "$bridge_hash" ]] || exit 65
paired=$(curl -fsS --max-time 6 http://127.0.0.1:4495/api/dexa/pair/status)
printf '%s' "$paired" | node -e 'let s="";process.stdin.on("data",b=>s+=b).on("end",()=>{let j=JSON.parse(s);if(j.paired!==true||j.secondDevicePaired!==true)process.exit(1)})'
cors=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 6 -X OPTIONS http://127.0.0.1:4495/api/dexa/execute -H 'Origin: https://dexa-cf-worker-canary-20261104.mirkazem.workers.dev' -H 'Access-Control-Request-Method: POST' -H 'Access-Control-Request-Headers: content-type,x-dexa-owner-token')
[[ "$cors" == 204 ]] || exit 66
committed=1
echo "DEXA_1673_WEB_AND_ENGINE_PROMPT_LIVE_OK,missions=$after"
