#!/usr/bin/env bash
# PCG r142 - one provider range-read path, source-pinned, web-only activation.
set -Eeuo pipefail
umask 027
diag=/tmp/pcg-r142-chunk-only-deploy.log
install -o root -g 1000 -m 0640 /dev/null "$diag"
exec > >(tee -a "$diag") 2>&1
echo "PCG_R142_START $(date -u +%FT%TZ)"
exec 9>/run/lock/cf-pcg-r142-chunk-only.lock
flock -n 9 || { echo PCG_R142_LOCK_BUSY; exit 24; }
[[ "$(id -u)" == 0 ]] || { echo PCG_R142_ROOT_REQUIRED; exit 11; }
old=/var/lib/capability-fabric/pcg/releases/pcg-web-stage6-unified-media-r141
new=/var/lib/capability-fabric/pcg/releases/pcg-web-stage6-unified-chunked-r142
active=/opt/capability-fabric/channels/pcg/current
archive=/tmp/pcg-chunk-only-r142-release.tgz
web=capability-fabric-pcg-web
[[ "$(readlink -f "$active")" == "$old" ]] || { echo PCG_R142_BASELINE_CHANGED; exit 12; }
[[ -f "$archive" && -f "$old/override-managed.yaml" ]] || { echo PCG_R142_MISSING_RELEASE; exit 13; }
[[ ! -e "$new" ]] || { echo PCG_R142_RELEASE_COLLISION; exit 14; }
for f in pcg_unified_media_acquisition.mjs pcg_web_telegram_media_adapter.mjs pcg_web_webk_bridge.mjs; do
 [[ -f "$old/$f" ]] || { echo PCG_R142_BASELINE_MISSING_$f; exit 15; }
done
# Do not interrupt any ongoing ASR work; only PCG web is recreated.
python3 - <<'PY'
import json,socket
s=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM)
s.settimeout(5);s.connect('/var/lib/capability-fabric/pcg/run/perplexity-asr.sock')
s.sendall(b'{"op":"health"}\n')
buf=b''
while b'\n' not in buf and len(buf)<65536:
 part=s.recv(8192)
 if not part:break
 buf+=part
s.close()
j=json.loads(buf.split(b'\n',1)[0])
assert j.get('ok') is True and j.get('state')=='READY', 'ASR_NOT_READY'
assert j.get('active_job_ids')==[], 'ASR_ACTIVE_JOBS_PRESENT'
for key in ('pending_single_jobs','batch_files_reserved','global_socket_active'):
 assert j.get(key)==0, 'ASR_BUSY_'+key
print('PCG_R142_QUIESCENT')
PY
stage="$(mktemp -d /run/pcg-r142-staging.XXXXXXXX)"
trap 'rm -rf "$stage"' EXIT
tar -tzf "$archive" | python3 -c 'import sys;a=sys.stdin.read().splitlines();assert a and all(not s.startswith("/") and ".." not in s.split("/") for s in a)'
tar -xzf "$archive" -C "$stage"
python3 - "$stage" "$old" <<'PY'
import hashlib,json,pathlib,sys
s=pathlib.Path(sys.argv[1]);old=pathlib.Path(sys.argv[2])
j=json.loads((s/'manifest.json').read_text())
assert j['schema']=='pcg.chunk-only.source-release.v1'
assert j['source_commit']=='915ca9ea4d46976e6430fdbea3a882d2879d4e56'
assert j['release_id']=='pcg-web-stage6-unified-chunked-r142'
assert set(j['files'])=={'pcg_unified_media_acquisition.mjs','pcg_web_telegram_media_adapter.mjs','pcg_web_webk_bridge.mjs'}
for name,digest in j['files'].items():
 f=s/'files'/name
 assert f.is_file() and not f.is_symlink() and hashlib.sha256(f.read_bytes()).hexdigest()==digest,name
