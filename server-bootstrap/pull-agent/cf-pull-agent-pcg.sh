#!/usr/bin/env bash
set -euo pipefail

TOKEN_FILE=/etc/capability-fabric/secrets/repo-read-token
TRUST_FILE=/etc/capability-fabric/trust/deploy-signing.pub
TRUST_FILE_NEXT=/etc/capability-fabric/trust/deploy-signing-next.pub
REPO_URL=https://github.com/homayounisaghar/capability-fabric.git
BRANCH=project/personal-communications-gateway
DEPLOY_DIR=server-deploy/channels/pcg/current
ROOT=/var/lib/capability-fabric/deploy/pcg
CACHE="$ROOT/repo.git"
RELEASES="$ROOT/releases"
SIGNATURES="$ROOT/signatures"
STATE="$ROOT/state"
RELEASE_GATE="$STATE/release-in-progress"
ACTIVE=/opt/capability-fabric/channels/pcg/current
PREVIOUS=/opt/capability-fabric/channels/pcg/previous
DETAIL_LOG=/var/log/capability-fabric/pcg-pull-agent-detail.log
LOCK_FILE=/run/lock/capability-fabric-pull-pcg.lock
HOST_DOCKER_LOCK=/run/lock/capability-fabric-pull.lock
PROJECT=capability-fabric-pcg
SIGN_ID=capability-fabric-deploy
SIGN_NAMESPACE=capability-fabric-deploy
MODE="${1:-pull}"

case "$MODE" in pull|rollback-drill) ;; *) echo "CF_PCG_PULL_INVALID_MODE" >&2; exit 2 ;; esac
[[ "$(id -u)" -eq 0 ]] || { echo "CF_PCG_PULL_REQUIRES_ROOT" >&2; exit 2; }
[[ -s "$TOKEN_FILE" ]] || { echo "CF_PCG_PULL_BLOCKED_REPO_CREDENTIAL" >&2; exit 20; }
[[ -s "$TRUST_FILE" ]] || { echo "CF_PCG_PULL_BLOCKED_SIGNING_TRUST" >&2; exit 21; }
for cmd in git ssh-keygen python3 docker flock sha256sum timeout; do
  command -v "$cmd" >/dev/null 2>&1 || { echo "CF_PCG_PULL_MISSING_TOOL=$cmd" >&2; exit 22; }
done
docker compose version >/dev/null 2>&1 || { echo "CF_PCG_PULL_MISSING_DOCKER_COMPOSE" >&2; exit 22; }

install -d -m 0750 -o root -g root "$ROOT" "$RELEASES" "$SIGNATURES" "$STATE" /var/log/capability-fabric /var/lib/capability-fabric/pcg /var/lib/capability-fabric/agent-home
install -d -m 0755 -o root -g root /opt/capability-fabric/channels/pcg /run/lock
install -d -m 0770 -o 65534 -g 65534 /var/lib/capability-fabric/pcg/run
install -d -m 0700 -o 65534 -g 65534 /var/lib/capability-fabric/pcg/core-state /var/lib/capability-fabric/pcg/telegram-state
install -d -m 0700 -o root -g root /var/lib/capability-fabric/pcg/correlation
: >> "$DETAIL_LOG"
chmod 0640 "$DETAIL_LOG"
chown root:root "$DETAIL_LOG"

exec 9>"$LOCK_FILE"
if ! flock -n 9; then echo "CF_PCG_PULL_SKIPPED_LOCKED"; exit 0; fi
work="$(mktemp -d "$ROOT/.pull.XXXXXX")"
cleanup() { rm -rf "$work"; }
trap cleanup EXIT

