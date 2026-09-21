#!/usr/bin/env bash
set -euo pipefail
umask 077

[[ "$(id -u)" -eq 0 ]] || { echo "must run as uid 0" >&2; exit 1; }

mode="${CF_PCG_PROVISION_SSH_MODE:-install}"
case "$mode" in
  install|install-key|verify) ;;
  *) echo "CF_PCG_PROVISION_SSH_MODE must be install, install-key, or verify" >&2; exit 2 ;;
esac

user_name=pcg-forward
key_dir=/etc/capability-fabric/pcg-forward
authorized_keys="$key_dir/authorized_keys"
sshd_dropin=/etc/ssh/sshd_config.d/80-capability-fabric-pcg-forward.conf
gate=/usr/local/libexec/capability-fabric-pcg-provision-ssh-gate
bootstrap=/run/capability-fabric/pcg-provision/bootstrap-url
port=8766

for cmd in sshd getent install stat ssh-keygen; do
  command -v "$cmd" >/dev/null 2>&1 || { echo "missing required command: $cmd" >&2; exit 3; }
done

verify_effective() {
  local effective
  effective="$(sshd -T -C user="$user_name",host=localhost,addr=127.0.0.1)"
  grep -qx "passwordauthentication no" <<<"$effective"
  grep -qx "kbdinteractiveauthentication no" <<<"$effective"
  grep -qx "permittty no" <<<"$effective"
  grep -qx "x11forwarding no" <<<"$effective"
  grep -qx "allowagentforwarding no" <<<"$effective"
  grep -qx "allowtcpforwarding local" <<<"$effective"
  grep -qx "permitopen 127.0.0.1:$port" <<<"$effective"
  grep -qx "gatewayports no" <<<"$effective"
  grep -qx "permituserenvironment no" <<<"$effective"
  grep -qx "permituserrc no" <<<"$effective"
  grep -qx "forcecommand $gate" <<<"$effective"
  grep -qx "authorizedkeysfile $authorized_keys" <<<"$effective"

  local allowusers
  allowusers="$(awk '$1=="allowusers"{for(i=2;i<=NF;i++)printf "%s%s",$i,(i==NF?"":" ")}' <<<"$effective")"
  if [[ -n "$allowusers" ]]; then
    case " $allowusers " in
      *" $user_name "*) ;;
      *)
        echo "BLOCKED: effective global AllowUsers excludes $user_name" >&2
        exit 24
        ;;
    esac
  fi
}

if [[ "$mode" == verify ]]; then
  [[ -r "$sshd_dropin" ]] || { echo "PCG forwarding sshd drop-in missing" >&2; exit 20; }
  [[ -x "$gate" ]] || { echo "PCG forwarding forced-command gate missing" >&2; exit 21; }
  [[ -f "$authorized_keys" && ! -L "$authorized_keys" ]] || { echo "PCG authorized_keys missing/unsafe" >&2; exit 22; }
  sshd -t
  verify_effective
  if [[ -s "$authorized_keys" ]]; then
    echo "PCG_FORWARD_KEY_INSTALLED=yes"
  else
    echo "PCG_FORWARD_KEY_INSTALLED=no"
  fi
  echo "PCG_FORWARD_SSH_CONTRACT=pass"
  exit 0
fi

if [[ "$mode" == install ]]; then
  prior_dropin=""
  if [[ -f "$sshd_dropin" && ! -L "$sshd_dropin" ]]; then
    prior_dropin="$(mktemp)"
    cp -- "$sshd_dropin" "$prior_dropin"
    rm -f -- "$sshd_dropin"
  fi
  restore_prior_dropin() {
    if [[ -n "$prior_dropin" && -f "$prior_dropin" && ! -f "$sshd_dropin" ]]; then
      install -m 0644 -o root -g root "$prior_dropin" "$sshd_dropin"
    fi
    [[ -z "$prior_dropin" ]] || rm -f -- "$prior_dropin"
  }
  trap restore_prior_dropin EXIT

  existing_effective="$(sshd -T -C user="$user_name",host=localhost,addr=127.0.0.1)"
  existing_allowusers="$(awk '$1=="allowusers"{for(i=2;i<=NF;i++)printf "%s%s",$i,(i==NF?"":" ")}' <<<"$existing_effective")"
  if [[ -n "$existing_allowusers" ]]; then
    case " $existing_allowusers " in
      *" $user_name "*) ;;
      *)
        echo "BLOCKED: existing global AllowUsers excludes $user_name; refusing silent SSH policy widening" >&2
        exit 24
        ;;
    esac
  fi

  if ! getent passwd "$user_name" >/dev/null; then
    useradd --system --no-create-home --home-dir /nonexistent --shell /bin/sh "$user_name"
    usermod --password "*" "$user_name"
  fi

  install -d -m 0755 -o root -g root "$key_dir" /usr/local/libexec /run/capability-fabric/pcg-provision
  if [[ ! -e "$authorized_keys" ]]; then
    install -m 0600 -o root -g root /dev/null "$authorized_keys"
  fi
  [[ -f "$authorized_keys" && ! -L "$authorized_keys" ]] || { echo "unsafe authorized_keys path" >&2; exit 25; }
  chown root:root "$authorized_keys"
  chmod 0600 "$authorized_keys"

  cat > "$gate" <<'GATE'
