#!/usr/bin/env bash
# Secret-free, source-pinned and rollback-safe PCG web-only r143 activation.
set -Eeuo pipefail
umask 027
diag=/tmp/pcg-r143-web-release.log
install -o root -g 1000 -m 0640 /dev/null "$diag"
exec > >(tee -a "$diag") 2>&1
exec 9>/run/lock/cf-pcg-r143-web.lock
flock -n 9 || { echo R143_LOCK_BUSY; exit 20; }
[[ "$(id -u)" == 0 ]] || { echo R143_ROOT_REQUIRED; exit 21; }
old=/var/lib/capability-fabric/pcg/releases/pcg-web-stage6-unified-chunked-r142
new=/var/lib/capability-fabric/pcg/releases/pcg-web-stage6-unified-r143
active=/opt/capability-fabric/channels/pcg/current
archive=/tmp/pcg-unified-r143-candidate.tgz
web=capability-fabric-pcg-web
[[ "$(readlink -f "$active")" == "$old" ]] || { echo R143_BASELINE_CHANGED; exit 22; }
[[ -f "$old/override-managed.yaml" && -f "$archive" && ! -e "$new" ]] || { echo R143_SOURCE_OR_RELEASE_CONFLICT; exit 23; }
# Never interrupt any active ASR job, including the separate Soniox worker.
python3 - <<'PY'
import json,socket
s=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM)
s.settimeout(5)
s.connect('/var/lib/capability-fabric/pcg/run/perplexity-asr.sock')
s.sendall(b'{"op":"health"}\n')
buf=b''
while b'\n' not in buf and len(buf)<65536:
 part=s.recv(8192)
 if not part:break
 buf+=part
s.close()
j=json.loads(buf.split(b'\n',1)[0])
assert j.get('ok') is True and j.get('state')=='READY','R143_ASR_NOT_READY'
assert not j.get('active_job_ids'),'R143_ACTIVE_JOBS_PRESENT'
for key in ('pending_single_jobs','batch_files_reserved','global_socket_active'):
 assert j.get(key)==0,'R143_BUSY_'+key
print('R143_QUIESCENCE_CONFIRMED')
PY
stage="$(mktemp -d /run/pcg-r143-stage.XXXXXXXX)"
incoming=/var/lib/capability-fabric/pcg/releases/.incoming-r143-$$
cleanup(){ rm -rf "$stage"; }
trap cleanup EXIT
tar -tzf "$archive" | python3 -c 'import sys;a=sys.stdin.read().splitlines();assert a and all(not x.startswith("/") and ".." not in x.split("/") for x in a)'
tar -xzf "$archive" -C "$stage"
python3 - "$stage" "$old" <<'PY'
import hashlib,json,pathlib,subprocess,sys
stage=pathlib.Path(sys.argv[1]);old=pathlib.Path(sys.argv[2])
j=json.loads((stage/'manifest.json').read_text())
assert j['schema']=='pcg.unified.r143.source-release.v1'
assert j['source_commit']=='a17554b000159b7143ca56eb54ced72c52a67939'
assert j['release_id']=='pcg-web-stage6-unified-r143'
before={
 'pcg_web_semantic_ops.mjs':'701b895ab5080326e364ba27bf097e2c886409aa',
 'pcg_web_webk_bridge.mjs':'ba581682b8b4ef8b06fbc78f210c4f325442b385',
 'pcg_web_telegram_media_adapter.mjs':'38a376541de553c4981eec31444cbedf2a04df17',
 'pcg_unified_media_acquisition.mjs':'582c7a104f7e916768b66ea14b2ba3f13c76c55a'}
assert set(j['files'])==set(before)-{'pcg_web_semantic_ops.mjs'}
assert j['semantic_patch_sha256']=='10cb248b452405be710c2ddb6fc62bb4dff49e0cc27d49478469c930205e33db'
assert j['semantic_merged_sha256']=='510c7451341b81c5167cfd63e3a89e7a051b97ec73b945dc45b742b796914605'
assert hashlib.sha256((s/'semantic.patch').read_bytes()).hexdigest()==j['semantic_patch_sha256']
for name,digest in j['files'].items():
 p=stage/'files'/name
 assert p.is_file() and not p.is_symlink() and hashlib.sha256(p.read_bytes()).hexdigest()==digest,name
 oldp=old/name
 assert oldp.is_file() and not oldp.is_symlink(),name
 original=subprocess.check_output(['git','hash-object',str(oldp)],text=True).strip()
 assert original==before[name],f'R143_PREVIOUS_SOURCE_CAS_FAILED_{name}'
 print('R143_BEFORE_SHA256',name,hashlib.sha256(oldp.read_bytes()).hexdigest())
 print('R143_AFTER_SHA256',name,digest)
