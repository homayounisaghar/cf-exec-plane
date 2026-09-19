#!/usr/bin/env bash
set -euo pipefail
[[ "$(id -u)" -eq 0 ]] || { echo "must run as uid 0" >&2; exit 1; }

profile=/var/lib/capability-fabric/onshape/browser-profile
active_link=/opt/capability-fabric/current
lock=/run/lock/capability-fabric-pull.lock
expected_release=onshape-single-session-v2-safety-metadata
project=capability-fabric

install -d -m 0755 /run/lock
exec 9>"$lock"
flock -n 9 || { echo "CF_ONSHAPE_RECOVERY=blocked-lock"; exit 20; }

[[ -L "$active_link" ]] || { echo "CF_ONSHAPE_RECOVERY=blocked-no-active"; exit 21; }
active="$(readlink -f "$active_link")"
[[ "$(basename "$active")" == "$expected_release" ]] || { echo "CF_ONSHAPE_RECOVERY=blocked-unexpected-release"; exit 22; }
[[ -d "$profile" ]] || { echo "CF_ONSHAPE_RECOVERY=blocked-profile-missing"; exit 23; }

cid="$(docker inspect -f '{{.State.Running}}' capability-fabric-onshape-server 2>/dev/null || true)"
[[ "$cid" == "true" ]] || { echo "CF_ONSHAPE_RECOVERY=blocked-server-not-running"; exit 24; }
if docker inspect capability-fabric-onshape-chromium >/dev/null 2>&1; then
  echo "CF_ONSHAPE_RECOVERY=blocked-candidate-browser-present"
  exit 25
fi

before_dirs="$(find "$profile" -xdev -type d ! -perm 0700 -print | wc -l | tr -d '[:space:]')"
before_files="$(find "$profile" -xdev -type f -perm /077 -print | wc -l | tr -d '[:space:]')"

find "$profile" -xdev -type d -exec chmod 0700 {} +
find "$profile" -xdev -type f -exec chmod 0600 {} +
chown root:root "$profile"
chmod 0700 "$profile"

after_dirs="$(find "$profile" -xdev -type d ! -perm 0700 -print | wc -l | tr -d '[:space:]')"
after_files="$(find "$profile" -xdev -type f -perm /077 -print | wc -l | tr -d '[:space:]')"
[[ "$after_dirs" == "0" && "$after_files" == "0" ]] || { echo "CF_ONSHAPE_RECOVERY=mode-normalization-failed"; exit 26; }
[[ "$(stat -c '%a %U:%G' "$profile")" == "700 root:root" ]] || { echo "CF_ONSHAPE_RECOVERY=root-invariant-failed"; exit 27; }

timeout_s="$(python3 - "$active/manifest.json" <<'PY'
import json,sys
with open(sys.argv[1], encoding='utf-8') as f:
    print(json.load(f)['health_timeout_seconds'])
PY
)"
if ! timeout "$timeout_s" env CF_RELEASE_DIR="$active" CF_COMPOSE_PROJECT="$project" bash "$active/health.sh"; then
  echo "CF_ONSHAPE_RECOVERY=current-health-failed"
  exit 28
fi

systemctl enable --now capability-fabric-pull.timer >/dev/null
[[ "$(systemctl is-enabled capability-fabric-pull.timer 2>/dev/null)" == "enabled" ]]
[[ "$(systemctl is-active capability-fabric-pull.timer 2>/dev/null)" == "active" ]]

echo CF_ONSHAPE_RECOVERY_BEGIN
echo "ACTIVE_RELEASE=$expected_release"
echo "BAD_DIRS_BEFORE=$before_dirs"
echo "BAD_FILES_BEFORE=$before_files"
echo "BAD_DIRS_AFTER=$after_dirs"
echo "BAD_FILES_AFTER=$after_files"
echo "CURRENT_HEALTH=pass"
echo "PULL_TIMER=enabled-active"
echo CF_ONSHAPE_RECOVERY_END
