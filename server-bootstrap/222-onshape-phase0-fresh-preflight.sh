#!/usr/bin/env bash
set -euo pipefail
[[ "$(id -u)" -eq 0 ]] || exit 2
control=/var/lib/capability-fabric/onshape/runtime-control/ONSHAPE_RUNTIME_CONTROL.json
echo CF_PHASE0_FRESH_CONTROL_BLOB="$(git hash-object "$control")"
python3 - "$control" <<'PY'
import json,sys
d=json.load(open(sys.argv[1])); a=d["authority"]; g=a["productionGuard"]; v=a["planes"]["vps-fabric"]
assert a["mode"]=="VPS_PRODUCTION" and a["materialAuthority"]=="vps-fabric"
assert a["planes"]["android-v1"]["ingress"]=="CLOSED" and a["planes"]["android-v1"]["materialEffectsAllowed"] is False
assert a["reconciliationHold"]["active"] is False
assert v["ingress"]=="ADMITTED" and v["materialEffectsAllowed"] is True
assert g["killSwitch"]=="ENGAGED" and g["allowedDocumentIds"]==[] and g["mutationBudget"]["maxMutations"]==0
print("CF_PHASE0_FRESH_REV="+str(d["controlRevision"]))
print("CF_PHASE0_FRESH_EPOCH="+str(a["productionEpoch"]))
print("CF_PHASE0_FRESH_RELEASE_SEQ="+str(v["releaseSequence"]))
print("CF_PHASE0_FRESH_RELEASE_ID="+str(v["releaseId"]))
print("CF_PHASE0_FRESH_PROD_GUARD=failclosed")
PY
for c in capability-fabric-onshape-server capability-fabric-onshape-fabric capability-fabric-onshape-gateway capability-fabric-onshape-phase0-research capability-fabric-onshape-phase0-fabric; do
 if docker inspect "$c" >/dev/null 2>&1; then
   echo "CF_PHASE0_FRESH_CONTAINER_${c}=running:$(docker inspect -f '{{.State.Running}}' "$c"):health:$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$c")"
 else
   echo "CF_PHASE0_FRESH_CONTAINER_${c}=absent"
 fi
done
if [[ -f /var/lib/capability-fabric/state/release-in-progress ]]; then
 echo CF_PHASE0_FRESH_RELEASE_GATE=present
else
 echo CF_PHASE0_FRESH_RELEASE_GATE=absent
fi
echo CF_PHASE0_FRESH_PORTS_BEGIN
ss -lnt | awk '$4 ~ /^127\.0\.0\.1:(8787|8788|8789|8791|8898|8899|8901)$/ {print $4}' | sort
echo CF_PHASE0_FRESH_PORTS_END
if docker inspect capability-fabric-onshape-phase0-research >/dev/null 2>&1; then
 docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' capability-fabric-onshape-phase0-research | grep -E '^(CF_RESEARCH_SOURCE_COMMIT|CF_RESEARCH_FIXTURE_TARGET|CF_PUBLIC_SURFACE|CF_FABRIC_REQUIRE_PRODUCTION_AUTHORITY)='
fi
echo CF_PHASE0_FRESH_PREFLIGHT=pass
