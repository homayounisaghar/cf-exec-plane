#!/usr/bin/env bash
# PCG r140: scoped web + Soniox decoder release, with exact r138 rollback.
set -Eeuo pipefail
umask 027
exec 9>/run/lock/cf-pcg-r140-unified-media.lock
flock -n 9 || { echo "PCG_R140_LOCK_BUSY"; exit 24; }

[[ "$(id -u)" == 0 ]] || { echo "PCG_R140_ROOT_REQUIRED"; exit 11; }
releases=/var/lib/capability-fabric/pcg/releases
old="$releases/pcg-web-stage6-soniox-multifile20-telegram-fastdownload-r138"
new="$releases/pcg-web-stage6-unified-media-r140"
active=/opt/capability-fabric/channels/pcg/current
archive=/tmp/pcg-unified-r140-release.tgz
staging=/run/pcg-unified-r140-staged
web=capability-fabric-pcg-web
asr=capability-fabric-pcg-perplexity-asr

[[ "$(readlink -f "$active")" == "$old" ]] || { echo "PCG_R140_BASELINE_CHANGED"; exit 12; }
[[ -f "$archive" && -f "$old/override-managed.yaml" ]] || { echo "PCG_R140_MISSING_BASELINE"; exit 13; }

# No manual/live active ASR job may be terminated by this planned rollout.
python3 - <<'PY'
import json,socket
path="/var/lib/capability-fabric/pcg/run/perplexity-asr.sock"
s=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM)
s.settimeout(5)
s.connect(path)
s.sendall(b'{"op":"health"}\n')
data=b""
while b"\n" not in data and len(data)<65536:
    part=s.recv(8192)
    if not part: break
    data+=part
s.close()
j=json.loads(data.split(b"\n",1)[0])
assert j.get("ok") is True and j.get("state")=="READY", "ASR_NOT_READY"
assert j.get("active_job_ids")==[], "ASR_ACTIVE_JOBS_PRESENT"
for field in ("pending_single_jobs","batch_files_reserved","global_socket_active"):
    assert j.get(field)==0,field+"_NOT_QUIESCENT"
print("PCG_R140_ASR_QUIESCENT_PRECHECK_PASS")
PY

install -d -m 0700 "$staging"
tar -tzf "$archive" | python3 -c 'import sys; a=sys.stdin.read().splitlines(); assert a and all(not x.startswith("/") and ".." not in x.split("/") for x in a)'
tar -xzf "$archive" -C "$staging"
rm -f "$archive"
node --check "$staging/pcg_web_semantic_ops.mjs"
node --check "$staging/pcg_ffmpeg_decode.mjs"
python3 - "$staging" <<'PY'
import pathlib,json,hashlib,sys
p=pathlib.Path(sys.argv[1])
m=json.loads((p/"manifest.json").read_text())
assert m["sequence"]==140 and m["release_id"]=="pcg-web-stage6-unified-media-r140"
for name,digest in m["files"].items():
    assert hashlib.sha256((p/name).read_bytes()).hexdigest()==digest,name
assert "createUnifiedMediaAcquirer" in (p/"pcg_web_semantic_ops.mjs").read_text()
assert "chatgpt: createReadyMaterialAdapter()" in (p/"pcg_web_semantic_ops.mjs").read_text()
print("PCG_R140_VERIFIED_STAGING")
PY

if [[ -e "$new" ]]; then
  cmp -s "$staging/manifest.json" "$new/manifest.json" || { echo "PCG_R140_RELEASE_COLLISION"; exit 14; }
else
  incoming="$releases/.incoming-unified-r140-$$"
  install -d -m 0755 "$incoming"
  cp -a "$staging"/. "$incoming"/
  chown -R root:root "$incoming"
  chmod -R a+rX,go-w "$incoming"
  mv "$incoming" "$new"
fi
sed "s|$old|$new|g" "$old/override-managed.yaml" > "$new/override-managed.yaml"
chmod 0644 "$new/override-managed.yaml"
project="$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project"}}' "$web")"
[[ "$project" == capability-fabric-pcg* ]] || { echo "PCG_R140_PROJECT_UNEXPECTED"; exit 16; }
docker compose -p "$project" -f "$new/compose.yaml" -f "$new/override-managed.yaml" config --quiet

before_web="$(docker inspect -f '{{.Id}}' "$web")"
before_asr="$(docker inspect -f '{{.Id}}' "$asr")"
others=(capability-fabric-pcg-telegram capability-fabric-pcg-asr capability-fabric-pcg-audio-transform capability-fabric-pcg-core)
before_other="$(for c in "${others[@]}"; do docker inspect -f '{{.Id}}' "$c"; done)"
activated=0
rollback_on_failure(){
  rc=$?
  if (( rc != 0 && activated == 1 )); then
    echo "PCG_R140_ROLLBACK_STARTED $rc"
    docker compose -p "$project" -f "$old/compose.yaml" -f "$old/override-managed.yaml" up -d --no-deps --no-build --pull never --force-recreate pcg_perplexity_asr pcg_web || true
    echo "PCG_R140_ROLLBACK_ATTEMPTED"
  fi
}
trap rollback_on_failure EXIT
activated=1
docker compose -p "$project" -f "$new/compose.yaml" -f "$new/override-managed.yaml" up -d --no-deps --no-build --pull never --force-recreate pcg_perplexity_asr pcg_web
for c in "$web" "$asr"; do
  healthy=0
  for i in $(seq 1 240); do
    state="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$c" 2>/dev/null || echo missing)"
    [[ "$state" == healthy ]] && { healthy=1; break; }
    sleep 1
  done
  [[ "$healthy" == 1 ]] || { echo "PCG_R140_UNHEALTHY_$c"; exit 17; }
  [[ "$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project.working_dir"}}' "$c")" == "$new" ]] || { echo "PCG_R140_RELEASE_LABEL_MISMATCH_$c"; exit 18; }
done
[[ "$(docker inspect -f '{{.Id}}' "$web")" != "$before_web" ]] || { echo "PCG_R140_WEB_NOT_RESTARTED"; exit 19; }
[[ "$(docker inspect -f '{{.Id}}' "$asr")" != "$before_asr" ]] || { echo "PCG_R140_ASR_NOT_RESTARTED"; exit 20; }
after_other="$(for c in "${others[@]}"; do docker inspect -f '{{.Id}}' "$c"; done)"
[[ "$before_other" == "$after_other" ]] || { echo "PCG_R140_UNRELATED_SERVICE_CHANGED"; exit 21; }
next="$active.next-r140-$$"
ln -s "$new" "$next"
mv -Tf "$next" "$active"
activated=0
trap - EXIT
echo "PCG_R140_WEB_AND_ASR_ACTIVE_HEALTHY"
echo "PCG_R140_OTHER_FOUR_CONTAINERS_UNCHANGED"
echo "PCG_R140_PREVIOUS_R138_RETAINED"