timestamp() { date -u +%Y-%m-%dT%H:%M:%SZ; }
detail() { printf '[%s] %s\n' "$(timestamp)" "$*" >> "$DETAIL_LOG"; }
atomic_write() { local path="$1" value="$2" tmp; tmp="${path}.tmp.$$"; printf '%s\n' "$value" > "$tmp"; chmod 0600 "$tmp"; mv -f "$tmp" "$path"; }
release_gate_begin() { atomic_write "$RELEASE_GATE" "RELEASE_IN_PROGRESS"; }
release_gate_end() { rm -f "$RELEASE_GATE"; }
atomic_link() { local target="$1" link="$2" tmp; tmp="${link}.tmp.$$"; rm -f "$tmp"; ln -s "$target" "$tmp"; mv -Tf "$tmp" "$link"; }
read_state() { local path="$1" fallback="$2"; if [[ -r "$path" ]]; then cat "$path"; else printf '%s' "$fallback"; fi; }
manifest_value() {
  local manifest="$1" key="$2"
  python3 - "$manifest" "$key" <<'PY'
import json,sys
with open(sys.argv[1], encoding='utf-8') as f: m=json.load(f)
print(m[sys.argv[2]])
PY
}

snapshot_onshape() {
  local out="$1" name
  {
    printf 'active=%s\n' "$(readlink -f /opt/capability-fabric/current 2>/dev/null || true)"
    printf 'sequence=%s\n' "$(cat /var/lib/capability-fabric/state/last-good-sequence 2>/dev/null || true)"
    for name in capability-fabric-onshape-server capability-fabric-onshape-fabric capability-fabric-onshape-gateway; do
      if docker inspect "$name" >/dev/null 2>&1; then
        printf '%s=%s|%s\n' "$name" "$(docker inspect -f '{{.Id}}' "$name")" "$(docker inspect -f '{{.State.StartedAt}}' "$name")"
      else
        printf '%s=ABSENT\n' "$name"
      fi
    done
  } > "$out"
}

with_host_docker_lock() {
  (
    exec 8>"$HOST_DOCKER_LOCK"
    flock 8
    "$@"
  )
}

compose_pull_locked() {
  local release="$1"
  detail "compose pull release=$release"
  docker compose -p "$PROJECT" -f "$release/compose.yaml" pull >>"$DETAIL_LOG" 2>&1
}

compose_switch_locked() {
  local from_release="$1" to_release="$2" before after
  before="$work/onshape-before.$$"
  after="$work/onshape-after.$$"
  snapshot_onshape "$before"
  if [[ -n "$from_release" && -s "$from_release/compose.yaml" ]]; then
    detail "compose down release=$from_release"
    docker compose -p "$PROJECT" -f "$from_release/compose.yaml" down --remove-orphans >>"$DETAIL_LOG" 2>&1 || true
  fi
  detail "compose up release=$to_release"
  docker compose -p "$PROJECT" -f "$to_release/compose.yaml" up -d --remove-orphans --no-build >>"$DETAIL_LOG" 2>&1
  snapshot_onshape "$after"
  if ! cmp -s "$before" "$after"; then
    detail "foreign Onshape state changed during PCG compose switch"
    echo "CF_PCG_PULL_FOREIGN_ONSHAPE_CHANGED" >&2
    return 1
  fi
}

compose_down_locked() {
  local release="$1" before after
  before="$work/onshape-before-down.$$"
  after="$work/onshape-after-down.$$"
  snapshot_onshape "$before"
  if [[ -s "$release/compose.yaml" ]]; then
    docker compose -p "$PROJECT" -f "$release/compose.yaml" down --remove-orphans >>"$DETAIL_LOG" 2>&1 || true
  fi
  snapshot_onshape "$after"
  if ! cmp -s "$before" "$after"; then
    detail "foreign Onshape state changed during PCG compose down"
    echo "CF_PCG_PULL_FOREIGN_ONSHAPE_CHANGED" >&2
    return 1
  fi
}

health_check() {
  local release="$1" timeout_s
  timeout_s="$(manifest_value "$release/manifest.json" health_timeout_seconds)"
  detail "health start release=$release"
  if timeout "$timeout_s" env CF_RELEASE_DIR="$release" CF_COMPOSE_PROJECT="$PROJECT" bash "$release/health.sh" >>"$DETAIL_LOG" 2>&1; then
    detail "health pass release=$release"
    return 0
  fi
  detail "health fail release=$release"
  return 1
}

