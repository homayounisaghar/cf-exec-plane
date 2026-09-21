#!/usr/bin/env bash
set -euo pipefail
umask 077

[[ "$(id -u)" -eq 0 ]] || { echo CF_A5_REQUIRES_ROOT >&2; exit 2; }

active=/opt/capability-fabric/current
previous=/opt/capability-fabric/previous
release_root=/var/lib/capability-fabric/releases
candidate="$release_root/onshape-vps-hardened-production-r3"
rollback="$release_root/onshape-vps-hardened-rollback-r1"
control=/var/lib/capability-fabric/onshape/runtime-control/ONSHAPE_RUNTIME_CONTROL.json
trust=/etc/capability-fabric/trust/deploy-signing.pub
gate=/var/lib/capability-fabric/state/release-in-progress
expected_sha=857b7ca6d5a6bcf79b820594801a4f88642fe9520dad1ae18fc064eae6073d7c

[[ -L "$active" && -d "$candidate" && -d "$rollback" && -s "$control" && -s "$trust" ]] || exit 20
[[ ! -e "$gate" ]] || { echo CF_A5_RELEASE_GATE=active >&2; exit 20; }

active_before="$(readlink -f "$active")"
previous_before="$(readlink -f "$previous" 2>/dev/null || true)"
control_sha_before="$(sha256sum "$control" | awk '{print $1}')"

python3 - "$active_before/manifest.json" "$control" <<'PY'
import json,sys
m=json.load(open(sys.argv[1])); r=json.load(open(sys.argv[2])); a=r["authority"]
assert m["sequence"]==63 and m["release_id"]=="onshape-vps-hardened-rollback-r1",m
assert r["controlRevision"]==529
assert r["lease"]["state"]=="FREE"
assert a["productionEpoch"]==1
assert a["mode"]=="ANDROID_PRODUCTION"
assert a["materialAuthority"]=="android-v1"
assert a["planes"]["android-v1"]["materialEffectsAllowed"] is True
assert a["planes"]["vps-fabric"]["materialEffectsAllowed"] is False
print("CF_A5_BASELINE=android-epoch1-seq63")
PY

manifest_sha="$(sha256sum "$candidate/manifest.json" | awk '{print $1}')"
[[ "$manifest_sha" == "$expected_sha" ]] || { echo CF_A5_MANIFEST_SHA=mismatch >&2; exit 21; }
sig="/var/lib/capability-fabric/signatures/$manifest_sha.sig"
[[ -s "$sig" ]] || { echo CF_A5_SIGNATURE=missing >&2; exit 21; }
work="$(mktemp -d /var/lib/capability-fabric/.a5.XXXXXX)"
trap 'rm -rf "$work"' EXIT
printf 'capability-fabric-deploy %s\n' "$(tr -d '\r\n' < "$trust")" >"$work/allowed"
ssh-keygen -Y verify -f "$work/allowed" -I capability-fabric-deploy -n capability-fabric-deploy -s "$sig" <"$candidate/manifest.json" >/dev/null 2>&1
echo "CF_A5_MANIFEST_SHA256=$manifest_sha"
echo CF_A5_SIGNATURE=pass

python3 - "$candidate/manifest.json" "$candidate" "$work/images" <<'PY'
import hashlib,json,os,re,sys
mp,root,out=sys.argv[1:4]
m=json.load(open(mp))
assert m["schema"]=="capability-fabric.deploy.v1"
assert m["sequence"]==66
assert m["release_id"]=="onshape-vps-hardened-production-r3"
for rel,expected in m["files"].items():
    p=os.path.join(root,rel)
    assert os.path.isfile(p),rel
    actual=hashlib.sha256(open(p,"rb").read()).hexdigest()
    assert actual==expected,(rel,actual,expected)
assert m["images"] and all(re.fullmatch(r"[^\s]+@sha256:[0-9a-f]{64}",x) for x in m["images"])
open(out,"w").write("\n".join(sorted(m["images"]))+"\n")
print("CF_A5_FILE_HASH_CLOSURE=pass")
print("CF_A5_IMAGE_DIGEST_PINNING=pass")
print("CF_A5_MANIFEST_FILE_COUNT="+str(len(m["files"])))
PY

