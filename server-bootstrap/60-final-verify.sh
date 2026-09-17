#!/usr/bin/env bash
set -euo pipefail

[[ "$(id -u)" -eq 0 ]] || { echo "must run as root" >&2; exit 1; }

pass() { printf '%s=pass\n' "$1"; }
fail() { printf '%s=fail\n' "$1" >&2; exit "${2:-1}"; }

printf 'CF_FINAL_VERIFY_BEGIN\n'
sshd -t && pass SSH_CONFIG || fail SSH_CONFIG
[[ "$(ufw status | awk 'NR==1 {print $2}')" == active ]] && pass FIREWALL || fail FIREWALL
[[ "$(systemctl is-enabled unattended-upgrades.service 2>/dev/null || true)" == enabled ]] && pass AUTO_UPDATES || fail AUTO_UPDATES
[[ "$(timedatectl show -p NTPSynchronized --value 2>/dev/null || true)" == yes ]] && pass TIME_SYNC || fail TIME_SYNC
swapon --show=NAME --noheadings | grep -Fxq '/dev/zram0' && pass ZRAM_ACTIVE || fail ZRAM_ACTIVE
swapon --show=NAME --noheadings | grep -Fxq '/swapfile' && pass SWAPFILE_ACTIVE || fail SWAPFILE_ACTIVE
[[ -f /swapfile && "$(stat -c %s /swapfile)" == 4294967296 ]] && pass SWAPFILE_SIZE || fail SWAPFILE_SIZE
[[ "$(systemctl is-active docker 2>/dev/null || true)" == active ]] && pass DOCKER_ACTIVE || fail DOCKER_ACTIVE
[[ -f /sys/fs/cgroup/cgroup.controllers ]] && pass CGROUP_V2 || fail CGROUP_V2
[[ "$(docker info --format '{{.LoggingDriver}}' 2>/dev/null)" == local ]] && pass DOCKER_LOG_DRIVER || fail DOCKER_LOG_DRIVER
[[ -x /usr/local/libexec/capability-fabric-pull-agent ]] && pass PULL_AGENT_INSTALLED || fail PULL_AGENT_INSTALLED
[[ "$(systemctl is-enabled capability-fabric-pull.timer 2>/dev/null || true)" == enabled ]] && pass PULL_TIMER_ENABLED || fail PULL_TIMER_ENABLED
[[ "$(systemctl is-active capability-fabric-pull.timer 2>/dev/null || true)" == active ]] && pass PULL_TIMER_ACTIVE || fail PULL_TIMER_ACTIVE
systemctl cat capability-fabric-pull.service >/dev/null 2>&1 && pass PULL_SERVICE_INSTALLED || fail PULL_SERVICE_INSTALLED
credential=/etc/capability-fabric/secrets/repo-read-token
trust=/etc/capability-fabric/trust/deploy-signing.pub
[[ -s "$credential" && "$(stat -c '%U:%G:%a' "$credential")" == root:root:600 ]] && pass REPO_TOKEN_MODE || fail REPO_TOKEN_MODE
[[ -s "$trust" && "$(stat -c '%U:%G' "$trust")" == root:root ]] && pass DEPLOY_TRUST_PRESENT || fail DEPLOY_TRUST_PRESENT
read -r kt kd extra < "$trust" || true
[[ "$kt" == ssh-ed25519 && -n "${kd:-}" && -z "${extra:-}" ]] && pass DEPLOY_TRUST_FORMAT || fail DEPLOY_TRUST_FORMAT
current=/opt/capability-fabric/current
[[ -L "$current" ]] || fail CURRENT_RELEASE_POINTER
release="$(readlink -f "$current")"
[[ "$release" == /var/lib/capability-fabric/releases/* && -d "$release" ]] || fail CURRENT_RELEASE_POINTER
pass CURRENT_RELEASE_POINTER
[[ -s "$release/manifest.json" && -s "$release/manifest.json.sig" && -s "$release/compose.yaml" && -x "$release/health.sh" ]] || fail CURRENT_RELEASE_FILES
pass CURRENT_RELEASE_FILES
health_timeout="$(python3 - "$release/manifest.json" <<'PY'
import json,sys
with open(sys.argv[1],encoding='utf-8') as f: m=json.load(f)
v=m.get('health_timeout_seconds')
if not isinstance(v,int) or not 5 <= v <= 300: raise SystemExit(1)
print(v)
PY
)"
timeout "$health_timeout" env CF_RELEASE_DIR="$release" CF_COMPOSE_PROJECT=capability-fabric bash "$release/health.sh"
pass CURRENT_RELEASE_HEALTH
proof=/var/lib/capability-fabric/state/backup-restore-proof
[[ -s "$proof" ]] || fail BACKUP_RESTORE_PROOF
[[ "$(awk -F= '$1=="restore_verified" {print $2}' "$proof" | tail -n1)" == yes ]] || fail BACKUP_RESTORE_PROOF
pass BACKUP_RESTORE_PROOF
printf 'CF_FINAL_VERIFY_END\n'
