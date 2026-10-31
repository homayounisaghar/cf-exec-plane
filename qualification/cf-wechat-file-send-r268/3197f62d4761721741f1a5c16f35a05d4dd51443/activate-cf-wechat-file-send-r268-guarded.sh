#!/usr/bin/env bash
# Scoped CF r268: private WeChat material handoff + chooser dry-run only.
# Real provider dispatch remains disabled by the production tool default.
set -Eeuo pipefail
umask 027
[[ "$(id -u)" == 0 ]] || { echo CF_R268_ROOT_REQUIRED; exit 11; }
exec 9>/run/cf-wechat-file-send-r268.lock
flock -n 9 || { echo CF_R268_LOCK_BUSY; exit 24; }

old=/var/lib/capability-fabric/releases/onshape-vps-fast-r100-direct-orbit1-paa-storage-r267-wa-caption-wechat-stable-ref-20261030
new=/var/lib/capability-fabric/releases/onshape-vps-fast-r100-direct-orbit1-paa-storage-r268-wechat-file-handoff-dryrun-20261031
active=/opt/capability-fabric/current
archive=/tmp/cf-wechat-file-send-r268-bundle.tgz
marker=/home/cfserver/.local/share/dexa/deployment-drain.flag
server=capability-fabric-onshape-server
gateway=capability-fabric-onshape-gateway
material_root=/var/lib/capability-fabric/pcg/run/material-files
helper_dir=/home/cfserver/wechat-media-tools-candidate-20261030
helper=$helper_dir/wechat_semantic_helper_chooser_fixed_20261031.py
dispatcher=$helper_dir/wechat_file_send_dispatch.py
helper_backup=$helper.r268-pre
dispatch_backup=$dispatcher.r268-pre
helper_unit=capability-fabric-pcg-wechat-semantic-manual.service
helper_old_sha=80b9dde09743d611ba0c76921d7e345602bbab306bfaeddd982e78ab6d2b03b0
helper_new_sha=11800f8f4abe4f96e99670e3cf6b37e5d0948bac46f5fec46110164778b29e68
dispatch_new_sha=29b0f679da7503608a06c602a9f20554b5e7c680938f715eac7c9b95d3ac0765
media_sha=194d3c1664620bdd211b803c649b814d6d5182337698a87bc7610285bebf2440
adapter_sha=281aa17eb6916e52276e4b92bb65bbc1e7858be2ca86c6133a491e035c4ac390
manifest_sha=e27ba8c8483639dd80810ffe96534f529a178a3549b2305ab6db62ebcf4ff6dc
closure_sha=4ba42914d33faf7a9ab8bdd9373f5197be1a6c66746b4d45e8de16a6d740ef9a

[[ "$(readlink -f "$active")" == "$old" ]] || { echo CF_R268_BASELINE_MOVED; exit 12; }
[[ -f "$archive" && -d "$old" && ! -e "$marker" && ! -e "$new" ]] || {
  echo CF_R268_INPUT_DRAIN_OR_RELEASE_INVALID; exit 13;
}
[[ "$(sha256sum "$helper" | awk '{print $1}')" == "$helper_old_sha" ]] || {
  echo CF_R268_HELPER_BASELINE_MOVED; exit 14;
}
[[ ! -e "$helper_backup" && ! -e "$dispatch_backup" ]] || {
  echo CF_R268_ROLLBACK_BACKUP_ALREADY_EXISTS; exit 15;
}
[[ "$(runuser -u cfserver -- env HOME=/home/cfserver XDG_RUNTIME_DIR=/run/user/1000 DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus systemctl --user is-active "$helper_unit")" == active ]] || {
  echo CF_R268_HELPER_NOT_ACTIVE; exit 16;
}
wechat_pid="$(pgrep -u 1000 -x wechat | head -n 1)"
[[ -n "$wechat_pid" && "$(pgrep -u 1000 -x wechat | wc -l)" -eq 1 ]] || {
  echo CF_R268_WECHAT_PID_AMBIGUOUS; exit 17;
}
[[ "$(curl -fsS --max-time 5 http://127.0.0.1:9337/status | python3 -c 'import json,sys; d=json.load(sys.stdin); print(str(d.get("authenticated") is True).lower())')" == true ]] || {
  echo CF_R268_WECHAT_AUTH_REQUIRED; exit 18;
}
[[ "$(curl -fsS --max-time 5 http://127.0.0.1:8788/)" == "cf-onshape-single ok" ]] || {
  echo CF_R268_BACKEND_BASELINE_UNHEALTHY; exit 19;
}
[[ "$(curl -fsS --max-time 5 http://127.0.0.1:8787/)" == "cf-onshape-single ok" ]] || {
  echo CF_R268_GATEWAY_BASELINE_UNHEALTHY; exit 20;
}
mem_kb=$(awk '$1=="MemAvailable:"{print $2}' /proc/meminfo)
[[ "$mem_kb" =~ ^[0-9]+$ && "$mem_kb" -ge 1536000 ]] || {
  echo CF_R268_MEMORY_HEADROOM_LOW; exit 31;
}
[[ -d "$material_root" && ! -L "$material_root" ]] || {
  echo CF_R268_MATERIAL_ROOT_MISSING; exit 32;
}
[[ "$(docker exec "$server" id -u)" == 0 ]] || {
  echo CF_R268_CONTAINER_NOT_ROOT; exit 33;
}
[[ "$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project"}}' "$server")" == capability-fabric ]] || {
  echo CF_R268_DOCKER_PROJECT_CHANGED; exit 34;
}
[[ "$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project.working_dir"}}' "$server")" == "$old" ]] || {
  echo CF_R268_CONTAINER_BASELINE_MISMATCH; exit 35;
}

