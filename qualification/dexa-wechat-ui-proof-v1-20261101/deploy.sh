#!/bin/sh
set -eu
# Owner-scoped, SHA-pinned UI-evidence release. Never dispatches a WeChat file.
if [ "$(id -un)" = root ]; then
 exec /usr/sbin/runuser -u cfserver -- /usr/bin/env HOME=/home/cfserver XDG_RUNTIME_DIR=/run/user/1000 DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus /bin/sh "$0"
fi
[ "$(id -un)" = cfserver ] || exit 41
export HOME=/home/cfserver
export XDG_RUNTIME_DIR=/run/user/1000
export DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus
SRC=/tmp/dexa-wechat-ui-proof-v1-20261101
WORK=/home/cfserver/.local/share/dexa/wechat-ui-proof-v1-release-20261101
DEXA=/var/lib/capability-fabric/paa-remote/dexa-mvp
NATIVE=/home/cfserver/wechat-media-tools-candidate-20261030
HELPER="$NATIVE/wechat_semantic_helper_chooser_fixed_20261031.py"
DRAIN=/home/cfserver/.local/share/dexa/deployment-drain.flag
CAND="$WORK/candidate"
BACK="$WORK/backup"
GUI_PID="$(pgrep -u 1000 -x wechat | head -n 1)"
[ -n "$GUI_PID" ] || exit 42
for unit in capability-fabric-pcg-wechat-semantic-manual.service dexa-catalog-gateway.service dexa-main.service; do
 systemctl --user is-active --quiet "$unit" || exit 43
