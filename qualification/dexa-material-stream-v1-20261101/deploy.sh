#!/bin/sh
set -eu
# Immutable secret-free Dexa-only release. Only the two Dexa user services
# are restarted. Native CF-server and the WeChat helper are never modified.
if [ "$(id -un)" = root ]; then
 exec /usr/sbin/runuser -u cfserver -- /usr/bin/env HOME=/home/cfserver XDG_RUNTIME_DIR=/run/user/1000 DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus /bin/sh "$0"
fi
[ "$(id -un)" = cfserver ] || { echo DEXA_WRONG_DEPLOY_USER >&2; exit 41; }
export HOME=/home/cfserver
export XDG_RUNTIME_DIR=/run/user/1000
export DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus
systemctl --user is-active --quiet dexa-main.service || exit 42
systemctl --user is-active --quiet dexa-catalog-gateway.service || exit 43

BASE=/var/lib/capability-fabric/paa-remote/dexa-mvp
SOURCE=/tmp/dexa-material-stream-v1-20261101
WORK="$HOME/.local/share/dexa/material-stream-v1-release-20261101"
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
  echo DEXA_MATERIAL_STREAM_ROLLBACK_STARTED
  for f in "$BACKUP"/*; do
   [ -f "$f" ] || continue
   cp "$f" "$BASE/${f##*/}"
   chmod 600 "$BASE/${f##*/}"
  done
  for f in dexa_material_stream_v1.mjs dexa_mcp_material_link_v1.mjs dexa_native_material_effect_v1.mjs test_dexa_material_stream_v1.mjs test_dexa_material_stream_integration_v1.mjs; do
   rm -f "$BASE/$f"
  done
  systemctl --user restart dexa-catalog-gateway.service || true
  systemctl --user restart dexa-main.service || true
  echo DEXA_MATERIAL_STREAM_ROLLBACK_FINISHED
 fi
}
cleanup(){
 rc=$?
 trap - EXIT
 if [ "$rc" -ne 0 ]; then rollback; fi
 if [ "$marked" -eq 1 ]; then rm -f "$DRAIN"; fi
 exit "$rc"
}
trap cleanup EXIT INT TERM

python3 - "$SOURCE" "$BASE" "$CANDIDATE" "$BACKUP" <<'PY'
from pathlib import Path
import hashlib,json,shutil,sys,subprocess
source,live,candidate,backup=[Path(x) for x in sys.argv[1:]]
m=json.loads((source/'manifest.json').read_text())
assert m['schema']=='dexa.material-stream.release.v1'
assert m['release_id']=='dexa-material-stream-v1-20261101'
assert m['canonicalSource']['commit']=='35b4d31d07bded71c436faa74997066110c0fcd3'
assert m['expected']['catalog']==297 and m['expected']['nativeCF']==193
assert m['cfServerChanged'] is False
assert m['servicesToRestart']==['dexa-catalog-gateway.service','dexa-main.service']
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
assert sha(source/'material-stream.patch')==m['patchSha256'],'PATCH_HASH_FAILED'
for name,digest in m['liveBaselineSha256'].items():
 file=live/name
 assert file.is_file() and not file.is_symlink()
 assert sha(file)==digest,'LIVE_BASELINE_CHANGED:'+name
 shutil.copyfile(file,candidate/name)
 shutil.copyfile(file,backup/name)
for name in ['dexa_material_stream_v1.mjs','dexa_mcp_material_link_v1.mjs',
             'dexa_native_material_effect_v1.mjs',
             'test_dexa_material_stream_v1.mjs',
             'test_dexa_material_stream_integration_v1.mjs']:
 assert not (live/name).exists(), 'CANDIDATE_FILE_ALREADY_INSTALLED:'+name
 shutil.copyfile(source/name,candidate/name)
patch=subprocess.run(['patch','-s','-d',str(candidate),'-p1'],input=(source/'material-stream.patch').read_bytes(),capture_output=True)
assert patch.returncode==0,'PATCH_CANDIDATE_FAILED:'+patch.stderr.decode()[:500]
for name,digest in m['candidateSha256'].items():
 assert (candidate/name).is_file() and sha(candidate/name)==digest,'CANDIDATE_SHA_MISMATCH:'+name
for name in ['test_dexa_tool_plan_v3.mjs','test_dexa_workflow_kernel.mjs',
 'test_dexa_catalog_read_recovery_v1.mjs','test_dexa_g2a_readonly_v1.mjs']:
 shutil.copyfile(live/name,candidate/name)
for pattern in ['*.mjs','*.json','*.txt']:
 for file in live.glob(pattern):
  target=candidate/file.name
  if not target.exists() and not target.is_symlink():
   target.symlink_to(file)
print('DEXA_MATERIAL_STREAM_SHA_PINNED_CANDIDATE_VERIFIED',len(m['candidateSha256']))
PY

