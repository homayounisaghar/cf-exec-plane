#!/usr/bin/env bash
set -euo pipefail
umask 077
[[ "$(id -u)" -eq 0 ]] || { echo CF_A1_REQUIRES_ROOT >&2; exit 2; }

active="$(readlink -f /opt/capability-fabric/current)"
[[ "$active" == /var/lib/capability-fabric/releases/* ]] || exit 20
active_seq="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["sequence"])' "$active/manifest.json")"
[[ "$active_seq" == 63 ]] || { echo "CF_A1_ACTIVE_SEQUENCE=$active_seq" >&2; exit 20; }
echo CF_A1_ACTIVE_SEQUENCE=63

target=''
while IFS= read -r manifest; do
  seq="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("sequence",""))' "$manifest" 2>/dev/null || true)"
  rid="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("release_id",""))' "$manifest" 2>/dev/null || true)"
  if [[ "$seq" == 65 && "$rid" == onshape-vps-hardened-production-r3 ]]; then
    d="$(dirname "$manifest")"
    [[ -z "$target" ]] || { echo CF_A1_SEQ66_DUPLICATE >&2; exit 21; }
    target="$d"
  fi
done < <(find /var/lib/capability-fabric/releases -mindepth 2 -maxdepth 2 -name manifest.json -type f -print 2>/dev/null | sort)

[[ -n "$target" ]] || { echo CF_A1_SEQ66_NOT_STAGED >&2; exit 21; }
[[ "$target" != "$active" ]] || { echo CF_A1_SEQ66_ALREADY_ACTIVE >&2; exit 21; }
echo "CF_A1_SEQ66_RELEASE=$(basename "$target")"
echo CF_A1_SEQ66_UNACTIVATED=pass

manifest="$target/manifest.json"
manifest_sha="$(sha256sum "$manifest" | awk '{print $1}')"
[[ -s "$target/manifest.sha256" ]] || { echo CF_A1_MANIFEST_SHA_FILE=missing >&2; exit 22; }
declared="$(tr -d '\r\n' < "$target/manifest.sha256")"
[[ "$manifest_sha" == "$declared" ]] || { echo CF_A1_MANIFEST_SHA_MISMATCH >&2; exit 22; }
echo "CF_A1_MANIFEST_SHA256=$manifest_sha"

sig="$target/manifest.json.sig"
trust=/etc/capability-fabric/trust/deploy-signing.pub
[[ -s "$sig" && -s "$trust" ]] || { echo CF_A1_SIGNATURE_MATERIAL=missing >&2; exit 23; }
tmp="$(mktemp -d /var/lib/capability-fabric/.a1.XXXXXX)"
trap 'rm -rf "$tmp"' EXIT
pub="$(tr -d '\r\n' < "$trust")"
printf 'capability-fabric-deploy %s\n' "$pub" > "$tmp/allowed"
ssh-keygen -Y verify -f "$tmp/allowed" -I capability-fabric-deploy -n capability-fabric-deploy -s "$sig" < "$manifest" >/dev/null 2>&1
echo CF_A1_SIGNATURE=pass

python3 - "$manifest" "$target" <<'PY'
import hashlib,json,os,re,sys
mp,root=sys.argv[1:3]
m=json.load(open(mp))
assert m["schema"]=="capability-fabric.deploy.v1"
assert m["sequence"]==66
assert m["release_id"]=="onshape-vps-hardened-production-r3"
assert m["compose_file"]=="compose.yaml"
files=m["files"]
required={
 "compose.yaml","health.sh","server.js","core.js","browser.js","session-pool.js",
 "onshape-request.cjs","fabric-agent.js","gateway.js",
 "fabric-policy/semantic-enforcement.v1.json"
}
missing=required-set(files)
assert not missing, sorted(missing)
for rel,expected in files.items():
    p=os.path.join(root,rel)
    assert os.path.isfile(p), rel
    actual=hashlib.sha256(open(p,"rb").read()).hexdigest()
    assert actual==expected,(rel,actual,expected)
assert m["images"] and all(re.fullmatch(r"[^\s]+@sha256:[0-9a-f]{64}",x) for x in m["images"])
print("CF_A1_FILE_HASH_CLOSURE=pass")
print("CF_A1_MANIFEST_FILE_COUNT="+str(len(files)))
print("CF_A1_IMAGE_DIGEST_PINNING=pass")
PY

compose="$target/compose.yaml"
if grep -Eq '^[[:space:]]*env_file[[:space:]]*:' "$compose"; then
  echo CF_A1_ENV_FILE=present >&2
  exit 24
fi
echo CF_A1_ENV_FILE=absent

if grep -Eq '\$\{[^}]+\}' "$compose"; then
  echo CF_A1_COMPOSE_INTERPOLATION=present >&2
  grep -Eo '\$\{[A-Za-z_][A-Za-z0-9_]*(?::-[^}]*)?\}' "$compose" | sed -E 's/^\$\{//; s/(:-[^}]*)?\}$//' | sort -u | sed 's/^/CF_A1_INTERPOLATED_NAME=/' || true
  exit 25
fi
echo CF_A1_COMPOSE_INTERPOLATION=absent

docker compose -f "$compose" config --format json > "$tmp/compose.json"
python3 - "$tmp/compose.json" "$manifest" <<'PY'
import json,sys
c=json.load(open(sys.argv[1])); m=json.load(open(sys.argv[2]))
services=c.get("services") or {}
assert services
expected_images=sorted(m["images"])
actual_images=sorted({svc.get("image") for svc in services.values() if svc.get("image")})
assert actual_images==expected_images,(actual_images,expected_images)

def envmap(svc):
    raw=svc.get("environment") or {}
    if isinstance(raw,dict):
        return {str(k):str(v) for k,v in raw.items()}
    out={}
    for item in raw:
        k,_,v=str(item).partition("="); out[k]=v
    return out

server=services.get("onshape_server") or services.get("server")
sidecar=services.get("fabric_sidecar")
assert server and sidecar, sorted(services)
se=envmap(server); fe=envmap(sidecar)
checks={
 "SERVER_CF_PUBLIC_SURFACE":(se.get("CF_PUBLIC_SURFACE"),"semantic-only"),
 "SERVER_CF_FABRIC_REQUIRE_PRODUCTION_AUTHORITY":(se.get("CF_FABRIC_REQUIRE_PRODUCTION_AUTHORITY"),"1"),
 "SERVER_CF_PRIVILEGED_NATIVE_ENABLED":(se.get("CF_PRIVILEGED_NATIVE_ENABLED"),"0"),
 "SIDECAR_CF_FABRIC_QUALIFICATION_MODE":(fe.get("CF_FABRIC_QUALIFICATION_MODE"),"0"),
 "SIDECAR_CF_FABRIC_REQUIRE_PRODUCTION_AUTHORITY":(fe.get("CF_FABRIC_REQUIRE_PRODUCTION_AUTHORITY"),"1"),
}
for label,(actual,expected) in checks.items():
    assert actual==expected,(label,actual,expected)
    print("CF_A1_"+label+"=pass")
print("CF_A1_EFFECTIVE_IMAGE_SET=manifest-exact")
PY

unit=/etc/systemd/system/capability-fabric-pull.service
[[ -s "$unit" ]] || exit 26
if grep -Eq '^EnvironmentFile=' "$unit"; then
  echo CF_A1_PULL_ENVIRONMENT_FILE=present >&2
  exit 26
fi
# HOME is operational process context, not a release behavior override.
extra_env="$(grep -E '^Environment=' "$unit" | grep -v '^Environment=HOME=/var/lib/capability-fabric/agent-home$' || true)"
[[ -z "$extra_env" ]] || { echo CF_A1_PULL_EXTERNAL_ENV_OVERRIDE=present >&2; exit 26; }
echo CF_A1_PULL_EXTERNAL_ENV_OVERRIDE=absent

echo CF_A1_SIGNED_CONFIG_IDENTITY=pass
echo CF_A1=pass
