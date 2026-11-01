#!/bin/sh
set -eu
# Secret-free immutable Dexa provider-observed video evidence release.
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
SOURCE=/tmp/dexa-tool-mode-v1-20261101
WORK="$HOME/.local/share/dexa/tool-mode-v1-release-20261101"
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
  echo DEXA_TOOL_MODE_V1_ROLLBACK_STARTED
  for f in "$BACKUP"/*; do
   [ -f "$f" ] || continue
   cp "$f" "$BASE/$(basename "$f")"
   chmod 600 "$BASE/$(basename "$f")"
  done
    systemctl --user restart dexa-catalog-gateway.service || true
  systemctl --user restart dexa-main.service || true
  echo DEXA_TOOL_MODE_V1_ROLLBACK_FINISHED
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
assert m['schema']=='dexa.tool-mode-structural.release.v1'
assert m['release_id']=='dexa-tool-mode-v1-20261101'
assert m['canonicalSource']['commit']=='cf74c08771715dc9182852b6818b85da444e4edb'
assert (m['expected']['catalog'],m['expected']['nativeCF'])==(297,193)
assert m['expected']['offlineTests']==139 and m['expected']['postreleaseTests']==56
assert m['cfServerChanged'] is False and m['providerSendForQualification'] is False
assert m['servicesToRestart']==['dexa-catalog-gateway.service','dexa-main.service']
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
assert sha(src/'tool-mode.patch')==m['patchSha256'],'PUBLIC_PATCH_CHANGED'
for name,digest in m['liveBaselineSha256'].items():
    f=live/name
    assert f.is_file() and not f.is_symlink() and sha(f)==digest,'LIVE_BASELINE_CHANGED:'+name
    shutil.copyfile(f,backup/name)
for extension in ('.mjs','.json','.txt'):
    for file in live.iterdir():
        if file.is_file() and not file.is_symlink() and file.suffix==extension:
            shutil.copyfile(file,cand/file.name)
test_name='test_dexa_video_observation_v1.mjs'
assert (live/test_name).is_file(),'BASELINE_TEST_MISSING'
result=subprocess.run(['patch','-s','-d',str(cand),'-p1'],
                      input=(src/'tool-mode.patch').read_bytes(),
                      capture_output=True)
assert result.returncode==0,'PATCH_FAILED:'+result.stderr.decode()[:400]
for name,digest in m['candidateSha256'].items():
    assert sha(cand/name)==digest,'CANDIDATE_HASH_MISMATCH:'+name
print('DEXA_TOOL_MODE_V1_EXACT_SOURCES_VERIFIED',
      len(m['liveBaselineSha256']),len(m['candidateSha256']))
PY
for name in dexa_general_plan_cycle_v2.mjs dexa_typed_planner_prompt_v3.mjs test_dexa_video_observation_v1.mjs; do
 node --check "$CANDIDATE/$name" >/dev/null
done
cd "$CANDIDATE"
node --input-type=module - <<'JS'
import {catalogCounts} from './dexa_catalog_registry.mjs';
import {catalogKnownOutputShape} from './dexa_catalog_output_adapters_v1.mjs';
import {attachCanonicalMessagingView} from './dexa_messaging_record_contract_v1.mjs';
const c=catalogCounts(),route='telegram.message.read_recent';
const shape=catalogKnownOutputShape(route);
const m=shape?.arrays?.messages?.semanticValueMappings?.media_open_kind?.video;
const one=attachCanonicalMessagingView({nativeTool:'telegram_message_list',
 readOnly:true,result:{state:'ACHIEVED',messages:[
 {kind:'message',handle:'fixture:video',media_type:'messageMediaDocument',
  media_open_kind:null,attachments:[{handle:'fixture:media',
   media_kind:'file',media_type:'video/mp4',size_bytes:100}]}
 ]}});
if(c.catalog!==297||c.cfMapped!==193||
 m?.collection!=='canonical_messages'||m?.value!=='video'||
 one?.canonical_messages?.[0]?.type!=='video'||
 one?.messages?.[0]?.media_open_kind!==null)process.exit(2);
console.log('DEXA_TOOL_MODE_V1_CANONICAL_CONTRACT_VERIFIED',c.catalog,c.cfMapped);
JS
node --test test_dexa_video_observation_v1.mjs test_dexa_voice_media_category_proof_v1.mjs test_dexa_fast_architecture_20261025.mjs test_dexa_native_recipient_contract_v1.mjs test_dexa_identity_closure_v1.mjs test_dexa_read_identity_dependency_closure_v1.mjs test_dexa_global_entity_resolver_v1.mjs test_dexa_general_plan_cycle_20261025.mjs test_dexa_owner_decision_stage1_v1.mjs test_dexa_material_stream_v1.mjs test_dexa_material_stream_integration_v1.mjs test_dexa_tool_plan_v3.mjs test_dexa_catalog_broker_admission.mjs test_dexa_workflow_kernel.mjs test_dexa_planner_output_canonicalizer.mjs > "$WORK/qualification.log" 2>&1 || { echo DEXA_TOOL_MODE_V1_TESTS_FAILED;tail -n 40 "$WORK/qualification.log";exit 47; }
grep -q '^# tests 139$' "$WORK/qualification.log" || exit 48
grep -q '^# pass 139$' "$WORK/qualification.log" || exit 49
grep -q '^# fail 0$' "$WORK/qualification.log" || exit 50
echo DEXA_TOOL_MODE_V1_OFFLINE_139_OF_139_PASS
health(){ curl -fsS --max-time 4 http://127.0.0.1:9471/healthz; }
before="$(health | node -e 'let s="";process.stdin.on("data",x=>s+=x).on("end",()=>{let d=JSON.parse(s);if(!d.ok||d.activeMissions!==0||d.deploymentDrain?.active||d.storedMissions<407)process.exit(3);console.log(d.storedMissions)})')"
( set -C; printf 'Guarded Dexa native recipient identity release\n' > "$DRAIN" )
marked=1
i=0
while [ "$i" -lt 90 ]; do
 if health | node -e 'let s="";process.stdin.on("data",x=>s+=x).on("end",()=>{let d=JSON.parse(s);process.exit(d.ok&&d.activeMissions===0&&d.deploymentDrain?.active===true?0:2)})'; then break; fi
 i=$((i+1));sleep 1
done
[ "$i" -lt 90 ] || { echo DEXA_TOOL_MODE_V1_DRAIN_TIMEOUT; exit 51; }
python3 - "$SOURCE/manifest.json" "$BASE" <<'PY'
import hashlib,json,sys
from pathlib import Path
m=json.loads(Path(sys.argv[1]).read_text());live=Path(sys.argv[2])
for name,digest in m['liveBaselineSha256'].items():
 assert hashlib.sha256((live/name).read_bytes()).hexdigest()==digest,name
print('DEXA_TOOL_MODE_V1_PRECOMMIT_BASELINES_STILL_EXACT')
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
print('DEXA_TOOL_MODE_V1_FILES_INSTALLED',len(m['candidateSha256']))
PY
systemctl --user restart dexa-catalog-gateway.service
systemctl --user restart dexa-main.service
i=0
while [ "$i" -lt 70 ]; do
 if health 2>/dev/null | node -e 'let s="";process.stdin.on("data",x=>s+=x).on("end",()=>{try{let d=JSON.parse(s);process.exit(d.ok&&d.activeMissions===0&&d.deploymentDrain?.active===true&&d.storedMissions>=Number(process.argv[1])?0:2)}catch{process.exit(2)}})' "$before"; then break; fi
 i=$((i+1));sleep 1
done
[ "$i" -lt 70 ] || { echo DEXA_TOOL_MODE_V1_POSTRESTART_HEALTH_TIMEOUT; exit 52; }
systemctl --user is-active --quiet dexa-main.service || exit 53
systemctl --user is-active --quiet dexa-catalog-gateway.service || exit 54
python3 - "$SOURCE/manifest.json" "$BASE" <<'PY'
import hashlib,json,sys
from pathlib import Path
m=json.loads(Path(sys.argv[1]).read_text());live=Path(sys.argv[2])
for name,digest in m['candidateSha256'].items():
 assert hashlib.sha256((live/name).read_bytes()).hexdigest()==digest,name
print('DEXA_TOOL_MODE_V1_POSTRESTART_HASHES_VERIFIED',len(m['candidateSha256']))
PY
cd "$BASE"
node --test test_dexa_video_observation_v1.mjs test_dexa_voice_media_category_proof_v1.mjs test_dexa_native_recipient_contract_v1.mjs test_dexa_identity_closure_v1.mjs test_dexa_read_identity_dependency_closure_v1.mjs test_dexa_material_stream_v1.mjs test_dexa_material_stream_integration_v1.mjs > "$WORK/postrelease.log" 2>&1 || { echo DEXA_TOOL_MODE_V1_POSTRELEASE_FAILED;tail -n 35 "$WORK/postrelease.log";exit 55; }
grep -q '^# tests 56$' "$WORK/postrelease.log" || exit 56
grep -q '^# pass 56$' "$WORK/postrelease.log" || exit 57
grep -q '^# fail 0$' "$WORK/postrelease.log" || exit 58
node --input-type=module - <<'JS'
import {catalogCounts} from './dexa_catalog_registry.mjs';
import {catalogKnownOutputShape} from './dexa_catalog_output_adapters_v1.mjs';
const c=catalogCounts(),map=catalogKnownOutputShape('telegram.message.read_recent')
 ?.arrays?.messages?.semanticValueMappings?.media_open_kind?.video;
if(c.catalog!==297||c.cfMapped!==193||
 map?.collection!=='canonical_messages'||map?.value!=='video')
 process.exit(2);
console.log('DEXA_TOOL_MODE_V1_LIVE_MODULES_VERIFIED',c.catalog,c.cfMapped);
JS
echo DEXA_TOOL_MODE_V1_LIVE_STAGED_VERIFIED
rm -f "$DRAIN"
marked=0
health | node -e 'let s="";process.stdin.on("data",x=>s+=x).on("end",()=>{let d=JSON.parse(s);if(!d.ok||d.storedMissions<Number(process.argv[1])||d.deploymentDrain?.active)process.exit(2);console.log("DEXA_TOOL_MODE_V1_LIVE_HEALTH",JSON.stringify({stored:d.storedMissions,active:d.activeMissions,drain:d.deploymentDrain.active}))})' "$before"
committed=1
echo DEXA_TOOL_MODE_V1_LIVE_VERIFIED_NO_PROVIDER_SEND