print('R143_PINNED_SOURCES_VALID')
PY
mkdir -m 0755 "$incoming"
cp -a "$old"/. "$incoming"/
for f in pcg_web_webk_bridge.mjs pcg_web_telegram_media_adapter.mjs pcg_unified_media_acquisition.mjs; do
 cp "$stage/files/$f" "$incoming/$f"
 node --check "$incoming/$f"
done
# Preserve the entire live r142 semantic/batch/parallelism/owner-upload flow.
# Apply only the audited r143 acquisition delta to that exact source.
patch --batch --fuzz=0 -p1 -d "$incoming" < "$stage/semantic.patch"
printf '%s  %s\n' 510c7451341b81c5167cfd63e3a89e7a051b97ec73b945dc45b742b796914605 "$incoming/pcg_web_semantic_ops.mjs" | sha256sum -c -
node --check "$incoming/pcg_web_semantic_ops.mjs"
grep -Fq 'startPerplexityAsrBatch' "$incoming/pcg_web_semantic_ops.mjs"
grep -Fq 'chatgpt: createReadyMaterialAdapter()' "$incoming/pcg_web_semantic_ops.mjs"
echo R143_PRIOR_ASR_BATCH_AND_READY_MATERIAL_PRESERVED
python3 - "$incoming" <<'PY'
import hashlib,json,pathlib,sys
p=pathlib.Path(sys.argv[1])
j=json.loads((p/'manifest.json').read_text())
assert j.get('sequence')==142,'R143_BASE_MANIFEST_MISMATCH'
j['sequence']=143
j['release_id']='pcg-web-stage6-unified-r143'
j['files']={f.name:hashlib.sha256(f.read_bytes()).hexdigest() for f in p.iterdir() if f.is_file() and f.name!='manifest.json'}
(p/'manifest.json').write_text(json.dumps(j,indent=2)+'\n')
PY
chown -R root:root "$incoming"
chmod -R a+rX,go-w "$incoming"
mv "$incoming" "$new"
sed "s|$old|$new|g" "$old/override-managed.yaml" > "$new/override-managed.yaml"
chmod 0644 "$new/override-managed.yaml"
project="$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project"}}' "$web")"
[[ "$project" == capability-fabric-pcg* ]] || { echo R143_COMPOSE_PROJECT_UNEXPECTED; exit 24; }
docker compose -p "$project" -f "$new/compose.yaml" -f "$new/override-managed.yaml" config --quiet
before_web="$(docker inspect -f '{{.Id}}' "$web")"
others=(capability-fabric-pcg-telegram capability-fabric-pcg-asr capability-fabric-pcg-audio-transform capability-fabric-pcg-core capability-fabric-pcg-perplexity-asr)
before_other="$(for c in "${others[@]}"; do docker inspect -f '{{.Id}}' "$c"; done)"
activated=0
rollback(){
 rc=$?
 if (( rc != 0 && activated == 1 )); then
  echo R143_ROLLBACK_START
  docker compose -p "$project" -f "$old/compose.yaml" -f "$old/override-managed.yaml" up -d --no-deps --no-build --pull never --force-recreate pcg_web || true
  echo R143_ROLLBACK_ATTEMPTED
 fi
}
trap 'rollback; cleanup' EXIT
activated=1
docker compose -p "$project" -f "$new/compose.yaml" -f "$new/override-managed.yaml" up -d --no-deps --no-build --pull never --force-recreate pcg_web
healthy=0
for i in $(seq 1 180); do
 state="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$web" 2>/dev/null || echo missing)"
 [[ "$state" == healthy ]] && { healthy=1;break; }
 sleep 1
done
[[ "$healthy" == 1 ]] || { echo R143_WEB_UNHEALTHY; exit 25; }
[[ "$(docker inspect -f '{{.Id}}' "$web")" != "$before_web" ]] || { echo R143_WEB_NOT_RECREATED; exit 26; }
[[ "$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project.working_dir"}}' "$web")" == "$new" ]] || { echo R143_WRONG_RELEASE_PATH; exit 27; }
after_other="$(for c in "${others[@]}"; do docker inspect -f '{{.Id}}' "$c"; done)"
[[ "$before_other" == "$after_other" ]] || { echo R143_UNRELATED_CONTAINER_CHANGED; exit 28; }
link="$active.next-r143-$$"
ln -s "$new" "$link"
mv -Tf "$link" "$active"
activated=0
trap cleanup EXIT
echo R143_LIVE_HEALTHY
echo R143_OTHER_FIVE_CONTAINERS_UNCHANGED
echo R143_ROLLBACK_R142_RETAINED
