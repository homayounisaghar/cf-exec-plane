#!/usr/bin/env bash
set -euo pipefail
umask 077

[[ "$(id -u)" -eq 0 ]] || { echo "Stage2 overlap verify requires root" >&2; exit 1; }
: "${CF_ADMIN_USER:?CF_ADMIN_USER is required}"
: "${CF_NEW_SSH_PUBLIC_KEY:?CF_NEW_SSH_PUBLIC_KEY is required}"
: "${CF_DEPLOY_SIGNING_PUBLIC_KEY:?CF_DEPLOY_SIGNING_PUBLIC_KEY is required}"

new_ssh="$(printf '%s' "$CF_NEW_SSH_PUBLIC_KEY" | tr -d '\r\n')"
read -r nkt nkd _ <<< "$new_ssh"
[[ "$nkt" == ssh-ed25519 && -n "$nkd" ]] || exit 2
new_ssh="$nkt $nkd"
new_sign="$(printf '%s' "$CF_DEPLOY_SIGNING_PUBLIC_KEY" | tr -d '\r\n')"
read -r skt skd _ <<< "$new_sign"
[[ "$skt" == ssh-ed25519 && -n "$skd" ]] || exit 2
new_sign="$skt $skd"

root_home="$(getent passwd root | cut -d: -f6)"
admin_home="$(getent passwd "$CF_ADMIN_USER" | cut -d: -f6)"
root_auth="$root_home/.ssh/authorized_keys"
admin_auth="$admin_home/.ssh/authorized_keys"
[[ -f "$root_auth" && -f "$admin_auth" ]] || exit 3

work="$(mktemp -d /tmp/cf-stage2-overlap.XXXXXX)"
trap 'rm -rf "$work"' EXIT
parse_keys() {
  python3 - "$1" <<'PY'
import shlex,sys
prefix=("ssh-","ecdsa-","sk-ssh-","sk-ecdsa-")
for raw in open(sys.argv[1],encoding="utf-8",errors="strict"):
    s=raw.strip()
    if not s or s.startswith("#"): continue
    try: t=shlex.split(s,comments=False,posix=True)
    except ValueError: continue
    for i,x in enumerate(t[:-1]):
        if x.startswith(prefix):
            print(x+" "+t[i+1]); break
PY
}
fingerprint() {
  local k="$1" f
  f="$(mktemp "$work/key.XXXXXX")"
  printf '%s\n' "$k" > "$f"
  ssh-keygen -E sha256 -lf "$f" | awk '{print $2}'
  rm -f "$f"
}
parse_keys "$root_auth" > "$work/root.keys"
parse_keys "$admin_auth" > "$work/admin.keys"
root_count="$(wc -l < "$work/root.keys" | tr -d ' ')"
admin_count="$(wc -l < "$work/admin.keys" | tr -d ' ')"
[[ "$root_count" -eq 2 && "$admin_count" -eq 2 ]] || { echo "CF_STAGE2_OVERLAP_COUNT_FAIL" >&2; exit 4; }
[[ "$(grep -Fxc -- "$new_ssh" "$work/root.keys" || true)" -eq 1 ]] || exit 4
[[ "$(grep -Fxc -- "$new_ssh" "$work/admin.keys" || true)" -eq 1 ]] || exit 4
grep -Fxv -- "$new_ssh" "$work/root.keys" | sort -u > "$work/root.other"
grep -Fxv -- "$new_ssh" "$work/admin.keys" | sort -u > "$work/admin.other"
comm -12 "$work/root.other" "$work/admin.other" > "$work/common.other"
[[ "$(wc -l < "$work/common.other" | tr -d ' ')" -eq 1 ]] || { echo "CF_STAGE2_OVERLAP_OLD_AMBIGUOUS" >&2; exit 5; }
old_ssh="$(cat "$work/common.other")"
old_fp="$(fingerprint "$old_ssh")"
new_fp="$(fingerprint "$new_ssh")"

old_trust=/etc/capability-fabric/trust/deploy-signing.pub
next_trust=/etc/capability-fabric/trust/deploy-signing-next.pub
[[ -s "$old_trust" && -s "$next_trust" ]] || { echo "CF_STAGE2_OVERLAP_TRUST_FAIL" >&2; exit 6; }
old_sign="$(awk 'NF>=2 {print $1" "$2; exit}' "$old_trust")"
next_sign="$(awk 'NF>=2 {print $1" "$2; exit}' "$next_trust")"
[[ "$next_sign" == "$new_sign" && "$old_sign" != "$new_sign" ]] || { echo "CF_STAGE2_OVERLAP_TRUST_IDENTITY_FAIL" >&2; exit 6; }

current="$(readlink -f /opt/capability-fabric/current)"
manifest="$current/manifest.json"
manifest_sha="$(sha256sum "$manifest" | cut -d ' ' -f1)"
sig="/var/lib/capability-fabric/signatures/${manifest_sha}.sig"
[[ -s "$manifest" && -s "$sig" && -x "$current/health.sh" ]] || exit 7
printf 'capability-fabric-deploy %s\n' "$new_sign" > "$work/allowed-new"
ssh-keygen -Y verify -f "$work/allowed-new" -I capability-fabric-deploy -n capability-fabric-deploy -s "$sig" < "$manifest" >/dev/null
timeout 300 env CF_RELEASE_DIR="$current" CF_COMPOSE_PROJECT=capability-fabric bash "$current/health.sh" >/dev/null

printf 'CF_STAGE2_OVERLAP_RESTORED=pass\n'
printf 'CF_STAGE2_OVERLAP_ROOT_KEY_COUNT=%s\n' "$root_count"
printf 'CF_STAGE2_OVERLAP_ADMIN_KEY_COUNT=%s\n' "$admin_count"
printf 'CF_STAGE2_OVERLAP_OLD_SSH_FINGERPRINT=%s\n' "$old_fp"
printf 'CF_STAGE2_OVERLAP_NEW_SSH_FINGERPRINT=%s\n' "$new_fp"
printf 'CF_STAGE2_OVERLAP_OLD_TRUST_PRESENT=yes\n'
printf 'CF_STAGE2_OVERLAP_NEW_TRUST_PRESENT=yes\n'
printf 'CF_STAGE2_OVERLAP_CURRENT_NEW_SIGNATURE=pass\n'
printf 'CF_STAGE2_OVERLAP_CURRENT_HEALTH=pass\n'
