#!/usr/bin/env bash
set -euo pipefail
umask 077
[[ "$(id -u)" -eq 0 ]] || exit 2
active=/opt/capability-fabric/current
candidate=/var/lib/capability-fabric/releases/onshape-vps-hardened-production-r3
control=/var/lib/capability-fabric/onshape/runtime-control/ONSHAPE_RUNTIME_CONTROL.json
gate=/var/lib/capability-fabric/state/release-in-progress
[[ -d "$candidate" && -s "$control" ]] || exit 20
[[ ! -e "$gate" ]] || exit 20
python3 - "$control" <<'PY'
import json,sys
r=json.load(open(sys.argv[1])); a=r['authority']
assert a['productionEpoch']==2
assert a['mode']=='QUIESCED_RECONCILING'
assert a['materialAuthority'] is None
assert a['planes']['android-v1']['materialEffectsAllowed'] is False
assert a['planes']['vps-fabric']['materialEffectsAllowed'] is False
assert r['lease']['state']=='FREE'
print('CF_ACTIVATE_PRECONDITION=pass')
PY
ln -sfn "$candidate" "$active.new"
mv -Tf "$active.new" "$active"
echo CF_SEQ66_ACTIVE=pass
echo CF_SEQ66_AUTHORITY_UNCHANGED=quiesced
