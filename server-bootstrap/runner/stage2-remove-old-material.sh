#!/usr/bin/env bash
set -euo pipefail
umask 077

: "${VPS_SSH_KEY:?VPS_SSH_KEY is required}"
: "${VPS_SSH_KEY_OLD:?VPS_SSH_KEY_OLD is required}"
: "${VPS_HOST:?VPS_HOST is required}"
: "${VPS_SSH_USER:?VPS_SSH_USER is required}"
: "${VPS_HOST_KEY:?VPS_HOST_KEY is required}"
: "${CF_ADMIN_USER:?CF_ADMIN_USER is required}"
: "${CF_DEPLOY_SIGNING_PUBLIC_KEY:?CF_DEPLOY_SIGNING_PUBLIC_KEY is required}"
port="${VPS_PORT:-22}"
case "$port" in ''|*[!0-9]*) echo "VPS_PORT must be numeric" >&2; exit 2 ;; esac
for u in "$VPS_SSH_USER" "$CF_ADMIN_USER"; do case "$u" in ''|*[!a-zA-Z0-9_-]*) echo "invalid SSH user" >&2; exit 2 ;; esac; done

tmp="$(mktemp -d "${RUNNER_TEMP:-/tmp}/cf-stage2-cutover.XXXXXX")"
trap 'rm -rf "$tmp"' EXIT
new_key="$tmp/new-key"
old_key="$tmp/old-key"
known_hosts="$tmp/known-hosts"
printf '%s\n' "$VPS_SSH_KEY" > "$new_key"
printf '%s\n' "$VPS_SSH_KEY_OLD" > "$old_key"
chmod 0600 "$new_key" "$old_key"

new_pub="$(ssh-keygen -y -f "$new_key")"
old_pub="$(ssh-keygen -y -f "$old_key")"
read -r nkt nkd nkx <<< "$new_pub"
read -r okt okd okx <<< "$old_pub"
[[ "$nkt" == ssh-ed25519 && -n "$nkd" && -z "${nkx:-}" ]] || { echo "NEW SSH key is not a clean Ed25519 key" >&2; exit 3; }
[[ "$okt" == ssh-ed25519 && -n "$okd" && -z "${okx:-}" ]] || { echo "OLD SSH key is not a clean Ed25519 key" >&2; exit 3; }
[[ "$nkd" != "$okd" ]] || { echo "OLD and NEW SSH keys are identical" >&2; exit 3; }
new_pub="$nkt $nkd"
old_pub="$okt $okd"

sign_pub="$(printf '%s' "$CF_DEPLOY_SIGNING_PUBLIC_KEY" | tr -d '\r\n')"
read -r skt skd skx <<< "$sign_pub"
[[ "$skt" == ssh-ed25519 && -n "$skd" && -z "${skx:-}" ]] || { echo "canonical signing public key invalid" >&2; exit 3; }
case "$skd" in *[!A-Za-z0-9+/=]*) echo "canonical signing public key malformed" >&2; exit 3 ;; esac
sign_pub="$skt $skd"

host_key_line="${VPS_HOST_KEY//$'\r'/}"
[[ "$host_key_line" != *$'\n'* ]] || exit 4
read -r hkt hkd hkx <<< "$host_key_line"
[[ "$hkt" == ssh-ed25519 && -n "$hkd" && -z "${hkx:-}" ]] || exit 4
printf '%s %s %s\n' "$VPS_HOST" "$hkt" "$hkd" > "$known_hosts"
printf '[%s]:%s %s %s\n' "$VPS_HOST" "$port" "$hkt" "$hkd" >> "$known_hosts"
chmod 0600 "$known_hosts"

