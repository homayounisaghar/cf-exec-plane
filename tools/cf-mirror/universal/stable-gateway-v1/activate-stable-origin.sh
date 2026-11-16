#!/usr/bin/env bash
# Gate automatic stable-origin web mode on real Worker->VPC->broker readiness.
set -euo pipefail
umask 077
BASE=https://cf-mirror-bridge.mirkazem-design.workers.dev
STATE="$HOME/.cache/cf-mirror-universal"
mkdir -p "$STATE"
test "$(curl -fsS --max-time 5 http://127.0.0.1:6266/__stable-health)" = CFM_STABLE_GATEWAY_READY_v1
H=$(curl -fsS --max-time 12 "$BASE/__bridge-health")
node -e 'const h=JSON.parse(process.argv[1]);if(h.ok!==true||h.version!=="cfm-stable-multisession-v1"||h.private_reachable!==true||h.stable_origin!=="https://cf-mirror-bridge.mirkazem-design.workers.dev")process.exit(1)' "$H" || { echo 'CFM_STABLE_NOT_READY: public Worker/VPC/private broker health failed'; exit 2; }
T=$(mktemp "$STATE/.stable-vpc-ready.XXXXXXXX")
printf 'Validated Workers VPC link: %s\n' "$(date -u -Iseconds)" > "$T"
chmod 600 "$T"
mv -f "$T" "$STATE/stable-vpc-ready"
echo 'CFM_STABLE_ORIGIN_ACTIVATED: future web mirrors use fixed workers.dev hostname with per-session paths'
