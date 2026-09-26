#!/usr/bin/env bash
set -euo pipefail
umask 077
[[ "$(id -u)" -eq 0 ]] || exit 2

candidate="d882fa763b3a55be5a18d6e196d028ff4f77ea07"
old_candidate="ae9bc114d84cfd7991cbdd38489b18d33a2d34bf"
fixture="a19e0fa5152af9f7ce106b6e:e5e7d0173fd1f1d0307a2cb6:e0929361aadb6135b5cecffa"
expected_control_blob="1b9c248d8b57385a86c5c157bf99ef4f1f6928ce"
control=/var/lib/capability-fabric/onshape/runtime-control/ONSHAPE_RUNTIME_CONTROL.json
prod_gate=/var/lib/capability-fabric/state/release-in-progress
lock=/run/lock/capability-fabric-pull.lock
cache=/var/lib/capability-fabric/repo.git
repo_token=/etc/capability-fabric/secrets/repo-read-token
git_home=/var/lib/capability-fabric/agent-home
root=/var/lib/capability-fabric/onshape-research-phase0
release="$root/releases/$candidate"
compose="$release/server-deploy/research-phase0/compose.yaml"
project=capability-fabric-onshape-phase0

[[ "$(git hash-object "$control")" == "$expected_control_blob" ]] || { echo CF_PHASE0_UPGRADE_CONTROL=freshness-mismatch; exit 20; }
python3 - "$control" <<'PY'
import json,sys
d=json.load(open(sys.argv[1])); a=d["authority"]; v=a["planes"]["vps-fabric"]; g=a["productionGuard"]
assert d["controlRevision"]==556
assert a["productionEpoch"]==27
assert a["mode"]=="VPS_PRODUCTION" and a["materialAuthority"]=="vps-fabric"
assert a["planes"]["android-v1"]["ingress"]=="CLOSED" and a["planes"]["android-v1"]["materialEffectsAllowed"] is False
assert v["ingress"]=="ADMITTED" and v["materialEffectsAllowed"] is True
assert v["releaseSequence"]==73 and v["releaseId"]=="onshape-vps-hardened-production-r8"
assert a["reconciliationHold"]["active"] is False
assert g["killSwitch"]=="ENGAGED" and g["allowedDocumentIds"]==[] and g["mutationBudget"]["maxMutations"]==0
print("CF_PHASE0_UPGRADE_AUTHORITY=pass")
PY
[[ -f "$prod_gate" ]] && grep -Fxq RELEASE_IN_PROGRESS "$prod_gate" || exit 21
for c in capability-fabric-onshape-server capability-fabric-onshape-fabric; do
 [[ "$(docker inspect -f '{{.State.Running}}' "$c" 2>/dev/null || echo false)" == true ]]
 [[ "$(docker inspect -f '{{.State.Health.Status}}' "$c")" == healthy ]]
done
[[ "$(docker inspect -f '{{.State.Running}}' capability-fabric-onshape-gateway 2>/dev/null || echo false)" == false ]]
echo CF_PHASE0_UPGRADE_PRODUCTION_PRE=pass

# Existing research stack must be the exact predecessor and exact fixture.
for c in capability-fabric-onshape-phase0-research capability-fabric-onshape-phase0-fabric; do
 [[ "$(docker inspect -f '{{.State.Running}}' "$c" 2>/dev/null || echo false)" == true ]]
 [[ "$(docker inspect -f '{{.State.Health.Status}}' "$c")" == healthy ]]
done
env_dump="$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' capability-fabric-onshape-phase0-research)"
grep -Fxq "CF_RESEARCH_SOURCE_COMMIT=$old_candidate" <<<"$env_dump"
grep -Fxq "CF_RESEARCH_FIXTURE_TARGET=$fixture" <<<"$env_dump"
echo CF_PHASE0_UPGRADE_OLD_BINDING=pass

# Preserve durable research state and authenticated browser profile.
db="$root/fabric-state/execution.sqlite3"
profile="$root/browser-profile"
[[ -s "$db" && -d "$profile" ]]
before_db="$(sha256sum "$db"|awk '{print $1}')"
before_profile_meta="$(find "$profile" -maxdepth 2 -type f -printf '%P\n' | sort | sha256sum | awk '{print $1}')"
echo CF_PHASE0_UPGRADE_STATE_PRESERVE_PRE=pass

exec 9>"$lock"
flock -w 30 9 || exit 22
echo CF_PHASE0_UPGRADE_SHARED_LOCK=acquired

