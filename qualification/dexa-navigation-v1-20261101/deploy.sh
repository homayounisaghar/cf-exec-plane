#!/usr/bin/env bash
set -Eeuo pipefail
if [[ "$(id -un)" == root ]];then
 exec /usr/sbin/runuser -u cfserver -- /usr/bin/env HOME=/home/cfserver XDG_RUNTIME_DIR=/run/user/1000 DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus /bin/bash "$0"
fi
[[ "$(id -un)" == cfserver ]] || exit 10
export HOME=/home/cfserver XDG_RUNTIME_DIR=/run/user/1000 DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus
SRC=/tmp/dexa-navigation-v1-20261101
D=/var/lib/capability-fabric/paa-remote/dexa-mvp
W=/home/cfserver/.local/share/dexa/dexa-navigation-v1-20261101
F=/home/cfserver/.local/share/dexa/deployment-drain.flag
CANDIDATE=ba91ea389a80625181354c7405c0d5aa69a8d3ec3b227863013b1e3a9f825592
BASELINE=ad4ae691c4cbbe612bc993ea4bcb2e91f8b20f4df209cfb9bb643a7530fea64d
sha(){ sha256sum "$1" | awk '{print $1}'; }
[[ ! -e "$W" && ! -e "$F" && -f "$SRC/dexa/dexa_catalog_output_shapes_v1.json" && -f "$SRC/dexa/test_dexa_wechat_navigation_identity_v1.mjs" ]] || exit 11
[[ "$(sha "$D/dexa_catalog_output_shapes_v1.json")" == "$BASELINE" && "$(sha "$SRC/dexa/dexa_catalog_output_shapes_v1.json")" == "$CANDIDATE" ]] || exit 12
test "$(node -e 'const x=require(process.argv[1]); if(x.schema!=="dexa.wechat-navigation-identity.v1")process.exit(1);console.log(x.source_commit)' "$SRC/manifest.json")" = dbea0cbe478f8ba730d87914ac96d20aed146242
WECHAT="$(pgrep -u 1000 -x wechat | head -n1)"
CF_RELEASE="$(readlink /opt/capability-fabric/current)"
[[ -n "$WECHAT" && -n "$CF_RELEASE" ]] || exit 13
for unit in dexa-main.service dexa-catalog-gateway.service capability-fabric-pcg-wechat-semantic-manual.service;do systemctl --user is-active --quiet "$unit";done
health(){ curl -fsS --max-time 5 http://127.0.0.1:9471/healthz; }
BEFORE="$(health | python3 -c 'import sys,json;x=json.load(sys.stdin);assert x["ok"] and x["activeMissions"]==0 and not x["deploymentDrain"]["active"];print(x["storedMissions"])')"
mkdir -p -m 700 "$W"/stage "$W"/backup
cp -p "$D/dexa_catalog_output_shapes_v1.json" "$W/backup/"
cp "$D/"*.mjs "$D/"*.json "$W/stage/"
cp "$SRC/dexa/dexa_catalog_output_shapes_v1.json" "$SRC/dexa/test_dexa_wechat_navigation_identity_v1.mjs" "$W/stage/"
QA="test_dexa_wechat_navigation_identity_v1.mjs test_dexa_native_recipient_contract_v1.mjs test_dexa_wechat_message_list_v1.mjs"
(cd "$W/stage";node --test $QA > "$W/pre.log" 2>&1)
grep -q '^# fail 0$' "$W/pre.log"
marked=0;installed=0;committed=0
cleanup(){
 rc=$?;trap - EXIT
 if ((rc!=0 && installed==1 && committed==0));then
  cp -p "$W/backup/dexa_catalog_output_shapes_v1.json" "$D/.dexa_catalog_output_shapes_v1.json.rollback"
  mv -f "$D/.dexa_catalog_output_shapes_v1.json.rollback" "$D/dexa_catalog_output_shapes_v1.json"
  rm -f "$D/test_dexa_wechat_navigation_identity_v1.mjs"
  systemctl --user restart dexa-main.service || true
 fi
 if ((marked==1));then rm -f "$F";fi
 exit "$rc"
}
trap cleanup EXIT
( set -C;printf 'dexa-navigation metadata-only release\n' > "$F" )
marked=1
stable=0
for i in $(seq 1 30);do
 if health 2>/dev/null | python3 -c 'import json,sys;x=json.load(sys.stdin);assert x["ok"] and x["activeMissions"]==0 and x["deploymentDrain"]["active"]' 2>/dev/null;then stable=$((stable+1));else stable=0;fi
 ((stable>=3)) && break
 sleep 1
done
((stable>=3)) || exit 14
[[ "$(sha "$D/dexa_catalog_output_shapes_v1.json")" == "$BASELINE" ]] || exit 15
installed=1
for file in dexa_catalog_output_shapes_v1.json test_dexa_wechat_navigation_identity_v1.mjs;do
 cp "$W/stage/$file" "$D/.$file.new";chmod 600 "$D/.$file.new";mv -f "$D/.$file.new" "$D/$file"
done
systemctl --user restart dexa-main.service
for i in $(seq 1 40);do
 if health 2>/dev/null | python3 -c 'import json,sys;x=json.load(sys.stdin);assert x["ok"] and x["activeMissions"]==0 and x["deploymentDrain"]["active"]' 2>/dev/null;then break;fi
 sleep 1
done
[[ "$(sha "$D/dexa_catalog_output_shapes_v1.json")" == "$CANDIDATE" ]] || exit 16
(cd "$D"; node --test $QA > "$W/post.log" 2>&1)
grep -q '^# fail 0$' "$W/post.log"
[[ "$(pgrep -u 1000 -x wechat | head -n1)" == "$WECHAT" && "$(readlink /opt/capability-fabric/current)" == "$CF_RELEASE" ]] || exit 17
for unit in dexa-main.service dexa-catalog-gateway.service capability-fabric-pcg-wechat-semantic-manual.service;do systemctl --user is-active --quiet "$unit";done
health | python3 -c 'import json,sys;x=json.load(sys.stdin);assert x["ok"] and x["activeMissions"]==0 and x["deploymentDrain"]["active"] and x["storedMissions"]>=int(sys.argv[1])' "$BEFORE"
committed=1;rm -f "$F";marked=0
health | python3 -c 'import json,sys;x=json.load(sys.stdin);assert x["ok"] and not x["deploymentDrain"]["active"];print("DEXA_NAVIGATION_LIVE",x["storedMissions"])'