stage=$(mktemp -d /run/cf-wechat-file-send-r268.XXXXXX)
claimed=0
helper_updated=0
dispatch_existed=0
started=0
committed=0
material_probe=""
handoff_probe=""
project=capability-fabric

userctl() {
  runuser -u cfserver -- env HOME=/home/cfserver XDG_RUNTIME_DIR=/run/user/1000 \
    DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus systemctl --user "$@"
}
health() {
  curl -fsS --max-time 5 http://127.0.0.1:9471/healthz | python3 -c 'import json,sys; d=json.load(sys.stdin); assert d.get("ok") is True; assert isinstance(d.get("activeMissions"),int) and isinstance(d.get("storedMissions"),int); print(d["activeMissions"],d["storedMissions"],int((d.get("deploymentDrain") or {}).get("active") is True))'
}
restore_helper() {
  if (( helper_updated == 1 )); then
    install -o cfserver -g cfserver -m 0600 "$helper_backup" "$helper"
    if (( dispatch_existed == 1 )); then
      install -o cfserver -g cfserver -m 0600 "$dispatch_backup" "$dispatcher"
    else
      rm -f "$dispatcher"
    fi
    userctl restart "$helper_unit" || true
  fi
}
rollback() {
  local code=$?
  trap - EXIT
  if (( code != 0 && started == 1 && committed == 0 )); then
    echo "CF_R268_CORE_ROLLBACK_START code=$code"
    docker compose -p "$project" -f "$old/compose.yaml" up -d --no-deps --no-build --pull never --force-recreate onshape_server || true
    echo CF_R268_CORE_ROLLBACK_ATTEMPTED
  fi
  if (( code != 0 )); then restore_helper; fi
  if (( claimed == 1 )); then rm -f "$marker"; fi
  [[ -z "$material_probe" ]] || rm -f "$material_probe"
  [[ -z "$handoff_probe" ]] || rm -f "$handoff_probe"
  rm -rf "$stage"
  exit "$code"
}
trap rollback EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

