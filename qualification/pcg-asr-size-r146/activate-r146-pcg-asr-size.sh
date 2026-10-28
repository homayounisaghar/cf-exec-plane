#!/usr/bin/env bash
# Scoped PCG r146 large-ASR input / 1 GiB PCM release from exact live r145 baseline.
set -Eeuo pipefail
umask 027
test "$(id -u)" = 0 || { echo ROOT_REQUIRED; exit 11; }
exec 9>/run/lock/cf-pcg-v2-rollout.lock
flock -n 9 || { echo RELEASE_LOCK_BUSY; exit 12; }
old=/var/lib/capability-fabric/pcg/releases/pcg-web-stage6-unified-chunked-r145-webk-freshref-directfile1
new=/var/lib/capability-fabric/pcg/releases/pcg-web-stage6-unified-chunked-r146-asr-large-source-pcm1g
link=/opt/capability-fabric/channels/pcg/current
cflink=/opt/capability-fabric/current
expectedcf=/var/lib/capability-fabric/releases/onshape-vps-fast-r100-direct-orbit1-paa-storage-r263-single-asr-tool
web=capability-fabric-pcg-web
asr=capability-fabric-pcg-perplexity-asr
stage=
project=
recreated=0
success=0
health() { docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$1" 2>/dev/null || echo missing; }
wait_health() {
  name=$1
  max=$2
  i=0
  while [ "$i" -lt "$max" ]; do
    [ "$(health "$name")" = healthy ] && return 0
    sleep 1
    i=$((i+1))
  done
  echo "HEALTH_TIMEOUT $name $(health "$name")"
  return 1
}
other_ids() {
  for name in capability-fabric-pcg-telegram capability-fabric-pcg-asr capability-fabric-pcg-audio-transform capability-fabric-pcg-core capability-fabric-onshape-server capability-fabric-onshape-gateway; do
    docker inspect -f '{{.Id}}' "$name"
  done
}
assert_idle() {
  python3 - <<'PY'
import json, pathlib, socket
mroot=pathlib.Path('/var/lib/capability-fabric/paa-remote/dexa-mvp/missions')
busy=[]
for file in mroot.glob('*.json'):
    m=json.loads(file.read_text())
    if m.get('state') in {'ACCEPTED','PLANNING','EXECUTING','WAITING_EXTERNAL'}:
        busy.append(m.get('id'))
assert not busy, 'DEXA_ACTIVE_MISSIONS'
sock=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM)
sock.settimeout(8)
sock.connect('/var/lib/capability-fabric/pcg/run/perplexity-asr.sock')
sock.sendall(b'{"op":"health"}\n')
data=b''
while b'\n' not in data and len(data)<65536:
    nxt=sock.recv(8192)
    if not nxt: break
    data+=nxt
sock.close()
d=json.loads(data.split(b'\n',1)[0])
assert d.get('ok') is True and d.get('state')=='READY', 'SONIOX_NOT_READY'
assert d.get('active_job_ids')==[], 'SONIOX_ACTIVE_JOBS'
for key in ('pending_single_jobs','batch_files_reserved','global_socket_active'):
    assert d.get(key)==0, 'SONIOX_BUSY_'+key
print('DEXA_AND_SONIOX_IDLE')
PY
}
web_rpc() {
  python3 - <<'PY'
import json,socket
s=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM)
s.settimeout(8)
s.connect('/var/lib/capability-fabric/pcg/run/web.sock')
s.sendall(b'{"op":"health"}\n')
data=b''
while b'\n' not in data and len(data)<65536:
    b=s.recv(8192)
    if not b:break
    data+=b