rollback_to() {
  local old="$1" candidate="$2"
  detail "rollback start"
  if [[ -n "$old" && -d "$old" && -s "$old/compose.yaml" && -s "$old/health.sh" ]]; then
    atomic_link "$old" "$ACTIVE"
    if with_host_docker_lock compose_switch_locked "$candidate" "$old" && health_check "$old"; then
      detail "rollback success"
      echo "CF_PCG_PULL_ROLLBACK=success"
      return 0
    fi
    detail "rollback previous health/apply failed"
    echo "CF_PCG_PULL_ROLLBACK=failed" >&2
    return 1
  fi
  rm -f "$ACTIVE"
  with_host_docker_lock compose_down_locked "$candidate" || true
  detail "rollback unavailable no previous release"
  echo "CF_PCG_PULL_ROLLBACK=unavailable" >&2
  return 1
}

if [[ "$MODE" == rollback-drill ]]; then
  [[ -L "$ACTIVE" ]] || { echo "CF_PCG_ROLLBACK_DRILL_BLOCKED_NO_CURRENT" >&2; exit 60; }
  old="$(readlink -f "$ACTIVE")"
  [[ "$old" == "$RELEASES/"* && -d "$old" ]] || { echo "CF_PCG_ROLLBACK_DRILL_INVALID_CURRENT" >&2; exit 60; }
  health_check "$old" || { echo "CF_PCG_ROLLBACK_DRILL_BLOCKED_CURRENT_UNHEALTHY" >&2; exit 60; }
  saved_previous=''; [[ -L "$PREVIOUS" ]] && saved_previous="$(readlink -f "$PREVIOUS")"
  drill="$RELEASES/.rollback-drill-$$"
  mkdir -m 0750 "$drill"; cp -a "$old/." "$drill/"
  cat > "$drill/health.sh" <<'DRILL'
#!/usr/bin/env bash
exit 1
DRILL
  chmod 0750 "$drill/health.sh"
  release_gate_begin
  atomic_link "$old" "$PREVIOUS"; atomic_link "$drill" "$ACTIVE"
  if ! with_host_docker_lock compose_switch_locked "$old" "$drill"; then
    atomic_link "$old" "$ACTIVE"
    with_host_docker_lock compose_switch_locked "$drill" "$old" || true
    rm -rf "$drill"
    release_gate_end
    echo "CF_PCG_ROLLBACK_DRILL_APPLY_FAILED" >&2
    exit 61
  fi
  if health_check "$drill"; then
    atomic_link "$old" "$ACTIVE"
    with_host_docker_lock compose_switch_locked "$drill" "$old" || true
    rm -rf "$drill"
    release_gate_end
    echo "CF_PCG_ROLLBACK_DRILL_UNEXPECTED_HEALTH_PASS" >&2
    exit 61
  fi
  if ! rollback_to "$old" "$drill"; then
    rm -rf "$drill"
    echo "CF_PCG_ROLLBACK_DRILL=failed" >&2
    exit 62
  fi
  if [[ -n "$saved_previous" && -d "$saved_previous" ]]; then atomic_link "$saved_previous" "$PREVIOUS"; else rm -f "$PREVIOUS"; fi
  rm -rf "$drill"; release_gate_end
  echo "CF_PCG_ROLLBACK_DRILL=success"
  exit 0
fi

askpass="$work/askpass"
cat > "$askpass" <<'ASKPASS'
#!/usr/bin/env bash
case "${1:-}" in
  *Username*) printf '%s\n' 'x-access-token' ;;
  *Password*) cat /etc/capability-fabric/secrets/repo-read-token ;;
  *) exit 1 ;;
esac
ASKPASS
chmod 0700 "$askpass"

if [[ ! -d "$CACHE" ]]; then git init --bare "$CACHE" >>"$DETAIL_LOG" 2>&1; fi
if git --git-dir="$CACHE" remote get-url origin >/dev/null 2>&1; then git --git-dir="$CACHE" remote set-url origin "$REPO_URL"; else git --git-dir="$CACHE" remote add origin "$REPO_URL"; fi