grep -Fq '"build_id": "onshape-vps-hardened-r3"' "$candidate/release-closure.json"
grep -Fq 'const BUILD_ID = "onshape-vps-hardened-r3";' "$candidate/server.js"
echo CF_A5_BUILD_ID=onshape-vps-hardened-r3
echo CF_A5_BUILD_ID_EXPLICIT=pass

! grep -Eq '\$\{[^}]+\}' "$candidate/compose.yaml"
! grep -Eq '^[[:space:]]*env_file[[:space:]]*:' "$candidate/compose.yaml"
docker compose -f "$candidate/compose.yaml" config --format json >"$work/compose.json"
python3 - "$work/compose.json" "$work/images" <<'PY'
import json,sys
c=json.load(open(sys.argv[1])); services=c["services"]
expected=sorted(x.strip() for x in open(sys.argv[2]) if x.strip())
actual=sorted({v.get("image") for v in services.values() if v.get("image")})
assert actual==expected,(actual,expected)
server=services["onshape_server"]; side=services["fabric_sidecar"]
def env(s):
    v=s.get("environment") or {}
    return {str(k):str(x) for k,x in v.items()} if isinstance(v,dict) else dict(x.split("=",1) for x in v)
se=env(server); fe=env(side)
assert se["CF_PUBLIC_SURFACE"]=="semantic-only"
assert se["CF_FABRIC_REQUIRE_PRODUCTION_AUTHORITY"]=="1"
assert se["CF_PRIVILEGED_NATIVE_ENABLED"]=="0"
assert fe["CF_FABRIC_REQUIRE_PRODUCTION_AUTHORITY"]=="1"
assert fe["CF_FABRIC_QUALIFICATION_MODE"]=="0"
print("CF_A5_SIGNED_CONFIG_IDENTITY=pass")
PY
echo CF_A5_COMPOSE_INTERPOLATION=absent
echo CF_A5_ENV_FILE=absent

# A5 UI gate: production source keeps mutation-risk UI capabilities out until
# the per-step durable journal + postcondition contract is separately qualified.
grep -Fq 'if not self.require_material_authority:' "$candidate/fabric-src/capability_fabric/onshape_vps.py"
grep -Fq 'UI input mutation-risk capability is not admitted on initial production surface' "$candidate/fabric-src/capability_fabric/onshape_vps.py"
grep -Fq 'native browser capability is not admitted on production surface' "$candidate/fabric-src/capability_fabric/onshape_vps.py"
PYTHONPATH="$candidate/fabric-src" python3 -m unittest   "$candidate/fabric-tests/test_onshape_vps_runtime.py" >/dev/null
echo CF_A5_UI_EFFECTFUL_PRODUCTION_CLOSED=pass
echo CF_A5_UI_STEP_JOURNAL_QUALIFIED=false

# Same-session production mutation contract/readback is explicit in the signed artifact.
grep -Fq '"sameSessionRequired": True' "$candidate/fabric-src/capability_fabric/onshape_vps.py"
grep -Fq 'observationSpec.sameSessionRequired !== true' "$candidate/fabric-agent.js"
grep -Fq 'requestOnSession' "$candidate/fabric-agent.js"
grep -Fq 'requestOnSession' "$candidate/core.js"
grep -Fq 'requestOnSession' "$candidate/session-pool.js"
grep -Fq 'mutationSessionId !== "session-1"' "$candidate/fabric-agent.js"
echo CF_A5_SAME_SESSION_READBACK_CONTRACT=pass
echo CF_A5_MUTATOR_SESSION=session-1

# Re-auth implementation remains bounded and does not delete the persistent profile.
grep -Fq 'async reauthenticateSession(sessionId' "$candidate/session-pool.js"
grep -Fq 'this.enabled = false' "$candidate/session-pool.js"
grep -Fq 'async establishSessionFromFreshProfile(account, password)' "$candidate/browser.js"
grep -Fq 'const tempProfile = ' "$candidate/browser.js"
grep -Fq 'await this.context.clearCookies();' "$candidate/browser.js"
grep -Fq 'await this.context.addCookies(cadCookies);' "$candidate/browser.js"
if grep -Eq 'rmSync\((this\.)?profileDir' "$candidate/browser.js" "$candidate/session-pool.js"; then
  echo CF_A5_REAUTH_PROFILE_DELETE=detected >&2
  exit 22
