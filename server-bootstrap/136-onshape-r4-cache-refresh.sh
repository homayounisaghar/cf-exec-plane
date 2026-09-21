#!/usr/bin/env bash
set -euo pipefail
umask 077
[[ "$(id -u)" -eq 0 ]] || exit 2

agent=/usr/local/libexec/capability-fabric-pull-agent
active=/opt/capability-fabric/current
control=/var/lib/capability-fabric/onshape/runtime-control/ONSHAPE_RUNTIME_CONTROL.json
cache=/var/lib/capability-fabric/repo.git
expected_head=d109fd506af171a4829fdff5bbd1a3b1de07c5e9
expected_control_blob=81f73bb89c5517080a80ada3047c58c287874c50

[[ -x "$agent" && -L "$active" && -s "$control" && -d "$cache" ]] || exit 20
before_active="$(readlink -f "$active")"
before_manifest="$(sha256sum "$before_active/manifest.json" | awk '{print $1}')"
before_control="$(git hash-object "$control")"
before_seq="$(python3 - "$before_active/manifest.json" <<'PY'
import json,sys
m=json.load(open(sys.argv[1]))
assert m["sequence"]==66 and m["release_id"]=="onshape-vps-hardened-production-r3"
print(m["sequence"])
PY
)"
[[ "$before_control" == "$expected_control_blob" ]]
[[ "$before_seq" == 66 ]]

out="$("$agent" pull 2>&1)"
printf '%s
' "$out"
printf '%s
' "$out" | grep -Fxq 'CF_PULL_NO_CHANGE'

after_active="$(readlink -f "$active")"
after_manifest="$(sha256sum "$after_active/manifest.json" | awk '{print $1}')"
after_control="$(git hash-object "$control")"
cache_head="$(git --git-dir="$cache" rev-parse refs/remotes/origin/main)"

[[ "$after_active" == "$before_active" ]]
[[ "$after_manifest" == "$before_manifest" ]]
[[ "$after_control" == "$before_control" ]]
[[ "$cache_head" == "$expected_head" ]]

echo CF_R4_CACHE_REFRESH_ACTIVE_RELEASE=seq66
echo CF_R4_CACHE_REFRESH_ACTIVE_UNCHANGED=yes
echo CF_R4_CACHE_REFRESH_CONTROL_UNCHANGED=yes
echo CF_R4_CACHE_REFRESH_HEAD="$cache_head"
echo CF_R4_CACHE_REFRESH=pass
