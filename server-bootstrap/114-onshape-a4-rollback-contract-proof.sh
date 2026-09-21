#!/usr/bin/env bash
set -euo pipefail
umask 077

[[ "$(id -u)" -eq 0 ]] || { echo CF_A4_LIVE_REQUIRES_ROOT >&2; exit 2; }

active=/opt/capability-fabric/current
previous=/opt/capability-fabric/previous
release_root=/var/lib/capability-fabric/releases
rollback="$release_root/onshape-vps-hardened-rollback-r1"
production="$release_root/onshape-vps-hardened-production-r2"
trust=/etc/capability-fabric/trust/deploy-signing.pub
db=/var/lib/capability-fabric/onshape/fabric-state/execution.sqlite3
control=/var/lib/capability-fabric/onshape/runtime-control/ONSHAPE_RUNTIME_CONTROL.json
quarantine=/var/lib/capability-fabric/onshape/fabric-state/quarantine/D-018-attempt-f6d80f46.json
guard_src=server-bootstrap/pull-agent/onshape_rollback_contract.py
guard=/usr/local/libexec/capability-fabric-onshape-rollback-contract
gate=/var/lib/capability-fabric/state/release-in-progress

[[ -L "$active" && -d "$rollback" && -d "$production" && -s "$trust" && -s "$db" && -s "$control" && -s "$quarantine" ]] || exit 20
[[ ! -e "$gate" ]] || { echo CF_A4_RELEASE_GATE=active >&2; exit 20; }

active_before="$(readlink -f "$active")"
previous_before="$(readlink -f "$previous" 2>/dev/null || true)"
control_sha_before="$(sha256sum "$control" | awk '{print $1}')"

python3 - "$rollback/manifest.json" "$production/manifest.json" <<'PY'
import json,sys
r=json.load(open(sys.argv[1])); p=json.load(open(sys.argv[2]))
assert r["sequence"]==63 and r["release_id"]=="onshape-vps-hardened-rollback-r1",r
assert p["sequence"]==65 and p["release_id"]=="onshape-vps-hardened-production-r2",p
print("CF_A4_ROLLBACK_ARTIFACT_SEQUENCE=63")
print("CF_A4_PRODUCTION_ARTIFACT_SEQUENCE=65")
PY
[[ "$active_before" == "$rollback" ]] || { echo CF_A4_ACTIVE_NOT_SEQ63 >&2; exit 21; }

verify_release() {
  local dir="$1" label="$2" work manifest_sha sig pub
  work="$(mktemp -d /var/lib/capability-fabric/.a4verify.XXXXXX)"
  manifest_sha="$(sha256sum "$dir/manifest.json" | awk '{print $1}')"
  sig="/var/lib/capability-fabric/signatures/$manifest_sha.sig"
  [[ -s "$sig" ]] || { rm -rf "$work"; return 1; }
  pub="$(tr -d '\r\n' < "$trust")"
  printf 'capability-fabric-deploy %s\n' "$pub" >"$work/allowed"
  ssh-keygen -Y verify -f "$work/allowed" -I capability-fabric-deploy -n capability-fabric-deploy -s "$sig" <"$dir/manifest.json" >/dev/null 2>&1
  python3 - "$dir/manifest.json" "$dir" <<'PY'
import hashlib,json,os,sys
m=json.load(open(sys.argv[1])); root=sys.argv[2]
for rel,expected in m["files"].items():
    p=os.path.join(root,rel)
    assert os.path.isfile(p),rel
    actual=hashlib.sha256(open(p,"rb").read()).hexdigest()
    assert actual==expected,(rel,actual,expected)
PY
  echo "CF_A4_${label}_MANIFEST_SHA256=$manifest_sha"
  echo "CF_A4_${label}_SIGNATURE=pass"
  echo "CF_A4_${label}_FILE_CLOSURE=pass"
  rm -rf "$work"
}
verify_release "$rollback" ROLLBACK
verify_release "$production" PRODUCTION

python3 - "$control" <<'PY'
import json,sys
r=json.load(open(sys.argv[1])); a=r["authority"]
assert r["controlRevision"]==529
assert r["lease"]["state"]=="FREE"
assert a["productionEpoch"]==1
assert a["mode"]=="ANDROID_PRODUCTION"
assert a["materialAuthority"]=="android-v1"
assert a["planes"]["android-v1"]["materialEffectsAllowed"] is True
assert a["planes"]["vps-fabric"]["materialEffectsAllowed"] is False
print("CF_A4_AUTHORITY_BASELINE=android-epoch1")
PY

install -m 0750 -o root -g root "$guard_src" "$guard"
echo "CF_A4_GUARD_SHA256=$(sha256sum "$guard" | awk '{print $1}')"
echo CF_A4_GUARD_INSTALL=pass

python3 "$guard" decide --db "$db" --control "$control" --quarantine "$quarantine"

active_after="$(readlink -f "$active")"
previous_after="$(readlink -f "$previous" 2>/dev/null || true)"
control_sha_after="$(sha256sum "$control" | awk '{print $1}')"
[[ "$active_after" == "$active_before" ]] || { echo CF_A4_ACTIVE_POINTER=changed >&2; exit 22; }
[[ "$previous_after" == "$previous_before" ]] || { echo CF_A4_PREVIOUS_POINTER=changed >&2; exit 22; }
[[ "$control_sha_after" == "$control_sha_before" ]] || { echo CF_A4_CONTROL=changed >&2; exit 22; }
[[ ! -e "$gate" ]] || { echo CF_A4_RELEASE_GATE=changed >&2; exit 22; }

echo CF_A4_PREMUTATION_ROLLBACK_ARTIFACT=already-installed-signed-seq63
echo CF_A4_NEW_BUILD_REQUIRED=false
echo CF_A4_NEW_SIGNATURE_REQUIRED=false
echo CF_A4_ACTIVE_POINTER=unchanged
echo CF_A4_PREVIOUS_POINTER=unchanged
echo CF_A4_CONTROL=unchanged
echo CF_A4_LIVE_PROOF=pass
