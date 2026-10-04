#!/usr/bin/env bash
set -euo pipefail

service_name=capability-fabric-onshape-server.service
unit_src="$CF_RELEASE_DIR/capability-fabric-onshape-server.service"
unit_dst="/etc/systemd/system/$service_name"
token_file=/etc/capability-fabric/secrets/mcp-token
profile=/var/lib/capability-fabric/onshape/browser-profile
secret_dir=/etc/capability-fabric/secrets/onshape
agent_state=/var/lib/capability-fabric/onshape/agent
openapi_dir=/var/lib/capability-fabric/onshape/openapi

[[ "$(stat -c '%a %U:%G' "$token_file")" == "600 root:root" ]]
install -d -m 0700 -o root -g root "$profile" "$secret_dir" "$agent_state" "$openapi_dir"
for secret in "$secret_dir/account" "$secret_dir/password"; do
  [[ -e "$secret" ]] || install -m 0600 -o root -g root /dev/null "$secret"
  [[ "$(stat -c '%a %U:%G' "$secret")" == "600 root:root" ]]
done

services="$(docker compose -p "$CF_COMPOSE_PROJECT" -f "$CF_RELEASE_DIR/compose.yaml" config --services | sort)"
[[ "$services" == $'onshape_gateway\nonshape_server' ]]

backend_cid="$(docker compose -p "$CF_COMPOSE_PROJECT" -f "$CF_RELEASE_DIR/compose.yaml" ps -q onshape_server)"
gateway_cid="$(docker compose -p "$CF_COMPOSE_PROJECT" -f "$CF_RELEASE_DIR/compose.yaml" ps -q onshape_gateway)"
[[ -n "$backend_cid" && -n "$gateway_cid" ]]
[[ "$(docker inspect -f '{{.State.Running}}' "$backend_cid")" == "true" ]]
[[ "$(docker inspect -f '{{.State.Running}}' "$gateway_cid")" == "true" ]]

backend_mounts="$(docker inspect -f '{{range .Mounts}}{{println .Source "|" .Destination "|" .RW}}{{end}}' "$backend_cid")"
grep -Fq '/var/lib/capability-fabric/onshape/browser-profile | /profile | true' <<<"$backend_mounts"
grep -Fq '/var/lib/capability-fabric/onshape/openapi | /openapi | true' <<<"$backend_mounts"
grep -Fq '/var/lib/capability-fabric/onshape/agent | /agent-state | true' <<<"$backend_mounts"

backend_env="$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$backend_cid")"
printf '%s\n' "$backend_env" | grep -Fxq 'ONSHAPE_API_MIN_INTERVAL_MS=1000'
printf '%s\n' "$backend_env" | grep -Fxq 'ONSHAPE_AGENT_STATE_DIR=/agent-state'
printf '%s\n' "$backend_env" | grep -Fxq 'CF_RVC_WORKER_URL=http://127.0.0.1:8794'

python3 - "$CF_RELEASE_DIR/release-closure.json" "$CF_RELEASE_DIR/manifest.json" <<'PY'
import json,sys
cfg=json.load(open(sys.argv[1]))
man=json.load(open(sys.argv[2]))
assert cfg["schema"]=="onshape.direct-release-closure.v1"
assert cfg["build_id"]==man["release_id"], (cfg["build_id"], man["release_id"])
r=cfg["required_runtime_config"]
assert r["browser_topology"]=="SINGLE_SESSION"
assert r["browser_contexts"]==1
assert r["documented_operation_path"]=="DIRECT_NODE_AGENT"
assert r["operation_registry"]=="STARTUP_PREINDEXED"
assert r["request_journal"]=="MUTATIONS_ONLY"
assert r["api_maximum_concurrency"]==1
assert r["api_minimum_interval_ms"]==1000
print("ONSHAPE_DIRECT_RELEASE_CLOSURE=pass")
PY

for _ in $(seq 1 90); do
  backend="$(curl -fsS --max-time 2 http://127.0.0.1:8788/ 2>/dev/null || true)"
  gateway="$(curl -fsS --max-time 2 http://127.0.0.1:8787/ 2>/dev/null || true)"
  [[ "$backend" == "cf-onshape-single ok" && "$gateway" == "cf-onshape-single ok" ]] && break
  sleep 1
done
[[ "$backend" == "cf-onshape-single ok" ]]
[[ "$gateway" == "cf-onshape-single ok" ]]

