#!/usr/bin/env bash
set -euo pipefail
umask 077

[[ "$(id -u)" -eq 0 ]] || { echo CF_R4_ACT_REQUIRES_ROOT >&2; exit 2; }

RELEASES=/var/lib/capability-fabric/releases
STATE=/var/lib/capability-fabric/state
SIGS=/var/lib/capability-fabric/signatures
TRUST=/etc/capability-fabric/trust/deploy-signing.pub
TOKEN=/etc/capability-fabric/secrets/repo-read-token
CACHE=/var/lib/capability-fabric/repo.git
ACTIVE=/opt/capability-fabric/current
PREVIOUS=/opt/capability-fabric/previous
CONTROL=/var/lib/capability-fabric/onshape/runtime-control/ONSHAPE_RUNTIME_CONTROL.json
GATE="$STATE/release-in-progress"
LOCK=/run/lock/capability-fabric-pull.lock
TIMER=capability-fabric-pull.timer
PROJECT=capability-fabric
GATEWAY=capability-fabric-onshape-gateway
DB=/var/lib/capability-fabric/onshape/fabric-state/execution.sqlite3
QUARANTINE=/var/lib/capability-fabric/onshape/fabric-state/quarantine/D-018-attempt-f6d80f46.json
ROLLBACK_GUARD=/usr/local/libexec/capability-fabric-onshape-rollback-contract

release_id=onshape-vps-hardened-production-r4
source_commit=0f5d0ea4692964e7cbb3de964f8c5b6ffaf62006
expected_manifest_sha=f2631a7f94ec5f6e5af5e9d3b3211cf440354eef0b55ff6fee7ab65cec50bfb9
expected_control_blob=177ddde1070c6a75f7cf94a15db1a0c93fa45159
candidate="$RELEASES/$release_id"

[[ -s "$TOKEN" && -s "$TRUST" && -d "$CACHE" && -s "$CONTROL" && -x "$ROLLBACK_GUARD" ]] || exit 20
[[ -f "$GATE" ]] || { echo CF_R4_ACT_GATE=missing >&2; exit 20; }
grep -Fxq 'RELEASE_IN_PROGRESS' "$GATE" || { echo CF_R4_ACT_GATE=unexpected >&2; exit 20; }
if systemctl is-active --quiet "$TIMER"; then echo CF_R4_ACT_TIMER=unexpected-active >&2; exit 20; fi
[[ "$(docker inspect -f '{{.State.Running}}' "$GATEWAY")" == false ]] || { echo CF_R4_ACT_GATEWAY=unexpected-running >&2; exit 20; }
[[ ! -e "$candidate" ]] || { echo CF_R4_ACT_RELEASE_ID_EXISTS >&2; exit 20; }

exec 9>"$LOCK"
flock -w 30 9 || { echo CF_R4_ACT_LOCK=busy >&2; exit 21; }

old="$(readlink -f "$ACTIVE")"
python3 - "$old/manifest.json" "$CONTROL" <<'PY'
import json,sys
m=json.load(open(sys.argv[1])); x=json.load(open(sys.argv[2])); a=x["authority"]; g=a["productionGuard"]
assert m["sequence"]==66 and m["release_id"]=="onshape-vps-hardened-production-r3"
assert x["controlRevision"]==532 and a["productionEpoch"]==4
assert a["mode"]=="QUIESCED_RECONCILING" and a["materialAuthority"] is None
assert a["planes"]["android-v1"]["ingress"]=="CLOSED" and a["planes"]["android-v1"]["materialEffectsAllowed"] is False
assert a["planes"]["vps-fabric"]["ingress"]=="CLOSED" and a["planes"]["vps-fabric"]["materialEffectsAllowed"] is False
assert x["routing"]["state"]=="CLOSED" and x["routing"]["materialCommandsAllowed"] is False
assert x["lease"]["state"]=="FREE"
assert g["schema"]=="capability-fabric.onshape-production-guard.v1"
assert g["generation"]==1 and g["killSwitch"]=="ENGAGED"
assert g["allowedDocumentIds"]==[]
assert g["mutationBudget"]=={"budgetId":"epoch4-seq67-stabilization-closed","maxMutations":0}
print("CF_R4_ACT_AUTHORITY_BEFORE=quiesced-epoch4-guard-closed")
print("CF_R4_ACT_ACTIVE_BEFORE=seq66")
PY
[[ "$(git hash-object "$CONTROL")" == "$expected_control_blob" ]] || { echo CF_R4_ACT_CONTROL_BLOB=mismatch >&2; exit 21; }

ponr="$("$ROLLBACK_GUARD" decide --db "$DB" --control "$CONTROL" --quarantine "$QUARANTINE")"
printf '%s
' "$ponr"
printf '%s
' "$ponr" | grep -Fxq 'CF_A4_PONR=true'
printf '%s
' "$ponr" | grep -Fxq 'CF_A4_PONR_COUNT=2'
printf '%s
' "$ponr" | grep -Fxq 'CF_A4_UNRESOLVED_BLOCKING=0'
printf '%s
' "$ponr" | grep -Fxq 'CF_A4_ZERO_UNRESOLVED=pass'
echo CF_R4_ACT_SAFETY_PRE=pass

