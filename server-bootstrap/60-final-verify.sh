#!/usr/bin/env bash
set -euo pipefail
umask 077

[[ "$(id -u)" -eq 0 ]] || { echo "must run as root" >&2; exit 1; }

pass() { printf '%s=pass\n' "$1"; }
fail() { printf '%s=fail\n' "$1" >&2; exit "${2:-1}"; }

tmpdir="$(mktemp -d /tmp/cf-final-verify.XXXXXX)"
trap 'rm -rf "$tmpdir"' EXIT

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

aagent=/usr/local/libexec/capability-fabric-pull-agent
[[ -x "$aagent" ]] && pass PULL_AGENT_INSTALLED || fail PULL_AGENT_INSTALLED
systemctl cat capability-fabric-pull.service >/dev/null 2>&1 && pass PULL_SERVICE_INSTALLED || fail PULL_SERVICE_INSTALLED
[[ "$(systemctl is-enabled capability-fabric-pull.timer 2>/dev/null || true)" == enabled ]] && pass PULL_TIMER_ENABLED || fail PULL_TIMER_ENABLED
[[ "$(systemctl is-active capability-fabric-pull.timer 2>/dev/null || true)" == active ]] && pass PULL_TIMER_ACTIVE || fail PULL_TIMER_ACTIVE

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

manifest_sha="$(sha256sum "$release/manifest.json" | awk '{print $1}')"
[[ "$manifest_sha" =~ ^[0-9a-f]{64}$ ]] || fail CURRENT_RELEASE_SIGNATURE
cache_sig="/var/lib/capability-fabric/signatures/${manifest_sha}.sig"
[[ -s "$cache_sig" ]] || fail CURRENT_RELEASE_SIGNATURE
cmp -s "$release/manifest.json.sig" "$cache_sig" || fail CURRENT_RELEASE_SIGNATURE
printf 'capability-fabric-deploy %s %s\n' "$kt" "$kd" > "$tmpdir/allowed-signers"
if ssh-keygen -Y verify -f "$tmpdir/allowed-signers" -I capability-fabric-deploy -n capability-fabric-deploy -s "$release/manifest.json.sig" < "$release/manifest.json" >/dev/null 2>&1; then
  pass CURRENT_RELEASE_SIGNATURE
else
  fail CURRENT_RELEASE_SIGNATURE
fi

health_timeout="$(python3 - "$release/manifest.json" <<'PY'
import json,sys
with open(sys.argv[1],encoding='utf-8') as f: m=json.load(f)
v=m.get('health_timeout_seconds')
if not isinstance(v,int) or not 5 <= v <= 300: raise SystemExit(1)
print(v)
PY
)"
timeout "$health_timeout" env CF_RELEASE_DIR="$release" CF_COMPOSE_PROJECT=capability-fabric bash "$release/health.sh" >/dev/null
pass CURRENT_RELEASE_HEALTH

backup_exec=/usr/local/libexec/capability-fabric-backup
backup_env=/etc/capability-fabric/backup.env
[[ -x "$backup_exec" ]] && pass BACKUP_EXEC_INSTALLED || fail BACKUP_EXEC_INSTALLED
systemctl cat capability-fabric-backup.service >/dev/null 2>&1 && pass BACKUP_SERVICE_INSTALLED || fail BACKUP_SERVICE_INSTALLED
[[ "$(systemctl is-enabled capability-fabric-backup.timer 2>/dev/null || true)" == enabled ]] && pass BACKUP_TIMER_ENABLED || fail BACKUP_TIMER_ENABLED
[[ "$(systemctl is-active capability-fabric-backup.timer 2>/dev/null || true)" == active ]] && pass BACKUP_TIMER_ACTIVE || fail BACKUP_TIMER_ACTIVE
[[ -s "$backup_env" && "$(stat -c '%U:%G:%a' "$backup_env")" == root:root:600 ]] && pass BACKUP_CONFIG_MODE || fail BACKUP_CONFIG_MODE
command -v restic >/dev/null 2>&1 && pass RESTIC_INSTALLED || fail RESTIC_INSTALLED

proof=/var/lib/capability-fabric/state/backup-restore-proof
[[ -s "$proof" && "$(stat -c '%U:%G:%a' "$proof")" == root:root:600 ]] || fail BACKUP_RESTORE_PROOF
snapshot_id="$(awk -F= '$1=="snapshot_id" {print $2}' "$proof" | tail -n1)"
restore_verified="$(awk -F= '$1=="restore_verified" {print $2}' "$proof" | tail -n1)"
verified_at="$(awk -F= '$1=="verified_at" {print $2}' "$proof" | tail -n1)"
[[ "$snapshot_id" =~ ^[0-9a-f]{64}$ && "$restore_verified" == yes && -n "$verified_at" ]] || fail BACKUP_RESTORE_PROOF
pass BACKUP_RESTORE_PROOF

set -a
# shellcheck disable=SC1090
. "$backup_env"
set +a
for name in RESTIC_REPOSITORY RESTIC_PASSWORD AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_DEFAULT_REGION; do
  [[ -n "${!name:-}" ]] || fail BACKUP_REMOTE_SNAPSHOT
 done
case "$RESTIC_REPOSITORY" in s3:https://*) ;; *) fail BACKUP_REMOTE_SNAPSHOT ;; esac
if ! restic snapshots --json --tag capability-fabric-personal-server > "$tmpdir/snapshots.json" 2> "$tmpdir/restic.err"; then
  fail BACKUP_REMOTE_SNAPSHOT
fi
if python3 - "$tmpdir/snapshots.json" "$snapshot_id" <<'PY'
import json,sys
with open(sys.argv[1],encoding='utf-8') as f: rows=json.load(f)
target=sys.argv[2]
raise SystemExit(0 if any(isinstance(x,dict) and x.get('id')==target for x in rows) else 1)
PY
then
  pass BACKUP_REMOTE_SNAPSHOT
else
  fail BACKUP_REMOTE_SNAPSHOT
fi

printf 'CF_FINAL_VERIFY_END\n'
