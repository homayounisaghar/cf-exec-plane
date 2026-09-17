#!/usr/bin/env bash
set -euo pipefail

[[ "$(id -u)" -eq 0 ]] || { echo "must run as uid 0" >&2; exit 1; }

if [[ -r /etc/os-release ]]; then
  . /etc/os-release
else
  echo "missing /etc/os-release" >&2
  exit 1
fi

has_global_v4=no
has_global_v6=no
ip -4 -o addr show scope global 2>/dev/null | grep -q . && has_global_v4=yes || true
ip -6 -o addr show scope global 2>/dev/null | grep -q . && has_global_v6=yes || true

if [[ -f /sys/fs/cgroup/cgroup.controllers ]]; then
  cgroup_v2=yes
else
  cgroup_v2=no
fi

os_lts_declared=no
case "${VERSION:-} ${PRETTY_NAME:-}" in
  *LTS*) os_lts_declared=yes ;;
esac

read_dmi() {
  local path="$1"
  if [[ -r "$path" ]]; then
    tr -d '\000\r\n' < "$path"
  else
    printf 'unknown'
  fi
}

default_iface="$(ip route show default 2>/dev/null | awk 'NR==1 {print $5}')"
[[ -n "$default_iface" ]] || default_iface=unknown

root_fs_bytes="$(df -B1 --output=size / | awk 'NR==2 {gsub(/[[:space:]]/, "", $1); print $1}')"
case "$root_fs_bytes" in ''|*[!0-9]*) echo "could not determine root filesystem size" >&2; exit 2 ;; esac

# Bounded disk-derived log plan. The journal budget is 1% of root, clamped to
# 256 MiB..1 GiB. A journal file is 1/8 of that budget. Retention scales at
# one day per 5 GiB of root, clamped to 7..30 days.
min_journal=$((256 * 1024 * 1024))
max_journal=$((1024 * 1024 * 1024))
journal_max_use_bytes=$((root_fs_bytes / 100))
(( journal_max_use_bytes < min_journal )) && journal_max_use_bytes=$min_journal
(( journal_max_use_bytes > max_journal )) && journal_max_use_bytes=$max_journal
journal_max_file_bytes=$((journal_max_use_bytes / 8))
five_gib=$((5 * 1024 * 1024 * 1024))
log_retention_days=$(((root_fs_bytes + five_gib - 1) / five_gib))
(( log_retention_days < 7 )) && log_retention_days=7
(( log_retention_days > 30 )) && log_retention_days=30

# Inspect TCP/53 without exposing a specific non-loopback server address in a
# public Actions log. Loopback and wildcard bind literals are safe to print.
tcp53_lines="$(ss -H -ltnp '( sport = :53 )' 2>/dev/null || true)"
tcp53_count=0
tcp53_public_exposure=no
resolved_active="$(systemctl is-active systemd-resolved 2>/dev/null || true)"
[[ -n "$resolved_active" ]] || resolved_active=unknown

