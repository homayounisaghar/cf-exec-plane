#!/usr/bin/env bash
set -euo pipefail
umask 077

[[ "$(id -u)" -eq 0 ]] || { echo CF_ACT_REQUIRES_ROOT >&2; exit 2; }

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
LIVE_AGENT=/usr/local/libexec/capability-fabric-pull-agent
PROJECT=capability-fabric

candidate="$RELEASES/onshape-vps-hardened-production-r3"
rollback="$RELEASES/onshape-vps-hardened-rollback-r1"
expected_manifest_sha=857b7ca6d5a6bcf79b820594801a4f88642fe9520dad1ae18fc064eae6073d7c
promotion_anchor=248c2f48baf0a850a9674eb2048a122d0132f882

[[ -s "$TOKEN" && -s "$TRUST" && -s "$LIVE_AGENT" && -d "$candidate" && -d "$rollback" && -s "$CONTROL" ]] || exit 20
[[ -f "$GATE" ]] || { echo CF_ACT_GATE=missing >&2; exit 20; }
grep -Fxq 'SEQ66_ACTIVATION_IN_PROGRESS_EPOCH2_QUIESCED' "$GATE" || { echo CF_ACT_GATE=unexpected >&2; exit 20; }
if systemctl is-active --quiet "$TIMER"; then echo CF_ACT_TIMER=unexpected-active >&2; exit 20; fi

exec 9>"$LOCK"
flock -w 30 9 || { echo CF_ACT_LOCK=busy >&2; exit 21; }

old="$(readlink -f "$ACTIVE")"
[[ "$old" == "$rollback" ]] || { echo CF_ACT_ACTIVE_BASELINE=not-seq63 >&2; exit 21; }

python3 - "$rollback/manifest.json" "$candidate/manifest.json" "$CONTROL" <<'PY'
import json,sys
r=json.load(open(sys.argv[1])); c=json.load(open(sys.argv[2])); x=json.load(open(sys.argv[3]))
assert r["sequence"]==63 and r["release_id"]=="onshape-vps-hardened-rollback-r1"
assert c["sequence"]==66 and c["release_id"]=="onshape-vps-hardened-production-r3"
a=x["authority"]
assert x["controlRevision"]==530 and a["productionEpoch"]==2
assert a["mode"]=="QUIESCED_RECONCILING" and a["materialAuthority"] is None
assert a["planes"]["android-v1"]["ingress"]=="CLOSED" and a["planes"]["android-v1"]["materialEffectsAllowed"] is False
assert a["planes"]["vps-fabric"]["ingress"]=="CLOSED" and a["planes"]["vps-fabric"]["materialEffectsAllowed"] is False
assert x["routing"]["state"]=="CLOSED" and x["routing"]["materialCommandsAllowed"] is False
assert x["lease"]["state"]=="FREE"
print("CF_ACT_AUTHORITY_BEFORE=quiesced-epoch2")
PY

manifest_sha="$(sha256sum "$candidate/manifest.json" | awk '{print $1}')"
[[ "$manifest_sha" == "$expected_manifest_sha" ]] || { echo CF_ACT_MANIFEST_SHA=mismatch >&2; exit 22; }
sig="$SIGS/$manifest_sha.sig"
[[ -s "$sig" ]] || { echo CF_ACT_SIGNATURE=missing >&2; exit 22; }
work="$(mktemp -d /var/lib/capability-fabric/.activate66.XXXXXX)"
cleanup(){ rm -rf "$work"; }
trap cleanup EXIT
printf 'capability-fabric-deploy %s\n' "$(tr -d '\r\n' < "$TRUST")" >"$work/allowed"
ssh-keygen -Y verify -f "$work/allowed" -I capability-fabric-deploy -n capability-fabric-deploy -s "$sig" <"$candidate/manifest.json" >/dev/null 2>&1
python3 - "$candidate/manifest.json" "$candidate" <<'PY'
import hashlib,json,os,sys
m=json.load(open(sys.argv[1])); root=sys.argv[2]
for rel,expected in m["files"].items():
    p=os.path.join(root,rel)
    assert os.path.isfile(p),rel
    assert hashlib.sha256(open(p,"rb").read()).hexdigest()==expected,rel
print("CF_ACT_FILE_CLOSURE=pass")
PY
echo CF_ACT_SIGNATURE=pass
echo "CF_ACT_MANIFEST_SHA256=$manifest_sha"

# Verify canonical main now advertises byte-identical signed seq66.
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
if [[ ! -d "$CACHE" ]]; then git init --bare "$CACHE" >/dev/null; fi
if git --git-dir="$CACHE" remote get-url origin >/dev/null 2>&1; then
  git --git-dir="$CACHE" remote set-url origin https://github.com/homayounisaghar/capability-fabric.git
else
  git --git-dir="$CACHE" remote add origin https://github.com/homayounisaghar/capability-fabric.git