work="$(mktemp -d /var/lib/capability-fabric/.activate67.XXXXXX)"
cleanup(){ rm -rf "$work"; }
trap cleanup EXIT
askpass="$work/askpass"
cat >"$askpass" <<'ASK'
#!/usr/bin/env bash
case "${1:-}" in
  *Username*) printf '%s
' x-access-token ;;
  *Password*) cat /etc/capability-fabric/secrets/repo-read-token ;;
  *) exit 1 ;;
esac
ASK
chmod 0700 "$askpass"

if git --git-dir="$CACHE" remote get-url origin >/dev/null 2>&1; then
  git --git-dir="$CACHE" remote set-url origin https://github.com/homayounisaghar/capability-fabric.git
else
  git --git-dir="$CACHE" remote add origin https://github.com/homayounisaghar/capability-fabric.git
fi
GIT_ASKPASS="$askpass" GIT_TERMINAL_PROMPT=0 HOME=/var/lib/capability-fabric/agent-home   git --git-dir="$CACHE" fetch --quiet --force --depth=1 origin "$source_commit"
resolved="$(git --git-dir="$CACHE" rev-parse FETCH_HEAD)"
[[ "$resolved" == "$source_commit" ]] || { echo CF_R4_ACT_SOURCE_COMMIT=mismatch >&2; exit 22; }

git --git-dir="$CACHE" show "$source_commit:server-deploy/current/manifest.json" >"$work/manifest.json"
manifest_sha="$(sha256sum "$work/manifest.json" | awk '{print $1}')"
[[ "$manifest_sha" == "$expected_manifest_sha" ]] || { echo CF_R4_ACT_MANIFEST_SHA=mismatch >&2; exit 22; }
python3 - "$work/manifest.json" <<'PY'
import json,sys
m=json.load(open(sys.argv[1]))
assert m["schema"]=="capability-fabric.deploy.v1"
assert m["sequence"]==67
assert m["release_id"]=="onshape-vps-hardened-production-r4"
assert len(m["files"])==35
print("CF_R4_ACT_MANIFEST_IDENTITY=pass")
PY

sig="$SIGS/$manifest_sha.sig"
[[ -s "$sig" ]] || { echo CF_R4_ACT_SIGNATURE=missing >&2; exit 22; }
printf 'capability-fabric-deploy %s
' "$(tr -d '
' < "$TRUST")" >"$work/allowed"
ssh-keygen -Y verify -f "$work/allowed" -I capability-fabric-deploy -n capability-fabric-deploy -s "$sig" <"$work/manifest.json" >/dev/null 2>&1
echo CF_R4_ACT_SIGNATURE=pass

stage="$RELEASES/.staging-$release_id-$$"
mkdir -m 0750 "$stage"
install -m 0640 "$work/manifest.json" "$stage/manifest.json"
install -m 0640 "$sig" "$stage/manifest.json.sig"
python3 - "$work/manifest.json" >"$work/files" <<'PY'
import json,sys
m=json.load(open(sys.argv[1]))
for rel,h in sorted(m["files"].items()):
    print(rel+"	"+h)
PY
while IFS=$'	' read -r rel expected; do
  [[ -n "$rel" ]] || continue
  install -d -m 0750 "$(dirname "$stage/$rel")"
  git --git-dir="$CACHE" show "$source_commit:server-deploy/current/$rel" >"$stage/$rel"
  actual="$(sha256sum "$stage/$rel" | awk '{print $1}')"
  [[ "$actual" == "$expected" ]] || { echo "CF_R4_ACT_FILE_HASH_MISMATCH=$rel" >&2; rm -rf "$stage"; exit 23; }
  chmod 0640 "$stage/$rel"
done <"$work/files"
chmod 0750 "$stage/health.sh"
printf '%s
' "$source_commit" >"$stage/source-commit"
printf '%s
' "$manifest_sha" >"$stage/manifest.sha256"
chmod 0640 "$stage/source-commit" "$stage/manifest.sha256"
chown -R root:root "$stage"
chmod -R go-w "$stage"
mv "$stage" "$candidate"
echo CF_R4_ACT_STAGE=pass
echo "CF_R4_ACT_SOURCE_COMMIT=$source_commit"
echo "CF_R4_ACT_MANIFEST_SHA256=$manifest_sha"

python3 - "$candidate/manifest.json" "$candidate" <<'PY'
import hashlib,json,os,sys
m=json.load(open(sys.argv[1])); root=sys.argv[2]
for rel,expected in m["files"].items():
    p=os.path.join(root,rel)
    assert os.path.isfile(p),rel
    assert hashlib.sha256(open(p,"rb").read()).hexdigest()==expected,rel
