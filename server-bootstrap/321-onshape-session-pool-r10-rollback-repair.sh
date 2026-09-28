#!/usr/bin/env bash
set -euo pipefail
umask 077
[[ "$(id -u)" -eq 0 ]] || exit 2

ACTIVE=/opt/capability-fabric/current
PREVIOUS=/opt/capability-fabric/previous
STATE=/var/lib/capability-fabric/state
CONTROL=/var/lib/capability-fabric/onshape/runtime-control/ONSHAPE_RUNTIME_CONTROL.json
LEASES=/var/lib/capability-fabric/onshape/fabric-agent/workflow-leases.json
GATE="$STATE/release-in-progress"
SERVER=capability-fabric-onshape-server
FABRIC=capability-fabric-onshape-fabric
GATEWAY=capability-fabric-onshape-gateway

[[ "$(basename "$(readlink -f "$ACTIVE")")" == "onshape-vps-hardened-r9" ]]
[[ "$(basename "$(readlink -f "$PREVIOUS")")" == "onshape-vps-hardened-r9" ]]
[[ "$(cat "$STATE/last-good-sequence")" == "74" ]]
[[ "$(cat "$STATE/last-good-release")" == "onshape-vps-hardened-r9" ]]
[[ "$(cat "$STATE/last-failed-commit")" == "51a6076cb5a6bcb3abfc77904749f4c5fb02a714" ]]
[[ -f "$GATE" ]] && grep -Fxq RELEASE_IN_PROGRESS "$GATE"
! systemctl is-active --quiet capability-fabric-pull.timer
! systemctl is-active --quiet capability-fabric-pull.service
[[ "$(docker inspect -f '{{.State.Running}}' "$GATEWAY" 2>/dev/null || echo false)" == false ]]
server_log="$(docker logs --tail 160 "$SERVER" 2>&1 || true)"
grep -Fq POOL_LEASE_STATE_INVALID <<<"$server_log"

python3 - "$CONTROL" <<'PY'
import json,sys
d=json.load(open(sys.argv[1])); a=d["authority"]; v=a["planes"]["vps-fabric"]; g=a["productionGuard"]
assert d["controlRevision"]==559 and a["productionEpoch"]==30
assert a["mode"]=="QUIESCED_RECONCILING" and a["materialAuthority"] is None
assert v["ingress"]=="CLOSED" and v["materialEffectsAllowed"] is False
assert v["releaseSequence"]==75 and v["releaseId"]=="onshape-vps-hardened-r10"
assert g["killSwitch"]=="ENGAGED" and g["allowedDocumentIds"]==[]
assert g["mutationBudget"]["maxMutations"]==0
PY

docker stop -t 10 "$SERVER" >/dev/null 2>&1 || true
python3 - "$LEASES" <<'PY'
import hashlib,json,os,sys
p=sys.argv[1]
raw=open(p,"rb").read()
d=json.loads(raw)
assert d.get("schema")=="capability-fabric.onshape-api-leases.v3"
assert d.get("leases")==[]
digest=hashlib.sha256(raw).hexdigest()
archive=p+".failed-r10-v3-"+digest
if os.path.exists(archive):
    assert open(archive,"rb").read()==raw
else:
    fd=os.open(archive,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
    with os.fdopen(fd,"wb") as f:
        f.write(raw); f.flush(); os.fsync(f.fileno())
payload={"schema":"capability-fabric.onshape-session-leases.v2","updated_at":d.get("updated_at"),"leases":[]}
tmp=p+".rollback-repair-"+str(os.getpid())
fd=os.open(tmp,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
with os.fdopen(fd,"w",encoding="utf-8") as f:
    json.dump(payload,f,indent=2); f.write("\n"); f.flush(); os.fsync(f.fileno())
os.replace(tmp,p)
os.chmod(p,0o600)
print("CF_R10_ROLLBACK_LEASE_STATE=v2-empty")
PY

docker start "$SERVER" >/dev/null
for _ in $(seq 1 120); do
  [[ "$(docker inspect -f '{{.State.Health.Status}}' "$SERVER" 2>/dev/null || echo starting)" == healthy ]] && break
  sleep 1
done
[[ "$(docker inspect -f '{{.State.Running}}' "$SERVER")" == true ]]
[[ "$(docker inspect -f '{{.State.Health.Status}}' "$SERVER")" == healthy ]]

docker start "$FABRIC" >/dev/null
for _ in $(seq 1 60); do
  [[ "$(docker inspect -f '{{.State.Health.Status}}' "$FABRIC" 2>/dev/null || echo starting)" == healthy ]] && break
  sleep 1
done
[[ "$(docker inspect -f '{{.State.Running}}' "$FABRIC")" == true ]]
[[ "$(docker inspect -f '{{.State.Health.Status}}' "$FABRIC")" == healthy ]]

failed_archive="$STATE/last-failed-commit.r10-rollback-repaired"
if [[ -e "$failed_archive" ]]; then
  cmp -s "$STATE/last-failed-commit" "$failed_archive"
else
  cp -a "$STATE/last-failed-commit" "$failed_archive"
fi
install -m 0600 -o root -g root /dev/null "$STATE/last-failed-commit"

[[ "$(basename "$(readlink -f "$ACTIVE")")" == "onshape-vps-hardened-r9" ]]
[[ ! -s "$STATE/last-failed-commit" ]]
[[ "$(docker inspect -f '{{.State.Running}}' "$GATEWAY")" == false ]]
[[ -f "$GATE" ]] && grep -Fxq RELEASE_IN_PROGRESS "$GATE"
! systemctl is-active --quiet capability-fabric-pull.timer
echo CF_R10_ROLLBACK_R9=healthy
echo CF_R10_ROLLBACK_GATE=closed
echo CF_R10_ROLLBACK_REPAIR=pass
