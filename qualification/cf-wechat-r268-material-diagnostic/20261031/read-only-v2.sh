#!/usr/bin/env bash
# Read-only on-host mapping of CF material and private writable mount candidates.
set -Eeuo pipefail
umask 027
[[ "$(id -u)" == 0 ]] || exit 2
log=/tmp/cf-wechat-r268-mount-v2-diagnostic.log
{
  echo "TIME=$(date -u +%FT%TZ)"
  echo "CF_RELEASE=$(readlink -f /opt/capability-fabric/current)"
  echo "DOCKER_MOUNTS_SOURCE_DEST_RW"
  docker inspect --format '{{range .Mounts}}{{printf "%s|%s|%t\n" .Source .Destination .RW}}{{end}}' capability-fabric-onshape-server
  echo "HOST_WALK_FOR_RW_CANDIDATES"
  docker inspect --format '{{range .Mounts}}{{printf "%s|%s|%t\n" .Source .Destination .RW}}{{end}}' capability-fabric-onshape-server |
    while IFS='|' read -r source dest writable; do
      case "$dest" in
        /agent-state|/profile|/run/pcg-material-files|/run/pcg)
          echo "MOUNT dest=$dest writable=$writable"
          stat -c '%n uid=%u gid=%g perms=%a type=%F' "$source" 2>&1 || true
          namei -l "$source" 2>&1 || true
          ;;
      esac
    done
  echo "CONTAINER_CANDIDATE_DIRS"
  docker exec capability-fabric-onshape-server sh -c '
    id
    for d in /run/pcg-material-files /run/pcg /agent-state /profile /release /tmp/app; do
      stat -c "%n uid=%u gid=%g perms=%a type=%F" "$d" 2>&1 || true
    done
    test -d /run/pcg-material-files && echo MATERIAL_MOUNT_PRESENT
  '
  echo END
} >"$log" 2>&1
chgrp 1000 "$log"
chmod 0640 "$log"
echo CF_R268_MATERIAL_MOUNT_V2_DIAGNOSTIC_SAVED
