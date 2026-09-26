#!/usr/bin/env bash
set -euo pipefail
umask 077
[[ "$(id -u)" -eq 0 ]] || exit 2
candidate="16df8b8b56eac5fb109acb3716a2dbb12d789e1b"
old_candidate="01f0feb7ae97db4e34d00da0bc9734519ef74322"
fixture="a19e0fa5152af9f7ce106b6e:e5e7d0173fd1f1d0307a2cb6:e0929361aadb6135b5cecffa"
control=/var/lib/capability-fabric/onshape/runtime-control/ONSHAPE_RUNTIME_CONTROL.json
root=/var/lib/capability-fabric/onshape-research-phase0
cache=/var/lib/capability-fabric/repo.git
home=/var/lib/capability-fabric/agent-home
lock=/run/lock/capability-fabric-pull.lock
project=capability-fabric-onshape-phase0
release="$root/releases/$candidate"
compose="$release/server-deploy/research-phase0/compose.yaml"

python3 - "$control" <<'PY'
import json,sys
d=json.load(open(sys.argv[1])); a=d["authority"]; g=a["productionGuard"]
assert a["mode"]=="VPS_PRODUCTION" and a["materialAuthority"]=="vps-fabric"
assert a["planes"]["android-v1"]["ingress"]=="CLOSED"
assert a["reconciliationHold"]["active"] is False
assert g["killSwitch"]=="ENGAGED" and g["allowedDocumentIds"]==[] and g["mutationBudget"]["maxMutations"]==0
print("CF_PHASE0_RUNTIME_UPGRADE_AUTHORITY=pass")
PY
for c in capability-fabric-onshape-server capability-fabric-onshape-fabric capability-fabric-onshape-phase0-research capability-fabric-onshape-phase0-fabric; do
 [[ "$(docker inspect -f '{{.State.Running}}' "$c" 2>/dev/null || echo false)" == true ]]
 [[ "$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$c")" == healthy ]]
done
env_dump="$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' capability-fabric-onshape-phase0-research)"
grep -Fxq "CF_RESEARCH_SOURCE_COMMIT=$old_candidate" <<<"$env_dump"
grep -Fxq "CF_RESEARCH_FIXTURE_TARGET=$fixture" <<<"$env_dump"

db="$root/fabric-state/execution.sqlite3"
profile="$root/browser-profile"
[[ -s "$db" && -d "$profile" ]]
before_db="$(sha256sum "$db"|awk '{print $1}')"
before_profile="$(find "$profile" -maxdepth 2 -type f -printf '%P\n'|sort|sha256sum|awk '{print $1}')"

exec 9>"$lock"; flock -w 30 9
tmp="$(mktemp -d "$root/.runtime-upgrade.XXXXXX")"; trap 'rm -rf "$tmp"' EXIT
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
GIT_ASKPASS="$ask" GIT_TERMINAL_PROMPT=0 HOME="$home" git --git-dir="$cache" fetch --quiet --force --depth=1 origin "$candidate"
[[ "$(git --git-dir="$cache" rev-parse FETCH_HEAD)" == "$candidate" ]]
if [[ ! -d "$release" ]]; then
 mkdir "$tmp/release"
 git --git-dir="$cache" archive "$candidate" | tar -x -C "$tmp/release"
 mkdir -p "$root/releases"
 mv "$tmp/release" "$release"
fi
grep -Fq '"runtime.query_objects"' "$release/server-deploy/current/server.js"
grep -Fq 'async function queryRuntimeObjects' "$release/server-deploy/current/browser-native.js"
grep -Fq 'async function queryViewerRuntime' "$release/server-deploy/current/browser-native.js"
grep -Fq '"runtime.viewer"' "$release/server-deploy/current/server.js"
export CF_PHASE0_FIXTURE_TARGET="$fixture"
export CF_PHASE0_PROJECT_STATE_REVISION="$candidate"
export CF_PHASE0_SOURCE_COMMIT="$candidate"
docker compose -p "$project" -f "$compose" config >/dev/null
docker rm -f capability-fabric-onshape-phase0-fabric capability-fabric-onshape-phase0-research >/dev/null
docker compose -p "$project" -f "$compose" up -d
flock -u 9

for i in $(seq 1 90); do
 a="$(docker inspect -f '{{.State.Health.Status}}' capability-fabric-onshape-phase0-research 2>/dev/null || true)"
 b="$(docker inspect -f '{{.State.Health.Status}}' capability-fabric-onshape-phase0-fabric 2>/dev/null || true)"
 [[ "$a" == healthy && "$b" == healthy ]] && break
 [[ "$a" == unhealthy || "$b" == unhealthy ]] && exit 30
 sleep 2
done
[[ "$(docker inspect -f '{{.State.Health.Status}}' capability-fabric-onshape-phase0-research)" == healthy ]]
[[ "$(docker inspect -f '{{.State.Health.Status}}' capability-fabric-onshape-phase0-fabric)" == healthy ]]
new_env="$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' capability-fabric-onshape-phase0-research)"
grep -Fxq "CF_RESEARCH_SOURCE_COMMIT=$candidate" <<<"$new_env"
grep -Fxq "CF_RESEARCH_FIXTURE_TARGET=$fixture" <<<"$new_env"
[[ "$(sha256sum "$db"|awk '{print $1}')" == "$before_db" ]]
[[ "$(find "$profile" -maxdepth 2 -type f -printf '%P\n'|sort|sha256sum|awk '{print $1}')" == "$before_profile" ]]
echo CF_PHASE0_RUNTIME_UPGRADE=pass
