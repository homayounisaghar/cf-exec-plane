#!/bin/sh
set -eu
if [ "$(id -un)" = root ]; then
 exec /usr/sbin/runuser -u cfserver -- /usr/bin/env HOME=/home/cfserver XDG_RUNTIME_DIR=/run/user/1000 DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus /bin/sh "$0"
fi
[ "$(id -un)" = cfserver ] || exit 41
export HOME=/home/cfserver XDG_RUNTIME_DIR=/run/user/1000 DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus
SRC=/tmp/dexa-wechat-retry-v1-20261101
WORK=/home/cfserver/.local/share/dexa/wechat-retry-v1-release-20261101-v1
DEXA=/var/lib/capability-fabric/paa-remote/dexa-mvp
NATIVE=/home/cfserver/wechat-media-tools-candidate-20261030
DRAIN=/home/cfserver/.local/share/dexa/deployment-drain.flag
GUI_PID="$(pgrep -u 1000 -x wechat | head -n 1)"
[ -n "$GUI_PID" ] || exit 42
[ ! -e "$WORK" ] && [ ! -e "$DRAIN" ] || exit 43
for unit in capability-fabric-pcg-wechat-semantic-manual.service dexa-catalog-gateway.service dexa-main.service; do
 systemctl --user is-active --quiet "$unit" || exit 44
done
mkdir -m 700 -p "$WORK" "$WORK/backup" "$WORK/candidate"
python3 - "$SRC" "$WORK" "$DEXA" "$NATIVE" <<'PY'
import hashlib,json,shutil,sys
from pathlib import Path
src,work,dexa,native=map(Path,sys.argv[1:])
m=json.loads((src/'manifest.json').read_text())
assert m['schema']=='dexa.wechat-retry.release.v1'
assert m['source_commit']=='cb26d6f4675dc44b80fd954a3aef273a5a0b05fa'
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
for rel,values in m['files'].items():
 dest=native/Path(rel).name if rel.startswith('native/') else dexa/Path(rel).name
 candidate=src/rel
 assert candidate.is_file() and sha(candidate)==values['candidate'],('SOURCE_SHA',rel)
 assert dest.is_file() and not dest.is_symlink() and sha(dest)==values['baseline'],('BASE_SHA',rel)
 b=work/'backup'/rel;c=work/'candidate'/rel
 b.parent.mkdir(parents=True,exist_ok=True)
 c.parent.mkdir(parents=True,exist_ok=True)
 shutil.copy2(dest,b);shutil.copy2(candidate,c)
 print('SOURCE_BASE_MATCH',rel)