detail "fetch start branch=$BRANCH"
if ! GIT_ASKPASS="$askpass" GIT_TERMINAL_PROMPT=0 HOME=/var/lib/capability-fabric/agent-home git --git-dir="$CACHE" fetch --quiet --force --prune --depth=1 origin "refs/heads/${BRANCH}:refs/remotes/origin/${BRANCH}" >>"$DETAIL_LOG" 2>&1; then
  echo "CF_PCG_PULL_FETCH_FAILED" >&2; exit 30
fi
commit="$(git --git-dir="$CACHE" rev-parse "refs/remotes/origin/${BRANCH}")"
[[ "$commit" =~ ^[0-9a-f]{40}$ ]] || { echo "CF_PCG_PULL_INVALID_HEAD" >&2; exit 30; }

last_good_commit="$(read_state "$STATE/last-good-commit" '')"
last_failed_commit="$(read_state "$STATE/last-failed-commit" '')"
if [[ "$commit" == "$last_good_commit" ]]; then echo "CF_PCG_PULL_NO_CHANGE"; exit 0; fi
if [[ "$commit" == "$last_failed_commit" ]]; then echo "CF_PCG_PULL_SKIPPED_PREVIOUSLY_FAILED_HEAD"; exit 0; fi

if ! git --git-dir="$CACHE" show "$commit:$DEPLOY_DIR/manifest.json" > "$work/manifest.json" 2>>"$DETAIL_LOG"; then
  echo "CF_PCG_PULL_NO_CANDIDATE" >&2
  exit 31
fi
manifest_sha="$(sha256sum "$work/manifest.json" | awk '{print $1}')"
[[ "$manifest_sha" =~ ^[0-9a-f]{64}$ ]] || { echo "CF_PCG_PULL_MANIFEST_DIGEST_FAILED" >&2; exit 31; }
sig_path="$SIGNATURES/${manifest_sha}.sig"
if [[ ! -s "$sig_path" ]]; then
  echo "CF_PCG_PULL_SIGNATURE_PENDING" >&2
  exit 31
fi
install -m 0640 "$sig_path" "$work/manifest.json.sig"

allowed="$work/allowed_signers"
: > "$allowed"
for trust_path in "$TRUST_FILE" "$TRUST_FILE_NEXT"; do
  [[ -e "$trust_path" ]] || continue
  [[ -s "$trust_path" ]] || { echo "CF_PCG_PULL_INVALID_TRUST_KEY" >&2; exit 21; }
  pub_line="$(tr -d '\r\n' < "$trust_path")"
  read -r key_type key_data extra <<< "$pub_line"
  [[ "$key_type" == ssh-ed25519 && -n "$key_data" && -z "${extra:-}" ]] || { echo "CF_PCG_PULL_INVALID_TRUST_KEY" >&2; exit 21; }
  case "$key_data" in *[!A-Za-z0-9+/=]*) echo "CF_PCG_PULL_INVALID_TRUST_KEY" >&2; exit 21 ;; esac
  printf '%s %s %s\n' "$SIGN_ID" "$key_type" "$key_data" >> "$allowed"
done
[[ -s "$allowed" ]] || { echo "CF_PCG_PULL_BLOCKED_SIGNING_TRUST" >&2; exit 21; }
if ! ssh-keygen -Y verify -f "$allowed" -I "$SIGN_ID" -n "$SIGN_NAMESPACE" -s "$work/manifest.json.sig" < "$work/manifest.json" >>"$DETAIL_LOG" 2>&1; then
  atomic_write "$STATE/last-failed-commit" "$commit"
  echo "CF_PCG_PULL_SIGNATURE_REJECTED" >&2
  exit 32
fi

