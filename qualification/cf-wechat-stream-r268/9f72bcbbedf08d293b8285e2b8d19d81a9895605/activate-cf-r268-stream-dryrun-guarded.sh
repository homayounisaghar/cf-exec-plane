#!/usr/bin/env bash
# Guarded CF r268 WeChat: 128KiB local dry-run bridge ONLY. No provider send.
set -Eeuo pipefail
umask 027
[[ "$(id -u)" == 0 ]] || { echo CF_WECHAT_R268_ROOT_REQUIRED; exit 11; }
exec 9>/run/cf-wechat-stream-r268.lock
flock -n 9 || { echo CF_WECHAT_R268_LOCK_BUSY; exit 24; }

old=/var/lib/capability-fabric/releases/onshape-vps-fast-r100-direct-orbit1-paa-storage-r267-wa-caption-wechat-stable-ref-20261030
new=/var/lib/capability-fabric/releases/onshape-vps-fast-r100-direct-orbit1-paa-storage-r268-wechat-stream-dryrun-20261031
active=/opt/capability-fabric/current
archive=/tmp/cf-wechat-stream-r268-bundle.tgz
marker=/home/cfserver/.local/share/dexa/deployment-drain.flag
server=capability-fabric-onshape-server
gateway=capability-fabric-onshape-gateway
helper=/home/cfserver/wechat-media-tools-candidate-20261030/wechat_semantic_helper_chooser_fixed_20261031.py
helper_backup="$helper.r268-stream-before"
helper_unit=capability-fabric-pcg-wechat-semantic-manual.service
helper_old_sha=80b9dde09743d611ba0c76921d7e345602bbab306bfaeddd982e78ab6d2b03b0
helper_new_sha=f5481b03017bfd433876d2f05ad69e8c58558d393871f805c29f6c26c5eae379
media_sha=7616d1f4c400c8c4f1483b6ea0ad93ea2e8cb071bbb00aedc24b43d2b7e0fd97
manifest_sha=186fcc8101d249af8a96fb31f396130b09b01f35fada54886f6932231b2469d7
closure_sha=adb2f9a0004d763767330347d2bc5e2800b4e385777ef93b3d793e7b373d0898

[[ "$(readlink -f "$active")" == "$old" ]] || { echo CF_WECHAT_R268_BASELINE_CHANGED; exit 12; }
[[ -f "$archive" && -d "$old" && ! -e "$new" && ! -e "$marker" ]] || {
 echo CF_WECHAT_R268_INPUT_OR_DRAIN_INVALID; exit 13;
}
[[ ! -e "$helper_backup" ]] || { echo CF_WECHAT_R268_BACKUP_EXISTS; exit 14; }
[[ "$(sha256sum "$helper" | awk '{print $1}')" == "$helper_old_sha" ]] || {
 echo CF_WECHAT_R268_HELPER_BASELINE_CHANGED; exit 15;
}
userctl() {
 runuser -u cfserver -- env HOME=/home/cfserver XDG_RUNTIME_DIR=/run/user/1000 \
   DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus systemctl --user "$@"
}
[[ "$(userctl is-active "$helper_unit")" == active ]] || {
 echo CF_WECHAT_R268_HELPER_NOT_ACTIVE; exit 16;
}
wechat_pid="$(pgrep -u 1000 -x wechat | head -n 1)"
[[ -n "$wechat_pid" && "$(pgrep -u 1000 -x wechat | wc -l)" -eq 1 ]] || {
 echo CF_WECHAT_R268_WECHAT_PROCESS_AMBIGUOUS; exit 17;
}
curl -fsS --max-time 4 http://127.0.0.1:9337/status | python3 -c \
 'import json,sys; d=json.load(sys.stdin); assert d.get("authenticated") is True and d.get("conversation_count",0)>=1'
