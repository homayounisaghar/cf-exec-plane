#!/usr/bin/env bash
set -Eeuo pipefail
if [[ "$(id -un)" == root ]];then
  exec /usr/sbin/runuser -u cfserver -- /usr/bin/env \
    HOME=/home/cfserver XDG_RUNTIME_DIR=/run/user/1000 \
    DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus \
    /bin/bash "$0"
fi
[[ "$(id -un)" == cfserver ]] || exit 40
export HOME=/home/cfserver XDG_RUNTIME_DIR=/run/user/1000 \
 DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus
SRC=/tmp/dexa-chat-read-plan-v2-20261101-v2
WORK=/home/cfserver/.local/share/dexa/chat-read-plan-v2-release-20261101-v2
DEXA=/var/lib/capability-fabric/paa-remote/dexa-mvp
DRAIN=/home/cfserver/.local/share/dexa/deployment-drain.flag
CF_RELEASE="$(readlink /opt/capability-fabric/current)"
GUI_PID="$(pgrep -u 1000 -x wechat | head -n1)"
[[ -n "$GUI_PID" && -d "$SRC/dexa" && ! -e "$WORK" && ! -e "$DRAIN" ]] || exit 41
for unit in dexa-main.service dexa-catalog-gateway.service capability-fabric-pcg-wechat-semantic-manual.service;do
  systemctl --user is-active --quiet "$unit" || exit 42