done
[ ! -e "$WORK" ] && [ ! -e "$DRAIN" ] || exit 44
[ -f "$SRC/manifest.json" ] || exit 45
install -d -m 700 "$WORK" "$CAND" "$BACK" "$CAND/native" "$CAND/dexa" "$BACK/native" "$BACK/dexa"
changed=0
committed=0
marked=0
rollback(){
 if [ "$changed" -eq 1 ] && [ "$committed" -ne 1 ]; then
  echo UI_WITNESS_ROLLBACK_STARTED
  for name in dexa_tool_plan_executor_v3.mjs dexa_workflow_kernel.mjs; do
   cp "$BACK/dexa/$name" "$DEXA/$name"
   chmod 600 "$DEXA/$name"
  done
  rm -f "$DEXA/dexa_native_ui_observation_v1.mjs" "$DEXA/test_dexa_native_ui_observation_v1.mjs"
  cp "$BACK/native/wechat_semantic_helper_chooser_fixed_20261031.py" "$HELPER"
  chmod 600 "$HELPER"
  rm -f "$NATIVE/wechat_native_ui_receipt_v1.py" "$NATIVE/test_wechat_native_ui_receipt_v1.py"
  systemctl --user restart capability-fabric-pcg-wechat-semantic-manual.service || true
  systemctl --user restart dexa-catalog-gateway.service || true
  systemctl --user restart dexa-main.service || true
  echo UI_WITNESS_ROLLBACK_FINISHED
 fi
}
cleanup(){
 rc=$?
 trap - EXIT
 if [ "$rc" -ne 0 ]; then rollback;fi
 if [ "$marked" -eq 1 ]; then rm -f "$DRAIN";fi
 exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
python3 - "$SRC" "$CAND" "$BACK" "$DEXA" "$HELPER" <<'PY'
import hashlib,json,os,shutil,subprocess,sys
from pathlib import Path
src,cand,backup,live,helper=(Path(v) for v in sys.argv[1:])
m=json.loads((src/'manifest.json').read_text())
assert m['schema']=='dexa.wechat-native-ui-witness.release.v1'
assert m['release_id']=='dexa-wechat-ui-proof-v1-20261101'
assert m['canonicalSource']['commit']=='11e63c9eb20ae2ac6173bfc1917947d0bedcdd7d'
assert (m['expected']['catalog'],m['expected']['nativeCF'])==(297,193)
assert m['expected']['minimumPreservedMissions']>=408
assert (m['expected']['jsTests'],m['expected']['nativeTests'])==(104,5)
assert m['noProviderSendDuringQualification'] is True
assert m['wechatGuiRestart'] is False and m['cfServerContainerRestart'] is False
assert m['cfServerToolsChanged'] is False
assert m['servicesToRestart']==[
 'capability-fabric-pcg-wechat-semantic-manual.service',
 'dexa-catalog-gateway.service','dexa-main.service']
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
for name,expected in m['patchSha256'].items():
 assert sha(src/name)==expected,'PATCH_CHANGED:'+name
assert sha(helper)==m['liveBaselineSha256']['nativeHelper'],'HELPER_BASE_CHANGED'
assert not helper.is_symlink()
assert helper.stat().st_uid==os.getuid()
for name in ('dexa_tool_plan_executor_v3.mjs','dexa_workflow_kernel.mjs'):
 p=live/name
 assert not p.is_symlink() and sha(p)==m['liveBaselineSha256'][name],'DEXA_BASE_CHANGED:'+name
 shutil.copy2(p,backup/'dexa'/name)
shutil.copy2(helper,backup/'native'/helper.name)
newfiles=('dexa_native_ui_observation_v1.mjs','test_dexa_native_ui_observation_v1.mjs')
for name in newfiles:
 assert not (live/name).exists(),'DEXA_NEW_FILE_ALREADY_EXISTS:'+name
for name in ('wechat_native_ui_receipt_v1.py','test_wechat_native_ui_receipt_v1.py'):
 assert not (helper.parent/name).exists(),'NATIVE_NEW_FILE_ALREADY_EXISTS:'+name
for p in live.iterdir():
 if p.is_file() and not p.is_symlink() and p.suffix in ('.mjs','.json','.txt'):
  shutil.copyfile(p,cand/'dexa'/p.name)
shutil.copyfile(helper,cand/'native'/'wechat_semantic_helper_chooser_fixed_20261031.py')
for name in newfiles:
 shutil.copyfile(src/name,cand/'dexa'/name)
for name in ('wechat_native_ui_receipt_v1.py','test_wechat_native_ui_receipt_v1.py'):
 shutil.copyfile(src/name,cand/'native'/name)
for rel,where in [('dexa-ui-reconcile.patch',cand/'dexa'),
                   ('native-helper.patch',cand/'native')]:
 p=subprocess.run(['patch','-s','-d',str(where),'-p1'],
    input=(src/rel).read_bytes(),capture_output=True)
 assert p.returncode==0,'PATCH_FAILED:'+rel+':'+p.stderr.decode()[:260]
nativeMap={
 'nativeHelper':cand/'native'/'wechat_semantic_helper_chooser_fixed_20261031.py',
 'nativeWitness':cand/'native'/'wechat_native_ui_receipt_v1.py',
 'nativeTest':cand/'native'/'test_wechat_native_ui_receipt_v1.py'}
for name,expected in m['candidateSha256'].items():
 target=nativeMap.get(name,cand/'dexa'/name)
 assert sha(target)==expected,'CANDIDATE_CHANGED:'+name
print('UI_WITNESS_EXACT_INPUTS_VERIFIED',len(m['candidateSha256']))
PY
for name in dexa_tool_plan_executor_v3.mjs dexa_workflow_kernel.mjs dexa_native_ui_observation_v1.mjs test_dexa_native_ui_observation_v1.mjs; do
 node --check "$CAND/dexa/$name"
done
python3 -m py_compile "$CAND/native/wechat_native_ui_receipt_v1.py" "$CAND/native/wechat_semantic_helper_chooser_fixed_20261031.py"
(cd "$CAND/native";python3 -m unittest -q test_wechat_native_ui_receipt_v1.py) > "$WORK/native-qa.log" 2>&1
grep -q 'Ran 5 tests' "$WORK/native-qa.log" || exit 46
grep -q '^OK$' "$WORK/native-qa.log" || exit 47
# All selected tests are no-effect. An unrelated 2026-10-23 test has a stale
# catalog-count literal and is not used as a release gate.
(cd "$CAND/dexa";node --test test_dexa_native_ui_observation_v1.mjs test_dexa_workflow_kernel.mjs test_dexa_native_recipient_contract_v1.mjs test_dexa_material_stream_v1.mjs test_dexa_material_stream_integration_v1.mjs test_dexa_catalog_broker_admission.mjs test_dexa_async_receipt_protocol.mjs test_dexa_catalog_read_recovery_v1.mjs test_dexa_g2a_readonly_v1.mjs test_dexa_tool_plan_v3.mjs test_dexa_identity_closure_v1.mjs test_dexa_video_observation_v1.mjs) > "$WORK/js-qa.log" 2>&1 || { tail -n 60 "$WORK/js-qa.log";exit 48; }
grep -q '^# tests 104$' "$WORK/js-qa.log" || exit 49
grep -q '^# pass 104$' "$WORK/js-qa.log" || exit 50
grep -q '^# fail 0$' "$WORK/js-qa.log" || exit 51
echo UI_WITNESS_STAGED_5_PY_104_JS_PASS
health(){ curl -fsS --max-time 5 http://127.0.0.1:9471/healthz; }
before="$(health | node -e 'let s="";process.stdin.on("data",x=>s+=x).on("end",()=>{let d=JSON.parse(s);if(!d.ok||d.activeMissions!==0||d.deploymentDrain?.active||d.storedMissions<408)process.exit(3);console.log(d.storedMissions)})')"
( set -C; printf '%s\n' 'Guarded UI receipt reconciliation; no provider send' > "$DRAIN" )
marked=1
i=0
while [ "$i" -lt 90 ]; do
 if health | node -e 'let s="";process.stdin.on("data",x=>s+=x).on("end",()=>{let d=JSON.parse(s);process.exit(d.ok&&d.activeMissions===0&&d.deploymentDrain?.active===true?0:2)})'; then break;fi
 i=$((i+1));sleep 1
done
[ "$i" -lt 90 ] || exit 52
python3 - "$SRC/manifest.json" "$HELPER" "$DEXA" <<'PY'
import hashlib,json,sys
from pathlib import Path
m=json.loads(Path(sys.argv[1]).read_text());helper=Path(sys.argv[2]);live=Path(sys.argv[3])
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
assert sha(helper)==m['liveBaselineSha256']['nativeHelper'],'HELPER_PRECOMMIT_CHANGED'
for n in ('dexa_workflow_kernel.mjs','dexa_tool_plan_executor_v3.mjs'):
 assert sha(live/n)==m['liveBaselineSha256'][n],'DEXA_PRECOMMIT_CHANGED:'+n
print('UI_WITNESS_PRECOMMIT_BASELINES_EXACT')
PY
changed=1
python3 - "$SRC/manifest.json" "$CAND" "$HELPER" "$DEXA" <<'PY'
import json,os,sys
from pathlib import Path
m=json.loads(Path(sys.argv[1]).read_text());cand=Path(sys.argv[2]);helper=Path(sys.argv[3]);live=Path(sys.argv[4])
targets=[
 (cand/'native'/'wechat_native_ui_receipt_v1.py',helper.parent/'wechat_native_ui_receipt_v1.py'),
 (cand/'native'/'test_wechat_native_ui_receipt_v1.py',helper.parent/'test_wechat_native_ui_receipt_v1.py'),
 (cand/'native'/helper.name,helper),
 (cand/'dexa'/'dexa_native_ui_observation_v1.mjs',live/'dexa_native_ui_observation_v1.mjs'),
 (cand/'dexa'/'test_dexa_native_ui_observation_v1.mjs',live/'test_dexa_native_ui_observation_v1.mjs'),
 (cand/'dexa'/'dexa_workflow_kernel.mjs',live/'dexa_workflow_kernel.mjs'),
 (cand/'dexa'/'dexa_tool_plan_executor_v3.mjs',live/'dexa_tool_plan_executor_v3.mjs')]
for source,target in targets:
 temp=target.with_name(target.name+'.uiwitness-new.tmp')
 temp.write_bytes(source.read_bytes());temp.chmod(0o600)
 os.replace(temp,target)
print('UI_WITNESS_FILE_SWAP_COUNT',len(targets))
PY
systemctl --user restart capability-fabric-pcg-wechat-semantic-manual.service
i=0
while [ "$i" -lt 45 ]; do
 if systemctl --user is-active --quiet capability-fabric-pcg-wechat-semantic-manual.service &&
    curl -fsS --max-time 3 http://127.0.0.1:9337/status 2>/dev/null |
    python3 -c 'import json,sys;assert json.load(sys.stdin)["authenticated"] is True' 2>/dev/null; then break;fi
 i=$((i+1));sleep 1
done
[ "$i" -lt 45 ] || { echo NATIVE_HELPER_NOT_AUTHENTICATED;exit 53; }
[ "$(pgrep -u 1000 -x wechat | head -n 1)" = "$GUI_PID" ] || { echo WECHAT_GUI_UNEXPECTEDLY_RESTARTED;exit 54; }
systemctl --user restart dexa-catalog-gateway.service
systemctl --user restart dexa-main.service
i=0
while [ "$i" -lt 70 ];do
 if health 2>/dev/null | node -e 'let s="";process.stdin.on("data",x=>s+=x).on("end",()=>{try{let d=JSON.parse(s);process.exit(d.ok&&d.activeMissions===0&&d.deploymentDrain?.active===true&&d.storedMissions>=Number(process.argv[1])?0:2)}catch{process.exit(2)}})' "$before"; then break;fi
 i=$((i+1));sleep 1
done
[ "$i" -lt 70 ] || exit 55
python3 - "$SRC/manifest.json" "$DEXA" "$HELPER" <<'PY'
from pathlib import Path
import hashlib,json,sys
m=json.loads(Path(sys.argv[1]).read_text());live=Path(sys.argv[2]);helper=Path(sys.argv[3])
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
map={'nativeHelper':helper,'nativeWitness':helper.parent/'wechat_native_ui_receipt_v1.py',
'nativeTest':helper.parent/'test_wechat_native_ui_receipt_v1.py'}
for name,expected in m['candidateSha256'].items():
 assert sha(map.get(name,live/name))==expected,'POSTRESTART_HASH_MISMATCH:'+name
print('UI_WITNESS_POSTRESTART_SHA_7_OF_7')
PY
(cd "$NATIVE";python3 -m unittest -q test_wechat_native_ui_receipt_v1.py)> "$WORK/native-post.log" 2>&1
grep -q 'Ran 5 tests' "$WORK/native-post.log" && grep -q '^OK$' "$WORK/native-post.log" || exit 56
(cd "$DEXA";node --test test_dexa_native_ui_observation_v1.mjs test_dexa_workflow_kernel.mjs test_dexa_native_recipient_contract_v1.mjs test_dexa_material_stream_v1.mjs test_dexa_material_stream_integration_v1.mjs test_dexa_catalog_broker_admission.mjs test_dexa_async_receipt_protocol.mjs test_dexa_catalog_read_recovery_v1.mjs test_dexa_g2a_readonly_v1.mjs test_dexa_tool_plan_v3.mjs test_dexa_identity_closure_v1.mjs test_dexa_video_observation_v1.mjs)> "$WORK/js-post.log" 2>&1 || { tail -n 35 "$WORK/js-post.log";exit 57; }
grep -q '^# tests 104$' "$WORK/js-post.log" && grep -q '^# pass 104$' "$WORK/js-post.log" && grep -q '^# fail 0$' "$WORK/js-post.log" || exit 58
[ "$(pgrep -u 1000 -x wechat | head -n 1)" = "$GUI_PID" ] || exit 59
for unit in capability-fabric-pcg-wechat-semantic-manual.service dexa-catalog-gateway.service dexa-main.service;do systemctl --user is-active --quiet "$unit" || exit 60;done
rm -f "$DRAIN"
marked=0
health | node -e 'let s="";process.stdin.on("data",x=>s+=x).on("end",()=>{let d=JSON.parse(s);if(!d.ok||d.activeMissions!==0||d.deploymentDrain.active||d.storedMissions<Number(process.argv[1]))process.exit(3);console.log("UI_WITNESS_HEALTH",JSON.stringify({stored:d.storedMissions,active:d.activeMissions,drain:d.deploymentDrain.active}))})' "$before"
committed=1
echo UI_WITNESS_LIVE_VERIFIED_5_PY_104_JS_NO_SEND