#!/usr/bin/env bash
set -euo pipefail
bootstrap=/run/capability-fabric/pcg-provision/bootstrap-url
complete=/var/lib/capability-fabric/pcg/run/provision-complete

if [[ -n "${SSH_ORIGINAL_COMMAND:-}" ]]; then
  echo "PCG provisioning account does not accept remote commands." >&2
  exit 64
fi

if [[ -e "$complete" || ! -f "$bootstrap" || -L "$bootstrap" ]]; then
  echo "PCG provisioning is not active." >&2
  exit 65
fi

owner="$(stat -c '%U' "$bootstrap")"
group="$(stat -c '%G' "$bootstrap")"
mode="$(stat -c '%a' "$bootstrap")"
[[ "$owner" == root && "$group" == pcg-forward && "$mode" == 640 ]] || {
  echo "PCG provisioning bootstrap file failed ownership/mode validation." >&2
  exit 66
}

cat "$bootstrap"

# Keep this forced-command session alive while the one-time provisioning window exists so
# the permitted local forward remains usable. No shell or arbitrary command is exposed.
deadline=$((SECONDS + 960))
while [[ $SECONDS -lt $deadline ]]; do
  [[ -e "$complete" ]] && exit 0
  [[ -f "$bootstrap" && ! -L "$bootstrap" ]] || exit 0
  sleep 1
done
exit 0
GATE
  chown root:root "$gate"
  chmod 0755 "$gate"

  cat > "$sshd_dropin" <<EOF
Match User $user_name
    AuthorizedKeysFile $authorized_keys
    AuthenticationMethods publickey
    PubkeyAuthentication yes
    PasswordAuthentication no
    KbdInteractiveAuthentication no
    PermitTTY no
    X11Forwarding no
    AllowAgentForwarding no
    AllowTcpForwarding local
    PermitOpen 127.0.0.1:$port
    GatewayPorts no
    PermitUserRC no
    ForceCommand $gate
EOF
  chown root:root "$sshd_dropin"
  chmod 0644 "$sshd_dropin"

  sshd -t
  verify_effective
  trap - EXIT
  [[ -z "$prior_dropin" ]] || rm -f -- "$prior_dropin"
  if systemctl list-unit-files ssh.service >/dev/null 2>&1; then
    systemctl reload ssh.service
  elif systemctl list-unit-files sshd.service >/dev/null 2>&1; then
    systemctl reload sshd.service
  else
    echo "could not locate ssh/sshd systemd service for safe reload" >&2
    exit 26
  fi
  echo "PCG_FORWARD_SSH_INSTALL=pass"
  if [[ -s "$authorized_keys" ]]; then echo "PCG_FORWARD_KEY_INSTALLED=yes"; else echo "PCG_FORWARD_KEY_INSTALLED=no"; fi
  exit 0
fi

: "${CF_PCG_FORWARD_PUBLIC_KEY:?CF_PCG_FORWARD_PUBLIC_KEY is required}"
[[ -r "$sshd_dropin" && -x "$gate" ]] || { echo "install forwarding SSH boundary first" >&2; exit 30; }

tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT
printf '%s\n' "$CF_PCG_FORWARD_PUBLIC_KEY" | tr -d '\r' > "$tmp"
chmod 0600 "$tmp"
read -r key_type key_data key_comment < "$tmp" || true
[[ "$key_type" == ssh-ed25519 && -n "${key_data:-}" ]] || {
  echo "PCG forwarding key must be a single ssh-ed25519 public key" >&2
  exit 31
}
case "$key_data" in *[!A-Za-z0-9+/=]*) echo "PCG forwarding public key encoding is invalid" >&2; exit 31 ;; esac
ssh-keygen -lf "$tmp" >/dev/null 2>&1 || { echo "PCG forwarding public key failed ssh-keygen validation" >&2; exit 31; }

options="command=\"$gate\",no-agent-forwarding,no-X11-forwarding,no-pty,no-user-rc,permitopen=\"127.0.0.1:$port\""
printf '%s %s %s\n' "$options" "$key_type" "$key_data" > "$authorized_keys"
chown root:root "$authorized_keys"
chmod 0600 "$authorized_keys"

sshd -t
verify_effective
echo "PCG_FORWARD_KEY_INSTALLED=yes"
echo "PCG_FORWARD_SSH_CONTRACT=pass"
