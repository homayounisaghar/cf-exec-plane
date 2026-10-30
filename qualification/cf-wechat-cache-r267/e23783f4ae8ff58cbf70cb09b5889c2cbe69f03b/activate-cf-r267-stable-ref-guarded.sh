#!/usr/bin/env bash
# Owner-authorized scoped CF backend release. Never redeploy or restart Dexa.
set -Eeuo pipefail
umask 027
[[ "$(id -u)" == 0 ]] || { echo CF_R267_ROOT_REQUIRED; exit 11; }
exec 9>/run/cf-wechat-cache-r267.lock
flock -n 9 || { echo CF_R267_LOCK_BUSY; exit 24; }
old=/var/lib/capability-fabric/releases/onshape-vps-fast-r100-direct-orbit1-paa-storage-r266-wa-caption-wechat-cache-ref-20261030
new=/var/lib/capability-fabric/releases/onshape-vps-fast-r100-direct-orbit1-paa-storage-r267-wa-caption-wechat-stable-ref-20261030
active=/opt/capability-fabric/current
archive=/tmp/cf-wechat-cache-r267-bundle.tgz
marker=/home/cfserver/.local/share/dexa/deployment-drain.flag
server=capability-fabric-onshape-server
gateway=capability-fabric-onshape-gateway
[[ "$(readlink -f "$active")" == "$old" ]] || { echo CF_R267_BASELINE_MOVED; exit 12; }
[[ -f "$archive" && -d "$old" && ! -e "$marker" ]] || { echo CF_R267_INPUT_OR_DRAIN_INVALID; exit 13; }
mem_kb=$(awk '$1=="MemAvailable:"{print $2}' /proc/meminfo)
[[ "$mem_kb" =~ ^[0-9]+$ && "$mem_kb" -ge 1536000 ]] || { echo CF_R267_MEMORY_HEADROOM_LOW; exit 31; }
stage=$(mktemp -d /run/cf-wechat-r267.XXXXXX)
claimed=0
started=0
committed=0
rollback() {
  local code=$?
  trap - EXIT
  if (( code != 0 && started == 1 && committed == 0 )); then
    echo "CF_R267_ROLLBACK_START code=$code"
    docker compose -p capability-fabric -f "$old/compose.yaml" up -d --no-deps --no-build --pull never --force-recreate onshape_server || true
    echo CF_R267_ROLLBACK_ATTEMPTED
  fi
  if (( claimed == 1 )); then rm -f "$marker"; fi
  rm -rf "$stage"
  exit "$code"
}
trap rollback EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
tar -tzf "$archive" | python3 -c 'import sys; a=sys.stdin.read().splitlines(); required={"wechat-media-tools.mjs","wechat_media_cache_adapter_v1.mjs","manifest.json","release-closure.json","test_r267_stable_public.mjs"}; assert len(a)==len(required) and set(a)==required'
tar -xzf "$archive" -C "$stage" --no-same-owner
python3 - "$old" "$stage" <<'PY'
from pathlib import Path
import hashlib,json,sys
old,stage=[Path(x) for x in sys.argv[1:]]
sha=lambda f:hashlib.sha256(f.read_bytes()).hexdigest()
base=json.loads((old/'manifest.json').read_text())
m=json.loads((stage/'manifest.json').read_text())
c=json.loads((stage/'release-closure.json').read_text())
assert base['sequence']==266 and base['release_id']=='onshape-vps-fast-r100-direct-orbit1-paa-storage-r266-wa-caption-wechat-cache-ref-20261030'
assert m['sequence']==267 and m['release_id']=='onshape-vps-fast-r100-direct-orbit1-paa-storage-r267-wa-caption-wechat-stable-ref-20261030'
assert len(base['files'])==32 and len(m['files'])==32
assert set(base['files'])==set(m['files'])==set(c['files'])
assert c['build_id']==m['release_id']
assert sha(stage/'manifest.json')=='55994a63eee9e5b06f7e94437f04f4b758631022b20de91895b5cac47175a399'
assert sha(stage/'wechat-media-tools.mjs')==m['files']['wechat-media-tools.mjs']=='d406cdbdbe101e3b05bee701e947c4ff390abe8dce607d9ccc8c636325cf7bc2'
assert sha(stage/'wechat_media_cache_adapter_v1.mjs')==m['files']['wechat_media_cache_adapter_v1.mjs']=='281aa17eb6916e52276e4b92bb65bbc1e7858be2ca86c6133a491e035c4ac390'
assert sha(stage/'release-closure.json')==m['files']['release-closure.json']
assert base['files']['whatsapp-ingress.mjs']==m['files']['whatsapp-ingress.mjs']=='264c4d9614551f2586dfcc157db61d8c99d81c6326e8d7b51123de37052c733d'
assert base['files']['wechat-media-tools.mjs']=='3f0c5d0630003b0912d9cf6f225bd1009ad7769f4fb9890b664b72716e68ee84'
assert base['files']['wechat_media_cache_adapter_v1.mjs']=='613ae0ddb2574ac68279f3cff2a156e04f2d9ee0810e36b659f6ff3bf68e0e0d'
changed={name for name in m['files'] if base['files'][name]!=m['files'][name]}
assert changed=={'wechat-media-tools.mjs','wechat_media_cache_adapter_v1.mjs','release-closure.json'},changed
for name,h in base['files'].items():
    f=old/name
    assert f.is_file() and not f.is_symlink() and sha(f)==h,('LIVE_BASE_CHANGED',name)
