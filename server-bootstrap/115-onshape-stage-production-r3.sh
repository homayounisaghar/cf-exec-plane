#!/usr/bin/env bash
set -euo pipefail
umask 077

[[ "$(id -u)" -eq 0 ]] || { echo CF_STAGE_R3_REQUIRES_ROOT >&2; exit 2; }

source_commit=23b64174c1c33e4048d6fe843af674559ab31ccb
manifest_path=server-deploy/candidates/onshape-vps-hardened-production-r3/manifest.json
expected_manifest_sha=857b7ca6d5a6bcf79b820594801a4f88642fe9520dad1ae18fc064eae6073d7c
release_id=onshape-vps-hardened-production-r3
release_root=/var/lib/capability-fabric/releases
target="$release_root/$release_id"
active=/opt/capability-fabric/current
previous=/opt/capability-fabric/previous
release_gate=/var/lib/capability-fabric/state/release-in-progress
cache=/var/lib/capability-fabric/repo.git
token_file=/etc/capability-fabric/secrets/repo-read-token
trust=/etc/capability-fabric/trust/deploy-signing.pub

[[ ! -e "$release_gate" ]] || { echo CF_STAGE_R3_RELEASE_GATE=active >&2; exit 20; }
[[ -L "$active" && -s "$token_file" && -s "$trust" ]] || exit 20
active_before="$(readlink -f "$active")"
previous_before="$(readlink -f "$previous" 2>/dev/null || true)"
[[ "$active_before" == "$release_root/"* ]] || exit 20
python3 - "$active_before/manifest.json" <<'PY'
import json,sys
m=json.load(open(sys.argv[1]))
assert m["sequence"]==63,m
assert m["release_id"]=="onshape-vps-hardened-rollback-r1",m
print("CF_STAGE_R3_ACTIVE_BEFORE=seq63")
PY

control=/var/lib/capability-fabric/onshape/runtime-control/ONSHAPE_RUNTIME_CONTROL.json
control_sha_before="$(sha256sum "$control" | awk '{print $1}')"
python3 - "$control" <<'PY'
import json,sys
r=json.load(open(sys.argv[1])); a=r["authority"]
assert r["controlRevision"]==529
assert r["lease"]["state"]=="FREE"
assert a["productionEpoch"]==1
assert a["mode"]=="ANDROID_PRODUCTION"
assert a["materialAuthority"]=="android-v1"
assert a["planes"]["vps-fabric"]["materialEffectsAllowed"] is False
print("CF_STAGE_R3_AUTHORITY_BEFORE=android-epoch1")
PY

containers=(capability-fabric-onshape-server capability-fabric-onshape-fabric capability-fabric-onshape-gateway)
before_file="$(mktemp)"
after_file="$(mktemp)"
work="$(mktemp -d /var/lib/capability-fabric/.stage-r3.XXXXXX)"
cleanup(){ rm -f "$before_file" "$after_file"; rm -rf "$work"; }
trap cleanup EXIT
for c in "${containers[@]}"; do
  docker inspect -f '{{.Name}}|{{.Id}}|{{.State.StartedAt}}|{{.Image}}' "$c" >>"$before_file"
done

askpass="$work/askpass"
cat >"$askpass" <<'ASK'
#!/usr/bin/env bash
case "${1:-}" in
  *Username*) printf '%s\n' x-access-token ;;
  *Password*) cat /etc/capability-fabric/secrets/repo-read-token ;;
  *) exit 1 ;;
esac
ASK
chmod 0700 "$askpass"
[[ -d "$cache" ]] || git init --bare "$cache" >/dev/null
if git --git-dir="$cache" remote get-url origin >/dev/null 2>&1; then
  git --git-dir="$cache" remote set-url origin https://github.com/homayounisaghar/capability-fabric.git
else
  git --git-dir="$cache" remote add origin https://github.com/homayounisaghar/capability-fabric.git
fi
GIT_ASKPASS="$askpass" GIT_TERMINAL_PROMPT=0 HOME=/var/lib/capability-fabric/agent-home   git --git-dir="$cache" fetch --quiet --depth=1 origin "$source_commit"
fetched="$(git --git-dir="$cache" rev-parse FETCH_HEAD)"
[[ "$fetched" == "$source_commit" ]] || exit 21
echo "CF_STAGE_R3_SOURCE_COMMIT=$fetched"

git --git-dir="$cache" show "$source_commit:$manifest_path" >"$work/manifest.json"
manifest_sha="$(sha256sum "$work/manifest.json" | awk '{print $1}')"
[[ "$manifest_sha" == "$expected_manifest_sha" ]] || { echo CF_STAGE_R3_MANIFEST_SHA=mismatch >&2; exit 22; }
echo "CF_STAGE_R3_MANIFEST_SHA256=$manifest_sha"

sig=/var/lib/capability-fabric/signatures/${manifest_sha}.sig
[[ -s "$sig" ]] || { echo CF_STAGE_R3_SIGNATURE=missing >&2; exit 23; }
pub="$(tr -d '\r\n' < "$trust")"
printf 'capability-fabric-deploy %s\n' "$pub" >"$work/allowed"
ssh-keygen -Y verify -f "$work/allowed" -I capability-fabric-deploy -n capability-fabric-deploy -s "$sig" <"$work/manifest.json" >/dev/null 2>&1
echo CF_STAGE_R3_SIGNATURE=pass