[[ "$(curl -fsS --max-time 4 http://127.0.0.1:8788/)" == "cf-onshape-single ok" ]] || exit 18
[[ "$(curl -fsS --max-time 4 http://127.0.0.1:8787/)" == "cf-onshape-single ok" ]] || exit 19
[[ "$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project.working_dir"}}' "$server")" == "$old" ]] || {
 echo CF_WECHAT_R268_CONTAINER_BASE_CHANGED; exit 20;
}
[[ "$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/run/pcg-material-files"}}{{.Source}}|{{.RW}}{{end}}{{end}}' "$server")" == \
   "/var/lib/capability-fabric/pcg/run/material-files|false" ]] || {
 echo CF_WECHAT_R268_MATERIAL_MOUNT_UNEXPECTED; exit 21;
}
docker exec "$server" test -d /run/pcg-material-files || {
 echo CF_WECHAT_R268_MATERIAL_MOUNT_NOT_PRESENT; exit 22;
}
[[ "$(docker exec "$server" id -u)" == 0 ]] || {
 echo CF_WECHAT_R268_MATERIAL_READER_NOT_ROOT; exit 23;
}
mem_kb=$(awk '$1=="MemAvailable:"{print $2}' /proc/meminfo)
[[ "$mem_kb" =~ ^[0-9]+$ && "$mem_kb" -ge 1536000 ]] || {
 echo CF_WECHAT_R268_MEMORY_LOW; exit 31;
}

stage=$(mktemp -d /run/cf-wechat-stream-r268.XXXXXX)
claimed=0
helper_updated=0
started=0
committed=0
project=capability-fabric
health() {
 curl -fsS --max-time 5 http://127.0.0.1:9471/healthz | python3 -c \
  'import json,sys; d=json.load(sys.stdin); assert d.get("ok") is True; assert isinstance(d.get("activeMissions"),int) and isinstance(d.get("storedMissions"),int); print(d["activeMissions"],d["storedMissions"],int((d.get("deploymentDrain") or {}).get("active") is True))'
}
rollback() {
 local rc=$?
 trap - EXIT
 if (( rc != 0 && started == 1 && committed == 0 )); then
  echo CF_WECHAT_R268_CORE_ROLLBACK
  docker compose -p "$project" -f "$old/compose.yaml" up -d --no-deps --no-build --pull never --force-recreate onshape_server || true
 fi
 if (( rc != 0 && helper_updated == 1 )); then
  install -o cfserver -g cfserver -m 0600 "$helper_backup" "$helper"
  userctl restart "$helper_unit" || true
  echo CF_WECHAT_R268_HELPER_ROLLBACK
 fi
 if (( claimed == 1 )); then rm -f "$marker"; fi
 rm -rf "$stage"
 exit "$rc"
}
trap rollback EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

tar -tzf "$archive" | python3 -c 'import sys; a=sys.stdin.read().splitlines(); required={"wechat-media-tools.mjs","wechat_media_cache_adapter_v1.mjs","manifest.json","release-closure.json","test_r267_stable_public.mjs","test_wechat_file_dryrun_bridge.mjs","wechat_semantic_helper_r268_stream_dryrun.py","test_wechat_helper_r268_stream_dryrun.py"}; assert len(a)==len(required) and set(a)==required'
tar -xzf "$archive" -C "$stage" --no-same-owner
python3 - "$old" "$stage" "$media_sha" "$manifest_sha" "$closure_sha" "$helper_new_sha" <<'PY'
from pathlib import Path
import hashlib,json,sys
old,stage=map(Path,sys.argv[1:3])
media_sha,manifest_sha,closure_sha,helper_sha=sys.argv[3:]
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
base=json.loads((old/'manifest.json').read_text())
m=json.loads((stage/'manifest.json').read_text())
c=json.loads((stage/'release-closure.json').read_text())
assert base['sequence']==267
assert base['release_id']=='onshape-vps-fast-r100-direct-orbit1-paa-storage-r267-wa-caption-wechat-stable-ref-20261030'
assert m['sequence']==268 and m['release_id']=='onshape-vps-fast-r100-direct-orbit1-paa-storage-r268-wechat-stream-dryrun-20261031'
assert len(base['files'])==len(m['files'])==32
assert set(base['files'])==set(m['files'])==set(c['files'])
assert c['build_id']==m['release_id']
assert sha(stage/'manifest.json')==manifest_sha
assert sha(stage/'release-closure.json')==m['files']['release-closure.json']==closure_sha
assert sha(stage/'wechat-media-tools.mjs')==m['files']['wechat-media-tools.mjs']==media_sha
assert sha(stage/'wechat_semantic_helper_r268_stream_dryrun.py')==helper_sha
assert sha(stage/'wechat_media_cache_adapter_v1.mjs')==m['files']['wechat_media_cache_adapter_v1.mjs']
assert base['files']['whatsapp-ingress.mjs']==m['files']['whatsapp-ingress.mjs']
assert {n for n in m['files'] if m['files'][n]!=base['files'][n]}=={'wechat-media-tools.mjs','release-closure.json'}
for name,h in base['files'].items():
    f=old/name
    assert f.is_file() and not f.is_symlink() and sha(f)==h,('LIVE_BASE_CHANGED',name)
