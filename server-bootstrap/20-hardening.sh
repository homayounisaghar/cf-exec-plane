#!/usr/bin/env bash
set -euo pipefail

[[ "$(id -u)" -eq 0 ]] || { echo "must run as uid 0" >&2; exit 1; }
: "${VPS_SSH_PORT:?VPS_SSH_PORT is required}"
: "${CF_ADMIN_USER:?CF_ADMIN_USER is required}"
: "${CF_SWAPFILE_BYTES:?CF_SWAPFILE_BYTES is required}"

case "$VPS_SSH_PORT" in
  ''|*[!0-9]*) echo "VPS_SSH_PORT must be numeric" >&2; exit 2 ;;
esac
case "$CF_ADMIN_USER" in
  ''|*[!a-zA-Z0-9_-]*) echo "CF_ADMIN_USER contains unsupported characters" >&2; exit 2 ;;
esac
case "$CF_SWAPFILE_BYTES" in
  ''|*[!0-9]*) echo "CF_SWAPFILE_BYTES must be numeric" >&2; exit 2 ;;
esac
min_swap=$((2 * 1024 * 1024 * 1024))
max_swap=$((4 * 1024 * 1024 * 1024))
if (( CF_SWAPFILE_BYTES < min_swap || CF_SWAPFILE_BYTES > max_swap )); then
  echo "CF_SWAPFILE_BYTES must be within the agreed 2-4 GiB range" >&2
  exit 2
fi

. /etc/os-release
if [[ "${ID:-}" != "ubuntu" ]]; then
  echo "PHASE2_OS_DECISION_REQUIRED: expected Ubuntu; observed ${ID:-unknown} ${VERSION_ID:-unknown}. No mutation performed." >&2
  exit 11
fi
case "${VERSION:-} ${PRETTY_NAME:-}" in
  *LTS*) ;;
  *)
    echo "PHASE2_OS_DECISION_REQUIRED: observed Ubuntu ${VERSION_ID:-unknown} without an LTS declaration. No mutation performed." >&2
    exit 11
    ;;
esac

ssh_connection="${SSH_CONNECTION:-}"
[[ -n "$ssh_connection" ]] || { echo "SSH_CONNECTION is unavailable; refusing to change firewall state" >&2; exit 7; }
read -r _client_ip _client_port _server_ip actual_ssh_port <<<"$ssh_connection"
case "$actual_ssh_port" in
  ''|*[!0-9]*) echo "could not determine actual SSH listener port from SSH_CONNECTION" >&2; exit 7 ;;
esac
if [[ "$actual_ssh_port" != "$VPS_SSH_PORT" ]]; then
  echo "SSH port mismatch: authenticated session reached server port $actual_ssh_port but VPS_SSH_PORT=$VPS_SSH_PORT; refusing before firewall changes" >&2
  exit 8
fi

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y sudo ufw unattended-upgrades logrotate ca-certificates

admin_user="$CF_ADMIN_USER"
if ! id "$admin_user" >/dev/null 2>&1; then
  useradd --create-home --shell /bin/bash "$admin_user"
fi
usermod -aG sudo "$admin_user"
passwd -l "$admin_user" >/dev/null 2>&1 || true

uid0_home="$(getent passwd 0 | awk -F: 'NR==1 {print $6}')"
[[ -n "$uid0_home" ]] || { echo "could not determine uid-0 home" >&2; exit 4; }
uid0_auth="$uid0_home/.ssh/authorized_keys"
[[ -s "$uid0_auth" ]] || { echo "uid-0 authorized_keys is missing or empty" >&2; exit 4; }
install -d -m 0700 -o "$admin_user" -g "$admin_user" "/home/$admin_user/.ssh"
install -m 0600 -o "$admin_user" -g "$admin_user" "$uid0_auth" "/home/$admin_user/.ssh/authorized_keys"

sudoers_file=/etc/sudoers.d/90-cf-admin
sudoers_content="$admin_user ALL=(ALL:ALL) NOPASSWD:ALL"
if [[ ! -f "$sudoers_file" ]] || [[ "$(cat "$sudoers_file")" != "$sudoers_content" ]]; then
  printf '%s\n' "$sudoers_content" > "$sudoers_file"
  chmod 0440 "$sudoers_file"
fi
visudo -cf "$sudoers_file" >/dev/null

ssh_dropin=/etc/ssh/sshd_config.d/60-cf-hardening.conf
install -d -m 0755 /etc/ssh/sshd_config.d
cat > "${ssh_dropin}.new" <<'CFG'
PasswordAuthentication no
KbdInteractiveAuthentication no
ChallengeResponseAuthentication no
PubkeyAuthentication yes
PermitEmptyPasswords no
PermitRootLogin prohibit-password
CFG
if [[ ! -f "$ssh_dropin" ]] || ! cmp -s "${ssh_dropin}.new" "$ssh_dropin"; then
  mv "${ssh_dropin}.new" "$ssh_dropin"
else
  rm -f "${ssh_dropin}.new"
fi
sshd -t
if systemctl list-unit-files ssh.service | grep -q '^ssh.service'; then
  systemctl reload ssh
else
  systemctl reload sshd
fi

root_fs_bytes="$(df -B1 --output=size / | awk 'NR==2 {gsub(/[[:space:]]/, "", $1); print $1}')"
case "$root_fs_bytes" in
  ''|*[!0-9]*) echo "could not determine root filesystem size" >&2; exit 9 ;;
