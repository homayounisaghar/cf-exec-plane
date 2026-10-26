#!/usr/bin/env bash
set -Eeuo pipefail
umask 027
exec 9>/run/lock/cf-pcg-r132-514.lock
flock -n 9 || { echo "PCG_R132_LOCK_BUSY"; exit 24; }
src=/run/pcg-r132-release-staged
releases=/var/lib/capability-fabric/pcg/releases
old="$releases/pcg-web-stage6-soniox-16x-r131"
new="$releases/pcg-web-stage6-soniox-parallel-514-r132"
active=/opt/capability-fabric/channels/pcg/current
old_override=$old/override-managed.yaml
new_override="$new/override-managed.yaml"
expected_src_manifest=9934752060c356207abf36334805e6cb7726103aa838a288bebd2c73162c8f85
if [[ "$(id -u)" -ne 0 ]]; then echo ROOT_REQUIRED; exit 11; fi
if [[ "$(readlink -f "$active")" == "$new" ]]; then echo PCG_R132_ALREADY_ACTIVE; exit 0; fi
if [[ "$(readlink -f "$active")" != "$old" ]]; then echo PCG_RELEASE_BASELINE_MOVED; exit 12; fi
# Extract immutable user-approved snapshot staged by the pinned workflow.
archive=/tmp/pcg-r132-release.tgz
[[ -f "$archive" ]] || { echo PCG_R132_ARCHIVE_MISSING; exit 25; }
rm -rf "$src"
install -d -m 0700 -o root -g root "$src"
tar -tzf "$archive" | python3 -c 'import sys; names=sys.stdin.read().splitlines(); assert names and all((not n.startswith("/")) and (".." not in n.split("/")) for n in names)'
tar -xzf "$archive" -C "$src"
rm -f "$archive"
for f in pcg_perplexity_asr.mjs pcg_soniox_fixed_overlap.mjs pcg_soniox_word_align_dp.mjs pcg_web_semantic_ops.mjs pcg_web_perplexity_asr_client.mjs; do
  node --check "$src/$f"
done
if [[ ! -r "$src/manifest.json" || "$(sha256sum "$src/manifest.json" | cut -d' ' -f1)" != "$expected_src_manifest" ]]; then echo PCG_STAGING_DIGEST_MISMATCH; exit 13; fi
if [[ ! -r "$old_override" || ! -r /home/cfserver/.telegram-web-cdp/cdp-proxy/stage/pcg_web_browser_resilient.mjs ]]; then echo PCG_MANAGED_RELAY_OVERRIDE_MISSING; exit 14; fi
if [[ "$(grep -Fc "$old" "$old_override")" -ne 1 ]] || ! grep -Fq '/secure-cdp/upstream.sock' "$old_override"; then echo PCG_MANAGED_RELAY_OVERRIDE_CHANGED; exit 15; fi
web=capability-fabric-pcg-web
asr=capability-fabric-pcg-perplexity-asr
project="$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project"}}' "$web")"
if [[ "$project" != capability-fabric-pcg* ]]; then echo PCG_PROJECT_UNEXPECTED; exit 16; fi
if [[ "$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project"}}' "$asr")" != "$project" ]]; then echo PCG_PROJECT_MISMATCH; exit 17; fi
for cid in "$web" "$asr"; do
  image="$(docker inspect -f '{{.Config.Image}}' "$cid")"
  if [[ "$image" != mcr.microsoft.com/playwright:v1.62.1-resolute@sha256:aebd85bce8056dcdc2269853fd94ea432b6a201da4f0ef125b509489ecd52ddb ]]; then echo PCG_NODE_IMAGE_CHANGED; exit 18; fi
done
before_other="$(for name in capability-fabric-pcg-telegram capability-fabric-pcg-asr capability-fabric-pcg-audio-transform capability-fabric-pcg-core; do docker inspect -f '{{.Id}}' "$name"; done)"
if [[ ! -d "$new" ]]; then
  incoming="$releases/.incoming-pcg-r132-514-$$"
  install -d -m 0755 "$incoming"
  cp -a "$src"/. "$incoming/"
  chown -R root:root "$incoming"
  chmod -R a+rX,go-w "$incoming"
  chmod 0755 "$incoming/health.sh"
  python3 - "$incoming" <<'PY'
