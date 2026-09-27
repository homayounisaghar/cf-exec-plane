#!/usr/bin/env bash
set -euo pipefail
umask 077
[[ "$(id -u)" -eq 0 ]] || exit 2

candidate="8a2ab17b2212c2fbad5afa49057d9878fab25b3f"
manifest_rel="server-deploy/candidates/onshape-vps-hardened-production-r9/manifest.json"
cache="/var/lib/capability-fabric/repo.git"
git_home="/var/lib/capability-fabric/agent-home"
token="/etc/capability-fabric/secrets/repo-read-token"
trust="/etc/capability-fabric/trust/deploy-signing.pub"
active="/opt/capability-fabric/current"
state="/var/lib/capability-fabric/state"
control="/var/lib/capability-fabric/onshape/runtime-control/ONSHAPE_RUNTIME_CONTROL.json"
gate="$state/release-in-progress"

[[ -d "$cache" && -s "$token" && -s "$trust" ]] || exit 20
[[ ! -e "$gate" ]] || { echo CF_POOL_R9_PREFLIGHT_GATE=present; exit 21; }
[[ "$(basename "$(readlink -f "$active")")" == "onshape-vps-hardened-production-r8" ]]
[[ "$(cat "$state/last-good-sequence")" == "73" ]]
[[ "$(cat "$state/last-good-release")" == "onshape-vps-hardened-production-r8" ]]
[[ ! -s "$state/last-failed-commit" ]]
echo CF_POOL_R9_PREFLIGHT_ACTIVE=seq73-r8

python3 - "$control" <<'PY'
import json,sys
d=json.load(open(sys.argv[1])); a=d["authority"]; g=a["productionGuard"]
assert d["controlRevision"]==556 and a["productionEpoch"]==27
assert d["lease"]["state"]=="FREE"
assert a["mode"]=="VPS_PRODUCTION" and a["materialAuthority"]=="vps-fabric"
assert a["planes"]["vps-fabric"]["ingress"]=="ADMITTED"
assert a["planes"]["vps-fabric"]["materialEffectsAllowed"] is True
assert a["planes"]["vps-fabric"]["releaseSequence"]==73
assert a["planes"]["vps-fabric"]["releaseId"]=="onshape-vps-hardened-production-r8"
assert a["reconciliationHold"]["active"] is False
assert g["generation"]==11 and g["killSwitch"]=="ENGAGED"
assert g["allowedDocumentIds"]==[]
assert g["mutationBudget"]["maxMutations"]==0
print("CF_POOL_R9_PREFLIGHT_AUTHORITY=epoch27-r8-guard-closed")
PY

for c in capability-fabric-onshape-server capability-fabric-onshape-fabric capability-fabric-onshape-gateway; do
  [[ "$(docker inspect -f '{{.State.Running}}' "$c" 2>/dev/null || echo false)" == true ]]
  [[ "$(docker inspect -f '{{.State.Health.Status}}' "$c" 2>/dev/null || echo bad)" == healthy ]]
done
systemctl is-active --quiet capability-fabric-pull.timer
echo CF_POOL_R9_PREFLIGHT_SERVICES=healthy

prod="$(docker exec -i capability-fabric-onshape-server sh -lc 'cd /tmp/app && node --input-type=module' <<'NODE'
import fs from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
const token=fs.readFileSync("/run/secrets/mcp-token","utf8").trim();
const c=new Client({name:"cf-pool-r9-precutover",version:"1.0"});
await c.connect(new StreamableHTTPClientTransport(new URL("http://127.0.0.1:8788/mcp/"+token)));
const r=await c.callTool({name:"onshape_pool_status",arguments:{}},undefined,{timeout:180000});
console.log((r.content||[]).filter(x=>x.type==="text").map(x=>x.text||"").join("\n"));
await c.close().catch(()=>{});
NODE
)"
python3 - "$prod" <<'PY'
import json,sys
p=json.loads(sys.argv[1])
assert p["build_id"]=="onshape-vps-hardened-r8"
assert p["pool_enabled"] is True and p["size"]==3
assert p["active_count"]==0 and p["queued_count"]==0 and p["document_lock_count"]==0
assert p["session_fingerprints_distinct"] is True
ss=p["sessions"]; assert len(ss)==3
assert all(x["auth"]["state"]=="PROVEN" and x["auth"]["http_status"]==200 for x in ss)
print("CF_POOL_R9_PREFLIGHT_POOL=3of3-PROVEN-idle")
PY