printf 'CF_INVENTORY_BEGIN\n'
printf 'OS_ID=%s\n' "${ID:-unknown}"
printf 'OS_VERSION_ID=%s\n' "${VERSION_ID:-unknown}"
printf 'OS_VERSION=%s\n' "${VERSION:-unknown}"
printf 'OS_PRETTY_NAME=%s\n' "${PRETTY_NAME:-unknown}"
printf 'OS_VERSION_CODENAME=%s\n' "${VERSION_CODENAME:-unknown}"
printf 'OS_UBUNTU_CODENAME=%s\n' "${UBUNTU_CODENAME:-unknown}"
printf 'OS_LTS_DECLARED=%s\n' "$os_lts_declared"
printf 'KERNEL=%s\n' "$(uname -srmo)"
printf 'ARCH=%s\n' "$(uname -m)"
printf 'VCPU=%s\n' "$(nproc)"
printf 'MEM_TOTAL_KIB=%s\n' "$(awk '/^MemTotal:/ {print $2}' /proc/meminfo)"
printf 'SWAP_TOTAL_KIB=%s\n' "$(awk '/^SwapTotal:/ {print $2}' /proc/meminfo)"
printf 'ROOT_FS_BYTES=%s\n' "$root_fs_bytes"
printf 'ROOT_FS_AVAIL_BYTES=%s\n' "$(df -B1 --output=avail / | awk 'NR==2 {print $1}')"
printf 'ROOT_FS_TYPE=%s\n' "$(findmnt -n -o FSTYPE /)"
printf 'ROOT_SOURCE=%s\n' "$(findmnt -n -o SOURCE /)"
printf 'VIRTUALIZATION=%s\n' "$(systemd-detect-virt 2>/dev/null || printf 'unknown')"
printf 'DMI_VENDOR=%s\n' "$(read_dmi /sys/class/dmi/id/sys_vendor)"
printf 'DMI_PRODUCT=%s\n' "$(read_dmi /sys/class/dmi/id/product_name)"
printf 'CGROUP_V2=%s\n' "$cgroup_v2"
printf 'CGROUP_FS=%s\n' "$(stat -fc %T /sys/fs/cgroup 2>/dev/null || printf 'unknown')"
printf 'DEFAULT_IFACE=%s\n' "$default_iface"
printf 'GLOBAL_IPV4_PRESENT=%s\n' "$has_global_v4"
printf 'GLOBAL_IPV6_PRESENT=%s\n' "$has_global_v6"
printf 'TIME_SYNC=%s\n' "$(timedatectl show -p NTPSynchronized --value 2>/dev/null || printf 'unknown')"
printf 'SSH_SERVICE=%s\n' "$(systemctl is-active ssh 2>/dev/null || systemctl is-active sshd 2>/dev/null || true)"
printf 'SSH_PORTS='; ss -ltn 2>/dev/null | awk 'NR>1 {n=split($4,a,":"); p=a[n]; if (p ~ /^[0-9]+$/) seen[p]=1} END {first=1; for (p in seen) {if (!first) printf ","; printf "%s",p; first=0} printf "\n"}'
printf 'SYSTEMD_RESOLVED_ACTIVE=%s\n' "$resolved_active"
printf 'TCP53_BEGIN\n'
if [[ -n "$tcp53_lines" ]]; then
  while IFS= read -r line; do
    [[ -n "$line" ]] || continue
    tcp53_count=$((tcp53_count + 1))
    local_field="$(awk '{print $4}' <<< "$line")"
    bind_host="${local_field%:53}"
    bind_host="${bind_host%\%*}"
    owner="$(sed -n 's/.*users:(("\([^"]*\)".*/\1/p' <<< "$line")"
    [[ -n "$owner" ]] || owner=unknown
    bind_class=unknown
    bind_display=redacted
    case "$bind_host" in
      127.*|'[::1]'|::1)
        bind_class=loopback
        bind_display="$local_field"
        ;;
      0.0.0.0|'[::]'|::|'*')
        bind_class=wildcard
        bind_display="$local_field"
        tcp53_public_exposure=yes
        ;;
      10.*|192.168.*|169.254.*|172.1[6-9].*|172.2[0-9].*|172.3[01].*|'[fe80:'*|'[fc'*|'[fd'*|fe80:*|fc*|fd*)
        bind_class=private_nonloopback
        bind_display=redacted_private_nonloopback
        ;;
      *)
        bind_class=specific_nonloopback
        bind_display=redacted_specific_nonloopback
        tcp53_public_exposure=yes
        ;;
    esac
    printf 'TCP53_%s_BIND=%s\n' "$tcp53_count" "$bind_display"
    printf 'TCP53_%s_BIND_CLASS=%s\n' "$tcp53_count" "$bind_class"
    printf 'TCP53_%s_OWNER=%s\n' "$tcp53_count" "$owner"
  done <<< "$tcp53_lines"
fi
printf 'TCP53_COUNT=%s\n' "$tcp53_count"
printf 'TCP53_INTERNET_EXPOSURE_POSSIBLE=%s\n' "$tcp53_public_exposure"
printf 'TCP53_END\n'
printf 'LOG_PLAN_BEGIN\n'
printf 'LOG_PLAN_JOURNAL_MAX_USE_BYTES=%s\n' "$journal_max_use_bytes"
printf 'LOG_PLAN_JOURNAL_MAX_FILE_BYTES=%s\n' "$journal_max_file_bytes"
printf 'LOG_PLAN_RETENTION_DAYS=%s\n' "$log_retention_days"
printf 'LOG_PLAN_END\n'
printf 'BLOCK_DEVICES_BEGIN\n'
lsblk -b -o NAME,SIZE,TYPE,FSTYPE,MOUNTPOINTS
printf 'BLOCK_DEVICES_END\n'
printf 'CF_INVENTORY_END\n'
