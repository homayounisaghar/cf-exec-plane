#!/usr/bin/env bash
set -euo pipefail
umask 077
[[ "$(id -u)" -eq 0 ]] || exit 2
active=/opt/capability-fabric/current
release="$(readlink -f "$active")"
[[ -s "$release/manifest.json" ]] || exit 20
python3 - "$release/manifest.json" <<'PY'
import json,sys
m=json.load(open(sys.argv[1]))
assert m['sequence']==66
assert m['release_id']=='onshape-vps-hardened-production-r3'
print('CF_SEQ66_IDENTITY=pass')
PY
# Qualification-only: no authority switch, no material mutation.
# Verify current runtime remains non-authoritative and smoke semantic path only.
grep -Eq 'CF_FABRIC_QUALIFICATION_MODE:[[:space:]]*"0"' "$release/compose.yaml"
grep -Eq 'CF_PUBLIC_SURFACE:[[:space:]]*semantic-only' "$release/compose.yaml"
echo CF_SEQ66_FINAL_QUALIFICATION_BOUNDARY=pass