if ! python3 - "$work/manifest.json" "$work/meta" "$work/files" "$work/images" <<'PY' >>"$DETAIL_LOG" 2>&1
import json,re,sys
manifest,meta_path,files_path,images_path=sys.argv[1:]
with open(manifest,encoding='utf-8') as f: m=json.load(f)
expected={'schema','sequence','release_id','compose_file','health_file','health_timeout_seconds','files','images'}
if set(m)!=expected: raise SystemExit('manifest keys mismatch')
if m['schema']!='capability-fabric.deploy.v1': raise SystemExit('schema mismatch')
if not isinstance(m['sequence'],int) or not (1 <= m['sequence'] <= 9223372036854775807): raise SystemExit('bad sequence')
if not isinstance(m['release_id'],str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]{0,79}',m['release_id']): raise SystemExit('bad release_id')
if m['compose_file']!='compose.yaml' or m['health_file']!='health.sh': raise SystemExit('fixed file names required')
if not isinstance(m['health_timeout_seconds'],int) or not (5 <= m['health_timeout_seconds'] <= 300): raise SystemExit('bad health timeout')
files=m['files']
if not isinstance(files,dict) or not files: raise SystemExit('bad files')
for required in ('compose.yaml','health.sh'):
    if required not in files: raise SystemExit('missing required file hash')
for p,h in files.items():
    if not isinstance(p,str) or p.startswith('/') or '..' in p.split('/') or not re.fullmatch(r'[A-Za-z0-9._/-]+',p): raise SystemExit('unsafe file path')
    if not isinstance(h,str) or not re.fullmatch(r'[0-9a-f]{64}',h): raise SystemExit('bad file hash')
images=m['images']
if not isinstance(images,list) or not images or len(set(images))!=len(images): raise SystemExit('bad images')
for image in images:
    if not isinstance(image,str) or not re.fullmatch(r'[^\s]+@sha256:[0-9a-f]{64}',image): raise SystemExit('image not digest pinned')
with open(meta_path,'w',encoding='utf-8') as f: f.write(f"{m['sequence']}\n{m['release_id']}\n{m['health_timeout_seconds']}\n")
with open(files_path,'w',encoding='utf-8') as f:
    for p in sorted(files): f.write(f"{p}\t{files[p]}\n")
with open(images_path,'w',encoding='utf-8') as f:
    for image in sorted(images): f.write(image+'\n')
PY
then
  atomic_write "$STATE/last-failed-commit" "$commit"
  echo "CF_PCG_PULL_MANIFEST_REJECTED" >&2
  exit 33
fi

mapfile -t meta < "$work/meta"
sequence="${meta[0]}"; release_id="${meta[1]}"
last_sequence="$(read_state "$STATE/last-good-sequence" '0')"
case "$last_sequence" in ''|*[!0-9]*) echo "CF_PCG_PULL_CORRUPT_STATE" >&2; exit 34 ;; esac
if (( sequence < last_sequence )); then atomic_write "$STATE/last-failed-commit" "$commit"; echo "CF_PCG_PULL_REPLAY_REJECTED" >&2; exit 35; fi
if (( sequence == last_sequence )); then
  last_release="$(read_state "$STATE/last-good-release" '')"
  if [[ "$release_id" == "$last_release" ]]; then atomic_write "$STATE/last-good-commit" "$commit"; echo "CF_PCG_PULL_NO_CHANGE"; exit 0; fi
  atomic_write "$STATE/last-failed-commit" "$commit"; echo "CF_PCG_PULL_SEQUENCE_COLLISION" >&2; exit 35
fi

stage="$RELEASES/.staging-${release_id}-$$"
release="$RELEASES/$release_id"
[[ ! -e "$release" ]] || { atomic_write "$STATE/last-failed-commit" "$commit"; echo "CF_PCG_PULL_RELEASE_ID_EXISTS" >&2; exit 36; }
mkdir -m 0750 "$stage"
install -m 0640 "$work/manifest.json" "$stage/manifest.json"
install -m 0640 "$work/manifest.json.sig" "$stage/manifest.json.sig"
while IFS=$'\t' read -r rel expected_hash; do
  [[ -n "$rel" ]] || continue
  install -d -m 0755 "$(dirname "$stage/$rel")"
  if ! git --git-dir="$CACHE" show "$commit:$DEPLOY_DIR/$rel" > "$stage/$rel" 2>>"$DETAIL_LOG"; then
    rm -rf "$stage"; atomic_write "$STATE/last-failed-commit" "$commit"; echo "CF_PCG_PULL_RELEASE_FILE_MISSING" >&2; exit 37
  fi
  actual_hash="$(sha256sum "$stage/$rel" | awk '{print $1}')"
  if [[ "$actual_hash" != "$expected_hash" ]]; then
    rm -rf "$stage"; atomic_write "$STATE/last-failed-commit" "$commit"; echo "CF_PCG_PULL_RELEASE_HASH_MISMATCH" >&2; exit 38
  fi
  chmod 0644 "$stage/$rel"
