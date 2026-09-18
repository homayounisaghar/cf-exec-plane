#!/usr/bin/env bash
set -euo pipefail
umask 077

mode="${1:?usage: install-rotation-material.sh <ssh-pubkey|signing-key-next>}"
: "${VPS_SSH_KEY:?VPS_SSH_KEY is required}"
: "${VPS_HOST:?VPS_HOST is required}"
: "${VPS_SSH_USER:?VPS_SSH_USER is required}"
: "${VPS_HOST_KEY:?VPS_HOST_KEY is required}"
port="${VPS_PORT:-22}"
case "$port" in ''|*[!0-9]*) echo "VPS_PORT must be numeric" >&2; exit 2 ;; esac
case "$VPS_SSH_USER" in ''|*[!a-zA-Z0-9_-]*) echo "VPS_SSH_USER contains unsupported characters" >&2; exit 2 ;; esac

key_file="$(mktemp "${RUNNER_TEMP:-/tmp}/cf-vps-key.XXXXXX")"
known_hosts="$(mktemp "${RUNNER_TEMP:-/tmp}/cf-known-hosts.XXXXXX")"
cleanup() { rm -f "$key_file" "$known_hosts"; }
trap cleanup EXIT
printf '%s\n' "$VPS_SSH_KEY" > "$key_file"
chmod 0600 "$key_file"
host_key_line="${VPS_HOST_KEY//$'\r'/}"
[[ "$host_key_line" != *$'\n'* ]] || { echo "VPS_HOST_KEY must contain exactly one line" >&2; exit 3; }
read -r key_type key_data extra <<< "$host_key_line"
[[ "$key_type" == ssh-ed25519 && -n "$key_data" && -z "${extra:-}" ]] || exit 3
printf '%s %s %s\n' "$VPS_HOST" "$key_type" "$key_data" > "$known_hosts"
printf '[%s]:%s %s %s\n' "$VPS_HOST" "$port" "$key_type" "$key_data" >> "$known_hosts"
chmod 0600 "$known_hosts"
ssh_base=(ssh -i "$key_file" -p "$port" -o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile="$known_hosts" -o ConnectTimeout=15 "${VPS_SSH_USER}@${VPS_HOST}")

normalize_ed25519() {
  local raw="$1" kt kd rest
  raw="${raw//$'\r'/}"
  [[ "$raw" != *$'\n'* ]] || { echo "public key material must be one line" >&2; exit 2; }
  read -r kt kd rest <<< "$raw"
  [[ "$kt" == ssh-ed25519 && -n "$kd" ]] || { echo "public key must be Ed25519" >&2; exit 2; }
  case "$kd" in *[!A-Za-z0-9+/=]*) echo "public key data malformed" >&2; exit 2 ;; esac
  printf '%s %s' "$kt" "$kd"
}

case "$mode" in
  ssh-pubkey)
    : "${VPS_SSH_PUBKEY_NEW:?VPS_SSH_PUBKEY_NEW is required}"
    : "${CF_ADMIN_USER:?CF_ADMIN_USER is required}"
    case "$CF_ADMIN_USER" in ''|*[!a-zA-Z0-9_-]*) echo "CF_ADMIN_USER malformed" >&2; exit 2 ;; esac
    normalized="$(normalize_ed25519 "$VPS_SSH_PUBKEY_NEW")"
    {
      printf '%s\n' "$CF_ADMIN_USER"
      printf '%s\n' "$normalized"
    } | "${ssh_base[@]}" 'set -euo pipefail; umask 077
      IFS= read -r admin
      IFS= read -r newkey
      [[ "$admin" =~ ^[A-Za-z0-9_-]+$ ]] || exit 2
      [[ "$newkey" == ssh-ed25519\ * ]] || exit 2
      add_key() {
        u="$1"
        entry="$(getent passwd "$u")" || exit 3
        home="$(printf "%s" "$entry" | cut -d: -f6)"
        gid="$(id -g "$u")"
        [[ -n "$home" && -d "$home" ]] || exit 3
        sshdir="$home/.ssh"
        auth="$sshdir/authorized_keys"
        install -d -m 0700 -o "$u" -g "$gid" "$sshdir"
        [[ ! -L "$auth" ]] || exit 4
        touch "$auth"
        chown "$u:$gid" "$auth"
        chmod 0600 "$auth"
        before="$(mktemp)"
        cp -a "$auth" "$before"
        if ! grep -Fqx -- "$newkey" "$auth"; then printf "%s\n" "$newkey" >> "$auth"; fi
        chown "$u:$gid" "$auth"
        chmod 0600 "$auth"
        while IFS= read -r oldline || [[ -n "$oldline" ]]; do
          [[ -z "$oldline" ]] && continue
          grep -Fqx -- "$oldline" "$auth" >/dev/null || { rm -f "$before"; exit 5; }
        done < "$before"
        rm -f "$before"
        grep -Fqx -- "$newkey" "$auth" >/dev/null
      }
      add_key root
      add_key "$admin"
      printf "CF_ROTATION_SSH_KEY_ADD=ok\n"
      printf "ROOT_EXISTING_AUTH_KEYS_PRESERVED=yes\n"
      printf "ADMIN_EXISTING_AUTH_KEYS_PRESERVED=yes\n"
      printf "OLD_SSH_KEYS_REMOVED=no\n"'
    ;;
  signing-key-next)
    : "${CF_DEPLOY_SIGNING_PUBLIC_KEY_NEW:?CF_DEPLOY_SIGNING_PUBLIC_KEY_NEW is required}"
    normalized="$(normalize_ed25519 "$CF_DEPLOY_SIGNING_PUBLIC_KEY_NEW")"
    printf '%s\n' "$normalized" | "${ssh_base[@]}" 'set -euo pipefail; umask 077
      old=/etc/capability-fabric/trust/deploy-signing.pub
      next=/etc/capability-fabric/trust/deploy-signing-next.pub
      [[ -s "$old" ]] || exit 6
      old_sha="$(sha256sum "$old" | awk "{print \\$1}")"
      install -d -m 0755 -o root -g root /etc/capability-fabric/trust
      t="$(mktemp /etc/capability-fabric/trust/.deploy-signing-next.XXXXXX)"
      trap '\''rm -f "$t"'\'' EXIT
      cat > "$t"
      [[ -s "$t" ]] || exit 7
      chown root:root "$t"; chmod 0644 "$t"
      mv -f "$t" "$next"
      trap - EXIT
      [[ "$(sha256sum "$old" | awk "{print \\$1}")" == "$old_sha" ]] || exit 8
      [[ "$(stat -c "%U:%G:%a" "$next")" == root:root:644 ]] || exit 9
      printf "CF_ROTATION_TRUST_ADD=ok\n"
      printf "OLD_TRUST_PRESERVED=yes\n"
      printf "NEW_TRUST_INSTALLED=yes\n"'
    ;;
  *) echo "invalid rotation material mode" >&2; exit 2 ;;
esac