for file in "$CANDIDATE"/*.mjs; do
 [ -L "$file" ] && continue
 node --check "$file" >/dev/null
done
cd "$CANDIDATE"
node --input-type=module -e "import {catalogCounts} from './dexa_catalog_registry.mjs'; import {streamAdapter} from './dexa_material_stream_v1.mjs'; let c=catalogCounts(); if(c.catalog!==297||c.cfMapped!==193||!streamAdapter('tool.cf.wechat_file_upload','tool.cf.wechat_file_upload_chunk'))process.exit(3); console.log('DEXA_MATERIAL_STREAM_CANDIDATE_IMPORT_VERIFIED')"
node --test test_dexa_material_stream_v1.mjs test_dexa_material_stream_integration_v1.mjs test_dexa_tool_plan_v3.mjs test_dexa_workflow_kernel.mjs test_dexa_catalog_read_recovery_v1.mjs test_dexa_catalog_broker_admission.mjs test_dexa_g2a_readonly_v1.mjs > "$WORK/qualification.log" 2>&1 || { echo DEXA_MATERIAL_STREAM_TESTS_FAILED; tail -n 35 "$WORK/qualification.log"; exit 47; }
grep -q '^# tests 51$' "$WORK/qualification.log" || exit 48
grep -q '^# pass 51$' "$WORK/qualification.log" || exit 49
grep -q '^# fail 0$' "$WORK/qualification.log" || exit 50
echo DEXA_MATERIAL_STREAM_OFFLINE_51_OF_51_PASS

health(){
 curl -fsS --max-time 4 http://127.0.0.1:9471/healthz
}
before="$(health | node -e 'let s="";process.stdin.on("data",x=>s+=x).on("end",()=>{let d=JSON.parse(s);if(!d.ok||d.activeMissions!==0||d.deploymentDrain?.active||d.storedMissions<398)process.exit(3);console.log(d.storedMissions)})')"
( set -C; printf 'Dexa manifest-aligned material stream scoped release\n' > "$DRAIN" )
marked=1
i=0
while [ "$i" -lt 90 ]; do
 if health | node -e 'let s="";process.stdin.on("data",x=>s+=x).on("end",()=>{let d=JSON.parse(s);process.exit(d.ok&&d.activeMissions===0&&d.deploymentDrain?.active===true?0:2)})'; then break; fi
 i=$((i+1));sleep 1
done
[ "$i" -lt 90 ] || { echo DEXA_MATERIAL_DRAIN_TIMEOUT; exit 51; }
python3 - "$SOURCE/manifest.json" "$BASE" <<'PY'
import json,hashlib,sys
from pathlib import Path
m=json.loads(Path(sys.argv[1]).read_text());live=Path(sys.argv[2])
for name,digest in m['liveBaselineSha256'].items():
 assert hashlib.sha256((live/name).read_bytes()).hexdigest()==digest,name
print('DEXA_MATERIAL_PRECOMMIT_BASELINES_STILL_IDENTICAL')
PY
changed=1
python3 - "$SOURCE/manifest.json" "$BASE" "$CANDIDATE" <<'PY'
import json,os,sys
from pathlib import Path
m=json.loads(Path(sys.argv[1]).read_text());live=Path(sys.argv[2]);source=Path(sys.argv[3])
for name in m['candidateSha256']:
 target=live/name
 temp=live/(name+'.dexa-material-v1.tmp')
 temp.write_bytes((source/name).read_bytes())
 temp.chmod(0o600)
 os.replace(temp,target)
print('DEXA_MATERIAL_RELEASE_FILES_INSTALLED',len(m['candidateSha256']))
PY
systemctl --user restart dexa-catalog-gateway.service
systemctl --user restart dexa-main.service

i=0
while [ "$i" -lt 60 ]; do
 if health 2>/dev/null | node -e 'let s="";process.stdin.on("data",x=>s+=x).on("end",()=>{try{let d=JSON.parse(s);process.exit(d.ok&&d.activeMissions===0&&d.deploymentDrain?.active===true&&d.storedMissions>=Number(process.argv[1])?0:2)}catch{process.exit(2)}})' "$before"; then break; fi
 i=$((i+1));sleep 1
done
[ "$i" -lt 60 ] || { echo DEXA_MATERIAL_POSTRESTART_HEALTH_TIMEOUT; exit 52; }
systemctl --user is-active --quiet dexa-catalog-gateway.service || exit 53
systemctl --user is-active --quiet dexa-main.service || exit 54
python3 - "$SOURCE/manifest.json" "$BASE" <<'PY'
import json,hashlib,sys
from pathlib import Path
m=json.loads(Path(sys.argv[1]).read_text());live=Path(sys.argv[2])
for name,digest in m['candidateSha256'].items():
 assert hashlib.sha256((live/name).read_bytes()).hexdigest()==digest,name
print('DEXA_MATERIAL_POSTRESTART_ALL_CANDIDATE_HASHES_VERIFIED')
PY
cd "$BASE"
node --input-type=module -e "import {catalogCounts} from './dexa_catalog_registry.mjs';import {streamAdapter} from './dexa_material_stream_v1.mjs';let c=catalogCounts();if(c.catalog!==297||c.cfMapped!==193||!streamAdapter('tool.cf.wechat_file_upload','tool.cf.wechat_file_upload_chunk'))process.exit(2);console.log('DEXA_MATERIAL_STREAM_LIVE_COUNT_AND_ADAPTER_OK')"
node --test test_dexa_material_stream_v1.mjs test_dexa_material_stream_integration_v1.mjs >/dev/null
committed=1
rm -f "$DRAIN"
marked=0
health | node -e 'let s="";process.stdin.on("data",x=>s+=x).on("end",()=>{let d=JSON.parse(s);if(!d.ok||d.activeMissions!==0||d.deploymentDrain?.active||d.storedMissions<Number(process.argv[1]))process.exit(2);console.log("DEXA_MATERIAL_STREAM_LIVE_HEALTHY",JSON.stringify({storedMissions:d.storedMissions,activeMissions:d.activeMissions,drain:d.deploymentDrain.active}))})' "$before"
echo DEXA_MATERIAL_STREAM_V1_LIVE_VERIFIED_NO_PROVIDER_SEND