PYTHONPATH="$active/fabric-src" python3 - "$active/fabric-src" <<'PY'
import sys
from capability_fabric.persistence import SqliteExecutionStateStore
with SqliteExecutionStateStore("/var/lib/capability-fabric/onshape/fabric-state/execution.sqlite3") as s:
    assert not s.recoverable()
print("CF_POOL_R9_PREFLIGHT_RECOVERABLE=zero")
PY

tmp="$(mktemp -d /root/.cf-pool-r9-preflight.XXXXXX)"
trap 'rm -rf "$tmp"' EXIT
ask="$tmp/askpass"
cat >"$ask" <<'ASK'
#!/usr/bin/env bash
case "${1:-}" in
  *Username*) printf '%s\n' x-access-token ;;
  *Password*) cat /etc/capability-fabric/secrets/repo-read-token ;;
  *) exit 1 ;;
esac
ASK
chmod 0700 "$ask"
GIT_ASKPASS="$ask" GIT_TERMINAL_PROMPT=0 HOME="$git_home" git --git-dir="$cache" fetch --quiet --force --depth=1 origin "$candidate"
[[ "$(git --git-dir="$cache" rev-parse FETCH_HEAD)" == "$candidate" ]]
git --git-dir="$cache" show "$candidate:$manifest_rel" > "$tmp/manifest.json"
python3 - "$tmp/manifest.json" <<'PY'
import json,sys
m=json.load(open(sys.argv[1]))
assert m["sequence"]==74
assert m["release_id"]=="onshape-vps-hardened-r9"
assert m["schema"]=="capability-fabric.deploy.v1"
print("CF_POOL_R9_PREFLIGHT_CANDIDATE_ID=seq74-r9")
PY

python3 - "$tmp/manifest.json" "$tmp/files" <<'PY'
import json,sys
m=json.load(open(sys.argv[1]))
with open(sys.argv[2],"w") as f:
    for p,h in sorted(m["files"].items()): f.write(p+"\t"+h+"\n")
PY
while IFS=$'\t' read -r rel expected; do
  actual="$(git --git-dir="$cache" show "$candidate:server-deploy/current/$rel" | sha256sum | awk '{print $1}')"
  [[ "$actual" == "$expected" ]] || { echo "hash mismatch $rel" >&2; exit 30; }
done < "$tmp/files"
echo CF_POOL_R9_PREFLIGHT_FILE_CLOSURE=pass

manifest_sha="$(sha256sum "$tmp/manifest.json" | awk '{print $1}')"
echo "CF_POOL_R9_PREFLIGHT_MANIFEST_SHA256=$manifest_sha"
echo "CF_POOL_R9_PREFLIGHT_MANIFEST_SHA256_A=${manifest_sha:0:16}"
echo "CF_POOL_R9_PREFLIGHT_MANIFEST_SHA256_B=${manifest_sha:16:16}"
echo "CF_POOL_R9_PREFLIGHT_MANIFEST_SHA256_C=${manifest_sha:32:16}"
echo "CF_POOL_R9_PREFLIGHT_MANIFEST_SHA256_D=${manifest_sha:48:16}"
echo "CF_POOL_R9_PREFLIGHT_MANIFEST_SHA256_D1=${manifest_sha:48:8}"
echo "CF_POOL_R9_PREFLIGHT_MANIFEST_SHA256_D2=${manifest_sha:56:8}"
echo "CF_POOL_R9_PREFLIGHT_MANIFEST_SHA256_D1A=${manifest_sha:48:4}"
echo "CF_POOL_R9_PREFLIGHT_MANIFEST_SHA256_D1B=${manifest_sha:52:4}"
sig="/var/lib/capability-fabric/signatures/$manifest_sha.sig"
[[ -s "$sig" ]]
printf '%s %s\n' capability-fabric-deploy "$(cat "$trust")" > "$tmp/allowed_signers"
ssh-keygen -Y verify -f "$tmp/allowed_signers" -I capability-fabric-deploy -n capability-fabric-deploy -s "$sig" < "$tmp/manifest.json" >/dev/null
echo CF_POOL_R9_PREFLIGHT_SIGNATURE=valid
echo CF_POOL_R9_PREFLIGHT_READY_FOR_AUTHORIZATION=pass
