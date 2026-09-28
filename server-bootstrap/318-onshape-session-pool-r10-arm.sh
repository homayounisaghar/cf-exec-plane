#!/usr/bin/env bash
set -euo pipefail
umask 077
[[ "$(id -u)" -eq 0 ]] || exit 2

CANDIDATE=7faa8346b1c54e3a9517592e8723793b47f8e7c8
MANIFEST_REL=server-deploy/candidates/onshape-vps-hardened-r10/manifest.json
EXPECTED_MANIFEST=50c7a75af1c575ad31c7b2d0054cf1ecf7fabd494c42c98e5eb32ab6e9ec603e
ACTIVE=/opt/capability-fabric/current
STATE=/var/lib/capability-fabric/state
CONTROL=/var/lib/capability-fabric/onshape/runtime-control/ONSHAPE_RUNTIME_CONTROL.json
GATE="$STATE/release-in-progress"
TIMER=capability-fabric-pull.timer
SERVICE=capability-fabric-pull.service
PULL=/usr/local/libexec/capability-fabric-pull-agent
GATEWAY=capability-fabric-onshape-gateway
SERVER=capability-fabric-onshape-server
CACHE=/var/lib/capability-fabric/repo.git
TOKEN=/etc/capability-fabric/secrets/repo-read-token
TRUST=/etc/capability-fabric/trust/deploy-signing.pub

[[ ! -e "$GATE" ]]
[[ "$(basename "$(readlink -f "$ACTIVE")")" == "onshape-vps-hardened-r9" ]]
[[ "$(cat "$STATE/last-good-sequence")" == "74" ]]
[[ "$(cat "$STATE/last-good-release")" == "onshape-vps-hardened-r9" ]]
[[ ! -s "$STATE/last-failed-commit" ]]

python3 - "$CONTROL" <<'PY'
import json,sys
d=json.load(open(sys.argv[1])); a=d["authority"]; v=a["planes"]["vps-fabric"]; g=a["productionGuard"]
assert d["controlRevision"]==558 and a["productionEpoch"]==29
assert a["mode"]=="VPS_PRODUCTION" and a["materialAuthority"]=="vps-fabric"
assert v["ingress"]=="ADMITTED" and v["materialEffectsAllowed"] is True
assert v["releaseSequence"]==74 and v["releaseId"]=="onshape-vps-hardened-r9"
assert v["manifestSha256"]=="5abb7ec2ba3525f3f1e3cf535323106436b42d264150fb20c911b221ef3af7a3"
assert d["lease"]["state"]=="FREE" and a["reconciliationHold"]["active"] is False
assert g["killSwitch"]=="ENGAGED" and g["allowedDocumentIds"]==[]
assert g["mutationBudget"]["maxMutations"]==0
print("CF_R10_ARM_AUTHORITY=epoch29-r9-guard-closed")
PY

for container in capability-fabric-onshape-server capability-fabric-onshape-fabric capability-fabric-onshape-gateway; do
  [[ "$(docker inspect -f '{{.State.Running}}' "$container" 2>/dev/null || echo false)" == true ]]
  [[ "$(docker inspect -f '{{.State.Health.Status}}' "$container" 2>/dev/null || echo bad)" == healthy ]]
done

pool="$(docker exec -i "$SERVER" sh -lc 'cd /tmp/app && node --input-type=module' <<'NODE'
import fs from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
const token=fs.readFileSync("/run/secrets/mcp-token","utf8").trim();
const c=new Client({name:"cf-r10-arm",version:"1.0"});
await c.connect(new StreamableHTTPClientTransport(new URL("http://127.0.0.1:8788/mcp/"+token)));
const r=await c.callTool({name:"onshape_pool_status",arguments:{}},undefined,{timeout:180000});
console.log((r.content||[]).filter(x=>x.type==="text").map(x=>x.text||"").join("\n"));
await c.close().catch(()=>{});
NODE
)"
python3 - "$pool" <<'PY'
import json,sys
p=json.loads(sys.argv[1])
assert p["build_id"]=="onshape-vps-hardened-r9"
assert p["pool_enabled"] is True and p["size"]==5
assert p["active_count"]==0 and p["queued_count"]==0 and p["document_lock_count"]==0
assert p["workflow_lease_count"]==0 and p["session_fingerprints_distinct"] is True
ss=p["sessions"]; assert len(ss)==5
assert all(x["auth"]["state"]=="PROVEN" and x["auth"]["http_status"]==200 for x in ss)
assert len({x["auth"]["account_id"] for x in ss})==1
print("CF_R10_ARM_POOL=5of5-PROVEN-idle")
PY

