#!/usr/bin/env bash
set -euo pipefail
umask 077

[[ "$(id -u)" -eq 0 ]] || { echo "Stage2 cutover requires root" >&2; exit 1; }
: "${CF_ADMIN_USER:?CF_ADMIN_USER is required}"
: "${CF_NEW_SSH_PUBLIC_KEY:?CF_NEW_SSH_PUBLIC_KEY is required}"
: "${CF_DEPLOY_SIGNING_PUBLIC_KEY:?CF_DEPLOY_SIGNING_PUBLIC_KEY is required}"
case "$CF_ADMIN_USER" in ''|*[!a-zA-Z0-9_-]*) echo "invalid admin user" >&2; exit 2 ;; esac

new_ssh="$(printf '%s' "$CF_NEW_SSH_PUBLIC_KEY" | tr -d '\r\n')"
read -r nkt nkd _ <<< "$new_ssh"
[[ "$nkt" == ssh-ed25519 && -n "$nkd" ]] || { echo "NEW SSH public key invalid" >&2; exit 2; }
case "$nkd" in *[!A-Za-z0-9+/=]*) echo "NEW SSH public key malformed" >&2; exit 2 ;; esac
new_ssh="$nkt $nkd"

new_sign="$(printf '%s' "$CF_DEPLOY_SIGNING_PUBLIC_KEY" | tr -d '\r\n')"
read -r skt skd _ <<< "$new_sign"
[[ "$skt" == ssh-ed25519 && -n "$skd" ]] || { echo "NEW signing public key invalid" >&2; exit 2; }
case "$skd" in *[!A-Za-z0-9+/=]*) echo "NEW signing public key malformed" >&2; exit 2 ;; esac
new_sign="$skt $skd"

active=/root/.cf-stage2-rollback-active
watchdog=cf-stage2-rollback-watchdog
[[ ! -e "$active" ]] || { echo "CF_STAGE2_STALE_ROLLBACK_STATE" >&2; exit 11; }
systemctl is-active --quiet "$watchdog.timer" && { echo "CF_STAGE2_STALE_WATCHDOG" >&2; exit 11; } || true

root_entry="$(getent passwd root)"
admin_entry="$(getent passwd "$CF_ADMIN_USER")"
root_home="$(printf '%s' "$root_entry" | cut -d: -f6)"
admin_home="$(printf '%s' "$admin_entry" | cut -d: -f6)"
root_auth="$root_home/.ssh/authorized_keys"
admin_auth="$admin_home/.ssh/authorized_keys"
[[ -f "$root_auth" && ! -L "$root_auth" && -f "$admin_auth" && ! -L "$admin_auth" ]] || exit 12

work="$(mktemp -d /root/.cf-stage2-pre.XXXXXX)"
cleanup_work() { rm -rf "$work"; }
trap cleanup_work EXIT

