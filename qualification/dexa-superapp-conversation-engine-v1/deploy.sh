#!/usr/bin/env bash
# Scoped, source-only Dexa Superapp conversation turn runtime release.
# Original Rana typed parser/provider executor and Android v18 are untouched.
set -euo pipefail
umask 077
test "$#" -eq 1 || exit 40
req="$1"
[[ "$req" =~ ^dexa-conversation-turn-v1-20261111-[0-9a-f]{8}$ ]] || exit 41
base="/home/cfserver/dexa-superapp-build"
archive="/tmp/$req.tgz"
manifest="/tmp/$req.manifest.json"
expected_archive="57b9ebb9668096ecac2923f765cb0cb16a341fc4d384d9d1d42d257350bbc8e0"
engine="/var/lib/capability-fabric/paa-remote/dexa-mvp"
web_old="$base/releases/dexa-dashboard-web-1675-dexa-web1675-20261111-296f641f/web"
private="/home/cfserver/.config/dexa-integration"
stage="$base/dexa-conversation-engine-live-$req"
override="/home/cfserver/.config/systemd/user/dexa-super-dashboard-v6.service.d/99-web-v1676.conf"
hash(){ sha256sum "$1" | cut -d' ' -f1; }
[[ -f "$archive" && -f "$manifest" ]] || exit 42
[[ "$(hash "$archive")" == "$expected_archive" ]] || exit 43
python3 - "$archive" "$manifest" <<'PY'
import sys,json,tarfile,hashlib
archive,manifest=sys.argv[1:]
m=json.load(open(manifest))
assert m['schema']=='dexa.superapp.conversation-engine-release.v1'
assert m['release']=='dexa-conversation-engine-v1'
assert m['webVersion']=='web-v1.6.76' and m['previousWebVersion']=='web-v1.6.75'
assert m['canonicalPrivateCommit']=='2cd2ff1b13e884dfb799424197e102f99478d1a2'
assert m['archiveSha256']=='57b9ebb9668096ecac2923f765cb0cb16a341fc4d384d9d1d42d257350bbc8e0'
assert m['historyLimitDefault']==30 and m['historyLimitMax']==100 and m['historyLimitMin']==1
assert m['originalRanaParserUntouched'] and m['originalRanaExecutorUntouched']
assert m['androidVersion']==18 and m['dashboardTabs']==4 and m['permissions']==74
assert len(m['files'])==16
with tarfile.open(archive) as t:
 members=t.getmembers()
 assert len(members)==len(m['files']) and {e.name for e in members}==set(m['files'])
 for e in members:
  assert e.isfile() and not e.issym() and '..' not in e.name.split('/')
  assert hashlib.sha256(t.extractfile(e).read()).hexdigest()==m['files'][e.name]
print('DEXA_CONVERSATION_16_FILE_ADMISSION_PASS')
PY
old=$(curl -fsS --max-time 7 http://127.0.0.1:4495/api/health |
 node -p 'JSON.parse(require("fs").readFileSync(0,"utf8")).webVersion')
