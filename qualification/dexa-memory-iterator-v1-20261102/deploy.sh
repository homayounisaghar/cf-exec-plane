#!/usr/bin/env bash
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
LIVE=/var/lib/capability-fabric/paa-remote/dexa-mvp
BASE=/home/cfserver/dexa-memory-iterator-v1-20261102
mkdir -p "$BASE"
exec 9>"$BASE/release.lock"
flock -n 9 || exit 20
export XDG_RUNTIME_DIR=/run/user/1000
export DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus
test "$(git hash-object "$LIVE/dexa_memory_read_v1.mjs")" = de3a6c71b9446468d6e93fc19c61c79e6b3f4df0
test "$(git hash-object "$DIR/dexa_memory_read_v1.mjs")" = 511c52b8af9d7eb33ee277f7cc07219a6b4de9a2
curl -fsS --max-time 6 http://127.0.0.1:9471/healthz >"$BASE/pre.json"
node -e 'const x=require(process.argv[1]);if(x.ok!==true||x.activeMissions!==0||x.deploymentDrain?.active===true)process.exit(2)' "$BASE/pre.json"
STAGE="$(mktemp -d "$BASE/stage-XXXXXXXX")"
for f in "$LIVE"/*.mjs "$LIVE"/*.json; do cp -p "$f" "$STAGE/"; done
cp "$DIR/dexa_memory_read_v1.mjs" "$DIR/test_dexa_memory_to_writer_translation_v1.mjs" "$STAGE/"
node --check "$STAGE/dexa_memory_read_v1.mjs"
(cd "$STAGE" && node --test test_dexa_memory_to_writer_translation_v1.mjs test_dexa_wechat_ignored_chat_v1.mjs test_dexa_exact_prior_answer_passthrough_v1.mjs >"$STAGE/tests.log" 2>&1)
tail -n 8 "$STAGE/tests.log"
BACKUP="$BASE/dexa_memory_read_v1.mjs.original"
cp -p "$LIVE/dexa_memory_read_v1.mjs" "$BACKUP"
RESTORE=1
restore(){
 if [ "$RESTORE" = 1 ]; then
  cp -p "$BACKUP" "$LIVE/dexa_memory_read_v1.mjs"
  systemctl --user restart dexa-main.service || true
  echo MEMORY_ITERATOR_ROLLBACK
 fi
}
trap restore EXIT
cp -p "$STAGE/dexa_memory_read_v1.mjs" "$LIVE/dexa_memory_read_v1.mjs"
systemctl --user restart dexa-main.service
for i in 1 2 3 4 5 6 7 8 9 10; do
 if curl -fsS --max-time 4 http://127.0.0.1:9471/healthz >"$STAGE/health.json" 2>/dev/null && node -e 'const x=require(process.argv[1]);if(x.ok!==true||x.activeMissions!==0||x.deploymentDrain?.active===true)process.exit(2)' "$STAGE/health.json"; then break; fi
 sleep 2
done
node -e 'const x=require(process.argv[1]);if(x.ok!==true||x.activeMissions!==0||x.deploymentDrain?.active===true)process.exit(2);console.log("ITERATOR_LIVE_HEALTH_OK",x.storedMissions)' "$STAGE/health.json"
cmp -s "$DIR/dexa_memory_read_v1.mjs" "$LIVE/dexa_memory_read_v1.mjs"
RESTORE=0
trap - EXIT
echo ITERATOR_RELEASE_INSTALLED
