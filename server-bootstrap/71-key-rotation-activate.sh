#!/usr/bin/env bash
set -euo pipefail
umask 077

[[ "$(id -u)" -eq 0 ]] || { echo "rotation activation requires root" >&2; exit 1; }

agent=/usr/local/libexec/capability-fabric-pull-agent
old_trust=/etc/capability-fabric/trust/deploy-signing.pub
next_trust=/etc/capability-fabric/trust/deploy-signing-next.pub
current=/opt/capability-fabric/current
signatures=/var/lib/capability-fabric/signatures
sign_id=capability-fabric-deploy
sign_namespace=capability-fabric-deploy

[[ -x "$agent" && -s "$old_trust" && -s "$next_trust" ]] || { echo "CF_ROTATION_ACTIVATE_MISSING_INPUT" >&2; exit 30; }

read_key() {
  local p="$1" kt kd extra
  read -r kt kd extra < "$p" || true
  [[ "$kt" == ssh-ed25519 && -n "${kd:-}" && -z "${extra:-}" ]] || return 1
  case "$kd" in *[!A-Za-z0-9+/=]*) return 1 ;; esac
  printf '%s %s' "$kt" "$kd"
}
old_key="$(read_key "$old_trust")" || exit 31
next_key="$(read_key "$next_trust")" || exit 31
[[ "$old_key" != "$next_key" ]] || exit 31

work="$(mktemp -d /tmp/cf-rotation-activate.XXXXXX)"
cleanup() { rm -rf "$work"; }
trap cleanup EXIT

set +e
"$agent" pull > "$work/pull.out" 2>&1
pull_rc=$?
set -e
grep '^CF_' "$work/pull.out" || true
if [[ "$pull_rc" -ne 0 ]]; then
  if grep -Eq '^CF_PULL_ROLLBACK=success$|^CF_PULL_APPLY_FAILED_ROLLED_BACK$' "$work/pull.out"; then
    echo "ROTATION_NEW_RELEASE_ROLLBACK=success"
  else
    echo "ROTATION_NEW_RELEASE_ROLLBACK=not-proven"
  fi
  echo "ROTATION_NEW_RELEASE_ACTIVATION=failed" >&2
  exit "$pull_rc"
fi

[[ -L "$current" ]] || { echo "ROTATION_ACTIVE_POINTER=fail" >&2; exit 32; }
release="$(readlink -f "$current")"
[[ "$release" == /var/lib/capability-fabric/releases/* && -s "$release/manifest.json" && -s "$release/manifest.json.sig" && -x "$release/health.sh" ]] || exit 32
manifest_sha="$(sha256sum "$release/manifest.json" | cut -d ' ' -f1)"
[[ "$manifest_sha" =~ ^[0-9a-f]{64}$ ]] || exit 32
cache_sig="$signatures/${manifest_sha}.sig"
[[ -s "$cache_sig" ]] || exit 32
cmp -s "$release/manifest.json.sig" "$cache_sig" || { echo "ROTATION_SIGNATURE_CACHE_MISMATCH" >&2; exit 33; }

printf '%s %s\n' "$sign_id" "$next_key" > "$work/new-allowed"
ssh-keygen -Y verify -f "$work/new-allowed" -I "$sign_id" -n "$sign_namespace" -s "$release/manifest.json.sig" < "$release/manifest.json" >/dev/null 2>&1 || {
  echo "NEW_SIGNING_KEY_VERIFY=fail" >&2
  exit 34
}

health_timeout="$(python3 - "$release/manifest.json" <<'PY'
import json,sys
with open(sys.argv[1],encoding='utf-8') as f:
    m=json.load(f)
v=m.get('health_timeout_seconds')
if not isinstance(v,int) or not 5 <= v <= 300:
    raise SystemExit(1)
print(v)
PY
)"
timeout "$health_timeout" env CF_RELEASE_DIR="$release" CF_COMPOSE_PROJECT=capability-fabric bash "$release/health.sh" >/dev/null || {
  echo "NEW_RELEASE_HEALTH=fail" >&2
  exit 35
}

printf 'CF_ROTATION_ACTIVATE_BEGIN\n'
printf 'NEW_SIGNING_KEY_VERIFY=pass\n'
printf 'NEW_RELEASE_HEALTH=pass\n'
printf 'OLD_SIGNING_TRUST_PRESENT=yes\n'
printf 'NEW_SIGNING_TRUST_PRESENT=yes\n'
printf 'OLD_SIGNING_TRUST_REMOVED=no\n'
printf 'ROTATION_NEW_RELEASE_ROLLBACK=not-needed\n'
printf 'CF_ROTATION_ACTIVATE_END\n'
