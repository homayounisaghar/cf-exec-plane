#!/usr/bin/env bash
# Hash-pinned, rollback-safe Dexa web 1.6.75. Android re-pair repair; original single public catalog remains;
# no Android APK/core Rana/owner hash changes during the web deploy.
set -euo pipefail
umask 077
test "$#" -eq 1 || exit 40
req="$1"
[[ "$req" =~ ^dexa-web1675-20261111-[0-9a-f]{8}$ ]] || exit 41
archive="/tmp/$req.tgz"
archive_sha=296f641f4b31e065e351e702eda7d1f9792d2d6c9ec6dd3542690c3e4a2c2e22
cycle_sha=33e00f6f1c3d1bfbc43127e5e299d128614ed7c6a875f3b2e5c3d0aaaf78cd41
integration_sha=bafd4712055af5b0582da63419d64ca8a7c1d7dd7eb277f057d547990259c021
server_sha=1f8d813763a445b347ab8f9177ecdb2e618100353d29cf6e9ae1752b7c136db0
publisher_sha=ca5c7e6136a1e57ded524f18967c74b9d67f05199002c21054cfe2a736e743ee
engine_sha=fdb185a6a60633a7e4b5f85e99512ae225880d4ab35ee55617ecb2f242f300c2
prompt_sha=7ca0f7551bc429347545b5f721bd425ce865ff4b698f1a537fbd29212634efbd
get_sha(){ sha256sum "$1" | cut -d' ' -f1; }
[[ -f "$archive" && "$(get_sha "$archive")" == "$archive_sha" ]] || exit 42
old=$(curl -fsS --max-time 6 http://127.0.0.1:4495/api/health | node -p 'JSON.parse(require("fs").readFileSync(0,"utf8")).webVersion')
[[ "$old" == web-v1.6.74 ]] || exit 43
engine=/var/lib/capability-fabric/paa-remote/dexa-mvp
[[ "$(get_sha "$engine/server.mjs")" == "$engine_sha" ]] || exit 44
[[ "$(get_sha "$engine/dexa_typed_planner_prompt_v3.mjs")" == "$prompt_sha" ]] || exit 45
health=$(curl -fsS --max-time 6 http://127.0.0.1:9471/healthz)
printf '%s' "$health" | node -e 'let b="";process.stdin.on("data",x=>b+=x).on("end",()=>{let h=JSON.parse(b);if(!h.ok||h.activeMissions!==0||!Number.isSafeInteger(h.storedMissions))process.exit(5)})' || exit 46
private=/home/cfserver/.config/dexa-integration
for f in owner-token.sha256 owner-token-mobile.sha256 engine-bridge-key;do
 [[ -f "$private/$f" && "$(stat -c %a "$private/$f")" == 600 ]] || exit 47
done
owner_sha=$(get_sha "$private/owner-token.sha256")
mobile_sha=$(get_sha "$private/owner-token-mobile.sha256")
bridge_sha=$(get_sha "$private/engine-bridge-key")
stage="/home/cfserver/dexa-superapp-build/releases/dexa-dashboard-web-1675-$req"
[[ ! -e "$stage" ]] || exit 48
mkdir -p "$stage"
tar -xzf "$archive" -C "$stage"
[[ "$(get_sha "$stage/web/cycle-panel.js")" == "$cycle_sha" ]] || exit 49
[[ "$(get_sha "$stage/web/dexa-integration.mjs")" == "$integration_sha" ]] || exit 50
[[ "$(get_sha "$stage/web/server.mjs")" == "$server_sha" ]] || exit 51
[[ "$(get_sha "$stage/sync/publish-catalog-history.py")" == "$publisher_sha" ]] || exit 52
node --check "$stage/web/cycle-panel.js"
node --check "$stage/web/dexa-integration.mjs"
node --check "$stage/web/server.mjs"
python3 -m py_compile "$stage/sync/publish-catalog-history.py"
# Prove existing GitHub OAuth works without publishing extra dummy history.
echo '{"exchanges":[]}' | python3 "$stage/sync/publish-catalog-history.py" --dry-run |
 python3 -c 'import json,sys;x=json.load(sys.stdin);assert x["ok"] and x["url"].startswith("https://raw.githubusercontent.com/homayounisaghar/cf-exec-plane/")'
apk17=/home/cfserver/dexa-superapp-build/dexa-wake-v1660-android17/dexa-super-dashboard-v17-cycle-wake-signed.apk
apk18=/home/cfserver/dexa-superapp-build/dexa-native-v18-web1666-binary-speaker/dexa-super-dashboard-v18-binary-speaker-signed.apk
[[ "$(get_sha "$apk18")" == a825818783edf470311e8ce013c4526ae91a7abde99aeabfe527709389712f25 ]] || exit 53
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
override=/home/cfserver/.config/systemd/user/dexa-super-dashboard-v6.service.d/99-web-v1675.conf
[[ ! -e "$override" ]] || exit 54
changed=0
committed=0
rollback(){
 code=$?
 if [[ "$committed" != 1 && "$changed" == 1 ]];then
  echo "DEXA_WEB1675_ROLLBACK code=$code" >&2
  rm -f "$override"
  svc daemon-reload || true
  svc restart dexa-super-dashboard-v6.service || true
 fi
}
trap rollback EXIT
printf '[Service]\nWorkingDirectory=%s/web\n' "$stage" > "$override"
if [[ "$(id -un)" == root ]];then chown cfserver:cfserver "$override";fi
changed=1
svc daemon-reload
svc restart dexa-super-dashboard-v6.service
ready=0
for i in 1 2 3 4 5 6 7 8 9 10;do
 current=$(curl -fsS --max-time 4 http://127.0.0.1:4495/api/health |
  node -p 'JSON.parse(require("fs").readFileSync(0,"utf8")).webVersion' 2>/dev/null || true)
 if [[ "$current" == web-v1.6.75 ]];then ready=1;break;fi
 sleep 1
done
[[ "$ready" == 1 ]] || exit 55
[[ "$(get_sha "$private/owner-token.sha256")" == "$owner_sha" ]] || exit 56
[[ "$(get_sha "$private/owner-token-mobile.sha256")" == "$mobile_sha" ]] || exit 57
[[ "$(get_sha "$private/engine-bridge-key")" == "$bridge_sha" ]] || exit 58
[[ "$(get_sha "$engine/server.mjs")" == "$engine_sha" ]] || exit 59
[[ "$(get_sha "$engine/dexa_typed_planner_prompt_v3.mjs")" == "$prompt_sha" ]] || exit 60
pair=$(curl -fsS --max-time 6 http://127.0.0.1:4495/api/dexa/pair/status)
printf '%s' "$pair" | node -e 'let b="";process.stdin.on("data",x=>b+=x).on("end",()=>{let p=JSON.parse(b);if(p.paired!==true||p.secondDevicePaired!==true||p.canIssueMobileInvite!==false)process.exit(4)})' || exit 61
cors=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 6 -X OPTIONS http://127.0.0.1:4495/api/dexa/catalog/sync -H 'Origin: https://dexa-cf-worker-canary-20261104.mirkazem.workers.dev' -H 'Access-Control-Request-Method: POST' -H 'Access-Control-Request-Headers: content-type,x-dexa-owner-token')
[[ "$cors" == 204 ]] || exit 62
committed=1
echo DEXA_WEB1675_PRIMARY_AUTHENTICATED_SAFE_MOBILE_REPAIR_VERIFIED
