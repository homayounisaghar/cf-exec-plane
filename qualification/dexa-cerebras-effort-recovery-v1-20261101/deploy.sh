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
SRC=/tmp/dexa-cerebras-effort-recovery-v1-20261101
WORK=/home/cfserver/.local/share/dexa/dexa-cerebras-effort-recovery-v1-20261101
DEXA=/var/lib/capability-fabric/paa-remote/dexa-mvp
DRAIN=/home/cfserver/.local/share/dexa/deployment-drain.flag
CF_RELEASE="$(readlink /opt/capability-fabric/current)"
WECHAT_GUI="$(pgrep -u 1000 -x wechat | head -n1)"
[[ -n "$WECHAT_GUI" && -d "$SRC/dexa" && ! -e "$WORK" && ! -e "$DRAIN" ]] || exit 11
for unit in dexa-main.service dexa-catalog-gateway.service capability-fabric-pcg-wechat-semantic-manual.service;do
 systemctl --user is-active --quiet "$unit" || exit 12
done
health(){ curl -fsS --max-time 5 http://127.0.0.1:9471/healthz; }
BEFORE="$(health | node -e 'let s="";process.stdin.on("data",x=>s+=x).on("end",()=>{const d=JSON.parse(s);if(!d.ok||d.activeMissions!==0||d.deploymentDrain?.active||d.storedMissions<429)process.exit(3);console.log(d.storedMissions)})')"
mkdir -m 700 -p "$WORK" "$WORK/backup" "$WORK/candidate" "$WORK/tests"
cp "$SRC/manifest.json" "$WORK/manifest.json"
python3 - "$SRC" "$WORK" "$DEXA" <<'PY'
import json,hashlib,shutil,sys
from pathlib import Path
src,work,live=map(Path,sys.argv[1:])
m=json.loads((src/'manifest.json').read_text())
assert m['schema']=='dexa.cerebras-effort-recovery.v1'
assert m['source_commit']=='d0cd4bf1f858536a5fb3220c9b54007dc19da2a0'
assert len(m['files'])==2 and m['no_catalog_change'] and m['no_cf_server_change']
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
for rel,item in m['files'].items():
 assert rel.startswith('dexa/') and len(Path(rel).parts)==2,rel
 candidate=src/rel;old=live/Path(rel).name
 assert candidate.is_file() and sha(candidate)==item['candidate'],('SNAPSHOT_HASH',rel)
 assert old.is_file() and not old.is_symlink() and sha(old)==item['baseline'],('LIVE_BASELINE_DRIFT',rel)
 shutil.copy2(candidate,work/'candidate'/Path(rel).name)
 shutil.copy2(old,work/'backup'/Path(rel).name)
 print('GUARDED_BASELINE_AND_SOURCE_SHA_OK',rel)
PY
cp "$DEXA/"*.mjs "$WORK/tests/"
cp "$DEXA/"*.json "$WORK/tests/"
cp "$WORK/candidate/"* "$WORK/tests/"
for f in "$WORK/candidate/"*.mjs;do node --check "$f";done
QA="test_dexa_cerebras_api_planner_v1.mjs test_dexa_universal_unread_contract_v1.mjs test_dexa_wechat_message_list_v1.mjs test_dexa_chat_semantic_planner_v1.mjs test_dexa_tool_plan_v3.mjs"
(cd "$WORK/tests";node --test $QA) > "$WORK/pre.log" 2>&1
grep -q '^# tests 30$' "$WORK/pre.log"
grep -q '^# pass 30$' "$WORK/pre.log"
grep -q '^# fail 0$' "$WORK/pre.log"
echo DEXA_CEREBRAS_RECOVERY_STAGE_30_PASS
marked=0
changed=0
committed=0
rollback(){
 if ((changed==1 && committed==0));then
  echo DEXA_CEREBRAS_RECOVERY_ROLLBACK
  for name in cerebras_api_planner.mjs test_dexa_cerebras_api_planner_v1.mjs;do
   dest="$DEXA/$name";tmp="$DEXA/.$name.effort-rollback"
   cp "$WORK/backup/$name" "$tmp";chmod 600 "$tmp";mv -f "$tmp" "$dest"
  done
  systemctl --user restart dexa-main.service || true
 fi
}
cleanup(){
 rc=$?
 trap - EXIT
 if ((rc!=0));then rollback;fi
 if ((marked==1));then rm -f "$DRAIN";fi
 exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
( set -C;printf '%s\n' 'Cerebras Qwen effort recovery medium; model-only, no CF or catalog mutations' > "$DRAIN" )
marked=1
stable=0
for ((i=0;i<60;i++));do
 if health 2>/dev/null | node -e 'let s="";process.stdin.on("data",x=>s+=x).on("end",()=>{let d=JSON.parse(s);process.exit(d.ok&&d.activeMissions===0&&d.deploymentDrain?.active===true?0:2)})';then
  stable=$((stable+1))
 else stable=0;fi
 ((stable>=3)) && break
 sleep 1
done
((stable>=3)) || exit 13
python3 - "$SRC" "$DEXA" <<'PY'
import hashlib,json,sys
from pathlib import Path
src,live=map(Path,sys.argv[1:])
m=json.loads((src/'manifest.json').read_text())
for rel,item in m['files'].items():
 assert hashlib.sha256((live/Path(rel).name).read_bytes()).hexdigest()==item['baseline'],rel
print('DEXA_CEREBRAS_RECOVERY_PRECOMMIT_BASELINE_VERIFIED')
PY
changed=1
for name in cerebras_api_planner.mjs test_dexa_cerebras_api_planner_v1.mjs;do
 tmp="$DEXA/.$name.effort-new";dest="$DEXA/$name"
 cp "$WORK/candidate/$name" "$tmp";chmod 600 "$tmp";mv -f "$tmp" "$dest"
done
systemctl --user restart dexa-main.service
ready=0
for ((i=0;i<75;i++));do
 if health 2>/dev/null | node -e 'let s="";process.stdin.on("data",x=>s+=x).on("end",()=>{let d=JSON.parse(s);process.exit(d.ok&&d.activeMissions===0&&d.deploymentDrain?.active===true&&d.storedMissions>=Number(process.argv[1])?0:2)})' "$BEFORE";then
  ready=1;break
 fi
 sleep 1
done
((ready==1)) || exit 14
[[ "$(readlink /opt/capability-fabric/current)" == "$CF_RELEASE" ]] || exit 15
[[ "$(pgrep -u 1000 -x wechat | head -n1)" == "$WECHAT_GUI" ]] || exit 16
for unit in dexa-main.service dexa-catalog-gateway.service capability-fabric-pcg-wechat-semantic-manual.service;do
 systemctl --user is-active --quiet "$unit" || exit 17
done
python3 - "$SRC" "$DEXA" <<'PY'
import hashlib,json,sys
from pathlib import Path
src,live=map(Path,sys.argv[1:])
m=json.loads((src/'manifest.json').read_text())
for rel,item in m['files'].items():
 assert hashlib.sha256((live/Path(rel).name).read_bytes()).hexdigest()==item['candidate'],rel
p=(live/'cerebras_api_planner.mjs').read_text()
assert 'reasoning_effort:"medium"' in p and 'reasoning_effort:"xhigh"' not in p
import json
assert len(json.loads((live/'rana_capability_catalog.json').read_text()))==298
assert len(json.loads((live/'rana_cf_tool_schemas.json').read_text())['cf'])==194
print('DEXA_CEREBRAS_RECOVERY_LIVE_2_SHA_298_CATALOG_194_CF_MEDIUM')
PY
(cd "$DEXA";node --test $QA) > "$WORK/post.log" 2>&1
grep -q '^# tests 30$' "$WORK/post.log"
grep -q '^# pass 30$' "$WORK/post.log"
grep -q '^# fail 0$' "$WORK/post.log"
rm -f "$DRAIN"
marked=0
health | node -e 'let s="";process.stdin.on("data",x=>s+=x).on("end",()=>{const d=JSON.parse(s);if(!d.ok||d.activeMissions!==0||d.deploymentDrain?.active||d.storedMissions<Number(process.argv[1]))process.exit(3);console.log("DEXA_CEREBRAS_RECOVERY_LIVE_HEALTH",d.storedMissions,d.activeMissions)})' "$BEFORE"
committed=1
echo DEXA_CEREBRAS_RECOVERY_MEDIUM_LIVE_VERIFIED