paa_health="$(curl -fsS --max-time 3 http://127.0.0.1:8793/local/v1/health 2>/dev/null || true)"
python3 - "$paa_health" <<'PY'
import json,sys
o=json.loads(sys.argv[1])
assert o.get("status")=="ok"
assert o.get("schema")=="personal-android-agent.command-queue-health.v1"
PY
printf 'PAA_COMMAND_QUEUE_HEALTH=pass\n'

# Readback: the live service must report the build id of this very release.
expected_build="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["build_id"])' "$CF_RELEASE_DIR/release-closure.json")"
served_build=''
for _ in $(seq 1 30); do
  served_build="$(curl -fsS -D - -o /dev/null --max-time 3 http://127.0.0.1:8788/ 2>/dev/null \
    | awk 'tolower($1)=="x-cf-build-id:"{print $2}' | tr -d '\r')"
  [[ "$served_build" == "$expected_build" ]] && break
  sleep 1
done
if [[ "$served_build" != "$expected_build" ]]; then
  echo "ONSHAPE_LIVE_BUILD_MISMATCH served='$served_build' expected='$expected_build'" >&2
  exit 1
fi
printf 'ONSHAPE_LIVE_BUILD_READBACK=%s\n' "$served_build"

for port in 8787 8788; do
  ss -lnt | awk -v p="127.0.0.1:$port" '$4 == p {found=1} END {exit found ? 0 : 1}'
done
if ss -lnt | awk '$4 ~ /^(0\.0\.0\.0|\[::\]|\*):(8787|8788|8794)$/ {found=1} END {exit found ? 0 : 1}'; then
  echo "Onshape listener is exposed beyond loopback" >&2
  exit 1
fi

if ss -lnt | awk '$4 ~ /^(0\.0\.0\.0|\[::\]|\*):8794$/ {found=1} END {exit found ? 0 : 1}'; then
  echo "Optional RVC listener is exposed beyond loopback" >&2
  exit 1
fi
printf 'RVC_OPTIONAL_LOOPBACK_GUARD=pass\n'

docker compose -p "$CF_COMPOSE_PROJECT" -f "$CF_RELEASE_DIR/compose.yaml" exec -T onshape_server \
  sh -lc 'cp /release/onshape-agent.test.mjs /tmp/app/ && cd /tmp/app && node --check server.js && node --check core.js && node --check browser.js && node --check onshape-agent.js && node --test onshape-agent.test.mjs'

unit_changed=no
if [[ ! -f "$unit_dst" ]] || ! cmp -s "$unit_src" "$unit_dst"; then
  install -m 0644 -o root -g root "$unit_src" "$unit_dst"
  unit_changed=yes
fi
[[ "$unit_changed" == no ]] || systemctl daemon-reload
[[ "$(systemctl is-enabled "$service_name" 2>/dev/null || true)" == enabled ]] || systemctl enable "$service_name" >/dev/null
systemctl is-active --quiet "$service_name" || systemctl start "$service_name"

probe_id="$(printf '%064d' 0)"
probe_path="/mcp/screenshot/$probe_id"
expected_probe='{"error":"Screenshot download not found or expired."}'

local_probe="$(curl -sS --max-time 5 "http://127.0.0.1:8787$probe_path" 2>/dev/null || true)"
[[ "$local_probe" == "$expected_probe" ]] || {
  echo "ONSHAPE_SCREENSHOT_LOCAL_ROUTE_FAILED body='$local_probe'" >&2
  exit 1
}

public_probe=''
for _ in $(seq 1 20); do
  public_probe="$(curl -sS --max-time 5 "https://cf-onshape.duckdns.org$probe_path" 2>/dev/null || true)"
  [[ "$public_probe" == "$expected_probe" ]] && break
  sleep 1
done
if [[ "$public_probe" != "$expected_probe" ]]; then
  echo "ONSHAPE_SCREENSHOT_PUBLIC_ROUTE_FAILED body='$public_probe'" >&2
  exit 1
fi
printf 'ONSHAPE_SCREENSHOT_PUBLIC_ROUTE=pass\n'

printf 'ONSHAPE_DIRECT_HEALTH=pass\n'
printf 'ONSHAPE_DIRECT_NODE_TESTS=pass\n'
printf 'ONSHAPE_SINGLE_SESSION=pass\n'
printf 'ONSHAPE_LOOPBACK_ONLY=pass\n'