tmp="$(mktemp -d "$root/.upgrade.XXXXXX")"
trap 'rm -rf "$tmp"' EXIT
ask="$tmp/askpass"
cat >"$ask" <<'ASK'
#!/usr/bin/env bash
case "${1:-}" in
 *Username*) printf '%s\n' x-access-token ;;
 *Password*) cat /etc/capability-fabric/secrets/repo-read-token ;;
 *) exit 1 ;;
esac
ASK
chmod 0700 "$ask"
GIT_ASKPASS="$ask" GIT_TERMINAL_PROMPT=0 HOME="$git_home" git --git-dir="$cache" fetch --quiet --force --depth=1 origin "$candidate"
[[ "$(git --git-dir="$cache" rev-parse FETCH_HEAD)" == "$candidate" ]]
if [[ ! -d "$release" ]]; then
 mkdir "$tmp/release"
 git --git-dir="$cache" archive "$candidate" | tar -x -C "$tmp/release"
 mkdir -p "$root/releases"
 mv "$tmp/release" "$release"
fi
[[ -s "$compose" && -s "$release/server-deploy/current/server.js" ]]
grep -Fq 'CF_FABRIC_AGENT_PORT: "8899"' "$compose"

export CF_PHASE0_FIXTURE_TARGET="$fixture"
export CF_PHASE0_PROJECT_STATE_REVISION="$candidate"
export CF_PHASE0_SOURCE_COMMIT="$candidate"
docker compose -p "$project" -f "$compose" config >/dev/null
echo CF_PHASE0_UPGRADE_COMPOSE=pass

# Recreate research only. No production container or production state is touched.
docker rm -f capability-fabric-onshape-phase0-fabric capability-fabric-onshape-phase0-research >/dev/null
docker compose -p "$project" -f "$compose" up -d
flock -u 9
echo CF_PHASE0_UPGRADE_SHARED_LOCK=released

for i in $(seq 1 90); do
 a="$(docker inspect -f '{{.State.Health.Status}}' capability-fabric-onshape-phase0-research 2>/dev/null || true)"
 b="$(docker inspect -f '{{.State.Health.Status}}' capability-fabric-onshape-phase0-fabric 2>/dev/null || true)"
 [[ "$a" == healthy && "$b" == healthy ]] && break
 [[ "$a" == unhealthy || "$b" == unhealthy ]] && exit 30
 sleep 2
done
[[ "$(docker inspect -f '{{.State.Health.Status}}' capability-fabric-onshape-phase0-research)" == healthy ]]
[[ "$(docker inspect -f '{{.State.Health.Status}}' capability-fabric-onshape-phase0-fabric)" == healthy ]]
echo CF_PHASE0_UPGRADE_HEALTH=pass

new_env="$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' capability-fabric-onshape-phase0-research)"
grep -Fxq "CF_RESEARCH_SOURCE_COMMIT=$candidate" <<<"$new_env"
grep -Fxq "CF_RESEARCH_FIXTURE_TARGET=$fixture" <<<"$new_env"
side_env="$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' capability-fabric-onshape-phase0-fabric)"
grep -Fxq 'CF_FABRIC_AGENT_PORT=8899' <<<"$side_env"
grep -Fxq 'CF_FABRIC_REQUIRE_PRODUCTION_AUTHORITY=0' <<<"$side_env"
echo CF_PHASE0_UPGRADE_NEW_BINDING=pass

# DB/profile were not cleared or replaced.
after_db="$(sha256sum "$db"|awk '{print $1}')"
[[ "$after_db" == "$before_db" ]]
after_profile_meta="$(find "$profile" -maxdepth 2 -type f -printf '%P\n' | sort | sha256sum | awk '{print $1}')"
[[ "$after_profile_meta" == "$before_profile_meta" ]]
echo CF_PHASE0_UPGRADE_STATE_PRESERVED=pass

[[ "$(git hash-object "$control")" == "$expected_control_blob" ]]
[[ -f "$prod_gate" ]] && grep -Fxq RELEASE_IN_PROGRESS "$prod_gate"
for c in capability-fabric-onshape-server capability-fabric-onshape-fabric; do
 [[ "$(docker inspect -f '{{.State.Running}}' "$c")" == true ]]
 [[ "$(docker inspect -f '{{.State.Health.Status}}' "$c")" == healthy ]]
done
[[ "$(docker inspect -f '{{.State.Running}}' capability-fabric-onshape-gateway 2>/dev/null || echo false)" == false ]]
echo CF_PHASE0_UPGRADE_PRODUCTION_UNCHANGED=pass
echo CF_PHASE0_UPGRADE=pass