PYTHONPATH="$(readlink -f "$ACTIVE")/fabric-src" python3 - <<'PY'
from capability_fabric.persistence import SqliteExecutionStateStore
with SqliteExecutionStateStore("/var/lib/capability-fabric/onshape/fabric-state/execution.sqlite3") as state:
    assert not state.recoverable()
print("CF_R10_ARM_RECOVERABLE=zero")
PY

tmp="$(mktemp -d /root/.cf-r10-arm.XXXXXX)"
trap 'rm -rf "$tmp"' EXIT
cat >"$tmp/askpass" <<'ASK'
#!/usr/bin/env bash
case "${1:-}" in
  *Username*) printf '%s\n' x-access-token ;;
  *Password*) cat /etc/capability-fabric/secrets/repo-read-token ;;
  *) exit 1 ;;
esac
ASK
chmod 0700 "$tmp/askpass"
GIT_ASKPASS="$tmp/askpass" GIT_TERMINAL_PROMPT=0 HOME=/var/lib/capability-fabric/agent-home git --git-dir="$CACHE" fetch --quiet --force --depth=1 origin "$CANDIDATE"
[[ "$(git --git-dir="$CACHE" rev-parse FETCH_HEAD)" == "$CANDIDATE" ]]
git --git-dir="$CACHE" show "$CANDIDATE:$MANIFEST_REL" >"$tmp/manifest.json"
[[ "$(sha256sum "$tmp/manifest.json"|awk '{print $1}')" == "$EXPECTED_MANIFEST" ]]
python3 - "$tmp/manifest.json" "$tmp/files" <<'PY'
import json,sys
m=json.load(open(sys.argv[1])); assert m["sequence"]==75 and m["release_id"]=="onshape-vps-hardened-r10"
with open(sys.argv[2],"w") as f:
    for p,h in sorted(m["files"].items()): f.write(p+"\t"+h+"\n")
PY
while IFS=$'\t' read -r rel expected; do
  actual="$(git --git-dir="$CACHE" show "$CANDIDATE:server-deploy/current/$rel"|sha256sum|awk '{print $1}')"
  [[ "$actual" == "$expected" ]] || { echo "candidate hash mismatch: $rel" >&2; exit 30; }
done <"$tmp/files"
sig="/var/lib/capability-fabric/signatures/$EXPECTED_MANIFEST.sig"
[[ -s "$sig" ]]
printf '%s %s\n' capability-fabric-deploy "$(cat "$TRUST")" >"$tmp/allowed_signers"
ssh-keygen -Y verify -f "$tmp/allowed_signers" -I capability-fabric-deploy -n capability-fabric-deploy -s "$sig" <"$tmp/manifest.json" >/dev/null
echo CF_R10_ARM_SIGNATURE=valid

systemctl stop "$TIMER"
for _ in $(seq 1 30); do systemctl is-active --quiet "$SERVICE" || break; sleep 1; done
! systemctl is-active --quiet "$SERVICE"
out="$("$PULL" pull 2>&1 || true)"
printf '%s\n' "$out"
printf '%s\n' "$out"|grep -Eq 'CF_PULL_NO_CHANGE|CF_PULL_APPLY=success'
[[ "$(basename "$(readlink -f "$ACTIVE")")" == "onshape-vps-hardened-r9" ]]

gate_tmp="$GATE.tmp.r10-arm.$$"
printf '%s\n' RELEASE_IN_PROGRESS >"$gate_tmp"
chmod 0600 "$gate_tmp"; chown root:root "$gate_tmp"; mv -f "$gate_tmp" "$GATE"
docker stop "$GATEWAY" >/dev/null
! systemctl is-active --quiet "$TIMER"
[[ "$(docker inspect -f '{{.State.Running}}' "$GATEWAY")" == false ]]
[[ "$(docker inspect -f '{{.State.Running}}' "$SERVER")" == true ]]
echo CF_R10_ARM_GATE=active
echo CF_R10_ARM_TIMER=stopped
echo CF_R10_ARM=pass
