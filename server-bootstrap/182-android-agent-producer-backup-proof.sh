#!/usr/bin/env bash
set -euo pipefail
umask 077

[[ "$(id -u)" -eq 0 ]] || { echo "must run as root" >&2; exit 1; }

producer=/etc/capability-fabric/secrets/android-agent/producer-p256-v1.pem
backup=/usr/local/libexec/capability-fabric-backup
config=/etc/capability-fabric/backup.env

[[ -s "$producer" ]] || { echo "producer key missing" >&2; exit 10; }
[[ "$(stat -c '%U:%G:%a' "$producer")" == root:root:600 ]] || { echo "producer key permissions unsafe" >&2; exit 11; }
[[ -x "$backup" ]] || { echo "installed backup executable missing" >&2; exit 12; }
[[ -s "$config" ]] || { echo "backup config missing" >&2; exit 13; }

backup_out="$("$backup" run)"
printf '%s
' "$backup_out"
snapshot_id="$(printf '%s
' "$backup_out" | awk -F= '$1=="SNAPSHOT_ID"{print $2}' | tail -n1)"
[[ "$snapshot_id" =~ ^[0-9a-f]{64}$ ]] || { echo "snapshot id missing" >&2; exit 14; }

set -a
# shellcheck disable=SC1090
. "$config"
set +a

for name in RESTIC_REPOSITORY RESTIC_PASSWORD AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_DEFAULT_REGION; do
  [[ -n "${!name:-}" ]] || { echo "backup config missing $name" >&2; exit 15; }
done

listing="$(restic ls "$snapshot_id" --json)"
python3 - "$producer" <<'PY' <<<"$listing"
import json,sys
producer=sys.argv[1]
found=False
for line in sys.stdin:
    try:
        obj=json.loads(line)
    except Exception:
        continue
    if obj.get("struct_type")=="node" and obj.get("path")==producer:
        found=True
        break
if not found:
    raise SystemExit("producer key absent from snapshot")
PY

printf 'CF_PAA_PRODUCER_BACKUP=pass
'
printf 'CF_PAA_PRODUCER_BACKUP_SNAPSHOT=%s
' "$snapshot_id"