parse_keys() {
  python3 - "$1" <<'PY'
import shlex,sys
known_prefixes=("ssh-","ecdsa-","sk-ssh-","sk-ecdsa-")
for raw in open(sys.argv[1],encoding="utf-8",errors="strict"):
    s=raw.strip()
    if not s or s.startswith("#"):
        continue
    try:
        t=shlex.split(s,comments=False,posix=True)
    except ValueError:
        continue
    for i,x in enumerate(t[:-1]):
        if x.startswith(known_prefixes):
            print(x+" "+t[i+1])
            break
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
root_before="$(wc -l < "$work/root.keys" | tr -d ' ')"
admin_before="$(wc -l < "$work/admin.keys" | tr -d ' ')"
[[ "$root_before" -ge 2 && "$admin_before" -ge 2 ]] || { echo "CF_STAGE2_TOO_FEW_KEYS_BEFORE" >&2; exit 13; }
[[ "$(grep -Fxc -- "$new_ssh" "$work/root.keys" || true)" -eq 1 ]] || { echo "CF_STAGE2_NEW_KEY_ROOT_CARDINALITY_FAIL" >&2; exit 13; }
[[ "$(grep -Fxc -- "$new_ssh" "$work/admin.keys" || true)" -eq 1 ]] || { echo "CF_STAGE2_NEW_KEY_ADMIN_CARDINALITY_FAIL" >&2; exit 13; }

grep -Fxv -- "$new_ssh" "$work/root.keys" | sort -u > "$work/root.other"
grep -Fxv -- "$new_ssh" "$work/admin.keys" | sort -u > "$work/admin.other"
comm -12 "$work/root.other" "$work/admin.other" > "$work/common.other"
[[ "$(wc -l < "$work/common.other" | tr -d ' ')" -eq 1 ]] || {
  echo "CF_STAGE2_OLD_KEY_IDENTITY_AMBIGUOUS" >&2
  exit 14
}
old_ssh="$(cat "$work/common.other")"
[[ "$old_ssh" != "$new_ssh" ]] || exit 14
[[ "$(grep -Fxc -- "$old_ssh" "$work/root.keys" || true)" -eq 1 ]] || exit 14
[[ "$(grep -Fxc -- "$old_ssh" "$work/admin.keys" || true)" -eq 1 ]] || exit 14

old_fp="$(fingerprint "$old_ssh")"
new_fp="$(fingerprint "$new_ssh")"

old_trust=/etc/capability-fabric/trust/deploy-signing.pub
next_trust=/etc/capability-fabric/trust/deploy-signing-next.pub
[[ -s "$old_trust" && -s "$next_trust" ]] || { echo "CF_STAGE2_OVERLAP_TRUST_MISSING" >&2; exit 15; }
old_sign="$(awk 'NF>=2 {print $1" "$2; exit}' "$old_trust")"
next_sign="$(awk 'NF>=2 {print $1" "$2; exit}' "$next_trust")"
[[ "$next_sign" == "$new_sign" && "$old_sign" != "$new_sign" ]] || { echo "CF_STAGE2_TRUST_IDENTITY_MISMATCH" >&2; exit 15; }
old_sign_fp="$(fingerprint "$old_sign")"
new_sign_fp="$(fingerprint "$new_sign")"

printf 'CF_STAGE2_PRE_OLD_SSH_FINGERPRINT=%s\n' "$old_fp"
printf 'CF_STAGE2_PRE_NEW_SSH_FINGERPRINT=%s\n' "$new_fp"
printf 'CF_STAGE2_PRE_OLD_SIGNING_FINGERPRINT=%s\n' "$old_sign_fp"
printf 'CF_STAGE2_PRE_NEW_SIGNING_FINGERPRINT=%s\n' "$new_sign_fp"
printf 'CF_STAGE2_PRE_ROOT_KEY_COUNT=%s\n' "$root_before"
printf 'CF_STAGE2_PRE_ADMIN_KEY_COUNT=%s\n' "$admin_before"
printf 'CF_STAGE2_PRE_BOTH_KEYS_PRESENT_ROOT=yes\n'
printf 'CF_STAGE2_PRE_BOTH_KEYS_PRESENT_ADMIN=yes\n'

install -d -m 0700 -o root -g root "$active"
cp -a "$root_auth" "$active/root.authorized_keys"
cp -a "$admin_auth" "$active/admin.authorized_keys"
cp -a "$old_trust" "$active/deploy-signing.pub"
cp -a "$next_trust" "$active/deploy-signing-next.pub"
printf '%s\n' "$root_auth" > "$active/root.path"
printf '%s\n' "$admin_auth" > "$active/admin.path"
printf '%s\n' "$CF_ADMIN_USER" > "$active/admin.user"
printf '%s\n' "$old_ssh" > "$active/old-ssh.pub"
printf '%s\n' "$new_ssh" > "$active/new-ssh.pub"
printf '%s\n' "$old_fp" > "$active/old-ssh.fp"
printf '%s\n' "$new_fp" > "$active/new-ssh.fp"
printf '%s\n' "$root_before" > "$active/root.count.before"
printf '%s\n' "$admin_before" > "$active/admin.count.before"

cat > "$active/rollback.sh" <<'RB'
#!/usr/bin/env bash
set -euo pipefail
active=/root/.cf-stage2-rollback-active
root_auth="$(cat "$active/root.path")"
admin_auth="$(cat "$active/admin.path")"
admin="$(cat "$active/admin.user")"
root_gid="$(id -g root)"
admin_gid="$(id -g "$admin")"
install -d -m 0700 -o root -g "$root_gid" "$(dirname "$root_auth")"
install -d -m 0700 -o "$admin" -g "$admin_gid" "$(dirname "$admin_auth")"
cp -f "$active/root.authorized_keys" "$root_auth"
cp -f "$active/admin.authorized_keys" "$admin_auth"
chown root:"$root_gid" "$root_auth"
chmod 0600 "$root_auth"
chown "$admin":"$admin_gid" "$admin_auth"
chmod 0600 "$admin_auth"
cp -f "$active/deploy-signing.pub" /etc/capability-fabric/trust/deploy-signing.pub
cp -f "$active/deploy-signing-next.pub" /etc/capability-fabric/trust/deploy-signing-next.pub
chown root:root /etc/capability-fabric/trust/deploy-signing.pub /etc/capability-fabric/trust/deploy-signing-next.pub
chmod 0644 /etc/capability-fabric/trust/deploy-signing.pub /etc/capability-fabric/trust/deploy-signing-next.pub
logger -t cf-stage2-rollback "CF_STAGE2_ROLLBACK_PERFORMED"
RB
chmod 0700 "$active/rollback.sh"

rollback_now() {
  rc=$?
  trap - EXIT
  systemctl stop "$watchdog.timer" >/dev/null 2>&1 || true
  "$active/rollback.sh" || true
  echo "CF_STAGE2_ROLLBACK=performed" >&2
  rm -rf "$active"
  cleanup_work
  exit "$rc"
}
trap rollback_now EXIT

systemd-run --quiet --unit="$watchdog" --on-active=10m "$active/rollback.sh"
systemctl is-active --quiet "$watchdog.timer" || { echo "CF_STAGE2_WATCHDOG_NOT_ARMED" >&2; exit 16; }
printf 'CF_STAGE2_ROLLBACK_WATCHDOG=armed\n'

rewrite_auth() {
  local auth="$1" user="$2" old="$3" gid t
  gid="$(id -g "$user")"
  t="$(mktemp "$(dirname "$auth")/.authorized_keys.stage2.XXXXXX")"
  python3 - "$auth" "$old" "$t" <<'PY'
import shlex,sys
src,old,out=sys.argv[1:]
known_prefixes=("ssh-","ecdsa-","sk-ssh-","sk-ecdsa-")
removed=0
with open(src,encoding="utf-8",errors="strict") as f, open(out,"w",encoding="utf-8") as g:
    for raw in f:
        norm=None
        s=raw.strip()
        if s and not s.startswith("#"):
            try:
                t=shlex.split(s,comments=False,posix=True)
            except ValueError:
                t=[]
            for i,x in enumerate(t[:-1]):
                if x.startswith(known_prefixes):
                    norm=x+" "+t[i+1]
                    break
        if norm==old:
            removed+=1
            continue
        g.write(raw)
if removed!=1:
    raise SystemExit(20)
PY
  chown "$user:$gid" "$t"
  chmod 0600 "$t"
  mv -f "$t" "$auth"
}
rewrite_auth "$root_auth" root "$old_ssh"
rewrite_auth "$admin_auth" "$CF_ADMIN_USER" "$old_ssh"

t="$(mktemp /etc/capability-fabric/trust/.deploy-signing.stage2.XXXXXX)"
printf '%s\n' "$new_sign" > "$t"
chown root:root "$t"
chmod 0644 "$t"
mv -f "$t" "$old_trust"
rm -f "$next_trust"

parse_keys "$root_auth" > "$work/root.after"
parse_keys "$admin_auth" > "$work/admin.after"
root_after="$(wc -l < "$work/root.after" | tr -d ' ')"
admin_after="$(wc -l < "$work/admin.after" | tr -d ' ')"
[[ "$root_after" -eq $((root_before-1)) && "$admin_after" -eq $((admin_before-1)) ]] || { echo "CF_STAGE2_KEY_COUNT_NOT_REDUCED_BY_ONE" >&2; exit 17; }
[[ "$(grep -Fxc -- "$new_ssh" "$work/root.after" || true)" -eq 1 && "$(grep -Fxc -- "$new_ssh" "$work/admin.after" || true)" -eq 1 ]] || exit 17
[[ "$(grep -Fxc -- "$old_ssh" "$work/root.after" || true)" -eq 0 && "$(grep -Fxc -- "$old_ssh" "$work/admin.after" || true)" -eq 0 ]] || exit 17
[[ ! -e "$next_trust" ]] || exit 17
[[ "$(awk 'NF>=2 {print $1" "$2; exit}' "$old_trust")" == "$new_sign" ]] || exit 17

current="$(readlink -f /opt/capability-fabric/current)"
[[ "$current" == /var/lib/capability-fabric/releases/* ]] || exit 18
manifest="$current/manifest.json"
manifest_sha="$(sha256sum "$manifest" | cut -d ' ' -f1)"
sig="/var/lib/capability-fabric/signatures/${manifest_sha}.sig"
[[ -s "$manifest" && -s "$sig" && -x "$current/health.sh" ]] || exit 18
printf 'capability-fabric-deploy %s\n' "$(cat "$old_trust")" > "$work/allowed-new"
ssh-keygen -Y verify -f "$work/allowed-new" -I capability-fabric-deploy -n capability-fabric-deploy -s "$sig" < "$manifest" >/dev/null
timeout 300 env CF_RELEASE_DIR="$current" CF_COMPOSE_PROJECT=capability-fabric bash "$current/health.sh" >/dev/null

trap cleanup_work EXIT
printf 'CF_STAGE2_CUTOVER_MUTATION=pass\n'
printf 'CF_STAGE2_POST_OLD_SSH_FINGERPRINT=%s\n' "$old_fp"
printf 'CF_STAGE2_POST_NEW_SSH_FINGERPRINT=%s\n' "$new_fp"
printf 'CF_STAGE2_POST_ROOT_KEY_COUNT=%s\n' "$root_after"
printf 'CF_STAGE2_POST_ADMIN_KEY_COUNT=%s\n' "$admin_after"
printf 'CF_STAGE2_POST_OLD_KEY_PRESENT_ROOT=no\n'
printf 'CF_STAGE2_POST_OLD_KEY_PRESENT_ADMIN=no\n'
printf 'CF_STAGE2_POST_NEW_KEY_PRESENT_ROOT=yes\n'
printf 'CF_STAGE2_POST_NEW_KEY_PRESENT_ADMIN=yes\n'
printf 'CF_STAGE2_ONLY_NEW_SIGNING_TRUST_ACTIVE=yes\n'
printf 'CF_STAGE2_CURRENT_SIGNATURE_NEW_TRUST=pass\n'
printf 'CF_STAGE2_CURRENT_HEALTH=pass\n'
