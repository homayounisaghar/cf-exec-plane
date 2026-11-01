#!/usr/bin/env bash
set -Eeuo pipefail
if [[ "$(id -un)" == root ]];then
 exec /usr/sbin/runuser -u cfserver -- /usr/bin/env HOME=/home/cfserver XDG_RUNTIME_DIR=/run/user/1000 DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus /bin/bash "$0"
fi
[[ "$(id -un)" == cfserver ]] || exit 10
export HOME=/home/cfserver XDG_RUNTIME_DIR=/run/user/1000 DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus
SRC=/tmp/dexa-ignore-service-chat-v1-20261102
D=/var/lib/capability-fabric/paa-remote/dexa-mvp
W=/home/cfserver/.local/share/dexa/dexa-ignore-service-chat-v1-20261102-release
F=/home/cfserver/.local/share/dexa/deployment-drain.flag
[[ ! -e "$W" && ! -e "$F" && -f "$SRC/manifest.json" ]] || exit 11
python3 - "$SRC" "$D" <<'PY'
import hashlib,json,sys
from pathlib import Path
src,live=map(Path,sys.argv[1:])
m=json.loads((src/"manifest.json").read_text())
assert m["schema"]=="dexa.ignore-wechat-service-chat.v1"
assert m["source_commit"]=="438d5325a19d62847d7fc92806646c6bde32c388"
assert m["excluded_display_name"]=="Service Notifications"
assert m["no_connector_change"] and m["no_native_wechat_change"]
assert m["service_restart"]=="dexa-main.service" and len(m["files"])==3
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
for name,item in m["files"].items():
 assert name in ("dexa_messaging_record_contract_v1.mjs","dexa_tool_plan_executor_v3.mjs","test_dexa_wechat_ignored_chat_v1.mjs")
 current=live/name;candidate=src/"dexa"/name
 assert candidate.is_file() and sha(candidate)==item["after"],name+" candidate"
 assert (not current.exists() and item["before"] is None) or (current.is_file() and not current.is_symlink() and sha(current)==item["before"]),name+" baseline"
print("DEXA_IGNORE_CHAT_PRECHECK_OK")
PY
health(){ curl -fsS --max-time 5 http://127.0.0.1:9471/healthz; }
BEFORE="$(health | python3 -c 'import sys,json;x=json.load(sys.stdin);assert x["ok"] and x["activeMissions"]==0 and not x["deploymentDrain"]["active"];print(x["storedMissions"])')"
WECHAT_GUI="$(pgrep -u 1000 -x wechat | head -n1)"
CF_RELEASE="$(readlink /opt/capability-fabric/current)"
[[ -n "$WECHAT_GUI" && -n "$CF_RELEASE" ]] || exit 12
for u in dexa-main.service dexa-catalog-gateway.service capability-fabric-pcg-wechat-semantic-manual.service;do systemctl --user is-active --quiet "$u" || exit 13;done
mkdir -p -m 700 "$W/stage" "$W/backup"
cp -p "$D/dexa_messaging_record_contract_v1.mjs" "$D/dexa_tool_plan_executor_v3.mjs" "$W/backup/"
cp "$D/"*.mjs "$D/"*.json "$W/stage/"
cp "$SRC/dexa/"*.mjs "$W/stage/"
for f in "$SRC/dexa/"*.mjs;do node --check "$f";done
QA="test_dexa_wechat_ignored_chat_v1.mjs test_dexa_universal_unread_contract_v1.mjs test_dexa_unread_output_contract_v2.mjs"
(cd "$W/stage";node --test $QA) > "$W/pre.log" 2>&1
grep -q '^# pass 29$' "$W/pre.log";grep -q '^# fail 0$' "$W/pre.log"
marked=0;changed=0;committed=0
cleanup(){
 rc=$?;trap - EXIT
 if ((rc!=0 && changed==1 && committed==0));then
  echo DEXA_IGNORE_CHAT_ROLLBACK
  for f in dexa_messaging_record_contract_v1.mjs dexa_tool_plan_executor_v3.mjs;do
   cp -p "$W/backup/$f" "$D/.$f.rollback"
   mv -f "$D/.$f.rollback" "$D/$f"
  done
  rm -f "$D/test_dexa_wechat_ignored_chat_v1.mjs"
  systemctl --user restart dexa-main.service || true
 fi
 if ((marked==1));then rm -f "$F";fi
 exit "$rc"
}
trap cleanup EXIT
( set -C;printf 'Dexa service chat filtering, main restart only\n' > "$F" )
marked=1
stable=0
for i in $(seq 1 30);do
 if health 2>/dev/null | python3 -c 'import sys,json;x=json.load(sys.stdin);assert x["ok"] and x["activeMissions"]==0 and x["deploymentDrain"]["active"]' 2>/dev/null;then stable=$((stable+1));else stable=0;fi
 ((stable>=3)) && break;sleep 1
done
((stable>=3)) || exit 14
python3 - "$SRC" "$D" <<'PY'
import hashlib,json,sys
from pathlib import Path
src,live=map(Path,sys.argv[1:])
for name,item in json.loads((src/"manifest.json").read_text())["files"].items():
 p=live/name
 if item["before"] is None:assert not p.exists()
 else:assert hashlib.sha256(p.read_bytes()).hexdigest()==item["before"]
PY
changed=1
for f in dexa_messaging_record_contract_v1.mjs dexa_tool_plan_executor_v3.mjs test_dexa_wechat_ignored_chat_v1.mjs;do
 cp "$SRC/dexa/$f" "$D/.$f.new";chmod 600 "$D/.$f.new";mv -f "$D/.$f.new" "$D/$f"
done
systemctl --user restart dexa-main.service
ready=0
for i in $(seq 1 40);do
 if health 2>/dev/null | python3 -c 'import json,sys;x=json.load(sys.stdin);assert x["ok"] and x["activeMissions"]==0 and x["deploymentDrain"]["active"]' 2>/dev/null;then ready=1;break;fi;sleep 1
done
((ready==1)) || exit 15
python3 - "$SRC" "$D" <<'PY'
import hashlib,json,sys
from pathlib import Path
src,live=map(Path,sys.argv[1:])
for name,item in json.loads((src/"manifest.json").read_text())["files"].items():
 assert hashlib.sha256((live/name).read_bytes()).hexdigest()==item["after"],name
print("DEXA_IGNORE_CHAT_LIVE_HASHES_OK")
PY
(cd "$D";node --test $QA) > "$W/post.log" 2>&1
grep -q '^# pass 29$' "$W/post.log";grep -q '^# fail 0$' "$W/post.log"
[[ "$(pgrep -u 1000 -x wechat | head -n1)" == "$WECHAT_GUI" && "$(readlink /opt/capability-fabric/current)" == "$CF_RELEASE" ]] || exit 16
for u in dexa-main.service dexa-catalog-gateway.service capability-fabric-pcg-wechat-semantic-manual.service;do systemctl --user is-active --quiet "$u" || exit 17;done
health | python3 -c 'import json,sys;x=json.load(sys.stdin);assert x["ok"] and x["activeMissions"]==0 and x["deploymentDrain"]["active"] and x["storedMissions"]>=int(sys.argv[1])' "$BEFORE"
committed=1;rm -f "$F";marked=0;trap - EXIT
health | python3 -c 'import json,sys;x=json.load(sys.stdin);assert x["ok"] and not x["deploymentDrain"]["active"];print("DEXA_SERVICE_CHAT_FILTER_LIVE",x["storedMissions"])'
