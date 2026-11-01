#!/bin/sh
set -eu
# Secret-free immutable Dexa native-recipient contract release.
# Only the original Dexa main and catalog gateway user units are restarted.
if [ "$(id -un)" = root ]; then
 exec /usr/sbin/runuser -u cfserver -- /usr/bin/env HOME=/home/cfserver XDG_RUNTIME_DIR=/run/user/1000 DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus /bin/sh "$0"
fi
[ "$(id -un)" = cfserver ] || { echo DEXA_WRONG_OWNER >&2; exit 41; }
export HOME=/home/cfserver
export XDG_RUNTIME_DIR=/run/user/1000
export DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus
systemctl --user is-active --quiet dexa-main.service || exit 42
systemctl --user is-active --quiet dexa-catalog-gateway.service || exit 43
BASE=/var/lib/capability-fabric/paa-remote/dexa-mvp
SOURCE=/tmp/dexa-native-recipient-v1-20261101
WORK="$HOME/.local/share/dexa/native-recipient-v1-release-20261101"
CANDIDATE="$WORK/candidate"
BACKUP="$WORK/backup"
DRAIN="$HOME/.local/share/dexa/deployment-drain.flag"
[ ! -e "$WORK" ] || { echo DEXA_RELEASE_ALREADY_ATTEMPTED >&2; exit 44; }
[ ! -e "$DRAIN" ] || { echo DEXA_ALREADY_DRAINED >&2; exit 45; }
test -f "$SOURCE/manifest.json" || exit 46
install -d -m 700 "$WORK" "$CANDIDATE" "$BACKUP"
changed=0
committed=0
marked=0
rollback(){
 if [ "$changed" -eq 1 ] && [ "$committed" -ne 1 ]; then
  echo DEXA_NATIVE_RECIPIENT_ROLLBACK_STARTED
  for f in "$BACKUP"/*; do
   [ -f "$f" ] || continue
   cp "$f" "$BASE/$(basename "$f")"
   chmod 600 "$BASE/$(basename "$f")"
  done
  rm -f "$BASE/test_dexa_native_recipient_contract_v1.mjs"
  systemctl --user restart dexa-catalog-gateway.service || true
  systemctl --user restart dexa-main.service || true
  echo DEXA_NATIVE_RECIPIENT_ROLLBACK_FINISHED
 fi
}
cleanup(){
 code=$?
 trap - EXIT
 if [ "$code" -ne 0 ]; then rollback; fi
 if [ "$marked" -eq 1 ]; then rm -f "$DRAIN"; fi
 exit "$code"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
python3 - "$SOURCE" "$BASE" "$CANDIDATE" "$BACKUP" <<'PY'
from pathlib import Path
import hashlib,json,shutil,sys,subprocess
src,live,cand,backup=(Path(x) for x in sys.argv[1:])
m=json.loads((src/'manifest.json').read_text())
assert m['schema']=='dexa.native-recipient.release.v1'
assert m['release_id']=='dexa-native-recipient-v1-20261101'
assert m['canonicalSource']['commit']=='1c0264d84601d92e3877ae99f6b45c6321b80931'
assert (m['expected']['catalog'],m['expected']['nativeCF'])==(297,193)
assert m['expected']['offlineTests']==116
assert m['cfServerChanged'] is False and m['providerSendForQualification'] is False
assert m['servicesToRestart']==['dexa-catalog-gateway.service','dexa-main.service']
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
assert sha(src/'native-recipient.patch')==m['patchSha256'],'PUBLIC_PATCH_CHANGED'
for name,digest in m['liveBaselineSha256'].items():
    f=live/name
    assert f.is_file() and not f.is_symlink() and sha(f)==digest,'LIVE_BASELINE_CHANGED:'+name
    shutil.copyfile(f,backup/name)
for extension in ('.mjs','.json','.txt'):
    for file in live.iterdir():
        if file.is_file() and not file.is_symlink() and file.suffix==extension:
            shutil.copyfile(file,cand/file.name)
test_name='test_dexa_native_recipient_contract_v1.mjs'
assert not (live/test_name).exists(),'NEW_TEST_COLLIDES_WITH_EXISTING'
shutil.copyfile(src/test_name,cand/test_name)
result=subprocess.run(['patch','-s','-d',str(cand),'-p1'],
                      input=(src/'native-recipient.patch').read_bytes(),
                      capture_output=True)
assert result.returncode==0,'PATCH_FAILED:'+result.stderr.decode()[:400]
for name,digest in m['candidateSha256'].items():
    assert sha(cand/name)==digest,'CANDIDATE_HASH_MISMATCH:'+name
print('DEXA_NATIVE_RECIPIENT_EXACT_SOURCES_VERIFIED',
      len(m['liveBaselineSha256']),len(m['candidateSha256']))
PY
for name in dexa_general_plan_contract_v1.mjs dexa_provider_identity_closure_v1.mjs dexa_general_plan_cycle_v2.mjs dexa_typed_planner_prompt_v3.mjs test_dexa_native_recipient_contract_v1.mjs; do
 node --check "$CANDIDATE/$name" >/dev/null
done
cd "$CANDIDATE"
node --input-type=module - <<'JS'
import {catalogCounts} from './dexa_catalog_registry.mjs';
import {catalogKnownOutputShape} from './dexa_catalog_output_adapters_v1.mjs';
let c=catalogCounts();
let source=catalogKnownOutputShape('tool.cf.wechat_conversation_list');
let sink=catalogKnownOutputShape('tool.cf.wechat_file_send');
if(c.catalog!==297||c.cfMapped!==193||
 !source?.arrays?.conversations?.fields?.includes('name')||
 sink?.identityInputs?.target?.kind!=='NATIVE_UNIQUE_EXACT_LABEL')
 process.exit(2);
console.log('DEXA_NATIVE_RECIPIENT_TYPED_METADATA_VERIFIED',c.catalog,c.cfMapped);
JS
node --test test_dexa_native_recipient_contract_v1.mjs test_dexa_identity_closure_v1.mjs test_dexa_read_identity_dependency_closure_v1.mjs test_dexa_global_entity_resolver_v1.mjs test_dexa_fast_architecture_20261025.mjs test_dexa_general_plan_cycle_20261025.mjs test_dexa_owner_decision_stage1_v1.mjs test_dexa_material_stream_v1.mjs test_dexa_material_stream_integration_v1.mjs test_dexa_tool_plan_v3.mjs test_dexa_catalog_broker_admission.mjs test_dexa_workflow_kernel.mjs > "$WORK/qualification.log" 2>&1 || { echo DEXA_NATIVE_RECIPIENT_TESTS_FAILED; tail -n 35 "$WORK/qualification.log"; exit 47; }
grep -q '^# tests 116$' "$WORK/qualification.log" || exit 48
grep -q '^# pass 116$' "$WORK/qualification.log" || exit 49
grep -q '^# fail 0$' "$WORK/qualification.log" || exit 50
echo DEXA_NATIVE_RECIPIENT_OFFLINE_116_OF_116_PASS
health(){ curl -fsS --max-time 4 http://127.0.0.1:9471/healthz; }
before="$(health | node -e 'let s="";process.stdin.on("data",x=>s+=x).on("end",()=>{let d=JSON.parse(s);if(!d.ok||d.activeMissions!==0||d.deploymentDrain?.active||d.storedMissions<399)process.exit(3);console.log(d.storedMissions)})')"
( set -C; printf 'Guarded Dexa native recipient identity release\n' > "$DRAIN" )
marked=1
i=0
while [ "$i" -lt 90 ]; do
 if health | node -e 'let s="";process.stdin.on("data",x=>s+=x).on("end",()=>{let d=JSON.parse(s);process.exit(d.ok&&d.activeMissions===0&&d.deploymentDrain?.active===true?0:2)})'; then break; fi
 i=$((i+1));sleep 1
done
[ "$i" -lt 90 ] || { echo DEXA_NATIVE_RECIPIENT_DRAIN_TIMEOUT; exit 51; }
python3 - "$SOURCE/manifest.json" "$BASE" <<'PY'
import hashlib,json,sys
from pathlib import Path
m=json.loads(Path(sys.argv[1]).read_text());live=Path(sys.argv[2])
for name,digest in m['liveBaselineSha256'].items():
 assert hashlib.sha256((live/name).read_bytes()).hexdigest()==digest,name
print('DEXA_NATIVE_RECIPIENT_PRECOMMIT_BASELINES_STILL_EXACT')
PY
changed=1
python3 - "$SOURCE/manifest.json" "$BASE" "$CANDIDATE" <<'PY'
import json,os,sys
from pathlib import Path
m=json.loads(Path(sys.argv[1]).read_text());live=Path(sys.argv[2]);cand=Path(sys.argv[3])
for name in m['candidateSha256']:
 target=live/name;temp=live/(name+'.native-identity-v1.tmp')
 temp.write_bytes((cand/name).read_bytes())
 temp.chmod(0o600)
 os.replace(temp,target)
print('DEXA_NATIVE_RECIPIENT_FILES_INSTALLED',len(m['candidateSha256']))
PY
systemctl --user restart dexa-catalog-gateway.service
systemctl --user restart dexa-main.service
i=0
while [ "$i" -lt 70 ]; do
 if health 2>/dev/null | node -e 'let s="";process.stdin.on("data",x=>s+=x).on("end",()=>{try{let d=JSON.parse(s);process.exit(d.ok&&d.activeMissions===0&&d.deploymentDrain?.active===true&&d.storedMissions>=Number(process.argv[1])?0:2)}catch{process.exit(2)}})' "$before"; then break; fi
 i=$((i+1));sleep 1
done
[ "$i" -lt 70 ] || { echo DEXA_NATIVE_RECIPIENT_POSTRESTART_HEALTH_TIMEOUT; exit 52; }
systemctl --user is-active --quiet dexa-main.service || exit 53
systemctl --user is-active --quiet dexa-catalog-gateway.service || exit 54
python3 - "$SOURCE/manifest.json" "$BASE" <<'PY'
import hashlib,json,sys
from pathlib import Path
m=json.loads(Path(sys.argv[1]).read_text());live=Path(sys.argv[2])
for name,digest in m['candidateSha256'].items():
 assert hashlib.sha256((live/name).read_bytes()).hexdigest()==digest,name
print('DEXA_NATIVE_RECIPIENT_POSTRESTART_HASHES_VERIFIED',len(m['candidateSha256']))
PY
cd "$BASE"
node --test test_dexa_native_recipient_contract_v1.mjs test_dexa_identity_closure_v1.mjs test_dexa_read_identity_dependency_closure_v1.mjs test_dexa_material_stream_v1.mjs test_dexa_material_stream_integration_v1.mjs > "$WORK/postrelease.log" 2>&1 || { echo DEXA_NATIVE_RECIPIENT_POSTRELEASE_FAILED;tail -n 30 "$WORK/postrelease.log";exit 55; }
grep -q '^# fail 0$' "$WORK/postrelease.log" || exit 56
node --input-type=module - <<'JS'
import {catalogCounts} from './dexa_catalog_registry.mjs';
import {catalogKnownOutputShape} from './dexa_catalog_output_adapters_v1.mjs';
const c=catalogCounts();
if(c.catalog!==297||c.cfMapped!==193||
 catalogKnownOutputShape('tool.cf.wechat_file_send')?.identityInputs?.target?.kind!=='NATIVE_UNIQUE_EXACT_LABEL')
 process.exit(2);
console.log('DEXA_NATIVE_RECIPIENT_LIVE_MODULES_VERIFIED',c.catalog,c.cfMapped);
JS
echo DEXA_NATIVE_RECIPIENT_LIVE_STAGED_VERIFIED
committed=1
rm -f "$DRAIN"
marked=0
health | node -e 'let s="";process.stdin.on("data",x=>s+=x).on("end",()=>{let d=JSON.parse(s);if(!d.ok||d.storedMissions<Number(process.argv[1])||d.deploymentDrain?.active)process.exit(2);console.log("DEXA_NATIVE_RECIPIENT_LIVE_HEALTH",JSON.stringify({stored:d.storedMissions,active:d.activeMissions,drain:d.deploymentDrain.active}))})' "$before"
echo DEXA_NATIVE_RECIPIENT_V1_LIVE_VERIFIED_NO_PROVIDER_SEND