print('CF_R267_EXACT_LIVE_BASE_AND_SOURCE_PATCH_VERIFIED')
PY
node --check "$stage/wechat-media-tools.mjs" >/dev/null
node --check "$stage/wechat_media_cache_adapter_v1.mjs" >/dev/null
[[ "$(curl -fsS --max-time 5 http://127.0.0.1:8788/)" == "cf-onshape-single ok" ]] || { echo CF_R267_BASELINE_UNHEALTHY; exit 15; }
[[ "$(curl -fsS --max-time 5 http://127.0.0.1:8787/)" == "cf-onshape-single ok" ]] || { echo CF_R267_GATEWAY_UNHEALTHY; exit 16; }
health() {
  curl -fsS --max-time 5 http://127.0.0.1:9471/healthz | python3 -c 'import json,sys;d=json.load(sys.stdin);assert d.get("ok") is True;assert isinstance(d.get("activeMissions"),int) and isinstance(d.get("storedMissions"),int);print(d["activeMissions"],d["storedMissions"],int((d.get("deploymentDrain") or {}).get("active") is True))'
}
read -r running stored draining <<< "$(health)"
[[ "$draining" == 0 && "$running" == 0 ]] || { echo CF_R267_DEXA_BUSY; exit 17; }
project="$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project"}}' "$server")"
[[ "$project" == capability-fabric ]] || { echo CF_R267_DOCKER_PROJECT_CHANGED; exit 18; }
gateway_before="$(docker inspect -f '{{.Id}}' "$gateway")"
if ! ( set -C; printf 'CF WeChat media r266 %s\n' "$(date -u +%FT%TZ)" > "$marker" ) 2>/dev/null; then
  echo CF_R267_DRAIN_RESERVATION_FAILED; exit 19
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
(( stable >= 3 )) || { echo CF_R267_DEXA_DRAIN_TIMEOUT; exit 20; }
[[ "$(readlink -f "$active")" == "$old" ]] || { echo CF_R267_BASELINE_MOVED_DURING_DRAIN; exit 12; }
mem_kb=$(awk '$1=="MemAvailable:"{print $2}' /proc/meminfo)
(( mem_kb >= 1536000 )) || { echo CF_R267_MEMORY_DROPPED_BEFORE_RESTART; exit 31; }
if [[ ! -e "$new" ]]; then
  incoming="/var/lib/capability-fabric/releases/.incoming-cf-r267-$$"
  install -d -m 0755 "$incoming"
  cp -a "$old"/. "$incoming"/
  install -o root -g root -m 0644 "$stage/wechat-media-tools.mjs" "$incoming/wechat-media-tools.mjs"
  install -o root -g root -m 0644 "$stage/wechat_media_cache_adapter_v1.mjs" "$incoming/wechat_media_cache_adapter_v1.mjs"
  install -o root -g root -m 0644 "$stage/manifest.json" "$incoming/manifest.json"
  install -o root -g root -m 0644 "$stage/release-closure.json" "$incoming/release-closure.json"
  chmod -R a+rX,go-w "$incoming"
  mv "$incoming" "$new"
fi
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
    assert p.is_file() and not p.is_symlink() and sha(p)==h,('R266_RELEASE_CORRUPT',f)
print('CF_R267_32_RELEASE_BYTES_VERIFIED')
PY
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
[[ "$ready" == 1 ]] || { echo CF_R267_BACKEND_UNHEALTHY; exit 21; }
[[ "$(docker inspect -f '{{.Id}}' "$gateway")" == "$gateway_before" ]] || { echo CF_R267_GATEWAY_CHANGED; exit 22; }
[[ "$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project.working_dir"}}' "$server")" == "$new" ]] || {
  echo CF_R267_CONTAINER_RELEASE_MISMATCH; exit 23;
}
for file in wechat-media-tools.mjs whatsapp-ingress.mjs wechat_media_cache_adapter_v1.mjs; do
  expected="$(sha256sum "$new/$file" | awk '{print $1}')"
  actual="$(docker exec "$server" sha256sum "/tmp/app/$file" | awk '{print $1}')"
  [[ "$actual" == "$expected" ]] || { echo "CF_R267_RUNTIME_SHA_MISMATCH:$file"; exit 25; }
done
read -r after_active after_stored after_drain <<< "$(health)"
[[ "$after_active" == 0 && "$after_stored" -ge "$stored" && "$after_drain" == 1 ]] || {
  echo CF_R267_DEXA_MISSIONS_CHANGED; exit 26;
}
tmp="$active.next-cf-r267-$$"
ln -s "$new" "$tmp"
mv -Tf "$tmp" "$active"
committed=1
echo CF_R267_BACKEND_HEALTHY_CAPTION_AND_GATEWAY_PRESERVED
echo CF_R267_DEXA_MISSIONS_PRESERVED_NO_PROVIDER_SENDS
