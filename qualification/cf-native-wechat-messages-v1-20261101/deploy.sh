#!/usr/bin/env bash
set -Eeuo pipefail
if [[ "$(id -un)" == root ]];then
 exec /usr/sbin/runuser -u cfserver -- /usr/bin/env HOME=/home/cfserver \
  XDG_RUNTIME_DIR=/run/user/1000 DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus \
  /bin/bash "$0"
fi
[[ "$(id -un)" == cfserver ]] || exit 10
export HOME=/home/cfserver XDG_RUNTIME_DIR=/run/user/1000 \
 DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus
SRC=/tmp/cf-native-wechat-messages-v1-20261101
WORK=/home/cfserver/.local/share/dexa/cf-native-wechat-messages-v1-release-20261101
NATIVE=/home/cfserver/wechat-media-tools-candidate-20261030
DRAIN=/home/cfserver/.local/share/dexa/deployment-drain.flag
GUI="$(pgrep -u 1000 -x wechat | head -n1)"
[[ -n "$GUI" && -d "$SRC/native" && ! -e "$WORK" && ! -e "$DRAIN" ]] || exit 11
systemctl --user is-active --quiet capability-fabric-pcg-wechat-semantic-manual.service
systemctl --user is-active --quiet dexa-main.service
health(){ curl -fsS --max-time 5 http://127.0.0.1:9471/healthz; }
before="$(health | node -e 'let s="";process.stdin.on("data",x=>s+=x).on("end",()=>{const d=JSON.parse(s);if(!d.ok||d.activeMissions!==0||d.deploymentDrain?.active||d.storedMissions<425)process.exit(2);console.log(d.storedMissions)})')"
mkdir -m 700 -p "$WORK" "$WORK/backup" "$WORK/candidate"
python3 - "$SRC" "$WORK" "$NATIVE" <<'PY'
from pathlib import Path
import json,hashlib,shutil,sys
src,work,native=map(Path,sys.argv[1:])
m=json.loads((src/'manifest.json').read_text())
assert m['schema']=='cf.native-wechat-message-list-release.v1'
assert m['source_commit']=='5042d059ebb59fb581a2309965b314f4d68b00b9'
assert len(m['files'])==3
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
for rel,v in m['files'].items():
    assert rel.startswith('native/') and len(Path(rel).parts)==2
    p=src/rel;dest=native/Path(rel).name
    assert p.is_file() and sha(p)==v['candidate'],('SOURCE_HASH',rel)
    assert (not dest.exists()) if v['baseline'] is None else (sha(dest)==v['baseline']),('BASE_HASH',rel)
    shutil.copy2(p,work/'candidate'/Path(rel).name)
    if v['baseline'] is not None:shutil.copy2(dest,work/'backup'/Path(rel).name)
print('CF_NATIVE_WECHAT_MESSAGES_SOURCE_AND_BASE_HASHES_VERIFIED')
PY
cp "$NATIVE/wechat_native_ui_receipt_v1.py" "$WORK/candidate/"
cp "$NATIVE/test_wechat_native_ui_receipt_v1.py" "$WORK/candidate/"
cp "$NATIVE/test_wechat_chat_projection_v1.py" "$WORK/candidate/"
(cd "$WORK/candidate"; python3 -m py_compile *.py;python3 -m unittest -q \
 test_wechat_message_projection_v1.py test_wechat_native_ui_receipt_v1.py \
 test_wechat_chat_projection_v1.py) > "$WORK/pre.log" 2>&1
grep -q 'Ran 26 tests' "$WORK/pre.log"
grep -q '^OK$' "$WORK/pre.log"
echo CF_NATIVE_WECHAT_MESSAGES_STAGE_26_PASS
marked=0;changed=0;committed=0
cleanup(){
 rc=$?
 trap - EXIT
 if (( rc!=0 && changed==1 && committed==0 ));then
  echo CF_NATIVE_WECHAT_MESSAGES_ROLLBACK
  cp "$WORK/backup/wechat_semantic_helper_chooser_fixed_20261031.py" "$NATIVE/wechat_semantic_helper_chooser_fixed_20261031.py"
  rm -f "$NATIVE/wechat_message_projection_v1.py" "$NATIVE/test_wechat_message_projection_v1.py"
  systemctl --user restart capability-fabric-pcg-wechat-semantic-manual.service || true
 fi
 if (( marked==1 ));then rm -f "$DRAIN";fi
 exit "$rc"
}
trap cleanup EXIT
( set -C;printf '%s\n' 'Bounded native WeChat messages tool installation; no provider sends' > "$DRAIN" )
marked=1
stable=0
for ((i=0;i<55;i++));do
 if health | node -e 'let s="";process.stdin.on("data",x=>s+=x).on("end",()=>{const d=JSON.parse(s);process.exit(d.ok&&d.activeMissions===0&&d.deploymentDrain?.active===true?0:1)})';then
  stable=$((stable+1))
 else stable=0;fi
 ((stable>=2))&&break
 sleep 1
done
((stable>=2)) || exit 12
python3 - "$SRC" "$NATIVE" <<'PY'
from pathlib import Path
import json,hashlib,sys
src,native=map(Path,sys.argv[1:]);m=json.loads((src/'manifest.json').read_text())
for rel,v in m['files'].items():
 p=native/Path(rel).name
 assert not p.exists() if v['baseline'] is None else hashlib.sha256(p.read_bytes()).hexdigest()==v['baseline'],rel
print('CF_NATIVE_WECHAT_MESSAGES_PRECOMMIT_HASH_PASS')
PY
changed=1
for f in wechat_message_projection_v1.py test_wechat_message_projection_v1.py wechat_semantic_helper_chooser_fixed_20261031.py;do
 cp "$WORK/candidate/$f" "$NATIVE/.$f.new"
 chmod 600 "$NATIVE/.$f.new"
 mv -f "$NATIVE/.$f.new" "$NATIVE/$f"
done
systemctl --user restart capability-fabric-pcg-wechat-semantic-manual.service
ready=0
for ((i=0;i<65;i++));do
 if systemctl --user is-active --quiet capability-fabric-pcg-wechat-semantic-manual.service &&
  curl -fsS --max-time 4 http://127.0.0.1:9337/status 2>/dev/null |
  node -e 'let s="";process.stdin.on("data",x=>s+=x).on("end",()=>{let d=JSON.parse(s);process.exit(d.authenticated===true?0:2)})';then ready=1;break;fi
 sleep 1
done
((ready==1)) || exit 13
[[ "$(pgrep -u 1000 -x wechat | head -n1)" == "$GUI" ]] || exit 14
python3 - "$SRC" "$NATIVE" <<'PY'
from pathlib import Path
import hashlib,json,sys
src,native=map(Path,sys.argv[1:]);m=json.loads((src/'manifest.json').read_text())
for rel,v in m['files'].items():
 assert hashlib.sha256((native/Path(rel).name).read_bytes()).hexdigest()==v['candidate'],rel
print('CF_NATIVE_WECHAT_MESSAGES_LIVE_3_SHA_MATCH')
PY
(cd "$NATIVE";python3 -m unittest -q test_wechat_message_projection_v1.py test_wechat_native_ui_receipt_v1.py test_wechat_chat_projection_v1.py)> "$WORK/post.log" 2>&1
grep -q 'Ran 26 tests' "$WORK/post.log"
grep -q '^OK$' "$WORK/post.log"
rm -f "$DRAIN"; marked=0
health | node -e 'let s="";process.stdin.on("data",x=>s+=x).on("end",()=>{let d=JSON.parse(s);if(!d.ok||d.activeMissions!==0||d.deploymentDrain?.active||d.storedMissions<Number(process.argv[1]))process.exit(2);console.log("CF_NATIVE_WECHAT_MESSAGES_LIVE_HEALTH",d.storedMissions)})' "$before"
committed=1
echo CF_NATIVE_WECHAT_MESSAGES_V1_LIVE_VERIFIED_26_TESTS