done
health(){ curl -fsS --max-time 5 http://127.0.0.1:9471/healthz; }
before="$(health | node -e 'let s="";process.stdin.on("data",x=>s+=x).on("end",()=>{let d=JSON.parse(s);if(!d.ok||d.activeMissions!==0||d.deploymentDrain?.active||d.storedMissions<418)process.exit(3);console.log(d.storedMissions)})')"
mkdir -m 700 -p "$WORK" "$WORK/backup" "$WORK/candidate" "$WORK/tests"
cp "$SRC/manifest.json" "$WORK/candidate-manifest.json"
python3 - "$SRC" "$WORK" "$DEXA" <<'PY'
from pathlib import Path
import json,hashlib,shutil,sys
src,work,dexa=map(Path,sys.argv[1:])
m=json.loads((src/'manifest.json').read_text())
assert m['schema']=='dexa.chat-read-plan-v2.release.v1'
assert m['source_commit']=='a0694eb4d7f4ba73d5a6433a058d8185eefb7ca5'
assert len(m['files'])==4
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
for rel,v in m['files'].items():
    assert rel.startswith('dexa/') and len(Path(rel).parts)==2, rel
    origin=src/rel;dest=dexa/Path(rel).name
    assert origin.is_file() and sha(origin)==v['candidate'],('SOURCE_SHA',rel)
    assert ((not dest.exists()) if v['baseline'] is None else
            (dest.is_file() and not dest.is_symlink() and sha(dest)==v['baseline'])),('BASE_SHA',rel)
    staged=work/'candidate'/rel
    staged.parent.mkdir(parents=True,exist_ok=True)
    shutil.copy2(origin,staged)
    if v['baseline'] is not None:
        b=work/'backup'/rel;b.parent.mkdir(parents=True,exist_ok=True)
        shutil.copy2(dest,b)
    print('SOURCE_AND_BASE_VERIFIED',rel)
PY
for source in "$WORK/candidate/dexa/"*.mjs;do node --check "$source";done
node --input-type=module - "$WORK/candidate/dexa/dexa_catalog_output_shapes_v1.json" <<'JS'
import fs from 'node:fs';
const f=process.argv[2],m=JSON.parse(fs.readFileSync(f,'utf8'));
if(m.schema!=='dexa.catalog-output-shapes.v1' ||
 m.adapters?.wechat_unread_list?.arrays?.conversations?.fieldTypes?.name!=='string' ||
 m.adapters?.wechat_unread_list?.arrays?.conversations?.fieldTypes?.unread_count!=='integer')
 process.exit(3);
console.log('TYPED_UNREAD_CONVERSATIONS_CONTRACT_VERIFIED');
JS
cp "$DEXA/"*.mjs "$WORK/tests/"
cp "$DEXA/"*.json "$WORK/tests/"
cp "$WORK/candidate/dexa/"* "$WORK/tests/"
QA="test_dexa_unread_output_contract_v2.mjs test_dexa_chat_semantic_planner_v1.mjs test_dexa_verified_replan_prefix_v1.mjs test_dexa_root_plan_answer_contract_v1.mjs test_dexa_native_recipient_contract_v1.mjs test_dexa_video_observation_v1.mjs test_dexa_workflow_kernel.mjs test_dexa_mission_control_future_v1.mjs test_dexa_catalog_read_recovery_v1.mjs test_dexa_tool_plan_v3.mjs test_dexa_native_ui_observation_v1.mjs test_dexa_messaging_record_contract_v1.mjs test_dexa_general_plan_cycle_20261025.mjs"
(cd "$WORK/tests";node --test $QA) > "$WORK/js-qa.log" 2>&1
grep -q '^# tests 91$' "$WORK/js-qa.log"
grep -q '^# pass 91$' "$WORK/js-qa.log"
grep -q '^# fail 0$' "$WORK/js-qa.log"
echo DEXA_READ_PLAN_V2_91_STAGE_TESTS_PASS
marked=0
changed=0
committed=0
rollback(){
 if [[ "$changed" == 1 && "$committed" != 1 ]];then
  echo DEXA_READ_PLAN_V2_ROLLBACK
  python3 - "$WORK" "$DEXA" <<'PY'
import os,json,sys
from pathlib import Path
work,dexa=map(Path,sys.argv[1:])
m=json.loads((work/'candidate-manifest.json').read_text())
for rel,v in m['files'].items():
  dest=dexa/Path(rel).name
  if v['baseline'] is None:
    dest.unlink(missing_ok=True)
  else:
    source=work/'backup'/rel
    tmp=dest.with_name(dest.name+'.readplan-rollback')
    tmp.write_bytes(source.read_bytes());tmp.chmod(0o600);os.replace(tmp,dest)
PY
  systemctl --user restart dexa-main.service || true
 fi
}
cleanup(){
 rc=$?
 trap - EXIT
 if [[ "$rc" != 0 ]];then rollback;fi
 if [[ "$marked" == 1 ]];then rm -f "$DRAIN";fi
 exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
( set -C; printf '%s\n' 'Dexa typed chat read planning v2; drain only; no provider sends' > "$DRAIN" )
marked=1
stable=0
for ((i=0;i<55;i++));do
 if health | node -e 'let s="";process.stdin.on("data",x=>s+=x).on("end",()=>{let d=JSON.parse(s);process.exit(d.ok&&d.activeMissions===0&&d.deploymentDrain?.active===true?0:2)})';then
   stable=$((stable+1))
 else
   stable=0
 fi
 (( stable>=2 )) && break
 sleep 1
done
(( stable>=2 )) || exit 50
python3 - "$SRC" "$DEXA" <<'PY'
from pathlib import Path
import json,hashlib,sys
src,dexa=map(Path,sys.argv[1:])
m=json.loads((src/'manifest.json').read_text())
for rel,v in m['files'].items():
    p=dexa/Path(rel).name
    assert (not p.exists()) if v['baseline'] is None else (hashlib.sha256(p.read_bytes()).hexdigest()==v['baseline']),rel
print('DEXA_READ_PLAN_V2_PRECOMMIT_HASHES_PASS')
PY
changed=1
python3 - "$SRC" "$DEXA" <<'PY'
import os,json,sys
from pathlib import Path
src,dexa=map(Path,sys.argv[1:])
m=json.loads((src/'manifest.json').read_text())
for rel in m['files']:
    dst=dexa/Path(rel).name;tmp=dst.with_name(dst.name+'.readplan-new')
    tmp.write_bytes((src/rel).read_bytes());tmp.chmod(0o600);os.replace(tmp,dst)
print('DEXA_READ_PLAN_V2_INSTALLED',len(m['files']))
PY
systemctl --user restart dexa-main.service
healthy=0
for ((i=0;i<65;i++));do
 if health 2>/dev/null | node -e 'let s="";process.stdin.on("data",x=>s+=x).on("end",()=>{try{let d=JSON.parse(s);process.exit(d.ok&&d.activeMissions===0&&d.deploymentDrain?.active===true&&d.storedMissions>=Number(process.argv[1])?0:2)}catch{process.exit(2)}})' "$before";then
   healthy=1;break
 fi
 sleep 1
done
(( healthy==1 )) || exit 51
systemctl --user is-active --quiet dexa-main.service
systemctl --user is-active --quiet dexa-catalog-gateway.service
systemctl --user is-active --quiet capability-fabric-pcg-wechat-semantic-manual.service
[[ "$(pgrep -u 1000 -x wechat | head -n1)" == "$GUI_PID" ]] || exit 52
[[ "$(readlink /opt/capability-fabric/current)" == "$CF_RELEASE" ]] || exit 53
python3 - "$SRC" "$DEXA" <<'PY'
from pathlib import Path
import json,hashlib,sys
src,dexa=map(Path,sys.argv[1:])
m=json.loads((src/'manifest.json').read_text())
for rel,v in m['files'].items():
    p=dexa/Path(rel).name
    assert p.is_file() and hashlib.sha256(p.read_bytes()).hexdigest()==v['candidate'], rel
print('DEXA_READ_PLAN_V2_LIVE_SOURCE_SHA_4_OF_4')
PY
(cd "$DEXA";node --test $QA) > "$WORK/js-post.log" 2>&1
grep -q '^# tests 91$' "$WORK/js-post.log"
grep -q '^# pass 91$' "$WORK/js-post.log"
grep -q '^# fail 0$' "$WORK/js-post.log"
echo DEXA_READ_PLAN_V2_91_LIVE_TESTS_PASS
rm -f "$DRAIN"
marked=0
health | node -e 'let s="";process.stdin.on("data",x=>s+=x).on("end",()=>{let d=JSON.parse(s);if(!d.ok||d.activeMissions!==0||d.deploymentDrain?.active||d.storedMissions<Number(process.argv[1]))process.exit(3);console.log("DEXA_READ_PLAN_V2_LIVE_HEALTH",d.storedMissions,d.activeMissions)})' "$before"
committed=1
echo DEXA_READ_PLAN_V2_LIVE_VERIFIED_NO_PROVIDER_SEND
