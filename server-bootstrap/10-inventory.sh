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
printf 'ROOT_FS_BYTES=%s\n' "$(df -B1 --output=size / | awk 'NR==2 {print $1}')"
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
printf 'BLOCK_DEVICES_BEGIN\n'
lsblk -b -o NAME,SIZE,TYPE,FSTYPE,MOUNTPOINTS
printf 'BLOCK_DEVICES_END\n'
printf 'CF_INVENTORY_END\n'