print("CF_R4_ACT_FILE_CLOSURE=pass")
PY

atomic_link(){
  local target="$1" link="$2" tmp
  tmp="${link}.tmp.$$"
  rm -f "$tmp"
  ln -s "$target" "$tmp"
  mv -Tf "$tmp" "$link"
}
health(){
  local rel="$1" timeout_s
  timeout_s="$(python3 - "$rel/manifest.json" <<'PY'
import json,sys
print(json.load(open(sys.argv[1]))["health_timeout_seconds"])
PY
)"
  timeout "$timeout_s" env CF_RELEASE_DIR="$rel" CF_COMPOSE_PROJECT="$PROJECT" bash "$rel/health.sh"
}
apply(){
  docker compose -p "$PROJECT" -f "$1/compose.yaml" up -d --remove-orphans --no-build
}

docker compose -p "$PROJECT" -f "$candidate/compose.yaml" pull >/dev/null
atomic_link "$old" "$PREVIOUS"
atomic_link "$candidate" "$ACTIVE"
echo CF_R4_ACT_POINTER_SWITCH=seq67

set +e
apply "$candidate" >"$work/apply.log" 2>&1
apply_rc=$?
if [[ "$apply_rc" -eq 0 ]]; then
  health "$candidate" >"$work/health.log" 2>&1
  health_rc=$?
else
  health_rc=1
fi
set -e

if [[ "$apply_rc" -ne 0 || "$health_rc" -ne 0 ]]; then
  echo "CF_R4_ACT_APPLY_RC=$apply_rc" >&2
  echo "CF_R4_ACT_HEALTH_RC=$health_rc" >&2
  tail -n 120 "$work/apply.log" >&2 || true
  tail -n 160 "$work/health.log" >&2 || true
  atomic_link "$old" "$ACTIVE"
  set +e
  apply "$old" >"$work/rollback-apply.log" 2>&1
  rb_apply=$?
  if [[ "$rb_apply" -eq 0 ]]; then
    health "$old" >"$work/rollback-health.log" 2>&1
    rb_health=$?
  else
    rb_health=1
  fi
  set -e
  docker stop "$GATEWAY" >/dev/null 2>&1 || true
  if [[ "$rb_apply" -eq 0 && "$rb_health" -eq 0 ]]; then
    echo CF_R4_ACT_ROLLBACK=success >&2
    echo CF_R4_ACT_FAIL_CLOSED=retained >&2
    exit 42
  fi
  echo CF_R4_ACT_ROLLBACK=failed >&2
  echo CF_R4_ACT_FAIL_CLOSED=retained >&2
  exit 43
fi

echo CF_R4_ACT_COMPOSE_APPLY=pass
cat "$work/health.log"
echo CF_R4_ACT_HEALTH=pass

printf '%s
' 67 >"$STATE/last-good-sequence"
printf '%s
' "$release_id" >"$STATE/last-good-release"
printf '%s
' "$source_commit" >"$STATE/last-good-commit"
rm -f "$STATE/last-failed-commit"
chmod 0600 "$STATE/last-good-sequence" "$STATE/last-good-release" "$STATE/last-good-commit"
chown root:root "$STATE/last-good-sequence" "$STATE/last-good-release" "$STATE/last-good-commit"

python3 - "$CONTROL" <<'PY'
import json,sys
x=json.load(open(sys.argv[1])); a=x["authority"]; g=a["productionGuard"]
assert x["controlRevision"]==532 and a["productionEpoch"]==4
assert a["mode"]=="QUIESCED_RECONCILING" and a["materialAuthority"] is None
assert a["planes"]["android-v1"]["materialEffectsAllowed"] is False
assert a["planes"]["vps-fabric"]["materialEffectsAllowed"] is False
assert g["generation"]==1 and g["killSwitch"]=="ENGAGED"
assert g["allowedDocumentIds"]==[]
assert g["mutationBudget"]["maxMutations"]==0
print("CF_R4_ACT_AUTHORITY_AFTER=quiesced-epoch4-guard-closed")
PY
[[ "$(git hash-object "$CONTROL")" == "$expected_control_blob" ]]

docker stop "$GATEWAY" >/dev/null
[[ "$(docker inspect -f '{{.State.Running}}' "$GATEWAY")" == false ]]
[[ "$(readlink -f "$ACTIVE")" == "$candidate" ]]
[[ "$(readlink -f "$PREVIOUS")" == "$old" ]]
[[ -f "$GATE" ]]
if systemctl is-active --quiet "$TIMER"; then exit 44; fi

echo CF_R4_ACT_ACTIVE_RELEASE=seq67
echo CF_R4_ACT_PREVIOUS_RELEASE=seq66
echo CF_R4_ACT_PUBLIC_GATEWAY=stopped
echo CF_R4_ACT_PULL_TIMER=stopped
echo CF_R4_ACT_RELEASE_GATE=active
echo CF_R4_ACT=pass
