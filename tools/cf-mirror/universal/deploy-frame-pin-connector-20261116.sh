#!/usr/bin/env bash
# Owner-approved, rollback-safe native MCP refresh for exact X11 window pinning and full titlebar frames.
# Only replaces the already deployed cf-mirror-mcp-tools.mjs in the active release.
# Does not alter cf-ops-preload.mjs, Dexa, MCP authentication or other tools.
set -Eeuo pipefail
umask 077
[[ $(id -u) == 0 ]] || { echo 'CFM_DEPLOY_ERROR: root authorization required' >&2; exit 1; }
SOURCE=/home/cfserver/.local/share/cf-mirror-universal/cf-mirror-mcp-tools.mjs
SRC_SHA=bbe72baa85a2b4291d6ad9cd29470fb9c419356c85d185bc1155fa78c5f09461
CONTAINER=capability-fabric-onshape-server
BACKUPS=/var/lib/capability-fabric/cf-mirror-mcp-backups
LIVE=$(readlink -f /opt/capability-fabric/current)
[[ "$LIVE" == /var/lib/capability-fabric/releases/* ]] || { echo 'CFM_DEPLOY_ERROR: unexpected release path' >&2; exit 2; }
TARGET="$LIVE/cf-mirror-mcp-tools.mjs"
PRELOAD="$LIVE/cf-ops-preload.mjs"
[[ -f "$SOURCE" && -f "$TARGET" && -f "$PRELOAD" ]] || { echo 'CFM_DEPLOY_ERROR: missing module/preload' >&2; exit 2; }
[[ "$(sha256sum "$SOURCE" | awk '{print $1}')" == "$SRC_SHA" ]] || { echo 'CFM_DEPLOY_ERROR: source SHA not approved' >&2; exit 2; }
grep -Fq 'file:///release/cf-mirror-mcp-tools.mjs' "$PRELOAD" || { echo 'CFM_DEPLOY_ERROR: mirror preload not installed' >&2; exit 2; }
grep -Fq 'registerCfMirrorUniversalTools' "$TARGET" || { echo 'CFM_DEPLOY_ERROR: deployed module not expected mirror adapter' >&2; exit 2; }
[[ ! -e /var/lib/capability-fabric/state/release-in-progress ]] || { echo 'CFM_DEPLOY_ERROR: CF release in progress' >&2; exit 2; }
[[ "$(docker inspect -f '{{.State.Running}}' "$CONTAINER")" == true ]] || { echo 'CFM_DEPLOY_ERROR: Docker container not running' >&2; exit 2; }
EXPECTED_LIVE="$LIVE" CONTAINER="$CONTAINER" python3 - <<'PY'
import json,os,subprocess
data=json.loads(subprocess.check_output(['docker','inspect',os.environ['CONTAINER']],text=True))[0]
src=os.path.realpath(os.environ['EXPECTED_LIVE'])
assert any(m.get('Destination')=='/release' and os.path.realpath(m.get('Source',''))==src
           for m in data.get('Mounts',[])),'LIVE_RELEASE_NOT_DOCKER_MOUNT'
PY
if [[ "$(sha256sum "$TARGET" | awk '{print $1}')" == "$SRC_SHA" ]]; then
 echo 'CFM_DEPLOY_ALREADY_CURRENT'
 exit 0
fi
node --check "$SOURCE"
mkdir -p "$BACKUPS"
BACKUP=$(mktemp -d "$BACKUPS/owner-contract-XXXXXXXX")
cp -a "$TARGET" "$BACKUP/module.before.mjs"
cp -a "$SOURCE" "$BACKUP/module.next.mjs"
chmod --reference="$TARGET" "$BACKUP/module.next.mjs"
chown --reference="$TARGET" "$BACKUP/module.next.mjs"
node --check "$BACKUP/module.next.mjs"
[[ "$(sha256sum "$BACKUP/module.next.mjs" | awk '{print $1}')" == "$SRC_SHA" ]] || exit 3
PATCHED=0
RESTARTED=0
SUCCESS=0
rollback(){
 rc=$?
 trap - EXIT
 if [[ "$SUCCESS" != 1 && "$PATCHED" == 1 ]]; then
  echo 'CFM_DEPLOY_ROLLBACK_START' >&2
  cp -a "$BACKUP/module.before.mjs" "$TARGET.rollback.$$" || true
  mv -f "$TARGET.rollback.$$" "$TARGET" || true
  if [[ "$RESTARTED" == 1 ]]; then docker restart -t 20 "$CONTAINER" >/dev/null 2>&1 || true; fi
  echo 'CFM_DEPLOY_ROLLBACK_DONE' >&2
 fi
 exit "$rc"
}
trap rollback EXIT
cp -a "$BACKUP/module.next.mjs" "$TARGET.next.$$"
mv -f "$TARGET.next.$$" "$TARGET"
PATCHED=1
RESTARTED=1
docker restart -t 20 "$CONTAINER" >/dev/null
initial_count=$(docker inspect -f '{{.RestartCount}}' "$CONTAINER")
healthy=0
for i in $(seq 1 12); do
 sleep 2
 status=$(docker inspect -f '{{.State.Running}}:{{.State.Restarting}}' "$CONTAINER" 2>/dev/null || echo unknown)
 counter=$(docker inspect -f '{{.RestartCount}}' "$CONTAINER" 2>/dev/null || echo unknown)
 [[ "$status" == true:false && "$counter" == "$initial_count" ]] || { echo 'CFM_DEPLOY_ERROR: container restart loop' >&2; exit 5; }
 # The CF MCP container has no host listener at 127.0.0.1:8769.
 # Validate the actual running container and the installed MCP adapter in
 # its own release mount instead of probing an unrelated/unpublished port.
 if docker exec "$CONTAINER" node --input-type=module -e 'const m=await import("file:///release/cf-mirror-mcp-tools.mjs"); if(typeof m.registerCfMirrorUniversalTools!=="function") process.exit(1)' >/dev/null 2>&1; then ((healthy+=1)) || true; fi
done
[[ "$healthy" -ge 8 ]] || { echo 'CFM_DEPLOY_ERROR: running container or mirror module not stable' >&2; exit 6; }
[[ "$(docker exec "$CONTAINER" sha256sum /release/cf-mirror-mcp-tools.mjs | awk '{print $1}')" == "$SRC_SHA" ]] || { echo 'CFM_DEPLOY_ERROR: container module mismatch' >&2; exit 6; }
docker exec "$CONTAINER" node --input-type=module -e 'const m=await import("file:///release/cf-mirror-mcp-tools.mjs");if(typeof m.registerCfMirrorUniversalTools!=="function")throw Error("MIRROR_MCP_EXPORT_MISSING");console.log("CFM_MCP_IMPORT_OK")'
echo "CFM_FRAME_PIN_DEPLOY_SUCCESS: exact X11 window selectors now active, backup=$BACKUP"
SUCCESS=1