import hashlib,json,pathlib,sys
root=pathlib.Path(sys.argv[1])
m=json.loads((root/'manifest.json').read_text())
assert m['sequence']==132 and m['release_id']=='pcg-web-stage6-soniox-parallel-514-r132'
for filename,digest in m['files'].items():
 assert hashlib.sha256((root/filename).read_bytes()).hexdigest()==digest,filename
print('PCG_STAGED_RELEASE_VERIFIED',len(m['files']))
PY
  mv "$incoming" "$new"
else
  if [[ ! -r "$new/manifest.json" ]] || ! cmp -s "$src/manifest.json" "$new/manifest.json"; then echo PCG_R132_RELEASE_COLLISION; exit 19; fi
fi
sed "s|$old|$new|g" "$old_override" > "$new_override"
chown root:root "$new_override"
chmod 0644 "$new_override"
docker compose -p "$project" -f "$new/compose.yaml" -f "$new_override" config --quiet
if ! docker image inspect 'mcr.microsoft.com/playwright:v1.62.1-resolute@sha256:aebd85bce8056dcdc2269853fd94ea432b6a201da4f0ef125b509489ecd52ddb' >/dev/null; then echo PCG_NODE_IMAGE_UNAVAILABLE; exit 20; fi
echo PCG_R132_PREFLIGHT_PASS
activation_started=0
rollback_on_failure(){
  rc=$?
  if (( rc != 0 )) && (( activation_started == 1 )); then
    echo "PCG_R132_FAILED_ROLLBACK_START code=$rc"
    docker compose -p "$project" -f "$old/compose.yaml" -f "$old_override" up -d --no-deps --no-build --pull never --force-recreate pcg_perplexity_asr pcg_web || true
    echo "PCG_R132_ROLLBACK_RECREATE_ATTEMPTED"
  fi
}
trap rollback_on_failure EXIT
activation_started=1
docker compose -p "$project" -f "$new/compose.yaml" -f "$new_override" up -d --no-deps --no-build --pull never --force-recreate pcg_perplexity_asr pcg_web
ok=0
for i in $(seq 1 180); do
  s1="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$asr" 2>/dev/null || echo missing)"
  s2="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$web" 2>/dev/null || echo missing)"
  if [[ "$s1" == healthy && "$s2" == healthy ]]; then ok=1; break; fi
  sleep 1
done
if [[ "$ok" != 1 ]]; then echo "PCG_R132_HEALTH_FAILED asr=$s1 web=$s2"; exit 21; fi
for name in "$web" "$asr"; do
  dir="$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project.working_dir"}}' "$name")"
  if [[ "$dir" != "$new" ]]; then echo "PCG_R132_RELEASE_LABEL_MISMATCH"; exit 22; fi
done
after_other="$(for name in capability-fabric-pcg-telegram capability-fabric-pcg-asr capability-fabric-pcg-audio-transform capability-fabric-pcg-core; do docker inspect -f '{{.Id}}' "$name"; done)"
if [[ "$before_other" != "$after_other" ]]; then echo PCG_R132_UNRELATED_CONTAINERS_CHANGED; exit 23; fi
docker exec "$asr" node -e 'const net=require("node:net");const s=net.createConnection({path:"/run/pcg/perplexity-asr.sock"});s.setTimeout(3000);s.on("connect",()=>s.write(JSON.stringify({op:"health"})+String.fromCharCode(10)));let data="";s.on("data",c=>{data+=c;if(data.includes(String.fromCharCode(10))){const d=JSON.parse(data.split(String.fromCharCode(10))[0]);if(d.ok===true&&d.state==="READY"&&Array.isArray(d.supported_speed_factors)&&d.supported_speed_factors.includes(16)&&d.default_stream_speed_factor===4&&d.default_parallelism===514&&Array.isArray(d.parallelism_range)&&d.parallelism_range[0]===1&&d.parallelism_range[1]===514){console.log("PCG_R132_16X_ENGINE_HEALTH_PASS");process.exit(0)}console.error("PCG_R132_ENGINE_HEALTH_UNEXPECTED");process.exit(1)}});s.on("error",()=>process.exit(1));s.on("timeout",()=>process.exit(1));'
newlink="$active.next-$$"
ln -s "$new" "$newlink"
mv -Tf "$newlink" "$active"
activation_started=0
trap - EXIT
echo "PCG_R132_ACTIVATED_RELEASE=pcg-web-stage6-soniox-parallel-514-r132"
echo "PCG_R132_MANAGED_TELEGRAM_RELAY=PRESERVED"
echo "PCG_R132_UNRELATED_CONTAINERS=UNCHANGED"

