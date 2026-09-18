#!/usr/bin/env bash
set -euo pipefail
umask 077

[[ "$(id -u)" -eq 0 ]] || { echo "Stage2 post-cutover verify requires root" >&2; exit 1; }
primary=/etc/capability-fabric/trust/deploy-signing.pub
next=/etc/capability-fabric/trust/deploy-signing-next.pub
current=/opt/capability-fabric/current
[[ -s "$primary" ]] || exit 20
[[ ! -e "$next" ]] || { echo "CF_STAGE2_EXTRA_TRUST_PRESENT" >&2; exit 20; }
read -r kt kd extra < "$primary" || true
[[ "$kt" == ssh-ed25519 && -n "${kd:-}" && -z "${extra:-}" ]] || exit 20
[[ -L "$current" ]] || exit 21
release="$(readlink -f "$current")"
[[ "$release" == /var/lib/capability-fabric/releases/* ]] || exit 21
manifest="$release/manifest.json"
manifest_sha="$(sha256sum "$manifest" | cut -d " " -f1)"
sig="/var/lib/capability-fabric/signatures/${manifest_sha}.sig"
[[ -s "$manifest" && -s "$sig" && -x "$release/health.sh" ]] || exit 21
work="$(mktemp -d /tmp/cf-stage2-post.XXXXXX)"
trap 'rm -rf "$work"' EXIT
printf 'capability-fabric-deploy %s\n' "$(cat "$primary")" > "$work/allowed"
ssh-keygen -Y verify -f "$work/allowed" -I capability-fabric-deploy -n capability-fabric-deploy -s "$sig" < "$manifest" >/dev/null
timeout 300 env CF_RELEASE_DIR="$release" CF_COMPOSE_PROJECT=capability-fabric bash "$release/health.sh" >/dev/null
printf 'CF_STAGE2_POST_ONLY_NEW_TRUST=yes\n'
printf 'CF_STAGE2_POST_SIGNATURE_VERIFY=pass\n'
printf 'CF_STAGE2_POST_HEALTH=pass\n'
