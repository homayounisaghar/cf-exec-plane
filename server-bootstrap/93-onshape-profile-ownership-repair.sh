#!/usr/bin/env bash
set -euo pipefail

[[ "$(id -u)" -eq 0 ]] || { echo "must run as uid 0" >&2; exit 1; }

profile=/var/lib/capability-fabric/onshape/browser-profile
state=/var/lib/capability-fabric/state
gate="$state/release-in-progress"
lock=/run/lock/capability-fabric-pull.lock
active_link=/opt/capability-fabric/current
expected_release=onshape-single-session-v40-write-evidence-fresh-page
backend=capability-fabric-onshape-server
gateway=capability-fabric-onshape-gateway
exclude=/etc/capability-fabric/backup.exclude
backup="/tmp/cf-onshape-profile-repair.$$.$RANDOM.tar"

install -d -m 0755 /run/lock
exec 9>"$lock"
flock -n 9 || { echo "CF_PROFILE_REPAIR=blocked-lock"; exit 20; }

[[ -L "$active_link" ]] || { echo "CF_PROFILE_REPAIR=blocked-no-active"; exit 21; }
active="$(readlink -f "$active_link")"
[[ "$(basename "$active")" == "$expected_release" ]] || { echo "CF_PROFILE_REPAIR=blocked-unexpected-release"; exit 22; }
[[ -d "$profile" ]] || { echo "CF_PROFILE_REPAIR=blocked-profile-missing"; exit 23; }
[[ -f "$exclude" ]] && grep -Fxq "$profile" "$exclude" || { echo "CF_PROFILE_REPAIR=blocked-backup-exclusion"; exit 24; }
[[ "$(docker inspect -f '{{.State.Running}}' "$backend" 2>/dev/null || true)" == true ]] || { echo "CF_PROFILE_REPAIR=blocked-backend-not-running"; exit 25; }
[[ "$(docker inspect -f '{{.State.Running}}' "$gateway" 2>/dev/null || true)" == true ]] || { echo "CF_PROFILE_REPAIR=blocked-gateway-not-running"; exit 26; }
[[ ! -e "$gate" ]] || { echo "CF_PROFILE_REPAIR=blocked-gate-present"; exit 27; }

backend_stopped=0
success=0
cleanup() {
  rc=$?
  if [[ "$success" -eq 1 ]]; then
    rm -f -- "$backup"
  else
    [[ -s "$backup" ]] && echo "CF_PROFILE_REPAIR_BACKUP_RETAINED=yes" || true
    if [[ "$backend_stopped" -eq 1 && "$(docker inspect -f '{{.State.Running}}' "$backend" 2>/dev/null || true)" != true ]]; then
      docker start "$backend" >/dev/null 2>&1 || true
    fi
  fi
  rm -f -- "$gate"
  exit "$rc"
}
trap cleanup EXIT

printf 'profile-ownership-repair\n' > "$gate"
chmod 0644 "$gate"

before_root="$(find "$profile" -xdev -printf '%U:%G\n' | sort | uniq -c | tr '\n' ';')"
echo "CF_PROFILE_REPAIR_OWNER_COUNTS_BEFORE=$before_root"

docker stop -t 20 "$backend" >/dev/null
backend_stopped=1
[[ "$(docker inspect -f '{{.State.Running}}' "$backend")" == false ]] || { echo "CF_PROFILE_REPAIR=backend-stop-failed"; exit 28; }

tar --numeric-owner -cpf "$backup" -C "$(dirname "$profile")" "$(basename "$profile")"
[[ -s "$backup" ]] || { echo "CF_PROFILE_REPAIR=backup-empty"; exit 29; }
tar -tf "$backup" >/dev/null
echo "CF_PROFILE_REPAIR_LOCAL_COPY=pass"

chown -R -h root:root "$profile"
find "$profile" -xdev -type d -exec chmod 0700 {} +
find "$profile" -xdev -type f -exec chmod 0600 {} +

nonroot="$(find "$profile" -xdev \( ! -uid 0 -o ! -gid 0 \) -print | wc -l | tr -d '[:space:]')"
bad_dirs="$(find "$profile" -xdev -type d ! -perm 0700 -print | wc -l | tr -d '[:space:]')"
bad_files="$(find "$profile" -xdev -type f -perm /077 -print | wc -l | tr -d '[:space:]')"
[[ "$nonroot" == 0 && "$bad_dirs" == 0 && "$bad_files" == 0 ]] || { echo "CF_PROFILE_REPAIR=normalization-failed"; exit 30; }

docker start "$backend" >/dev/null
backend_stopped=0
healthy=no
for _ in $(seq 1 150); do
  body="$(curl -fsS --max-time 2 http://127.0.0.1:8788/ 2>/dev/null || true)"
  if [[ "$body" == "cf-onshape-single ok" ]]; then healthy=yes; break; fi
  sleep 1
done
[[ "$healthy" == yes ]] || { echo "CF_PROFILE_REPAIR=backend-health-failed"; exit 31; }

docker exec "$backend" sh -lc 'test -r /profile/Default && test -w /profile/Default && test -r /profile/Default/IndexedDB && test -w /profile/Default/IndexedDB'
echo "CF_PROFILE_REPAIR_CONTAINER_ACCESS=pass"
echo "CF_PROFILE_REPAIR_NONROOT_AFTER=$nonroot"
echo "CF_PROFILE_REPAIR_BAD_DIRS_AFTER=$bad_dirs"
echo "CF_PROFILE_REPAIR_BAD_FILES_AFTER=$bad_files"

success=1
echo "CF_PROFILE_REPAIR=success"
