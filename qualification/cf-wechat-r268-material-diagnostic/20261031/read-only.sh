#!/usr/bin/env bash
# Read-only inspection of the r267 material path and container mount boundary.
set -Eeuo pipefail
umask 027
[[ "$(id -u)" -eq 0 ]] || { echo ROOT_REQUIRED; exit 2; }
log=/tmp/cf-wechat-r268-material-diagnostic.log
{
 echo "TIME=$(date -u +%FT%TZ)"
 echo "HOST_DIRS"
 for p in /var/lib/capability-fabric/pcg/run /var/lib/capability-fabric/pcg/run/material-files; do
  stat -c '%n uid=%u gid=%g perms=%a type=%F' "$p" || true
 done
 echo "CONTAINER_IDENTITY"
 docker exec capability-fabric-onshape-server sh -c 'id; echo UID_MAP; cat /proc/self/uid_map; echo GID_MAP; cat /proc/self/gid_map' || true
 echo "DOCKER_MOUNT_DESTINATIONS"
 docker inspect --format '{{range .Mounts}}{{printf "%s rw=%t\n" .Destination .RW}}{{end}}' capability-fabric-onshape-server || true
 echo "CONTAINER_DIRS"
 docker exec capability-fabric-onshape-server sh -c 'for p in /var/lib/capability-fabric/pcg/run /var/lib/capability-fabric/pcg/run/material-files /tmp/app /tmp/app/.wechat-handoff; do stat -c "%n uid=%u gid=%g perms=%a type=%F" "$p" 2>&1 || true; done' || true
 echo "MATERIAL_SOURCE_CONTAINER_VISIBILITY"
 docker exec capability-fabric-onshape-server test -d /var/lib/capability-fabric/pcg/run/material-files && echo MATERIAL_PATH_PRESENT || echo MATERIAL_PATH_ABSENT_OR_INACCESSIBLE
 echo "CORE_VERSION"
 readlink -f /opt/capability-fabric/current || true
 echo "END"
} >"$log" 2>&1
chgrp 1000 "$log"
chmod 0640 "$log"
echo CF_WECHAT_R268_MATERIAL_DIAGNOSTIC_SAVED
