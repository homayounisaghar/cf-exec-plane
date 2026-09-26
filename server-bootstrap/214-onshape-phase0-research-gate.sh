#!/usr/bin/env bash
set -euo pipefail
umask 077
[[ "$(id -u)" -eq 0 ]] || { echo "must run as uid 0" >&2; exit 2; }

candidate_commit="fb31d9bc095c23476a01448f6302ff747769ced8"
cache=/var/lib/capability-fabric/repo.git
token=/etc/capability-fabric/secrets/repo-read-token
home=/var/lib/capability-fabric/agent-home

[[ -s "$token" && -d "$cache" ]] || { echo "private repo read path unavailable" >&2; exit 20; }

tmp="$(mktemp -d /var/lib/capability-fabric/phase0-research-gate.XXXXXX)"
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

GIT_ASKPASS="$askpass" GIT_TERMINAL_PROMPT=0 HOME="$home" \
  git --git-dir="$cache" fetch --quiet --force --depth=1 origin "$candidate_commit"
resolved="$(git --git-dir="$cache" rev-parse FETCH_HEAD)"
[[ "$resolved" == "$candidate_commit" ]] || { echo "candidate resolution mismatch" >&2; exit 21; }

mkdir "$tmp/repo"
git --git-dir="$cache" archive "$candidate_commit" | tar -x -C "$tmp/repo"
cd "$tmp/repo"

for path in \
  pyproject.toml \
  server-deploy/current/server.js \
  server-deploy/current/browser-native.js \
  server-deploy/current/runtime-mode.js \
  server-deploy/current/runtime-mode.test.mjs \
  server-deploy/current/fabric-agent.js \
  server-deploy/current/fabric-agent.test.mjs \
  server-deploy/current/session-pool.js \
  server-deploy/current/session-pool.test.mjs \
  server-deploy/research-phase0/compose.yaml \
  tests/onshape_vps_fabric/test_research_sidecar_bind.py
do
  [[ -s "$path" ]] || { echo "missing candidate path: $path" >&2; exit 22; }
done

grep -Fq ': "onshape-vps-hardened-r8";' server-deploy/current/server.js
grep -Fq 'onshape-phase0-${RESEARCH_SOURCE_COMMIT.slice(0, 12)}' server-deploy/current/server.js
grep -Fq 'Phase 0 research runtime requires exact CF_RESEARCH_SOURCE_COMMIT' server-deploy/current/server.js
grep -Fq 'CF_RESEARCH_SURFACE_ID' server-deploy/current/server.js
grep -Fq 'RESEARCH_FIXTURE_MISMATCH' server-deploy/current/server.js
grep -Fq 'PHASE0_RESEARCH_PORTS' server-deploy/current/runtime-mode.js
grep -Fq 'apiBasePath' server-deploy/current/server.js
grep -Fq '"network.snapshot", "websocket.snapshot", "runtime.query_objects"' server-deploy/current/server.js
grep -Fq '"runtime.query_objects"' server-deploy/current/browser-native.js
grep -Fq '"runtime.viewer"' server-deploy/current/browser-native.js
grep -Fq 'async function queryViewerRuntime' server-deploy/current/browser-native.js
grep -Fq '"runtime.query_objects"' src/capability_fabric/onshape_vps.py
grep -Fq '"runtime.viewer"' src/capability_fabric/onshape_vps.py
grep -Fq '"runtime.query_objects"' server-deploy/current/fabric-src/capability_fabric/onshape_vps.py
grep -Fq '"runtime.viewer"' server-deploy/current/fabric-src/capability_fabric/onshape_vps.py
grep -Fq 'async function queryRuntimeObjects' server-deploy/current/browser-native.js
grep -Fq 'CF_FABRIC_AGENT_PORT: "8899"' server-deploy/research-phase0/compose.yaml
grep -Fq 'port not in {8789, 8899}' src/capability_fabric/onshape_vps_transport.py

echo CF_PHASE0_CANDIDATE_FETCH=pass
echo CF_PHASE0_CANDIDATE_COMMIT="$candidate_commit"
echo CF_PHASE0_PRIVATE_SOURCE_LOCATION=vps-temp-only

python_image='python:3.12-slim-bookworm@sha256:392307d22300de8b5986851a12d9176dfc0fc073e65bf6523ebd7dcbeb23564e'
node_image='mcr.microsoft.com/playwright:v1.62.1-resolute@sha256:aebd85bce8056dcdc2269853fd94ea432b6a201da4f0ef125b509489ecd52ddb'

docker run --rm --network none \
  -v "$tmp/repo:/repo:rw" -w /repo \
  -e PYTHONDONTWRITEBYTECODE=1 -e PYTHONPATH=/repo/src \
  "$python_image" sh -ec '
    python -m compileall -q src/capability_fabric tests/v1_kernel tests/v1_persistence tests/onshape_vps_fabric
    python -m unittest discover -s tests/v1_kernel -p "test_*.py" -v
    python -m unittest discover -s tests/v1_persistence -p "test_*.py" -v
    python -m unittest discover -s tests/onshape_vps_fabric -p "test_*.py" -v
  '
echo CF_PHASE0_CANONICAL_PYTHON=pass

docker run --rm \
  -v "$tmp/repo:/repo:rw" -w /repo/server-deploy/current \
  "$node_image" sh -ec '
    npm install --omit=dev --ignore-scripts --no-audit --no-fund --package-lock=false
  '
echo CF_PHASE0_NODE_DEPS=pass

docker run --rm --network none \
  -v "$tmp/repo:/repo:rw" -w /repo \
  "$node_image" sh -ec '
    node --check server-deploy/current/server.js
    node --check server-deploy/current/browser-native.js
    node --check server-deploy/current/runtime-mode.js
    node --check server-deploy/current/fabric-agent.js
    node --check server-deploy/current/session-pool.js
    node --test server-deploy/current/runtime-mode.test.mjs
    node --test server-deploy/current/fabric-agent.test.mjs
    node --test server-deploy/current/session-pool.test.mjs
  '
echo CF_PHASE0_NODE=pass

CF_PHASE0_FIXTURE_TARGET="111111111111111111111111:222222222222222222222222:333333333333333333333333" \
CF_PHASE0_PROJECT_STATE_REVISION="cf-exec-plane-phase0-gate" \
CF_PHASE0_SOURCE_COMMIT="$candidate_commit" \
  docker compose -f server-deploy/research-phase0/compose.yaml config >/dev/null
echo CF_PHASE0_COMPOSE_CONFIG=pass

docker run --rm --network none \
  -v "$tmp/repo:/repo:rw" -w /repo/server-deploy/current \
  -e PYTHONDONTWRITEBYTECODE=1 \
  -e PYTHONPATH=/repo/server-deploy/current/fabric-src \
  "$python_image" sh -ec '
    python -m compileall -q fabric-src fabric-tests
    python -m unittest discover -s fabric-tests -p "test_*.py" -v
  '
echo CF_PHASE0_STAGED_PYTHON=pass

echo CF_PHASE0_DEPLOYMENT=none
echo CF_PHASE0_ONSHAPE_LIVE_INTERACTION=none
echo CF_PHASE0_RESEARCH_GATE=pass