python3 - "$work/manifest.json" "$work/files" "$work/images" <<'PY'
import json,re,sys
m=json.load(open(sys.argv[1]))
assert m["schema"]=="capability-fabric.deploy.v1"
assert m["sequence"]==66
assert m["release_id"]=="onshape-vps-hardened-production-r3"
assert m["compose_file"]=="compose.yaml"
assert m["health_file"]=="health.sh"
files=m["files"]; images=m["images"]
assert "compose.yaml" in files and "release-closure.json" in files and "server.js" in files
assert images and all(re.fullmatch(r"[^\s]+@sha256:[0-9a-f]{64}",x) for x in images)
with open(sys.argv[2],"w") as f:
  for p in sorted(files): f.write(f"{p}\t{files[p]}\n")
with open(sys.argv[3],"w") as f:
  for x in sorted(images): f.write(x+"\n")
print("CF_STAGE_R3_MANIFEST_IDENTITY=pass")
PY

if [[ -e "$target" ]]; then
  [[ -d "$target" ]] || exit 24
  stage="$target"
  echo CF_STAGE_R3_WRITE=UNCHANGED
else
  stage="$release_root/.staging-$release_id-$$"
  mkdir -m 0750 "$stage"
  install -m 0640 "$work/manifest.json" "$stage/manifest.json"
  install -m 0640 "$sig" "$stage/manifest.json.sig"
  while IFS=$'\t' read -r rel expected; do
    install -d -m 0750 "$(dirname "$stage/$rel")"
    git --git-dir="$cache" show "$source_commit:server-deploy/current/$rel" >"$stage/$rel"
    actual="$(sha256sum "$stage/$rel" | awk '{print $1}')"
    [[ "$actual" == "$expected" ]] || { echo "CF_STAGE_R3_FILE_HASH_MISMATCH=$rel" >&2; rm -rf "$stage"; exit 25; }
    chmod 0640 "$stage/$rel"
  done <"$work/files"
  chmod 0750 "$stage/health.sh"
  printf '%s\n' "$source_commit" >"$stage/source-commit"
  printf '%s\n' "$manifest_sha" >"$stage/manifest.sha256"
  chmod 0640 "$stage/source-commit" "$stage/manifest.sha256"
  chown -R root:root "$stage"
fi

[[ "$(sha256sum "$stage/manifest.json" | awk '{print $1}')" == "$expected_manifest_sha" ]]
while IFS=$'\t' read -r rel expected; do
  [[ "$(sha256sum "$stage/$rel" | awk '{print $1}')" == "$expected" ]] || exit 26
done <"$work/files"

! grep -Eq '\$\{[^}]+\}' "$stage/compose.yaml"
! grep -Eq '^[[:space:]]*env_file[[:space:]]*:' "$stage/compose.yaml"
docker compose -f "$stage/compose.yaml" config --format json >"$work/compose.json"
python3 - "$work/compose.json" "$work/images" <<'PY'
import json,sys
c=json.load(open(sys.argv[1])); s=c.get("services") or {}
actual=sorted({v.get("image") for v in s.values() if v.get("image")})
expected=sorted(x.strip() for x in open(sys.argv[2]) if x.strip())
assert actual==expected,(actual,expected)
print("CF_STAGE_R3_COMPOSE_RESOLUTION=pass")
print("CF_STAGE_R3_IMAGE_SET=manifest-exact")
PY

if [[ "$stage" != "$target" ]]; then
  mv "$stage" "$target"
  echo CF_STAGE_R3_WRITE=CHANGED
fi

active_after="$(readlink -f "$active")"
previous_after="$(readlink -f "$previous" 2>/dev/null || true)"
[[ "$active_after" == "$active_before" ]] || { echo CF_STAGE_R3_ACTIVE_POINTER=changed >&2; exit 27; }
[[ "$previous_after" == "$previous_before" ]] || { echo CF_STAGE_R3_PREVIOUS_POINTER=changed >&2; exit 27; }
[[ ! -e "$release_gate" ]] || { echo CF_STAGE_R3_RELEASE_GATE=changed >&2; exit 27; }
[[ "$(sha256sum "$control" | awk '{print $1}')" == "$control_sha_before" ]] || { echo CF_STAGE_R3_RUNTIME_CONTROL=changed >&2; exit 27; }
for c in "${containers[@]}"; do
  docker inspect -f '{{.Name}}|{{.Id}}|{{.State.StartedAt}}|{{.Image}}' "$c" >>"$after_file"
done
cmp -s "$before_file" "$after_file" || { echo CF_STAGE_R3_CONTAINERS=changed >&2; exit 27; }

echo CF_STAGE_R3_ACTIVE_POINTER=unchanged
echo CF_STAGE_R3_PREVIOUS_POINTER=unchanged
echo CF_STAGE_R3_RELEASE_GATE=clear
echo CF_STAGE_R3_RUNTIME_CONTROL=unchanged
echo CF_STAGE_R3_CONTAINERS=unchanged
echo CF_STAGE_R3_AUTHORITY_AFTER=android-epoch1
echo CF_STAGE_R3=pass
