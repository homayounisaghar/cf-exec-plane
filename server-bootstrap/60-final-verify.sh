#!/usr/bin/env bash
set -euo pipefail

[[ "$(id -u)" -eq 0 ]] || { echo "must run as uid 0" >&2; exit 1; }

printf 'CF_FINAL_VERIFY_BEGIN\n'
printf 'SSH_CONFIG_OK='; sshd -t && printf 'yes\n'
printf 'FIREWALL=%s\n' "$(ufw status | awk 'NR==1 {print $2}')"
printf 'AUTO_UPDATES=%s\n' "$(systemctl is-enabled unattended-upgrades.service 2>/dev/null || true)"
printf 'TIME_SYNC=%s\n' "$(timedatectl show -p NTPSynchronized --value 2>/dev/null || printf 'unknown')"
printf 'ZRAM_ACTIVE=%s\n' "$(swapon --show=NAME --noheadings | grep -q '/dev/zram0' && printf yes || printf no)"
printf 'SWAPFILE_ACTIVE=%s\n' "$(swapon --show=NAME --noheadings | grep -qx '/swapfile' && printf yes || printf no)"
printf 'DOCKER_ACTIVE=%s\n' "$(systemctl is-active docker 2>/dev/null || true)"
printf 'CGROUP_V2=%s\n' "$( [[ -f /sys/fs/cgroup/cgroup.controllers ]] && printf yes || printf no )"
printf 'PULL_AGENT_ACTIVE=%s\n' "$(systemctl is-active cf-pull-agent.timer 2>/dev/null || true)"
printf 'CF_FINAL_VERIFY_END\n'