fi
GIT_ASKPASS="$askpass" GIT_TERMINAL_PROMPT=0 HOME=/var/lib/capability-fabric/agent-home   git --git-dir="$CACHE" fetch --quiet --force --depth=1 origin refs/heads/main:refs/remotes/origin/main
main_commit="$(git --git-dir="$CACHE" rev-parse refs/remotes/origin/main)"
[[ "$main_commit" =~ ^[0-9a-f]{40}$ ]] || { echo CF_ACT_CANONICAL_HEAD=invalid >&2; exit 23; }
# HEAD may advance for operational scripts/checkpoints after the atomic release
# promotion. The release invariant is byte-for-byte current-tree closure, not
# equality with the historical promotion commit.
git --git-dir="$CACHE" show "$main_commit:server-deploy/current/manifest.json" >"$work/main-manifest.json"
cmp -s "$work/main-manifest.json" "$candidate/manifest.json" || { echo CF_ACT_CANONICAL_MANIFEST=mismatch >&2; exit 23; }
python3 - "$candidate/manifest.json" "$CACHE" "$main_commit" <<'PY'
import hashlib,json,subprocess,sys
mp,cache,commit=sys.argv[1:]
m=json.load(open(mp))
for rel,expected in m["files"].items():
    data=subprocess.check_output(["git",f"--git-dir={cache}","show",f"{commit}:server-deploy/current/{rel}"])
    assert hashlib.sha256(data).hexdigest()==expected,rel
print("CF_ACT_CANONICAL_FILE_CLOSURE=pass")
PY
echo "CF_ACT_CANONICAL_MAIN_COMMIT=$main_commit"
echo "CF_ACT_PROMOTION_ANCHOR=$promotion_anchor"
echo CF_ACT_CANONICAL_CURRENT_CLOSURE=pass

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

# Images are digest-pinned and should already be present, but pull before pointer switch.
docker compose -p "$PROJECT" -f "$candidate/compose.yaml" pull >/dev/null
atomic_link "$old" "$PREVIOUS"
atomic_link "$candidate" "$ACTIVE"
echo CF_ACT_POINTER_SWITCH=seq66

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
  echo "CF_ACT_APPLY_RC=$apply_rc" >&2
  echo "CF_ACT_HEALTH_RC=$health_rc" >&2
  atomic_link "$old" "$ACTIVE"
  set +e
  apply "$old" >"$work/rollback-apply.log" 2>&1
  rb_apply=$?
  if [[ "$rb_apply" -eq 0 ]]; then
    health "$old" >"$work/rollback-health.log" 2>&1
    rb_health=$?
  else rb_health=1; fi
  set -e
  if [[ "$rb_apply" -eq 0 && "$rb_health" -eq 0 ]]; then
    echo CF_ACT_ROLLBACK=success >&2
    echo CF_ACT_FAIL_CLOSED_GATE=retained >&2
    exit 42
  fi
  echo CF_ACT_ROLLBACK=failed >&2
  echo CF_ACT_FAIL_CLOSED_GATE=retained >&2
  exit 43
fi

echo CF_ACT_COMPOSE_APPLY=pass
echo CF_ACT_HEALTH=pass

# Persist monotonic release sequencing only after health passes.
printf '%s\n' 66 >"$STATE/last-good-sequence"
printf '%s\n' onshape-vps-hardened-production-r3 >"$STATE/last-good-release"
printf '%s\n' "$main_commit" >"$STATE/last-good-commit"
rm -f "$STATE/last-failed-commit"
chmod 0600 "$STATE/last-good-sequence" "$STATE/last-good-release" "$STATE/last-good-commit"
chown root:root "$STATE/last-good-sequence" "$STATE/last-good-release" "$STATE/last-good-commit"

# Authority must still be quiesced after container replacement.
python3 - "$CONTROL" <<'PY'
import json,sys
x=json.load(open(sys.argv[1])); a=x["authority"]
assert x["controlRevision"]==530 and a["productionEpoch"]==2
assert a["mode"]=="QUIESCED_RECONCILING" and a["materialAuthority"] is None
assert a["planes"]["android-v1"]["materialEffectsAllowed"] is False
assert a["planes"]["vps-fabric"]["materialEffectsAllowed"] is False
print("CF_ACT_AUTHORITY_AFTER=quiesced-epoch2")
PY

[[ "$(readlink -f "$ACTIVE")" == "$candidate" ]]
[[ "$(readlink -f "$PREVIOUS")" == "$old" ]]
echo CF_ACT_ACTIVE_RELEASE=seq66
echo CF_ACT_PREVIOUS_RELEASE=seq63

# Release lock, clear gate, prove normal pull path is now stable no-change,
# then restore timer.
rm -f "$GATE"
flock -u 9
exec 9>&-

pull_output="$("$LIVE_AGENT" pull 2>&1)"
printf '%s\n' "$pull_output"
printf '%s\n' "$pull_output" | grep -Fxq 'CF_PULL_NO_CHANGE'
systemctl start "$TIMER"
systemctl is-active --quiet "$TIMER"
echo CF_ACT_PULL_STEADY_STATE=no-change
echo CF_ACT_TIMER=active
echo CF_ACT_RELEASE_GATE=clear
echo CF_ACT=pass