[[ "$old" == "web-v1.6.75" ]] || exit 44
[[ -d "$engine/missions" && ! -e "$engine/dexa_superapp_turn_memory_v1.mjs" ]] || exit 45
[[ ! -e "$stage" && ! -e "$override" ]] || exit 46
[[ "$(hash "$engine/server.mjs")" == "fdb185a6a60633a7e4b5f85e99512ae225880d4ab35ee55617ecb2f242f300c2" ]] || exit 47
[[ "$(hash "$engine/index.html")" == "e765a4bffac6eda525d2b06bbe19cba0426ed837bb9b02c2894264677bdc859c" ]] || exit 48
[[ "$(hash "$engine/dexa_tool_plan_v3.mjs")" == "ff683497b1d8a8592c68866be9795a26a511c9145def03b413ef6fc80c8df0c0" ]] || exit 49
[[ "$(hash "$engine/dexa_tool_plan_executor_v3.mjs")" == "3ad700942e5df74c77df701d9e2c4670c5c4827285112e83f6982a191e3afc30" ]] || exit 50
[[ "$(hash "$engine/rana.mjs")" == "13b325c661f95b0a82904e791a875661d7baef16c3d943aa424ae98cf0f1188c" ]] || exit 51
[[ "$(hash "$web_old/cycle-panel.js")" == "33e00f6f1c3d1bfbc43127e5e299d128614ed7c6a875f3b2e5c3d0aaaf78cd41" ]] || exit 52
[[ "$(hash "$web_old/dexa-integration.mjs")" == "bafd4712055af5b0582da63419d64ca8a7c1d7dd7eb277f057d547990259c021" ]] || exit 53
[[ "$(hash "$web_old/server.mjs")" == "1f8d813763a445b347ab8f9177ecdb2e618100353d29cf6e9ae1752b7c136db0" ]] || exit 54
[[ "$(hash "$web_old/../sync/publish-catalog-history.py")" == "ca5c7e6136a1e57ded524f18967c74b9d67f05199002c21054cfe2a736e743ee" ]] || exit 55
health=$(curl -fsS --max-time 7 http://127.0.0.1:9471/healthz)
printf '%s' "$health" | node -e 'let b="";process.stdin.on("data",x=>b+=x).on("end",()=>{let j=JSON.parse(b);if(j.ok!==true||j.activeMissions!==0||j.storedMissions<535)process.exit(1)})' || exit 56
apk="$base/dexa-native-v18-web1666-binary-speaker/dexa-super-dashboard-v18-binary-speaker-signed.apk"
[[ "$(hash "$apk")" == "a825818783edf470311e8ce013c4526ae91a7abde99aeabfe527709389712f25" ]] || exit 57
for name in owner-token.sha256 owner-token-mobile.sha256 engine-bridge-key; do
 [[ -f "$private/$name" && "$(stat -c %a "$private/$name")" == 600 ]] || exit 58
done
primary_sha=$(hash "$private/owner-token.sha256")
mobile_sha=$(hash "$private/owner-token-mobile.sha256")
bridge_sha=$(hash "$private/engine-bridge-key")
mkdir -p "$stage"
tar -xzf "$archive" -C "$stage"
mkdir -p "$stage/rollback"
cp -p "$engine/server.mjs" "$stage/rollback/server.mjs"
cp -p "$engine/index.html" "$stage/rollback/index.html"
node --check "$stage/engine/server.mjs"
node --check "$stage/engine/dexa_superapp_turn_memory_v1.mjs"
node --check "$stage/web/cycle-panel.js"
node --check "$stage/web/dexa-integration.mjs"
node --check "$stage/web/server.mjs"
python3 -m py_compile "$stage/sync/publish-catalog-history.py"
[[ "$(hash "$stage/engine/server.mjs")" == "f35433b14c46d211dd282f8ee31759f40677a8915aaba17b7cc2e53e0dd8b60e" ]] || exit 59
[[ "$(hash "$stage/engine/dexa_superapp_turn_memory_v1.mjs")" == "54f269693694a722ffa896eed78fd65853b46713e86490c33c3c2323344d0cdf" ]] || exit 60
[[ "$(hash "$stage/web/cycle-panel.js")" == "8d806dbb78641e6a3d91bccb23726a84ecbc4a2c83ace42187841a760ae90e1c" ]] || exit 61
install -m 0644 "$apk" "$stage/web/dexa-super-dashboard-v18-binary-speaker-signed.apk"
# Keep legacy Android v17 download intact.
install -m 0644 "$base/dexa-wake-v1660-android17/dexa-super-dashboard-v17-cycle-wake-signed.apk" "$stage/web/dexa-super-dashboard-v17-cycle-wake-signed.apk"
if [[ "$(id -un)" == root ]];then
 chown -R cfserver:cfserver "$stage"
fi
svc(){
 if [[ "$(id -un)" == cfserver ]];then
  env XDG_RUNTIME_DIR=/run/user/1000 DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus systemctl --user "$@"
 else
  runuser -u cfserver -- env HOME=/home/cfserver XDG_RUNTIME_DIR=/run/user/1000 DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus systemctl --user "$@"
 fi
}
engine_changed=0
web_changed=0
committed=0
rollback(){
 rc=$?
 if [[ "$committed" != 1 ]];then
  echo "DEXA_CONVERSATION_RELEASE_ROLLBACK rc=$rc engine=$engine_changed web=$web_changed" >&2
  if [[ "$web_changed" == 1 ]];then
   rm -f "$override"
   svc daemon-reload || true
   svc restart dexa-super-dashboard-v6.service || true
  fi
  if [[ "$engine_changed" == 1 ]];then
   install -m 0644 "$stage/rollback/server.mjs" "$engine/server.mjs"
   install -m 0600 "$stage/rollback/index.html" "$engine/index.html"
   rm -f "$engine/dexa_superapp_turn_memory_v1.mjs"
   svc restart dexa-main.service || true
  fi
 fi
}
trap rollback EXIT
install -m 0644 "$stage/engine/dexa_superapp_turn_memory_v1.mjs" "$engine/dexa_superapp_turn_memory_v1.mjs"
install -m 0644 "$stage/engine/server.mjs" "$engine/server.mjs"
install -m 0600 "$stage/engine/index.html" "$engine/index.html"
engine_changed=1
svc restart dexa-main.service
ready=0
for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15;do
 h=$(curl -fsS --max-time 4 http://127.0.0.1:9471/healthz 2>/dev/null || true)
 if [[ -n "$h" ]];then
  if printf '%s' "$h" | node -e 'let b="";process.stdin.on("data",x=>b+=x).on("end",()=>{let x=JSON.parse(b);if(!x.ok||x.activeMissions!==0||x.storedMissions<535)process.exit(1)})' 2>/dev/null;then
   ready=1;break
  fi
 fi
 sleep 1
done
[[ "$ready" == 1 ]] || exit 62
key=$(cat "$private/engine-bridge-key")
curl -fsS --max-time 7 -H "x-dexa-superapp-bridge-key: $key" http://127.0.0.1:9471/api/superapp/history |
 python3 -c 'import json,sys;x=json.load(sys.stdin);assert x["ok"] and x["historyLimit"]==30 and len(x["exchanges"])>=5;assert "می" in x["exchanges"][-1]["user"]' || exit 63
printf '[Service]\nWorkingDirectory=%s/web\n' "$stage" > "$override"
if [[ "$(id -un)" == root ]];then chown cfserver:cfserver "$override";fi
web_changed=1
svc daemon-reload
svc restart dexa-super-dashboard-v6.service
ok=0
for i in 1 2 3 4 5 6 7 8 9 10 11 12;do
 version=$(curl -fsS --max-time 4 http://127.0.0.1:4495/api/health |
  node -p 'JSON.parse(require("fs").readFileSync(0,"utf8")).webVersion' 2>/dev/null || true)
 if [[ "$version" == "web-v1.6.76" ]];then ok=1;break;fi
 sleep 1
done
[[ "$ok" == 1 ]] || exit 64
[[ "$(hash "$private/owner-token.sha256")" == "$primary_sha" ]] || exit 65
[[ "$(hash "$private/owner-token-mobile.sha256")" == "$mobile_sha" ]] || exit 66
[[ "$(hash "$private/engine-bridge-key")" == "$bridge_sha" ]] || exit 67
[[ "$(hash "$engine/dexa_tool_plan_v3.mjs")" == "ff683497b1d8a8592c68866be9795a26a511c9145def03b413ef6fc80c8df0c0" ]] || exit 68
[[ "$(hash "$engine/dexa_tool_plan_executor_v3.mjs")" == "3ad700942e5df74c77df701d9e2c4670c5c4827285112e83f6982a191e3afc30" ]] || exit 69
[[ "$(hash "$engine/rana.mjs")" == "13b325c661f95b0a82904e791a875661d7baef16c3d943aa424ae98cf0f1188c" ]] || exit 70
[[ "$(hash "$stage/web/dexa-super-dashboard-v18-binary-speaker-signed.apk")" == "a825818783edf470311e8ce013c4526ae91a7abde99aeabfe527709389712f25" ]] || exit 71
pair=$(curl -fsS --max-time 5 http://127.0.0.1:4495/api/dexa/pair/status)
printf '%s' "$pair" | node -e 'let b="";process.stdin.on("data",x=>b+=x).on("end",()=>{let j=JSON.parse(b);if(!j.paired||!j.secondDevicePaired)process.exit(1)})' || exit 72
cors=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 5 -X OPTIONS http://127.0.0.1:4495/api/dexa/catalog/sync -H 'Origin: https://dexa-cf-worker-canary-20261104.mirkazem.workers.dev' -H 'Access-Control-Request-Method: POST' -H 'Access-Control-Request-Headers: content-type,x-dexa-owner-token')
[[ "$cors" == "204" ]] || exit 73
# All new engine and web state is verified. GitHub sync can be retried by the
# next run without rolling back physically persisted replies or tool receipts.
committed=1
set +e
history=$(curl -fsS --max-time 7 -H "x-dexa-superapp-bridge-key: $key" http://127.0.0.1:9471/api/superapp/history)
publish=$(printf '%s' "$history" | python3 "$stage/sync/publish-catalog-history.py")
status=$?
set -e
if [[ "$status" == 0 ]];then
 printf '%s' "$publish" | python3 -c 'import json,sys;d=json.load(sys.stdin);print("DXA_PUBLIC_TURN_HISTORY_PUBLISHED",d["historyCount"],d["contentSha256"],d["historySha256"])'
else
 echo "DXA_PUBLIC_TURN_HISTORY_PUBLICATION_PENDING_RETRY" >&2
fi
echo DEXA_CONVERSATION_ENGINE_V1_LIVE_VERIFIED
