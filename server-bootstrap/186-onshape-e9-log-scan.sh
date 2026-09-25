#!/usr/bin/env bash
set -euo pipefail
INV=invocation:767b593a-424a-4f9c-aaa2-fb6bbf1dbcde
for c in capability-fabric-onshape-server capability-fabric-onshape-fabric; do
  echo "CF_E9_LOG_CONTAINER=$c"
  docker logs --since 2026-09-25T19:24:40Z --until 2026-09-25T19:25:40Z "$c" 2>&1 | grep -F -C 8 "$INV" || true
done
echo CF_E9_LOG_SCAN=pass
