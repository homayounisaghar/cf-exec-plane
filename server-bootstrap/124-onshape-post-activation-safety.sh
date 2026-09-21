#!/usr/bin/env bash
set -euo pipefail
umask 077
[[ "$(id -u)" -eq 0 ]] || exit 2

active=/opt/capability-fabric/current
control=/var/lib/capability-fabric/onshape/runtime-control/ONSHAPE_RUNTIME_CONTROL.json
db=/var/lib/capability-fabric/onshape/fabric-state/execution.sqlite3
q=/var/lib/capability-fabric/onshape/fabric-state/quarantine/D-018-attempt-f6d80f46.json
guard=/usr/local/libexec/capability-fabric-onshape-rollback-contract
gate=/var/lib/capability-fabric/state/release-in-progress

[[ -x "$guard" && -s "$db" && -s "$q" && -s "$control" && ! -e "$gate" ]] || exit 20
python3 - "$active/manifest.json" "$control" <<'PY'
import json,sys
m=json.load(open(sys.argv[1])); r=json.load(open(sys.argv[2])); a=r["authority"]
assert m["sequence"]==66 and m["release_id"]=="onshape-vps-hardened-production-r3"
assert r["controlRevision"]==530 and a["productionEpoch"]==2
assert a["mode"]=="QUIESCED_RECONCILING" and a["materialAuthority"] is None
assert a["planes"]["android-v1"]["materialEffectsAllowed"] is False
assert a["planes"]["vps-fabric"]["materialEffectsAllowed"] is False
print("CF_POSTACT_BASELINE=seq66-quiesced-epoch2")
PY
out="$(python3 "$guard" decide --db "$db" --control "$control" --quarantine "$q")"
printf '%s\n' "$out"
printf '%s\n' "$out" | grep -Fxq 'CF_A4_PONR=false'
printf '%s\n' "$out" | grep -Fxq 'CF_A4_PONR_COUNT=0'
printf '%s\n' "$out" | grep -Fxq 'CF_A4_UNRESOLVED_BLOCKING=0'
printf '%s\n' "$out" | grep -Fxq 'CF_A4_ZERO_UNRESOLVED=pass'
echo CF_POSTACT_PONR=false
echo CF_POSTACT_EFFECTIVE_UNRESOLVED=0
echo CF_POSTACT=pass