base=json.loads((old/'manifest.json').read_text())
assert base['sequence']==141 and base['release_id']=='pcg-web-stage6-unified-media-r141'
print('PCG_R142_PINNED_SOURCES_AND_BASELINE')
PY
incoming=/var/lib/capability-fabric/pcg/releases/.incoming-chunked-r142-$$
install -d -m 0755 "$incoming"
cp -a "$old"/. "$incoming"/
for f in pcg_unified_media_acquisition.mjs pcg_web_telegram_media_adapter.mjs pcg_web_webk_bridge.mjs; do
 cp "$stage/files/$f" "$incoming/$f"
done
python3 - "$incoming" <<'PY'
import json,hashlib,pathlib,sys
p=pathlib.Path(sys.argv[1])
j=json.loads((p/'manifest.json').read_text())
j['sequence']=142
j['release_id']='pcg-web-stage6-unified-chunked-r142'
j['files']={f.name:hashlib.sha256(f.read_bytes()).hexdigest() for f in p.iterdir() if f.is_file() and f.name!='manifest.json'}
(p/'manifest.json').write_text(json.dumps(j,indent=2)+'\n')
PY
chown -R root:root "$incoming"
chmod -R a+rX,go-w "$incoming"
mv "$incoming" "$new"
sed "s|$old|$new|g" "$old/override-managed.yaml" > "$new/override-managed.yaml"
chmod 0644 "$new/override-managed.yaml"
project="$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project"}}' "$web")"
[[ "$project" == capability-fabric-pcg* ]] || { echo PCG_R142_PROJECT_UNEXPECTED; exit 16; }
docker compose -p "$project" -f "$new/compose.yaml" -f "$new/override-managed.yaml" config --quiet
before_web="$(docker inspect -f '{{.Id}}' "$web")"
others=(capability-fabric-pcg-telegram capability-fabric-pcg-asr capability-fabric-pcg-audio-transform capability-fabric-pcg-core capability-fabric-pcg-perplexity-asr)
before_other="$(for c in "${others[@]}"; do docker inspect -f '{{.Id}}' "$c"; done)"
activated=0
rollback(){
 rc=$?
 if (( rc != 0 && activated == 1 )); then
  echo PCG_R142_ROLLBACK_START
  docker compose -p "$project" -f "$old/compose.yaml" -f "$old/override-managed.yaml" up -d --no-deps --no-build --pull never --force-recreate pcg_web || true
  echo PCG_R142_ROLLBACK_ATTEMPTED
 fi
}
trap 'rollback; rm -rf "$stage"' EXIT
activated=1
docker compose -p "$project" -f "$new/compose.yaml" -f "$new/override-managed.yaml" up -d --no-deps --no-build --pull never --force-recreate pcg_web
healthy=0
for i in $(seq 1 240); do
 state="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$web" 2>/dev/null || echo missing)"
 [[ "$state" == healthy ]] && { healthy=1;break; }
 sleep 1
done
[[ "$healthy" == 1 ]] || { echo PCG_R142_WEB_UNHEALTHY; exit 17; }
[[ "$(docker inspect -f '{{.Id}}' "$web")" != "$before_web" ]] || { echo PCG_R142_WEB_NOT_RECREATED; exit 18; }
[[ "$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project.working_dir"}}' "$web")" == "$new" ]] || { echo PCG_R142_WRONG_RELEASE_LABEL; exit 19; }
after_other="$(for c in "${others[@]}"; do docker inspect -f '{{.Id}}' "$c"; done)"
[[ "$before_other" == "$after_other" ]] || { echo PCG_R142_UNRELATED_CONTAINERS_CHANGED; exit 20; }
link="$active.next-r142-$$"
ln -s "$new" "$link"
mv -Tf "$link" "$active"
activated=0
trap 'rm -rf "$stage"' EXIT
echo PCG_R142_CHUNKED_ONLY_LIVE_HEALTHY
echo PCG_R142_OTHER_FIVE_CONTAINERS_UNCHANGED
echo PCG_R142_PREVIOUS_R141_RETAINED
