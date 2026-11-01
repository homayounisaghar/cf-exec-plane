#!/usr/bin/env bash
set -Eeuo pipefail
if [[ "$(id -un)" == root ]];then
 exec /usr/sbin/runuser -u cfserver -- /usr/bin/env HOME=/home/cfserver XDG_RUNTIME_DIR=/run/user/1000 DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus /bin/bash "$0"
fi
[[ "$(id -un)" == cfserver ]] || exit 10
export HOME=/home/cfserver XDG_RUNTIME_DIR=/run/user/1000 DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus
SRC=/tmp/dexa-wechat-latest-edge-v1-20261102
TARGET=/home/cfserver/wechat-media-tools-candidate-20261030
HELPER=wechat_semantic_helper_chooser_fixed_20261031.py
W=/home/cfserver/.local/share/dexa/dexa-wechat-latest-edge-v1-20261102-release
DRAIN=/home/cfserver/.local/share/dexa/deployment-drain.flag
[[ ! -e "$W" && ! -e "$DRAIN" && -f "$SRC/manifest.json" ]] || exit 11
python3 - "$SRC" "$TARGET" <<'PY'
import hashlib,json,sys
from pathlib import Path
s,t=map(Path,sys.argv[1:])
m=json.loads((s/"manifest.json").read_text())
assert m["schema"]=="dexa.wechat-latest-edge.v1"
assert m["source_commit"]=="fc33ed08dd9c5fd894b46f3b80295a88e58a2852"
assert m["scope"]=="native-wechat-helper-only" and m["python_helper_restart"]
assert m["no_cf_server_change"] and m["no_dexa_main_restart"] and m["no_wechat_gui_restart"] and m["no_connector_refresh"]
assert set(m["files"])=={"wechat_latest_edge_v1.py","test_wechat_latest_edge_v1.py","apply_latest_edge_v1.py"}
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
for n,v in m["files"].items():assert sha(s/"native"/n)==v,n
helper=t/"wechat_semantic_helper_chooser_fixed_20261031.py"
assert helper.is_file() and not helper.is_symlink() and sha(helper)==m["baseline_helper_sha256"]
assert not (t/"wechat_latest_edge_v1.py").exists()
PY
GUI_PID="$(pgrep -u 1000 -x wechat | head -n1)"
CF_LINK="$(readlink /opt/capability-fabric/current)"
[[ -n "$GUI_PID" && -n "$CF_LINK" ]] || exit 12
for unit in capability-fabric-pcg-wechat-semantic-manual.service dexa-main.service dexa-catalog-gateway.service;do systemctl --user is-active --quiet "$unit" || exit 13;done
health(){ curl -fsS --max-time 5 http://127.0.0.1:9471/healthz; }
native_health(){ curl -fsS --max-time 5 http://127.0.0.1:9337/status; }
BEFORE="$(health | python3 -c 'import sys,json;x=json.load(sys.stdin);assert x["ok"] and x["activeMissions"]==0 and not x["deploymentDrain"]["active"];print(x["storedMissions"])')"
native_health | python3 -c 'import sys,json;x=json.load(sys.stdin);assert x["ok"] and x["authenticated"]'
mkdir -p -m 700 "$W/stage" "$W/backup"
cp -p "$TARGET/$HELPER" "$TARGET/wechat_message_projection_v1.py" "$W/stage/"
cp -p "$TARGET/$HELPER" "$W/backup/"
cp "$SRC/native/"*.py "$W/stage/"
python3 "$W/stage/apply_latest_edge_v1.py" "$W/stage/$HELPER" "$W/stage/patched_helper.py"
python3 - "$SRC/manifest.json" "$W/stage" <<'PY'
import hashlib,json,sys
from pathlib import Path
m=json.loads(Path(sys.argv[1]).read_text());root=Path(sys.argv[2])
assert hashlib.sha256((root/"patched_helper.py").read_bytes()).hexdigest()==m["candidate_helper_sha256"]
PY
(cd "$W/stage"; python3 -m unittest test_wechat_latest_edge_v1 -v) > "$W/pre.log" 2>&1
grep -q '^Ran 8 tests' "$W/pre.log";grep -q '^OK$' "$W/pre.log"
python3 -m py_compile "$W/stage/patched_helper.py" "$W/stage/wechat_latest_edge_v1.py"
marked=0;installed=0;committed=0
cleanup(){
 rc=$?
 trap - EXIT
 if ((rc!=0 && installed==1 && committed==0));then
  echo WECHAT_LATEST_EDGE_ROLLBACK
  cp -p "$W/backup/$HELPER" "$TARGET/.$HELPER.rollback"
  mv -f "$TARGET/.$HELPER.rollback" "$TARGET/$HELPER"
  rm -f "$TARGET/wechat_latest_edge_v1.py"
  systemctl --user restart capability-fabric-pcg-wechat-semantic-manual.service || true
 fi
 if ((marked==1));then rm -f "$DRAIN";fi
 exit "$rc"
}
trap cleanup EXIT
( set -C; printf 'Native WeChat latest-edge read evidence, helper-only restart\n' > "$DRAIN" )
marked=1
stable=0
for i in $(seq 1 30);do
 if health 2>/dev/null | python3 -c 'import json,sys;x=json.load(sys.stdin);assert x["ok"] and x["activeMissions"]==0 and x["deploymentDrain"]["active"]' 2>/dev/null;then stable=$((stable+1));else stable=0;fi
 ((stable>=3)) && break
 sleep 1
done
((stable>=3)) || exit 14
python3 - "$SRC/manifest.json" "$TARGET/$HELPER" <<'PY'
import hashlib,json,sys
from pathlib import Path
m=json.loads(Path(sys.argv[1]).read_text())
assert hashlib.sha256(Path(sys.argv[2]).read_bytes()).hexdigest()==m["baseline_helper_sha256"]
PY
installed=1
for n in wechat_latest_edge_v1.py "$HELPER";do
 from="$W/stage/$n"
 [[ "$n" == "$HELPER" ]] && from="$W/stage/patched_helper.py"
 cp "$from" "$TARGET/.$n.new"
 if [[ "$n" == "$HELPER" ]];then
  chmod --reference="$W/backup/$HELPER" "$TARGET/.$n.new"
 else
  chmod 600 "$TARGET/.$n.new"
 fi
 mv -f "$TARGET/.$n.new" "$TARGET/$n"
done
python3 - "$SRC/manifest.json" "$TARGET" <<'PY'
import hashlib,json,sys
from pathlib import Path
m=json.loads(Path(sys.argv[1]).read_text());p=Path(sys.argv[2])
sha=lambda f:hashlib.sha256(f.read_bytes()).hexdigest()
assert sha(p/"wechat_semantic_helper_chooser_fixed_20261031.py")==m["candidate_helper_sha256"]
assert sha(p/"wechat_latest_edge_v1.py")==m["files"]["wechat_latest_edge_v1.py"]
print("NATIVE_WECHAT_LATEST_EDGE_LIVE_BYTES_VERIFIED")
PY
systemctl --user restart capability-fabric-pcg-wechat-semantic-manual.service
ready=0
for i in $(seq 1 30);do
 if native_health 2>/dev/null | python3 -c 'import json,sys;x=json.load(sys.stdin);assert x["ok"] and x["authenticated"]' 2>/dev/null;then ready=1;break;fi
 sleep 1
done
((ready==1)) || exit 15
(cd "$W/stage"; python3 -m unittest test_wechat_latest_edge_v1 -v) > "$W/post.log" 2>&1
grep -q '^Ran 8 tests' "$W/post.log";grep -q '^OK$' "$W/post.log"
[[ "$(pgrep -u 1000 -x wechat | head -n1)" == "$GUI_PID" && "$(readlink /opt/capability-fabric/current)" == "$CF_LINK" ]] || exit 16
for unit in capability-fabric-pcg-wechat-semantic-manual.service dexa-main.service dexa-catalog-gateway.service;do systemctl --user is-active --quiet "$unit" || exit 17;done
health | python3 -c 'import json,sys;x=json.load(sys.stdin);assert x["ok"] and x["activeMissions"]==0 and x["deploymentDrain"]["active"] and x["storedMissions"]>=int(sys.argv[1])' "$BEFORE"
committed=1
rm -f "$DRAIN";marked=0;trap - EXIT
health | python3 -c 'import json,sys;x=json.load(sys.stdin);assert x["ok"] and not x["deploymentDrain"]["active"];print("WECHAT_LATEST_EDGE_NATIVE_LIVE",x["storedMissions"])'
echo NATIVE_HELPER_ONLY_RESTART_NO_CONNECTOR_REFRESH