esac
(( root_fs_bytes > 0 )) || { echo "root filesystem size is zero" >&2; exit 9; }
journal_max_use_bytes=$((root_fs_bytes / 50))
journal_max_file_bytes=$((journal_max_use_bytes / 8))
two_gib=$((2 * 1024 * 1024 * 1024))
retention_days=$(((root_fs_bytes + two_gib - 1) / two_gib))
(( journal_max_use_bytes > 0 && journal_max_file_bytes > 0 && retention_days > 0 )) || {
  echo "derived log limits are invalid" >&2
  exit 9
}

install -d -m 0755 /etc/systemd/journald.conf.d
cat > /etc/systemd/journald.conf.d/20-cf-limits.conf <<CFG
[Journal]
Storage=persistent
SystemMaxUse=${journal_max_use_bytes}
SystemMaxFileSize=${journal_max_file_bytes}
MaxRetentionSec=${retention_days}day
CFG
systemctl restart systemd-journald

install -d -m 0750 -o root -g root /var/log/capability-fabric
cat > /etc/logrotate.d/capability-fabric <<CFG
/var/log/capability-fabric/*.log {
    daily
    rotate ${retention_days}
    maxsize ${journal_max_file_bytes}
    missingok
    notifempty
    compress
    delaycompress
    copytruncate
    su root root
}
CFG
logrotate -d /etc/logrotate.conf >/dev/null 2>&1

ufw default deny incoming
ufw default allow outgoing
if ! ufw status | grep -Eq "(^|[[:space:]])${VPS_SSH_PORT}/tcp([[:space:]]|$).*LIMIT"; then
  ufw limit "${VPS_SSH_PORT}/tcp"
fi
ufw --force enable

cat > /etc/apt/apt.conf.d/20auto-upgrades <<'CFG'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
CFG
systemctl enable --now unattended-upgrades.service >/dev/null 2>&1 || true

if systemctl list-unit-files systemd-timesyncd.service | grep -q '^systemd-timesyncd.service'; then
  timedatectl set-ntp true
  systemctl enable --now systemd-timesyncd.service
fi

zram_provider=none
if apt-cache show systemd-zram-generator >/dev/null 2>&1; then
  apt-get install -y systemd-zram-generator
  cat > /etc/systemd/zram-generator.conf <<'CFG'
[zram0]
CFG
  systemctl daemon-reload
  systemctl restart systemd-zram-setup@zram0.service 2>/dev/null || true
  zram_provider=systemd-zram-generator
elif apt-cache show zram-tools >/dev/null 2>&1; then
  apt-get install -y zram-tools
  systemctl enable --now zramswap.service
  zram_provider=zram-tools
else
  echo "no supported zram package is available" >&2
  exit 5
fi

zram_bytes="$(lsblk -b -dn -o SIZE /dev/zram0 2>/dev/null || true)"
if [[ -z "$zram_bytes" || "$zram_bytes" -le 0 ]]; then
  zram_bytes="$(cat /sys/block/zram0/disksize 2>/dev/null || true)"
fi
if [[ -z "$zram_bytes" || "$zram_bytes" -le 0 ]]; then
  echo "zram device did not become available" >&2
  exit 6
fi

swapfile=/swapfile
if [[ -f "$swapfile" ]]; then
  existing_size="$(stat -c %s "$swapfile")"
  if [[ "$existing_size" != "$CF_SWAPFILE_BYTES" ]]; then
    echo "existing swapfile size differs from requested size; refusing automatic resize" >&2
    exit 10
  fi
else
  fallocate -l "$CF_SWAPFILE_BYTES" "$swapfile"
  chmod 0600 "$swapfile"
  mkswap "$swapfile" >/dev/null
fi
if ! swapon --show=NAME --noheadings | grep -Fxq "$swapfile"; then
  swapon "$swapfile"
fi
if ! grep -Eq '^/swapfile[[:space:]]+none[[:space:]]+swap[[:space:]]' /etc/fstab; then
  printf '/swapfile none swap sw 0 0\n' >> /etc/fstab
fi

printf 'CF_HARDENING_BEGIN\n'
printf 'ADMIN_USER_CONFIGURED=yes\n'
printf 'SSH_PORT_EXPECTED=%s\n' "$VPS_SSH_PORT"
printf 'SSH_PORT_ACTUAL=%s\n' "$actual_ssh_port"
printf 'UFW_STATUS=%s\n' "$(ufw status | awk 'NR==1 {print $2}')"
printf 'PASSWORD_AUTH_EFFECTIVE=%s\n' "$(sshd -T | awk '$1=="passwordauthentication" {print $2; exit}')"
printf 'ROOT_LOGIN_EFFECTIVE=%s\n' "$(sshd -T | awk '$1=="permitrootlogin" {print $2; exit}')"
printf 'TIME_SYNC=%s\n' "$(timedatectl show -p NTPSynchronized --value 2>/dev/null || printf 'unknown')"
printf 'ROOT_FS_BYTES=%s\n' "$root_fs_bytes"
printf 'JOURNAL_MAX_USE_BYTES=%s\n' "$journal_max_use_bytes"
printf 'JOURNAL_MAX_FILE_BYTES=%s\n' "$journal_max_file_bytes"
printf 'LOG_RETENTION_DAYS=%s\n' "$retention_days"
printf 'ZRAM_PROVIDER=%s\n' "$zram_provider"
printf 'ZRAM_BYTES=%s\n' "$zram_bytes"
printf 'SWAPFILE_BYTES=%s\n' "$(stat -c %s "$swapfile")"
printf 'JOURNAL_DISK_USAGE=%s\n' "$(journalctl --disk-usage 2>/dev/null | tr '\n' ' ')"
printf 'CF_HARDENING_END\n'
