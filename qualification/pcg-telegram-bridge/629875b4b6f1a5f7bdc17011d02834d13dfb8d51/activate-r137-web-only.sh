#!/usr/bin/env bash
set -Eeuo pipefail
umask 027
exec 9>/run/lock/cf-pcg-r137-web-only.lock
flock -n 9 || { echo "PCG_R137_LOCK_BUSY"; exit 24; }
releases=/var/lib/capability-fabric/pcg/releases
old="$releases/pcg-web-stage6-soniox-multifile20-r136"
new="$releases/pcg-web-stage6-soniox-multifile20-telegram-batch-r137"
active=/opt/capability-fabric/channels/pcg/current
archive=/tmp/pcg-r137-release.tgz
src=/run/pcg-r137-release-staged
web=capability-fabric-pcg-web
asr=capability-fabric-pcg-perplexity-asr
[[ "$(id -u)" == 0 ]] || { echo "ROOT_REQUIRED"; exit 11; }
[[ "$(readlink -f "$active")" == "$old" ]] || { echo "PCG_R137_RELEASE_BASELINE_MOVED"; exit 12; }
[[ -f "$archive" && -f "$old/override-managed.yaml" ]] || { echo "PCG_R137_MISSING_BASELINE_OR_ARCHIVE"; exit 13; }
install -d -m 0700 "$src"
tar -tzf "$archive" | python3 -c 'import sys; a=sys.stdin.read().splitlines(); assert a and all(not x.startswith("/") and ".." not in x.split("/") for x in a)'
tar -xzf "$archive" -C "$src"
rm -f "$archive"
node --check "$src/pcg_web_semantic_ops.mjs"
python3 - "$src" <<'PY'
import hashlib,json,pathlib,sys
p=pathlib.Path(sys.argv[1]);m=json.loads((p/"manifest.json").read_text())
assert m["sequence"]==137 and m["release_id"]=="pcg-web-stage6-soniox-multifile20-telegram-batch-r137"
for f,d in m["files"].items():assert hashlib.sha256((p/f).read_bytes()).hexdigest()==d,f
print("PCG_R137_STAGING_INTEGRITY_PASS")
PY
if [[ -e "$new" ]]; then
  cmp -s "$src/manifest.json" "$new/manifest.json" || { echo "PCG_R137_RELEASE_COLLISION"; exit 14; }
else
  incoming="$releases/.incoming-pcg-r137-$$"
  install -d -m 0755 "$incoming"
  cp -a "$src"/. "$incoming/"
  chown -R root:root "$incoming"
  chmod -R a+rX,go-w "$incoming"
  mv "$incoming" "$new"
fi
sed "s|$old|$new|g" "$old/override-managed.yaml" > "$new/override-managed.yaml"
chmod 0644 "$new/override-managed.yaml"
project="$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project"}}' "$web")"
[[ "$project" == capability-fabric-pcg* ]] || { echo "PCG_R137_PROJECT_UNEXPECTED"; exit 16; }
docker compose -p "$project" -f "$new/compose.yaml" -f "$new/override-managed.yaml" config --quiet
before_asr="$(docker inspect -f '{{.Id}}' "$asr")"
before_other="$(for n in capability-fabric-pcg-telegram capability-fabric-pcg-asr capability-fabric-pcg-audio-transform capability-fabric-pcg-core; do docker inspect -f '{{.Id}}' "$n"; done)"
activation_started=0
rollback_on_failure(){
  rc=$?
  if (( rc != 0 && activation_started == 1 )); then
    echo "PCG_R137_ROLLBACK_START $rc"
    docker compose -p "$project" -f "$old/compose.yaml" -f "$old/override-managed.yaml" up -d --no-deps --no-build --pull never --force-recreate pcg_web || true
    echo "PCG_R137_ROLLBACK_ATTEMPTED"
  fi
}
trap rollback_on_failure EXIT
activation_started=1
docker compose -p "$project" -f "$new/compose.yaml" -f "$new/override-managed.yaml" up -d --no-deps --no-build --pull never --force-recreate pcg_web
healthy=0
for i in $(seq 1 180); do
  h="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$web" 2>/dev/null || echo missing)"
  if [[ "$h" == healthy ]];then healthy=1;break;fi
  sleep 1
done
[[ "$healthy" == 1 ]] || { echo "PCG_R137_WEB_HEALTH_FAILED"; exit 17; }
[[ "$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project.working_dir"}}' "$web")" == "$new" ]] || { echo "PCG_R137_RELEASE_LABEL_MISMATCH"; exit 18; }
[[ "$(docker inspect -f '{{.Id}}' "$asr")" == "$before_asr" ]] || { echo "PCG_R137_UNRELATED_ASR_RESTARTED"; exit 19; }
after_other="$(for n in capability-fabric-pcg-telegram capability-fabric-pcg-asr capability-fabric-pcg-audio-transform capability-fabric-pcg-core; do docker inspect -f '{{.Id}}' "$n"; done)"
[[ "$before_other" == "$after_other" ]] || { echo "PCG_R137_UNRELATED_CONTAINER_CHANGED"; exit 20; }
tmp="$active.next-r137-$$"
ln -s "$new" "$tmp"
mv -Tf "$tmp" "$active"
activation_started=0
trap - EXIT
echo "PCG_R137_WEB_ONLY_ACTIVE_AND_HEALTHY"
echo "PCG_R137_ASR_AND_FOUR_OTHER_SERVICES_UNCHANGED"