fi
echo CF_A5_REAUTH_PERSISTENT_PROFILE_DELETE=absent
echo CF_A5_REAUTH_SOURCE_CONTRACT=pass

# Fresh read-only live health of the currently active three-session cohort.
container=capability-fabric-onshape-server
token="$(tr -d '\r\n' < /etc/capability-fabric/secrets/mcp-token)"
docker exec -i "$container" sh -lc 'cd /tmp/app && node --input-type=module' >"$work/pool.json" <<'NODE'
import fs from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
const token=fs.readFileSync("/run/secrets/mcp-token","utf8").trim();
const client=new Client({name:"cf-a5-pool-proof",version:"1.0.0"});
const transport=new StreamableHTTPClientTransport(new URL("http://127.0.0.1:8788/mcp/"+token));
await client.connect(transport);
const res=await client.callTool({name:"onshape_pool_status",arguments:{}});
const text=res.content.filter(x=>x.type==="text").map(x=>x.text||"").join("\n");
process.stdout.write(text);
await client.close();
NODE
python3 - "$work/pool.json" <<'PY'
import json,sys
v=json.load(open(sys.argv[1]))
assert v.get("pool_enabled") is True,v
assert v.get("size")==3,v
assert v.get("material_mutator_session_id")=="session-1",v
assert v.get("production_material_requires_qualified_pool") is True,v
assert v.get("warming") is False,v
assert v.get("active_count")==0,v
assert v.get("queued_count")==0,v
sessions=v.get("sessions")
assert isinstance(sessions,list) and len(sessions)==3,v
ids={x.get("session_id") for x in sessions}
assert ids=={"session-1","session-2","session-3"},ids
for x in sessions:
    auth=x.get("auth") or {}
    assert auth.get("state")=="PROVEN",(x.get("session_id"),auth)
print("CF_A5_LIVE_POOL_SIZE=3")
print("CF_A5_LIVE_POOL_AUTH=3-of-3-PROVEN")
print("CF_A5_LIVE_POOL_IDLE=pass")
PY

# Rollback release must remain pre-built and signed.
rb_sha="$(sha256sum "$rollback/manifest.json" | awk '{print $1}')"
rb_sig="/var/lib/capability-fabric/signatures/$rb_sha.sig"
[[ -s "$rb_sig" ]] || exit 23
ssh-keygen -Y verify -f "$work/allowed" -I capability-fabric-deploy -n capability-fabric-deploy -s "$rb_sig" <"$rollback/manifest.json" >/dev/null 2>&1
python3 - "$rollback/manifest.json" <<'PY'
import json,sys
m=json.load(open(sys.argv[1]))
assert m["sequence"]==63
assert m["release_id"]=="onshape-vps-hardened-rollback-r1"
print("CF_A5_ROLLBACK_SEQUENCE=63")
PY
echo CF_A5_ROLLBACK_RETAINED=pass
echo CF_A5_ROLLBACK_SIGNATURE=pass

active_after="$(readlink -f "$active")"
previous_after="$(readlink -f "$previous" 2>/dev/null || true)"
[[ "$active_after" == "$active_before" ]] || { echo CF_A5_ACTIVE_POINTER=changed >&2; exit 24; }
[[ "$previous_after" == "$previous_before" ]] || { echo CF_A5_PREVIOUS_POINTER=changed >&2; exit 24; }
[[ "$(sha256sum "$control" | awk '{print $1}')" == "$control_sha_before" ]] || { echo CF_A5_CONTROL=changed >&2; exit 24; }
[[ ! -e "$gate" ]] || { echo CF_A5_RELEASE_GATE=changed >&2; exit 24; }
echo CF_A5_ACTIVE_POINTER=unchanged
echo CF_A5_PREVIOUS_POINTER=unchanged
echo CF_A5_RUNTIME_CONTROL=unchanged
echo CF_A5_AUTHORITY_AFTER=android-epoch1
echo CF_A5=pass
