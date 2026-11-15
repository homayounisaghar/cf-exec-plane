#!/usr/bin/env bash
# CF mirror MCP: minimal, restart-persistent fix for missing /tmp/app module.
# The already mounted /release module is imported by absolute file URL.
# Preflight -> backup -> stage/validate -> atomic patch -> restart/health -> rollback.
set -Eeuo pipefail
umask 077
C=capability-fabric-onshape-server
MODULE=/home/cfserver/.local/share/cf-mirror-universal/cf-mirror-mcp-tools.mjs
EXPECTED=528f05014eeb8777ef17abd6d324a83381677008e5470b38a23eb3b9aebbc1c3
BACKUP_ROOT=/var/lib/capability-fabric/cf-mirror-mcp-backups
LIVE=$(readlink -f /opt/capability-fabric/current)
PRELOAD="$LIVE/cf-ops-preload.mjs"
RELEASE_MODULE="$LIVE/cf-mirror-mcp-tools.mjs"
MOD_IMPORT='file:///release/cf-mirror-mcp-tools.mjs'
PATCHED=0
RESTART_ATTEMPTED=0
SUCCESS=0
BACKUP=''
fail(){ echo "CF_MIRROR_FAIL: $*" >&2; exit 1; }
rollback(){
  rc=$?
  trap - EXIT
  if [[ "$SUCCESS" != 1 && "$PATCHED" == 1 ]]; then
    echo "CF_MIRROR_ROLLBACK: restoring previous preload" >&2
    cp -a "$BACKUP/preload.before.mjs" "$PRELOAD.rollback.$$" || true
    mv -f "$PRELOAD.rollback.$$" "$PRELOAD" || true
    if [[ "$RESTART_ATTEMPTED" == 1 ]]; then
      docker restart -t 20 "$C" >/dev/null 2>&1 || true
      sleep 5
      echo "CF_MIRROR_ROLLBACK_STATUS: $(docker inspect -f '{{.State.Running}}' "$C" 2>/dev/null || echo unknown)" >&2
    fi
  fi
  exit "$rc"
}
trap rollback EXIT
[[ $(id -u) == 0 ]] || fail 'must be run with sudo'
[[ -f "$MODULE" && -f "$RELEASE_MODULE" && -f "$PRELOAD" ]] || fail 'missing staged module or live files'
[[ "$LIVE" == /var/lib/capability-fabric/releases/* ]] || fail 'unexpected live release path'
[[ "$(sha256sum "$MODULE" | cut -d' ' -f1)" == "$EXPECTED" ]] || fail 'owner module hash changed'
[[ "$(sha256sum "$RELEASE_MODULE" | cut -d' ' -f1)" == "$EXPECTED" ]] || fail 'release module differs from approved version'
[[ "$(docker inspect -f '{{.State.Running}}' "$C")" == true ]] || fail 'CF Docker not running'
[[ ! -e /var/lib/capability-fabric/state/release-in-progress ]] || fail 'another CF release is in progress'
# Verify /release in the container is the currently active host release.
EXPECTED_LIVE="$LIVE" CONTAINER="$C" python3 - <<'PY'
import json,os,subprocess
data=json.loads(subprocess.check_output(['docker','inspect',os.environ['CONTAINER']],text=True))[0]
src=os.path.realpath(os.environ['EXPECTED_LIVE'])
mounts=data.get('Mounts') or []
assert any(m.get('Destination')=='/release' and os.path.realpath(m.get('Source',''))==src for m in mounts), 'Docker /release mount is not the active host release'
cmd=' '.join(str(x) for x in (data.get('Config',{}).get('Cmd') or []))
assert '/release/cf-ops-preload.mjs' in cmd and '/tmp/app/' in cmd, 'container startup copy recipe unexpected'
print('PRECHECK_OK: Docker copies the live preload into /tmp/app, and /release is mounted')
PY
docker exec "$C" sh -c 'test -f /tmp/app/cf-ops-preload.mjs && test -f /release/cf-mirror-mcp-tools.mjs' || fail 'expected Docker files not present'
docker exec "$C" sha256sum /release/cf-mirror-mcp-tools.mjs | grep -Fq "$EXPECTED" || fail 'container sees a different module'
docker exec "$C" node --input-type=module -e 'const m=await import("file:///release/cf-mirror-mcp-tools.mjs");if(typeof m.registerCfMirrorUniversalTools!=="function")throw Error("MCP adapter export missing");console.log("MODULE_IMPORT_OK")'
grep -Fq 'export function callerIdentity' "$LIVE/cf-ops-tools.mjs" || fail 'callerIdentity unavailable'
if grep -Fq "$MOD_IMPORT" "$PRELOAD" && grep -Fq 'registerCfMirrorUniversalTools(this,z,{callAgent,callerIdentity});' "$PRELOAD"; then
  echo 'ALREADY_INSTALLED: absolute release import and registration exist'
  SUCCESS=1
  exit 0
fi
# Fail closed if the previous deployment is still half-applied.
grep -Fq 'import { registerCfOpsTools, callAgent } from "./cf-ops-tools.mjs";' "$PRELOAD" || fail 'current preload does not match the known healthy version'
grep -Fq '    registerGatewayTools(this,z);' "$PRELOAD" || fail 'registration anchor missing'
if grep -Fq 'registerCfMirrorUniversalTools' "$PRELOAD"; then
  fail 'partial/unknown mirror patch detected; will not overwrite it'
fi
mkdir -p "$BACKUP_ROOT"
BACKUP=$(mktemp -d "$BACKUP_ROOT/absolute-import-XXXXXXXX")
cp -a "$PRELOAD" "$BACKUP/preload.before.mjs"
# Stage patch off-line; all validation occurs BEFORE editing the live release.
PRELOAD="$PRELOAD" STAGE="$BACKUP/preload.patched.mjs" python3 - <<'PY'
import os,pathlib
p=pathlib.Path(os.environ['PRELOAD'])
s=p.read_text()
imp='import { registerCfOpsTools, callAgent } from "./cf-ops-tools.mjs";'
anchor='    registerGatewayTools(this,z);'
assert s.count(imp)==1 and s.count(anchor)==1
s=s.replace(imp,'import { registerCfOpsTools, callAgent, callerIdentity } from "./cf-ops-tools.mjs";\nimport { registerCfMirrorUniversalTools } from "file:///release/cf-mirror-mcp-tools.mjs";')
s=s.replace(anchor,anchor+'\n    registerCfMirrorUniversalTools(this,z,{callAgent,callerIdentity});')
pathlib.Path(os.environ['STAGE']).write_text(s)
PY
node --check "$BACKUP/preload.patched.mjs" || fail 'preload syntax invalid'
chmod --reference="$PRELOAD" "$BACKUP/preload.patched.mjs"
chown --reference="$PRELOAD" "$BACKUP/preload.patched.mjs"
# Atomic rename into the currently mounted release. Never write inside /tmp/app.
cp -a "$BACKUP/preload.patched.mjs" "$PRELOAD.next.$$"
mv -f "$PRELOAD.next.$$" "$PRELOAD"
PATCHED=1
RESTART_ATTEMPTED=1
docker restart -t 20 "$C" >/dev/null || fail 'container restart failed'
# Catch crash-loops rather than mistaking an initial "docker restart" 0 for health.
ok=0
restart_count=$(docker inspect -f '{{.RestartCount}}' "$C")
for i in $(seq 1 12); do
  sleep 2
  state=$(docker inspect -f '{{.State.Running}}:{{.State.Restarting}}' "$C" 2>/dev/null || echo unknown)
  count=$(docker inspect -f '{{.RestartCount}}' "$C" 2>/dev/null || echo unknown)
  if [[ "$state" != true:false || "$count" != "$restart_count" ]]; then
    docker logs --tail 25 "$C" 2>&1 | grep -E 'ERR_MODULE_NOT_FOUND|Error|error' | tail -8 || true
    fail "container restarted/crashed after patch: $state count=$count"
  fi
  if curl -fsS --max-time 3 http://127.0.0.1:8769/ >/dev/null; then ((ok+=1)) || true; else ok=0; fi
done
[[ "$ok" -ge 8 ]] || fail 'CF MCP HTTP endpoint was not consistently healthy'
docker exec "$C" sh -c 'grep -Fq "file:///release/cf-mirror-mcp-tools.mjs" /tmp/app/cf-ops-preload.mjs' || fail 'patched preload missing inside Docker'
echo "CF_MIRROR_DEPLOY_OK: CF HTTP healthy, no restart loop, module loads from /release, backup=$BACKUP"
SUCCESS=1
