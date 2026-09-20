#!/usr/bin/env bash
set -euo pipefail
umask 077

[[ "$(id -u)" -eq 0 ]] || { echo "CF_AUTHORITY_REFRESH_REQUIRES_ROOT" >&2; exit 2; }

candidate="server-bootstrap/pull-agent/cf-pull-agent.sh"
live="/usr/local/libexec/capability-fabric-pull-agent"
timer="capability-fabric-pull.timer"
lock="/run/lock/capability-fabric-pull.lock"
cache="/var/lib/capability-fabric/repo.git"
active="/opt/capability-fabric/current"
runtime_path="runtime/onshape/ONSHAPE_RUNTIME_CONTROL.json"
mirror_dir="/var/lib/capability-fabric/onshape/runtime-control"
mirror="$mirror_dir/ONSHAPE_RUNTIME_CONTROL.json"
mirror_blob="$mirror_dir/git-blob-sha"
mirror_commit="$mirror_dir/source-commit"

[[ -s "$candidate" ]] || { echo "CF_AUTHORITY_REFRESH_CANDIDATE_MISSING" >&2; exit 10; }
[[ -s "$live" ]] || { echo "CF_AUTHORITY_REFRESH_LIVE_AGENT_MISSING" >&2; exit 11; }
[[ -L "$active" ]] || { echo "CF_AUTHORITY_REFRESH_ACTIVE_RELEASE_MISSING" >&2; exit 12; }

bash -n "$candidate"
grep -q 'RELEASE_GATE="$STATE/release-in-progress"' "$candidate"
grep -q 'sync_runtime_control()' "$candidate"
grep -q 'RUNTIME_CONTROL_PATH=runtime/onshape/ONSHAPE_RUNTIME_CONTROL.json' "$candidate"

before_active="$(readlink -f "$active")"
[[ "$before_active" == /var/lib/capability-fabric/releases/* ]] || {
  echo "CF_AUTHORITY_REFRESH_ACTIVE_POINTER_INVALID" >&2
  exit 13
}

work="$(mktemp -d /root/.cf-authority-refresh.XXXXXX)"
backup="$work/pull-agent.previous"
cp -a "$live" "$backup"
before_sha="$(sha256sum "$live" | awk '{print $1}')"
candidate_sha="$(sha256sum "$candidate" | awk '{print $1}')"
timer_was_active=no
if systemctl is-active --quiet "$timer"; then
  timer_was_active=yes
fi

installed=no
verified=no
cleanup() {
  rc=$?
  set +e
  if [[ "$verified" != yes && "$installed" == yes && -s "$backup" ]]; then
    install -m 0750 -o root -g root "$backup" "$live"
    echo "CF_AUTHORITY_REFRESH_BINARY_ROLLBACK=performed"
  fi
  if [[ "$timer_was_active" == yes ]]; then
    systemctl start "$timer" >/dev/null 2>&1 || true
  fi
  rm -rf "$work"
  exit "$rc"
}
trap cleanup EXIT

# Prevent timer races while replacing the executable. The same lock is used by
# the pull agent itself, so acquiring it proves no pull cycle is currently in
# its critical section.
systemctl stop "$timer"
install -d -m 0755 -o root -g root /run/lock
exec 9>"$lock"
if ! flock -w 30 9; then
  echo "CF_AUTHORITY_REFRESH_PULL_LOCK_BUSY" >&2
  exit 20
fi

install -m 0750 -o root -g root "$candidate" "$live"
installed=yes
after_install_sha="$(sha256sum "$live" | awk '{print $1}')"
[[ "$after_install_sha" == "$candidate_sha" ]] || {
  echo "CF_AUTHORITY_REFRESH_INSTALL_HASH_MISMATCH" >&2
  exit 21
}

# Release the lock before invoking the new agent. The timer remains stopped, so
# this manual pull is the only possible caller.
flock -u 9
exec 9>&-

pull_output="$("$live" pull 2>&1)" || {
  printf '%s\n' "$pull_output"
  echo "CF_AUTHORITY_REFRESH_PULL_FAILED" >&2
  exit 22
}
printf '%s\n' "$pull_output"

after_active="$(readlink -f "$active")"
[[ "$after_active" == "$before_active" ]] || {
  echo "CF_AUTHORITY_REFRESH_ACTIVE_RELEASE_CHANGED" >&2
  exit 23
}

[[ -s "$cache/HEAD" || -d "$cache/objects" ]] || {
  echo "CF_AUTHORITY_REFRESH_CACHE_MISSING" >&2
  exit 24
}
expected_commit="$(git --git-dir="$cache" rev-parse refs/remotes/origin/main)"
expected_blob="$(git --git-dir="$cache" rev-parse "$expected_commit:$runtime_path")"
actual_blob="$(git hash-object "$mirror")"
stored_blob="$(tr -d '\r\n' < "$mirror_blob")"
stored_commit="$(tr -d '\r\n' < "$mirror_commit")"

[[ "$expected_commit" =~ ^[0-9a-f]{40}$ ]] || { echo "CF_AUTHORITY_REFRESH_EXPECTED_COMMIT_INVALID" >&2; exit 25; }
[[ "$expected_blob" =~ ^[0-9a-f]{40}$ ]] || { echo "CF_AUTHORITY_REFRESH_EXPECTED_BLOB_INVALID" >&2; exit 25; }
[[ "$actual_blob" == "$expected_blob" ]] || { echo "CF_AUTHORITY_REFRESH_MIRROR_HASH_MISMATCH" >&2; exit 26; }
[[ "$stored_blob" == "$expected_blob" ]] || { echo "CF_AUTHORITY_REFRESH_STORED_BLOB_MISMATCH" >&2; exit 27; }
[[ "$stored_commit" == "$expected_commit" ]] || { echo "CF_AUTHORITY_REFRESH_STORED_COMMIT_MISMATCH" >&2; exit 28; }
[[ "$(stat -c '%U:%G:%a' "$mirror")" == "root:root:640" ]] || {
  echo "CF_AUTHORITY_REFRESH_MIRROR_PERMISSIONS_INVALID" >&2
  exit 29
}

if [[ "$timer_was_active" == yes ]]; then
  systemctl start "$timer"
  systemctl is-active --quiet "$timer" || {
    echo "CF_AUTHORITY_REFRESH_TIMER_RESTORE_FAILED" >&2
    exit 30
  }
fi
verified=yes

echo "CF_AUTHORITY_REFRESH_BEGIN"
echo "PREVIOUS_AGENT_SHA256=$before_sha"
echo "INSTALLED_AGENT_SHA256=$after_install_sha"
echo "ACTIVE_RELEASE_UNCHANGED=yes"
echo "AUTHORITY_SOURCE_COMMIT=$expected_commit"
echo "AUTHORITY_GIT_BLOB_SHA=$expected_blob"
echo "AUTHORITY_MIRROR_PERMISSIONS=root:root:640"
echo "AUTHORITY_MIRROR_PROVEN=yes"
echo "TIMER_WAS_ACTIVE=$timer_was_active"
echo "CF_AUTHORITY_REFRESH_END"