source=(stage/'wechat-media-tools.mjs').read_text()
helper=(stage/'wechat_semantic_helper_r268_stream_dryrun.py').read_text()
assert 'WECHAT_FILE_LIVE_SEND_DISABLED' in source
assert 'WECHAT_FILE_LIVE_SEND_DISABLED' in helper
assert 'enableLiveFileSend=true' not in source and 'enableLiveFileSend:true' not in source
print('CF_WECHAT_R268_EXACT_SOURCE_AND_BASE_VERIFIED')
PY
node --check "$stage/wechat-media-tools.mjs"
python3 -m py_compile "$stage/wechat_semantic_helper_r268_stream_dryrun.py"

# Replace only the owner helper, retaining a byte-exact recovery copy.
cp -a "$helper" "$helper_backup"
install -o cfserver -g cfserver -m 0600 \
 "$stage/wechat_semantic_helper_r268_stream_dryrun.py" "$helper.r268-new"
mv -f "$helper.r268-new" "$helper"
helper_updated=1
userctl restart "$helper_unit"
helper_ready=0
for ((i=0;i<35;i++)); do
 if userctl is-active --quiet "$helper_unit" && \
   curl -fsS --max-time 3 http://127.0.0.1:9337/status 2>/dev/null | \
   python3 -c 'import json,sys; d=json.load(sys.stdin); assert d.get("authenticated") is True' 2>/dev/null; then
  helper_ready=1; break
 fi
 sleep 1
done
[[ "$helper_ready" == 1 ]] || { echo CF_WECHAT_R268_HELPER_UNHEALTHY; exit 41; }
[[ "$(pgrep -u 1000 -x wechat | head -n 1)" == "$wechat_pid" ]] || {
 echo CF_WECHAT_R268_WECHAT_APP_CHANGED; exit 42;
}
curl -fsS --max-time 20 -X POST -H 'content-type: application/json' -d '{}' \
  http://127.0.0.1:9337/file-dialog-probe | \
  python3 -c 'import json,sys; d=json.load(sys.stdin); assert d.get("state")=="ACHIEVED"; assert d.get("dialog",{}).get("is_distinct_file_dialog_candidate") is True'
echo CF_WECHAT_R268_HELPER_CHOOSER_DRYRUN_OK

# Build immutable r268 release from the exact healthy r267 snapshot.
incoming="/var/lib/capability-fabric/releases/.incoming-cf-wechat-stream-r268-$$"
install -d -m 0755 "$incoming"
cp -a "$old"/. "$incoming"/
install -o root -g root -m 0644 "$stage/wechat-media-tools.mjs" "$incoming/wechat-media-tools.mjs"
install -o root -g root -m 0644 "$stage/manifest.json" "$incoming/manifest.json"
install -o root -g root -m 0644 "$stage/release-closure.json" "$incoming/release-closure.json"
chmod -R a+rX,go-w "$incoming"
mv "$incoming" "$new"
python3 - "$new" "$stage" <<'PY'
from pathlib import Path
import hashlib,json,sys
new,stage=map(Path,sys.argv[1:])
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
m=json.loads((stage/'manifest.json').read_text())
assert new.is_dir() and not new.is_symlink()
assert set(p.name for p in new.iterdir())==set(m['files'])|{'manifest.json'}
for name,h in m['files'].items():
    p=new/name
    assert p.is_file() and not p.is_symlink() and sha(p)==h,(name,'HASH_MISMATCH')
print('CF_WECHAT_R268_ALL_RELEASE_BYTES_MATCH')
PY
docker compose -p "$project" -f "$new/compose.yaml" config --quiet