done < "$work/files"
chmod 0750 "$stage/health.sh"
printf '%s\n' "$commit" > "$stage/source-commit"
printf '%s\n' "$manifest_sha" > "$stage/manifest.sha256"
chmod 0644 "$stage/source-commit" "$stage/manifest.sha256"

if ! docker compose -f "$stage/compose.yaml" config --format json > "$work/compose.json" 2>>"$DETAIL_LOG"; then
  rm -rf "$stage"; atomic_write "$STATE/last-failed-commit" "$commit"; echo "CF_PCG_PULL_COMPOSE_INVALID" >&2; exit 39
fi
if ! python3 - "$work/compose.json" "$work/images" <<'PY' >>"$DETAIL_LOG" 2>&1
import json,sys
with open(sys.argv[1],encoding='utf-8') as f: c=json.load(f)
services=c.get('services')
if not isinstance(services,dict) or not services: raise SystemExit('no services')
actual=[]
for name,svc in services.items():
    if 'build' in svc: raise SystemExit(f'build forbidden: {name}')
    image=svc.get('image')
    if not isinstance(image,str) or not image: raise SystemExit(f'image required: {name}')
    actual.append(image)
with open(sys.argv[2],encoding='utf-8') as f: expected=[x.strip() for x in f if x.strip()]
if sorted(set(actual)) != sorted(expected): raise SystemExit('resolved image set differs from signed manifest')
PY
then
  rm -rf "$stage"; atomic_write "$STATE/last-failed-commit" "$commit"; echo "CF_PCG_PULL_IMAGE_POLICY_REJECTED" >&2; exit 39
fi

mv "$stage" "$release"
chown -R root:root "$release"
chmod -R go-w "$release"
if ! with_host_docker_lock compose_pull_locked "$release"; then
  atomic_write "$STATE/last-failed-commit" "$commit"
  echo "CF_PCG_PULL_IMAGE_PULL_FAILED" >&2
  exit 40
fi

old=''
if [[ -L "$ACTIVE" ]]; then
  old="$(readlink -f "$ACTIVE")"
  [[ "$old" == "$RELEASES/"* && -d "$old" ]] || { atomic_write "$STATE/last-failed-commit" "$commit"; echo "CF_PCG_PULL_INVALID_CURRENT_POINTER" >&2; exit 41; }
fi

release_gate_begin
[[ -z "$old" ]] || atomic_link "$old" "$PREVIOUS"
atomic_link "$release" "$ACTIVE"

if ! with_host_docker_lock compose_switch_locked "$old" "$release" || ! health_check "$release"; then
  atomic_write "$STATE/last-failed-commit" "$commit"
  if rollback_to "$old" "$release"; then
    release_gate_end
    echo "CF_PCG_PULL_APPLY_FAILED_ROLLED_BACK" >&2
    exit 42
  fi
  echo "CF_PCG_PULL_APPLY_FAILED_ROLLBACK_FAILED" >&2
  exit 43
fi

atomic_write "$STATE/last-good-sequence" "$sequence"
atomic_write "$STATE/last-good-release" "$release_id"
atomic_write "$STATE/last-good-commit" "$commit"
rm -f "$STATE/last-failed-commit"
release_gate_end
detail "activation success sequence=$sequence release=$release_id"
echo "CF_PCG_PULL_APPLY=success"