tar -tzf "$archive" | python3 -c 'import sys; a=sys.stdin.read().splitlines(); required={"wechat-media-tools.mjs","wechat_media_cache_adapter_v1.mjs","manifest.json","release-closure.json","test_r267_stable_public.mjs","wechat_file_handoff.test.mjs","wechat_file_receipt_guard.mjs","wechat_file_receipt_guard.test.mjs","test_wechat_file_send_integration.mjs","test_wechat_file_send_dispatch.py","wechat_file_send_dispatch.py","wechat_semantic_helper_file_send_candidate.py"}; assert len(a)==len(required) and set(a)==required'
tar -xzf "$archive" -C "$stage" --no-same-owner
python3 - "$old" "$stage" "$media_sha" "$adapter_sha" "$manifest_sha" "$closure_sha" <<'PY'
from pathlib import Path
import hashlib,json,sys
old,stage=map(Path,sys.argv[1:3])
expected_media,expected_adapter,expected_manifest,expected_closure=sys.argv[3:]
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
base=json.loads((old/'manifest.json').read_text())
m=json.loads((stage/'manifest.json').read_text())
c=json.loads((stage/'release-closure.json').read_text())
assert base['sequence']==267
assert base['release_id']=='onshape-vps-fast-r100-direct-orbit1-paa-storage-r267-wa-caption-wechat-stable-ref-20261030'
assert m['sequence']==268
assert m['release_id']=='onshape-vps-fast-r100-direct-orbit1-paa-storage-r268-wechat-file-handoff-dryrun-20261031'
assert len(base['files'])==32 and len(m['files'])==32
assert set(base['files'])==set(m['files'])==set(c['files'])
assert c['build_id']==m['release_id']
assert sha(stage/'manifest.json')==expected_manifest
assert sha(stage/'release-closure.json')==expected_closure
assert sha(stage/'wechat-media-tools.mjs')==m['files']['wechat-media-tools.mjs']==expected_media
assert sha(stage/'wechat_media_cache_adapter_v1.mjs')==m['files']['wechat_media_cache_adapter_v1.mjs']==expected_adapter
assert base['files']['whatsapp-ingress.mjs']==m['files']['whatsapp-ingress.mjs']=='264c4d9614551f2586dfcc157db61d8c99d81c632e8d7b51123de37052c733d'
changed={name for name in m['files'] if base['files'][name]!=m['files'][name]}
assert changed=={'wechat-media-tools.mjs','release-closure.json'},changed
for name,h in base['files'].items():
    f=old/name
    assert f.is_file() and not f.is_symlink() and sha(f)==h,('LIVE_BASE_CHANGED',name)
assert 'enableLiveFileSend=true' not in (stage/'wechat-media-tools.mjs').read_text()
assert 'enableLiveFileSend:true' not in (stage/'wechat-media-tools.mjs').read_text()
print('CF_R268_EXACT_R267_BASE_AND_DRYRUN_ONLY_PATCH_VERIFIED')
PY
[[ "$(sha256sum "$stage/wechat_semantic_helper_file_send_candidate.py" | awk '{print $1}')" == "$helper_new_sha" ]] || {
  echo CF_R268_HELPER_SOURCE_SHA_MISMATCH; exit 36;
}
[[ "$(sha256sum "$stage/wechat_file_send_dispatch.py" | awk '{print $1}')" == "$dispatch_new_sha" ]] || {
  echo CF_R268_DISPATCH_SOURCE_SHA_MISMATCH; exit 37;
}
node --check "$stage/wechat-media-tools.mjs" >/dev/null
node --check "$stage/wechat_media_cache_adapter_v1.mjs" >/dev/null
python3 -m py_compile "$stage/wechat_semantic_helper_file_send_candidate.py" "$stage/wechat_file_send_dispatch.py"

# Verify the material directory is actually shared into the current CF container.
material_probe="$material_root/.cf-wechat-r268-material-probe-$$"
printf 'CF_WECHAT_R268_MATERIAL_MOUNT_PROBE\n' > "$material_probe"
chmod 0600 "$material_probe"
host_probe_sha="$(sha256sum "$material_probe" | awk '{print $1}')"
docker exec "$server" test -r "$material_probe"
container_probe_sha="$(docker exec "$server" sha256sum "$material_probe" | awk '{print $1}')"
[[ "$container_probe_sha" == "$host_probe_sha" ]] || {
  echo CF_R268_MATERIAL_MOUNT_NOT_SHARED; exit 38;
}

# Preserve the exact live helper before replacing only its owner-scoped process.
cp -a "$helper" "$helper_backup"
if [[ -e "$dispatcher" ]]; then
  cp -a "$dispatcher" "$dispatch_backup"
  dispatch_existed=1