{
  printf '%s\n' "$CF_ADMIN_USER"
  printf '%s\n' "$new_pub"
  printf '%s\n' "$old_pub"
  printf '%s\n' "$sign_pub"
} | ssh \
  -i "$new_key" \
  -p "$port" \
  -o BatchMode=yes \
  -o IdentitiesOnly=yes \
  -o StrictHostKeyChecking=yes \
  -o UserKnownHostsFile="$known_hosts" \
  -o ConnectTimeout=15 \
  "${VPS_SSH_USER}@${VPS_HOST}" 'set -euo pipefail; umask 077
    IFS= read -r admin
    IFS= read -r new_ssh
    IFS= read -r old_ssh
    IFS= read -r new_sign
    [[ "$admin" =~ ^[A-Za-z0-9_-]+$ ]] || exit 10
    [[ "$new_ssh" == ssh-ed25519\ * && "$old_ssh" == ssh-ed25519\ * && "$new_ssh" != "$old_ssh" ]] || exit 10
    [[ "$new_sign" == ssh-ed25519\ * ]] || exit 10

    rollback_dir="$(mktemp -d /root/.cf-stage2-rollback.XXXXXX)"
    committed=no
    rollback() {
      rc=$?
      if [[ "$committed" != yes ]]; then
        for label in root admin; do
          meta="$rollback_dir/$label.meta"
          bak="$rollback_dir/$label.authorized_keys"
          if [[ -s "$meta" && -f "$bak" ]]; then
            IFS=: read -r home user gid < "$meta"
            install -d -m 0700 -o "$user" -g "$gid" "$home/.ssh"
            cp -f "$bak" "$home/.ssh/authorized_keys"
            chown "$user:$gid" "$home/.ssh/authorized_keys"
            chmod 0600 "$home/.ssh/authorized_keys"
          fi
        done
        if [[ -f "$rollback_dir/deploy-signing.pub" ]]; then
          cp -f "$rollback_dir/deploy-signing.pub" /etc/capability-fabric/trust/deploy-signing.pub
          chown root:root /etc/capability-fabric/trust/deploy-signing.pub
          chmod 0644 /etc/capability-fabric/trust/deploy-signing.pub
        fi
        if [[ -f "$rollback_dir/deploy-signing-next.pub" ]]; then
          cp -f "$rollback_dir/deploy-signing-next.pub" /etc/capability-fabric/trust/deploy-signing-next.pub
          chown root:root /etc/capability-fabric/trust/deploy-signing-next.pub
          chmod 0644 /etc/capability-fabric/trust/deploy-signing-next.pub
        fi
      fi
      rm -rf "$rollback_dir"
      exit "$rc"
    }
    trap rollback EXIT

    prepare_auth() {
      label="$1"; user="$2"
      entry="$(getent passwd "$user")" || exit 11
      home="$(printf "%s" "$entry" | cut -d: -f6)"
      gid="$(id -g "$user")"
      auth="$home/.ssh/authorized_keys"
      [[ -f "$auth" && ! -L "$auth" ]] || exit 11
      cp -a "$auth" "$rollback_dir/$label.authorized_keys"
      printf "%s:%s:%s\n" "$home" "$user" "$gid" > "$rollback_dir/$label.meta"
      old_count="$(grep -F -c -- "$old_ssh" "$auth" || true)"
      new_count="$(grep -F -c -- "$new_ssh" "$auth" || true)"
      [[ "$old_count" -eq 1 && "$new_count" -eq 1 ]] || {
        echo "CF_STAGE2_AUTH_KEY_CARDINALITY_FAIL=$label" >&2
        exit 12
      }
    }
    prepare_auth root root
    prepare_auth admin "$admin"

    old_trust=/etc/capability-fabric/trust/deploy-signing.pub
    next_trust=/etc/capability-fabric/trust/deploy-signing-next.pub
    [[ -s "$old_trust" && -s "$next_trust" ]] || exit 13
    cp -a "$old_trust" "$rollback_dir/deploy-signing.pub"
    cp -a "$next_trust" "$rollback_dir/deploy-signing-next.pub"
    old_norm="$(awk "NF>=2 {print \\$1 \" \" \\$2; exit}" "$old_trust")"
    next_norm="$(awk "NF>=2 {print \\$1 \" \" \\$2; exit}" "$next_trust")"
    [[ "$next_norm" == "$new_sign" && "$old_norm" != "$new_sign" ]] || {
      echo "CF_STAGE2_TRUST_IDENTITY_MISMATCH" >&2
      exit 14
    }

    cut_auth() {
      label="$1"; user="$2"
      entry="$(getent passwd "$user")"
      home="$(printf "%s" "$entry" | cut -d: -f6)"
      gid="$(id -g "$user")"
      auth="$home/.ssh/authorized_keys"
      t="$(mktemp "$home/.ssh/.authorized_keys.stage2.XXXXXX")"
      awk -v old="$old_ssh" "index(\$0, old)==0 {print}" "$auth" > "$t"
      grep -Fq -- "$new_ssh" "$t" || exit 15
      ! grep -Fq -- "$old_ssh" "$t" || exit 15
      chown "$user:$gid" "$t"
      chmod 0600 "$t"
      mv -f "$t" "$auth"
      [[ "$(stat -c "%U:%G:%a" "$auth")" == "$user:$gid:600" ]] || exit 15
      printf "CF_STAGE2_OLD_SSH_KEY_REMOVED_%s=yes\n" "$label"
    }
    cut_auth root root
    cut_auth admin "$admin"

    t="$(mktemp /etc/capability-fabric/trust/.deploy-signing.stage2.XXXXXX)"
    printf "%s\n" "$new_sign" > "$t"
    chown root:root "$t"
    chmod 0644 "$t"
    mv -f "$t" "$old_trust"
    rm -f "$next_trust"
    [[ "$(awk "NF>=2 {print \\$1 \" \" \\$2; exit}" "$old_trust")" == "$new_sign" ]] || exit 16
    [[ ! -e "$next_trust" ]] || exit 16

    current="$(readlink -f /opt/capability-fabric/current)"
    [[ "$current" == /var/lib/capability-fabric/releases/* ]] || exit 17
    manifest="$current/manifest.json"
    manifest_sha="$(sha256sum "$manifest" | cut -d " " -f1)"
    sig="/var/lib/capability-fabric/signatures/${manifest_sha}.sig"
    [[ -s "$sig" ]] || exit 17
    printf "capability-fabric-deploy %s\n" "$(cat "$old_trust")" > "$rollback_dir/allowed-new"
    ssh-keygen -Y verify -f "$rollback_dir/allowed-new" -I capability-fabric-deploy -n capability-fabric-deploy -s "$sig" < "$manifest" >/dev/null
    timeout 300 env CF_RELEASE_DIR="$current" CF_COMPOSE_PROJECT=capability-fabric bash "$current/health.sh" >/dev/null

    committed=yes
    trap - EXIT
    rm -rf "$rollback_dir"
    printf "CF_STAGE2_TRUST_CUTOVER=pass\n"
    printf "CF_STAGE2_ONLY_NEW_SIGNING_TRUST_ACTIVE=yes\n"
    printf "CF_STAGE2_CURRENT_SIGNATURE_NEW_TRUST=pass\n"
    printf "CF_STAGE2_CURRENT_HEALTH=pass\n"'
