#!/usr/bin/env bash
set -euo pipefail
umask 077

: "${VPS_SSH_KEY:?VPS_SSH_KEY is required}"
: "${VPS_HOST:?VPS_HOST is required}"
: "${VPS_SSH_USER:?VPS_SSH_USER is required}"
: "${VPS_HOST_KEY:?VPS_HOST_KEY is required}"
: "${CF_BACKUP_S3_ENDPOINT:?CF_BACKUP_S3_ENDPOINT is required}"
: "${CF_BACKUP_S3_REGION:?CF_BACKUP_S3_REGION is required}"
: "${CF_BACKUP_S3_BUCKET:?CF_BACKUP_S3_BUCKET is required}"
: "${CF_BACKUP_S3_ACCESS_KEY:?CF_BACKUP_S3_ACCESS_KEY is required}"
: "${CF_BACKUP_S3_SECRET_KEY:?CF_BACKUP_S3_SECRET_KEY is required}"
: "${CF_BACKUP_RESTIC_PASSWORD:?CF_BACKUP_RESTIC_PASSWORD is required}"
port="${VPS_PORT:-22}"
case "$port" in ''|*[!0-9]*) echo "VPS_PORT must be numeric" >&2; exit 2 ;; esac
case "$VPS_SSH_USER" in ''|*[!a-zA-Z0-9_-]*) echo "VPS_SSH_USER contains unsupported characters" >&2; exit 2 ;; esac
case "$CF_BACKUP_S3_ENDPOINT" in *://*|*/*|*' '*|'') echo "backup endpoint must be a bare S3 hostname" >&2; exit 2 ;; esac
case "$CF_BACKUP_S3_REGION" in ''|*[!a-zA-Z0-9-]*) echo "backup region is malformed" >&2; exit 2 ;; esac
case "$CF_BACKUP_S3_BUCKET" in ''|*[!a-z0-9.-]*) echo "backup bucket is malformed" >&2; exit 2 ;; esac
for v in CF_BACKUP_S3_ACCESS_KEY CF_BACKUP_S3_SECRET_KEY CF_BACKUP_RESTIC_PASSWORD; do
  value="${!v}"
  [[ "$value" != *$'\n'* && "$value" != *$'\r'* ]] || { echo "$v must be one line" >&2; exit 2; }
done

repository="s3:https://${CF_BACKUP_S3_ENDPOINT}/${CF_BACKUP_S3_BUCKET}/capability-fabric-personal-server"
printf -v q_repo '%q' "$repository"
printf -v q_pass '%q' "$CF_BACKUP_RESTIC_PASSWORD"
printf -v q_access '%q' "$CF_BACKUP_S3_ACCESS_KEY"
printf -v q_secret '%q' "$CF_BACKUP_S3_SECRET_KEY"
printf -v q_region '%q' "$CF_BACKUP_S3_REGION"
payload=$(printf 'RESTIC_REPOSITORY=%s\nRESTIC_PASSWORD=%s\nAWS_ACCESS_KEY_ID=%s\nAWS_SECRET_ACCESS_KEY=%s\nAWS_DEFAULT_REGION=%s\n' "$q_repo" "$q_pass" "$q_access" "$q_secret" "$q_region")

key_file="$(mktemp "${RUNNER_TEMP:-/tmp}/cf-vps-key.XXXXXX")"
known_hosts="$(mktemp "${RUNNER_TEMP:-/tmp}/cf-known-hosts.XXXXXX")"
trap 'rm -f "$key_file" "$known_hosts"' EXIT
printf '%s\n' "$VPS_SSH_KEY" > "$key_file"; chmod 0600 "$key_file"
host_key_line="${VPS_HOST_KEY//$'\r'/}"
read -r key_type key_data extra <<< "$host_key_line"
[[ "$key_type" == ssh-ed25519 && -n "$key_data" && -z "${extra:-}" ]] || exit 3
printf '%s %s %s\n' "$VPS_HOST" "$key_type" "$key_data" > "$known_hosts"
printf '[%s]:%s %s %s\n' "$VPS_HOST" "$port" "$key_type" "$key_data" >> "$known_hosts"; chmod 0600 "$known_hosts"

printf '%s' "$payload" | ssh -i "$key_file" -p "$port" -o BatchMode=yes -o IdentitiesOnly=yes \
  -o StrictHostKeyChecking=yes -o UserKnownHostsFile="$known_hosts" -o ConnectTimeout=15 \
  "${VPS_SSH_USER}@${VPS_HOST}" \
  'set -euo pipefail; umask 077; install -d -m 0755 -o root -g root /etc/capability-fabric; t=$(mktemp /etc/capability-fabric/.backup-env.XXXXXX); trap '\''rm -f "$t"'\'' EXIT; cat > "$t"; test -s "$t"; chown root:root "$t"; chmod 0600 "$t"; mv -f "$t" /etc/capability-fabric/backup.env; trap - EXIT; printf "CF_BACKUP_CONFIG_INSTALL=ok\n"'
