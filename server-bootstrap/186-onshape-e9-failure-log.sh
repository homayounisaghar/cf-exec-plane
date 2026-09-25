#!/usr/bin/env bash
set -euo pipefail
SERVER=capability-fabric-onshape-server
FABRIC=capability-fabric-onshape-fabric
for c in "$SERVER" "$FABRIC"; do
  echo "CF_E9_LOG_CONTAINER=$c"
  docker logs --since '2026-09-25T19:24:50Z' --until '2026-09-25T19:25:30Z' "$c" 2>&1     | grep -E '767b593a|updatePartStudioFeature|mutation|snapshot|guard|authority|error|exception|traceback|failed|fail|ROUTED'     || true
done
echo CF_E9_LOG=pass
