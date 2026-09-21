#!/usr/bin/env bash
set -euo pipefail
umask 077
[[ "$(id -u)" -eq 0 ]] || exit 2

candidate_commit="6aba3e55c3b4604e851649bede55e57453eab687"
candidate_dir="server-deploy/candidates/onshape-vps-hardened-production-r4"
cache=/var/lib/capability-fabric/repo.git
token=/etc/capability-fabric/secrets/repo-read-token
home=/var/lib/capability-fabric/agent-home
control=/var/lib/capability-fabric/onshape/runtime-control/ONSHAPE_RUNTIME_CONTROL.json
active="$(readlink -f /opt/capability-fabric/current)"

[[ "$active" == /var/lib/capability-fabric/releases/* ]] || exit 20
[[ -s "$token" && -d "$cache" && -s "$control" ]] || exit 21
[[ "$(python3 -c 'import json; print(json.load(open("'"$active"'/manifest.json"))["sequence"])')" == 66 ]] || exit 22
python3 - "$control" <<'PY'
import json,sys
r=json.load(open(sys.argv[1])); a=r["authority"]
assert r["controlRevision"]==531
assert a["productionEpoch"]==3
assert a["mode"]=="VPS_PRODUCTION"
assert a["materialAuthority"]=="vps-fabric"
assert a["planes"]["android-v1"]["ingress"]=="CLOSED"
assert a["planes"]["android-v1"]["materialEffectsAllowed"] is False
print("CF_R4_TEST_LIVE_BASE=seq66-epoch3-unchanged")
PY

tmp="$(mktemp -d /var/lib/capability-fabric/r4-test.XXXXXX)"
askpass="$tmp/askpass"
cleanup(){ rm -rf "$tmp"; }
trap cleanup EXIT
cat > "$askpass" <<'ASKPASS'
#!/usr/bin/env bash
case "${1:-}" in
  *Username*) printf '%s\n' 'x-access-token' ;;
  *Password*) cat /etc/capability-fabric/secrets/repo-read-token ;;
  *) exit 1 ;;
esac
ASKPASS
chmod 0700 "$askpass"

GIT_ASKPASS="$askpass" GIT_TERMINAL_PROMPT=0 HOME="$home"   git --git-dir="$cache" fetch --quiet --force --depth=1 origin "$candidate_commit"
resolved="$(git --git-dir="$cache" rev-parse FETCH_HEAD)"
[[ "$resolved" == "$candidate_commit" ]] || exit 23
mkdir "$tmp/release"
git --git-dir="$cache" archive "$candidate_commit" "$candidate_dir"   | tar -x -C "$tmp/release" --strip-components=3

[[ -s "$tmp/release/fabric-agent.js" ]]
[[ -s "$tmp/release/fabric-agent.test.mjs" ]]
[[ -s "$tmp/release/fabric-src/capability_fabric/onshape_authority.py" ]]
[[ ! -e "$tmp/release/browser-native.js" ]]

grep -Fq 'capability-fabric.onshape-production-guard.v1' "$tmp/release/fabric-agent.js"
grep -Fq 'FABRIC_GUARD_BUDGET_EXHAUSTED' "$tmp/release/fabric-agent.js"
grep -Fq 'require_production_guard' "$tmp/release/fabric-src/capability_fabric/onshape_authority.py"
grep -Fq 'productionGuardGeneration' "$tmp/release/fabric-src/capability_fabric/onshape_vps.py"
grep -Fq 'onshape-vps-hardened-r4' "$tmp/release/server.js"

docker run --rm --network none   -v "$tmp/release:/release:ro" -w /release   mcr.microsoft.com/playwright:v1.62.1-resolute@sha256:aebd85bce8056dcdc2269853fd94ea432b6a201da4f0ef125b509489ecd52ddb   node --check /release/fabric-agent.js

docker run --rm --network none   -v "$tmp/release:/release:ro" -w /release   mcr.microsoft.com/playwright:v1.62.1-resolute@sha256:aebd85bce8056dcdc2269853fd94ea432b6a201da4f0ef125b509489ecd52ddb   node --check /release/server.js

docker run --rm --network none   -v "$tmp/release:/release:ro" -w /release   mcr.microsoft.com/playwright:v1.62.1-resolute@sha256:aebd85bce8056dcdc2269853fd94ea432b6a201da4f0ef125b509489ecd52ddb   node --test /release/fabric-agent.test.mjs

docker run --rm --network none   -v "$tmp/release:/release:ro" -w /release/fabric-src   python:3.12-slim-bookworm@sha256:392307d22300de8b5986851a12d9176dfc0fc073e65bf6523ebd7dcbeb23564e   python -m unittest discover -s /release/fabric-tests -p 'test_*.py' -v

echo CF_R4_TEST_COMMIT="$candidate_commit"
echo CF_R4_TEST_NODE=pass
echo CF_R4_TEST_PYTHON=pass
echo CF_R4_TEST_NETWORK=none
echo CF_R4_TEST_ACTIVE_RELEASE_UNCHANGED=seq66
echo CF_R4_TEST=pass