s.close()
j=json.loads(data.split(b'\n',1)[0])
assert j.get('ok') is True and j.get('phase')=='READY','PCG_WEB_NOT_READY'
print('PCG_WEB_READY')
PY
}
rollback() {
  trap - EXIT
  set +e
  status=0
  echo PCG_R146_ROLLBACK_START
  if [ "$recreated" -eq 1 ]; then
    docker compose -p "$project" -f "$old/compose.yaml" -f "$old/override-managed.yaml" up -d --no-deps --no-build --pull never --force-recreate pcg_perplexity_asr pcg_web || status=1
    wait_health "$asr" 200 || status=1
    wait_health "$web" 200 || status=1
    web_rpc || status=1
  fi
  if [ "$(readlink "$link")" = "$new" ]; then
    ln -s "$old" "$link.rollback-$$" && mv -Tf "$link.rollback-$$" "$link" || status=1
  fi
  if [ -n "$stage" ] && [ -d "$stage" ]; then rm -rf -- "$stage"; fi
  if [ "$status" -eq 0 ]; then echo PCG_R146_ROLLBACK_COMPLETE; else echo PCG_R146_ROLLBACK_REQUIRES_INSPECTION; fi
}
on_exit() {
  rc=$?
  trap - EXIT
  if [ "$rc" -ne 0 ] || [ "$success" -ne 1 ]; then
    echo "PCG_R146_ABORT rc=$rc"
    if [ "$recreated" -eq 1 ]; then rollback; fi
    if [ -n "$stage" ] && [ -d "$stage" ]; then rm -rf -- "$stage"; fi
  fi
}
trap on_exit EXIT
trap 'exit 130' INT TERM
echo PCG_R146_PREFLIGHT
test "$(readlink "$link")" = "$old" || { echo PCG_BASELINE_CHANGED; exit 20; }
test "$(readlink "$cflink")" = "$expectedcf" || { echo CF_BASELINE_CHANGED; exit 21; }
test ! -e "$new" && test ! -L "$new" || { echo RELEASE_COLLISION; exit 22; }
test "$(sha256sum "$old/manifest.json" | cut -d ' ' -f1)" = 2adbae6b9c89ba73085329fb7e292f3114015c29d6b90d6c0c3f96e711b2d83e || { echo OLD_MANIFEST_MISMATCH; exit 23; }
test "$(health "$web")" = healthy && test "$(health "$asr")" = healthy || { echo BASELINE_UNHEALTHY; exit 24; }
project=$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project"}}' "$web")
case "$project" in capability-fabric-pcg*) ;; *) echo UNEXPECTED_COMPOSE_PROJECT; exit 25;; esac
test "$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project.working_dir"}}' "$web")" = "$old" || { echo BASELINE_COMPOSE_WORKDIR_MISMATCH; exit 26; }
test "$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project.working_dir"}}' "$asr")" = "$old" || { echo BASELINE_ASR_COMPOSE_WORKDIR_MISMATCH; exit 27; }
assert_idle
web_rpc
before_other=$(other_ids)
before_web=$(docker inspect -f '{{.Id}}' "$web")
before_asr=$(docker inspect -f '{{.Id}}' "$asr")
stage=$(mktemp -d /var/lib/capability-fabric/pcg/releases/.incoming-r146-XXXXXX)
cp -a "$old/." "$stage/"
python3 - "$stage" <<'PY'
import hashlib,json,pathlib,sys
p=pathlib.Path(sys.argv[1])
m=json.loads((p/'manifest.json').read_text())
assert m['release_id']=='pcg-web-stage6-unified-chunked-r145-webk-freshref-directfile1' and m['sequence']==145
assert len(m['files'])==47
assert set(m['files'])|{'manifest.json'}=={x.name for x in p.iterdir()}
for f,digest in m['files'].items():
    assert hashlib.sha256((p/f).read_bytes()).hexdigest()==digest, 'R145_BASELINE_FILE_MISMATCH:'+f
changes={
'pcg_web_semantic_ops.mjs':[
 ('sizeBytes > 64 * 1024 * 1024','sizeBytes > 2 * 1024 * 1024 * 1024',1),
 ('Direct transcription accepts sources up to 64 MiB.','Direct transcription accepts source files up to 2 GiB.',1),
 ('transfer_limits: { max_bytes: 64 * 1024 * 1024 }','transfer_limits: { max_bytes: 2 * 1024 * 1024 * 1024 }',1),
 ('transfer_limits:{max_bytes:64*1024*1024}','transfer_limits:{max_bytes:2*1024*1024*1024}',1),
 ('material.size_bytes>64*1024*1024','material.size_bytes>2*1024*1024*1024',1)],
'pcg_perplexity_asr.mjs':[
 ('const MAX_SOURCE_BYTES = 64 * 1024 * 1024;','const MAX_SOURCE_BYTES = 2 * 1024 * 1024 * 1024;',1)],
'pcg_ffmpeg_decode.mjs':[
 ('const MAX_PCM_BYTES=256*1024*1024;','const MAX_PCM_BYTES=1024*1024*1024;',1)],
'pcg_web_perplexity_asr_client.mjs':[
 ('sizeBytes > 64 * 1024 * 1024','sizeBytes > 2 * 1024 * 1024 * 1024',1),
 ('f.sizeBytes>64*1024*1024','f.sizeBytes>2*1024*1024*1024',1)]}
