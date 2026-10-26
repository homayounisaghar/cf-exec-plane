#!/usr/bin/env bash
set -Eeuo pipefail
umask 027
exec 9>/run/lock/cf-audio-telegram-r262.lock
flock -n 9 || { echo "CF_R262_LOCK_BUSY"; exit 24; }
old=/var/lib/capability-fabric/releases/onshape-vps-fast-r100-direct-orbit1-paa-storage-r261-audio-batch20
new=/var/lib/capability-fabric/releases/onshape-vps-fast-r100-direct-orbit1-paa-storage-r262-telegram-audio-batch
active=/opt/capability-fabric/current
src=/run/cf-r262-telegram-batch-staged
archive=/tmp/cf-r262-release.tgz
name=capability-fabric-onshape-server
[[ "$(id -u)" == 0 ]] || { echo "ROOT_REQUIRED"; exit 11; }
[[ "$(readlink -f "$active")" == "$old" ]] || { echo "CF_R262_RELEASE_BASELINE_MOVED"; exit 12; }
[[ -f "$archive" ]] || { echo "CF_R262_ARCHIVE_MISSING"; exit 13; }
install -d -m 0700 "$src"
tar -tzf "$archive" | python3 -c 'import sys; a=sys.stdin.read().splitlines(); assert a and all(not x.startswith("/") and ".." not in x.split("/") for x in a)'
tar -xzf "$archive" -C "$src"
rm -f "$archive"
node --check "$src/telegram-ingress.mjs"
python3 - "$src" <<'PY'
import hashlib,json,pathlib,sys
p=pathlib.Path(sys.argv[1]);m=json.loads((p/"manifest.json").read_text())
assert m["sequence"]==262 and m["release_id"]=="onshape-vps-fast-r100-direct-orbit1-paa-storage-r262-telegram-audio-batch"
for f,h in m["files"].items(): assert hashlib.sha256((p/f).read_bytes()).hexdigest()==h,f
print("CF_R262_STAGING_INTEGRITY_PASS")
PY
if [[ -e "$new" ]]; then
  cmp -s "$src/manifest.json" "$new/manifest.json" || { echo "CF_R262_RELEASE_COLLISION";exit 14; }
else
  incoming=/var/lib/capability-fabric/releases/.incoming-cf-r262-$$
  install -d -m 0755 "$incoming"
  cp -a "$src"/. "$incoming/"
  chown -R root:root "$incoming"
  chmod -R a+rX,go-w "$incoming"
  mv "$incoming" "$new"
fi
docker compose -p capability-fabric -f "$new/compose.yaml" config --quiet
before_gateway="$(docker inspect -f '{{.Id}}' capability-fabric-onshape-gateway)"
activation_started=0
on_failure(){
  rc=$?
  if (( rc != 0 && activation_started == 1 ));then
    echo "CF_R262_ROLLBACK_START $rc"
    docker compose -p capability-fabric -f "$old/compose.yaml" up -d --no-deps --no-build --pull never --force-recreate onshape_server || true
    echo "CF_R262_ROLLBACK_ATTEMPTED"
  fi
}
trap on_failure EXIT
activation_started=1
docker compose -p capability-fabric -f "$new/compose.yaml" up -d --no-deps --no-build --pull never --force-recreate onshape_server
good=0
for i in $(seq 1 180);do
  state="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$name" 2>/dev/null || echo missing)"
  if [[ "$state" == healthy ]];then good=1;break;fi
  sleep 1
done
[[ "$good" == 1 ]] || { echo "CF_R262_BACKEND_HEALTH_FAILED";exit 21; }
[[ "$(docker inspect -f '{{.Id}}' capability-fabric-onshape-gateway)" == "$before_gateway" ]] || { echo "CF_R262_GATEWAY_CHANGED";exit 22; }
[[ "$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project.working_dir"}}' "$name")" == "$new" ]] || { echo "CF_R262_RELEASE_LABEL_MISMATCH";exit 23; }
tmp="$active.next-r262-$$"
ln -s "$new" "$tmp"
mv -Tf "$tmp" "$active"
activation_started=0
trap - EXIT
echo "CF_R262_ACTIVE_HEALTHY"
echo "CF_R262_GATEWAY_CONTAINER_UNCHANGED"