read -r running stored draining <<< "$(health)"
[[ "$running" == 0 && "$draining" == 0 ]] || { echo CF_WECHAT_R268_DEXA_BUSY; exit 43; }
gateway_before="$(docker inspect -f '{{.Id}}' "$gateway")"
if ! ( set -C; printf 'CF WeChat stream dryrun %s\n' "$(date -u +%FT%TZ)" > "$marker" ) 2>/dev/null; then
 echo CF_WECHAT_R268_DRAIN_RESERVATION_FAILED; exit 44;
fi
claimed=1
chown cfserver:cfserver "$marker"
stable=0
for ((i=0;i<75;i++)); do
 if value="$(health 2>/dev/null)"; then
  read -r now_running now_stored now_drain <<< "$value"
  if [[ "$now_running" == 0 && "$now_drain" == 1 ]]; then ((stable+=1)) || true; else stable=0; fi
  if ((stable>=3)); then break; fi
 else stable=0; fi
 sleep 1
done
((stable>=3)) || { echo CF_WECHAT_R268_DRAIN_TIMEOUT; exit 45; }
[[ "$(readlink -f "$active")" == "$old" ]] || { echo CF_WECHAT_R268_BASE_MOVED; exit 46; }
mem_kb=$(awk '$1=="MemAvailable:"{print $2}' /proc/meminfo)
((mem_kb>=1536000)) || { echo CF_WECHAT_R268_MEMORY_DROPPED; exit 47; }
started=1
docker compose -p "$project" -f "$new/compose.yaml" up -d --no-deps --no-build --pull never --force-recreate onshape_server
ready=0
for ((i=0;i<180;i++)); do
 state="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$server" 2>/dev/null || true)"
 if [[ "$state" == healthy && "$(curl -fsS --max-time 4 http://127.0.0.1:8788/ 2>/dev/null || true)" == 'cf-onshape-single ok' ]]; then
  ready=1; break
 fi
 sleep 1
done
[[ "$ready" == 1 ]] || { echo CF_WECHAT_R268_BACKEND_UNHEALTHY; exit 48; }
[[ "$(docker inspect -f '{{.Id}}' "$gateway")" == "$gateway_before" ]] || {
 echo CF_WECHAT_R268_GATEWAY_CHANGED; exit 49;
}
[[ "$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project.working_dir"}}' "$server")" == "$new" ]] || {
 echo CF_WECHAT_R268_BACKEND_RELEASE_MISMATCH; exit 50;
}
for name in wechat-media-tools.mjs wechat_media_cache_adapter_v1.mjs whatsapp-ingress.mjs; do
 expected="$(sha256sum "$new/$name" | awk '{print $1}')"
 actual="$(docker exec "$server" sha256sum "/tmp/app/$name" | awk '{print $1}')"
 [[ "$actual" == "$expected" ]] || { echo "CF_WECHAT_R268_RUNTIME_SHA_MISMATCH:$name"; exit 51; }
done
[[ "$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/run/pcg-material-files"}}{{.Source}}|{{.RW}}{{end}}{{end}}' "$server")" == \
  "/var/lib/capability-fabric/pcg/run/material-files|false" ]] || { echo CF_WECHAT_R268_MOUNT_CHANGED; exit 52; }
[[ "$(pgrep -u 1000 -x wechat | head -n 1)" == "$wechat_pid" ]] || {
 echo CF_WECHAT_R268_WECHAT_PID_CHANGED; exit 53;
}
curl -fsS --max-time 4 http://127.0.0.1:9337/status | python3 -c \
 'import json,sys; d=json.load(sys.stdin); assert d.get("authenticated") is True'
read -r after_running after_stored after_drain <<< "$(health)"
[[ "$after_running" == 0 && "$after_stored" -ge "$stored" && "$after_drain" == 1 ]] || {
 echo CF_WECHAT_R268_DEXA_MISSIONS_CHANGED; exit 54;
}
tmp="$active.next-wechat-stream-r268-$$"
ln -s "$new" "$tmp"
mv -Tf "$tmp" "$active"
committed=1
echo CF_WECHAT_R268_STREAM_DRYRUN_LIVE_HEALTHY
echo CF_WECHAT_R268_LIVE_FILE_SEND_DISABLED
echo CF_WECHAT_R268_GATEWAY_DEXA_AND_WECHAT_APP_PRESERVED