new_hashes={
'pcg_web_semantic_ops.mjs':'e299e765f89adf22723b001da58fb0f2740758ee0e7e7ad16afb7c1faaf6222c',
'pcg_perplexity_asr.mjs':'29426a9506951f28ffc828a88086ce4e7c6a2d350b97d5cbb5186aa422218021',
'pcg_ffmpeg_decode.mjs':'62e5cd8899f614f4c483736992220495b7bfc840580d361a1434ee8b4519dde5',
'pcg_web_perplexity_asr_client.mjs':'dfecc91b9650649a04da5e804f8599129dd55975f9512375fddb4c13bdf97338'}
for name,repls in changes.items():
    source=(p/name).read_text()
    for src,dst,expected in repls:
        assert source.count(src)==expected, 'R146_PATCH_BASE_MISMATCH:'+name+':'+src
        source=source.replace(src,dst)
    (p/name).write_text(source)
    assert hashlib.sha256((p/name).read_bytes()).hexdigest()==new_hashes[name], 'R146_PATCH_SHA_MISMATCH:'+name
old='pcg-web-stage6-unified-chunked-r145-webk-freshref-directfile1'
new='pcg-web-stage6-unified-chunked-r146-asr-large-source-pcm1g'
override=p/'override-managed.yaml'
s=override.read_text()
assert s.count(old)==1
override.write_text(s.replace(old,new))
assert hashlib.sha256(override.read_bytes()).hexdigest()=='3f4cb151c43323b05fb3e6f2a837cb6b6f3ae8cb182cdaa0993723f32146b956'
m['release_id']=new
m['sequence']=146
for f in m['files']:
    m['files'][f]=hashlib.sha256((p/f).read_bytes()).hexdigest()
(p/'manifest.json').write_text(json.dumps(m,sort_keys=True,indent=2)+'\n')
assert hashlib.sha256((p/'manifest.json').read_bytes()).hexdigest()=='b85691fbbff506926df920b258a79b295ccdbb2c44d5a92f37b5394e8bc578a4', 'R146_MANIFEST_SHA_MISMATCH'
assert len(m['files'])==47
assert set(m['files'])|{'manifest.json'}=={x.name for x in p.iterdir()}
print('R146_SOURCE_MANIFEST_PINNED_5_FILES_ONLY')
PY
for f in pcg_web_semantic_ops.mjs pcg_perplexity_asr.mjs pcg_ffmpeg_decode.mjs pcg_web_perplexity_asr_client.mjs; do
  node --check "$stage/$f"
done
for f in pcg_soniox_fixed_overlap.mjs pcg_soniox_multifile.mjs pcg_soniox_word_align_dp.mjs; do
  node --check "$stage/$f"
done
docker compose -p "$project" -f "$stage/compose.yaml" -f "$stage/override-managed.yaml" config --quiet
chown -R root:root "$stage"
find "$stage" -type d -exec chmod 0755 {} +
find "$stage" -type f -exec chmod a+r,go-w {} +
mv -T "$stage" "$new"
stage=
test "$(sha256sum "$new/manifest.json" | cut -d ' ' -f1)" = b85691fbbff506926df920b258a79b295ccdbb2c44d5a92f37b5394e8bc578a4
test "$(readlink "$link")" = "$old"
test "$(readlink "$cflink")" = "$expectedcf"
assert_idle
recreated=1
echo PCG_R146_SCOPED_CONTAINER_RESTART
docker compose -p "$project" -f "$new/compose.yaml" -f "$new/override-managed.yaml" up -d --no-deps --no-build --pull never --force-recreate pcg_perplexity_asr pcg_web
wait_health "$asr" 210
wait_health "$web" 210
web_rpc
test "$(docker inspect -f '{{.Id}}' "$web")" != "$before_web"
test "$(docker inspect -f '{{.Id}}' "$asr")" != "$before_asr"
test "$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project.working_dir"}}' "$web")" = "$new"
test "$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project.working_dir"}}' "$asr")" = "$new"
test "$(other_ids)" = "$before_other"
test "$(readlink "$cflink")" = "$expectedcf"
ln -s "$new" "$link.next-r146-$$"
mv -Tf "$link.next-r146-$$" "$link"
test "$(readlink "$link")" = "$new"
test "$(other_ids)" = "$before_other"
test "$(health "$web")" = healthy && test "$(health "$asr")" = healthy
success=1
echo PCG_R146_LIVE_VERIFIED_SOURCE_2G_PCM_1G
echo PCG_R145_RETAINED_FOR_ROLLBACK
echo CF_R263_DEXA_AND_OTHER_PCG_UNCHANGED