PY
python3 -m py_compile "$WORK/candidate/native/"*.py
for f in "$WORK/candidate/dexa/"*.mjs; do node --check "$f"; done
# Native tests run against staged isolated module.
(cd "$WORK/candidate/native";python3 -m unittest -q test_wechat_native_ui_receipt_v1.py) > "$WORK/native-qa.log" 2>&1
grep -q 'Ran 9 tests' "$WORK/native-qa.log"
grep -q '^OK$' "$WORK/native-qa.log"
# Copy the unmodified running dependency tree for import-only test execution.
mkdir -p "$WORK/tests"
cp "$DEXA/"*.mjs "$WORK/tests/"
cp "$DEXA/"*.json "$WORK/tests/"
cp "$WORK/candidate/dexa/"*.mjs "$WORK/tests/"
(cd "$WORK/tests";node --test test_dexa_native_ui_observation_v1.mjs test_dexa_workflow_kernel.mjs test_dexa_native_recipient_contract_v1.mjs test_dexa_material_stream_v1.mjs test_dexa_material_stream_integration_v1.mjs test_dexa_catalog_broker_admission.mjs test_dexa_async_receipt_protocol.mjs test_dexa_catalog_read_recovery_v1.mjs test_dexa_g2a_readonly_v1.mjs test_dexa_tool_plan_v3.mjs test_dexa_identity_closure_v1.mjs test_dexa_video_observation_v1.mjs) > "$WORK/js-qa.log" 2>&1
grep -q '^# pass 105$' "$WORK/js-qa.log"
grep -q '^# fail 0$' "$WORK/js-qa.log"
echo WECHAT_RETRY_NO_EFFECT_STAGING_9_PY_105_JS_PASS
health(){ curl -fsS --max-time 5 http://127.0.0.1:9471/healthz; }
before="$(health | node -e 'let s="";process.stdin.on("data",x=>s+=x).on("end",()=>{let d=JSON.parse(s);if(!d.ok||d.activeMissions!==0||d.deploymentDrain?.active||d.storedMissions<410)process.exit(3);console.log(d.storedMissions)})')"
marked=0
changed=0
committed=0
rollback(){
 if [ "$changed" -eq 1 ] && [ "$committed" -ne 1 ]; then
  echo WECHAT_RETRY_ROLLBACK
  python3 - "$WORK" "$DEXA" "$NATIVE" <<'PY'
import os,sys
from pathlib import Path
work,dexa,native=map(Path,sys.argv[1:])
for b in (work/'backup').rglob('*'):
 if not b.is_file():continue
 rel=b.relative_to(work/'backup')
 dest=native/rel.name if rel.parts[0]=='native' else dexa/rel.name
 tmp=dest.with_name(dest.name+'.retry-rollback')
 tmp.write_bytes(b.read_bytes());tmp.chmod(0o600);os.replace(tmp,dest)
PY
  systemctl --user restart capability-fabric-pcg-wechat-semantic-manual.service || true
  systemctl --user restart dexa-catalog-gateway.service || true
  systemctl --user restart dexa-main.service || true
 fi
}
cleanup(){
 rc=$?
 trap - EXIT
 if [ "$rc" -ne 0 ];then rollback;fi
 if [ "$marked" -eq 1 ];then rm -f "$DRAIN";fi
 exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
( set -C; printf '%s\n' 'Bounded failed-video retry v1; no sends during release' > "$DRAIN" )
marked=1
i=0
while [ "$i" -lt 50 ];do
 if health | node -e 'let s="";process.stdin.on("data",x=>s+=x).on("end",()=>{let d=JSON.parse(s);process.exit(d.ok&&d.activeMissions===0&&d.deploymentDrain?.active===true?0:2)})';then break;fi
 i=$((i+1));sleep 1
done
[ "$i" -lt 50 ] || exit 51
python3 - "$SRC" "$DEXA" "$NATIVE" <<'PY'
import json,hashlib,sys
from pathlib import Path
src,dexa,native=map(Path,sys.argv[1:])
m=json.loads((src/'manifest.json').read_text())
for rel,v in m['files'].items():
 p=(native if rel.startswith('native/') else dexa)/Path(rel).name
 assert hashlib.sha256(p.read_bytes()).hexdigest()==v['baseline'],rel
print('WECHAT_RETRY_PRECOMMIT_SHA_MATCH')
PY
changed=1
python3 - "$SRC" "$DEXA" "$NATIVE" <<'PY'
import json,os,sys
from pathlib import Path
src,dexa,native=map(Path,sys.argv[1:])
m=json.loads((src/'manifest.json').read_text())
for rel in m['files']:
 dest=(native if rel.startswith('native/') else dexa)/Path(rel).name
 tmp=dest.with_name(dest.name+'.retry-new')
 tmp.write_bytes((src/rel).read_bytes());tmp.chmod(0o600);os.replace(tmp,dest)
print('WECHAT_RETRY_APPLIED',len(m['files']))
PY
systemctl --user restart capability-fabric-pcg-wechat-semantic-manual.service
i=0
while [ "$i" -lt 45 ];do
 if systemctl --user is-active --quiet capability-fabric-pcg-wechat-semantic-manual.service &&
  curl -fsS --max-time 3 http://127.0.0.1:9337/status 2>/dev/null |
  python3 -c 'import json,sys;assert json.load(sys.stdin)["authenticated"] is True' 2>/dev/null;then break;fi
 i=$((i+1));sleep 1
done
[ "$i" -lt 45 ] || exit 52
[ "$(pgrep -u 1000 -x wechat | head -n 1)" = "$GUI_PID" ] || exit 53
systemctl --user restart dexa-catalog-gateway.service
systemctl --user restart dexa-main.service
i=0
while [ "$i" -lt 60 ];do
 if health 2>/dev/null | node -e 'let s="";process.stdin.on("data",x=>s+=x).on("end",()=>{try{let d=JSON.parse(s);process.exit(d.ok&&d.activeMissions===0&&d.deploymentDrain?.active===true&&d.storedMissions>=Number(process.argv[1])?0:2)}catch{process.exit(2)}})' "$before";then break;fi
 i=$((i+1));sleep 1
done
[ "$i" -lt 60 ] || exit 54
python3 - "$SRC" "$DEXA" "$NATIVE" <<'PY'
import json,hashlib,sys
from pathlib import Path
src,dexa,native=map(Path,sys.argv[1:])
m=json.loads((src/'manifest.json').read_text())
for rel,v in m['files'].items():
 p=(native if rel.startswith('native/') else dexa)/Path(rel).name
 assert hashlib.sha256(p.read_bytes()).hexdigest()==v['candidate'],rel
print('WECHAT_RETRY_POST_DEPLOY_SHA_7_OF_7')
PY
(cd "$NATIVE";python3 -m unittest -q test_wechat_native_ui_receipt_v1.py)> "$WORK/native-post.log" 2>&1
grep -q 'Ran 9 tests' "$WORK/native-post.log" && grep -q '^OK$' "$WORK/native-post.log"
(cd "$DEXA";node --test test_dexa_native_ui_observation_v1.mjs test_dexa_workflow_kernel.mjs test_dexa_native_recipient_contract_v1.mjs test_dexa_material_stream_v1.mjs test_dexa_material_stream_integration_v1.mjs test_dexa_catalog_broker_admission.mjs test_dexa_async_receipt_protocol.mjs test_dexa_catalog_read_recovery_v1.mjs test_dexa_g2a_readonly_v1.mjs test_dexa_tool_plan_v3.mjs test_dexa_identity_closure_v1.mjs test_dexa_video_observation_v1.mjs)> "$WORK/js-post.log" 2>&1
grep -q '^# pass 105$' "$WORK/js-post.log" && grep -q '^# fail 0$' "$WORK/js-post.log"
[ "$(pgrep -u 1000 -x wechat | head -n 1)" = "$GUI_PID" ] || exit 55
rm -f "$DRAIN"
marked=0
health | node -e 'let s="";process.stdin.on("data",x=>s+=x).on("end",()=>{let d=JSON.parse(s);if(!d.ok||d.activeMissions!==0||d.deploymentDrain?.active||d.storedMissions<Number(process.argv[1]))process.exit(3);console.log("WECHAT_RETRY_HEALTH",d.storedMissions,d.activeMissions)})' "$before"
committed=1
echo WECHAT_RETRY_LIVE_VERIFIED_NO_PROVIDER_SEND
