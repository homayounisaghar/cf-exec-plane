#!/usr/bin/env bash
set -euo pipefail
umask 077

[[ "$(id -u)" -eq 0 ]] || { echo "rotation setup requires root" >&2; exit 1; }

src=server-bootstrap/pull-agent/cf-pull-agent.sh
installed=/usr/local/libexec/capability-fabric-pull-agent
old_trust=/etc/capability-fabric/trust/deploy-signing.pub
next_trust=/etc/capability-fabric/trust/deploy-signing-next.pub
current=/opt/capability-fabric/current
sign_id=capability-fabric-deploy
sign_namespace=capability-fabric-deploy

[[ -s "$src" && -s "$old_trust" && -s "$next_trust" ]] || { echo "CF_ROTATION_SETUP_MISSING_INPUT" >&2; exit 20; }

read_key() {
  local p="$1" kt kd extra
  read -r kt kd extra < "$p" || true
  [[ "$kt" == ssh-ed25519 && -n "${kd:-}" && -z "${extra:-}" ]] || return 1
  case "$kd" in *[!A-Za-z0-9+/=]*) return 1 ;; esac
  printf '%s %s' "$kt" "$kd"
}
old_key="$(read_key "$old_trust")" || { echo "CF_ROTATION_OLD_TRUST_INVALID" >&2; exit 21; }
next_key="$(read_key "$next_trust")" || { echo "CF_ROTATION_NEW_TRUST_INVALID" >&2; exit 21; }
[[ "$old_key" != "$next_key" ]] || { echo "CF_ROTATION_TRUST_KEYS_NOT_DISTINCT" >&2; exit 21; }

install -d -m 0755 -o root -g root /usr/local/libexec
tmp="$(mktemp /usr/local/libexec/.capability-fabric-pull-agent.XXXXXX)"
trap 'rm -f "$tmp"' EXIT
install -m 0750 -o root -g root "$src" "$tmp"
mv -f "$tmp" "$installed"
trap - EXIT

[[ "$(systemctl is-enabled capability-fabric-pull.timer 2>/dev/null || true)" == enabled ]] || { echo "CF_ROTATION_PULL_TIMER_NOT_ENABLED" >&2; exit 22; }
[[ "$(systemctl is-active capability-fabric-pull.timer 2>/dev/null || true)" == active ]] || { echo "CF_ROTATION_PULL_TIMER_NOT_ACTIVE" >&2; exit 22; }

[[ -L "$current" ]] || { echo "CF_ROTATION_CURRENT_RELEASE_MISSING" >&2; exit 23; }
release="$(readlink -f "$current")"
[[ "$release" == /var/lib/capability-fabric/releases/* && -s "$release/manifest.json" && -s "$release/manifest.json.sig" ]] || exit 23

work="$(mktemp -d /tmp/cf-rotation-setup.XXXXXX)"
trap 'rm -rf "$work"' EXIT
printf '%s %s\n' "$sign_id" "$old_key" > "$work/old-allowed"
printf '%s %s\n%s %s\n' "$sign_id" "$old_key" "$sign_id" "$next_key" > "$work/dual-allowed"

ssh-keygen -Y verify -f "$work/old-allowed" -I "$sign_id" -n "$sign_namespace" -s "$release/manifest.json.sig" < "$release/manifest.json" >/dev/null 2>&1 || {
  echo "CF_ROTATION_OLD_SIGNATURE_VERIFY_FAILED" >&2
  exit 24
}
ssh-keygen -Y verify -f "$work/dual-allowed" -I "$sign_id" -n "$sign_namespace" -s "$release/manifest.json.sig" < "$release/manifest.json" >/dev/null 2>&1 || {
  echo "CF_ROTATION_DUAL_TRUST_VERIFY_FAILED" >&2
  exit 24
}

if "$installed" pull > "$work/pull.out" 2>&1; then
  :
else
  grep '^CF_' "$work/pull.out" || true
  echo "CF_ROTATION_DUAL_TRUST_AGENT_PULL=fail" >&2
  exit 25
fi

printf 'CF_ROTATION_SETUP_BEGIN\n'
printf 'OLD_SIGNING_KEY_STILL_ACCEPTED=pass\n'
printf 'SECOND_SIGNING_TRUST_PRESENT=pass\n'
printf 'DUAL_TRUST_AGENT_INSTALLED=pass\n'
printf 'DUAL_TRUST_AGENT_PULL=pass\n'
printf 'OLD_SIGNING_TRUST_REMOVED=no\n'
printf 'CF_ROTATION_SETUP_END\n'
