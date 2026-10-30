#!/usr/bin/env bash
set -Eeuo pipefail
umask 027
exec 9>/run/lock/cf-wechat-media-r264.lock
flock -n 9 || { echo "CF_R264_LOCK_BUSY"; exit 24; }
old=/var/lib/capability-fabric/releases/onshape-vps-fast-r100-direct-orbit1-paa-storage-r263-single-asr-tool
new=/var/lib/capability-fabric/releases/onshape-vps-fast-r100-direct-orbit1-paa-storage-r264-wechat-media1
active=/opt/capability-fabric/current
archive=/tmp/cf-r264-wechat-media-release.tgz
staged=/run/cf-r264-wechat-media-staged
server=capability-fabric-onshape-server
gateway=capability-fabric-onshape-gateway
[[ "$(id -u)" == 0 ]] || { echo "CF_R264_ROOT_REQUIRED"; exit 11; }
[[ "$(readlink -f "$active")" == "$old" ]] || { echo "CF_R264_BASELINE_MOVED"; exit 12; }
[[ -f "$archive" ]] || { echo "CF_R264_ARCHIVE_MISSING"; exit 13; }
# This host may run memory-intensive owner workloads concurrently.
# No Docker/CF service effect until enough free RAM is actually observed.
mem_kb=$(awk '$1=="MemAvailable:"{print $2}' /proc/meminfo)
[[ "$mem_kb" =~ ^[0-9]+$ && "$mem_kb" -ge 1536000 ]] || {
  echo "CF_R264_INSUFFICIENT_MEMORY_HEADROOM"; exit 31;
}
install -d -m 0700 "$staged"
tar -tzf "$archive" | python3 -c 'import sys; a=sys.stdin.read().splitlines(); assert a and all(not x.startswith("/") and ".." not in x.split("/") for x in a)'
tar -xzf "$archive" -C "$staged"
python3 - "$staged" "$old" <<'PY'
import hashlib,json,pathlib,sys
p=pathlib.Path(sys.argv[1]); old=pathlib.Path(sys.argv[2])
m=json.loads((p/"manifest.json").read_text())
before=json.loads((old/"manifest.json").read_text())
assert m["sequence"]==264
assert m["release_id"]=="onshape-vps-fast-r100-direct-orbit1-paa-storage-r264-wechat-media1"
assert before["sequence"]==263
assert before["release_id"]=="onshape-vps-fast-r100-direct-orbit1-paa-storage-r263-single-asr-tool"
assert set(m["files"])==set(json.loads((p/"release-closure.json").read_text())["files"])
assert len(m["files"])==32 and len(before["files"])==29
changed={"server.js","wechat-preload.mjs","compose.yaml","release-closure.json"}
new={"wechat-media-tools.mjs","wechat_media_cache_adapter_v1.mjs","wechat-material-download-bridge.mjs"}
assert set(m["files"])-set(before["files"])==new
for rel,h in m["files"].items():
    f=p/rel
    assert f.is_file() and not f.is_symlink() and hashlib.sha256(f.read_bytes()).hexdigest()==h,rel
for rel,h in before["files"].items():
    if rel not in changed:
        assert m["files"][rel]==h,("UNRELATED_R263_CHANGE",rel)
assert m["files"]["telegram-ingress.mjs"]==before["files"]["telegram-ingress.mjs"]
print("CF_R264_MANIFEST_AND_OLD_CONTRACT_PASS")
PY
for f in server.js wechat-preload.mjs wechat-media_cache_adapter_v1.mjs wechat-media-tools.mjs wechat-material-download-bridge.mjs; do
  if [[ -f "$staged/$f" ]]; then node --check "$staged/$f"; fi
done
if [[ -e "$new" ]]; then
  cmp -s "$new/manifest.json" "$staged/manifest.json" || { echo "CF_R264_RELEASE_COLLISION"; exit 14; }
else
  incoming="/var/lib/capability-fabric/releases/.incoming-cf-r264-$$"
  install -d -m 0755 "$incoming"
  cp -a "$staged"/. "$incoming"/
  chown -R root:root "$incoming"
  chmod -R a+rX,go-w "$incoming"
  mv "$incoming" "$new"
fi
docker compose -p capability-fabric -f "$new/compose.yaml" config --quiet
gateway_before="$(docker inspect -f '{{.Id}}' "$gateway")"
on_failure(){
  rc=$?
  if (( rc != 0 && activation_started == 1 )); then
    echo "CF_R264_ROLLBACK_START $rc"
    docker compose -p capability-fabric -f "$old/compose.yaml" up -d --no-deps --no-build --pull never --force-recreate onshape_server || true
    echo "CF_R264_ROLLBACK_ATTEMPTED"
  fi
}
activation_started=0
trap on_failure EXIT
activation_started=1
docker compose -p capability-fabric -f "$new/compose.yaml" up -d --no-deps --no-build --pull never --force-recreate onshape_server
healthy=0
for i in $(seq 1 180); do
  state="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$server" 2>/dev/null || echo missing)"
  if [[ "$state" == healthy ]]; then healthy=1; break; fi
  sleep 1
done
[[ "$healthy" == 1 ]] || { echo "CF_R264_BACKEND_HEALTH_FAILED"; exit 21; }
[[ "$(docker inspect -f '{{.Id}}' "$gateway")" == "$gateway_before" ]] || { echo "CF_R264_GATEWAY_CHANGED"; exit 22; }
[[ "$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project.working_dir"}}' "$server")" == "$new" ]] || { echo "CF_R264_RELEASE_LABEL_MISMATCH"; exit 23; }
tmp="$active.next-r264-$$"
ln -s "$new" "$tmp"
mv -Tf "$tmp" "$active"
activation_started=0
trap - EXIT
rm -f "$archive"
echo "CF_R264_ACTIVE_HEALTHY_GATEWAY_UNCHANGED"