fi
helper_updated=1
install -o cfserver -g cfserver -m 0600 "$stage/wechat_semantic_helper_file_send_candidate.py" "$helper.new"
install -o cfserver -g cfserver -m 0600 "$stage/wechat_file_send_dispatch.py" "$dispatcher.new"
mv -f "$helper.new" "$helper"
mv -f "$dispatcher.new" "$dispatcher"
userctl restart "$helper_unit"
helper_ready=0
for (( i=0; i<30; i++ )); do
  if userctl is-active --quiet "$helper_unit" && \
     curl -fsS --max-time 3 http://127.0.0.1:9337/status 2>/dev/null | \
       python3 -c 'import json,sys; d=json.load(sys.stdin); assert d.get("authenticated") is True; assert d.get("conversation_count",0)>=1' 2>/dev/null; then
    helper_ready=1
    break
  fi
  sleep 1
done
[[ "$helper_ready" == 1 ]] || { echo CF_R268_HELPER_RESTART_UNHEALTHY; exit 39; }
[[ "$(pgrep -u 1000 -x wechat | head -n 1)" == "$wechat_pid" ]] || {
  echo CF_R268_WECHAT_PID_CHANGED; exit 40;
}
curl -fsS --max-time 15 -X POST -H 'content-type: application/json' -d '{}' \
  http://127.0.0.1:9337/file-dialog-probe | \
  python3 -c 'import json,sys; d=json.load(sys.stdin); assert d.get("state")=="ACHIEVED"; assert d.get("dialog",{}).get("is_distinct_file_dialog_candidate") is True'
[[ "$(pgrep -u 1000 -x wechat | head -n 1)" == "$wechat_pid" ]] || {
  echo CF_R268_WECHAT_PID_CHANGED_AFTER_CHOOSER; exit 41;
}
echo CF_R268_OWNER_HELPER_DRYRUN_QUALIFIED_WECHAT_UNCHANGED

python3 - "$old" "$stage" <<'PY'
from pathlib import Path
import hashlib,json,sys
old,stage=[Path(x) for x in sys.argv[1:]]
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
m=json.loads((stage/'manifest.json').read_text())
c=json.loads((stage/'release-closure.json').read_text())
assert len(m['files'])==32 and set(m['files'])==set(c['files'])
for name,h in m['files'].items():
    if name not in {'wechat-media-tools.mjs','release-closure.json'}:
        assert sha(old/name)==h,('UNCHANGED_FILE_MISMATCH',name)
print('CF_R268_UNCHANGED_RELEASE_FILES_PINNED')
PY

[[ "$(curl -fsS --max-time 5 http://127.0.0.1:8788/)" == "cf-onshape-single ok" ]] || {
  echo CF_R268_BACKEND_BASELINE_UNHEALTHY; exit 42;
}
[[ "$(curl -fsS --max-time 5 http://127.0.0.1:8787/)" == "cf-onshape-single ok" ]] || {
  echo CF_R268_GATEWAY_BASELINE_UNHEALTHY; exit 43;
}
read -r running stored draining <<< "$(health)"
[[ "$draining" == 0 && "$running" == 0 ]] || { echo CF_R268_DEXA_BUSY; exit 44; }
project="$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project"}}' "$server")"
[[ "$project" == capability-fabric ]] || { echo CF_R268_DOCKER_PROJECT_CHANGED; exit 45; }
gateway_before="$(docker inspect -f '{{.Id}}' "$gateway")"
if ! ( set -C; printf 'CF WeChat file handoff r267 %s\n' "$(date -u +%FT%TZ)" > "$marker" ) 2>/dev/null; then
  echo CF_R268_DRAIN_RESERVATION_FAILED; exit 46;
fi
claimed=1
chown cfserver:cfserver "$marker"
stable=0
for (( i=0; i<75; i++ )); do
  if value="$(health 2>/dev/null)"; then
    read -r running_now preserved_now draining_now <<< "$value"
    if [[ "$running_now" == 0 && "$draining_now" == 1 ]]; then ((stable+=1)) || true; else stable=0; fi
    if (( stable >= 3 )); then break; fi
  else stable=0; fi
  sleep 1
done
(( stable >= 3 )) || { echo CF_R268_DEXA_DRAIN_TIMEOUT; exit 47; }
[[ "$(readlink -f "$active")" == "$old" ]] || { echo CF_R268_BASELINE_MOVED_DURING_DRAIN; exit 48; }
mem_kb=$(awk '$1=="MemAvailable:"{print $2}' /proc/meminfo)
(( mem_kb >= 1536000 )) || { echo CF_R268_MEMORY_DROPPED_BEFORE_RESTART; exit 49; }

incoming="/var/lib/capability-fabric/releases/.incoming-cf-wechat-r268-$$"
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
new,stage=[Path(x) for x in sys.argv[1:]]
sha=lambda x:hashlib.sha256(x.read_bytes()).hexdigest()
m=json.loads((stage/'manifest.json').read_text())
assert new.is_dir() and not new.is_symlink()
assert {p.name for p in new.iterdir()}==set(m['files'])|{'manifest.json'}
assert (new/'manifest.json').read_bytes()==(stage/'manifest.json').read_bytes()
for f,h in m['files'].items():
    p=new/f
    assert p.is_file() and not p.is_symlink() and sha(p)==h,('R268_RELEASE_CORRUPT',f)
print('CF_R268_32_RELEASE_BYTES_VERIFIED')
PY
install -d -o cfserver -g cfserver -m 0700 "$new/.wechat-handoff"
handoff_probe="$new/.wechat-handoff/.r268-mount-probe"
printf 'CF_WECHAT_R268_HANDOFF_MOUNT_PROBE\n' > "$handoff_probe"
chmod 0600 "$handoff_probe"
docker compose -p "$project" -f "$new/compose.yaml" config --quiet

started=1
docker compose -p "$project" -f "$new/compose.yaml" up -d --no-deps --no-build --pull never --force-recreate onshape_server
ready=0
for (( i=0; i<180; i++ )); do
  state="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$server" 2>/dev/null || true)"
  if [[ "$state" == healthy && "$(curl -fsS --max-time 4 http://127.0.0.1:8788/ 2>/dev/null || true)" == 'cf-onshape-single ok' ]]; then
    ready=1; break
  fi
  sleep 1
done
[[ "$ready" == 1 ]] || { echo CF_R268_BACKEND_UNHEALTHY; exit 50; }
[[ "$(docker inspect -f '{{.Id}}' "$gateway")" == "$gateway_before" ]] || {
  echo CF_R268_GATEWAY_CHANGED; exit 51;
}
[[ "$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project.working_dir"}}' "$server")" == "$new" ]] || {
  echo CF_R268_CONTAINER_RELEASE_MISMATCH; exit 52;
}
[[ "$(docker exec "$server" id -u)" == 0 ]] || { echo CF_R268_CONTAINER_USER_CHANGED; exit 53; }
for file in wechat-media-tools.mjs wechat_media_cache_adapter_v1.mjs whatsapp-ingress.mjs; do
  expected="$(sha256sum "$new/$file" | awk '{print $1}')"
  actual="$(docker exec "$server" sha256sum "/tmp/app/$file" | awk '{print $1}')"
  [[ "$actual" == "$expected" ]] || { echo "CF_R268_RUNTIME_SHA_MISMATCH:$file"; exit 54; }
done
container_handoff_sha="$(docker exec "$server" sha256sum /tmp/app/.wechat-handoff/.r268-mount-probe | awk '{print $1}')"
host_handoff_sha="$(sha256sum "$handoff_probe" | awk '{print $1}')"
[[ "$container_handoff_sha" == "$host_handoff_sha" ]] || {
  echo CF_R268_HANDOFF_MOUNT_NOT_SHARED; exit 55;
}
rm -f "$handoff_probe"
[[ "$(docker exec "$server" test -r "$material_probe"; echo $?)" == 0 ]] || {
  echo CF_R268_MATERIAL_MOUNT_LOST; exit 56;
}
read -r after_active after_stored after_drain <<< "$(health)"
[[ "$after_active" == 0 && "$after_stored" -ge "$stored" && "$after_drain" == 1 ]] || {
  echo CF_R268_DEXA_MISSIONS_CHANGED; exit 57;
}
tmp="$active.next-cf-wechat-r268-$$"
ln -s "$new" "$tmp"
mv -Tf "$tmp" "$active"
committed=1
echo CF_R268_BACKEND_HEALTHY_WECHAT_FILE_HANDOFF_DRYRUN_ONLY
echo CF_R268_LIVE_FILE_SEND_STILL_DISABLED
echo CF_R268_DEXA_MISSIONS_PRESERVED_GATEWAY_PRESERVED_NO_PROVIDER_SENDS
